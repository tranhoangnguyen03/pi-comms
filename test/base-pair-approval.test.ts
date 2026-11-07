import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PairApprovalStore, pairKey } from '../src/transport/broker/pair-approvals.ts';

test('F11: one unordered A-B grant survives restart and either endpoint can revoke', t => {
  const root = mkdtempSync(join(tmpdir(), 'pair-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = randomUUID(), b = randomUUID(), fork = randomUUID(), third = randomUUID();
  const epochs = new Map([[a, 'a-live'], [b, 'b-live'], [fork, 'fork-live'], [third, 'c-live']]);
  const epoch = (id: string) => epochs.get(id);
  const pairs = new PairApprovalStore(root);
  assert.equal(pairKey(undefined, a, b), pairKey(undefined, b, a));
  assert.equal(pairs.state(undefined, a, b, epoch).mode, 'none');
  pairs.decide(undefined, a, b, 'remembered', 'Review', epoch);
  assert.equal(pairs.state(undefined, b, a, epoch).mode, 'remembered');
  assert.equal(new PairApprovalStore(root).state(undefined, b, a, epoch).mode, 'remembered');
  assert.equal(pairs.state(undefined, a, fork, epoch).mode, 'none');
  assert.equal(pairs.state('different-scope', b, a, epoch).mode, 'none');
  assert.equal(pairs.state(undefined, a, third, epoch).mode, 'none');
  pairs.decide(undefined, b, a, 'revoked', '', epoch);
  assert.equal(pairs.state(undefined, a, b, epoch).mode, 'revoked');
  assert.equal(new PairApprovalStore(root).state(undefined, b, a, epoch).mode, 'revoked',
    'revocation from either direction is one durable state');
  pairs.decide(undefined, a, b, 'remembered', 'Review after reapproval', epoch);
  assert.equal(new PairApprovalStore(root).state(undefined, b, a, epoch).mode, 'remembered');
});

test('F11: session-only pair ends when either side leaves and never becomes remembered', t => {
  const root = mkdtempSync(join(tmpdir(), 'pair-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = randomUUID(), b = randomUUID();
  const live = new Map([[a, 'a1'], [b, 'b1']]);
  const epoch = (id: string) => live.get(id);
  const pairs = new PairApprovalStore(root);
  pairs.decide(undefined, a, b, 'session', 'Review', epoch);
  assert.equal(pairs.state(undefined, b, a, epoch).mode, 'session');
  assert.equal(new PairApprovalStore(root).state(undefined, a, b, epoch).mode, 'none',
    'broker restart must expire a session-only grant');
  assert.deepEqual(pairs.expireSession(undefined, b), [a]);
  assert.equal(pairs.state(undefined, a, b, epoch).mode, 'none');
  pairs.decide(undefined, a, b, 'remembered', 'Old remembered', epoch);
  pairs.decide(undefined, b, a, 'session', 'Changed to session-only', epoch);
  assert.equal(new PairApprovalStore(root).state(undefined, a, b, epoch).mode, 'none',
    'a later session-only choice clears older remembered approval');
});

test('F11: invalid latest pair state cannot fall back to an earlier approved backup', t => {
  const root = mkdtempSync(join(tmpdir(), 'pair-torn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = randomUUID(), b = randomUUID(), epochs = new Map([[a, 'a'], [b, 'b']]);
  const epoch = (id: string) => epochs.get(id);
  const pairs = new PairApprovalStore(root);
  pairs.decide(undefined, a, b, 'remembered', 'Older grant', epoch);
  const file = join(root, 'pair-approvals.json');
  copyFileSync(file, file + '.bak');
  pairs.decide(undefined, b, a, 'revoked', '', epoch);
  assert.equal(new PairApprovalStore(root).state(undefined, a, b, epoch).mode, 'revoked');
  writeFileSync(file, readFileSync(file, 'utf8').slice(0, 31)); // Torn latest write.
  const damaged = new PairApprovalStore(root);
  assert.match(damaged.holdReason() ?? '', /PAIR_STATE_BLOCKED/);
  assert.throws(() => damaged.state(undefined, a, b, epoch), /PAIR_STATE_BLOCKED/);
  assert.throws(() => damaged.decide(undefined, a, b, 'remembered', 'retry', epoch), /PAIR_STATE_BLOCKED/);
});

test('F11: remembered pair state is scoped and has one serialized revision order', t => {
  const root = mkdtempSync(join(tmpdir(), 'pair-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = randomUUID(), b = randomUUID(), epoch = (id: string) => id === a ? 'a' : id === b ? 'b' : undefined;
  const store = new PairApprovalStore(root);
  const first = store.decide('local-workspace', a, b, 'remembered', 'first', epoch);
  const second = store.decide('local-workspace', b, a, 'revoked', '', epoch);
  assert.ok(second.revision > first.revision);
  assert.equal(store.state('local-workspace', a, b, epoch).mode, 'revoked');
  assert.equal(store.state('another-workspace', a, b, epoch).mode, 'none');
  const reopened = new PairApprovalStore(root);
  assert.equal(reopened.state('local-workspace', b, a, epoch).revision, second.revision);
  assert.equal(reopened.state('local-workspace', b, a, epoch).mode, 'revoked');
});
