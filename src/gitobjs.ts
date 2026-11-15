// gitobjs.ts — git objects, packfiles, pkt-lines, trees, commits and diffs.
// Only node:crypto and node:zlib. Packs are written with full objects only (no deltas);
// packs are read with OFS_DELTA and REF_DELTA resolution (thin pushes included).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, Repo } from './store.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode a whole buffer of pkt-lines into packets ({flush,delim} or {data}). */
export type Pkt = { kind: 'flush' } | { kind: 'delim' } | { kind: 'data'; payload: Buffer };

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

/** Split pack bytes from the tail of a receive-pack body: pkt-lines first, then the raw pack. */
export function splitCommandsAndPack(buf: Buffer): { packets: Pkt[]; pack: Buffer } {
  let offset = 0;
  const packets: Pkt[] = [];
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line in receive-pack');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, pack: buf.subarray(offset) };
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). */
export function writePack(objects: Array<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buf: Buffer, offset: number): { size: number; first: number; next: number } {
  const first = buf[offset] ?? 0;
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((first & 0x80) !== 0 || (buf[pos - 1] ?? 0) & 0x80) {
    const b = buf[pos] ?? 0;
    size |= (b & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if ((b & 0x80) === 0) break;
  }
  return { size, first, next: pos };
}

function readOfsDeltaBase(buf: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buf[offset] ?? 0;
  let pos = offset + 1;
  let baseOffset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] ?? 0;
    pos += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next: pos };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes, so the exact stream end is the SMALLEST end that
  // inflates cleanly: grow until success, then binary-search the minimal successful end.
  let lo = offset;
  let hi = Math.min(buf.length, offset + 16);
  for (;;) {
    let data: Buffer | null = null;
    try {
      data = inflateSync(buf.subarray(offset, hi));
    } catch {
      data = null;
    }
    if (data !== null) {
      let low = lo;
      let high = hi;
      while (low + 1 < high) {
        const mid = (low + high) >> 1;
        try {
          inflateSync(buf.subarray(offset, mid));
          high = mid;
        } catch {
          low = mid;
        }
      }
      return { data, next: high };
    }
    if (hi >= buf.length) throw new Error('truncated deflate stream in pack');
    lo = hi;
    hi = Math.min(buf.length, hi * 2);
  }
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos] ?? 0;
      pos += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { offset |= (delta[pos] ?? 0) << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { size |= (delta[pos] ?? 0) << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || outLen !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. `resolveBase` supplies objects a
 * thin pack leaves out (the repo's own object store on push).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length === 0) return [];
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: PackEntry;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('trailing bytes in pack');

  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): PackEntry => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved: PackEntry = { type, data, oid };
    entry.resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };
  return raw.map((entry) => resolve(entry));
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(c: Commit): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

const IDENT = 'github-forge <forge@example.invalid> 1700000000 +0000';

export function makeCommit(tree: string, parents: string[], message: string): { data: Buffer; oid: string } {
  const data = buildCommit({ tree, parents, author: IDENT, committer: IDENT, message: message.endsWith('\n') ? message : `${message}\n` });
  return { data, oid: hashObject('commit', data) };
}

// -------------------------------------------------------------------------------------------
// repo object helpers
// -------------------------------------------------------------------------------------------

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function getCommit(repo: Repo, oid: string): Commit | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** Flat map of path -> {mode, oid} for a tree (recursive). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Set one path in a tree, returning the new tree oid (creates intermediate trees). */
export function setPathInTree(repo: Repo, treeOid: string | null, segments: string[], mode: string, blobOid: string | null): string {
  const entries = new Map<string, TreeEntry>();
  if (treeOid !== null) {
    const obj = repo.objects.get(treeOid);
    if (obj && obj.type === 'tree') for (const e of parseTree(obj.data)) entries.set(e.name, e);
  }
  const [head, ...rest] = segments as [string, ...string[]];
  if (rest.length === 0) {
    if (blobOid === null) entries.delete(head);
    else entries.set(head, { mode, name: head, oid: blobOid });
  } else {
    const existing = entries.get(head);
    const childTree = existing && existing.mode === '40000' ? existing.oid : null;
    const newChild = setPathInTree(repo, childTree, rest, mode, blobOid);
    entries.set(head, { mode: '40000', name: head, oid: newChild });
  }
  const data = buildTree([...entries.values()]);
  return storeObject(repo, 'tree', data);
}

/** Read one file's blob oid from a commit's tree (null when absent). */
export function blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
  const commit = getCommit(repo, commitOid);
  if (!commit) return null;
  return flattenTree(repo, commit.tree).get(path)?.oid ?? null;
}

/** All ancestors of a commit (including itself), BFS newest-first. */
export function ancestors(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    out.push(oid);
    for (const p of commit.parents) queue.push(p);
  }
  return out;
}

/** First common ancestor of two tips (merge-base), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aSet = new Set(ancestors(repo, a));
  for (const oid of ancestors(repo, b)) if (aSet.has(oid)) return oid;
  return null;
}

export function isAncestor(repo: Repo, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  // Walk from the tip toward the root and stop as soon as the ancestor is found:
  // a fast-forward push is one step away, so this is O(distance), not O(history).
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === maybeAncestor) return true;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const p of commit.parents) queue.push(p);
  }
  return false;
}

/** The target OID of an annotated tag object (`object <sha>` on its first line). */
export function tagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})\n/.exec(text);
  return m ? (m[1] as string) : null;
}

/**
 * Follow annotated tag objects to the commit they point at (nested tags included).
 * Returns the commit OID, or null when the object is not a tag / not found.
 */
export function peelObject(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const target = tagTarget(obj.data);
    if (target === null) return null;
    current = target;
  }
  return null;
}

/**
 * Every object OID reachable from the given commit tips (commits, trees, blobs,
 * and tag objects followed to their targets), not descending below the `stopAt`
 * boundaries (a shallow clone holds the boundary commit, not its parents).
 * This is the object set a client holding those tips already has.
 */
export function reachableObjects(repo: Repo, tips: string[], stopAt: Set<string>): Set<string> {
  const out = new Set<string>();
  const commitQueue = [...tips];
  const seenCommits = new Set<string>();
  const seenTrees = new Set<string>();
  const addTree = (treeOid: string): void => {
    const treeQueue = [treeOid];
    while (treeQueue.length > 0) {
      const t = treeQueue.shift() as string;
      if (seenTrees.has(t)) continue;
      seenTrees.add(t);
      const treeObj = repo.objects.get(t);
      if (!treeObj || treeObj.type !== 'tree') continue;
      out.add(t);
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') treeQueue.push(entry.oid);
        else out.add(entry.oid);
      }
    }
  };
  while (commitQueue.length > 0) {
    const oid = commitQueue.shift() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        out.add(oid);
        const target = tagTarget(obj.data);
        if (target) commitQueue.push(target);
      }
      continue;
    }
    out.add(oid);
    addTree(commit.tree);
    if (stopAt.has(oid)) continue;
    for (const p of commit.parents) commitQueue.push(p);
  }
  return out;
}

/** Commits reachable from `tips` but not from `haves`, in BFS order (newest first). */
export function walkCommits(repo: Repo, tips: string[], haves: Set<string>): { commits: string[]; boundary: string[] } {
  const commits: string[] = [];
  const seen = new Set<string>(haves);
  const queue = [...tips];
  const haveAncestors = new Set<string>();
  for (const h of haves) for (const a of ancestors(repo, h)) haveAncestors.add(a);
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid) || haveAncestors.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    commits.push(oid);
    for (const p of commit.parents) queue.push(p);
  }
  return { commits, boundary: [] };
}

/**
 * Objects to send for a fetch: commits reachable from wants (minus haves), their trees and blobs.
 * With `depth`, only that many generations from each want; boundary commits are the shallow set.
 */
export function collectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | null,
  prevShallow: Set<string> = new Set(),
): { objects: Array<{ type: ObjectType; data: Buffer }>; shallow: string[]; unshallow: string[]; included: Set<string> } {
  // What the client already has: the ancestors of its haves — but NOT below its
  // shallow boundaries (a shallow clone has the boundary commit, not its parents).
  const haveAncestors = new Set<string>();
  for (const h of haves) {
    const queue = [h];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = getCommit(repo, oid);
      if (!commit) continue;
      haveAncestors.add(oid);
      if (prevShallow.has(oid)) continue; // boundary: the client has this, not its parents
      for (const p of commit.parents) queue.push(p);
    }
  }
  const shallow: string[] = [];
  // BFS with generation depth from the wants. Parents are queued even for commits
  // the client already has (a deepen fetch reaches the parents THROUGH its haves);
  // the haveAncestors set decides inclusion, not traversal. A commit at generation
  // g is included iff g < depth; the shallow boundary is the deepest INCLUDED
  // generation (g == depth - 1), never the first excluded one.
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
  const seen = new Set<string>();
  const included = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) {
      // An annotated tag want: include the tag object and follow it to its target
      // at the same generation (the target is what the client actually checks out).
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag' && !haveAncestors.has(oid)) {
        included.add(oid);
        const target = tagTarget(obj.data);
        if (target) queue.push({ oid: target, gen });
      }
      continue;
    }
    for (const p of commit.parents) queue.push({ oid: p, gen: gen + 1 });
    if (haveAncestors.has(oid)) continue;
    if (depth !== null && gen >= depth) continue;
    included.add(oid);
    if (depth !== null && gen === depth - 1) shallow.push(oid);
  }
  // A previous shallow boundary stops being one iff this fetch delivered its parent
  // (or delivered the boundary itself and it is no longer at the deepest level).
  const unshallow: string[] = [];
  for (const b of prevShallow) {
    const commit = getCommit(repo, b);
    const parentDelivered = commit !== undefined && commit.parents.some((p) => included.has(p));
    if (parentDelivered || (included.has(b) && !shallow.includes(b))) unshallow.push(b);
  }
  const objects: Array<{ type: ObjectType; data: Buffer }> = [];
  const added = new Set<string>();
  // Objects the client already holds (reachable from its haves): never re-send them.
  const clientObjects = reachableObjects(repo, [...haves], prevShallow);
  const addObject = (oid: string): void => {
    if (added.has(oid) || clientObjects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    added.add(oid);
    objects.push({ type: obj.type, data: obj.data });
  };
  const addTreeRecursive = (treeOid: string): void => {
    addObject(treeOid);
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTreeRecursive(entry.oid);
      else addObject(entry.oid);
    }
  };
  for (const oid of included) {
    addObject(oid);
    const commit = getCommit(repo, oid);
    if (commit) addTreeRecursive(commit.tree);
  }
  return { objects, shallow, unshallow, included };
}

// -------------------------------------------------------------------------------------------
// diffs
// -------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (t: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (t === '') return map;
    for (const line of t.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

/** Diff two trees (flat path maps): the changed paths with line counts. */
export function diffTrees(
  repo: Repo,
  baseTree: string | null,
  headTree: string | null,
): FileChange[] {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const text = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineCounts(text, '');
      out.push({ path, status: 'removed', additions: 0, deletions: Math.max(deletions, 0) });
    } else if (!b && h) {
      const text = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineCounts('', text);
      out.push({ path, status: 'added', additions: Math.max(additions, 1), deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineCounts(oldText, newText);
      out.push({ path, status: 'modified', additions, deletions });
    }
  }
  return out;
}

/** Three-way merge of `head` onto `base` with `mergeBase` as ancestor. Null when it conflicts. */
export function threeWayMerge(
  repo: Repo,
  baseCommit: string,
  headCommit: string,
  mergeBaseCommit: string,
): { tree: string; conflict: boolean } {
  const baseC = getCommit(repo, baseCommit);
  const headC = getCommit(repo, headCommit);
  const ancestorC = getCommit(repo, mergeBaseCommit);
  if (!baseC || !headC || !ancestorC) return { tree: '', conflict: true };
  const baseFlat = flattenTree(repo, baseC.tree);
  const headFlat = flattenTree(repo, headC.tree);
  const ancestorFlat = flattenTree(repo, ancestorC.tree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...ancestorFlat.keys()]);
  let treeOid: string | null = baseC.tree;
  let conflict = false;
  for (const path of paths) {
    const a = ancestorFlat.get(path)?.oid ?? null;
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    if (h === a) continue; // head did not change it: keep base
    if (b === a) {
      // base did not change it: take head's version
      const mode = headFlat.get(path)?.mode ?? '100644';
      treeOid = setPathInTree(repo, treeOid, path.split('/'), mode, h);
      continue;
    }
    if (b === h) continue; // both changed it the same way
    conflict = true;
  }
  return { tree: treeOid ?? '', conflict };
}
