import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Asks, type AskItem } from '../src/ask.ts';
import { Runtime } from '../src/runtime.ts';
import { AskInput, validate } from '../src/schema.ts';
import { modelView } from '../src/model-view.ts';

const a = randomUUID(), b = randomUUID(), c = randomUUID();
const approved = (id: string) => ({ id, name: 'Reviewer', context: 'Review' });
function pair() {
  const fromA: any[] = [], fromB: any[] = [];
  const lead = new Runtime(a, async (_id, envelope) => { fromA.push(envelope); return { outcome: 'accepted' }; });
  const reviewer = new Runtime(b, async (_id, envelope) => { fromB.push(envelope); return { outcome: 'accepted' }; });
  lead.approveFromOwner(approved(b)); reviewer.approveFromOwner(approved(a));
  return { lead, reviewer, fromA, fromB };
}
async function request(lead: Runtime, reviewer: Runtime, fromA: any[], asks: Asks, call: string, mode: 'first-reply' | 'reported-outcome' = 'reported-outcome') {
  const item: AskItem = {}, seconds = .5;
  asks.open(call, [item], mode);
  let pending!: Promise<void>;
  const sent = await lead.send({ to: b, subject: 'Check retry', text: 'Find unsafe writes', workRef: 'AUTH-42' },
    entry => { pending = asks.register(call, item, entry, seconds, mode); });
  asks.sent(sent.message.id, sent.state);
  reviewer.receive(a, fromA.at(-1));
  return { item, sent, pending };
}

test('outcome selector and wait mode validate without altering legacy default asks', () => {
  const id = randomUUID(), msg = { to: b, subject: 'Review', text: 'Check' };
  validate(AskInput, { requests: [msg] });
  validate(AskInput, { requests: [msg], waitFor: 'first-reply' });
  validate(AskInput, { requests: [msg], waitFor: 'reported-outcome' });
  validate(AskInput, { outcomes: [id] });
  validate(AskInput, { outcomes: [id], waitFor: 'reported-outcome' });
  for (const input of [
    {}, { requests: [msg], outcomes: [id] }, { outcomes: [id, id] },
    { outcomes: [id], waitFor: 'first-reply' }, { outcomes: [] }, { requests: [] },
    { outcomes: [id], timeoutSeconds: 601 }, { requests: [msg], waitFor: 'unsupported' },
  ]) assert.throws(() => validate(AskInput, input), /INVALID_INPUT/);
});

test('reported-outcome returns an ordinary question promptly, never inferring completion', async () => {
  const { lead, reviewer, fromA, fromB } = pair(), asks = new Asks(lead);
  const { sent, pending, item } = await request(lead, reviewer, fromA, asks, 'question');
  await reviewer.send({ respondTo: reviewer.entry(sent.message.id)!.returnHandle!, text: 'Do writes count?' });
  lead.receive(b, fromB[0]); asks.admit(); await pending;
  assert.equal(item.outcome, 'replied', 'plain question is actionable, not a final report');
  const projection = asks.project('question', .5);
  assert.equal(projection.waitFor, 'reported-outcome');
  assert.match(modelView(projection, () => 'Reviewer'), /without a reported outcome/);
  assert.equal(item.reply, fromB[0].id);
  asks.present('question');
  assert.deepEqual(lead.waiting, [], 'presented question enters model context exactly once');
});

test('needs-input returns; resume on existing request waits for later completion without resending', async () => {
  const { lead, reviewer, fromA, fromB } = pair(), asks = new Asks(lead);
  const { sent, pending, item } = await request(lead, reviewer, fromA, asks, 'initial');
  const original = sent.message.id;
  await reviewer.send({ respondTo: reviewer.entry(original)!.returnHandle!, text: 'Need a policy choice',
    report: { request: original, state: 'needs-input' } });
  lead.receive(b, fromB[0]); asks.admit(); await pending;
  assert.equal(item.outcome, 'needs-input');
  assert.equal(item.reply, fromB[0].id);
  asks.present('initial');
  const question = lead.entry(fromB[0].id)!.returnHandle!;
  const answer = await lead.send({ respondTo: question, text: 'Only retry idempotent reads' });
  reviewer.receive(a, fromA[1]);

  const remaining: AskItem = {};
  asks.open('resume', [remaining], 'reported-outcome');
  const waiting = asks.watch('resume', remaining, lead.entry(original)!, .5);
  const sendsBefore = fromA.length;
  await reviewer.send({ respondTo: reviewer.entry(answer.message.id)!.returnHandle!,
    text: 'Found the unsafe write retry', report: { request: original, state: 'complete' },
    structured: { findings: 1 } });
  lead.receive(b, fromB[1]); asks.admit(); await waiting;
  assert.equal(remaining.outcome, 'reported-complete');
  assert.equal(remaining.request, original);
  assert.equal(remaining.reply, fromB[1].id);
  assert.equal(fromA.length, sendsBefore, 'watching an existing request never sends it again');
  assert.equal((asks.project('resume', .5).items[0] as any).response.message.report.request, original);
  assert.match(modelView(asks.project('resume', .5), () => 'Reviewer'), /Peer reports complete/);
  asks.present('resume');
  assert.equal(lead.waiting.length, 0);
});

test('progress is not final; blocked and timeout are distinct from requester acceptance', async () => {
  const { lead, reviewer, fromA, fromB } = pair(), asks = new Asks(lead);
  const { sent, pending, item } = await request(lead, reviewer, fromA, asks, 'progress');
  await reviewer.send({ respondTo: reviewer.entry(sent.message.id)!.returnHandle!,
    text: 'Review is halfway', report: { request: sent.message.id, state: 'progress' } });
  lead.receive(b, fromB[0]); asks.admit();
  assert.equal(item.outcome, undefined, 'progress alone does not finish an outcome wait');
  assert.equal(asks.claimed(fromB[0].id), true, 'progress cannot wake the model while the selected outcome wait runs');
  await reviewer.send({ respondTo: reviewer.entry(sent.message.id)!.returnHandle!,
    text: 'Tests unavailable', report: { request: sent.message.id, state: 'blocked' } });
  lead.receive(b, fromB[1]); asks.admit(); await pending;
  assert.equal(item.outcome, 'blocked');
  assert.equal(item.reply, fromB[1].id);
  assert.equal(lead.waiting.includes(fromB[0].id), true, 'progress stays available for ordinary intake');
  asks.present('progress');
  assert.equal(asks.claimed(fromB[0].id), false, 'progress returns to normal intake after the wait');
  const later: AskItem = {}; asks.open('timeout', [later], 'reported-outcome');
  const wait = asks.watch('timeout', later, lead.entry(sent.message.id)!, .05);
  await wait;
  assert.equal(later.outcome, 'timeout', 'already presented reports do not silently complete a later watch');
  assert.equal(later.reply, undefined);
  asks.present('timeout');
});

test('independent existing waits preserve pause, revoke and exact-request isolation', async () => {
  const { lead, reviewer, fromA, fromB } = pair(), asks = new Asks(lead);
  const first = await lead.send({ to: b, subject: 'A', text: 'A review' });
  const second = await lead.send({ to: b, subject: 'B', text: 'B review' });
  reviewer.receive(a, fromA[0]); reviewer.receive(a, fromA[1]);
  const one: AskItem = {}, two: AskItem = {};
  asks.open('both', [one, two], 'reported-outcome');
  const p1 = asks.watch('both', one, lead.entry(first.message.id)!, .15);
  const p2 = asks.watch('both', two, lead.entry(second.message.id)!, .15);
  await reviewer.send({ respondTo: reviewer.entry(first.message.id)!.returnHandle!, text: 'A done',
    report: { request: first.message.id, state: 'complete' } });
  lead.receive(b, fromB[0]); asks.admit();
  await p1;
  assert.equal(one.outcome, 'reported-complete');
  assert.equal(two.outcome, undefined, 'the other exact request remains pending');
  asks.end('paused', 'both'); await p2;
  assert.equal(one.outcome, 'paused', 'interruption before result presentation releases earlier claims');
  assert.equal(two.outcome, 'paused');
  assert.equal(asks.claimed(fromB[0].id), false);
  asks.present('both');

  const third: AskItem = {}; asks.open('revoked', [third], 'reported-outcome');
  const waiting = asks.watch('revoked', third, lead.entry(second.message.id)!, .5);
  lead.revokeFromOwner(b); asks.end('revoked', undefined, b); await waiting;
  assert.equal(third.outcome, 'revoked');
  assert.equal(third.reply, undefined);
  assert.equal(fromA.length, 2, 'waiting never resends any request');
});

test('cannot start two simultaneous watches on one request', async () => {
  const { lead } = pair(), asks = new Asks(lead);
  const sent = await lead.send({ to: b, subject: 'A', text: 'A review' });
  const first: AskItem = {}, second: AskItem = {};
  asks.open('one', [first], 'reported-outcome');
  asks.open('two', [second], 'reported-outcome');
  const waiting = asks.watch('one', first, lead.entry(sent.message.id)!, .5);
  assert.throws(() => asks.watch('two', second, lead.entry(sent.message.id)!, .5), /active wait/);
  asks.end('interrupted', 'one'); await waiting; asks.present('one');
});


test('watch registration does not bypass the host admission gate for buffered messages', async () => {
  const { lead, reviewer, fromA, fromB } = pair(), asks = new Asks(lead);
  const original = await lead.send({ to: b, subject: 'A', text: 'Review A' });
  reviewer.receive(a, fromA[0]);
  await reviewer.send({
    respondTo: reviewer.entry(original.message.id)!.returnHandle!,
    text: 'Reported completion', report: { request: original.message.id, state: 'complete' },
  });
  lead.receive(b, fromB[0]);

  const item: AskItem = {};
  asks.open('gate', [item], 'reported-outcome');
  const pending = asks.watch('gate', item, lead.entry(original.message.id)!, .25);
  assert.equal(item.outcome, undefined, 'watch cannot consume a buffered message before the host admits it');
  assert.equal(asks.claimed(fromB[0].id), false);
  assert.equal(lead.waiting.includes(fromB[0].id), true);

  asks.admit(); await pending;
  assert.equal(item.outcome, 'reported-complete');
  asks.present('gate');
  assert.deepEqual(lead.waiting, []);
});

test('plain clarification goes to the nearest watched request in the same exchange', async () => {
  const { lead, reviewer, fromA, fromB } = pair(), asks = new Asks(lead);
  const original = await lead.send({ to: b, subject: 'Review A', text: 'Review the design' });
  reviewer.receive(a, fromA[0]);
  const question = await reviewer.send({
    respondTo: reviewer.entry(original.message.id)!.returnHandle!, text: 'Need details for A',
  });
  lead.receive(b, fromB[0]);
  const followup = await lead.send({
    respondTo: lead.entry(question.message.id)!.returnHandle!, text: 'Follow-up B: more details',
  });
  reviewer.receive(a, fromA[1]);

  const first: AskItem = {}, second: AskItem = {};
  asks.open('shared', [first, second], 'reported-outcome');
  const pA = asks.watch('shared', first, lead.entry(original.message.id)!, .35);
  const pB = asks.watch('shared', second, lead.entry(followup.message.id)!, .35);

  const plain = await reviewer.send({
    respondTo: reviewer.entry(followup.message.id)!.returnHandle!, text: 'Answer to B only',
  });
  lead.receive(b, fromB[1]);
  asks.admit(); await pB;
  assert.equal(second.outcome, 'replied', 'B receives the plain reply addressed to B');
  assert.equal(second.reply, plain.message.id);
  assert.equal(first.outcome, undefined, 'A is still waiting for its own report');

  const final = await reviewer.send({
    respondTo: reviewer.entry(original.message.id)!.returnHandle!,
    text: 'Review A finished', report: { request: original.message.id, state: 'complete' },
  });
  lead.receive(b, fromB[2]); asks.admit(); await pA;
  assert.equal(first.outcome, 'reported-complete');
  assert.equal(first.reply, final.message.id);
  asks.present('shared');
});
