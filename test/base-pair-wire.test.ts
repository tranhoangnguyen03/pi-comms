import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'pc-pair-broker-'));
process.env.PI_CODING_AGENT_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const { IntercomClient } = await import('../src/transport/broker/client.ts');
const brokerPath = fileURLToPath(new URL('../dist/transport/broker/broker.js', import.meta.url));
const waitFor = async (check: () => boolean, logs: () => string, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error('F11 broker lifecycle timed out: ' + logs());
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};
async function startBroker() {
  const child = spawn(process.execPath, [brokerPath], {
    env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: string[] = [];
  child.stdout!.on('data', data => chunks.push(String(data)));
  child.stderr!.on('data', data => chunks.push(String(data)));
  try {
    await waitFor(() => chunks.join('').includes('Intercom broker started'), () => chunks.join(''));
    return child;
  } catch (error) { await stopBroker(child); throw error; }
}
async function stopBroker(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  await done;
}
const reg = (name: string, pairConsentV1 = true) => ({
  name, cwd: root, model: 'fixture', pid: process.pid, startedAt: Date.now(),
  lastActivity: Date.now(), pairConsentV1,
});
async function member(id: string, name: string, pairConsentV1 = true) {
  const client = new IntercomClient();
  client.on('error', () => undefined);
  await client.connect(reg(name, pairConsentV1), id);
  return client;
}
async function send(sender: InstanceType<typeof IntercomClient>, target: InstanceType<typeof IntercomClient>) {
  const id = target.sessionId!;
  const found = (await sender.listSessions()).find(s => s.id === id)!;
  assert.ok(found?.endpointEpoch, 'exact recipient exists');
  return sender.sendExact(id, found.endpointEpoch!, { messageId: randomUUID(), text: 'pair test payload' });
}

test('F11 real broker: B-first remembered restart, either-side revoke, session expiry, legacy peer rejection', async () => {
  const aId = randomUUID(), bId = randomUUID(), oldId = randomUUID();
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined,
    b: InstanceType<typeof IntercomClient> | undefined,
    old: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await startBroker();
    a = await member(aId, 'A'); b = await member(bId, 'B');
    assert.equal((await a.listPairs()).find(p => p.peer === bId), undefined);
    const approved = await a.decidePair(bId, 'remembered', 'Review');
    assert.equal(approved.mode, 'remembered');
    assert.equal((await b.listPairs()).find(p => p.peer === aId)?.mode, 'remembered');
    assert.equal((await send(b, a)).delivered, true, 'B may initiate first from the one pair grant');
    assert.equal((await send(a, b)).delivered, true);

    // A revoke from B is the same pair change that A must respect.
    assert.equal((await b.decidePair(aId, 'revoked', '')).mode, 'revoked');
    assert.equal((await a.listPairs()).find(p => p.peer === bId)?.mode, 'revoked');
    assert.equal((await send(a, b)).code, 'E_PAIR_NOT_APPROVED');
    assert.equal((await send(b, a)).code, 'E_PAIR_NOT_APPROVED');
    await a.disconnect(); await b.disconnect();
    await stopBroker(broker); broker = await startBroker();
    a = await member(aId, 'A restarted'); b = await member(bId, 'B restarted');
    assert.equal((await a.listPairs()).find(p => p.peer === bId)?.mode, 'revoked');
    assert.equal((await b.listPairs()).find(p => p.peer === aId)?.mode, 'revoked');
    assert.equal((await send(a, b)).code, 'E_PAIR_NOT_APPROVED', 'broker restart cannot revive an old grant');

    // One new owner grant is shared; message order is irrelevant after restart.
    assert.equal((await b.decidePair(aId, 'remembered', 'Reapproved')).mode, 'remembered');
    await a.disconnect(); await b.disconnect(); await stopBroker(broker);
    broker = await startBroker();
    a = await member(aId, 'A again'); b = await member(bId, 'B again');
    assert.equal((await send(b, a)).delivered, true);
    assert.equal((await send(a, b)).delivered, true);

    // Deliberately shorten lifetime. A session-only grant must end if one
    // endpoint disconnects, and cannot come back after a broker restart.
    assert.equal((await a.decidePair(bId, 'session', 'Now only')).mode, 'session');
    await b.disconnect();
    assert.equal((await a.listPairs()).find(p => p.peer === bId)?.mode, 'none');
    b = await member(bId, 'B later');
    assert.equal((await send(a, b)).code, 'E_PAIR_NOT_APPROVED');

    // Old clients cannot send through the pair-aware broker boundary.
    old = await member(oldId, 'Old client', false);
    await assert.rejects(a.decidePair(oldId, 'remembered', 'Not allowed'), /PAIR_PEER_UNAVAILABLE_OR_UNSUPPORTED/);
    assert.equal((await send(a, old)).code, 'E_PAIR_UNSUPPORTED');
    assert.equal((await send(old, a)).code, 'E_PAIR_UNSUPPORTED');
  } finally {
    await Promise.all([a,b,old].filter(Boolean).map(client => client!.disconnect().catch(() => undefined)));
    await stopBroker(broker);
  }
});
