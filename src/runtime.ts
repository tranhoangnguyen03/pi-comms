import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Id, MessageInput, EnvelopeSchema, checkSize, validate, type Envelope, InspectInput } from './schema.ts';
import type { Attempt } from './session-send.ts';
import { isRecoveryEvent, type RecoveryEvent, type RecordWriter, type SaveState } from './session-records.ts';

export type Fact = { kind: 'accepted' | 'queued' | 'posted' | 'saved' | 'summarized' | 'rejected'; at: string; source: string; evidenceRef?: string };
export type Message = Envelope & { from: string; to: string };
type Intake = 'waiting' | 'offered' | 'posted' | 'summarized';
export type Entry = { message: Message; facts: Fact[]; state: Attempt['outcome']; code?: string; returnHandle?: string; linkage?: 'context-lost'; reportLinkage?: 'context-lost'; readable?: boolean; intake?: Intake };
export type Approval = { id: string; name: string; context: string };
export class Runtime {
  private approvals = new Map<string, Approval>();
  private revoked = new Set<string>();
  private records = new Map<string, Entry>();
  private returns = new Map<string, Message>();
  private saveStates = new Map<string, SaveState | 'partial'>();
  private uncertainAdmission = new Set<string>();
  private recoveryIssue: string | undefined;
  private pause = false;
  waiting: string[] = [];
  constructor(readonly self: string, private transport: (id: string, envelope: Envelope) => Promise<Attempt>, private writer?: RecordWriter) {}
  get paused() { return this.pause; }
  set paused(value: boolean) {
    if (this.pause === value) return;
    // A human stop applies immediately, even when saving the control fails.
    if (value) this.pause = true;
    this.write({ kind: 'pause', value });
    this.pause = value;
  }
  holdReason() { return this.recoveryIssue; }
  holdRecovery(reason: string) { this.recoveryIssue ??= reason; }
  assertOperational() { if (this.recoveryIssue) throw new Error(`RECOVERY_BLOCKED: ${this.recoveryIssue}`); }
  private write(event: RecoveryEvent, ids: string[] = []) {
    this.assertOperational();
    try {
      const state = this.writer?.(event) ?? 'volatile';
      ids.forEach(id => this.saveStates.set(id, state));
      return state;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ids.forEach(id => this.saveStates.set(id, 'partial'));
      this.holdRecovery(reason);
      throw error;
    }
  }
  // Recovery is a reduction of our own native entries, never a replay of sends.
  // Approval grants intentionally do not survive this F10 slice.
  restore(events: readonly RecoveryEvent[], saved: SaveState = 'saved') {
    if (this.records.size || this.approvals.size) throw new Error('INVALID_INPUT: restore requires a fresh runtime');
    for (const raw of events) {
      try {
        if (!isRecoveryEvent(raw)) throw new Error('Invalid communication record');
        const event = structuredClone(raw);
        switch (event.kind) {
          case 'message': {
            const entry = event.entry as Entry;
            const message = entry.message;
            const outgoing = message.from === this.self && message.to !== this.self;
            const incoming = message.to === this.self && message.from !== this.self;
            if (!outgoing && !incoming) throw new Error('Record belongs to a different participant');
            if (outgoing && (entry.returnHandle || entry.intake) || incoming && (!entry.returnHandle || entry.intake !== 'waiting')) throw new Error('Invalid recorded message direction');
            const prior = this.records.get(message.id);
            if (prior) {
              if (!isDeepStrictEqual(prior.message, message) || prior.returnHandle !== entry.returnHandle) throw new Error('Conflicting recorded message ID');
              break;
            }
            if (entry.returnHandle && this.returns.has(entry.returnHandle)) throw new Error('Conflicting recorded reply handle');
            this.records.set(message.id, entry);
            if (entry.returnHandle) this.returns.set(entry.returnHandle, message);
            this.saveStates.set(message.id, saved);
            break;
          }
          case 'outcome': {
            const entry = this.required(event.id);
            if (entry.message.from !== this.self) throw new Error('Outgoing outcome attached to an incoming message');
            entry.state = event.state as Attempt['outcome']; entry.code = event.code;
            break;
          }
          case 'fact': this.addFact(this.required(event.id), event.fact as Fact); break;
          case 'visibility':
            for (const id of event.ids) { const entry = this.required(id); if (entry.message.to !== this.self) throw new Error('Visibility attached to an outgoing message'); entry.readable = true; }
            break;
          case 'intake':
            for (const id of event.ids) { const entry = this.required(id); if (entry.message.to !== this.self) throw new Error('Intake attached to an outgoing message'); entry.intake = event.disposition as Intake; }
            break;
          case 'pause': this.pause = event.value; break;
          case 'contact': if (event.revoked) this.revoked.add(event.peer); else this.revoked.delete(event.peer); break;
        }
      } catch (error) {
        this.holdRecovery(`Saved communication is incomplete: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const entry of this.records.values()) {
      if (entry.message.to !== this.self || entry.intake === 'summarized') continue;
      this.waiting.push(entry.message.id);
      if (entry.intake !== 'waiting') this.uncertainAdmission.add(entry.message.id);
    }
  }
  private required(id: string) {
    const entry = this.records.get(id);
    if (!entry) throw new Error('Communication change has no original message');
    return entry;
  }
  private allowHistory(id: string) {
    const ids = [...this.records.values()].filter(entry => entry.message.from === id && !entry.readable).map(entry => entry.message.id);
    if (!ids.length) return;
    this.write({ kind: 'visibility', ids }, ids);
    ids.forEach(message => { this.records.get(message)!.readable = true; });
  }
  // Passed only to the human command handler, never registered as an agent tool.
  approveFromOwner(peer: Approval) {
    validate(Id, peer.id); this.assertOperational();
    this.write({ kind: 'contact', peer: peer.id, revoked: false });
    this.allowHistory(peer.id);
    this.revoked.delete(peer.id); this.approvals.set(peer.id, { ...peer });
  }
  // Only a fresh transport assertion reaches this path. It can authorize this
  // runtime, not a positive grant in the restored owner's next runtime.
  approveFromTransport(peer: Approval) {
    if (this.revoked.has(peer.id) || this.isApproved(peer.id)) return;
    this.assertOperational(); this.allowHistory(peer.id); this.approvals.set(peer.id, { ...peer });
  }
  revokeFromOwner(id: string) {
    validate(Id, id); this.revoked.add(id); this.approvals.delete(id);
    this.write({ kind: 'contact', peer: id, revoked: true });
  }
  isRevoked = (id: string) => this.revoked.has(id);
  approval(id: string) { const peer = this.approvals.get(id); return peer ? { ...peer } : undefined; }
  isApproved = (id: string) => this.approvals.has(id);
  known() { return [...this.approvals.values()].map(p => ({ ...p })); }
  peerLabels(id: string) {
    return [...this.records.values()].reverse()
      .filter(entry => entry.message.from === this.self && entry.message.to === id && entry.message.recipientLabel !== undefined && entry.state === 'accepted')
      .slice(0, 8)
      .map(entry => ({ exchange: entry.message.exchange, workRef: entry.message.workRef ?? null, label: entry.message.recipientLabel!, source: 'sender-supplied' as const }));
  }
  entry(id: string) { return this.records.get(id); }
  private addFact(entry: Entry, fact: Fact) {
    if (!entry.facts.some(existing => existing.kind === fact.kind && existing.evidenceRef === fact.evidenceRef)) entry.facts.push(fact);
  }
  fact(id: string, kind: Fact['kind'], source: string, evidenceRef?: string) {
    const entry = this.records.get(id);
    if (!entry || entry.facts.some(f => f.kind === kind && f.evidenceRef === evidenceRef)) return;
    const fact: Fact = { kind, at: new Date().toISOString(), source, ...(evidenceRef ? { evidenceRef } : {}) };
    // Native saved-history evidence is already stored by Pi. Do not duplicate
    // that evidence in another stream, or append merely because we inspected it.
    if (kind !== 'saved') this.write({ kind: 'fact', id, fact }, [id]);
    this.addFact(entry, fact);
  }
  observedNative(ids: string[], evidenceRef: string) {
    for (const id of ids) {
      const entry = this.records.get(id);
      if (!entry || entry.message.to !== this.self) continue;
      entry.intake = 'posted'; entry.readable = true;
      this.uncertainAdmission.delete(id);
      this.waiting = this.waiting.filter(waiting => waiting !== id);
      this.fact(id, 'saved', 'native session entry observed on disk', evidenceRef);
    }
  }
  contactFor(input: MessageInput) {
    validate(MessageInput, input); checkSize(input);
    const source = 'respondTo' in input ? this.returns.get(input.respondTo) : undefined;
    if ('respondTo' in input && !source) throw new Error('CONTEXT_LOST');
    const to = source?.from ?? input.to;
    validate(Id, to);
    const correction = input.corrects ? this.records.get(input.corrects)?.message : undefined;
    if (input.corrects && (!correction || correction.from !== this.self || correction.to !== to)) throw new Error('INVALID_INPUT: correction must reference your message to this exact peer');
    if (input.handoverFrom) {
      const prior = [...this.records.values()].some(entry => entry.message.exchange === input.handoverFrom && this.visible(entry, 'agent'));
      if (!prior) throw new Error('CONTEXT_LOST: handover source exchange is not available to this session; no message was sent');
    }
    return { to, source };
  }
  async send(input: MessageInput, registered?: (entry: Entry) => void) {
    this.assertOperational();
    const { to, source } = this.contactFor(input);
    if (!this.isApproved(to)) throw new Error('CONTACT_NOT_APPROVED');
    if (input.report) {
      const request = this.records.get(input.report.request)?.message;
      if (!source || !request || request.from !== to || request.to !== this.self || request.exchange !== source.exchange) throw new Error('INVALID_INPUT: work report must reference a received request from this exact colleague in the same exchange; no message was sent');
    }
    const workRef = source?.workRef ?? input.workRef;
    const envelope: Envelope = {
      id: randomUUID(), exchange: source?.exchange ?? randomUUID(), subject: source?.subject ?? ('subject' in input ? input.subject : ''),
      text: input.text, refs: input.refs ?? [], ...(workRef ? { workRef } : {}),
      ...(!source && input.recipientLabel ? { recipientLabel: input.recipientLabel } : {}),
      ...(!source && input.handoverFrom ? { handoverFrom: input.handoverFrom } : {}),
      ...(input.structured ? { structured: input.structured } : {}), ...(input.report ? { report: input.report } : {}),
      replyTo: source?.id ?? null, corrects: input.corrects ?? null, createdAt: new Date().toISOString(),
    };
    checkSize(envelope, this.approval(to)?.context);
    const entry: Entry & { readable: boolean } = { message: { ...envelope, from: this.self, to }, facts: [], state: 'unknown', readable: true };
    this.write({ kind: 'message', entry }, [envelope.id]);
    this.records.set(envelope.id, entry);
    registered?.(entry);
    let outcome: Attempt;
    try { outcome = await this.transport(to, envelope); } catch { outcome = { outcome: 'unknown', code: 'OUTCOME_UNKNOWN' }; }
    // Once dispatch happened, a failed save or switched session cannot turn an
    // observed send into a misleading "nothing sent" result.
    entry.state = outcome.outcome; entry.code = outcome.code;
    try {
      this.write({ kind: 'outcome', id: envelope.id, state: outcome.outcome, ...(outcome.code ? { code: outcome.code } : {}) }, [envelope.id]);
      if (outcome.outcome !== 'unknown') this.fact(envelope.id, outcome.outcome === 'accepted' ? 'accepted' : 'rejected', 'broker');
    } catch { this.saveStates.set(envelope.id, 'partial'); }
    return this.view(entry);
  }
  receive(from: string, envelope: Envelope) {
    this.assertOperational(); validate(Id, from); validate(EnvelopeSchema, envelope); checkSize(envelope);
    const message: Message = { ...structuredClone(envelope), from, to: this.self };
    const previous = this.records.get(envelope.id);
    if (previous) {
      if (!isDeepStrictEqual(previous.message, message)) throw new Error('INVALID_INPUT: conflicting message ID');
      return false;
    }
    let contextLost = false;
    if (envelope.replyTo) {
      if (envelope.recipientLabel !== undefined) throw new Error('INVALID_INPUT: recipient label belongs to the new exchange, not a reply');
      const source = this.records.get(envelope.replyTo)?.message;
      if (!source) contextLost = true;
      else {
        if (source.from !== this.self || source.to !== from || source.exchange !== envelope.exchange) throw new Error('INVALID_INPUT: invalid reply linkage');
        if (source.workRef !== envelope.workRef) throw new Error('INVALID_INPUT: reply must preserve the exchange work reference');
      }
    }
    let reportLinkage: 'context-lost' | undefined;
    if (envelope.report) {
      if (!envelope.replyTo) throw new Error('INVALID_INPUT: a work report must be a reply');
      const request = this.records.get(envelope.report.request)?.message;
      if (!request) reportLinkage = 'context-lost';
      else if (request.from !== this.self || request.to !== from || request.exchange !== envelope.exchange) throw new Error('INVALID_INPUT: work report references a different request, colleague or exchange');
    }
    if (envelope.corrects) {
      const source = this.records.get(envelope.corrects)?.message;
      if (!source || source.from !== from || source.to !== this.self) throw new Error('INVALID_INPUT: invalid correction linkage');
    }
    const handle = randomUUID();
    const entry: Entry & { readable: boolean } = {
      message, facts: [{ kind: 'queued', at: new Date().toISOString(), source: 'receiver runtime' }], state: 'accepted',
      returnHandle: handle, readable: this.isApproved(from), intake: 'waiting',
      ...(contextLost ? { linkage: 'context-lost' } : {}), ...(reportLinkage ? { reportLinkage } : {}),
    };
    this.write({ kind: 'message', entry }, [envelope.id]);
    this.returns.set(handle, message); this.records.set(envelope.id, entry); this.waiting.push(envelope.id);
    return true;
  }
  eligible() {
    if (this.recoveryIssue) return [];
    return this.waiting.filter(id => this.isApproved(this.records.get(id)!.message.from) && this.records.get(id)!.intake === 'waiting' && !this.uncertainAdmission.has(id));
  }
  offered(ids: string[], source = 'native Pi sendMessage') {
    const pending = ids.filter(id => this.waiting.includes(id) && this.records.get(id)?.intake === 'waiting');
    if (!pending.length) return;
    this.write({ kind: 'intake', ids: pending, disposition: 'offered', source }, pending);
    pending.forEach(id => { this.records.get(id)!.intake = 'offered'; this.uncertainAdmission.add(id); });
  }
  posted(ids: string[], source = 'native Pi sendMessage') {
    if (!ids.length) return;
    this.offered(ids, source);
    this.write({ kind: 'intake', ids, disposition: 'posted', source }, ids);
    const posted = new Set(ids);
    this.waiting = this.waiting.filter(id => !posted.has(id));
    ids.forEach(id => { const entry = this.required(id); entry.intake = 'posted'; this.uncertainAdmission.delete(id); this.addFact(entry, { kind: 'posted', at: new Date().toISOString(), source }); });
  }
  summarized(ids: string[]) {
    if (!ids.length) return;
    this.write({ kind: 'intake', ids, disposition: 'summarized', source: 'request-aware intake' }, ids);
    const done = new Set(ids); this.waiting = this.waiting.filter(id => !done.has(id));
    ids.forEach(id => { const entry = this.required(id); entry.intake = 'summarized'; this.addFact(entry, { kind: 'summarized', at: new Date().toISOString(), source: 'request-aware intake' }); });
  }
  private reportsFor(requestId: string, audience: 'agent' | 'human' = 'agent') {
    const request = this.records.get(requestId)?.message;
    if (!request || request.from !== this.self) return [];
    return [...this.records.values()].filter(entry => entry.message.report?.request === requestId && entry.message.from === request.to && entry.message.exchange === request.exchange && !entry.reportLinkage && this.visible(entry, audience));
  }
  private actionableReport(entry: Entry) { return !!entry.message.report && (entry.message.report.state !== 'progress' || !!entry.message.corrects); }
  reportState(requestId: string, audience: 'agent' | 'human' = 'agent') {
    const reports = this.reportsFor(requestId, audience);
    const lastActionable = [...reports].reverse().find(entry => this.actionableReport(entry));
    const current = lastActionable ?? reports.at(-1);
    const laterProgressCount = lastActionable ? reports.slice(reports.indexOf(lastActionable) + 1).filter(e => e.message.report?.state === 'progress').length : 0;
    return { reports, current, laterProgressCount };
  }
  handoversFrom(exchange: string) {
    return [...this.records.values()].filter(entry => entry.message.from === this.self && entry.message.handoverFrom === exchange)
      .map(entry => ({ toExchange: entry.message.exchange, toPeer: entry.message.to, message: entry.message.id, state: entry.state, code: entry.code ?? null }));
  }
  reportNote(entry: Entry) {
    const report = entry.message.report;
    if (!report || entry.reportLinkage) return '';
    const { reports, current } = this.reportState(report.request);
    const earlier = reports.slice(0, reports.findIndex(e => e.message.id === entry.message.id));
    const progress = earlier.filter(e => e.message.report?.state === 'progress').length;
    const previousActions = earlier.filter(entry => this.actionableReport(entry));
    const parts = [];
    if (progress) parts.push(`${progress} earlier progress report(s) retained in inspection`);
    if (previousActions.length) parts.push(`earlier peer state: ${previousActions.at(-1)!.message.report!.state}`);
    if (current && current.message.id !== entry.message.id) parts.push(`a later actionable state (${current.message.report!.state}) is on record`);
    return parts.length ? `Report history for request ${report.request}: ${parts.join('; ')}.\n` : '';
  }
  planIntake(ids: string[]) {
    const eligible = new Set(this.eligible());
    const deliver: Entry[] = [], summarized: string[] = [];
    for (const id of ids) {
      const entry = this.records.get(id);
      if (!entry || !eligible.has(id)) continue;
      if (entry.message.report?.state === 'progress' && !entry.reportLinkage && !entry.message.corrects) summarized.push(id);
      else deliver.push(entry);
    }
    return { deliver, summarized };
  }
  private visible(entry: Entry, audience: 'agent' | 'human') { return audience === 'human' || entry.message.from === this.self || entry.readable === true; }
  private project(entry: Entry, audience: 'agent' | 'human') {
    if (!this.visible(entry, audience)) {
      const { id, exchange, from, to } = entry.message;
      return { message: { id, exchange, from, to }, evidence: 'withheld', code: 'CONTACT_NOT_APPROVED' };
    }
    return this.view(entry);
  }
  view(entry: Entry) {
    return structuredClone({ ...entry, responses: [...this.records.values()].filter(r => r.message.replyTo === entry.message.id).map(r => r.message.id), evidence: 'available',
      record: { state: this.saveStates.get(entry.message.id) ?? 'volatile', ...(this.saveStates.get(entry.message.id) === 'partial' ? { warning: 'The latest observation was not saved. Do not resend solely because of this storage failure.' } : {}) },
      ...(this.uncertainAdmission.has(entry.message.id) ? { admission: 'uncertain' as const } : {}),
    });
  }
  page(entries: Entry[], cursor?: string, audience: 'agent' | 'human' = 'agent') {
    const start = cursor ? entries.findIndex(e => e.message.id === cursor) + 1 : 0;
    if (cursor && start === 0) throw new Error('CONTEXT_LOST: cursor no longer available');
    const items: ReturnType<Runtime['project']>[] = []; let bytes = 0;
    for (const entry of entries.slice(start)) {
      const view = this.project(entry, audience); const size = Buffer.byteLength(JSON.stringify(view));
      if (items.length && bytes + size > MAX_PAGE_BYTES) break;
      items.push(view); bytes += size; if (items.length === 30) break;
    }
    return { items, nextCursor: start + items.length < entries.length ? items.at(-1)!.message.id : null };
  }
  inspect(input: InspectInput, audience: 'agent' | 'human' = 'agent') {
    validate(InspectInput, input);
    if (input.message) {
      const entry = this.records.get(input.message); if (!entry) throw new Error('CONTEXT_LOST'); return this.project(entry, audience);
    }
    const records = [...this.records.values()];
    if (input.requests) return { responses: input.requests.map(id => {
      const request = this.records.get(id);
      if (!request || request.message.from !== this.self) return { request: id, outcome: 'context-lost' };
      const replies = records.filter(entry => entry.message.replyTo === id && entry.message.from === request.message.to);
      const { reports, current, laterProgressCount } = this.reportState(id, audience);
      return { request: id, peer: request.message.to, subject: request.message.subject, workRef: request.message.workRef ?? null, state: request.state,
        code: request.code, outcome: replies.length ? 'reply-received' : request.state === 'accepted' ? 'no-reply-yet' : request.state,
        responseCount: replies.length, replies: replies.slice(-1).map(entry => this.project(entry, audience)),
        reportCount: reports.length, ...(reports.length ? { latestReport: this.project(reports.at(-1)!, audience) } : {}),
        ...(current ? { currentReport: this.project(current, audience) } : {}), ...(laterProgressCount ? { laterProgressCount } : {}) };
    }) };
    if (input.peer || input.workRef || !input.exchange && !input.queue && !input.outbox) {
      const latest = new Map<string, Entry>();
      for (const entry of records) {
        if (input.peer && entry.message.from !== input.peer && entry.message.to !== input.peer) continue;
        if (input.workRef && (entry.message.workRef !== input.workRef || !this.visible(entry, audience))) continue;
        if (entry.message.report?.state === 'progress' && !entry.message.corrects) {
          const current = this.reportState(entry.message.report.request, audience).current;
          if (current && this.actionableReport(current)) continue;
        }
        latest.delete(entry.message.exchange); latest.set(entry.message.exchange, entry);
      }
      const exchanges = [...latest.values()].reverse().map(entry => {
        const visible = this.visible(entry, audience);
        const labeled = visible ? records.find(record => record.message.exchange === entry.message.exchange && record.message.recipientLabel !== undefined && this.visible(record, audience))?.message : undefined;
        return { exchange: entry.message.exchange, peer: entry.message.from === this.self ? entry.message.to : entry.message.from,
          ...(visible ? { subject: entry.message.subject, preview: entry.message.text.slice(0, 240), at: entry.message.createdAt,
            ...(entry.message.workRef ? { workRef: entry.message.workRef } : {}),
            ...(labeled ? { recipientLabel: labeled.recipientLabel, labeledSession: labeled.to, labelSource: 'sender-supplied' } : {})
          } : { code: 'CONTACT_NOT_APPROVED' }), state: entry.state, latestMessage: entry.message.id };
      });
      if (input.peer || input.workRef) {
        const start = input.cursor ? exchanges.findIndex(e => e.exchange === input.cursor) + 1 : 0;
        if (input.cursor && !start) throw new Error('CONTEXT_LOST');
        const items = exchanges.slice(start, start + 30);
        return { items, nextCursor: start + items.length < exchanges.length ? items.at(-1)!.exchange : null };
      }
      return { waiting: this.waiting.length, paused: this.paused, recentExchanges: exchanges.slice(0, 8),
        uncertainOutgoing: records.filter(e => e.message.from === this.self && e.state === 'unknown').slice(-8).map(e => ({ message: e.message.id, to: e.message.to, code: e.code ?? 'OUTCOME_UNKNOWN' })),
        uncertainAdmission: [...this.uncertainAdmission].slice(-8), ...(this.recoveryIssue ? { recoveryHold: this.recoveryIssue } : {}) };
    }
    const selected = 'queue' in input ? this.waiting.map(id => this.records.get(id)!) : 'outbox' in input ? records.filter(e => e.message.from === this.self) : records.filter(e => e.message.exchange === input.exchange);
    if ('exchange' in input && !selected.length) throw new Error('CONTEXT_LOST');
    const page = this.page(selected, input.cursor, audience);
    return input.exchange ? { ...page, handovers: this.handoversFrom(input.exchange) } : page;
  }
}
export const MAX_PAGE_BYTES = 900_000;
