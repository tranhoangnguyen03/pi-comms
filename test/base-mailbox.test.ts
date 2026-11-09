import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const { spawnBrokerIfNeeded, getBrokerSpawnOptions } = await import('../src/transport/broker/spawn.ts');

const root = mkdtempSync(join(tmpdir(), 'pc-mailbox-'));
process.env.PI_CODING_AGENT_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const { IntercomClient } = await import('../src/transport/broker/client.ts');
const { DurableMailbox, MAIL_TTL_MS, MAIL_MAX_ITEMS, mailFingerprint } = await import('../src/transport/broker/mailbox-store.ts');
const { messageDeliveryFingerprint } = await import('../src/transport/broker/protocol.ts');
const brokerPath = fileURLToPath(new URL('../dist/transport/broker/broker.js', import.meta.url));
const waitFor = async (fn: () => boolean | Promise<boolean>, hint = 'mailbox', ms = 8000) => {
  const until = Date.now() + ms;
  while (!await fn()) {
    if (Date.now() > until) throw Error('F12 timed out: ' + hint);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function start() {
  const p = spawn(process.execPath, [brokerPath], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: string[] = [];
  p.stdout!.on('data', c => chunks.push(String(c)));
  p.stderr!.on('data', c => chunks.push(String(c)));
  await waitFor(() => chunks.join('').includes('Intercom broker started'), chunks.join(''));
  return p;
}
async function stop(p?: ChildProcess) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const exited = once(p, 'exit'); p.kill('SIGTERM'); await exited;
}
function reg(name: string, durableMailboxV1 = true) {
  return { name, cwd: root, model: 'fixture', pid: process.pid, startedAt: Date.now(),
    lastActivity: Date.now(), pairConsentV1: true, durableMailboxV1, runtimeId: randomUUID() };
}
async function peer(id: string, name: string, durable = true) {
  const c = new IntercomClient(); c.on('error', () => undefined);
  await c.connect(reg(name, durable), id);
  return c;
}
test('F12 real broker: queue acknowledgement survives restart, exact-ID reoffer and saved receipt', async () => {
  const aId = randomUUID(), bId = randomUUID(), mid = randomUUID();
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined,
    b: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await start();
    a = await peer(aId, 'Sender A'); b = await peer(bId, 'Receiver B');
    assert.equal((await a.decidePair(bId, 'remembered', 'Offline code review')).mode, 'remembered');
    await b.disconnect(); b = undefined;
    const accepted = await a.sendExact(bId, undefined, { messageId: mid, text: 'offline result A' }, 'async');
    assert.equal(accepted.delivery, 'queued');
    const state = JSON.parse(readFileSync(join(root, 'comms', 'mailbox.json'), 'utf8'));
    assert.equal(state.pending.length, 1, 'broker saved payload before acknowledging queued');
    assert.equal(state.pending[0].targetId, bId);
    assert.equal((await a.mailboxEvidence([mid]))[0].state, 'queued');
    const repeat = await a.sendExact(bId, undefined, { messageId: mid, text: 'offline result A' }, 'async');
    assert.equal(repeat.delivery, 'queued', 'identical ID does not enqueue twice');
    assert.equal((await a.sendExact(bId, undefined, { messageId: mid, text: 'changed payload' }, 'async')).code, 'E_MESSAGE_ID_REUSE');
    const ask = await a.sendExact(bId, undefined, { messageId: randomUUID(), text: 'not queued ask', expectsReply: true }, 'live_only');
    assert.equal(ask.delivered, false);
    assert.equal(JSON.parse(readFileSync(join(root, 'comms', 'mailbox.json'), 'utf8')).pending.length, 1);

    await a.disconnect(); a = undefined; await stop(broker); broker = await start();
    a = await peer(aId, 'A restarted');
    assert.equal((await a.mailboxEvidence([mid]))[0].state, 'queued');
    const received: string[] = [];
    b = new IntercomClient(); b.on('error', () => undefined);
    b.on('message', (_from: unknown, message: { id: string }) => received.push(message.id));
    await b.connect(reg('B returned'), bId);
    await b.listPairs();
    await waitFor(() => received.includes(mid), 'queued message not reoffered after broker restart');
    assert.equal(received.length, 1);
    // A receiver crash before saving its native record cannot release broker responsibility.
    await b.disconnect(); b = new IntercomClient(); b.on('error', () => undefined);
    const repeated: string[] = [];
    b.on('message', (_from: unknown, message: { id: string }) => {
      repeated.push(message.id);
      b!.sendMessageReceipt({ messageId: message.id, status: 'receiver_recorded', timestamp: Date.now() });
    });
    await b.connect(reg('B recovered'), bId); await b.listPairs();
    await waitFor(() => repeated.length === 1, 'same-ID reoffer after unsaved receiver crash');
    assert.deepEqual(repeated, [mid]);
    await waitFor(async () => (await a!.mailboxEvidence([mid]))[0].state === 'receiver_recorded',
      'sender must see committed saved-receipt outcome');
    assert.equal(JSON.parse(readFileSync(join(root, 'comms', 'mailbox.json'), 'utf8')).pending.length, 0);
    await a.disconnect(); a = undefined; await b.disconnect(); b = undefined;
    await stop(broker); broker = await start();
    a = await peer(aId, 'A again');
    assert.equal((await a.mailboxEvidence([mid]))[0].state, 'receiver_recorded', 'terminal outcome survives restart');
  } finally {
    await Promise.all([a,b].filter(Boolean).map(x => x!.disconnect().catch(() => undefined)));
    await stop(broker);
  }
});

test('F12: bounded queue rejects instead of evicting; expiry, identity and corruption keep honest evidence', () => {
  const dir = join(root, 'limits'); mkdirSync(dir, { recursive: true });
  const store = new DurableMailbox(dir);
  const fromId = randomUUID(), targetId = randomUUID(), now = Date.now();
  const from = { id: fromId, name: 'A', cwd: root, model: 'fixture', pid: process.pid,
    startedAt: now, lastActivity: now, endpointEpoch: randomUUID() };
  const item = (id: string, queuedAt = now) => {
    const message = { id, timestamp: now, content: { text: 'payload' } };
    return { from, fromKey: fromId, targetId, targetKey: targetId, scope: null,
      message, queuedAt, expiresAt: queuedAt + MAIL_TTL_MS,
      fingerprint: mailFingerprint(message, targetId) };
  };
  const first = randomUUID();
  store.enqueue(item(first));
  for (let i = 1; i < MAIL_MAX_ITEMS; i++) store.enqueue(item(randomUUID()));
  assert.equal(store.pending.length, MAIL_MAX_ITEMS);
  assert.throws(() => store.enqueue(item(randomUUID())), /MAILBOX_FULL/);
  assert.ok(store.lookup(fromId, first) && 'message' in store.lookup(fromId, first)!, 'accepted mail never evicted');
  const expiredAt = now + MAIL_TTL_MS + 1;
  const expired = store.expire(expiredAt);
  assert.equal(expired.length, MAIL_MAX_ITEMS);
  assert.equal(store.pending.length, 0);
  assert.equal(store.lookup(fromId, first)?.outcome, 'expired');
  assert.equal(new DurableMailbox(dir).lookup(fromId, first)?.outcome, 'expired', 'expiry committed to disk');

  const corruptDir = join(root, 'corrupt'); mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, 'mailbox.json'), '{broken');
  const corrupt = new DurableMailbox(corruptDir);
  assert.match(corrupt.blocked ?? '', /MAILBOX_UNREADABLE/);
  assert.throws(() => corrupt.enqueue(item(randomUUID())), /MAILBOX_UNREADABLE/);
  assert.ok(readdirSync(corruptDir).some(name => name.startsWith('mailbox.json.unreadable-')));
  const obsoleteDir = join(root, 'old-format'); mkdirSync(obsoleteDir, { recursive: true });
  writeFileSync(join(obsoleteDir, 'mailbox.json'), JSON.stringify({ formatVersion: 999, pending: [], terminal: [], sha256: 'old' }));
  assert.match(new DurableMailbox(obsoleteDir).blocked ?? '', /MAILBOX_UNREADABLE/, 'unknown disk versions cannot accept new mail');
  store.pruneEvidence(expiredAt + 14 * 24 * 60 * 60 * 1000 + 1);
  assert.equal(store.lookup(fromId, first), undefined, 'old outcome evidence has a bounded lifetime');
  const bytesDir = join(root, 'byte-limit'); mkdirSync(bytesDir, { recursive: true });
  const bytesStore = new DurableMailbox(bytesDir);
  const huge = item(randomUUID()); huge.message.content.text = 'x'.repeat(32 * 1024 * 1024);
  huge.fingerprint = mailFingerprint(huge.message, targetId);
  assert.throws(() => bytesStore.enqueue(huge), /MAILBOX_FULL/, 'byte limit rejects before durable acceptance');
});

test('F12: ending approval before reconnect saves a terminal result, not a new delivery', async () => {
  const aId = randomUUID(), bId = randomUUID(), mid = randomUUID();
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined, b: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await start(); a = await peer(aId, 'A'); b = await peer(bId, 'B');
    await a.decidePair(bId, 'remembered', 'Temporary collaboration');
    await b.disconnect(); b = undefined;
    assert.equal((await a.sendExact(bId, undefined, { messageId: mid, text: 'now revoked' }, 'async')).delivery, 'queued');
    await a.decidePair(bId, 'none', '');
    await waitFor(async () => (await a!.mailboxEvidence([mid]))[0].state === 'contact_ended');
    b = await peer(bId, 'B returned');
    const arrivals: string[] = []; b.on('message', (_: unknown, msg: { id: string }) => arrivals.push(msg.id));
    await b.listPairs();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(arrivals, [], 'revoked mail must not be delivered later');
    assert.equal((await a.mailboxEvidence([mid]))[0].state, 'contact_ended');
  } finally {
    await Promise.all([a,b].filter(Boolean).map(x => x!.disconnect().catch(() => undefined)));
    await stop(broker);
  }
});


test('F12 real broker: committed expiry remains visible after restart', async () => {
  const fromId = randomUUID(), targetId = randomUUID(), mid = randomUUID();
  const staleAt = Date.now() - MAIL_TTL_MS - 2000;
  const message = { id: mid, timestamp: staleAt, content: { text: 'expired body' } };
  const from = { id: fromId, cwd: root, model: 'fixture', pid: process.pid,
    startedAt: staleAt, lastActivity: staleAt, endpointEpoch: randomUUID() };
  new DurableMailbox(join(root, 'comms')).enqueue({ from, fromKey: JSON.stringify([null, fromId]),
    targetId, targetKey: JSON.stringify([null, targetId]), scope: null, message, queuedAt: staleAt,
    expiresAt: staleAt + MAIL_TTL_MS,
    fingerprint: mailFingerprint(message, targetId) });
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await start(); a = await peer(fromId, 'Expired mail sender');
    assert.equal((await a.mailboxEvidence([mid]))[0].state, 'expired');
    const duplicate = await a.sendExact(targetId, undefined, { messageId: mid, text: 'expired body' }, 'async');
    assert.equal(duplicate.delivered, false, 'expired ID must not be re-accepted');
    assert.equal(duplicate.code, 'E_DELIVERY_EXPIRED', 'same content keeps the saved terminal outcome');
    const changed = await a.sendExact(targetId, undefined, { messageId: mid, text: 'changed expired body' }, 'async');
    assert.equal(changed.code, 'E_MESSAGE_ID_REUSE', 'changed content cannot reuse an expired ID');
  } finally {
    await a?.disconnect().catch(() => undefined); await stop(broker);
  }
});

test('F12 broker auto-upgrade leaves previously acknowledged offline message intact', async () => {
  const aId = randomUUID(), bId = randomUUID(), mid = randomUUID();
  const legacyPath = join(root, 'pre-upgrade/dist/transport/broker/broker.js');
  mkdirSync(join(root, 'pre-upgrade/dist/transport/broker'), { recursive: true });
  // The old F12-capable broker has no version stamp but uses the SAME durable
  // mailbox format. This is not the pre-F12 RAM-only migration.
  writeFileSync(legacyPath, readFileSync(brokerPath, 'utf8')
    .replaceAll('packageVersion: INTERCOM_PACKAGE_VERSION,', ''));
  let old: ChildProcess | undefined;
  let a: InstanceType<typeof IntercomClient> | undefined, b: InstanceType<typeof IntercomClient> | undefined;
  try {
    old = spawn(process.execPath, [legacyPath], {
      ...getBrokerSpawnOptions(process.env, true), stdio: ['ignore','pipe','pipe'],
    });
    const logs: string[] = [];
    old.stdout!.on('data', c => logs.push(String(c)));
    old.stderr!.on('data', c => logs.push(String(c)));
    await waitFor(() => logs.join('').includes('Intercom broker started'), logs.join(''), 9000);
    a = await peer(aId, 'A before upgrade'); b = await peer(bId, 'B before upgrade');
    await a.decidePair(bId, 'remembered', 'Upgraded mail');
    await b.disconnect(); b = undefined;
    assert.equal((await a.sendExact(bId, undefined, { messageId: mid, text: 'MAIL_SURVIVES_UPGRADE' }, 'async')).delivery, 'queued');
    const queuedPath = join(root, 'comms', 'mailbox.json');
    assert.ok(readFileSync(queuedPath, 'utf8').includes(mid));
    await spawnBrokerIfNeeded(new URL('../dist/transport/broker/broker.js', import.meta.url));
    await a.disconnect().catch(() => undefined);
    a = await peer(aId, 'A after upgrade');
    assert.equal((await a.mailboxEvidence([mid]))[0].state, 'queued');
    const arrivals: string[] = [];
    b = new IntercomClient(); b.on('error', () => undefined);
    b.on('message', (_: unknown, msg: { id: string }) => {
      arrivals.push(msg.id);
      b!.sendMessageReceipt({ messageId: msg.id, status: 'receiver_recorded', timestamp: Date.now() });
    });
    await b.connect(reg('B after upgrade'), bId); await b.listPairs();
    await waitFor(() => arrivals.includes(mid), 'exact receiver after broker upgrade');
    await waitFor(async () => (await a!.mailboxEvidence([mid]))[0].state === 'receiver_recorded');
  } finally {
    await Promise.all([a,b].filter(Boolean).map(x => x!.disconnect().catch(() => undefined)));
    await stop(old);
    try { process.kill(Number(readFileSync(join(root,'comms','broker.pid'),'utf8')), 'SIGTERM'); } catch {}
  }
});


test('F12 real broker: session-only approval expires before queued mail is offered to restarted runtime', async () => {
  const aId = randomUUID(), bId = randomUUID(), mid = randomUUID();
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined,
    b: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await start(); a = await peer(aId, 'A kept running'); b = await peer(bId, 'B first runtime');
    await a.decidePair(bId, 'session', 'Review while a peer briefly disconnects');
    (b as any).socket.destroy(); // same-runtime socket loss is not session expiry
    await waitFor(async () => !(await a!.listSessions()).some(s => s.id === bId), 'B socket drop');
    assert.equal((await a.listPairs()).find(s => s.peer === bId)?.mode, 'session');
    assert.equal((await a.sendExact(bId, undefined, { messageId: mid, text: 'must not reach a restarted runtime' }, 'async')).delivery, 'queued');
    const arrivals: string[] = [];
    b = new IntercomClient(); b.on('error', () => undefined);
    b.on('message', (_: unknown, msg: { id: string }) => arrivals.push(msg.id));
    await b.connect(reg('B after restart'), bId); // new runtimeId expires A-B session-only approval
    await b.listPairs();
    await waitFor(async () => (await a!.mailboxEvidence([mid]))[0].state === 'contact_ended',
      'queued item must reach terminal consent outcome');
    assert.deepEqual(arrivals, [], 'no mailbox payload reaches a restarted runtime after temporary approval expired');
  } finally {
    await Promise.all([a,b].filter(Boolean).map(x => x!.disconnect().catch(() => undefined)));
    await stop(broker);
  }
});
