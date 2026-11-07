import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { EnvelopeSchema, Id, checkSize } from './schema.ts';

// One namespace keeps future versions visible to older readers. It is state,
// not a custom_message: neither held payloads nor controls enter model context.
export const RECORD_TYPE = 'pi-comms:state';
export type SaveState = 'saved' | 'volatile';
const FactSchema = Type.Object({
  kind: Type.Union([Type.Literal('accepted'), Type.Literal('queued'), Type.Literal('posted'), Type.Literal('handed-off'), Type.Literal('saved'), Type.Literal('summarized'), Type.Literal('rejected')]),
  at: Type.String(), source: Type.String(), evidenceRef: Type.Optional(Type.String()),
}, { additionalProperties: false });
const IntakeSchema = Type.Union([Type.Literal('waiting'), Type.Literal('offered'), Type.Literal('posted'), Type.Literal('handed-off'), Type.Literal('summarized'), Type.Literal('dismissed')]);
const StateSchema = Type.Union([Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('unknown')]);
const StoredMessageSchema = Type.Object({ ...EnvelopeSchema.properties, from: Id, to: Id }, { additionalProperties: false });
const StoredEntrySchema = Type.Object({
  message: StoredMessageSchema, facts: Type.Array(FactSchema), state: StateSchema,
  readable: Type.Boolean(), returnHandle: Type.Optional(Id),
  code: Type.Optional(Type.String()), intake: Type.Optional(IntakeSchema),
  linkage: Type.Optional(Type.Literal('context-lost')), reportLinkage: Type.Optional(Type.Literal('context-lost')),
}, { additionalProperties: false });
export const RecoveryEventSchema = Type.Union([
  Type.Object({ kind: Type.Literal('message'), entry: StoredEntrySchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('outcome'), id: Id, state: StateSchema, code: Type.Optional(Type.String()) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fact'), id: Id, fact: FactSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('visibility'), ids: Type.Array(Id) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('intake'), ids: Type.Array(Id), disposition: IntakeSchema, source: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('pause'), value: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('contact'), peer: Id, revoked: Type.Boolean(), readableIds: Type.Optional(Type.Array(Id)), remembered: Type.Optional(Type.Object({ name: Type.String(), context: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
]);
export type RecoveryEvent = Static<typeof RecoveryEventSchema>;
export type RecordWriter = (event: RecoveryEvent) => SaveState;
export type NativeEntry = { type: string; id?: string; customType?: string; data?: unknown; details?: unknown; message?: any; [key: string]: unknown };
export type RecordHost = {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): readonly NativeEntry[];
  append(customType: string, data: unknown): void;
};
export type RecordStatus = { state: SaveState | 'blocked'; reason?: string };
type StoredRecord = { version: 1; owner: string; scope: string; writeId: string; event: RecoveryEvent };

export function isRecoveryEvent(value: unknown): value is RecoveryEvent {
  if (!Check(RecoveryEventSchema, value)) return false;
  try {
    const event = value as RecoveryEvent;
    if (event.kind === 'message') checkSize(event.entry.message);
    // An explicit deny can never make previously withheld content readable.
    if (event.kind === 'contact' && event.revoked && (event.readableIds?.length || event.remembered)) return false;
    return true;
  } catch { return false; }
}

/** Read-only inspection of the host file; all writes go through pi.appendEntry. */
export class NativeSessionRecords {
  private active = true;
  private status: RecordStatus = { state: 'volatile' };
  private sawFile = false;
  constructor(readonly owner: string, readonly scope: string, private host: RecordHost) {}
  close() { this.active = false; }
  info(): RecordStatus { return { ...this.status }; }
  block(reason: string) { this.status = { state: 'blocked', reason }; }
  assertWritable() {
    if (!this.active || this.host.getSessionId() !== this.owner) throw new Error('CONTEXT_LOST: record writer belongs to an earlier session');
    if (this.status.state === 'blocked') throw new Error(`RECOVERY_BLOCKED: ${this.status.reason}`);
  }
  private fileSize(path: string): number | undefined {
    try { return statSync(path).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private readFile(): NativeEntry[] {
    const path = this.host.getSessionFile();
    if (!path) { if (this.status.state !== 'blocked') this.status = { state: 'volatile' }; return []; }
    try {
      const size = this.fileSize(path);
      if (size === undefined) {
        const conversation = this.host.getEntries().some(entry => entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role));
        if (this.sawFile || conversation) this.block('The native session file is missing. Communication is held; existing verified history remains inspectable.');
        else if (this.status.state !== 'blocked') this.status = { state: 'volatile' };
        return [];
      }
      this.sawFile = true;
      const text = readFileSync(path, 'utf8');
      const entries: NativeEntry[] = [];
      let malformed = false;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as NativeEntry).type !== 'string') malformed = true;
          else entries.push(parsed as NativeEntry);
        } catch { malformed = true; }
      }
      if (entries[0]?.type !== 'session' || entries[0]?.id !== this.owner) {
        this.block('Native session identity is missing or conflicting. No restored controls or messages will be admitted.');
        return [];
      }
      if (malformed) this.block('Malformed native session data may hide a contact control. Communication is held; preserve the file and repair it before reloading.');
      else if (this.status.state !== 'blocked') this.status = { state: 'saved' };
      return entries.slice(1);
    } catch (error) {
      this.block(`Cannot read the native session file: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
  load(): { events: RecoveryEvent[]; native: NativeEntry[]; legacy: boolean } {
    const native = this.readFile();
    // Buffered/ephemeral state can survive a reload in this process, but is
    // never presented as disk evidence or as a restart guarantee.
    const source = this.status.state === 'volatile' ? this.host.getEntries() : native;
    const events: RecoveryEvent[] = [];
    const writes = new Map<string, StoredRecord>();
    for (const entry of source) {
      if (entry.type !== 'custom' || entry.customType !== RECORD_TYPE) continue;
      const value = entry.data as Partial<StoredRecord> | undefined;
      if (!value || typeof value !== 'object' || typeof value.owner !== 'string' || typeof value.scope !== 'string') {
        this.block('A communication record has no valid owner or scope. New communication is held.'); continue;
      }
      if (value.owner !== this.owner || value.scope !== this.scope) continue; // A native fork is a different participant.
      if (value.version !== 1 || typeof value.writeId !== 'string' || !Check(Id, value.writeId) || !isRecoveryEvent(value.event)) {
        this.block('A communication record is invalid or uses an unsupported version. New communication is held.'); continue;
      }
      const record = value as StoredRecord;
      const previous = writes.get(record.writeId);
      if (previous) {
        if (!isDeepStrictEqual(previous, record)) this.block('Conflicting communication write IDs. New communication is held.');
        continue;
      }
      writes.set(record.writeId, record); events.push(structuredClone(record.event));
    }
    return { events, native, legacy: !events.length && native.some(entry => entry.customType === 'comms_batch') };
  }
  nativeEntries(): NativeEntry[] { return this.readFile(); }
  append: RecordWriter = event => {
    this.assertWritable();
    if (!isRecoveryEvent(event)) throw new Error('INVALID_INPUT: invalid internal communication record');
    const record: StoredRecord = { version: 1, owner: this.owner, scope: this.scope, writeId: randomUUID(), event: structuredClone(event) };
    const path = this.host.getSessionFile();
    let before: number | undefined;
    try { if (path) before = this.fileSize(path); }
    catch (error) { this.block(`Cannot inspect native session storage: ${String(error)}`); this.assertWritable(); }
    if (path && before === undefined && this.sawFile) { this.block('Native session storage disappeared. No new message was sent.'); this.assertWritable(); }
    let appendError: unknown;
    try { this.host.append(RECORD_TYPE, record); } catch (error) { appendError = error; }
    // appendEntry can notify a failing listener after the file write. Check
    // actual appended bytes before treating that exception as a failed commit.
    try {
      if (path) {
        const after = this.fileSize(path);
        if (after !== undefined) {
          this.sawFile = true;
          const offset = before ?? 0;
          if (after < offset) throw new Error('Native session storage shrank during append');
          const fd = openSync(path, 'r');
          const bytes = Buffer.alloc(after - offset);
          try { let read = 0; while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, offset + read); if (!count) break; read += count; } }
          finally { closeSync(fd); }
          for (const line of bytes.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            let entry: NativeEntry;
            try { entry = JSON.parse(line); } catch { throw new Error('Malformed native append; save not confirmed'); }
            if (entry.type === 'custom' && entry.customType === RECORD_TYPE && isDeepStrictEqual(entry.data, record)) {
              this.status = { state: 'saved' }; return 'saved';
            }
          }
          throw new Error('Native append was not found on disk');
        }
        if (before !== undefined) throw new Error('Native session file disappeared during append');
      }
      if (appendError) throw appendError;
      this.status = { state: 'volatile' }; return 'volatile';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.block(`Native save failed: ${reason}. Do not resend an uncertain operation; inspect available records.`);
      throw new Error(`PERSISTENCE_FAILED: ${reason}`);
    }
  };
}
