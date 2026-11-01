import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { MessageInput, InspectInput, EnvelopeSchema, validate } from '../src/schema.ts';
import { modelView } from '../src/model-view.ts';
import { inspectionText } from '../src/human-view.ts';
import { InlineCard } from '../src/inline-card.ts';

const a = randomUUID(), b = randomUUID(), c = randomUUID();
const approved = (id: string) => ({ id, name: 'Colleague', context: 'Review only' });
const incoming = (workRef: string, recipientLabel?: string) => ({
  id: randomUUID(), exchange: randomUUID(), subject: 'Request', text: 'Review this',
  refs: [], replyTo: null, corrects: null, createdAt: new Date().toISOString(),
  workRef, ...(recipientLabel ? { recipientLabel } : {}),
});

test('work references and recipient labels are bounded, optional, and never change routing authority', () => {
  validate(MessageInput, { to: b, subject: 'Check', text: 'Read it', workRef: 'AUTH-42', recipientLabel: 'Security reviewer' });
  validate(MessageInput, { to: b, subject: 'Check', text: 'Read it' });
  validate(InspectInput, { workRef: 'AUTH-42' });
  validate(InspectInput, { workRef: 'AUTH-42', cursor: randomUUID() });
  for (const input of [
    { to: b, subject: 'Check', text: 'Read it', workRef: ' ' },
    { to: b, subject: 'Check', text: 'Read it', workRef: 'x'.repeat(121) },
    { to: b, subject: 'Check', text: 'Read it', recipientLabel: 'x'.repeat(121) },
    { respondTo: randomUUID(), text: 'Answer', workRef: 'AUTH-42' },
    { respondTo: randomUUID(), text: 'Answer', recipientLabel: 'Security reviewer' },
  ]) assert.throws(() => validate(MessageInput, input), /INVALID_INPUT/);
  assert.throws(() => validate(InspectInput, { workRef: 'AUTH-42', peer: b }), /INVALID_INPUT/);
  assert.throws(() => validate(InspectInput, { workRef: 'AUTH-42', requests: [randomUUID()] }), /INVALID_INPUT/);
});

test('a request labels its exact recipient; linked replies inherit only the work reference', async () => {
  const firstWire: any[] = [], secondWire: any[] = [];
  const lead = new Runtime(a, async (_to, msg) => { firstWire.push(msg); return { outcome: 'accepted' }; });
  const reviewer = new Runtime(b, async (_to, msg) => { secondWire.push(msg); return { outcome: 'accepted' }; });
  lead.approveFromOwner(approved(b)); reviewer.approveFromOwner(approved(a));

  const request = await lead.send({ to: b, subject: 'Security', text: 'Review AUTH-42', workRef: 'AUTH-42', recipientLabel: 'Security reviewer' });
  validate(EnvelopeSchema, firstWire[0]);
  assert.equal(firstWire[0].workRef, 'AUTH-42');
  assert.equal(firstWire[0].recipientLabel, 'Security reviewer');
  assert.equal(reviewer.receive(a, firstWire[0]), true);

  const handle = reviewer.entry(request.message.id)!.returnHandle!;
  const reply = await reviewer.send({ respondTo: handle, text: 'Need a clarification' });
  assert.equal(secondWire[0].workRef, 'AUTH-42');
  assert.equal(secondWire[0].recipientLabel, undefined, 'recipient labels belong to the initial request');
  assert.equal(lead.receive(b, secondWire[0]), true);

  const followup = await lead.send({ respondTo: lead.entry(reply.message.id)!.returnHandle!, text: 'Only idempotent operations' });
  assert.equal(firstWire[1].workRef, 'AUTH-42');
  assert.equal(firstWire[1].recipientLabel, undefined);
  reviewer.receive(a, firstWire[1]);

  await reviewer.send({ respondTo: handle, text: 'Finding after clarification' });
  lead.receive(b, secondWire[1]);
  assert.equal(lead.inspect({ requests: [request.message.id] }).responses[0].workRef, 'AUTH-42');
  assert.equal(lead.inspect({ workRef: 'AUTH-42' }).items.length, 1);
  assert.equal(lead.inspect({ workRef: 'AUTH-4' }).items.length, 0);
  assert.equal(lead.inspect({ exchange: request.message.exchange }).items.length, 4);

  const row: any = lead.inspect({ workRef: 'AUTH-42' }).items[0];
  assert.equal(row.recipientLabel, 'Security reviewer');
  assert.equal(row.labeledSession, b);
  assert.equal(row.labelSource, 'sender-supplied');
  assert.equal(row.workRef, 'AUTH-42');

  const second = await lead.send({ to: b, subject: 'Recovery', text: 'Review AUTH-43', workRef: 'AUTH-43', recipientLabel: 'Recovery reviewer' });
  assert.notEqual(second.message.exchange, request.message.exchange);
  assert.deepEqual(lead.peerLabels(b).map(p => [p.workRef, p.label, p.source]),
    [['AUTH-43', 'Recovery reviewer', 'sender-supplied'], ['AUTH-42', 'Security reviewer', 'sender-supplied']]);

  const legacy = await lead.send({ to: b, subject: 'Unscoped', text: 'Ordinary message' });
  assert.equal(legacy.message.workRef, undefined);
  assert.equal(legacy.message.recipientLabel, undefined);

  assert.throws(() => lead.receive(b, { ...secondWire[0], id: randomUUID(), workRef: 'OTHER' }), /work reference/);
  assert.throws(() => lead.receive(b, { ...secondWire[0], id: randomUUID(), recipientLabel: 'Lead' }), /recipient label/);
});

test('work-filter inspection cannot reveal unapproved metadata or create a peer label', () => {
  const runtime = new Runtime(a, async () => ({ outcome: 'accepted' }));
  const secret = incoming('SECRET-42', 'Owner');
  runtime.receive(c, secret);
  const agent: any = runtime.inspect({ workRef: 'SECRET-42' });
  const human: any = runtime.inspect({ workRef: 'SECRET-42' }, 'human');
  assert.deepEqual(agent.items, []);
  assert.equal(human.items.length, 1);
  assert.equal(human.items[0].workRef, 'SECRET-42');
  assert.equal(runtime.peerLabels(c).length, 0);
  const masked: any = runtime.inspect({ peer: c });
  assert.equal(masked.items[0].workRef, undefined);
  assert.equal(masked.items[0].recipientLabel, undefined);
  assert.equal(masked.items[0].code, 'CONTACT_NOT_APPROVED');
  assert.equal(runtime.waiting.length, 1, 'inspection must not admit messages');

  runtime.approveFromOwner(approved(c));
  assert.equal(runtime.inspect({ workRef: 'SECRET-42' }).items.length, 1);
});

test('human and model displays explain work and sender-supplied labels without treating them as authority', async () => {
  const runtime = new Runtime(b, async () => ({ outcome: 'accepted' }));
  runtime.receive(a, incoming('AUTH-42', 'Security reviewer'));
  runtime.approveFromOwner(approved(a));
  const entry: any = runtime.inspect({ queue: 'self' });
  const model = modelView(entry, id => id === a ? 'Lead' : 'Reviewer');
  assert.match(model, /Work: AUTH-42/);
  assert.match(model, /Recipient label \(sender-supplied, not authority\): Security reviewer/);
  const human = inspectionText(entry, { self: b, name: id => id === a ? 'Lead' : 'Reviewer', approved: () => true });
  assert.match(human, /Work: AUTH-42/);
  assert.match(human, /Security reviewer/);

  const card = new InlineCard([{
    id: randomUUID(), exchange: randomUUID(), from: 'Lead', to: 'Reviewer', subject: 'Review',
    text: 'Find the issue', workRef: 'AUTH-42', recipientLabel: 'Security reviewer',
    at: new Date().toISOString(), fact: 'posted',
  }], { fg: (_key: string, value: string) => value } as any, { expanded: false });
  const visible = card.render(120).join('\n');
  assert.match(visible, /Work: AUTH-42/);
  assert.match(visible, /Security reviewer/);
});
