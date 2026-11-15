// store.ts — the forge's in-memory state.
//
// One process, one store, no persistence: a trial runs against a fresh, empty forge and the
// replay pass re-runs the same requests in the same order, so everything here is deterministic:
// timestamps come from MAKEFUN_TRIAL_NOW plus a monotonic sequence (never Date.now()), ids are
// counters (never Math.random()), and the viewer login is the scenario's fixed viewer
// (SCENARIO_SEED is a constant in the kit: viewer login "adaiversen", id 1000).

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The token owner's login, from the kit's fixed scenario seed (wire.ts SCENARIO_SEED). */
export const VIEWER_LOGIN: string = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdSeq: number;
  updatedSeq: number;
  files: PullFile[];
  mergeBase: string | null;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1_700_000_000;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  /** Monotonic sequence: every created thing takes the next number; drives ordering + timestamps. */
  seq = 0;
  nextRepoId = 1;
  nextGlobalId = 1;
  nextRequestId = 1;
  readonly epochSec: number = parseTrialNow();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** ISO timestamp for a sequence number: deterministic across replays. */
  ts(seq: number): string {
    return new Date((this.epochSec + seq) * 1000).toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  requestId(): string {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return `req-${id.toString(16).padStart(8, '0')}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: seq,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  renameRepo(repo: Repo, newName: string): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    repo.name = newName;
    this.repos.set(this.key(repo.owner, repo.name), repo);
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextGlobalId, body, user: VIEWER_LOGIN, createdSeq: this.nextSeq() };
    this.nextGlobalId += 1;
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string, files: PullFile[], mergeBase: string | null): Pull {
    const seq = this.nextSeq();
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      files,
      mergeBase,
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const label: Label = { id: this.nextGlobalId, name, color, description };
    this.nextGlobalId += 1;
    repo.labels.set(name, label);
    return label;
  }
}

/** The one bearer token this process accepts (MAKEFUN_SHOP_TOKEN). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Whether the Authorization header carries the trial token. */
export function authorized(authorization: string | string[] | undefined): boolean {
  const expected = expectedToken();
  if (typeof authorization !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  if (match === null) return false;
  const presented = match[1] ?? '';
  if (expected === '') return presented !== '';
  return presented === expected;
}
