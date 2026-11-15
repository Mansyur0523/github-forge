[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Mansyur0523/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Mansyur0523/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-forge — a GitHub-compatible git forge (make.fun bounty `github-core-clone-01`)

A single Node.js process (stdlib only, no dependencies, no install step) that serves
git smart HTTP at `/{owner}/{repo}.git`, REST v3 at `/api/v3`, GraphQL at
`/api/graphql`, and MCP at `/mcp`, from its own in-memory store. Entry point is
`main.ts` (Node 22+, run as `node --experimental-strip-types main.ts`); it binds an
ephemeral port, POSTs `{port}` to `$MAKEFUN_ENV_URL/register`, then long-polls
`$MAKEFUN_ENV_URL/done` until the trial ends and exits 0.

## Layout

- `main.ts` — entry lifecycle (starter, unchanged): register + poll `/done`.
- `app.ts` — HTTP server: routing, auth, body reading, JSON/git responses.
- `src/store.ts` — in-memory store (repos, issues, pulls, comments, labels), deterministic
  timestamps from `MAKEFUN_TRIAL_NOW` + sequence, viewer `adaiversen` (id 1000).
- `src/gitobjs.ts` — SHA-1 objects, pack read/write (v2, full objects + OFS/REF delta
  resolve on read), pkt-lines, trees/commits, fetch collection, tag peeling.
- `src/githttp.ts` — v0/v2 advertisements, v2 ls-refs, v0/v2 fetch, receive-pack +
  sideband report.
- `src/rest.ts` — full REST v3 (repos, branches, commits, contents, refs, issues,
  comments, pulls + squash merge).
- `src/graphql.ts` — GraphQL: tokenizer + parser, validator, executor, introspection,
  opaque global ids, cursor pagination, all five mutations, batching.
- `src/mcp.ts` — MCP Streamable HTTP: `server/discover` (2026-07-28 + legacy
  `initialize`), 6 tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).
- `test/` — smoke test, real-`git` CLI test, conformance runners, saved results.

## Auth

One bearer token (`MAKEFUN_SHOP_TOKEN`) is the viewer's. REST/GraphQL/MCP always
require it. Git reads of a public repo need no token (GitHub behaviour); private-repo
reads and all pushes require it. A missing repo is 404 on git endpoints regardless
of auth.

## Protocol notes (verified against real `git` 2.43 and the kit's git-client)

- Push report: report pkt-lines + flush **inside** the band-1 sideband data, then a
  bare flush — without the inner flush real git reports "the remote end hung up".
- v2 fetch sections are emitted only when they carry content: `acknowledgments` only
  when the client sent haves (with `ACK` lines + a `ready` line — without `ready`,
  real git errors "expected no other sections to be sent after no 'ready'"),
  `shallow-info` only with shallow/unshallow lines, no `wanted-refs`, always `packfile`.
- Shallow boundary = the deepest *included* commit generation, never the first excluded one.
- `deepen N`: absolute depth per the kit client; treated as an increment when the request
  only re-asks already-held shallow boundaries with N no deeper than the current depth
  (real git `--deepen`).
- Incremental fetches never re-send objects reachable from the client's haves.
- Annotated tags push as `tag` objects, peel to their commit in ls-refs/advertisements,
  and round-trip through fetch packs.

## Local results (15 Nov 2026, this machine)

- `test/smoke.mjs` — all checks pass (REST, GraphQL, MCP, protocol).
- `test/git-cli.mjs` — real `git` 2.43: clone (empty / with history / shallow / deepen),
  push, fetch, tags, non-fast-forward refusal, wrong-token refusal, 1 MiB file — all pass.
- Kit conformance `sdk/run.ts --perf` — **120/120 checks**, feature 600, agent 200,
  perf 118–126 across runs, total **918–923** (`test/results/conformance-sdk-run.json`).
- Sealed env harness `sdk/conformance/main.ts` (register + `/done` lifecycle) —
  **120/120, perf 160 points, total 960** (`test/results/conformance-env-state.json`,
  `test/results/conformance-env-perf.json`). The house reference scores 120/120 with
  ~100 perf points (~900 total), so this entry beats it on performance.

## License

MIT — see `LICENSE`.
