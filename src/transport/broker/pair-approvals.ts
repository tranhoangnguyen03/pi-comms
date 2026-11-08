import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// One broker-owned approval per unordered exact pair. Approved or not approved:
// there is no stored refusal. Only remembered approvals touch disk.
export type PairMode = 'session' | 'remembered' | 'none';
export type PairView = { peer: string; mode: PairMode; context?: string; revision: number };
type Remembered = { a: string; b: string; scope: string | null; context: string; revision: number };
// Session-only approval belongs to each endpoint's Pi runtime, not to one socket,
// so a reconnect of the same runtime keeps it and a reload/replacement ends it.
type Temporary = { a: string; b: string; scope: string | null; context: string; aRuntime: string; bRuntime: string; revision: number };
type FileData = { formatVersion: 2; pairs: Remembered[]; sha256: string };

const json = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
export const pairKey = (scope: string | undefined, a: string, b: string) =>
  json([scope ?? null, ...[a, b].sort()]);

export class PairApprovalStore {
  private readonly file: string;
  private readonly pairs = new Map<string, Remembered>();
  private readonly temporary = new Map<string, Temporary>();
  private revision = 0;
  // Set when an unreadable file was moved aside at startup; reported once in broker logs.
  readonly recovered: string | undefined;
  constructor(runtimeDir: string) {
    this.file = join(runtimeDir, 'pair-approvals.json');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as FileData;
      if (data?.formatVersion !== 2 || !Array.isArray(data.pairs) || hash([2, data.pairs]) !== data.sha256)
        throw Error('invalid version or checksum');
      for (const value of data.pairs) {
        if (!value || typeof value.a !== 'string' || typeof value.b !== 'string' || value.a >= value.b ||
            (typeof value.scope !== 'string' && value.scope !== null) || typeof value.context !== 'string' ||
            !Number.isSafeInteger(value.revision)) throw Error('malformed pair entry');
        this.pairs.set(pairKey(value.scope ?? undefined, value.a, value.b), value);
        this.revision = Math.max(this.revision, value.revision);
      }
    } catch (error) {
      // An unreadable file can only lose remembered approvals, never grant one.
      // Keep it for inspection and continue with no remembered approvals.
      this.pairs.clear();
      const aside = `${this.file}.unreadable-${Date.now()}`;
      renameSync(this.file, aside);
      this.recovered = `Unreadable pair approvals (${String(error)}) moved to ${aside}; remembered approvals must be granted again.`;
    }
  }
  private persist(next: Map<string, Remembered>) {
    const pairs = [...next.values()].sort((x, y) => pairKey(x.scope ?? undefined, x.a, x.b).localeCompare(pairKey(y.scope ?? undefined, y.a, y.b)));
    const temp = `${this.file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(temp, json({ formatVersion: 2, pairs, sha256: hash([2, pairs]) } satisfies FileData), { mode: 0o600 });
      const fd = openSync(temp, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file);
      try { const dir = openSync(dirname(this.file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      catch { /* Directory fsync is unsupported on some platforms. */ }
    } finally { rmSync(temp, { force: true }); }
  }
  state(scope: string | undefined, id: string, peer: string): PairView {
    const key = pairKey(scope, id, peer), saved = this.pairs.get(key), live = this.temporary.get(key);
    if (saved) return { peer, mode: 'remembered', context: saved.context, revision: saved.revision };
    if (live) return { peer, mode: 'session', context: live.context, revision: live.revision };
    return { peer, mode: 'none', revision: this.revision };
  }
  list(scope: string | undefined, id: string): PairView[] {
    const peers = new Set<string>();
    for (const p of [...this.pairs.values(), ...this.temporary.values()])
      if (p.scope === (scope ?? null) && (p.a === id || p.b === id)) peers.add(p.a === id ? p.b : p.a);
    return [...peers].sort().map(peer => this.state(scope, id, peer));
  }
  // `runtimes` returns the live Pi runtime ID of a registered session.
  // A failed write throws and leaves the previous approval unchanged.
  decide(scope: string | undefined, id: string, peer: string, mode: PairMode, context: string,
    runtimes: (id: string) => string | undefined): PairView {
    if (id === peer) throw Error('INVALID_INPUT: cannot approve own session');
    const [a, b] = [id, peer].sort();
    const key = pairKey(scope, id, peer);
    const aRuntime = runtimes(a), bRuntime = runtimes(b);
    if (mode !== 'none' && (!aRuntime || !bRuntime)) throw Error('TARGET_UNAVAILABLE: both exact sessions must be online to approve');
    const revision = this.revision + 1;
    if (mode === 'remembered' || this.pairs.has(key)) {
      const next = new Map(this.pairs);
      if (mode === 'remembered') next.set(key, { a, b, scope: scope ?? null, context, revision });
      else next.delete(key);
      this.persist(next);
      this.pairs.clear(); for (const [k, v] of next) this.pairs.set(k, v);
    }
    this.revision = revision;
    this.temporary.delete(key);
    if (mode === 'session') this.temporary.set(key, { a, b, scope: scope ?? null, context, aRuntime: aRuntime!, bRuntime: bRuntime!, revision });
    return this.state(scope, id, peer);
  }
  // End session-only approvals of `id` unless they belong to `keepRuntime`.
  // Returns affected peers. Remembered approvals are unaffected.
  expireSession(scope: string | undefined, id: string, keepRuntime?: string): string[] {
    const affected: string[] = [];
    for (const [key, live] of this.temporary) {
      if (live.scope !== (scope ?? null) || (live.a !== id && live.b !== id)) continue;
      if (keepRuntime && (live.a === id ? live.aRuntime : live.bRuntime) === keepRuntime) continue;
      affected.push(live.a === id ? live.b : live.a);
      this.temporary.delete(key);
    }
    if (affected.length) this.revision++;
    return affected;
  }
}
