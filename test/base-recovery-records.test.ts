import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Runtime, NESTED_HANDOFF } from '../src/runtime.ts';
import { Asks, type AskItem } from '../src/ask.ts';
import { NativeSessionRecords, RECORD_TYPE, type NativeEntry, type RecoveryEvent } from '../src/session-records.ts';
import type { Envelope } from '../src/schema.ts';

const peer = () => ({ id: randomUUID(), name: 'Reviewer', context: 'Review the change' });
const envelope = (overrides: Partial<Envelope> = {}): Envelope => ({ id: randomUUID(), exchange: randomUUID(), subject: 'Review', text: 'original finding', refs: [], replyTo: null, corrects: null, createdAt: new Date().toISOString(), ...overrides });
function attach(manager: SessionManager, scope: string, append = (type: string, data: unknown) => { manager.appendCustomEntry(type, data); }) {
  const log = new NativeSessionRecords(manager.getSessionId(), scope, {
    getSessionId: () => manager.getSessionId(), getSessionFile: () => manager.getSessionFile(),
    getEntries: () => manager.getEntries() as unknown as NativeEntry[], append,
  });
  const loaded = log.load();
  let sends = 0;
  const runtime = new Runtime(manager.getSessionId(), async () => { sends++; return { outcome: 'accepted' }; }, log.append);
  runtime.restore(loaded.events, log.info().state === 'saved' ? 'saved' : 'volatile');
  if (log.info().state === 'blocked') runtime.holdRecovery(log.info().reason!);
  return { log, runtime, loaded, sends: () => sends };
}
function fixture(t: TestContext, saved = true) {
  const root = mkdtempSync(join(tmpdir(), 'comms-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, 'sessions'));
  if (saved) manager.appendMessage({ role: 'user', content: 'A real review request', timestamp: Date.now() });
  return { root, manager, ...attach(manager, root) };
}

test('F10: authorized history and handles survive without restoring positive consent', async t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  const incoming = envelope({ workRef: 'R-10' });
  f.runtime.receive(b.id, incoming);
  const old = f.runtime.inspect({ message: incoming.id }) as any;
  f.runtime.paused = true;
  f.runtime.revokeFromOwner(b.id);
  assert.equal((f.runtime.inspect({ message: incoming.id }) as any).message.text, incoming.text);
  const held = envelope({ text: 'never authorized', workRef: 'R-10' });
  f.runtime.receive(b.id, held);
  f.log.close();
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(resumed.runtime.paused, true);
  assert.equal(resumed.runtime.isRevoked(b.id), true);
  assert.equal(resumed.runtime.isApproved(b.id), false);
  const restored = resumed.runtime.inspect({ message: incoming.id }) as any;
  assert.equal(restored.message.text, incoming.text);
  assert.equal(restored.returnHandle, old.returnHandle);
  assert.equal(restored.record.state, 'saved');
  assert.equal((resumed.runtime.inspect({ message: held.id }) as any).evidence, 'withheld');
  assert.doesNotMatch(JSON.stringify(resumed.runtime.inspect({ workRef: 'R-10' })), /never authorized/);
  assert.match(JSON.stringify(resumed.runtime.inspect({ message: held.id }, 'human')), /never authorized/);
  resumed.runtime.approveFromTransport(b);
  assert.equal(resumed.runtime.isApproved(b.id), false, 'a fresh assertion cannot undo a saved local revoke');
  await assert.rejects(resumed.runtime.send({ respondTo: old.returnHandle, text: 'answer' }), /CONTACT_NOT_APPROVED/);
  assert.equal(resumed.sends(), 0);
  resumed.runtime.approveFromOwner(b);
  const reply = await resumed.runtime.send({ respondTo: old.returnHandle, text: 'answer', report: { request: incoming.id, state: 'complete' } });
  assert.equal(reply.message.replyTo, incoming.id);
  assert.equal(reply.message.exchange, incoming.exchange);
  assert.equal(reply.message.workRef, 'R-10');
  assert.equal(resumed.sends(), 1);
});

test('F10: expired positive consent does not hide old findings, but new intake remains gated', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromTransport(b);
  const prior = envelope(); f.runtime.receive(b.id, prior);
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(resumed.runtime.isApproved(b.id), false);
  assert.equal((resumed.runtime.inspect({ message: prior.id }) as any).evidence, 'available');
  const fresh = envelope({ text: 'fresh after restart' }); resumed.runtime.receive(b.id, fresh);
  assert.equal((resumed.runtime.inspect({ message: fresh.id }) as any).evidence, 'withheld');
  assert.deepEqual(resumed.runtime.eligible(), []);
  resumed.runtime.approveFromTransport(b);
  assert.equal(resumed.runtime.isApproved(b.id), true, 'normal current-runtime transport consent is still supported');
  assert.equal((resumed.runtime.inspect({ message: fresh.id }) as any).evidence, 'available');
  const next = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(next.runtime.isApproved(b.id), false, 'transport assertions never become remembered positive grants');
});

test('F10: saved outgoing intent remains unknown after interruption; no automatic network replay', async t => {
  const f = fixture(t), b = peer();
  let finish!: (value: { outcome: 'accepted' }) => void;
  let networkCalls = 0;
  const original = new Runtime(f.manager.getSessionId(), () => { networkCalls++; return new Promise(resolve => { finish = resolve; }); }, f.log.append);
  original.approveFromOwner(b);
  const pending = original.send({ to: b.id, subject: 'Review', text: 'do this once' });
  const id = (original.inspect({ outbox: 'self' }) as any).items[0].message.id;
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal((resumed.runtime.inspect({ message: id }) as any).state, 'unknown');
  assert.equal(resumed.sends(), 0);
  assert.equal(networkCalls, 1);
  f.log.close(); finish({ outcome: 'accepted' });
  const result = await pending;
  assert.equal(result.state, 'accepted', 'a late observed success must not become "nothing sent"');
  assert.equal(result.record.state, 'partial', 'closed writer cannot append a result to the replacement session');
  assert.equal((resumed.runtime.inspect({ message: id }) as any).state, 'unknown');
});

test('F10: never-offered, uncertain admission and actual native posting stay distinct', t => {
  const f = fixture(t), b = peer(); f.runtime.approveFromOwner(b);
  const waiting = envelope({ text: 'not offered' }), uncertain = envelope({ text: 'possibly offered' }), posted = envelope({ text: 'posted' });
  for (const message of [waiting, uncertain, posted]) f.runtime.receive(b.id, message);
  f.runtime.offered([uncertain.id, posted.id]);
  const proof = f.manager.appendCustomMessageEntry('comms_batch', 'posted', true, { owner: f.manager.getSessionId(), ids: [posted.id] });
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  resumed.runtime.observedNative([posted.id], proof);
  resumed.runtime.approveFromOwner(b);
  assert.deepEqual(resumed.runtime.eligible(), [waiting.id]);
  assert.equal((resumed.runtime.inspect({ message: uncertain.id }) as any).admission, 'uncertain');
  assert.ok(!resumed.runtime.waiting.includes(posted.id));
  assert.equal(resumed.runtime.receive(b.id, posted), false, 'same-ID redelivery does not recreate intake');
  assert.throws(() => resumed.runtime.receive(b.id, { ...posted, text: 'different payload' }), /conflicting message ID/);
});

test('F10: reports, corrections and handover links reduce from original records after restart', async t => {
  const f = fixture(t), b = peer(), c = peer(); f.runtime.approveFromOwner(b); f.runtime.approveFromOwner(c);
  const request = await f.runtime.send({ to: b.id, subject: 'Review', text: 'check retry', workRef: 'R-11' });
  const report = envelope({ exchange: request.message.exchange, replyTo: request.message.id, workRef: 'R-11', report: { request: request.message.id, state: 'complete' }, text: 'initial completion' });
  f.runtime.receive(b.id, report);
  const correction = envelope({ exchange: request.message.exchange, replyTo: request.message.id, workRef: 'R-11', report: { request: request.message.id, state: 'blocked' }, corrects: report.id, text: 'correction: unsafe retry' });
  f.runtime.receive(b.id, correction);
  const handover = await f.runtime.send({ to: c.id, subject: 'Continue review', text: 'authored brief', handoverFrom: request.message.exchange });
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  const view = resumed.runtime.inspect({ requests: [request.message.id] }) as any;
  assert.equal(view.responses[0].currentReport.message.id, correction.id);
  assert.equal(view.responses[0].currentReport.message.corrects, report.id);
  const old = resumed.runtime.inspect({ exchange: request.message.exchange }) as any;
  assert.equal(old.handovers[0].message, handover.message.id);
  assert.equal(resumed.runtime.isApproved(c.id), false);
  assert.equal(resumed.runtime.isApproved(b.id), false);
});

test('F10: tree navigation does not undo revocation; native forks do not inherit operational state', t => {
  const f = fixture(t), b = peer();
  const rootLeaf = f.manager.getLeafId()!;
  f.runtime.approveFromOwner(b); const message = envelope(); f.runtime.receive(b.id, message);
  f.runtime.revokeFromOwner(b.id); f.runtime.paused = true;
  f.manager.branch(rootLeaf);
  f.manager.appendMessage({ role: 'user', content: 'new branch', timestamp: Date.now() });
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(resumed.runtime.isRevoked(b.id), true);
  assert.equal(resumed.runtime.paused, true);
  assert.equal((resumed.runtime.inspect({ message: message.id }) as any).message.text, message.text);
  const fork = SessionManager.forkFrom(f.manager.getSessionFile()!, join(f.root, 'fork'), join(f.root, 'fork-sessions'));
  assert.notEqual(fork.getSessionId(), f.manager.getSessionId());
  const child = attach(fork, f.root);
  assert.equal(child.runtime.paused, false);
  assert.equal(child.runtime.isRevoked(b.id), false);
  assert.equal(child.runtime.isApproved(b.id), false);
  assert.throws(() => child.runtime.inspect({ message: message.id }), /CONTEXT_LOST/);
});

test('F10: fresh and ephemeral sessions keep live use without a dummy prompt or sidecar', async t => {
  const f = fixture(t, false), b = peer(); f.runtime.approveFromOwner(b);
  const sent = await f.runtime.send({ to: b.id, subject: 'live', text: 'first communication' });
  assert.equal(sent.state, 'accepted'); assert.equal(sent.record.state, 'volatile');
  assert.equal(existsSync(f.manager.getSessionFile()!), false);
  const memory = SessionManager.inMemory(f.root), ephemeral = attach(memory, f.root);
  ephemeral.runtime.approveFromOwner(b);
  assert.equal((await ephemeral.runtime.send({ to: b.id, subject: 'live', text: 'ephemeral' })).record.state, 'volatile');
  assert.equal(memory.getSessionFile(), undefined);
  assert.doesNotMatch(JSON.stringify(memory.buildSessionContext().messages), /ephemeral/);
  f.manager.appendMessage({ role: 'user', content: 'first actual user turn', timestamp: Date.now() });
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal((resumed.runtime.inspect({ message: sent.message.id }) as any).record.state, 'saved');
});

test('F10: failed save never dispatches or claims a control survived; memory is not commit evidence', async t => {
  const f = fixture(t), b = peer(); f.runtime.approveFromOwner(b);
  const path = f.manager.getSessionFile()!;
  rmSync(path); mkdirSync(path);
  await assert.rejects(f.runtime.send({ to: b.id, subject: 'unsent', text: 'must not dispatch' }), /PERSISTENCE_FAILED/);
  assert.equal(f.sends(), 0);
  assert.equal(f.log.info().state, 'blocked');
  assert.throws(() => { f.runtime.paused = true; }, /RECOVERY_BLOCKED/);
  assert.equal(f.runtime.paused, true, 'live human stop applies even if its save cannot be confirmed');
  assert.throws(() => f.runtime.revokeFromOwner(b.id), /RECOVERY_BLOCKED/);
  assert.equal(f.runtime.isRevoked(b.id), true);
  assert.equal(f.runtime.isApproved(b.id), false);
});

test('F10: failed history visibility write cannot clear an earlier saved revocation', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  f.runtime.revokeFromOwner(b.id);
  const held = envelope({ text: 'WITHHELD_UNTIL_EXPLICIT_REAPPROVAL' });
  f.runtime.receive(b.id, held);
  const file = f.manager.getSessionFile()!;
  f.log.close();

  const manager = SessionManager.open(file);
  const restored = attach(manager, f.root, (type, data) => {
    const event = (data as { event?: { kind?: string; revoked?: boolean; readableIds?: string[] } })?.event;
    if (event?.kind === 'contact' && event.revoked === false && event.readableIds?.length) {
      throw new Error('simulated partial reapproval save failure');
    }
    manager.appendCustomEntry(type, data);
  });
  assert.equal(restored.runtime.isRevoked(b.id), true);
  assert.throws(() => restored.runtime.approveFromOwner(b), /PERSISTENCE_FAILED/);
  assert.equal(restored.runtime.isApproved(b.id), false);
  assert.equal(restored.log.info().state, 'blocked');

  const again = attach(SessionManager.open(file), f.root);
  assert.equal(again.runtime.isRevoked(b.id), true, 'failed approval does not durably undo the deny');
  assert.equal(again.runtime.isApproved(b.id), false);
  assert.equal((again.runtime.inspect({ message: held.id }) as any).evidence, 'withheld');
  again.runtime.approveFromOwner(b);
  const approved = attach(SessionManager.open(file), f.root);
  assert.equal(approved.runtime.isRevoked(b.id), false);
  assert.equal(approved.runtime.isApproved(b.id), false, 'positive consent remains runtime-only in F10');
  assert.equal((approved.runtime.inspect({ message: held.id }) as any).message.text, held.text,
    'the completed reapproval commits historical readability with the cleared deny');
});

test('F10: failure after host commit is distinguished from an unsaved in-memory entry', t => {
  const f = fixture(t);
  const wrapped = attach(f.manager, f.root, (type, data) => { f.manager.appendCustomEntry(type, data); throw new Error('listener failed after append'); });
  assert.equal(wrapped.log.append({ kind: 'pause', value: true }), 'saved');
  const reopened = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(reopened.runtime.paused, true);
});

test('F10: malformed tails and unknown versions hold communication without erasing readable history', t => {
  const f = fixture(t), b = peer(); f.runtime.approveFromOwner(b);
  const message = envelope(); f.runtime.receive(b.id, message);
  const file = f.manager.getSessionFile()!;
  appendFileSync(file, '{"type":"custom","data":');
  const manager = SessionManager.open(file);
  // Pi may terminate the malformed tail with a newline while opening. Compare
  // the adapter against the host-opened bytes, not an unsupported host promise.
  const beforeInspection = readFileSync(file, 'utf8');
  const resumed = attach(manager, f.root);
  assert.equal(resumed.log.info().state, 'blocked');
  assert.match(resumed.runtime.holdReason()!, /Malformed/);
  assert.equal((resumed.runtime.inspect({ message: message.id }) as any).message.text, message.text);
  assert.match(beforeInspection.trimEnd(), /\{"type":"custom","data":$/);
  assert.equal(readFileSync(file, 'utf8'), beforeInspection, 'inspection never repairs or truncates native data');
  const other = SessionManager.create(f.root, join(f.root, 'other'));
  other.appendMessage({ role: 'user', content: 'real turn', timestamp: Date.now() });
  other.appendCustomEntry(RECORD_TYPE, { version: 99, owner: other.getSessionId(), scope: f.root, writeId: randomUUID(), event: { kind: 'pause', value: false } });
  assert.equal(attach(other, f.root).log.info().state, 'blocked');
});

test('F10: incomplete or conflicting records never restore an active collaboration', t => {
  const f = fixture(t);
  const events: RecoveryEvent[] = [{ kind: 'outcome', id: randomUUID(), state: 'accepted' }];
  const empty = new Runtime(randomUUID(), async () => ({ outcome: 'accepted' }));
  empty.restore(events);
  assert.match(empty.holdReason()!, /no original message/);
  assert.deepEqual(empty.eligible(), []);
  f.log.close();
  assert.throws(() => f.log.append({ kind: 'pause', value: true }), /CONTEXT_LOST/);
});

test('F10: a saved ask candidate is not restored as admitted or replayed through its old result', async t => {
  const f = fixture(t), b = peer(); f.runtime.approveFromOwner(b);
  const asks = new Asks(f.runtime), item: AskItem = {};
  asks.open('interrupted-ask', [item]);
  let waiting!: Promise<void>;
  const request = await f.runtime.send({ to: b.id, subject: 'Review', text: 'One request' }, entry => {
    waiting = asks.register('interrupted-ask', item, entry, 1);
  });
  asks.sent(request.message.id, request.state);
  const reply = envelope({ exchange: request.message.exchange, replyTo: request.message.id, text: 'CANDIDATE_NOT_YET_ADMITTED' });
  f.runtime.receive(b.id, reply); asks.admit(); await waiting;
  const candidate = asks.project('interrupted-ask', 1);
  const proof = f.manager.appendMessage({ role: 'toolResult', toolCallId: 'interrupted-ask', toolName: 'comms_ask',
    content: [{ type: 'text', text: reply.text }], details: { ok: true, data: candidate }, isError: false, timestamp: Date.now() });
  asks.end('interrupted'); f.log.close();
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  resumed.runtime.observedNative([reply.id], proof, 'ask');
  assert.ok(resumed.runtime.waiting.includes(reply.id), 'saving the candidate did not admit it');
  const freshAsks = new Asks(resumed.runtime);
  assert.equal(freshAsks.has('interrupted-ask'), false, 'old waits are not restored');
  const projected = freshAsks.restoredProjection(candidate) as any;
  assert.equal(projected.items[0].outcome, 'interrupted');
  assert.doesNotMatch(JSON.stringify(projected), /CANDIDATE_NOT_YET_ADMITTED/);
  assert.equal((resumed.runtime.inspect({ message: reply.id }) as any).message.text, reply.text, 'authorized history stays inspectable');
  resumed.runtime.approveFromOwner(b);
  assert.deepEqual(resumed.runtime.eligible(), [reply.id], 'definitely unoffered reply can use normal fresh admission');
  resumed.runtime.posted([reply.id]);
  assert.doesNotMatch(JSON.stringify(freshAsks.restoredProjection(candidate)), /CANDIDATE_NOT_YET_ADMITTED/, 'ordinary batch delivery does not duplicate the reply in the old ask result');
});

test('F10: an offered busy-boundary batch discarded before native append stays uncertain', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  const incoming = envelope({ text: 'QUEUED_BUT_NEVER_ADMITTED' });
  f.runtime.receive(b.id, incoming);
  f.runtime.offered([incoming.id], 'native Pi sendMessage');
  // This models a cleared steering queue: the host never added a
  // comms_batch custom_message to its saved session.
  const before = f.runtime.inspect({ message: incoming.id }) as any;
  assert.equal(before.intake, 'offered');
  assert.equal(before.admission, 'uncertain');
  assert.equal(before.facts.some((fact: any) => fact.kind === 'posted'), false);
  assert.deepEqual(f.runtime.eligible(), []);
  assert.ok(f.runtime.waiting.includes(incoming.id), 'no evidence to remove it from pending intake');
  assert.equal(f.manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'comms_batch').length, 0);

  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  const restored = resumed.runtime.inspect({ message: incoming.id }) as any;
  assert.equal(restored.intake, 'offered');
  assert.equal(restored.admission, 'uncertain');
  assert.equal(restored.facts.some((fact: any) => fact.kind === 'posted' || fact.kind === 'saved'), false);
  assert.ok(resumed.runtime.waiting.includes(incoming.id));
  assert.deepEqual(resumed.runtime.eligible(), [], 'unknown host admission must not trigger automatic replay');

  const entryId = f.manager.appendCustomMessageEntry('comms_batch', 'native batch', true, { owner: f.manager.getSessionId(), ids: [incoming.id] });
  resumed.runtime.observedNative([incoming.id], entryId);
  const confirmed = resumed.runtime.inspect({ message: incoming.id }) as any;
  assert.equal(confirmed.intake, 'posted');
  assert.equal(confirmed.admission, undefined);
  assert.equal(confirmed.facts.some((fact: any) => fact.kind === 'posted'), true);
  assert.equal(confirmed.facts.some((fact: any) => fact.kind === 'saved'), true);
  assert.equal(resumed.runtime.waiting.length, 0);
});

test('F10: completed nested caller handoff is not resurrected as waiting after restart', async t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  const asks = new Asks(f.runtime), item: AskItem = {};
  asks.open('nested-recovery', [item]);
  let waiting!: Promise<void>;
  const request = await f.runtime.send({ to: b.id, subject: 'Nested review', text: 'Review risk' }, entry => {
    waiting = asks.register('nested-recovery', item, entry, 1);
  });
  asks.sent(request.message.id, request.state);
  const reply = envelope({ exchange: request.message.exchange, replyTo: request.message.id, text: 'COMPLETED_NESTED_HANDOFF' });
  f.runtime.receive(b.id, reply); asks.admit(); await waiting;
  asks.present('nested-recovery', NESTED_HANDOFF);
  const delivered = f.runtime.inspect({ message: reply.id }) as any;
  assert.equal(delivered.intake, 'handed-off');
  assert.equal(delivered.intakeSource, NESTED_HANDOFF);
  assert.equal(f.runtime.waiting.length, 0);
  assert.equal(delivered.admission, undefined);
  assert.equal(delivered.facts.some((fact: any) => fact.kind === 'saved'), false, 'not a native child transcript');

  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  const restored = resumed.runtime.inspect({ message: reply.id }) as any;
  assert.equal(restored.intake, 'handed-off');
  assert.equal(restored.intakeSource, NESTED_HANDOFF);
  assert.equal(restored.admission, undefined);
  assert.equal(resumed.runtime.waiting.length, 0);
  assert.equal((resumed.runtime.inspect({}) as any).uncertainAdmission.length, 0);
  assert.equal(restored.facts.some((fact: any) => fact.kind === 'saved'), false);
  assert.equal((new Asks(resumed.runtime)).has('nested-recovery'), false, 'the old ask waiter is not restored');
});

test('F10: legacy posted-source nested handoff restores as completed, not awaiting native admission', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  const reply = envelope({ text: 'NESTED_ALREADY_PASSED_TO_CALLER' });
  f.runtime.receive(b.id, reply);
  // Earlier F10 draft wrote the generic posted disposition even though the
  // specific source said this was a nested result handed to its caller.
  f.runtime.posted([reply.id], NESTED_HANDOFF);
  const recovered = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  const state = recovered.runtime.inspect({ message: reply.id }) as any;
  assert.equal(state.intake, 'handed-off');
  assert.equal(state.admission, undefined);
  assert.equal(state.facts.some((fact: any) => fact.kind === 'handed-off' && fact.source === NESTED_HANDOFF), true);
  assert.equal(recovered.runtime.waiting.length, 0);
  assert.deepEqual((recovered.runtime.inspect({}) as any).uncertainAdmission, []);
});

test('F10: premature posted receipts from earlier F10 drafts become offered/uncertain', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  const incoming = envelope({ text: 'OLDER_QUEUED_STEER' });
  f.runtime.receive(b.id, incoming);
  // Simulate the old mistaken immediate state transition after sendMessage().
  f.runtime.posted([incoming.id], 'native Pi sendMessage');
  assert.equal((f.runtime.inspect({ message: incoming.id }) as any).intake, 'posted');
  const recovered = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  const state = recovered.runtime.inspect({ message: incoming.id }) as any;
  assert.equal(state.intake, 'offered', 'no native evidence has confirmed this old steering offer');
  assert.equal(state.admission, 'uncertain');
  assert.equal(state.facts.some((fact: any) => fact.kind === 'posted'), false);
  assert.equal(recovered.runtime.waiting.includes(incoming.id), true);
  assert.deepEqual(recovered.runtime.eligible(), [], 'do not automatically replay an uncertain send');
});
