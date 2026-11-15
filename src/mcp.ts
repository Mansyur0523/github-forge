// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp).
// Speaks the modern 2026-07-28 era (server/discover, no handshake, no session) and the
// legacy initialize handshake as a fallback. Plain JSON answers, never SSE. The six tools
// act on the same store as REST and GraphQL.

import type { Repo, Store } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './store.ts';
import { computePullFiles, mergePullInternal } from './rest.ts';
import { mergeBase } from './gitobjs.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the token owner; ignored when it differs).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.ts(repo.createdSeq),
    updated_at: store.ts(repo.createdSeq),
  };
}

function issueJson(store: Store, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; user: string; createdSeq: number; updatedSeq: number; comments: Array<{ id: number }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user, id: VIEWER_ID },
    created_at: store.ts(issue.createdSeq),
    updated_at: store.ts(issue.updatedSeq),
    comments: issue.comments.length,
  };
}

function pullJson(store: Store, repo: Repo, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; headRef: string; headSha: string; baseRef: string; baseSha: string; createdSeq: number; updatedSeq: number }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: store.ts(pull.createdSeq),
    updated_at: store.ts(pull.updatedSeq),
  };
}

type ToolResult = { ok: true; payload: unknown } | { ok: false; message: string };

function toolError(message: string): ToolResult {
  return { ok: false, message };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string | null {
  const missing = required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
  return missing.length > 0 ? missing.join(', ') : null;
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? args.repository ?? '');
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const normalized = name.replace(/^github__/, '');
  const tool = TOOLS.find((t) => t.name === normalized);
  if (!tool) return toolError(`unknown tool ${name}`);
  const missing = missingArgs(args, tool.inputSchema.required);
  if (missing !== null) return toolError(`Missing required argument(s): ${missing}`);
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '' || !/^[A-Za-z0-9_.-]+$/.test(repoName)) return toolError('Invalid repository name');
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing) return { ok: true, payload: repoJson(store, existing) };
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { ok: true, payload: repoJson(store, repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      return { ok: true, payload: repoJson(store, repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, payload: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const state = String(args.state ?? 'open');
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return { ok: true, payload: issues.map((i) => issueJson(store, repo, i)) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? repo.defaultBranch);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch not found');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return { ok: true, payload: pullJson(store, repo, existing) };
        }
      }
      const mb = mergeBase(repo, baseSha, headSha);
      const files = computePullFiles(repo, baseSha, headSha);
      const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, headSha, base, baseSha, files, mb);
      return { ok: true, payload: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.get(number);
      if (!pull) return toolError('pull request not found');
      try {
        const outcome = mergePullInternal(store, repo, pull, 'squash');
        return { ok: true, payload: { ...pullJson(store, repo, pull), merged: true, sha: outcome.sha } };
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpAnswer {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Handle one POST /mcp body. Auth is decided by the caller (401 before this runs). */
export function handleMcp(store: Store, bodyText: string): McpAnswer {
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (!isRecord(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};
  // A notification (no id) is answered with 202 and no body.
  const isNotification = body.id === undefined;
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_VERSIONS.includes(requested) || SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (toolName === '') {
      return { status: 200, body: rpcError(id, -32602, 'tools/call needs a tool name') };
    }
    const known = TOOLS.some((t) => t.name === toolName || `github__${t.name}` === toolName);
    if (!known) {
      return { status: 200, body: rpcError(id, -32602, `unknown tool ${toolName}`) };
    }
    const outcome = callTool(store, toolName, args);
    if (!outcome.ok) {
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          isError: true,
        }),
      };
    }
    return {
      status: 200,
      body: rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  void isNotification;
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
