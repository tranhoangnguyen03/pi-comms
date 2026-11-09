import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMessage, isSessionId, messageDeliveryFingerprint } from './protocol.ts';
import type { Message, SessionInfo } from '../types.ts';

// This is delivery responsibility, not a second transcript. The broker alone writes it.
export const MAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EVIDENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAIL_MAX_ITEMS = 256;
export const MAIL_MAX_BYTES = 32 * 1024 * 1024;
export const MAIL_MAX_EVIDENCE = 4096;
export const MAIL_MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
export type MailOutcome = 'receiver_recorded' | 'expired' | 'contact_ended' | 'peer_outdated' | 'cancelled';
export type MailItem = {
  from: SessionInfo; fromKey: string; targetKey: string; targetId: string;
  scope: string | null; message: Message; queuedAt: number; expiresAt: number; fingerprint: string;
};
export type MailEvidence = {
  fromKey: string; id: string; fingerprint: string; targetId: string;
  outcome: MailOutcome; at: number;
};
type Disk = { formatVersion: 1; pending: MailItem[]; terminal: MailEvidence[]; sha256: string };
const json = (x: unknown) => JSON.stringify(x);
const digest = (x: unknown) => createHash('sha256').update(json(x)).digest('hex');
export const mailFingerprint = (message: Message, targetId: string) => createHash('sha256').update(messageDeliveryFingerprint(message, targetId)).digest('hex');
const bytes = (x: unknown) => Buffer.byteLength(json(x), 'utf8');
const key = (fromKey: string, id: string) => json([fromKey, id]);
function validItem(x: any): x is MailItem {
  return x && typeof x === 'object' && !Array.isArray(x) &&
    typeof x.fromKey === 'string' && typeof x.targetKey === 'string' &&
    typeof x.targetId === 'string' && isSessionId(x.targetId) &&
    (x.scope === null || typeof x.scope === 'string') &&
    x.from && isSessionId(x.from.id) && isMessage(x.message) && isSessionId(x.message.id) &&
    Number.isSafeInteger(x.queuedAt) && Number.isSafeInteger(x.expiresAt) &&
    x.expiresAt === x.queuedAt + MAIL_TTL_MS &&
    typeof x.fingerprint === 'string' && x.fingerprint === mailFingerprint(x.message, x.targetId);
}
function validEvidence(x: any): x is MailEvidence {
  return x && typeof x === 'object' && !Array.isArray(x) &&
    typeof x.fromKey === 'string' && isSessionId(x.id) && isSessionId(x.targetId) &&
    typeof x.fingerprint === 'string' &&
    ['receiver_recorded','expired','contact_ended','peer_outdated','cancelled'].includes(x.outcome) &&
    Number.isSafeInteger(x.at) && x.at > 0;
}

export class DurableMailbox {
  private readonly path: string;
  private items: MailItem[] = [];
  private evidence: MailEvidence[] = [];
  readonly blocked: string | undefined;
  constructor(dir: string) {
    this.path = join(dir, 'mailbox.json');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) return;
    try {
      if (readFileSync(this.path).byteLength > MAX_FILE_BYTES) throw Error('oversized mailbox');
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Disk;
      if (data?.formatVersion !== 1 || !Array.isArray(data.pending) || !Array.isArray(data.terminal) ||
          data.sha256 !== digest([1, data.pending, data.terminal]) ||
          data.pending.length > MAIL_MAX_ITEMS || data.terminal.length > MAIL_MAX_EVIDENCE ||
          bytes(data.pending) > MAIL_MAX_BYTES || bytes(data.terminal) > MAIL_MAX_EVIDENCE_BYTES ||
          !data.pending.every(validItem) || !data.terminal.every(validEvidence)) throw Error('invalid mailbox version, checksum, or entry');
      const seen = new Set<string>();
      for (const x of [...data.pending, ...data.terminal]) {
        const k = key(x.fromKey, 'message' in x ? x.message.id : x.id);
        if (seen.has(k)) throw Error('duplicate mailbox identity');
        seen.add(k);
      }
      this.items = data.pending; this.evidence = data.terminal;
    } catch (error) {
      const aside = this.path + '.unreadable-' + Date.now();
      try { renameSync(this.path, aside); } catch { /* Do not overwrite unreadable evidence. */ }
      this.blocked = 'MAILBOX_UNREADABLE: ' + String(error) + '; preserved at ' + aside;
    }
  }
  private commit(pending: MailItem[], terminal: MailEvidence[]): void {
    if (this.blocked) throw Error(this.blocked);
    if (pending.length > MAIL_MAX_ITEMS || terminal.length > MAIL_MAX_EVIDENCE ||
        bytes(pending) > MAIL_MAX_BYTES || bytes(terminal) > MAIL_MAX_EVIDENCE_BYTES) throw Error('MAILBOX_FULL');
    const encoded = json({ formatVersion: 1, pending, terminal, sha256: digest([1, pending, terminal]) } satisfies Disk);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FILE_BYTES) throw Error('MAILBOX_FULL');
    const tmp = this.path + '.tmp.' + process.pid + '.' + randomUUID();
    try {
      writeFileSync(tmp, encoded, { mode: 0o600 });
      const fd = openSync(tmp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      try { const fd = openSync(dirname(this.path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
      catch { /* Directory fsync not available on all supported hosts. */ }
    } finally { rmSync(tmp, { force: true }); }
    this.items = pending; this.evidence = terminal;
  }
  get pending(): readonly MailItem[] { return this.items; }
  lookup(fromKey: string, id: string): MailItem | MailEvidence | undefined {
    return this.items.find(x => x.fromKey === fromKey && x.message.id === id) ??
      this.evidence.find(x => x.fromKey === fromKey && x.id === id);
  }
  enqueue(item: MailItem): void {
    if (this.blocked) throw Error(this.blocked);
    if (!validItem(item)) throw Error('MAILBOX_INVALID');
    if (this.lookup(item.fromKey, item.message.id)) throw Error('MAILBOX_DUPLICATE');
    this.pruneEvidence(item.queuedAt);
    // Reserve one outcome slot per pending delivery, so terminal records cannot
    // be lost merely because the accepted mailbox later fills.
    if (this.items.length >= MAIL_MAX_ITEMS ||
        this.items.length + this.evidence.length >= MAIL_MAX_EVIDENCE ||
        bytes([...this.items, item]) > MAIL_MAX_BYTES ||
        bytes(this.evidence) + (this.items.length + 1) * 512 > MAIL_MAX_EVIDENCE_BYTES) throw Error('MAILBOX_FULL');
    this.commit([...this.items, item], this.evidence);
  }
  settle(fromKey: string, id: string, outcome: MailOutcome, at = Date.now()): boolean {
    const item = this.items.find(x => x.fromKey === fromKey && x.message.id === id);
    if (!item) return false;
    const evidence: MailEvidence = { fromKey, id, fingerprint: item.fingerprint, targetId: item.targetId, outcome, at };
    this.commit(this.items.filter(x => x !== item), [...this.evidence, evidence]);
    return true;
  }
  expire(now = Date.now(), approved: (item: MailItem) => boolean = () => true): MailEvidence[] {
    if (this.blocked) return [];
    const ended = this.items.filter(x => x.expiresAt <= now || !approved(x));
    if (!ended.length) { this.pruneEvidence(now); return []; }
    const next = ended.map(x => ({
      fromKey: x.fromKey, id: x.message.id, fingerprint: x.fingerprint, targetId: x.targetId,
      outcome: (x.expiresAt <= now ? 'expired' : 'contact_ended') as MailOutcome, at: now,
    }));
    const retainedEvidence = this.evidence.filter(x => now - x.at <= EVIDENCE_TTL_MS);
    this.commit(this.items.filter(x => !ended.includes(x)), [...retainedEvidence, ...next]);
    return next;
  }
  pruneEvidence(now = Date.now()): void {
    if (this.blocked) return;
    const terminal = this.evidence.filter(x => now - x.at <= EVIDENCE_TTL_MS);
    if (terminal.length !== this.evidence.length) this.commit(this.items, terminal);
  }
}
