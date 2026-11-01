import type { Entry, Runtime } from './runtime.ts';

export type WaitFor = 'first-reply' | 'reported-outcome';
export type AskOutcome = 'replied' | 'reported-complete' | 'needs-input' | 'blocked' |
  'timeout' | 'interrupted' | 'paused' | 'revoked' | 'disconnected' |
  'context-lost' | 'not-sent' | 'rejected' | 'unknown';
export type AskItem = { request?: string; peer?: string; subject?: string; workRef?: string; outcome?: AskOutcome; code?: string; reply?: string };
type Wait = { item: AskItem; mode: WaitFor; finish: (outcome: AskOutcome, reply?: string) => void; start: () => void; suspend: () => void };

// Only wait/claim state lives here. Payloads, reports, links and evidence stay in Runtime.
export class Asks {
  private waits = new Map<string, Wait>();
  private calls = new Map<string, { items: AskItem[]; mode: WaitFor; ended?: AskOutcome; presented: boolean }>();
  private claims = new Map<string, string>();
  private dialog = false;
  constructor(private runtime: Runtime) {}
  open(call: string, items: AskItem[], mode: WaitFor = 'first-reply') { this.calls.set(call, { items, mode, presented: false }); }
  ended(call: string) { return this.calls.get(call)?.ended; }
  register(call: string, item: AskItem, entry: Entry, seconds: number, mode: WaitFor = 'first-reply') {
    if (this.waits.has(entry.message.id)) throw new Error('INVALID_INPUT: this request already has an active wait.');
    item.request = entry.message.id; item.peer = entry.message.to; item.subject = entry.message.subject; item.workRef = entry.message.workRef;
    let timer: NodeJS.Timeout | undefined;
    let remaining = seconds * 1000, startedAt = 0;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const finish = (outcome: AskOutcome, reply?: string) => {
      if (!this.waits.delete(entry.message.id)) return;
      clearTimeout(timer); item.outcome = outcome; item.reply = reply;
      if (reply) this.claims.set(reply, call);
      resolve();
    };
    this.waits.set(entry.message.id, { item, mode, finish, start: () => {
      if (this.waits.has(entry.message.id) && !timer && !this.dialog) {
        startedAt = performance.now(); timer = setTimeout(() => finish('timeout'), remaining);
      }
    }, suspend: () => {
      if (timer) { remaining = Math.max(0, remaining - (performance.now() - startedAt)); clearTimeout(timer); timer = undefined; }
    } });
    const ended = this.ended(call);
    if (ended) finish(ended);
    return promise;
  }
  // Observe an already-sent request. This performs no send, replay or new approval.
  watch(call: string, item: AskItem, entry: Entry, seconds: number) {
    const waiting = this.register(call, item, entry, seconds, 'reported-outcome');
    this.waits.get(entry.message.id)?.start();
    this.admit(); // A previously arrived but still unadmitted report may already be waiting.
    return waiting;
  }
  approvalDialog(open: boolean) {
    this.dialog = open;
    for (const wait of this.waits.values()) {
      if (open) wait.suspend();
      else if (wait.mode === 'reported-outcome' || this.runtime.entry(wait.item.request!)?.state === 'accepted') wait.start();
    }
  }
  sent(id: string, state: Entry['state'], code?: string) {
    const wait = this.waits.get(id);
    if (!wait) return;
    if (state === 'accepted') wait.start();
    else { wait.item.code = code; wait.finish(state); }
  }
  // A plain reply anywhere down the original reply chain must be surfaced to the
  // caller. Without a report it cannot be treated as completion or held forever.
  private belongsTo(request: string, entry: Entry) {
    const original = this.runtime.entry(request)?.message;
    if (!original || original.exchange !== entry.message.exchange) return false;
    const seen = new Set<string>();
    let parent = entry.message.replyTo;
    while (parent && !seen.has(parent)) {
      if (parent === request) return true;
      seen.add(parent);
      const prior = this.runtime.entry(parent)?.message;
      if (!prior || prior.exchange !== original.exchange) return false;
      parent = prior.replyTo;
    }
    return false;
  }
  admit() {
    for (const id of this.runtime.eligible()) {
      if (this.claims.has(id)) continue;
      const entry = this.runtime.entry(id)!;
      const direct = entry.message.replyTo && this.waits.get(entry.message.replyTo);
      if (direct?.mode === 'first-reply' && direct.item.peer === entry.message.from) {
        direct.finish('replied', id); continue;
      }
      const report = entry.message.report;
      if (report) {
        const wait = this.waits.get(report.request);
        const original = this.runtime.entry(report.request)?.message;
        if (wait?.mode === 'reported-outcome' && wait.item.peer === entry.message.from &&
            !entry.reportLinkage && original?.exchange === entry.message.exchange) {
          const outcome = report.state === 'complete' ? 'reported-complete' :
            report.state === 'needs-input' ? 'needs-input' :
            report.state === 'blocked' ? 'blocked' : undefined;
          if (outcome) wait.finish(outcome, id);
        }
        // Progress updates and reports on other requests remain normal intake;
        // neither can silently settle a different wait.
        continue;
      }
      for (const [request, wait] of this.waits) {
        if (wait.mode === 'reported-outcome' && wait.item.peer === entry.message.from &&
            this.belongsTo(request, entry)) {
          wait.finish('replied', id); // Explicitly unclassified reply; not work completion.
          break;
        }
      }
    }
  }
  claimed(id: string) { return this.claims.has(id); }
  end(reason: AskOutcome, call?: string, peer?: string) {
    for (const [id, operation] of this.calls) {
      if (call && id !== call || operation.presented) continue;
      if (!peer) operation.ended = reason;
      for (const item of operation.items) {
        if (peer && item.peer !== peer) continue;
        if (item.request) this.waits.get(item.request)?.finish(reason);
        if (item.reply) {
          this.claims.delete(item.reply); item.reply = undefined; item.outcome = reason;
        }
      }
    }
  }
  project(call: string, seconds: number) {
    const operation = this.calls.get(call)!;
    return { timeoutSeconds: seconds, ...(operation.mode === 'reported-outcome' ? { waitFor: 'reported-outcome' as const } : {}),
      items: operation.items.map(item => ({ ...item,
        outcome: item.outcome ?? operation.ended ?? 'not-sent',
        ...(item.reply ? { response: this.runtime.inspect({ message: item.reply }) } : {}),
      })) };
  }
  present(call: string, source = 'native ask result context admission') {
    const operation = this.calls.get(call);
    if (!operation || operation.presented) return;
    operation.presented = true;
    const ids = operation.items.flatMap(item => item.reply ? [item.reply] : []);
    this.runtime.posted(ids, source);
    ids.forEach(id => this.claims.delete(id));
  }
  has(call: string) { return this.calls.has(call); }
}
