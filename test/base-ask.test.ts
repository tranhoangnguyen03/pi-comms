import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { Asks, type AskItem } from '../src/ask.ts';
import { AskInput, InspectInput, validate } from '../src/schema.ts';
import { modelView } from '../src/model-view.ts';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const envelope = (request: any, text = 'answer') => ({ id: randomUUID(), exchange: request.exchange, subject: request.subject, text, refs: [], replyTo: request.id, corrects: null, createdAt: new Date().toISOString() });

test('ask registers before transport, matches native peer + exact request, and claims once', async () => {
  const peer = randomUUID(), self = randomUUID();
  let asks: Asks; let immediate = true;
  const runtime = new Runtime(self, async (_id, outgoing) => {
    if (immediate) { runtime.receive(peer, envelope(outgoing)); asks.admit(); }
    return { outcome: 'accepted' };
  });
  runtime.approveFromOwner({ id: peer, name: 'B', context: 'review' }); asks = new Asks(runtime);
  const item: AskItem = {}; asks.open('first', [item]); let waiting: Promise<void> | undefined;
  const sent = await runtime.send({ to: peer, subject: 'Review', text: 'question' }, entry => { waiting = asks.register('first', item, entry, .1); });
  asks.sent(sent.message.id, sent.state); await waiting;
  assert.equal(item.outcome, 'replied'); assert.ok(asks.claimed(item.reply!));
  assert.equal(runtime.waiting.length, 1, 'resolving a promise is not admission');
  const wrong = randomUUID(); assert.throws(() => runtime.receive(wrong, envelope(sent.message)), /linkage/);
  asks.present('first'); assert.equal(runtime.waiting.length, 0); asks.present('first');
  assert.equal(runtime.entry(item.reply!)!.facts.filter(f => f.kind === 'posted').length, 1);
  immediate = false;
  const second: AskItem = {}; asks.open('second', [second]);
  const newer = await runtime.send({ respondTo: runtime.entry(item.reply!)!.returnHandle!, text: 'new question' }, entry => { waiting = asks.register('second', second, entry, .1); });
  asks.sent(newer.message.id, newer.state);
  runtime.receive(peer, envelope(sent.message, 'another answer to the OLD request')); asks.admit();
  assert.equal(second.outcome, undefined, 'an old reply in the same exchange cannot settle the newer ask');
  runtime.receive(peer, envelope(newer.message, 'answer to the NEW request')); asks.admit(); await waiting;
  assert.notEqual(second.reply, item.reply);
  const progress: any = runtime.inspect({ requests: [sent.message.id, newer.message.id] });
  assert.equal(progress.responses[1].replies[0].message.replyTo, newer.message.id);
});

test('overlapping waits have independent rejection, timeout, late replies, release and privacy', async () => {
  const peer = randomUUID();
  let outcome: 'accepted' | 'rejected' | 'unknown' = 'accepted';
  const runtime = new Runtime(randomUUID(), async () => ({ outcome }));
  runtime.approveFromOwner({ id: peer, name: 'B', context: 'review' });
  const asks = new Asks(runtime);
  const start = async (call: string) => {
    const item: AskItem = {}; asks.open(call, [item]); let waiting!: Promise<void>;
    const sent = await runtime.send({ to: peer, subject: call, text: 'question' }, entry => { waiting = asks.register(call, item, entry, .1); });
    asks.sent(sent.message.id, sent.state, sent.code);
    return { item, sent, waiting };
  };
  const first = await start('first'), second = await start('second');
  runtime.receive(peer, envelope(first.sent.message)); asks.admit(); await first.waiting;
  assert.equal(second.item.outcome, undefined);
  asks.end('interrupted', 'first'); assert.equal(first.item.reply, undefined);
  assert.equal(runtime.eligible().length, 1, 'unpresented reply retained for normal intake');
  await second.waiting; assert.equal(second.item.outcome, 'timeout');
  const late = envelope(second.sent.message, 'late useful answer'); runtime.receive(peer, late); asks.admit();
  assert.equal(asks.claimed(late.id), false);
  outcome = 'rejected'; const rejected = await start('refused'); await rejected.waiting; assert.equal(rejected.item.outcome, 'rejected');
  outcome = 'unknown'; const unknown = await start('unknown'); await unknown.waiting; assert.equal(unknown.item.outcome, 'unknown');
  outcome = 'accepted'; const revoked = await start('revoked');
  runtime.receive(peer, envelope(revoked.sent.message, 'PRIVATE')); asks.admit(); await revoked.waiting;
  runtime.revokeFromOwner(peer); asks.end('revoked', undefined, peer);
  assert.equal(revoked.item.outcome, 'revoked'); assert.doesNotMatch(JSON.stringify(asks.project('revoked', .1)), /PRIVATE/);
  const progress = runtime.inspect({ requests: [revoked.sent.message.id] });
  assert.doesNotMatch(modelView(progress, () => 'B'), /PRIVATE/);
});

test('reply clock starts after acceptance; all local endings clear outstanding waits', async () => {
  for (const reason of ['paused', 'interrupted', 'context-lost', 'disconnected'] as const) {
    const peer = randomUUID(); const runtime = new Runtime(randomUUID(), async () => ({ outcome: 'accepted' }));
    runtime.approveFromOwner({ id: peer, name: 'B', context: 'review' });
    const asks = new Asks(runtime); const item: AskItem = {}; asks.open('call', [item]);
    let waiting!: Promise<void>;
    const sent = await runtime.send({ to: peer, subject: 'Review', text: 'question' }, entry => { waiting = asks.register('call', item, entry, .1); });
    await delay(120); assert.equal(item.outcome, undefined, 'registration alone starts no timer');
    asks.sent(sent.message.id, sent.state); asks.end(reason); await waiting;
    assert.equal(item.outcome, reason);
  }
});

test('bounded ask schema, response selection and lean projections retain handles and exact payload', async () => {
  const to = randomUUID();
  validate(AskInput, { requests: [{ to, subject: 'Review', text: 'question' }] });
  for (const input of [{ requests: [] }, { requests: [{ to, text: 'missing subject' }] }, { requests: [{ to, subject: 's', text: 'q' }], timeoutSeconds: 601 }]) assert.throws(() => validate(AskInput, input));
  assert.throws(() => validate(InspectInput, { requests: [to], cursor: to }));
  const runtime = new Runtime(randomUUID(), async () => ({ outcome: 'accepted' })); runtime.approveFromOwner({ id: to, name: 'B', context: 'review' });
  const first = await runtime.send({ to, subject: 'Review', text: 'first' });
  const incoming = envelope(first.message, 'Substantive thanks are allowed.\nFULL PAYLOAD'); runtime.receive(to, incoming);
  const followup = await runtime.send({ respondTo: runtime.entry(incoming.id)!.returnHandle!, text: 'second' });
  const progress: any = runtime.inspect({ requests: [first.message.id, followup.message.id] });
  assert.equal(progress.responses[0].outcome, 'reply-received'); assert.equal(progress.responses[1].outcome, 'no-reply-yet');
  assert.match(modelView(runtime.inspect({ message: first.message.id }), () => 'B'), new RegExp(`Responses: ${incoming.id}`));
  const projected = modelView(progress, () => 'B'); assert.match(projected, /FULL PAYLOAD/); assert.match(projected, /respondTo/); assert.match(projected, /No reply yet/); assert.doesNotMatch(projected, /^\{/);
});
