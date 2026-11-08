import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PairApprovalStore, pairKey } from '../src/transport/broker/pair-approvals.ts';

const tempRoot = (t: { after: (fn: () => void) => void }, name: string) => {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('F11: one unordered A-B approval survives restart; either endpoint can end it', t => {
  const root = tempRoot(t, 'pair-store-');
  const a = randomUUID(), b = randomUUID(), fork = randomUUID();
  const runtimes = new Map([[a, 'ra'], [b, 'rb'], [fork, 'rf']]);
  const rt = (id: string) => runtimes.get(id);
  const pairs = new PairApprovalStore(root);
  assert.equal(pairKey(undefined, a, b), pairKey(undefined, b, a));
  assert.equal(pairs.state(undefined, a, b).mode, 'none');
  pairs.decide(undefined, a, b, 'remembered', 'Review', rt);
  assert.equal(pairs.state(undefined, b, a).mode, 'remembered');
  assert.equal(new PairApprovalStore(root).state(undefined, b, a).mode, 'remembered');
  assert.equal(pairs.state(undefined, a, fork).mode, 'none', 'a fork inherits nothing');
  assert.equal(pairs.state('different-scope', b, a).mode, 'none');
  pairs.decide(undefined, b, a, 'none', '', rt);
  assert.equal(new PairApprovalStore(root).state(undefined, a, b).mode, 'none', 'ending is durable from either side');
  pairs.decide(undefined, a, b, 'remembered', 'Approved again', rt);
  assert.equal(new PairApprovalStore(root).state(undefined, b, a).mode, 'remembered', 'no stored refusal blocks a new approval');
});

test('F11: session-only approval follows the Pi runtime, not the socket, and never touches disk', t => {
  const root = tempRoot(t, 'pair-session-');
  const a = randomUUID(), b = randomUUID();
  const rt = (id: string) => (id === a ? 'ra' : 'rb');
  const pairs = new PairApprovalStore(root);
  pairs.decide(undefined, a, b, 'session', 'Review', rt);
  assert.deepEqual(readdirSync(root), [], 'session-only approval writes nothing');
  assert.equal(new PairApprovalStore(root).state(undefined, a, b).mode, 'none', 'broker restart ends session-only approval');
  assert.deepEqual(pairs.expireSession(undefined, b, 'rb'), [], 'same runtime reconnecting keeps it');
  assert.equal(pairs.state(undefined, a, b).mode, 'session');
  assert.deepEqual(pairs.expireSession(undefined, b, 'rb-reloaded'), [a], 'a new runtime ends it');
  assert.equal(pairs.state(undefined, a, b).mode, 'none');
  pairs.decide(undefined, a, b, 'remembered', 'Remembered', rt);
  pairs.decide(undefined, b, a, 'session', 'Now session-only', rt);
  assert.equal(new PairApprovalStore(root).state(undefined, a, b).mode, 'none', 'downgrade to session-only removes the remembered record');
});

test('F11: ended and session-only pairs leave no records behind', t => {
  const root = tempRoot(t, 'pair-growth-');
  const pairs = new PairApprovalStore(root);
  const rt = () => 'r';
  for (let i = 0; i < 20; i++) {
    const a = randomUUID(), b = randomUUID();
    pairs.decide(undefined, a, b, 'remembered', 'w', rt);
    pairs.decide(undefined, a, b, 'none', '', rt);
    pairs.decide(undefined, a, b, 'session', 'w', rt);
    pairs.expireSession(undefined, a);
  }
  assert.equal(JSON.parse(readFileSync(join(root, 'pair-approvals.json'), 'utf8')).pairs.length, 0);
});

test('F11: an unreadable file is kept aside and grants nothing; other approvals keep working', t => {
  const root = tempRoot(t, 'pair-torn-');
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const rt = () => 'r';
  new PairApprovalStore(root).decide(undefined, a, b, 'remembered', 'Older grant', rt);
  const file = join(root, 'pair-approvals.json');
  writeFileSync(file, readFileSync(file, 'utf8').slice(0, 31)); // Torn write.
  const recovered = new PairApprovalStore(root);
  assert.match(recovered.recovered ?? '', /moved to .*unreadable/);
  assert.equal(recovered.state(undefined, a, b).mode, 'none');
  assert.ok(readdirSync(root).some(name => name.startsWith('pair-approvals.json.unreadable-')), 'evidence is preserved');
  recovered.decide(undefined, a, c, 'remembered', 'New grant', rt);
  assert.equal(new PairApprovalStore(root).state(undefined, c, a).mode, 'remembered');
});

test('F11: a failed save rejects only that decision and keeps earlier state', { skip: process.getuid?.() === 0 }, t => {
  const root = tempRoot(t, 'pair-fail-');
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const rt = () => 'r';
  const pairs = new PairApprovalStore(root);
  pairs.decide(undefined, a, b, 'remembered', 'Saved', rt);
  chmodSync(root, 0o500);
  assert.throws(() => pairs.decide(undefined, a, c, 'remembered', 'Cannot save', rt));
  assert.equal(pairs.state(undefined, a, c).mode, 'none');
  assert.equal(pairs.state(undefined, a, b).mode, 'remembered', 'earlier approval unaffected');
  pairs.decide(undefined, a, c, 'session', 'Session-only still works', rt);
  assert.equal(pairs.state(undefined, a, c).mode, 'session');
  chmodSync(root, 0o700);
  pairs.decide(undefined, a, c, 'remembered', 'Saved after repair', rt);
  assert.equal(new PairApprovalStore(root).state(undefined, a, c).mode, 'remembered');
});
