import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Id, MessageInput, EnvelopeSchema, checkSize, validate, type Envelope, InspectInput } from './schema.ts';
import type { Attempt } from './session-send.ts';

export type Fact = { kind: 'accepted' | 'queued' | 'posted' | 'saved' | 'summarized' | 'rejected'; at: string; source: string; evidenceRef?: string };
export type Message = Envelope & { from: string; to: string };
export type Entry = { message: Message; facts: Fact[]; state: Attempt['outcome']; code?: string; returnHandle?: string; linkage?: 'context-lost'; reportLinkage?: 'context-lost' };
export type Approval = { id: string; name: string; context: string };
export class Runtime {
  private approvals = new Map<string, Approval>();
  private revoked = new Set<string>();
  private records = new Map<string, Entry>();
  private returns = new Map<string, Message>();
  waiting: string[] = [];
  paused = false;
  constructor(readonly self: string, private transport: (id: string, envelope: Envelope) => Promise<Attempt>) {}
  // Passed only to the human command handler, never registered as an agent tool.
  approveFromOwner(peer: Approval) { this.revoked.delete(peer.id); this.approvals.set(peer.id, { ...peer }); }
  // Only transport metadata emitted by the human-approved runtime can reach this path.
  approveFromTransport(peer: Approval) { if (!this.revoked.has(peer.id) && !this.isApproved(peer.id)) this.approvals.set(peer.id, { ...peer }); }
  revokeFromOwner(id: string) { this.revoked.add(id); this.approvals.delete(id); }
  approval(id: string) { const peer = this.approvals.get(id); return peer ? { ...peer } : undefined; }
  isApproved = (id: string) => this.approvals.has(id);
  known() { return [...this.approvals.values()].map(p => ({ ...p })); }
  // Only describe labels this session supplied for exact recipients of accepted requests.
  // A label belongs to an exchange, not the recipient's global identity or permissions.
  peerLabels(id: string) {
    return [...this.records.values()].reverse()
      .filter(entry => entry.message.from === this.self && entry.message.to === id &&
        entry.message.recipientLabel !== undefined && entry.state === 'accepted')
      .slice(0, 8)
      .map(entry => ({ exchange: entry.message.exchange, workRef: entry.message.workRef ?? null,
        label: entry.message.recipientLabel!, source: 'sender-supplied' as const }));
  }
  entry(id: string) { return this.records.get(id); }
  fact(id: string, kind: Fact['kind'], source: string, evidenceRef?: string) {
    const entry = this.records.get(id);
    if (entry && !entry.facts.some(f => f.kind === kind && f.evidenceRef === evidenceRef)) entry.facts.push({ kind, at: new Date().toISOString(), source, ...(evidenceRef ? { evidenceRef } : {}) });
  }
  contactFor(input: MessageInput) {
    validate(MessageInput, input);
    checkSize(input);
    const source = 'respondTo' in input ? this.returns.get(input.respondTo) : undefined;
    if ('respondTo' in input && !source) throw new Error('CONTEXT_LOST');
    const to = source?.from ?? input.to;
    validate(Id, to);
    const correction = input.corrects ? this.records.get(input.corrects)?.message : undefined;
    if (input.corrects && (!correction || correction.from !== this.self || correction.to !== to)) throw new Error('INVALID_INPUT: correction must reference your message to this exact peer');
    return { to, source };
  }
  async send(input: MessageInput, registered?: (entry: Entry) => void) {
    const { to, source } = this.contactFor(input);
    if (!this.isApproved(to)) throw new Error('CONTACT_NOT_APPROVED');
    if (input.report) {
      const request = this.records.get(input.report.request)?.message;
      if (!source || !request || request.from !== to || request.to !== this.self || request.exchange !== source.exchange) {
        throw new Error('INVALID_INPUT: work report must reference a received request from this exact colleague in the same exchange; no message was sent');
      }
    }
    const workRef = source?.workRef ?? input.workRef;
    const envelope: Envelope = {
      id: randomUUID(), exchange: source?.exchange ?? randomUUID(),
      subject: source?.subject ?? ('subject' in input ? input.subject : ''),
      text: input.text, refs: input.refs ?? [],
      ...(workRef ? { workRef } : {}),
      ...(!source && input.recipientLabel ? { recipientLabel: input.recipientLabel } : {}),
      ...(input.structured ? { structured: input.structured } : {}),
      ...(input.report ? { report: input.report } : {}),
      replyTo: source?.id ?? null, corrects: input.corrects ?? null,
      createdAt: new Date().toISOString(),
    };
    checkSize(envelope, this.approval(to)?.context);
    const entry: Entry = { message: { ...envelope, from: this.self, to }, facts: [], state: 'unknown' };
    this.records.set(envelope.id, entry);
    registered?.(entry);
    let outcome: Attempt;
    try { outcome = await this.transport(to, envelope); } catch { outcome = { outcome: 'unknown', code: 'OUTCOME_UNKNOWN' }; }
    entry.state = outcome.outcome; entry.code = outcome.code;
    if (outcome.outcome !== 'unknown') this.fact(envelope.id, outcome.outcome === 'accepted' ? 'accepted' : 'rejected', 'broker');
    return this.view(entry);
  }
  receive(from: string, envelope: Envelope) {
    validate(EnvelopeSchema, envelope); checkSize(envelope);
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
      else if (request.from !== this.self || request.to !== from || request.exchange !== envelope.exchange) {
        throw new Error('INVALID_INPUT: work report references a different request, colleague or exchange');
      }
    }
    if (envelope.corrects) {
      const source = this.records.get(envelope.corrects)?.message;
      if (!source || source.from !== from || source.to !== this.self) throw new Error('INVALID_INPUT: invalid correction linkage');
    }
    const handle = randomUUID();
    this.returns.set(handle, message);
    this.records.set(envelope.id, { message, facts: [], state: 'accepted', returnHandle: handle, ...(contextLost ? { linkage: 'context-lost' } : {}), ...(reportLinkage ? { reportLinkage } : {}) });
    this.fact(envelope.id, 'queued', 'receiver runtime');
    // Unapproved messages are visible to the human, but cannot wake or enter model context.
    this.waiting.push(envelope.id);
    return true;
  }
  eligible() { return this.waiting.filter(id => this.isApproved(this.records.get(id)!.message.from)); }
  posted(ids: string[], source = 'native Pi sendMessage') {
    const posted = new Set(ids);
    this.waiting = this.waiting.filter(id => !posted.has(id));
    ids.forEach(id => this.fact(id, 'posted', source));
  }
  // An incoming progress report remains in the authoritative record and
  // inspection, but need not create a separate model turn. This is not "posted".
  summarized(ids: string[]) {
    const done = new Set(ids);
    this.waiting = this.waiting.filter(id => !done.has(id));
    ids.forEach(id => this.fact(id, 'summarized', 'request-aware intake'));
  }
  private reportsFor(requestId: string, audience: 'agent' | 'human' = 'agent') {
    const request = this.records.get(requestId)?.message;
    if (!request || request.from !== this.self) return [];
    return [...this.records.values()].filter(entry => entry.message.report?.request === requestId &&
      entry.message.from === request.to && entry.message.exchange === request.exchange &&
      !entry.reportLinkage && this.visible(entry, audience));
  }
  // Project from existing records, never a second work-status store. An
  // actionable report remains current even if a late progress update arrives.
  reportState(requestId: string, audience: 'agent' | 'human' = 'agent') {
    const reports = this.reportsFor(requestId, audience);
    const lastActionable = [...reports].reverse().find(e => e.message.report?.state !== 'progress');
    const current = lastActionable ?? reports.at(-1);
    const laterProgressCount = lastActionable
      ? reports.slice(reports.indexOf(lastActionable) + 1).filter(e => e.message.report?.state === 'progress').length : 0;
    return { reports, current, laterProgressCount };
  }
  reportNote(entry: Entry) {
    const report = entry.message.report;
    if (!report || entry.reportLinkage) return '';
    const { reports, current } = this.reportState(report.request);
    const earlier = reports.slice(0, reports.findIndex(e => e.message.id === entry.message.id));
    const progress = earlier.filter(e => e.message.report?.state === 'progress').length;
    const previousActions = earlier.filter(e => e.message.report?.state !== 'progress');
    const parts = [];
    if (progress) parts.push(`${progress} earlier progress report(s) retained in inspection`);
    if (previousActions.length) parts.push(`earlier peer state: ${previousActions.at(-1)!.message.report!.state}`);
    if (current && current.message.id !== entry.message.id) parts.push(`a later actionable state (${current.message.report!.state}) is on record`);
    return parts.length ? `Report history for request ${report.request}: ${parts.join('; ')}.\n` : '';
  }
  // One intake route: deliver all useful messages and every actionable peer
  // report. Fold only progress reports into inspection so an old progress update
  // cannot wake the lead after a later completion or correction.
  planIntake(ids: string[]) {
    const deliver: Entry[] = [], summarized: string[] = [];
    for (const id of ids) {
      const entry = this.records.get(id);
      if (!entry || !this.waiting.includes(id) || !this.isApproved(entry.message.from)) continue;
      if (entry.message.report?.state === 'progress' && !entry.reportLinkage) summarized.push(id);
      else deliver.push(entry);
    }
    return { deliver, summarized };
  }
  private visible(entry: Entry, audience: 'agent' | 'human') { return audience === 'human' || entry.message.from === this.self || this.isApproved(entry.message.from); }
  private project(entry: Entry, audience: 'agent' | 'human') {
    if (!this.visible(entry, audience)) {
      const { id, exchange, from, to } = entry.message;
      return { message: { id, exchange, from, to }, evidence: 'withheld', code: 'CONTACT_NOT_APPROVED' };
    }
    return this.view(entry);
  }
  view(entry: Entry) {
    return structuredClone({ ...entry, responses: [...this.records.values()].filter(r => r.message.replyTo === entry.message.id).map(r => r.message.id), evidence: 'available' });
  }
  page(entries: Entry[], cursor?: string, audience: 'agent' | 'human' = 'agent') {
    const start = cursor ? entries.findIndex(e => e.message.id === cursor) + 1 : 0;
    if (cursor && start === 0) throw new Error('CONTEXT_LOST: cursor no longer available');
    const items: ReturnType<Runtime['project']>[] = [];
    let bytes = 0;
    for (const entry of entries.slice(start)) {
      const view = this.project(entry, audience); const size = Buffer.byteLength(JSON.stringify(view));
      if (items.length && bytes + size > MAX_PAGE_BYTES) break;
      items.push(view); bytes += size;
      if (items.length === 30) break;
    }
    return { items, nextCursor: start + items.length < entries.length ? items.at(-1)!.message.id : null };
  }
  inspect(input: InspectInput, audience: 'agent' | 'human' = 'agent') {
    validate(InspectInput, input);
    if (input.message) {
      const entry = this.records.get(input.message);
      if (!entry) throw new Error('CONTEXT_LOST');
      return this.project(entry, audience);
    }
    const records = [...this.records.values()];
    if (input.requests) return { responses: input.requests.map(id => {
      const request = this.records.get(id);
      if (!request || request.message.from !== this.self) return { request: id, outcome: 'context-lost' };
      const replies = records.filter(entry => entry.message.replyTo === id && entry.message.from === request.message.to);
      // The final report may reply to a later clarification in the same exchange.
      // Its explicit original-request link is separate from direct replyTo tracking.
      const { reports, current, laterProgressCount } = this.reportState(id, audience);
      return { request: id, peer: request.message.to, subject: request.message.subject, workRef: request.message.workRef ?? null, state: request.state,
        code: request.code, outcome: replies.length ? 'reply-received' : request.state === 'accepted' ? 'no-reply-yet' : request.state,
        responseCount: replies.length, replies: replies.slice(-1).map(entry => this.project(entry, audience)),
        reportCount: reports.length, ...(reports.length ? { latestReport: this.project(reports.at(-1)!, audience) } : {}),
        ...(current ? { currentReport: this.project(current, audience) } : {}),
        ...(laterProgressCount ? { laterProgressCount } : {}) };
    }) };
    if (input.peer || input.workRef || !input.exchange && !input.queue && !input.outbox) {
      const latest = new Map<string, Entry>();
      for (const entry of records) {
        if (input.peer && entry.message.from !== input.peer && entry.message.to !== input.peer) continue;
        if (input.workRef && (entry.message.workRef !== input.workRef || !this.visible(entry, audience))) continue;
        // A late progress report does not replace a more useful final/corrective
        // report as the exchange preview. Its full record stays inspectable.
        if (entry.message.report?.state === 'progress' && this.reportState(entry.message.report.request, audience)
          .current?.message.report?.state !== 'progress') continue;
        latest.delete(entry.message.exchange); latest.set(entry.message.exchange, entry);
      }
      const exchanges = [...latest.values()].reverse().map(entry => {
        const visible = this.visible(entry, audience);
        const labeled = visible ? records.find(record => record.message.exchange === entry.message.exchange &&
          record.message.recipientLabel !== undefined && this.visible(record, audience))?.message : undefined;
        return { exchange: entry.message.exchange, peer: entry.message.from === this.self ? entry.message.to : entry.message.from,
          ...(visible ? {
            subject: entry.message.subject, preview: entry.message.text.slice(0, 240), at: entry.message.createdAt,
            ...(entry.message.workRef ? { workRef: entry.message.workRef } : {}),
            ...(labeled ? { recipientLabel: labeled.recipientLabel, labeledSession: labeled.to, labelSource: 'sender-supplied' } : {}),
          } : { code: 'CONTACT_NOT_APPROVED' }),
          state: entry.state, latestMessage: entry.message.id };
      });
      if (input.peer || input.workRef) {
        const start = input.cursor ? exchanges.findIndex(e => e.exchange === input.cursor) + 1 : 0;
        if (input.cursor && !start) throw new Error('CONTEXT_LOST');
        const items = exchanges.slice(start, start + 30);
        return { items, nextCursor: start + items.length < exchanges.length ? items.at(-1)!.exchange : null };
      }
      return { waiting: this.waiting.length, paused: this.paused, recentExchanges: exchanges.slice(0, 8),
        uncertainOutgoing: records.filter(e => e.message.from === this.self && e.state === 'unknown').slice(-8).map(e => ({ message: e.message.id, to: e.message.to, code: e.code ?? 'OUTCOME_UNKNOWN' })) };
    }
    const selected = 'queue' in input ? this.waiting.map(id => this.records.get(id)!) : 'outbox' in input ? records.filter(e => e.message.from === this.self) : records.filter(e => e.message.exchange === input.exchange);
    if ('exchange' in input && !selected.length) throw new Error('CONTEXT_LOST');
    return this.page(selected, input.cursor, audience);
  }
}
export const MAX_PAGE_BYTES = 900_000;
