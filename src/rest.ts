// rest.ts — GitHub REST v3 (/api/v3): repos, branches, commits, contents, git refs,
// issues, comments, labels, pull requests and merges. Every reply is application/json
// with a non-empty X-GitHub-Request-Id; errors carry {message}.

import type { IncomingMessage } from 'node:http';
import type { Label, Pull, Repo, Store } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN, isOid } from './store.ts';
import {
  blobAtPath,
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  getCommit,
  getObject,
  hashObject,
  isAncestor,
  makeCommit,
  mergeBase,
  parseCommit,
  parseTree,
  setPathInTree,
  storeObject,
  threeWayMerge,
} from './gitobjs.ts';

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  query: URLSearchParams;
  body: unknown;
  requestId: string;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}
function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}
function unprocessable(message: string): HttpError {
  return new HttpError(422, message);
}
function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function originOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], ctx: Ctx): { items: T[]; total: number; pageCount: number; page: number; perPage: number } {
  const { page, perPage } = pageParams(ctx);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), total, pageCount, page, perPage };
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function linkHeader(ctx: Ctx, basePath: string, page: number, perPage: number, pageCount: number): string | null {
  const origin = originOf(ctx);
  const url = (p: number): string => `${origin}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < pageCount) parts.push(`<${url(page + 1)}>; rel="next"`, `<${url(pageCount)}>; rel="last"`);
  if (page > 1) parts.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  return parts.length > 0 ? parts.join(', ') : null;
}

// -------------------------------------------------------------------------------------------
// JSON shapes
// -------------------------------------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  return { login, id: VIEWER_ID, node_id: '', avatar_url: '', type: 'User', site_admin: false };
}

export function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}`,
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: ctx.store.ts(repo.createdSeq),
    updated_at: ctx.store.ts(repo.createdSeq),
    pushed_at: ctx.store.ts(repo.createdSeq),
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    size: 0,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(ctx: Ctx, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; user: string; createdSeq: number; updatedSeq: number; comments: Array<{ id: number }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', description: '' };
    }),
    user: userJson(issue.user),
    created_at: ctx.store.ts(issue.createdSeq),
    updated_at: ctx.store.ts(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? ctx.store.ts(issue.updatedSeq) : null,
    comments: issue.comments.length,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeableOf(repo, pull),
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(repo.owner),
      repo: repoJson(ctx, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(repo.owner),
      repo: repoJson(ctx, repo),
    },
    user: userJson(pull.user),
    created_at: ctx.store.ts(pull.createdSeq),
    updated_at: ctx.store.ts(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? ctx.store.ts(pull.updatedSeq) : null,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function mergeableOf(repo: Repo, pull: Pull): boolean {
  if (pull.merged || pull.state === 'closed') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return false;
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return false;
  return !threeWayMerge(repo, baseTip, headTip, mb).conflict;
}

function branchJson(ctx: Ctx, repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function commitJson(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> {
  const commit = getCommit(repo, sha);
  const message = commit?.message.replace(/\n$/, '') ?? '';
  const date = ctx.store.ts(1);
  return {
    sha,
    commit: {
      message,
      author: { name: VIEWER_LOGIN, email: 'forge@example.invalid', date },
      committer: { name: VIEWER_LOGIN, email: 'forge@example.invalid', date },
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: (commit?.parents ?? []).map((p) => ({ sha: p })),
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// -------------------------------------------------------------------------------------------
// repo lookup + validation
// -------------------------------------------------------------------------------------------

export function requireRepo(ctx: Ctx, owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) throw notFound();
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) throw notFound();
  return repo;
}

function requireBranchTip(repo: Repo, branch: string): string {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) throw unprocessable(`Branch ${branch} does not exist`);
  return sha;
}

// -------------------------------------------------------------------------------------------
// contents + commits
// -------------------------------------------------------------------------------------------

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function commitFile(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; contentSha: string | null; isNew: boolean } {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw badRequest('empty path');
  let tip = repo.refs.get(`refs/heads/${branch}`);
  const isNewBranch = tip === undefined;
  let treeOid: string | null = null;
  let parent: string[] = [];
  if (tip !== undefined) {
    const commit = getCommit(repo, tip);
    if (!commit) throw new HttpError(500, 'corrupt branch tip');
    treeOid = commit.tree;
    parent = [tip];
  }
  const existingBlob = tip !== undefined ? blobAtPath(repo, tip, path) : null;
  const isNew = existingBlob === null;
  let contentSha: string | null = null;
  if (content !== null) {
    contentSha = storeObject(repo, 'blob', content);
    treeOid = setPathInTree(repo, treeOid, segments, '100644', contentSha);
  } else {
    if (existingBlob === null) throw notFound('file does not exist');
    treeOid = setPathInTree(repo, treeOid, segments, '100644', null);
  }
  const { data, oid } = makeCommit(treeOid, parent, message);
  storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  void isNewBranch;
  return { commitSha: oid, contentSha, isNew };
}

function contentFileJson(ctx: Ctx, repo: Repo, path: string, blobOid: string, ref: string): Record<string, unknown> {
  const blob = getObject(repo, blobOid);
  const data = blob?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: b64encode(data),
    sha: blobOid,
    url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
  };
}

function dirEntries(ctx: Ctx, repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({
        type: 'dir',
        size: 0,
        name: entry.name,
        path,
        sha: entry.oid,
        url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    } else {
      const blob = getObject(repo, entry.oid);
      out.push({
        type: 'file',
        size: blob?.data.length ?? 0,
        name: entry.name,
        path,
        sha: entry.oid,
        url: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function resolveRefTree(ctx: Ctx, repo: Repo, ref: string | null): { tree: string; commitSha: string } {
  let tip: string | undefined;
  if (ref === null || ref === '') {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  } else if (repo.refs.has(`refs/heads/${ref}`)) {
    tip = repo.refs.get(`refs/heads/${ref}`);
  } else if (repo.refs.has(`refs/tags/${ref}`)) {
    tip = repo.refs.get(`refs/tags/${ref}`);
  } else if (isOid(ref)) {
    tip = ref;
  }
  if (!tip) throw notFound('ref not found');
  const commit = getCommit(repo, tip);
  if (!commit) throw notFound('ref not found');
  return { tree: commit.tree, commitSha: tip };
}

// -------------------------------------------------------------------------------------------
// handlers
// -------------------------------------------------------------------------------------------

export function handleApiRoot(ctx: Ctx): RestResult {
  return {
    status: 200,
    body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
    headers: { 'x-oauth-scopes': 'repo, read:org' },
  };
}

export function handleMeta(): RestResult {
  return { status: 200, body: { installed_version: '1.0.0' } };
}

export function handleGetUser(): RestResult {
  return { status: 200, body: { ...userJson(VIEWER_LOGIN), name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` } };
}

export function handleCreateRepo(ctx: Ctx): RestResult {
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const name = str(ctx.body.name);
  if (name === '' || !/^[A-Za-z0-9_.-]+$/.test(name)) throw unprocessable('Invalid repository name');
  if (ctx.store.getRepo(VIEWER_LOGIN, name)) throw unprocessable('Repository already exists');
  const repo = ctx.store.createRepo(name, str(ctx.body.description), ctx.body.private === true);
  return { status: 201, body: repoJson(ctx, repo) };
}

export function handleListUserRepos(ctx: Ctx): RestResult {
  const repos = [...ctx.store.repos.values()]
    .filter((r) => r.owner === VIEWER_LOGIN)
    .sort((a, b) => a.createdSeq - b.createdSeq);
  const { items: page, pageCount, page: pageNum, perPage } = paginate(repos, ctx);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx, '/api/v3/user/repos', pageNum, perPage, pageCount);
  if (link !== null) headers.link = link;
  return { status: 200, body: page.map((r) => repoJson(ctx, r)), headers };
}

export function handleGetRepo(ctx: Ctx, owner: string, name: string): RestResult {
  return { status: 200, body: repoJson(ctx, requireRepo(ctx, owner, name)) };
}

export function handlePatchRepo(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const newName = optStr(ctx.body.name);
  if (newName !== undefined && newName !== repo.name) {
    if (!/^[A-Za-z0-9_.-]+$/.test(newName)) throw unprocessable('Invalid repository name');
    if (ctx.store.getRepo(VIEWER_LOGIN, newName)) throw unprocessable('Repository already exists');
    ctx.store.renameRepo(repo, newName);
  }
  const description = optStr(ctx.body.description);
  if (description !== undefined) repo.description = description;
  const defaultBranch = optStr(ctx.body.default_branch);
  if (defaultBranch !== undefined && repo.refs.has(`refs/heads/${defaultBranch}`)) repo.defaultBranch = defaultBranch;
  if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
  return { status: 200, body: repoJson(ctx, repo) };
}

export function handleDeleteRepo(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  ctx.store.deleteRepo(repo);
  return { status: 204, body: null };
}

export function handleListBranches(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push(branchJson(ctx, repo, ref.slice('refs/heads/'.length), sha));
  }
  const { items: page } = paginate(branches, ctx);
  return { status: 200, body: page };
}

export function handleGetBranch(ctx: Ctx, owner: string, name: string, branch: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) throw notFound('Branch not found');
  return { status: 200, body: branchJson(ctx, repo, branch, sha) };
}

export function handleListCommits(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const shaParam = ctx.query.get('sha');
  const tip = shaParam ? resolveRefTree(ctx, repo, shaParam).commitSha : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) return { status: 200, body: [] };
  const commits: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    commits.push(oid);
    for (const p of commit.parents) queue.push(p);
  }
  const { items: page } = paginate(commits, ctx);
  return { status: 200, body: page.map((sha) => commitJson(ctx, repo, sha)) };
}

export function handleGetCommit(ctx: Ctx, owner: string, name: string, sha: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!getCommit(repo, sha)) throw notFound('Commit not found');
  return { status: 200, body: commitJson(ctx, repo, sha) };
}

export function handleGetRef(ctx: Ctx, owner: string, name: string, refPath: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const ref = `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (!sha) throw notFound('Reference does not exist');
  return { status: 200, body: { ref, object: { sha, type: 'commit' } } };
}

export function handleCreateRef(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const ref = str(ctx.body.ref);
  const sha = str(ctx.body.sha);
  if (!ref.startsWith('refs/') || !isOid(sha)) throw unprocessable('Invalid ref or sha');
  if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
  if (!getCommit(repo, sha)) throw unprocessable('Object does not exist');
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
}

export function handleGetContents(ctx: Ctx, owner: string, name: string, path: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const ref = ctx.query.get('ref');
  const { tree } = resolveRefTree(ctx, repo, ref);
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return { status: 200, body: dirEntries(ctx, repo, tree, '') };
  // Walk to the path.
  let currentTree = tree;
  let currentPath = '';
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i] as string;
    currentPath = currentPath === '' ? seg : `${currentPath}/${seg}`;
    const obj = getObject(repo, currentTree);
    if (!obj || obj.type !== 'tree') throw notFound('Not Found');
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry) throw notFound('Not Found');
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return { status: 200, body: dirEntries(ctx, repo, entry.oid, currentPath) };
      return { status: 200, body: contentFileJson(ctx, repo, currentPath, entry.oid, ref ?? repo.defaultBranch) };
    }
    if (entry.mode !== '40000') throw notFound('Not Found');
    currentTree = entry.oid;
  }
  throw notFound('Not Found');
}

export function handlePutContents(ctx: Ctx, owner: string, name: string, path: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const message = str(ctx.body.message, 'Update');
  const contentB64 = str(ctx.body.content);
  if (contentB64 === '') throw badRequest('content is required');
  const branch = str(ctx.body.branch, repo.defaultBranch);
  const sha = optStr(ctx.body.sha);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const existingBlob = tip !== undefined ? blobAtPath(repo, tip, path) : null;
  if (existingBlob !== null) {
    if (sha === undefined) throw conflict('sha is required to update a file');
    if (sha !== existingBlob) throw conflict('sha does not match the current blob');
  } else if (sha !== undefined) {
    throw conflict('sha does not match: the file does not exist');
  }
  const content = b64decode(contentB64);
  const { commitSha, contentSha, isNew } = commitFile(ctx, repo, branch, path, content, message);
  return {
    status: isNew ? 201 : 200,
    body: {
      content: { sha: contentSha, encoding: 'base64', size: content.length, name: path.split('/').pop() ?? path, path },
      commit: { sha: commitSha, message },
    },
  };
}

export function handleDeleteContents(ctx: Ctx, owner: string, name: string, path: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const message = str(ctx.body.message, 'Delete');
  const branch = str(ctx.body.branch, repo.defaultBranch);
  const sha = optStr(ctx.body.sha);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const existingBlob = tip !== undefined ? blobAtPath(repo, tip, path) : null;
  if (existingBlob === null) throw notFound('file does not exist');
  if (sha !== undefined && sha !== existingBlob) throw conflict('sha does not match the current blob');
  const { commitSha } = commitFile(ctx, repo, branch, path, null, message);
  return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
}

export function handleListLabels(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  return { status: 200, body: [...repo.labels.values()].map(labelJson) };
}

export function handleCreateLabel(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const labelName = str(ctx.body.name);
  if (labelName === '') throw unprocessable('Label name is required');
  if (repo.labels.has(labelName)) throw unprocessable('Label already exists');
  const label = ctx.store.createLabel(repo, labelName, str(ctx.body.color, 'ededed'), str(ctx.body.description));
  return { status: 201, body: labelJson(label) };
}

export function handleCreateIssue(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const title = str(ctx.body.title);
  if (title === '') throw unprocessable('Title is required');
  const labels = Array.isArray(ctx.body.labels) ? ctx.body.labels.map((l) => String(l)) : [];
  for (const labelName of labels) {
    if (!repo.labels.has(labelName)) throw unprocessable(`Label does not exist: ${labelName}`);
  }
  const issue = ctx.store.createIssue(repo, title, str(ctx.body.body), labels);
  return { status: 201, body: issueJson(ctx, repo, issue) };
}

export function handleListIssues(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const { items: page } = paginate(issues, ctx);
  return { status: 200, body: page.map((i) => issueJson(ctx, repo, i)) };
}

export function handleGetIssue(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Issue not found');
  return { status: 200, body: issueJson(ctx, repo, issue) };
}

export function handlePatchIssue(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Issue not found');
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const title = optStr(ctx.body.title);
  if (title !== undefined) issue.title = title;
  const body = optStr(ctx.body.body);
  if (body !== undefined) issue.body = body;
  const state = optStr(ctx.body.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  if (Array.isArray(ctx.body.labels)) {
    const labels = ctx.body.labels.map((l) => String(l));
    for (const labelName of labels) if (!repo.labels.has(labelName)) throw unprocessable(`Label does not exist: ${labelName}`);
    issue.labels = labels;
  }
  issue.updatedSeq = ctx.store.nextSeq();
  return { status: 200, body: issueJson(ctx, repo, issue) };
}

export function handleListComments(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Issue not found');
  const { items: page } = paginate(issue.comments, ctx);
  return {
    status: 200,
    body: page.map((c) => ({ id: c.id, body: c.body, user: userJson(c.user), created_at: ctx.store.ts(c.createdSeq), updated_at: ctx.store.ts(c.createdSeq) })),
  };
}

export function handleCreateComment(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Issue not found');
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const body = str(ctx.body.body);
  if (body === '') throw unprocessable('Comment body is required');
  const comment = ctx.store.createComment(repo, issue, body);
  return {
    status: 201,
    body: { id: comment.id, body: comment.body, user: userJson(comment.user), created_at: ctx.store.ts(comment.createdSeq), updated_at: ctx.store.ts(comment.createdSeq) },
  };
}

export function handleAddIssueLabels(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Issue not found');
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const labels = Array.isArray(ctx.body.labels) ? ctx.body.labels.map((l) => String(l)) : [];
  for (const labelName of labels) if (!repo.labels.has(labelName)) throw unprocessable(`Label does not exist: ${labelName}`);
  for (const labelName of labels) if (!issue.labels.includes(labelName)) issue.labels.push(labelName);
  issue.updatedSeq = ctx.store.nextSeq();
  return { status: 200, body: issue.labels.map((n) => labelJson(repo.labels.get(n) as Label)) };
}

export function computePullFiles(repo: Repo, baseSha: string, headSha: string): Array<{ filename: string; status: 'added' | 'removed' | 'modified' | 'renamed'; additions: number; deletions: number; changes: number }> {
  const baseC = getCommit(repo, baseSha);
  const headC = getCommit(repo, headSha);
  if (!baseC || !headC) return [];
  const mb = mergeBase(repo, baseSha, headSha);
  const mbTree = mb ? getCommit(repo, mb)?.tree ?? null : null;
  const changes = diffTrees(repo, mbTree, headC.tree);
  return changes.map((c) => ({
    filename: c.path,
    status: c.status === 'removed' ? 'removed' : c.status,
    additions: c.additions,
    deletions: c.deletions,
    changes: c.additions + c.deletions,
  }));
}

export function handleCreatePull(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  if (!isRecord(ctx.body)) throw badRequest('body must be a JSON object');
  const title = str(ctx.body.title);
  const head = str(ctx.body.head);
  const base = str(ctx.body.base, repo.defaultBranch);
  if (title === '' || head === '') throw unprocessable('Title and head are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!headSha) throw unprocessable(`Head branch ${head} does not exist`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!baseSha) throw unprocessable(`Base branch ${base} does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      throw unprocessable('A pull request already exists for this branch');
    }
  }
  const mb = mergeBase(repo, baseSha, headSha);
  const files = computePullFiles(repo, baseSha, headSha);
  const pull = ctx.store.createPull(repo, title, str(ctx.body.body), head, headSha, base, baseSha, files, mb);
  return { status: 201, body: pullJson(ctx, repo, pull) };
}

export function handleListPulls(ctx: Ctx, owner: string, name: string): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => (state === 'closed' ? p.state === 'closed' : p.state === 'open'));
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { items: page } = paginate(pulls, ctx);
  return { status: 200, body: page.map((p) => pullJson(ctx, repo, p)) };
}

export function handleGetPull(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound('Pull request not found');
  return { status: 200, body: pullJson(ctx, repo, pull) };
}

export function handleListPullFiles(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound('Pull request not found');
  return { status: 200, body: pull.files };
}

export interface MergeOutcome {
  sha: string;
  message: string;
}

/** The merge itself, shared by the REST and GraphQL surfaces. Throws HttpError on failure. */
export function mergePullInternal(store: Store, repo: Repo, pull: Pull, method: 'squash' | 'merge'): MergeOutcome {
  if (pull.merged || pull.state === 'closed') throw new HttpError(405, 'Pull request is already merged or closed');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) throw new HttpError(405, 'Head or base branch is gone');
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) throw new HttpError(405, 'No merge base');
  const merged = threeWayMerge(repo, baseTip, headTip, mb);
  if (merged.conflict) throw new HttpError(405, 'Merge conflict');
  const message = method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const parents = method === 'squash' ? [baseTip] : [baseTip, headTip];
  const { data, oid } = makeCommit(merged.tree, parents, message);
  storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = oid;
  const seq = store.nextSeq();
  pull.mergedAt = store.ts(seq);
  pull.updatedSeq = seq;
  return { sha: oid, message };
}

export function handleMergePull(ctx: Ctx, owner: string, name: string, number: number): RestResult {
  const repo = requireRepo(ctx, owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound('Pull request not found');
  const method = isRecord(ctx.body) ? str(ctx.body.merge_method, 'squash') : 'squash';
  if (method !== 'squash' && method !== 'merge') throw unprocessable(`Unsupported merge method: ${method}`);
  const outcome = mergePullInternal(ctx.store, repo, pull, method);
  return { status: 200, body: { merged: true, sha: outcome.sha, message: outcome.message } };
}
