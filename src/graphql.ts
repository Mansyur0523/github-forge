// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server send:
// viewer/repository/node/__type, issue + pull-request reads, the five mutations, batching,
// aliases, inline fragments, variables, inline enums and input objects. Unknown fields are
// HTTP 200 with an errors array naming them (never a 400).

import type { Pull, Repo, Store } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';
import { computePullFiles, mergePullInternal } from './rest.ts';
import { getCommit, mergeBase, threeWayMerge } from './gitobjs.ts';

// -------------------------------------------------------------------------------------------
// global (Relay) ids: opaque base64url of a kind + coordinates; decodable for the mutations.
// -------------------------------------------------------------------------------------------

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join('\0'), 'utf8').toString('base64url');
}

export function ungid(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split('\0');
    const kind = parts.shift();
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', repo.owner, repo.name);
}
function issueGid(repo: Repo, number: number): string {
  return gid('Issue', repo.owner, repo.name, number);
}
function pullGid(repo: Repo, number: number): string {
  return gid('PullRequest', repo.owner, repo.name, number);
}
function commentGid(repo: Repo, issueNumber: number, commentId: number): string {
  return gid('IssueComment', repo.owner, repo.name, issueNumber, commentId);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}
function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// schema: the field set of every type (validation + __type introspection).
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['id', 'login', 'name', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'url'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'mergedAt', 'author', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  Node: ['id'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'LABEL', 'MILESTONE', 'PACKAGE', 'PROJECT', 'TOPIC', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** Return type of every field (for selection validation + execution). */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  User: { id: 'ID', login: 'String', name: 'String', url: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    description: 'String', createdAt: 'String', url: 'String',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String', createdAt: 'String', updatedAt: 'String', author: 'User', labels: 'String', comments: 'String', url: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', state: 'PullRequestState', merged: 'Boolean',
    headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection',
    body: 'String', createdAt: 'String', mergedAt: 'String', author: 'User', url: 'String',
  },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changes: 'Int' },
  Node: { id: 'ID' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', description: 'String' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', url: 'String' },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload',
  },
};

function fieldType(typeName: string, field: string): string {
  return FIELD_TYPE[typeName]?.[field] ?? 'String';
}

function baseType(typeName: string): string {
  return typeName.replace(/^\[|\]$/g, '');
}

function isListType(typeName: string): boolean {
  return typeName.startsWith('[');
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: SelectionNode[];
}

class ParseError extends Error {}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '$') {
      // A variable reference is one token: `$owner`, not `$` + `owner`.
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if ('{}():![]=@&|'.includes(ch) || ch === '.') {
      if (ch === '.' && input.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    if (t === undefined) throw new ParseError('unexpected end of document');
    return t;
  }

  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new ParseError(`expected ${tok}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === 'query' || tok === 'mutation') {
        this.next();
        ops.push(this.parseOperation(tok));
      } else if (tok === '{') {
        ops.push({ kind: 'query', name: null, variables: [], selections: this.parseSelections() });
      } else if (tok === 'fragment') {
        throw new ParseError('named fragments are not supported');
      } else {
        throw new ParseError(`unexpected token ${JSON.stringify(tok)}`);
      }
    }
    return ops;
  }

  private parseOperation(kind: 'query' | 'mutation'): Operation {
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next !== '(' && next !== '{') name = this.next();
    const variables: string[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const t = this.next();
        if (t.startsWith('$')) variables.push(t.slice(1));
        else if (t === ':') {
          // skip the type (may be [String!] etc.)
          let depth = 0;
          for (;;) {
            const u = this.next();
            if (u === '[') depth += 1;
            else if (u === ']') depth -= 1;
            else if (u === ')' && depth === 0) {
              this.pos -= 1;
              break;
            } else if ((u === ',' || u === ')') && depth === 0) {
              if (u === ')') this.pos -= 1;
              break;
            } else if (u === '=') {
              this.parseValue();
              break;
            }
          }
        } else if (t === '=') {
          this.parseValue();
        }
      }
      this.expect(')');
    }
    return { kind, name, variables, selections: this.parseSelections() };
  }

  parseSelections(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new ParseError('unterminated selection set');
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          typeCondition = this.next();
        } else {
          throw new ParseError('named fragment spreads are not supported');
        }
        out.push({ kind: 'fragment', typeCondition, selections: this.parseSelections() });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      const selections = this.peek() === '{' ? this.parseSelections() : [];
      out.push({ kind: 'field', alias, name, args, selections });
    }
    this.expect('}');
    return out;
  }

  parseValue(): ValueNode {
    const tok = this.next();
    if (tok.startsWith('$')) return { kind: 'variable', name: tok.slice(1) };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
    if (tok === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    return { kind: 'enum', value: tok };
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

export interface GqlContext {
  store: Store;
}

type Obj = Record<string, unknown>;

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, variables);
  return out;
}

class GqlError extends Error {}

interface TypedValue {
  __typename: string;
  value: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate a selection set against a type; throws GqlError naming the first bad field. */
function validate(typeName: string, selections: SelectionNode[]): void {
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const target = sel.typeCondition ?? typeName;
      if (sel.typeCondition !== null && sel.typeCondition !== typeName && !(typeName === 'Node')) {
        // An inline fragment on another concrete type: its fields validate against that type.
        validate(sel.typeCondition, sel.selections);
      } else {
        validate(target, sel.selections);
      }
      continue;
    }
    if (sel.name === '__typename') continue;
    const known = FIELDS[typeName];
    if (!known || !known.includes(sel.name)) {
      throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    }
    if (sel.selections.length > 0) {
      const childType = baseType(fieldType(typeName, sel.name));
      validate(childType, sel.selections);
    }
  }
}

// -------------------------------------------------------------------------------------------
// resolvers
// -------------------------------------------------------------------------------------------

function findRepoByGid(ctx: GqlContext, id: unknown): Repo | null {
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'Repository' || parsed.parts.length < 2) return null;
  return ctx.store.getRepo(parsed.parts[0] as string, parsed.parts[1] as string) ?? null;
}

function findIssueByGid(ctx: GqlContext, id: unknown): { repo: Repo; number: number } | null {
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'Issue' || parsed.parts.length < 3) return null;
  const repo = ctx.store.getRepo(parsed.parts[0] as string, parsed.parts[1] as string);
  if (!repo) return null;
  return { repo, number: parseInt(parsed.parts[2] as string, 10) };
}

function findPullByGid(ctx: GqlContext, id: unknown): { repo: Repo; number: number } | null {
  const parsed = ungid(id);
  if (!parsed || parsed.kind !== 'PullRequest' || parsed.parts.length < 3) return null;
  const repo = ctx.store.getRepo(parsed.parts[0] as string, parsed.parts[1] as string);
  if (!repo) return null;
  return { repo, number: parseInt(parsed.parts[2] as string, 10) };
}

function issueStateGql(state: string): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeableGql(ctx: GqlContext, repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return 'CONFLICTING';
  return threeWayMerge(repo, baseTip, headTip, mb).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function issueView(ctx: GqlContext, repo: Repo, number: number): TypedValue | null {
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return {
    __typename: 'Issue',
    value: {
      __typename: 'Issue',
      _repo: repo,
      _number: number,
      id: issueGid(repo, number),
      number: issue.number,
      title: issue.title,
      state: issueStateGql(issue.state),
      body: issue.body,
      createdAt: ctx.store.ts(issue.createdSeq),
      updatedAt: ctx.store.ts(issue.updatedSeq),
      url: `/${repo.owner}/${repo.name}/issues/${number}`,
    },
  };
}

function pullView(ctx: GqlContext, repo: Repo, number: number): TypedValue | null {
  const pull = repo.pulls.get(number);
  if (!pull) return null;
  return {
    __typename: 'PullRequest',
    value: {
      __typename: 'PullRequest',
      _repo: repo,
      _number: number,
      id: pullGid(repo, number),
      number: pull.number,
      title: pull.title,
      state: pullStateGql(pull),
      merged: pull.merged,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      mergeable: pullMergeableGql(ctx, repo, pull),
      body: pull.body,
      createdAt: ctx.store.ts(pull.createdSeq),
      mergedAt: pull.mergedAt,
      url: `/${repo.owner}/${repo.name}/pull/${number}`,
    },
  };
}

function repoView(ctx: GqlContext, repo: Repo): TypedValue {
  return {
    __typename: 'Repository',
    value: {
      __typename: 'Repository',
      _repo: repo,
      id: repoGid(repo),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { __typename: 'User', login: repo.owner, id: VIEWER_LOGIN },
      defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      description: repo.description,
      createdAt: ctx.store.ts(repo.createdSeq),
      url: `/${repo.owner}/${repo.name}`,
    },
  };
}

function issuesConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): TypedValue {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    issues = issues.filter((i) => wanted.has(issueStateGql(i.state)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const field = String(orderBy?.field ?? 'CREATED_AT');
  const direction = String(orderBy?.direction ?? 'ASC');
  if (field === 'CREATED_AT') {
    issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  } else {
    issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterNum = numberFromCursor(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = issues.findIndex((i) => i.number === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = issues.slice(start, start + first);
  const nodes = slice.map((i) => issueView(ctx, repo, i.number)?.value ?? null).filter((v) => v !== null);
  const endCursor = slice.length > 0 ? cursorFor(slice[slice.length - 1]?.number ?? 0) : null;
  return {
    __typename: 'IssueConnection',
    value: {
      __typename: 'IssueConnection',
      nodes,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: start + slice.length < issues.length,
        hasPreviousPage: start > 0,
        startCursor: slice.length > 0 ? cursorFor(slice[0]?.number ?? 0) : null,
        endCursor,
      },
      totalCount: issues.length,
    },
  };
}

function pullsConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): TypedValue {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterNum = numberFromCursor(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = pulls.findIndex((p) => p.number === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = pulls.slice(start, start + first);
  const nodes = slice.map((p) => pullView(ctx, repo, p.number)?.value ?? null).filter((v) => v !== null);
  const endCursor = slice.length > 0 ? cursorFor(slice[slice.length - 1]?.number ?? 0) : null;
  return {
    __typename: 'PullRequestConnection',
    value: {
      __typename: 'PullRequestConnection',
      nodes,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: start + slice.length < pulls.length,
        hasPreviousPage: start > 0,
        startCursor: slice.length > 0 ? cursorFor(slice[0]?.number ?? 0) : null,
        endCursor,
      },
      totalCount: pulls.length,
    },
  };
}

function typeInfo(name: string): TypedValue | null {
  const fields = FIELDS[name];
  const enums = ENUM_VALUES[name];
  if (!fields && !enums) return null;
  return {
    __typename: '__Type',
    value: {
      __typename: '__Type',
      name,
      kind: enums ? 'ENUM' : 'OBJECT',
      fields: (fields ?? []).map((f) => ({ __typename: '__Field', name: f, description: null })),
      enumValues: (enums ?? []).map((e) => ({ __typename: '__EnumValue', name: e, description: null })),
      description: null,
    },
  };
}

function resolveField(ctx: GqlContext, typeName: string, parent: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argsOf(field, variables);
  const rec = isRecord(parent) ? parent : {};
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_LOGIN === 'adaiversen' ? 1000 : 1 };
      if (field.name === 'repository') {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoView(ctx, repo).value : null;
      }
      if (field.name === 'node') {
        const parsed = ungid(args.id);
        if (!parsed) return null;
        if (parsed.kind === 'Repository' && parsed.parts.length >= 2) {
          const repo = ctx.store.getRepo(parsed.parts[0] as string, parsed.parts[1] as string);
          return repo ? repoView(ctx, repo).value : null;
        }
        if (parsed.kind === 'Issue' && parsed.parts.length >= 3) {
          const repo = ctx.store.getRepo(parsed.parts[0] as string, parsed.parts[1] as string);
          if (!repo) return null;
          return issueView(ctx, repo, parseInt(parsed.parts[2] as string, 10))?.value ?? null;
        }
        if (parsed.kind === 'PullRequest' && parsed.parts.length >= 3) {
          const repo = ctx.store.getRepo(parsed.parts[0] as string, parsed.parts[1] as string);
          if (!repo) return null;
          return pullView(ctx, repo, parseInt(parsed.parts[2] as string, 10))?.value ?? null;
        }
        return null;
      }
      if (field.name === '__type') {
        const info = typeInfo(String(args.name ?? ''));
        return info ? info.value : null;
      }
      return null;
    }
    case 'Repository': {
      const repo = rec._repo as Repo;
      if (field.name === 'issue') return issueView(ctx, repo, Number(args.number))?.value ?? null;
      if (field.name === 'issues') return issuesConnection(ctx, repo, args).value;
      if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args).value;
      if (field.name === 'pullRequest') return pullView(ctx, repo, Number(args.number))?.value ?? null;
      return rec[field.name] ?? null;
    }
    case 'Issue':
    case 'PullRequest':
    case 'User':
    case 'Ref':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PageInfo':
    case 'IssueEdge':
    case 'PullRequestEdge':
    case '__Type':
    case '__Field':
    case '__EnumValue':
      return rec[field.name] ?? null;
    case 'PullRequestChangedFileConnection': {
      const pull = rec._pull as Pull | undefined;
      const repo = rec._repo as Repo | undefined;
      void pull;
      void repo;
      return rec[field.name] ?? null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, args);
    }
    default:
      return rec[field.name] ?? null;
  }
}

function resolveMutation(ctx: GqlContext, field: FieldNode, args: Record<string, unknown>): unknown {
  const input = isRecord(args.input) ? args.input : {};
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoByGid(ctx, input.repositoryId);
      if (!repo) throw new GqlError('repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueView(ctx, repo, issue.number)?.value ?? null };
    }
    case 'closeIssue': {
      const found = findIssueByGid(ctx, input.issueId);
      if (!found) throw new GqlError('issue not found');
      const issue = found.repo.issues.get(found.number);
      if (!issue) throw new GqlError('issue not found');
      issue.state = 'closed';
      issue.updatedSeq = ctx.store.nextSeq();
      return { __typename: 'CloseIssuePayload', issue: issueView(ctx, found.repo, found.number)?.value ?? null };
    }
    case 'createPullRequest': {
      const repo = findRepoByGid(ctx, input.repositoryId);
      if (!repo) throw new GqlError('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new GqlError('head or base branch not found');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(ctx, repo, existing.number)?.value ?? null };
        }
      }
      const mb = mergeBase(repo, baseSha, headSha);
      const files = computePullFiles(repo, baseSha, headSha);
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, headSha, base, baseSha, files, mb);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(ctx, repo, pull.number)?.value ?? null };
    }
    case 'mergePullRequest': {
      const found = findPullByGid(ctx, input.pullRequestId);
      if (!found) throw new GqlError('pull request not found');
      const pull = found.repo.pulls.get(found.number);
      if (!pull) throw new GqlError('pull request not found');
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      mergePullInternal(ctx.store, found.repo, pull, method === 'merge' ? 'merge' : 'squash');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullView(ctx, found.repo, found.number)?.value ?? null };
    }
    case 'addComment': {
      const found = findIssueByGid(ctx, input.subjectId);
      if (!found) throw new GqlError('subject not found');
      const issue = found.repo.issues.get(found.number);
      if (!issue) throw new GqlError('issue not found');
      const comment = ctx.store.createComment(found.repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: commentGid(found.repo, found.number, comment.id),
            body: comment.body,
            author: { __typename: 'User', login: VIEWER_LOGIN },
            createdAt: ctx.store.ts(comment.createdSeq),
          },
        },
      };
    }
    default:
      throw new GqlError(`unknown mutation ${field.name}`);
  }
}

// PullRequest.files needs the pull's file list: attach it in pullView via a lazy field.
function pullFilesConnection(ctx: GqlContext, repo: Repo, pull: Pull, first: number): TypedValue {
  void ctx;
  const nodes = pull.files.slice(0, first).map((f) => ({
    __typename: 'PullRequestChangedFile',
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  }));
  return {
    __typename: 'PullRequestChangedFileConnection',
    value: {
      __typename: 'PullRequestChangedFileConnection',
      nodes,
      pageInfo: { __typename: 'PageInfo', hasNextPage: pull.files.length > first, endCursor: null },
    },
  };
}

// Patch the PullRequest resolver for `files` (it needs repo + pull, stored on the value).
const origResolve = resolveField;

function resolveFieldPatched(ctx: GqlContext, typeName: string, parent: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  if (typeName === 'PullRequest' && field.name === 'files') {
    const rec = isRecord(parent) ? parent : {};
    const repo = rec._repo as Repo;
    const pull = repo.pulls.get(rec._number as number);
    if (!pull) return null;
    const args = argsOf(field, variables);
    const first = typeof args.first === 'number' ? args.first : 30;
    return pullFilesConnection(ctx, repo, pull, first).value;
  }
  if (typeName === 'PullRequest' && field.name === 'author') {
    const rec = isRecord(parent) ? parent : {};
    const repo = rec._repo as Repo;
    const pull = repo.pulls.get(rec._number as number);
    return { __typename: 'User', login: pull?.user ?? VIEWER_LOGIN };
  }
  if (typeName === 'Issue' && field.name === 'author') {
    const rec = isRecord(parent) ? parent : {};
    const repo = rec._repo as Repo;
    const issue = repo.issues.get(rec._number as number);
    return { __typename: 'User', login: issue?.user ?? VIEWER_LOGIN };
  }
  return origResolve(ctx, typeName, parent, field, variables);
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOne(ctx: GqlContext, query: string, variables: Record<string, unknown>): GqlResponse {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'empty document' }] };
  const operation = operations[0] as Operation;
  try {
    validate(operation.kind === 'mutation' ? 'Mutation' : 'Query', operation.selections);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const rootValue: TypedValue = { __typename: rootType, value: {} };
  try {
    const data = executeSelectionsPatched(ctx, rootType, rootValue, operation.selections, variables);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function executeSelectionsPatched(
  ctx: GqlContext,
  typeName: string,
  typed: TypedValue,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Obj {
  const out: Obj = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typed.__typename && typed.__typename !== 'Node') continue;
      Object.assign(out, executeSelectionsPatched(ctx, sel.typeCondition ?? typeName, typed, sel.selections, variables));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typed.__typename;
      continue;
    }
    const raw = resolveFieldPatched(ctx, typeName, typed.value, sel, variables);
    if (sel.selections.length === 0 || raw === null || raw === undefined) {
      out[key] = raw ?? null;
      continue;
    }
    const childType = baseType(fieldType(typeName, sel.name));
    if (isListType(fieldType(typeName, sel.name))) {
      if (!Array.isArray(raw)) {
        out[key] = null;
        continue;
      }
      out[key] = raw.map((entry) => {
        if (entry === null || entry === undefined) return null;
        const typedEntry: TypedValue = isRecord(entry) && typeof entry.__typename === 'string'
          ? { __typename: entry.__typename as string, value: entry }
          : { __typename: childType, value: entry };
        return executeSelectionsPatched(ctx, childType, typedEntry, sel.selections, variables);
      });
    } else if (isRecord(raw)) {
      // A record carrying __typename is a value, not a TypedValue wrapper: wrap it.
      const typedChild: TypedValue = typeof raw.__typename === 'string'
        ? { __typename: raw.__typename as string, value: raw }
        : { __typename: childType, value: raw };
      out[key] = executeSelectionsPatched(ctx, childType, typedChild, sel.selections, variables);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/** Handle a POST /api/graphql body (single operation or a batch array). */
export function handleGraphQL(ctx: GqlContext, body: unknown): GqlResponse | GqlResponse[] {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (!isRecord(entry)) return { data: null, errors: [{ message: 'batched entry is not an object' }] };
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      return executeOne(ctx, String(entry.query ?? ''), variables);
    });
  }
  if (!isRecord(body)) return { data: null, errors: [{ message: 'body must be an object' }] };
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  return executeOne(ctx, String(body.query ?? ''), variables);
}
