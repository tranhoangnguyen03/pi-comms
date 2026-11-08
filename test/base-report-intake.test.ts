import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { modelView } from '../src/model-view.ts';
import { observationLabel } from '../src/communication-view.ts';

const self = randomUUID(), peer = randomUUID(), unapproved = randomUUID();
const approve = (id: string) => ({ id, name: 'Reviewer', context: 'Read-only review' });
function pair() {
  const outbound: any[] = [], inbound: any[] = [];
  const lead = new Runtime(self, async (_to, msg) => { outbound.push(msg); return { outcome: 'accepted' }; });
  const reviewer = new Runtime(peer, async (_to, msg) => { inbound.push(msg); return { outcome: 'accepted' }; });
  lead.approve(approve(peer)); reviewer.approve(approve(self));
  return { lead, reviewer, outbound, inbound };
}
async function start(lead: Runtime, reviewer: Runtime, outbound: any[]) {
  const request = await lead.send({ to: peer, subject: 'Retry review', text: 'Check retry safety', workRef: 'AUTH-42' });
  reviewer.receive(self, outbound.at(-1)!);
  return { id: request.message.id, replyHandle: reviewer.entry(request.message.id)!.returnHandle! };
}
async function report(reviewer: Runtime, lead: Runtime, inbound: any[], handle: string, id: string,
  state: 'progress' | 'needs-input' | 'blocked' | 'complete', text: string) {
  const sent = await reviewer.send({ respondTo: handle, text, report: { request: id, state } });
  lead.receive(peer, inbound.at(-1)!);
  return sent;
}

test('progress remains inspectable without creating a model turn; completion includes history', async () => {
  const { lead, reviewer, outbound, inbound } = pair();
  const { id, replyHandle } = await start(lead, reviewer, outbound);
  const progress = await report(reviewer, lead, inbound, replyHandle, id, 'progress', 'HALFWAY_DETAIL');
  const plan = lead.planIntake(lead.eligible());
  assert.equal(plan.deliver.length, 0, 'progress alone should not wake the model');
  assert.deepEqual(plan.summarized, [progress.message.id]);
  lead.summarized(plan.summarized);
  assert.deepEqual(lead.waiting, []);
  const progressRecord = lead.inspect({ message: progress.message.id }) as any;
  assert.equal(progressRecord.message.text, 'HALFWAY_DETAIL');
  assert.match(observationLabel(progressRecord), /not posted to Pi/);
  assert.equal((lead.inspect({ requests: [id] }) as any).responses[0].latestReport.message.report.state, 'progress');

  const complete = await report(reviewer, lead, inbound, replyHandle, id, 'complete', 'FINAL_FINDING');
  const next = lead.planIntake(lead.eligible());
  assert.deepEqual(next.deliver.map(e => e.message.id), [complete.message.id]);
  assert.deepEqual(next.summarized, []);
  assert.match(lead.reportNote(next.deliver[0]), /1 earlier progress report/);
  lead.posted(next.deliver.map(e => e.message.id));
  const row: any = lead.inspect({ requests: [id] }).responses[0];
  assert.equal(row.reportCount, 2);
  assert.equal(row.latestReport.message.id, complete.message.id);
  assert.equal(row.currentReport.message.id, complete.message.id);
  assert.equal(row.currentReport.message.report.state, 'complete');
  assert.match(modelView(lead.inspect({ requests: [id] }), () => 'Reviewer'), /Peer reports complete/);
});

test('delayed progress cannot replace completion in request inspection or overview', async () => {
  const { lead, reviewer, outbound, inbound } = pair();
  const { id, replyHandle } = await start(lead, reviewer, outbound);
  const complete = await report(reviewer, lead, inbound, replyHandle, id, 'complete', 'CONFIRMED_DONE');
  lead.posted(lead.planIntake(lead.eligible()).deliver.map(e => e.message.id));
  const late = await report(reviewer, lead, inbound, replyHandle, id, 'progress', 'STALE_PROGRESS');
  const plan = lead.planIntake(lead.eligible());
  assert.deepEqual(plan.deliver, []);
  assert.deepEqual(plan.summarized, [late.message.id]);
  lead.summarized(plan.summarized);

  const row: any = lead.inspect({ requests: [id] }).responses[0];
  assert.equal(row.latestReport.message.id, late.message.id, 'last received report remains visible in raw history');
  assert.equal(row.currentReport.message.id, complete.message.id, 'current actionable peer claim remains complete');
  assert.equal(row.laterProgressCount, 1);
  const summary = modelView(lead.inspect({ requests: [id] }), () => 'Reviewer');
  assert.match(summary, /Peer reports complete/);
  assert.match(summary, /1 later progress update/);
  assert.doesNotMatch(summary, /Peer reports progress \(current reported state\)/);
  const overview: any = lead.inspect({ peer });
  assert.equal(overview.items[0].latestMessage, complete.message.id, 'conversation preview must not regress to late progress');
  const historical: any = lead.inspect({ message: late.message.id });
  assert.equal(historical.message.text, 'STALE_PROGRESS');
  assert.match(observationLabel(historical), /not posted/);
});

test('a later blocked correction stays actionable and supersedes an earlier completion', async () => {
  const { lead, reviewer, outbound, inbound } = pair();
  const { id, replyHandle } = await start(lead, reviewer, outbound);
  await report(reviewer, lead, inbound, replyHandle, id, 'progress', 'Early check');
  lead.summarized(lead.planIntake(lead.eligible()).summarized);
  const done = await report(reviewer, lead, inbound, replyHandle, id, 'complete', 'First conclusion');
  lead.posted(lead.planIntake(lead.eligible()).deliver.map(e => e.message.id));
  const correction = await report(reviewer, lead, inbound, replyHandle, id, 'blocked', 'Missing a required test');
  const planned = lead.planIntake(lead.eligible());
  assert.deepEqual(planned.deliver.map(e => e.message.id), [correction.message.id]);
  assert.match(lead.reportNote(planned.deliver[0]), /earlier peer state: complete/);
  lead.posted(planned.deliver.map(e => e.message.id));
  const row: any = lead.inspect({ requests: [id] }).responses[0];
  assert.equal(row.currentReport.message.id, correction.message.id);
  assert.equal(row.currentReport.message.report.state, 'blocked');
  assert.equal(row.reportCount, 3);
  assert.equal((lead.inspect({ message: done.message.id }) as any).message.report.state, 'complete');
});

test('sender-side progress remains a conversation preview without an actionable local report', async () => {
  const { lead, reviewer, outbound } = pair();
  const { id, replyHandle } = await start(lead, reviewer, outbound);
  const progress = await reviewer.send({
    respondTo: replyHandle, text: 'Review halfway, evidence to follow',
    report: { request: id, state: 'progress' },
  });
  const peerView: any = reviewer.inspect({ peer: self });
  assert.equal(peerView.items[0].latestMessage, progress.message.id,
    'the sender must see its latest outgoing progress instead of the older request');
  assert.match(peerView.items[0].preview, /Review halfway/);
  const overview: any = reviewer.inspect({});
  assert.equal(overview.recentExchanges[0].latestMessage, progress.message.id);
});

test('unverified progress-only exchange remains discoverable in the overview', () => {
  const runtime = new Runtime(self, async () => ({ outcome: 'accepted' }));
  runtime.approve(approve(peer));
  const orphan = {
    id: randomUUID(), exchange: randomUUID(), subject: 'Earlier context lost',
    text: 'Progress with lost original request', refs: [], replyTo: randomUUID(),
    corrects: null, createdAt: new Date().toISOString(),
    report: { request: randomUUID(), state: 'progress' as const },
  };
  runtime.receive(peer, orphan);
  assert.equal((runtime.inspect({ message: orphan.id }) as any).reportLinkage, 'context-lost');
  const overview: any = runtime.inspect({});
  assert.equal(overview.recentExchanges.length, 1,
    'an unknown original request does not justify hiding the only exchange');
  assert.equal(overview.recentExchanges[0].latestMessage, orphan.id);
  assert.match(overview.recentExchanges[0].preview, /Progress with lost/);
  assert.equal((runtime.inspect({ peer })).items[0].latestMessage, orphan.id);
});

test('explicit progress correction reaches the requester after the corrected result was already posted', async () => {
  const { lead, reviewer, outbound, inbound } = pair();
  const { id, replyHandle } = await start(lead, reviewer, outbound);
  const prior = await report(reviewer, lead, inbound, replyHandle, id, 'complete', 'Previous evidence');
  lead.posted(lead.planIntake(lead.eligible()).deliver.map(e => e.message.id));
  assert.equal(lead.waiting.includes(prior.message.id), false, 'the old conclusion has already been delivered');

  const corrected = await reviewer.send({
    respondTo: replyHandle,
    text: 'Previous evidence is wrong; still investigating.',
    report: { request: id, state: 'progress' },
    corrects: prior.message.id,
  });
  lead.receive(peer, inbound.at(-1)!);
  const plan = lead.planIntake(lead.eligible());
  assert.deepEqual(plan.deliver.map(e => e.message.id), [corrected.message.id],
    'an explicit correction is actionable despite a progress work state');
  assert.deepEqual(plan.summarized, []);
  assert.match(lead.reportNote(plan.deliver[0]), /earlier peer state: complete/);
  lead.posted(plan.deliver.map(e => e.message.id));
  const row: any = lead.inspect({ requests: [id] }).responses[0];
  assert.equal(row.latestReport.message.id, corrected.message.id);
  assert.equal(row.currentReport.message.id, corrected.message.id,
    'the correction must retract the earlier complete status for inspection');
  assert.equal(row.currentReport.message.report.state, 'progress');
  assert.equal((lead.inspect({ peer }) as any).items[0].latestMessage, corrected.message.id);

  const stale = await report(reviewer, lead, inbound, replyHandle, id, 'progress', 'Uncorrected older progress');
  const stalePlan = lead.planIntake(lead.eligible());
  assert.deepEqual(stalePlan.deliver, []);
  assert.deepEqual(stalePlan.summarized, [stale.message.id]);
  lead.summarized(stalePlan.summarized);
  const current: any = lead.inspect({ requests: [id] }).responses[0];
  assert.equal(current.currentReport.message.id, corrected.message.id,
    'a late ordinary progress update must not undo the explicit correction');
  assert.equal(current.laterProgressCount, 1);
});

test('plain replies and requests for input are never swallowed by report grouping', async () => {
  const { lead, reviewer, outbound, inbound } = pair();
  const { id, replyHandle } = await start(lead, reviewer, outbound);
  const plain = await reviewer.send({ respondTo: replyHandle, text: 'Do retries cover writes?' });
  lead.receive(peer, inbound.at(-1)!);
  const asking = await report(reviewer, lead, inbound, replyHandle, id, 'needs-input', 'Please confirm retry scope');
  const update = await report(reviewer, lead, inbound, replyHandle, id, 'progress', 'Halfway through checks');
  const plan = lead.planIntake(lead.eligible());
  assert.deepEqual(plan.deliver.map(e => e.message.id), [plain.message.id, asking.message.id]);
  assert.deepEqual(plan.summarized, [update.message.id]);
  lead.posted(plan.deliver.map(e => e.message.id));
  lead.summarized(plan.summarized);
  assert.deepEqual(lead.waiting, []);
  assert.equal((lead.inspect({ requests: [id] }) as any).responses[0].currentReport.message.report.state, 'needs-input');
});

test('unapproved progress and reports with missing links keep human-visible original records', () => {
  const lead = new Runtime(self, async () => ({ outcome: 'accepted' }));
  const entry = { id: randomUUID(), exchange: randomUUID(), subject: 'PRIVATE_SUBJECT',
    text: 'PRIVATE_REPORT', refs: [], replyTo: randomUUID(), corrects: null,
    report: { request: randomUUID(), state: 'progress' }, createdAt: new Date().toISOString() };
  lead.receive(unapproved, entry);
  assert.deepEqual(lead.eligible(), []);
  assert.deepEqual(lead.planIntake([entry.id]).deliver, []);
  assert.deepEqual(lead.planIntake([entry.id]).summarized, []);
  assert.equal(JSON.stringify(lead.inspect({ queue: 'self' })).includes('PRIVATE_REPORT'), false);
  assert.match(JSON.stringify(lead.inspect({ queue: 'self' }, 'human')), /PRIVATE_REPORT/);
  lead.approve(approve(unapproved));
  const allowed = lead.planIntake(lead.eligible());
  assert.deepEqual(allowed.deliver.map(e => e.message.id), [entry.id],
    'an unverified report must be shown with its link warning, not silently grouped');
  assert.equal((lead.inspect({ message: entry.id }) as any).reportLinkage, 'context-lost');
});
