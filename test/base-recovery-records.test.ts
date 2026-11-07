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
  assert.equal(state.intakeSource, NESTED_HANDOFF);
  assert.equal(state.facts.some((fact: any) => fact.kind === 'posted'), false,
    'do not invent a posted receipt or handoff timestamp missing from the old saved record');
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

test('F10: native in-memory admission is not mislabeled as saved on disk', t => {
  const f = fixture(t, false), b = peer();
  f.runtime.approveFromOwner(b);
  const incoming = envelope({ text: 'LIVE_NATIVE_ADMISSION' });
  f.runtime.receive(b.id, incoming);
  f.runtime.offered([incoming.id]);
  f.runtime.observedNative([incoming.id], 'native-memory-entry', 'batch', false);
  const observed = f.runtime.inspect({ message: incoming.id }) as any;
  assert.equal(observed.intake, 'posted');
  assert.equal(observed.admission, undefined);
  assert.equal(observed.facts.some((fact: any) => fact.kind === 'posted'), true);
  assert.equal(observed.facts.some((fact: any) => fact.kind === 'saved'), false);
  assert.equal(observed.record.state, 'volatile');
  assert.equal(f.runtime.waiting.length, 0);
});

test('F10: owner may explicitly retry uncertain native admission using the original record', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b);
  const message = envelope({ text: 'MANUAL_UNCERTAIN_RETRY' });
  f.runtime.receive(b.id, message);
  f.runtime.offered([message.id]);
  const loaded = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.deepEqual(loaded.runtime.pendingCounts(), { waiting: 0, uncertain: 1 });
  assert.equal((loaded.runtime.inspect({}) as any).waiting, 0);
  assert.equal((loaded.runtime.inspect({}) as any).uncertain, 1);
  assert.equal(loaded.runtime.uncertainIncoming()[0].message.id, message.id);
  assert.deepEqual(loaded.runtime.eligible(), [], 'no automatic replay after restart');
  assert.throws(() => loaded.runtime.resolveUncertainFromOwner(message.id, 'retry'), /CONTACT_NOT_APPROVED/);
  assert.deepEqual(loaded.runtime.pendingCounts(), { waiting: 0, uncertain: 1 });
  loaded.runtime.approveFromOwner(b);
  const originalHandle = (loaded.runtime.inspect({ message: message.id }) as any).returnHandle;
  const retried = loaded.runtime.resolveUncertainFromOwner(message.id, 'retry');
  assert.equal(retried.message.id, message.id);
  assert.equal(retried.returnHandle, originalHandle);
  assert.equal(retried.intake, 'waiting');
  assert.deepEqual(loaded.runtime.pendingCounts(), { waiting: 1, uncertain: 0 });
  assert.deepEqual(loaded.runtime.eligible(), [message.id]);
  const recovered = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal((recovered.runtime.inspect({ message: message.id }) as any).intake, 'waiting');
  assert.deepEqual(recovered.runtime.pendingCounts(), { waiting: 1, uncertain: 0 });
  assert.deepEqual(recovered.runtime.eligible(), [], 'positive consent still ends with runtime reset');
  recovered.runtime.approveFromOwner(b);
  recovered.runtime.offered([message.id]);
  const actual = f.manager.appendCustomMessageEntry('comms_batch', message.text, true,
    { owner: f.manager.getSessionId(), ids: [message.id] });
  recovered.runtime.observedNative([message.id], actual);
  assert.deepEqual(recovered.runtime.pendingCounts(), { waiting: 0, uncertain: 0 });
  assert.equal((recovered.runtime.inspect({ message: message.id }) as any).intake, 'posted');
});

test('F10: owner may dismiss uncertain admission; dismissal persists without erasing evidence', t => {
  const f = fixture(t), b = peer();
  const message = envelope({ text: 'DISMISSED_WITHOUT_REPLAY' });
  f.runtime.receive(b.id, message);
  f.runtime.offered([message.id]);
  f.runtime.resolveUncertainFromOwner(message.id, 'dismiss');
  assert.deepEqual(f.runtime.pendingCounts(), { waiting: 0, uncertain: 0 });
  const retained = f.runtime.inspect({ message: message.id }, 'human') as any;
  assert.equal(retained.message.text, message.text);
  assert.equal(retained.intake, 'dismissed');
  assert.equal(retained.facts.some((fact: any) => fact.kind === 'posted'), false);
  assert.throws(() => f.runtime.resolveUncertainFromOwner(message.id, 'retry'), /INVALID_INPUT/);
  const reopened = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal((reopened.runtime.inspect({ message: message.id }, 'human') as any).intake, 'dismissed');
  assert.deepEqual(reopened.runtime.pendingCounts(), { waiting: 0, uncertain: 0 });
  assert.deepEqual(reopened.runtime.eligible(), []);
  // If an old host steer lands later, the observed native proof wins.
  const appended = f.manager.appendCustomMessageEntry('comms_batch', message.text, true,
    { owner: f.manager.getSessionId(), ids: [message.id] });
  reopened.runtime.observedNative([message.id], appended);
  assert.equal((reopened.runtime.inspect({ message: message.id }, 'human') as any).intake, 'posted');
});

test('F10: explicit outgoing No is a durable peer refusal, distinct from a cancelled send', t => {
  const f = fixture(t), b = peer();
  f.runtime.revokeFromOwner(b.id);
  f.runtime.approveFromTransport(b);
  assert.equal(f.runtime.isApproved(b.id), false);
  const reopened = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(reopened.runtime.isRevoked(b.id), true);
  reopened.runtime.approveFromTransport(b);
  assert.equal(reopened.runtime.isApproved(b.id), false, 'transport assertion cannot clear owner No');
  reopened.runtime.approveFromOwner(b);
  const reapproved = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(reapproved.runtime.isRevoked(b.id), false);
  assert.equal(reapproved.runtime.isApproved(b.id), false, 'F10 grants remain runtime-only after restart');
});

test('F11: owner-remembered exact-peer approval survives same saved session restart', async t => {
  const f = fixture(t), b = peer(), stranger = peer();
  const state = f.runtime.approveFromOwner(b, true);
  assert.equal(state, 'saved');
  assert.equal(f.runtime.isRemembered(b.id), true);
  const reopened = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(reopened.runtime.isApproved(b.id), true);
  assert.equal(reopened.runtime.isRemembered(b.id), true);
  assert.equal(reopened.runtime.approval(b.id)?.context, b.context);
  assert.equal(reopened.runtime.isApproved(stranger.id), false);
  const sent = await reopened.runtime.send({ to: b.id, subject: 'Continue', text: 'Work after restart' });
  assert.equal(sent.state, 'accepted');
  assert.equal(reopened.sends(), 1, 'same exact peer sends without renewed contact confirmation');
  await assert.rejects(reopened.runtime.send({ to: stranger.id, subject: 'No grant', text: 'no' }), /CONTACT_NOT_APPROVED/);
});

test('F11: earlier F10 owner grants and transport-derived approvals remain runtime-only', t => {
  const f = fixture(t), b = peer(), c = peer();
  f.runtime.approveFromOwner(b);
  f.runtime.approveFromTransport(c);
  assert.equal(f.runtime.isApproved(b.id), true);
  assert.equal(f.runtime.isApproved(c.id), true);
  assert.equal(f.runtime.isRemembered(b.id), false);
  assert.equal(f.runtime.isRemembered(c.id), false);
  const reopened = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(reopened.runtime.isApproved(b.id), false, 'F10 grants never silently upgrade');
  assert.equal(reopened.runtime.isApproved(c.id), false, 'transport assertion cannot create remembered consent');
});

test('F11: revocation overrides a remembered grant; later session-only reapproval removes remembrance', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b, true);
  f.runtime.revokeFromOwner(b.id);
  const afterRevoke = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(afterRevoke.runtime.isRevoked(b.id), true);
  assert.equal(afterRevoke.runtime.isApproved(b.id), false);
  assert.equal(afterRevoke.runtime.isRemembered(b.id), false);
  afterRevoke.runtime.approveFromTransport(b);
  assert.equal(afterRevoke.runtime.isApproved(b.id), false);
  const saved = afterRevoke.runtime.approveFromOwner(b, false);
  assert.equal(saved, 'saved');
  assert.equal(afterRevoke.runtime.isApproved(b.id), true);
  assert.equal(afterRevoke.runtime.isRemembered(b.id), false);
  const again = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(again.runtime.isRevoked(b.id), false);
  assert.equal(again.runtime.isApproved(b.id), false, 'only current runtime received session-only grant');
  assert.equal(again.runtime.isRemembered(b.id), false);
});

test('F11: a later owner session-only choice clears earlier remembered consent', t => {
  const f = fixture(t), b = peer();
  f.runtime.approveFromOwner(b, true);
  f.runtime.approveFromOwner(b, false);
  const reopened = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(reopened.runtime.isApproved(b.id), false);
  assert.equal(reopened.runtime.isRemembered(b.id), false);
});

test('F11: one owner remembering a pair does not grant the other owner persistent consent', t => {
  const f = fixture(t);
  const other = SessionManager.create(f.root, join(f.root, 'other-sessions'));
  other.appendMessage({ role: 'user', content: 'Other owner session', timestamp: Date.now() });
  const b = attach(other, f.root);
  const fromA = { id: f.manager.getSessionId(), name: 'Lead', context: 'Review' };
  const fromB = { id: other.getSessionId(), name: 'Reviewer', context: 'Review' };
  f.runtime.approveFromOwner(fromB, true);
  b.runtime.approveFromTransport(fromA);
  assert.equal(b.runtime.isApproved(fromA.id), true, 'fresh valid transport can authorize this runtime');
  const both = [attach(SessionManager.open(f.manager.getSessionFile()!), f.root),
    attach(SessionManager.open(other.getSessionFile()!), f.root)];
  assert.equal(both[0].runtime.isApproved(fromB.id), true, 'A remembers its own exact peer');
  assert.equal(both[1].runtime.isApproved(fromA.id), false, 'B transport grant was not B owner remembrance');
});

test('F11: remembered permissions never transfer to a native fork or unrelated scope', t => {
  const f = fixture(t), b = peer();
  const firstLeaf = f.manager.getLeafId()!;
  f.runtime.approveFromOwner(b, true);
  f.manager.branch(firstLeaf);
  f.manager.appendMessage({ role: 'user', content: 'Other branch', timestamp: Date.now() });
  const same = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(same.runtime.isApproved(b.id), true, "tree change does not undo owner's durable choice");
  const fork = SessionManager.forkFrom(f.manager.getSessionFile()!, join(f.root, 'fork-f11'), join(f.root, 'fork-sessions'));
  assert.notEqual(fork.getSessionId(), f.manager.getSessionId());
  const child = attach(fork, f.root);
  assert.equal(child.runtime.isApproved(b.id), false);
  assert.equal(child.runtime.isRemembered(b.id), false);
  const outside = attach(SessionManager.open(f.manager.getSessionFile()!), join(f.root, 'another-scope'));
  assert.equal(outside.runtime.isApproved(b.id), false, 'scope-bounded records cannot grant another agent directory');
});

test('F11: a fresh remembered choice remains volatile until Pi saves a real turn', t => {
  const f = fixture(t, false), b = peer();
  assert.equal(f.runtime.approveFromOwner(b, true), 'volatile');
  assert.equal(existsSync(f.manager.getSessionFile()!), false);
  assert.equal(f.runtime.isApproved(b.id), true, 'local consent applies in the live runtime');
  f.manager.appendMessage({ role: 'user', content: 'Actual first turn', timestamp: Date.now() });
  const resumed = attach(SessionManager.open(f.manager.getSessionFile()!), f.root);
  assert.equal(resumed.runtime.isApproved(b.id), true, 'native host flush made the remembered choice durable');
  const ephemeral = attach(SessionManager.inMemory(f.root), f.root);
  assert.equal(ephemeral.runtime.approveFromOwner(b, true), 'volatile');
  assert.equal(ephemeral.runtime.isApproved(b.id), true);
  assert.equal(ephemeral.log.info().state, 'volatile');
});

test('F11: failed remembered owner grant cannot replace a saved refusal or expose held history', t => {
  const f = fixture(t), b = peer();
  f.runtime.revokeFromOwner(b.id);
  const held = envelope({ text: 'STILL_WITHHELD_AFTER_FAILED_REMEMBER' });
  f.runtime.receive(b.id, held);
  const file = f.manager.getSessionFile()!;
  const manager = SessionManager.open(file);
  const broken = attach(manager, f.root, (type, data) => {
    const event = (data as { event?: { kind?: string; remembered?: unknown } })?.event;
    if (event?.kind === 'contact' && event.remembered) throw new Error('simulated remembered grant write failure');
    manager.appendCustomEntry(type, data);
  });
  assert.equal(broken.runtime.isRevoked(b.id), true);
  assert.throws(() => broken.runtime.approveFromOwner(b, true), /PERSISTENCE_FAILED/);
  assert.equal(broken.runtime.isRemembered(b.id), false);
  assert.equal(broken.runtime.isApproved(b.id), false);
  const reopened = attach(SessionManager.open(file), f.root);
  assert.equal(reopened.runtime.isRevoked(b.id), true);
  assert.equal(reopened.runtime.isApproved(b.id), false);
  assert.equal(reopened.runtime.isRemembered(b.id), false);
  assert.equal((reopened.runtime.inspect({ message: held.id }) as any).evidence, 'withheld');
});
