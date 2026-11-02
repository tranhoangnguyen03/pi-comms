import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { MessageInput, AskInput, EnvelopeSchema, validate } from '../src/schema.ts';
import { modelView } from '../src/model-view.ts';
import { inspectionText } from '../src/human-view.ts';
import { InlineCard } from '../src/inline-card.ts';

const a = randomUUID(), b = randomUUID(), c = randomUUID();
const approved = (id: string) => ({ id, name: 'Colleague', context: 'Approved contact' });
const label = (id: string) => id === a ? 'Lead' : id === b ? 'Former reviewer' : 'Successor';

function fixture() {
  const wiresA: any[] = [], wiresB: any[] = [], wiresC: any[] = [];
  const lead = new Runtime(a, async (_to, envelope) => { wiresA.push(envelope); return { outcome: 'accepted' }; });
  const former = new Runtime(b, async (_to, envelope) => { wiresB.push(envelope); return { outcome: 'accepted' }; });
  const successor = new Runtime(c, async (_to, envelope) => { wiresC.push(envelope); return { outcome: 'accepted' }; });
  lead.approveFromOwner(approved(b)); former.approveFromOwner(approved(a));
  return { lead, former, successor, wiresA, wiresB, wiresC };
}

test('explicit handover carries only authored brief and old-exchange reference into a distinct new exchange', async () => {
  const { lead, former, successor, wiresA, wiresB, wiresC } = fixture();
  const old = await lead.send({ to: b, subject: 'Review auth retries', text: 'OLD_PRIVATE_SCOPE', workRef: 'AUTH-42' });
  former.receive(a, wiresA.at(-1)!);
  const report = await former.send({
    respondTo: former.entry(old.message.id)!.returnHandle!,
    text: 'OLD_PRIVATE_EVIDENCE', report: { request: old.message.id, state: 'blocked' },
  });
  lead.receive(b, wiresB.at(-1)!);

  const sourceBefore: any = lead.inspect({ exchange: old.message.exchange });
  assert.equal(sourceBefore.items.length, 2);
  assert.deepEqual(sourceBefore.handovers, []);

  // The owner chooses and separately authorizes C. No permission is inherited from B.
  await assert.rejects(
    lead.send({ to: c, subject: 'Successor brief', text: 'Authored brief', handoverFrom: old.message.exchange }),
    /CONTACT_NOT_APPROVED/);
  assert.equal(lead.known().some(p => p.id === c), false);
  assert.equal(successor.inspect({}).recentExchanges.length, 0);
  lead.approveFromOwner(approved(c)); successor.approveFromOwner(approved(a));

  const text = 'Goal: review retry safety. Finding: uncertain write retry. Open question: can we avoid duplicate writes?';
  const forwarded = await lead.send({
    to: c, subject: 'Successor security review', text,
    workRef: 'AUTH-42', recipientLabel: 'Replacement reviewer',
    handoverFrom: old.message.exchange, refs: [{ label: 'Fix proposal', uri: 'file:///safe/retry-plan.md' }],
  });
  assert.equal(forwarded.state, 'accepted');
  assert.notEqual(forwarded.message.exchange, old.message.exchange);
  assert.equal(forwarded.message.replyTo, null);
  assert.equal(forwarded.message.handoverFrom, old.message.exchange);
  assert.equal(forwarded.message.to, c);
  assert.equal(forwarded.message.from, a);
  assert.equal(wiresA.at(-1)!.handoverFrom, old.message.exchange);
  validate(EnvelopeSchema, wiresA.at(-1)!);
  assert.equal(JSON.stringify(wiresA.at(-1)).includes('OLD_PRIVATE_EVIDENCE'), false);
  assert.equal(JSON.stringify(wiresA.at(-1)).includes('OLD_PRIVATE_SCOPE'), false);
  assert.equal(successor.receive(a, wiresA.at(-1)!), true);

  // Receiver sees exactly the supplied brief, not the former exchange or approval.
  const received: any = successor.inspect({ queue: 'self' }).items[0];
  assert.equal(received.message.text, text);
  assert.equal(received.message.handoverFrom, old.message.exchange);
  assert.equal(successor.entry(old.message.id), undefined);
  assert.equal(successor.known().some(p => p.id === b), false);
  const receiverModel = modelView(successor.inspect({ queue: 'self' }), label);
  assert.match(receiverModel, /Handover from earlier exchange/);
  assert.match(receiverModel, /prior conversation is not shared/);
  const receiverHuman = inspectionText(successor.inspect({ queue: 'self' }, 'human'), {
    self: c, name: label, approved: () => true,
  });
  assert.match(receiverHuman, /Handover from earlier exchange/);
  const card = new InlineCard([{
    id: forwarded.message.id, from: 'Lead', to: 'Successor', subject: forwarded.message.subject,
    text, handoverFrom: forwarded.message.handoverFrom, workRef: forwarded.message.workRef,
    exchange: forwarded.message.exchange, at: forwarded.message.createdAt, fact: 'posted',
  }], { fg: (_: string, value: string) => value } as any, { expanded: false });
  assert.match(card.render(150).join('\n'), /Handover from earlier exchange/);

  const oldAfter: any = lead.inspect({ exchange: old.message.exchange });
  assert.equal(oldAfter.items.length, 2, 'handover never moves or duplicates prior records');
  assert.deepEqual(oldAfter.handovers, [{
    toExchange: forwarded.message.exchange, toPeer: c, message: forwarded.message.id,
    state: 'accepted', code: null,
  }]);
  assert.match(modelView(oldAfter, label), /Handover links from this exchange/);
  assert.match(modelView(oldAfter, label), /Successor/);
  assert.equal(lead.inspect({ exchange: forwarded.message.exchange }).items.length, 1);
  assert.equal(former.inspect({ exchange: old.message.exchange }).items.length, 2);
  assert.equal(former.entry(forwarded.message.id), undefined);

  // An ordinary successor reply stays on the new exchange, and the requester
  // can inspect the same attributed M2 work report after the handover.
  const answer = await successor.send({
    respondTo: received.returnHandle,
    text: 'New finding: guard writes with an idempotency key.',
    report: { request: forwarded.message.id, state: 'complete' },
  });
  lead.receive(c, wiresC.at(-1)!);
  const newWork: any = lead.inspect({ requests: [forwarded.message.id] }).responses[0];
  assert.equal(newWork.currentReport.message.report.state, 'complete');
  assert.equal(newWork.currentReport.message.exchange, forwarded.message.exchange);
  const oldWork: any = lead.inspect({ requests: [old.message.id] }).responses[0];
  assert.equal(oldWork.currentReport.message.id, report.message.id);
});

test('invalid handover provenance and mixing with replies fail before transport or approval', async () => {
  const { lead, former, wiresA } = fixture();
  const initial = await lead.send({ to: b, subject: 'Old', text: 'Discuss review' });
  former.receive(a, wiresA[0]);
  const sizeBefore = wiresA.length;
  const missing = randomUUID();
  for (const input of [
    { to: b, subject: 'New', text: 'Brief', handoverFrom: missing },
    { to: b, subject: 'New', text: 'Brief', handoverFrom: initial.message.id },
  ]) await assert.rejects(lead.send(input), /CONTEXT_LOST/);
  assert.equal(wiresA.length, sizeBefore, 'invalid source cannot contact target');

  // A report reply cannot be a new handover.
  const reply = await former.send({ respondTo: former.entry(initial.message.id)!.returnHandle!, text: 'Question?' });
  const input = { respondTo: randomUUID(), text: 'Answer', handoverFrom: initial.message.exchange };
  assert.throws(() => validate(MessageInput, input), /handoverFrom/);
  assert.throws(() => validate(AskInput, { requests: [input] }), /handoverFrom/);
  assert.throws(() => validate(EnvelopeSchema, { ...wiresA[0], id: randomUUID(),
    handoverFrom: initial.message.exchange, replyTo: reply.message.id }), /handover/);

  // Source metadata received from an unapproved colleague is not automatically
  // usable as a handover source by the lead's agent.
  const stranger = new Runtime(a, async () => { assert.fail('must not send'); return { outcome: 'accepted' }; });
  stranger.approveFromOwner(approved(c));
  const incoming = { id: randomUUID(), exchange: randomUUID(), subject: 'Private', text: 'Unapproved',
    refs: [], replyTo: null, corrects: null, createdAt: new Date().toISOString() };
  stranger.receive(b, incoming);
  await assert.rejects(stranger.send({
    to: c, subject: 'Attempted handover', text: 'Do not expose unknown exchange',
    handoverFrom: incoming.exchange,
  }), /CONTEXT_LOST/);
  assert.equal(stranger.inspect({ queue: 'self' }).items[0].evidence, 'withheld');
});

test('ordinary messages, reply forms, unknown old wire and batched asks remain compatible', async () => {
  const { lead, former, wiresA } = fixture();
  validate(MessageInput, { to: b, subject: 'Request', text: 'Ordinary' });
  validate(AskInput, { requests: [{ to: b, subject: 'New', text: 'Authored',
    handoverFrom: randomUUID() }] });
  const ordinary = await lead.send({ to: b, subject: 'Ordinary', text: 'No metadata' });
  assert.equal(ordinary.message.handoverFrom, undefined);
  former.receive(a, wiresA[0]);
  const handle = former.entry(ordinary.message.id)!.returnHandle!;
  const answered = await former.send({ respondTo: handle, text: 'Plain reply' });
  assert.equal(answered.message.handoverFrom, undefined);
  assert.equal(wiresA[0].handoverFrom, undefined);
  validate(EnvelopeSchema, wiresA[0]);

  // A recipient may not verify a sender's former exchange: it is a pointer,
  // not a foreign-session read or a claim that records were restored.
  const successor = new Runtime(c, async () => ({ outcome: 'accepted' }));
  successor.approveFromOwner(approved(a));
  const external = { ...wiresA[0], id: randomUUID(), exchange: randomUUID(),
    handoverFrom: randomUUID(), replyTo: null };
  successor.receive(a, external);
  const seen: any = successor.inspect({ message: external.id });
  assert.equal(seen.message.handoverFrom, external.handoverFrom);
  assert.equal(seen.linkage, undefined, 'sender-supplied provenance does not imply missing reply linkage');
});
