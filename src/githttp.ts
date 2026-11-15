// githttp.ts — git smart HTTP: info/refs (v0/v2 advertisements), git-upload-pack (v0/v2
// fetch + ls-refs), git-receive-pack (v0 push with report-status in sideband band 1).
// No git binary anywhere: the protocol is implemented on node:zlib / node:crypto.

import type { Repo } from './store.ts';
import { ZERO_OID } from './store.ts';
import {
  collectFetchObjects,
  decodePktLines,
  getCommit,
  hashObject,
  isAncestor,
  peelObject,
  pktDelim,
  pktLine,
  PKT_FLUSH,
  readPack,
  splitCommandsAndPack,
  storeObject,
  writePack,
} from './gitobjs.ts';

export const AGENT = 'github-forge/1.0';

function sidebandPackets(data: Buffer): Buffer[] {
  // Split pack bytes into sideband band-1 packets (pkt-line max 65520 bytes).
  const out: Buffer[] = [];
  const maxChunk = 65520 - 5; // 4 (pkt len) + 1 (band byte)
  for (let off = 0; off < data.length || out.length === 0; off += maxChunk) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxChunk));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
    if (data.length === 0) break;
  }
  return out;
}

/** Sorted ref names for advertisement / ls-refs. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** v0 advertisement for a service, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  if (head === null && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = head === null ? `${ZERO_OID} HEAD\0${caps}\n` : `${head} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      // Peeled line for annotated tag refs: the target commit, never the tag itself.
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelObject(repo, ref.oid);
        if (peeled !== null && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement (upload-pack only). */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

/** v2 ls-refs response. */
export function v2LsRefs(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const head = headOid(repo);
  if (head === null) {
    if (keep('HEAD') || args.prefixes.length === 0) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else if (keep('HEAD')) {
    const sym = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${head} HEAD${sym}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      // Only annotated tags peel: the attribute names the target commit, never the tag itself.
      const peeled = peelObject(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

/**
 * v2 fetch response. Sections are emitted ONLY when they carry content — real git
 * expects `packfile` first when the client sent no haves and no depth, and reads
 * `acknowledgments` only when it sent haves. `wanted-refs` is omitted (neither real
 * git nor the kit's client requires it).
 */
/**
 * Resolve the effective fetch depth. The kit's client sends `deepen N` as the ABSOLUTE
 * depth it wants, while real git's `--deepen N` sends N as an INCREMENT over the
 * client's current depth. The two are told apart by shape: a pure deepen re-requests
 * only commits the client already holds as shallow boundaries, with N no deeper than
 * its current depth (boundary generation + 1) — that is an increment. Anything else
 * (a new tip, a deeper absolute request) is an absolute depth.
 */
function effectiveDepth(repo: Repo, req: FetchRequest): number | null {
  if (req.depth === null) return null;
  if (req.shallow.length === 0) return req.depth;
  const boundaryGens: number[] = [];
  const queue: Array<{ oid: string; gen: number }> = req.wants.map((oid) => ({ oid, gen: 0 }));
  const seen = new Set<string>();
  const boundarySet = new Set(req.shallow);
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (boundarySet.has(oid)) {
      boundaryGens.push(gen);
      continue;
    }
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const p of commit.parents) queue.push({ oid: p, gen: gen + 1 });
  }
  if (boundaryGens.length === 0) return req.depth;
  const currentDepth = Math.min(...boundaryGens) + 1;
  const allWantsBoundaries = req.wants.every((w) => boundarySet.has(w));
  if (allWantsBoundaries && req.depth <= currentDepth) return currentDepth + req.depth;
  return req.depth;
}

export function v2Fetch(repo: Repo, req: FetchRequest): Buffer {
  const depth = effectiveDepth(repo, req);
  const { objects, shallow, unshallow } = collectFetchObjects(repo, req.wants, new Set(req.haves), depth, new Set(req.shallow));
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acks = req.haves.filter((oid) => repo.objects.has(oid));
    if (acks.length > 0) {
      for (const oid of acks) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    // `ready` tells the client negotiation is over and the packfile section follows
    // in this same response; without it real git errors ("expected no other sections
    // to be sent after no 'ready'").
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: ACK/NAK / shallow lines as plain pkt-lines, then the sideband pack. */
export function v0Fetch(repo: Repo, req: FetchRequest): Buffer {
  const depth = effectiveDepth(repo, req);
  const { objects, shallow, unshallow } = collectFetchObjects(repo, req.wants, new Set(req.haves), depth, new Set(req.shallow));
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (req.haves.length > 0) {
    const acks = req.haves.filter((oid) => repo.objects.has(oid));
    if (acks.length > 0) {
      for (const oid of acks) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  report: string;
  /** Whether every command was accepted. */
  ok: boolean;
}

/**
 * Apply a receive-pack: validate each command against the current refs, store the pack's objects,
 * then move the refs that pass. Non-fast-forward is refused per ref; the others still apply.
 */
export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer): PushOutcome {
  const lines: string[] = [];
  let unpackOk = true;
  try {
    const entries = readPack(pack, (oid) => repo.objects.get(oid));
    for (const entry of entries) {
      if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
    }
  } catch (err) {
    unpackOk = false;
    lines.push(`unpack error ${err instanceof Error ? err.message : String(err)}\n`);
    return { report: lines.join(''), ok: false };
  }
  lines.push('unpack ok\n');
  let allOk = true;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    const fail = (reason: string): void => {
      lines.push(`ng ${cmd.ref} ${reason}\n`);
      allOk = false;
    };
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        fail('remote ref does not exist');
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        fail('stale info');
        continue;
      }
      repo.refs.delete(cmd.ref);
      lines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    const isTagRef = cmd.ref.startsWith('refs/tags/');
    // A branch moves to a commit; a tag ref moves to a commit (lightweight) or to a
    // tag object (annotated). Anything else is not a ref target the server holds.
    if (!newObj || (newObj.type !== 'commit' && !(isTagRef && newObj.type === 'tag'))) {
      fail('object not found');
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        fail('stale info');
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    if (cmd.oldOid !== current) {
      fail('stale info');
      continue;
    }
    // Tags have no ancestry: a tag update is accepted once the old value matches.
    if (!isTagRef && !isAncestor(repo, current, cmd.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}\n`);
  }
  return { report: lines.join(''), ok: unpackOk && allOk };
}

/** Parse a receive-pack body into commands + pack. Throws on malformed pkt-lines. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, pack } = splitCommandsAndPack(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities on the first command
    const trimmed = line.replace(/\n$/, '');
    const parts = trimmed.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(trimmed.slice(0, 60))}`);
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');
  return { commands, pack };
}

/** Parse an upload-pack v2 body (ls-refs / fetch). */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const args: string[] = [];
  let command = '';
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else if (seenDelim) args.push(line);
  }
  if (command === '') throw new Error('upload-pack v2 request without a command');
  return { command, args };
}

/** Parse an upload-pack v0 body into a fetch request. */
export function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const [verb, ...rest] = line.split(' ');
    if (verb === 'want') req.wants.push(rest[0] as string);
    else if (verb === 'have') req.haves.push(rest[0] as string);
    else if (verb === 'shallow') req.shallow.push(rest[0] as string);
    else if (verb === 'deepen') req.depth = parseInt(rest[0] as string, 10);
    else if (verb === 'deepen-since' || verb === 'deepen-not') req.depth = req.depth ?? null;
    else if (verb === 'done') break;
  }
  return req;
}

/** Build the push report as sideband band-1 pkt-lines + flush. */
export function pushReportBytes(report: string): Buffer {
  // The report is a stream of pkt-lines (`unpack ok`, `ok <ref>` / `ng <ref> <reason>`)
  // terminated by a flush INSIDE the band-1 data — the client's report parser reads
  // until that flush and treats an EOF without it as a hung-up remote (real git does
  // exactly this). The band-1 payload is chunked into sideband packets (<= 65520 B).
  const inner: Buffer[] = [];
  for (const line of report.split('\n')) {
    if (line === '') continue;
    inner.push(pktLine(`${line}\n`));
  }
  inner.push(PKT_FLUSH);
  const payload = Buffer.concat(inner);
  const parts: Buffer[] = [];
  const MAX_CHUNK = 65520 - 4 - 1; // pkt-line length prefix + band byte
  for (let off = 0; off < payload.length; off += MAX_CHUNK) {
    const chunk = payload.subarray(off, off + MAX_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export { hashObject, storeObject, getCommit };
