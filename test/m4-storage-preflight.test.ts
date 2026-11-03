import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// Characterization of the pinned Pi host, NOT an implementation of M4.
// These tests deliberately expose limits that a native-session design must handle.
const kind = 'pi-comms-preflight-v1';
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-m4-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, manager: SessionManager.create(dir, join(dir, 'sessions')) };
}
function user(manager: SessionManager, text = 'Review this change') {
  return manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
}
function custom(manager: SessionManager) {
  return manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === kind);
}

test('M4 preflight: native custom data reopens without entering model context', t => {
  const { manager } = fixture(t);
  user(manager);
  const data = { ownerSessionId: manager.getSessionId(), message: 'WITHHELD_PRIVATE_PAYLOAD', visible: false };
  const id = manager.appendCustomEntry(kind, data);
  const file = manager.getSessionFile()!;
  assert.equal(existsSync(file), true);
  const reopened = SessionManager.open(file);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  const entry = reopened.getEntry(id);
  assert.equal(entry?.type, 'custom');
  if (entry?.type !== 'custom') assert.fail('Missing persisted custom entry');
  assert.deepEqual(entry.data, data);
  assert.equal(JSON.stringify(reopened.buildSessionContext().messages).includes('WITHHELD_PRIVATE_PAYLOAD'), false);
});

test('M4 preflight: an unused session buffers custom entries until a conversation exists', t => {
  const { manager } = fixture(t);
  manager.appendCustomEntry(kind, { pause: true });
  manager.appendCustomMessageEntry('comms_batch', 'Incoming message', true, { ids: ['m1'] });
  assert.equal(custom(manager).length, 1);
  const file = manager.getSessionFile()!;
  assert.equal(existsSync(file), false, 'A path or in-memory custom entry is not disk evidence');
  user(manager);
  assert.equal(existsSync(file), true);
  assert.equal(custom(SessionManager.open(file)).length, 1);
});

test('M4 preflight: ephemeral sessions support live state without a recovery file', () => {
  const manager = SessionManager.inMemory();
  user(manager);
  manager.appendCustomEntry(kind, { pause: true });
  assert.equal(manager.getSessionFile(), undefined);
  assert.equal(custom(manager).length, 1);
});

test('M4 preflight: tree navigation must not roll back external contact decisions', t => {
  const { manager } = fixture(t);
  const root = user(manager);
  manager.appendCustomEntry(kind, { ownerSessionId: manager.getSessionId(), decision: 'approve' });
  const revoke = manager.appendCustomEntry(kind, { ownerSessionId: manager.getSessionId(), decision: 'revoke' });
  manager.branch(root);
  user(manager, 'Continue on another branch');
  assert.equal(manager.getBranch().some(entry => entry.id === revoke), false);
  assert.equal(manager.getEntries().some(entry => entry.id === revoke), true);
  assert.equal(SessionManager.open(manager.getSessionFile()!).getEntries().some(entry => entry.id === revoke), true);
});

test('M4 preflight: native fork copies custom data but changes session identity', t => {
  const { manager } = fixture(t);
  user(manager);
  const original = manager.getSessionId();
  const id = manager.appendCustomEntry(kind, { ownerSessionId: original, decision: 'remember' });
  const file = manager.createBranchedSession(id)!;
  assert.notEqual(manager.getSessionId(), original);
  const reopened = SessionManager.open(file);
  const entry = reopened.getEntry(id);
  assert.equal(entry?.type, 'custom');
  if (entry?.type !== 'custom') assert.fail('Expected native fork to copy custom entries');
  assert.equal((entry.data as { ownerSessionId: string }).ownerSessionId, original);
  assert.notEqual((entry.data as { ownerSessionId: string }).ownerSessionId, reopened.getSessionId());
  // Future M4 restoration must ignore foreign-owner control/return-handle records.
  // This does not claim that pi-comms can remove transcript text copied by Pi itself.
});

test('M4 preflight: failed append can remain visible in memory without a disk commit', t => {
  const { manager } = fixture(t);
  user(manager);
  const file = manager.getSessionFile()!;
  const before = readFileSync(file, 'utf8');
  assert.ok(before.length > 0);
  // Replace only this disposable fixture's file with a directory to force a write failure.
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => manager.appendCustomEntry(kind, { decision: 'revoke' }));
  assert.equal(custom(manager).length, 1, 'getEntries alone cannot certify a successful write');
});

test('M4 preflight: host loader can skip a malformed tail without reporting it', t => {
  const { manager } = fixture(t);
  user(manager);
  const id = manager.appendCustomEntry(kind, { decision: 'approve' });
  const file = manager.getSessionFile()!;
  appendFileSync(file, '{"type":"custom","customType":"pi-comms-preflight-v1"');
  const reopened = SessionManager.open(file);
  assert.ok(reopened.getEntry(id));
  assert.equal(custom(reopened).length, 1);
  // A successful host load is not proof that the latest controlling decision survived.
});
