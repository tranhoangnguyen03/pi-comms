import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// One broker-owned decision per unordered exact pair. No owner election,
// per-participant approval database or fallback to a previous grant snapshot.
export type PairMode = 'session' | 'remembered' | 'revoked' | 'none';
export type PairView = { peer: string; mode: PairMode; context?: string; revision: number };
type PersistentMode = 'remembered' | 'revoked' | 'none';
type Record = { a: string; b: string; scope: string | null; mode: PersistentMode; context?: string; revision: number };
type Temporary = { a: string; b: string; scope: string | null; context: string; aEpoch: string; bEpoch: string; revision: number };
type FileData = { formatVersion: 1; revision: number; pairs: Record[]; sha256: string };

const json = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
export const pairKey = (scope: string | undefined, a: string, b: string) =>
  json([scope ?? null, ...[a, b].sort()]);

export class PairApprovalStore {
  private readonly file: string;
  private readonly pairs = new Map<string, Record>();
  private readonly temporary = new Map<string, Temporary>();
  private revision = 0;
  private error: string | undefined;
  constructor(runtimeDir: string) {
    this.file = join(runtimeDir, 'pair-approvals.json');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      if (!existsSync(this.file)) return; // Missing means no approval, never a restored grant.
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Not a valid pair snapshot');
      const data = parsed as FileData;
      if (data.formatVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
          !Array.isArray(data.pairs) || hash([data.formatVersion, data.revision, data.pairs]) !== data.sha256)
        throw Error('Invalid version, revision or checksum');
      for (const value of data.pairs) {
        if (!value || typeof value.a !== 'string' || typeof value.b !== 'string' ||
            (typeof value.scope !== 'string' && value.scope !== null) ||
            !['remembered', 'revoked', 'none'].includes(value.mode) ||
            (value.context !== undefined && typeof value.context !== 'string') ||
            !Number.isSafeInteger(value.revision) || value.revision > data.revision ||
            value.a >= value.b) throw Error('Malformed pair entry');
        const key = pairKey(value.scope ?? undefined, value.a, value.b);
        if (this.pairs.has(key)) throw Error('Conflicting pair record');
        this.pairs.set(key, value);
      }
      this.revision = data.revision;
    } catch (error) {
      this.error = `PAIR_STATE_BLOCKED: invalid broker pair state: ${String(error)}. No previous backup is used.`;
    }
  }
  holdReason() { return this.error; }
  private assertReady() { if (this.error) throw Error(this.error); }
  private persist(next: Map<string, Record>, revision: number) {
    this.assertReady();
    const pairs = [...next.values()].sort((x, y) => pairKey(x.scope ?? undefined, x.a, x.b).localeCompare(pairKey(y.scope ?? undefined, y.a, y.b)));
    const payload: FileData = { formatVersion: 1, revision, pairs, sha256: hash([1, revision, pairs]) };
    const temp = `${this.file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(temp, json(payload), { mode: 0o600 });
      const fd = openSync(temp, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file);
      // Directory fsync where supported. No .bak fallback may revive a revoke.
      try { const fd = openSync(dirname(this.file), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
      catch { /* Unsupported on some platforms. */ }
    } catch (error) {
      // Failed/uncertain commit is not acknowledged. Inspect the newest
      // primary on restart, and hold if corrupted rather than guessing.
      this.error = `PAIR_STATE_BLOCKED: pair state write failed: ${String(error)}`;
      throw Error(this.error);
    } finally { rmSync(temp, { force: true }); }
  }
  state(scope: string | undefined, id: string, peer: string, epochs: (id: string) => string | undefined): PairView {
    this.assertReady();
    const key = pairKey(scope, id, peer), saved = this.pairs.get(key), live = this.temporary.get(key);
    if (saved?.mode === 'remembered') return { peer, mode: 'remembered', context: saved.context, revision: saved.revision };
    if (live && live.aEpoch === epochs(live.a) && live.bEpoch === epochs(live.b))
      return { peer, mode: 'session', context: live.context, revision: live.revision };
    return { peer, mode: saved?.mode === 'revoked' ? 'revoked' : 'none', revision: saved?.revision ?? 0 };
  }
  list(scope: string | undefined, id: string, epochs: (id: string) => string | undefined): PairView[] {
    this.assertReady();
    const candidates = new Set<string>();
    for (const p of [...this.pairs.values(), ...this.temporary.values()])
      if (p.scope === (scope ?? null) && (p.a === id || p.b === id)) candidates.add(p.a === id ? p.b : p.a);
    return [...candidates].sort().map(peer => this.state(scope, id, peer, epochs));
  }
  decide(scope: string | undefined, id: string, peer: string, mode: Exclude<PairMode, 'none'>, context: string,
    epochs: (id: string) => string | undefined): PairView {
    this.assertReady();
    if (id === peer) throw Error('PAIR_INVALID_TARGET: cannot approve own session');
    const [a, b] = [id, peer].sort();
    const key = pairKey(scope, id, peer);
    const aEpoch = epochs(a), bEpoch = epochs(b);
    if (mode !== 'revoked' && (!aEpoch || !bEpoch)) throw Error('PAIR_PEER_OFFLINE: both exact sessions must be online to approve');
    const revision = this.revision + 1;
    const next = new Map(this.pairs);
    next.set(key, { a, b, scope: scope ?? null, mode: mode === 'remembered' ? 'remembered' : mode === 'revoked' ? 'revoked' : 'none',
      ...(mode === 'remembered' ? { context } : {}), revision });
    this.persist(next, revision);
    this.pairs.clear(); for (const [k, v] of next) this.pairs.set(k, v);
    this.revision = revision;
    this.temporary.delete(key);
    if (mode === 'session') this.temporary.set(key, { a, b, scope: scope ?? null, context, aEpoch: aEpoch!, bEpoch: bEpoch!, revision });
    return this.state(scope, id, peer, epochs);
  }
  expireSession(scope: string | undefined, id: string): string[] {
    const affected: string[] = [];
    for (const [key, live] of this.temporary) {
      if (live.scope === (scope ?? null) && (live.a === id || live.b === id)) {
        affected.push(live.a === id ? live.b : live.a);
        this.temporary.delete(key);
      }
    }
    return affected;
  }
}
