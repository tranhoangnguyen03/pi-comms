import type { Entry, Runtime } from './runtime.ts';

export type AskOutcome = 'replied' | 'timeout' | 'interrupted' | 'paused' | 'revoked' | 'disconnected' | 'context-lost' | 'not-sent' | 'rejected' | 'unknown';
export type AskItem = { request?: string; peer?: string; subject?: string; workRef?: string; outcome?: AskOutcome; code?: string; reply?: string };
type Wait = { item: AskItem; finish: (outcome: AskOutcome, reply?: string) => void; start: () => void; suspend: () => void };

// Only wait/claim state lives here. Payloads, links and evidence stay in Runtime.
export class Asks {
  private waits = new Map<string, Wait>();
  private calls = new Map<string, { items: AskItem[]; ended?: AskOutcome; presented: boolean }>();
  private claims = new Map<string, string>();
  private dialog = false;
  constructor(private runtime: Runtime) {}
  open(call: string, items: AskItem[]) { this.calls.set(call, { items, presented: false }); }
  ended(call: string) { return this.calls.get(call)?.ended; }
  register(call: string, item: AskItem, entry: Entry, seconds: number) {
    item.request = entry.message.id; item.peer = entry.message.to; item.subject = entry.message.subject;
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
    this.waits.set(entry.message.id, { item, finish, start: () => {
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
  approvalDialog(open: boolean) {
    this.dialog = open;
    for (const wait of this.waits.values()) {
      if (open) wait.suspend();
      else if (this.runtime.entry(wait.item.request!)?.state === 'accepted') wait.start();
    }
  }
  sent(id: string, state: Entry['state'], code?: string) {
    const wait = this.waits.get(id);
    if (!wait) return;
    if (state === 'accepted') wait.start();
    else { wait.item.code = code; wait.finish(state); }
  }
  admit() {
    for (const id of this.runtime.eligible()) {
      if (this.claims.has(id)) continue;
      const entry = this.runtime.entry(id)!;
      const wait = entry.message.replyTo && this.waits.get(entry.message.replyTo);
      if (wait && wait.item.peer === entry.message.from) wait.finish('replied', id);
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
    return { timeoutSeconds: seconds, items: operation.items.map(item => ({ ...item,
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
