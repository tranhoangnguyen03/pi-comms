import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { MessageInput, EnvelopeSchema, validate } from '../src/schema.ts';
import { modelView } from '../src/model-view.ts';
import { inspectionText } from '../src/human-view.ts';
import { InlineCard } from '../src/inline-card.ts';

const a = randomUUID(), b = randomUUID(), c = randomUUID();
const approval = (id: string) => ({ id, name: 'Colleague', context: 'Review' });
const report = (request: string, state: 'progress' | 'needs-input' | 'blocked' | 'complete') => ({ request, state });

function pair() {
  const sentA: any[] = [], sentB: any[] = [];
  const lead = new Runtime(a, async (_to, envelope) => { sentA.push(envelope); return { outcome: 'accepted' }; });
  const reviewer = new Runtime(b, async (_to, envelope) => { sentB.push(envelope); return { outcome: 'accepted' }; });
  lead.approveFromOwner(approval(b)); reviewer.approveFromOwner(approval(a));
  return { lead, reviewer, sentA, sentB };
}

test('structured data is optional JSON object; work reports require an exact reply and known state', () => {
  const handle = randomUUID(), id = randomUUID();
  validate(MessageInput, { to: b, subject: 'Review', text: 'Check this', structured: { flags: ['a', 'b'], count: 2, passing: true } });
  validate(MessageInput, { respondTo: handle, text: 'Need input', report: report(id, 'needs-input') });
  validate(MessageInput, { respondTo: handle, text: 'Done', report: report(id, 'complete'), structured: { tests: true } });
  validate(MessageInput, { respondTo: handle, text: 'Plain reply' });
  for (const input of [
    { to: b, subject: 'Review', text: 'no reply', report: report(id, 'complete') },
    { respondTo: handle, text: 'bad request', report: { request: 'not-a-uuid', state: 'complete' } },
    { respondTo: handle, text: 'bad state', report: { request: id, state: 'approved' } },
    { respondTo: handle, text: 'extra authority', report: { request: id, state: 'complete', accepted: true } },
    { respondTo: handle, text: 'wrong structure', structured: 12 },
    { respondTo: handle, text: 'wrong structure', structured: ['not', 'an', 'object'] },
  ]) assert.throws(() => validate(MessageInput, input), /INVALID_INPUT/);
});

test('rejects non-JSON nested structured values before sending or recording messages', async () => {
  let transports = 0;
  const runtime = new Runtime(a, async () => { transports++; return { outcome: 'accepted' }; });
  runtime.approveFromOwner(approval(b));

  const nestedOverflow = JSON.parse('{"metrics":{"count":1e400}}');
  assert.equal(nestedOverflow.metrics.count, Infinity, 'parsed JSON may contain non-finite JS numbers');
  const sparse = [1, , 3];
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const invalid: unknown[] = [
    nestedOverflow, { count: Number.NaN }, { count: -Infinity }, { metrics: [0, Infinity] },
    { items: [true, undefined] }, { items: sparse }, { missing: undefined },
    { count: 12n }, { handler: () => 1 }, { when: new Date() }, circular,
  ];
  for (const structured of invalid) {
    await assert.rejects(
      runtime.send({ to: b, subject: 'Payload fidelity', text: 'Check this', structured } as any),
      /INVALID_INPUT: structured must contain only JSON values with finite numbers/,
    );
  }
  await assert.rejects(
    runtime.send({ to: b, subject: 'Payload fidelity', text: 'Check explicit missing value', structured: undefined } as any),
    /INVALID_INPUT: structured must contain only JSON values with finite numbers/,
  );
  assert.equal(transports, 0, 'validation must reject before invoking transport');
  assert.deepEqual(runtime.inspect({ outbox: 'self' }).items, [], 'invalid data must not create outbox records');

  const valid = { metrics: { count: 14, passed: true, details: ['one', null, { depth: [1.25] }] } };
  const sent = await runtime.send({ to: b, subject: 'Valid JSON', text: 'Details', structured: valid });
  assert.deepEqual(sent.message.structured, valid);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.message.structured)), valid);
  assert.equal(transports, 1, 'valid nested data still sends normally');

  const incoming = { id: randomUUID(), exchange: randomUUID(), subject: 'Incoming',
    text: 'Bad wire value', refs: [], replyTo: null, corrects: null,
    createdAt: new Date().toISOString(), structured: nestedOverflow };
  const receiver = new Runtime(b, async () => ({ outcome: 'accepted' }));
  assert.throws(() => receiver.receive(a, incoming), /INVALID_INPUT: structured/);
  assert.deepEqual(receiver.waiting, [], 'invalid inbound data must not enter the receiver queue');
});

test('final work report can refer to original request after clarification rounds', async () => {
  const { lead, reviewer, sentA, sentB } = pair();
  const request = await lead.send({ to: b, subject: 'Retry review', text: 'Check double writes', workRef: 'AUTH-42' });
  reviewer.receive(a, sentA[0]);
  const requestHandle = reviewer.entry(request.message.id)!.returnHandle!;

  const question = await reviewer.send({ respondTo: requestHandle, text: 'Should retry apply to writes?' });
  lead.receive(b, sentB[0]);
  const answer = await lead.send({ respondTo: lead.entry(question.message.id)!.returnHandle!, text: 'No. Only safe reads.' });
  reviewer.receive(a, sentA[1]);

  const evidence = { files_changed: [], tests_passing: true, findings: [{ file: 'src/auth.ts', line: 42 }] };
  const final = await reviewer.send({
    respondTo: reviewer.entry(answer.message.id)!.returnHandle!,
    text: 'Found the risky retry. Patch is recommended.',
    report: report(request.message.id, 'complete'), structured: evidence,
  });
  assert.equal(final.message.report?.request, request.message.id);
  assert.equal(final.message.workRef, 'AUTH-42');
  assert.equal(final.message.structured?.tests_passing, true);
  assert.equal(sentB[1].replyTo, answer.message.id, 'report can answer later clarification but refer to original request');
  validate(EnvelopeSchema, sentB[1]);
  lead.receive(b, sentB[1]);

  const row: any = lead.inspect({ requests: [request.message.id] }).responses[0];
  assert.equal(row.outcome, 'reply-received', 'first reply semantics remain intact');
  assert.equal(row.responseCount, 1, 'exact direct replies remain distinct from later work reports');
  assert.equal(row.reportCount, 1);
  assert.equal(row.latestReport.message.id, final.message.id);
  assert.equal(row.latestReport.message.report.state, 'complete');
  assert.deepEqual(row.latestReport.message.structured, evidence);
  const rendered = modelView(lead.inspect({ requests: [request.message.id] }), id => id === b ? 'Reviewer' : 'Lead');
  assert.match(rendered, /Peer reports complete/);
  assert.match(rendered, /not requester acceptance/);
  assert.match(rendered, /tests_passing/);
  assert.match(rendered, /AUTH-42/);
  assert.ok(!('acceptedWork' in row), 'transport must not infer requester acceptance');

  await reviewer.send({
    respondTo: requestHandle, text: 'Correction: review is blocked by a missing test.',
    report: report(request.message.id, 'blocked'), structured: { missing: 'retry test' },
  });
  lead.receive(b, sentB[2]);
  const after: any = lead.inspect({ requests: [request.message.id] }).responses[0];
  assert.equal(after.reportCount, 2);
  assert.equal(after.latestReport.message.report.state, 'blocked', 'latest attributed report, not a completion oracle');
});

test('report links cannot cross peers or exchanges; uncertainty is preserved when request record is lost', async () => {
  const { lead, reviewer, sentA, sentB } = pair();
  const first = await lead.send({ to: b, subject: 'First', text: 'Review' });
  const other = await lead.send({ to: b, subject: 'Second', text: 'Separate' });
  reviewer.receive(a, sentA[0]); reviewer.receive(a, sentA[1]);

  const handle = reviewer.entry(first.message.id)!.returnHandle!;
  const priorCount = sentB.length;
  await assert.rejects(reviewer.send({ respondTo: handle, text: 'Not mine', report: report(other.message.id, 'complete') }), /work report/);
  await assert.rejects(reviewer.send({ respondTo: handle, text: 'Not known', report: report(randomUUID(), 'blocked') }), /work report/);
  assert.equal(sentB.length, priorCount, 'invalid reports never reach transport');

  const fake = {
    id: randomUUID(), exchange: first.message.exchange, subject: first.message.subject,
    text: 'Mislinked report', refs: [], replyTo: first.message.id, corrects: null,
    report: report(other.message.id, 'complete'), createdAt: new Date().toISOString(),
  };
  assert.throws(() => lead.receive(b, fake), /work report references/);
  // A peer that resumed without its original request record must not claim verified linkage.
  const restartedLead = new Runtime(a, async () => ({ outcome: 'accepted' }));
  restartedLead.receive(b, { ...fake, id: randomUUID(), report: report(randomUUID(), 'progress') });
  const orphan: any = restartedLead.inspect({ queue: 'self' }, 'human').items[0];
  assert.equal(orphan.reportLinkage, 'context-lost');
  const human = inspectionText(restartedLead.inspect({ queue: 'self' }, 'human'),
    { self: a, name: id => id === a ? 'Lead' : 'Reviewer', approved: () => false });
  assert.match(human, /link unverified/);
});

test('work reports stay withheld after revocation, while human views retain readable evidence', async () => {
  const { lead, reviewer, sentA, sentB } = pair();
  const req = await lead.send({ to: b, subject: 'Review', text: 'Please check' });
  reviewer.receive(a, sentA[0]);
  await reviewer.send({ respondTo: reviewer.entry(req.message.id)!.returnHandle!, text: 'Done',
    report: report(req.message.id, 'complete'), structured: { result: 'private finding' } });
  lead.receive(b, sentB[0]);
  const approved: any = lead.inspect({ requests: [req.message.id] }).responses[0];
  assert.equal(approved.reportCount, 1);
  lead.revokeFromOwner(b);
  const withheld: any = lead.inspect({ requests: [req.message.id] }).responses[0];
  assert.equal(withheld.reportCount, 0);
  assert.equal(withheld.latestReport, undefined);
  assert.doesNotMatch(modelView(lead.inspect({ requests: [req.message.id] }), () => 'Reviewer'), /private finding/);
  const human = inspectionText(lead.inspect({ message: sentB[0].id }, 'human'),
    { self: a, name: id => id === a ? 'Lead' : 'Reviewer', approved: () => false });
  assert.match(human, /Peer reports complete/);
  assert.match(human, /private finding/);
  assert.ok(lead.waiting.includes(sentB[0].id), 'read-only inspect does not admit held content');

  const card = new InlineCard([{ id: sentB[0].id, from: 'Reviewer', to: 'Lead', subject: 'Review',
    text: 'Done', report: report(req.message.id, 'complete'), structured: { result: 'private finding' },
    at: sentB[0].createdAt, exchange: sentB[0].exchange, fact: 'posted' }],
    { fg: (_: string, s: string) => s } as any, { expanded: false });
  const compact = card.render(100).join('\n');
  assert.match(compact, /Peer reports complete/);
  assert.match(compact, /private finding/);
});

test('report metadata shares the existing message size limit', async () => {
  const { lead, reviewer, sentA } = pair();
  const initial = await lead.send({ to: b, subject: 'Review', text: 'Read' });
  reviewer.receive(a, sentA[0]);
  const handle = reviewer.entry(initial.message.id)!.returnHandle!;
  await assert.rejects(reviewer.send({
    respondTo: handle, text: 'Details in attachment',
    structured: { excess: 'x'.repeat(901_000) },
    report: report(initial.message.id, 'progress'),
  }), /exceeds/);
});
