// app.ts — the HTTP server: routing, auth, body reading, JSON + git responses.
// One process, stdlib only. Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id; git replies are the smart-HTTP content types.
//
// Performance notes:
// - The request line is split by hand (no `new URL()` per request) and path
//   segments are only percent-decoded when they actually contain a '%'.
// - GET requests never touch a promise: health, the API root, info/refs and the
//   whole REST GET surface are handled synchronously in the request callback.
//   Only requests with a body (POST/PUT/PATCH/DELETE) go through an async read.
// - Handlers may return a pre-serialised reply (RestResult.raw); those bytes go
//   straight to the socket with no JSON.stringify and no byte-length scan.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, authorized } from './src/store.ts';
import {
  handleAddIssueLabels,
  handleApiRoot,
  handleCreateComment,
  handleCreateIssue,
  handleCreateLabel,
  handleCreatePull,
  handleCreateRef,
  handleDeleteContents,
  handleDeleteRepo,
  handleGetBranch,
  handleGetCommit,
  handleGetContents,
  handleGetIssue,
  handleGetPull,
  handleGetRef,
  handleGetRepo,
  handleGetUser,
  handleListBranches,
  handleListComments,
  handleListIssues,
  handleListLabels,
  handleListPullFiles,
  handleListPulls,
  handleListCommits,
  handleListUserRepos,
  handleCreateRepo,
  handleMergePull,
  handleMeta,
  handlePatchIssue,
  handlePatchRepo,
  handlePutContents,
  HttpError,
  type Ctx,
  type RestResult,
} from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import {
  applyPush,
  parseReceivePack,
  parseV0Fetch,
  parseV2Request,
  pushReportBytes,
  v0Advertisement,
  v0Fetch,
  v2Advertisement,
  v2Fetch,
  v2LsRefs,
} from './src/githttp.ts';
import { VIEWER_LOGIN } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const store = new Store();

/** Write a JSON reply from an object (stringified + "\n", like the original). */
function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...extra });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(text);
}

/** Write a pre-serialised JSON reply (exact bytes + length, no re-stringify). */
function sendRaw(res: ServerResponse, status: number, raw: { text: string; length: number }, requestId: string, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...extra });
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': raw.length,
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(raw.text);
}

/** Write a handler's RestResult, using its pre-serialised bytes when it has them. */
function sendResult(res: ServerResponse, result: RestResult, requestId: string): void {
  if (result.raw !== undefined) sendRaw(res, result.status, result.raw, requestId, result.headers ?? {});
  else sendJson(res, result.status, result.body, requestId, result.headers ?? {});
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

/** Split a request target into pathname + query params, without `new URL()`. */
function splitUrl(target: string): { pathname: string; query: URLSearchParams } {
  let url = target;
  const hash = url.indexOf('#');
  if (hash >= 0) url = url.slice(0, hash);
  const q = url.indexOf('?');
  if (q < 0) return { pathname: url === '' ? '/' : url, query: new URLSearchParams() };
  return { pathname: q === 0 ? '/' : url.slice(0, q), query: new URLSearchParams(url.slice(q + 1)) };
}

/** Read the whole request body (used only for methods that carry one). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Path segments, percent-decoded only when a segment actually contains '%'. */
function splitSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    out.push(part.includes('%') ? decodeSegment(part) : part);
  }
  return out;
}

/** A numeric path segment, or NaN when it is not all digits. */
function segNumber(s: string | undefined): number {
  if (s === undefined || !/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

function handleRest(ctx: Ctx, method: string, pathname: string): RestResult {
  const seg = splitSegments(pathname);
  // seg[0]='api', seg[1]='v3', ...
  if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
    const rest = seg.slice(2);
    if (rest.length === 0) {
      if (method === 'GET') return handleApiRoot(ctx);
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'meta' && rest.length === 1) {
      if (method === 'GET') return handleMeta();
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'user' && rest.length === 1) {
      if (method === 'GET') return handleGetUser();
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      if (method === 'POST') return handleCreateRepo(ctx);
      if (method === 'GET') return handleListUserRepos(ctx);
      throw new HttpError(404, 'Not Found');
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = rest[1] as string;
      const repo = rest[2] as string;
      const tail = rest.slice(3);
      if (tail.length === 0) {
        if (method === 'GET') return handleGetRepo(ctx, owner, repo);
        if (method === 'PATCH') return handlePatchRepo(ctx, owner, repo);
        if (method === 'DELETE') return handleDeleteRepo(ctx, owner, repo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') return handleListBranches(ctx, owner, repo);
      if (tail[0] === 'branches' && tail.length >= 2 && method === 'GET') return handleGetBranch(ctx, owner, repo, tail.slice(1).join('/'));
      if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return handleListCommits(ctx, owner, repo);
      if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') return handleGetCommit(ctx, owner, repo, tail[1] as string);
      if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') return handleCreateRef(ctx, owner, repo);
      if (tail[0] === 'git' && tail[1] === 'refs' && tail.length >= 3 && method === 'GET') return handleGetRef(ctx, owner, repo, tail.slice(2).join('/'));
      if (tail[0] === 'contents') {
        const path = tail.slice(1).join('/');
        if (method === 'GET') return handleGetContents(ctx, owner, repo, path);
        if (method === 'PUT') return handlePutContents(ctx, owner, repo, path);
        if (method === 'DELETE') return handleDeleteContents(ctx, owner, repo, path);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'labels' && tail.length === 1) {
        if (method === 'GET') return handleListLabels(ctx, owner, repo);
        if (method === 'POST') return handleCreateLabel(ctx, owner, repo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'issues' && tail.length === 1) {
        if (method === 'GET') return handleListIssues(ctx, owner, repo);
        if (method === 'POST') return handleCreateIssue(ctx, owner, repo);
        throw new HttpError(404, 'Not Found');
      }
      const issueNo = segNumber(tail[1]);
      if (tail[0] === 'issues' && tail.length === 2 && Number.isFinite(issueNo)) {
        if (method === 'GET') return handleGetIssue(ctx, owner, repo, issueNo);
        if (method === 'PATCH') return handlePatchIssue(ctx, owner, repo, issueNo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'issues' && tail.length === 3 && Number.isFinite(issueNo) && tail[2] === 'comments') {
        if (method === 'GET') return handleListComments(ctx, owner, repo, issueNo);
        if (method === 'POST') return handleCreateComment(ctx, owner, repo, issueNo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'issues' && tail.length === 3 && Number.isFinite(issueNo) && tail[2] === 'labels') {
        if (method === 'POST') return handleAddIssueLabels(ctx, owner, repo, issueNo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'pulls' && tail.length === 1) {
        if (method === 'GET') return handleListPulls(ctx, owner, repo);
        if (method === 'POST') return handleCreatePull(ctx, owner, repo);
        throw new HttpError(404, 'Not Found');
      }
      const pullNo = segNumber(tail[1]);
      if (tail[0] === 'pulls' && tail.length === 2 && Number.isFinite(pullNo)) {
        if (method === 'GET') return handleGetPull(ctx, owner, repo, pullNo);
        throw new HttpError(404, 'Not Found');
      }
      if (tail[0] === 'pulls' && tail.length === 3 && Number.isFinite(pullNo) && tail[2] === 'files' && method === 'GET') {
        return handleListPullFiles(ctx, owner, repo, pullNo);
      }
      if (tail[0] === 'pulls' && tail.length === 3 && Number.isFinite(pullNo) && tail[2] === 'merge' && method === 'PUT') {
        return handleMergePull(ctx, owner, repo, pullNo);
      }
    }
  }
  throw new HttpError(404, 'Not Found');
}

/** Best-effort 500 for an unexpected failure (headers may already be gone). */
function fail500(res: ServerResponse, requestId: string, err: unknown): void {
  process.stderr.write(`[entry] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  try {
    sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
  } catch {
    // The response is already gone; nothing left to do.
  }
}

const GIT_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Git smart HTTP. info/refs GET is synchronous; the pack POSTs read a body first. */
function routeGit(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  pathname: string,
  query: URLSearchParams,
  method: string,
  match: RegExpExecArray,
): void {
  const owner = decodeSegment(match[1] as string);
  const repoName = decodeSegment(match[2] as string);
  const service = match[3] as string;
  if (owner !== VIEWER_LOGIN) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  // Auth is per-endpoint, like GitHub: a public repo's reads (info/refs,
  // upload-pack) need no token, a private repo's reads need it, and
  // receive-pack (push) always needs it. A missing repo is 404 regardless.
  const authed = authorized(req.headers.authorization);
  const isPush = service === 'git-receive-pack';
  if (isPush || repo.isPrivate) {
    if (!authed) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'x-github-request-id': requestId,
        'www-authenticate': 'Basic realm="GitHub"',
      });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
  }
  if (service === 'info/refs' && method === 'GET') {
    const svc = query.get('service');
    if (svc === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement', requestId);
      } else {
        sendBytes(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement', requestId);
      }
    } else if (svc === 'git-receive-pack') {
      sendBytes(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement', requestId);
    } else {
      sendJson(res, 400, { message: 'Missing service parameter' }, requestId);
    }
    return;
  }
  if (service === 'git-upload-pack' && method === 'POST') {
    void (async () => {
      try {
        const body = await readBody(req);
        try {
          if ((req.headers['git-protocol'] ?? '') === 'version=2') {
            const { command, args } = parseV2Request(body);
            if (command === 'ls-refs') {
              const prefixes: string[] = [];
              let peel = false;
              let symrefs = false;
              let unborn = false;
              for (const arg of args) {
                if (arg === 'peel') peel = true;
                else if (arg === 'symrefs') symrefs = true;
                else if (arg === 'unborn') unborn = true;
                else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
              }
              sendBytes(res, 200, v2LsRefs(repo, { peel, symrefs, unborn, prefixes }), 'application/x-git-upload-pack-result', requestId);
            } else if (command === 'fetch') {
              const fetchReq = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], depth: null as number | null, filter: null as string | null };
              for (const arg of args) {
                if (arg.startsWith('want ')) fetchReq.wants.push(arg.slice(5));
                else if (arg.startsWith('have ')) fetchReq.haves.push(arg.slice(5));
                else if (arg.startsWith('shallow ')) fetchReq.shallow.push(arg.slice(8));
                else if (arg.startsWith('deepen ')) fetchReq.depth = parseInt(arg.slice(7), 10);
                else if (arg.startsWith('filter ')) fetchReq.filter = arg.slice(7);
              }
              sendBytes(res, 200, v2Fetch(repo, fetchReq), 'application/x-git-upload-pack-result', requestId);
            } else {
              sendJson(res, 400, { message: `Unknown v2 command ${command}` }, requestId);
            }
          } else {
            const fetchReq = parseV0Fetch(body);
            sendBytes(res, 200, v0Fetch(repo, fetchReq), 'application/x-git-upload-pack-result', requestId);
          }
        } catch (err) {
          sendJson(res, 400, { message: err instanceof Error ? err.message : 'malformed request' }, requestId);
        }
      } catch (err) {
        fail500(res, requestId, err);
      }
    })();
    return;
  }
  if (service === 'git-receive-pack' && method === 'POST') {
    void (async () => {
      try {
        const body = await readBody(req);
        try {
          const { commands, pack } = parseReceivePack(body);
          const outcome = applyPush(repo, commands, pack);
          sendBytes(res, 200, pushReportBytes(outcome.report), 'application/x-git-receive-pack-result', requestId);
        } catch (err) {
          sendJson(res, 400, { message: err instanceof Error ? err.message : 'malformed request' }, requestId);
        }
      } catch (err) {
        fail500(res, requestId, err);
      }
    })();
    return;
  }
  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

/** REST v3: GETs run synchronously; methods with a body read it first. */
function routeRest(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  pathname: string,
  query: URLSearchParams,
  method: string,
): void {
  if (method === 'GET') {
    try {
      const ctx: Ctx = { store, req, query, body: null, requestId };
      sendResult(res, handleRest(ctx, method, pathname), requestId);
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { message: err.message }, requestId);
      else {
        process.stderr.write(`[entry] REST error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
      }
    }
    return;
  }
  void (async () => {
    try {
      let parsedBody: unknown = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            parsedBody = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' }, requestId);
            return;
          }
        }
      }
      const ctx: Ctx = { store, req, query, body: parsedBody, requestId };
      try {
        sendResult(res, handleRest(ctx, method, pathname), requestId);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message }, requestId);
        } else {
          process.stderr.write(`[entry] REST error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        }
      }
    } catch (err) {
      fail500(res, requestId, err);
    }
  })();
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = store.requestId();
    const { pathname, query } = splitUrl(req.url ?? '/');
    const method = req.method ?? 'GET';
    try {
      // Health: no auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }
      // The GitHub API root: no auth (the starter's behaviour).
      if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
        const result = handleApiRoot({ store, req, query, body: null, requestId });
        sendResult(res, result, requestId);
        return;
      }
      // Git smart HTTP.
      const gitMatch = GIT_RE.exec(pathname);
      if (gitMatch) {
        routeGit(req, res, requestId, pathname, query, method, gitMatch);
        return;
      }

      // Everything else (REST, GraphQL, MCP) needs the trial token.
      if (!authorized(req.headers.authorization)) {
        sendJson(res, 401, { message: 'Bad credentials' }, requestId);
        return;
      }

      // GraphQL.
      if (pathname === '/api/graphql' && method === 'POST') {
        void (async () => {
          try {
            const raw = await readBody(req);
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw.toString('utf8')) as unknown;
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON body' }, requestId);
              return;
            }
            sendJson(res, 200, handleGraphQL({ store }, parsed), requestId);
          } catch (err) {
            fail500(res, requestId, err);
          }
        })();
        return;
      }

      // MCP.
      if (pathname === '/mcp') {
        if (method === 'GET') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(202, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        if (method === 'POST') {
          void (async () => {
            try {
              const raw = await readBody(req);
              const answer = handleMcp(store, raw.toString('utf8'));
              if (answer.body === null) {
                res.writeHead(answer.status, { 'x-github-request-id': requestId });
                res.end();
                return;
              }
              sendJson(res, answer.status, answer.body, requestId);
            } catch (err) {
              fail500(res, requestId, err);
            }
          })();
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        return;
      }

      // REST v3.
      if (pathname.startsWith('/api/v3')) {
        routeRest(req, res, requestId, pathname, query, method);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, requestId);
    } catch (err) {
      fail500(res, requestId, err);
    }
  });
}
