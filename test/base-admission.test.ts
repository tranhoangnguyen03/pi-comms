import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';

test('inspection preserves authorized history but withholds new revoked content and handles', () => {
  const self = randomUUID(), peer = randomUUID();
  const runtime = new Runtime(self, async () => ({ outcome: 'accepted' }));
  const envelope = { id: randomUUID(), exchange: randomUUID(), subject: 'PRIVATE_SUBJECT', text: 'PRIVATE_BODY', refs: [{ uri: 'file:///PRIVATE_URI', label: 'PRIVATE_LABEL' }], replyTo: null, corrects: null, createdAt: new Date().toISOString() };
  runtime.receive(peer, envelope);
  const handle = runtime.entry(envelope.id)!.returnHandle!;
  for (const input of [{ queue: 'self' as const }, { message: envelope.id }, { exchange: envelope.exchange }, {}, { peer }]) {
    const hidden = JSON.stringify(runtime.inspect(input));
    for (const secret of ['PRIVATE_', handle]) assert.ok(!hidden.includes(secret), `agent projection leaked ${secret}`);
    assert.match(hidden, /CONTACT_NOT_APPROVED/);
    const human = JSON.stringify(runtime.inspect(input, 'human'));
    assert.match(human, /PRIVATE_BODY/);
    if ('message' in input || 'exchange' in input || 'queue' in input) assert.ok(human.includes(handle));
  }
  runtime.approve({ id: peer, name: 'Reviewer', context: 'review' });
  assert.match(JSON.stringify(runtime.inspect({ message: envelope.id })), /PRIVATE_BODY/);
  runtime.unapprove(peer);
  for (const input of [{ message: envelope.id }, { exchange: envelope.exchange }, {}, { peer }]) {
    assert.match(JSON.stringify(runtime.inspect(input)), /PRIVATE_BODY/, 'revocation does not erase already authorized history');
  }
  assert.deepEqual(runtime.eligible(), [], 'historical readability does not authorize a new model admission');

  const fresh = { ...envelope, id: randomUUID(), exchange: randomUUID(), subject: 'NEW_WITHHELD_SUBJECT', text: 'NEW_WITHHELD_BODY', refs: [] };
  runtime.receive(peer, fresh);
  const freshHandle = runtime.entry(fresh.id)!.returnHandle!;
  for (const input of [{ message: fresh.id }, { exchange: fresh.exchange }, { queue: 'self' as const }, {}, { peer }]) {
    const hidden = JSON.stringify(runtime.inspect(input));
    assert.doesNotMatch(hidden, /NEW_WITHHELD/);
    assert.ok(!hidden.includes(freshHandle));
    assert.match(JSON.stringify(runtime.inspect(input, 'human')), /NEW_WITHHELD_BODY/);
  }
  assert.equal(runtime.isApproved(peer), false);
  assert.deepEqual(runtime.eligible(), []);
});
