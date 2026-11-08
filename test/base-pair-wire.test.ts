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
const waitFor = async (check: () => boolean | Promise<boolean>, logs: () => string, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!await check()) {
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
const reg = (name: string, pairConsentV1 = true, runtimeId = randomUUID()) => ({
  name, cwd: root, model: 'fixture', pid: process.pid, startedAt: Date.now(),
  lastActivity: Date.now(), pairConsentV1, ...(pairConsentV1 ? { runtimeId } : {}),
});
async function member(id: string, name: string, pairConsentV1 = true, runtimeId = randomUUID()) {
  const client = new IntercomClient();
  client.on('error', () => undefined);
  await client.connect(reg(name, pairConsentV1, runtimeId), id);
  return client;
}
async function send(sender: InstanceType<typeof IntercomClient>, target: InstanceType<typeof IntercomClient>) {
  const id = target.sessionId!;
  const found = (await sender.listSessions()).find(s => s.id === id)!;
  assert.ok(found?.endpointEpoch, 'exact recipient exists');
  return sender.sendExact(id, found.endpointEpoch!, { messageId: randomUUID(), text: 'pair test payload' });
}
const mode = async (client: InstanceType<typeof IntercomClient>, peer: string) =>
  (await client.listPairs()).find(p => p.peer === peer)?.mode ?? 'none';

test('F11 real broker: B-first remembered restart, either-side end, session-only expiry, outdated peer', async () => {
  const aId = randomUUID(), bId = randomUUID(), oldId = randomUUID();
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined,
    b: InstanceType<typeof IntercomClient> | undefined,
    old: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await startBroker();
    a = await member(aId, 'A'); b = await member(bId, 'B');
    assert.equal(await mode(a, bId), 'none');
    assert.equal((await a.decidePair(bId, 'remembered', 'Review')).mode, 'remembered');
    assert.equal(await mode(b, aId), 'remembered');
    assert.equal((await send(b, a)).delivered, true, 'B may initiate first from the one pair approval');
    assert.equal((await send(a, b)).delivered, true);

    // Ending from B is the same pair change for A. It is "not approved", not a block.
    const updates: { mode: string; reason?: string }[] = [];
    a.on('pair_update', (u: { mode: string; reason?: string }) => updates.push(u));
    assert.equal((await b.decidePair(aId, 'none', '')).mode, 'none');
    await waitFor(() => updates.some(u => u.mode === 'none' && u.reason === 'ended'), () => JSON.stringify(updates));
    assert.equal((await send(a, b)).code, 'E_PAIR_NOT_APPROVED');
    assert.equal((await send(b, a)).code, 'E_PAIR_NOT_APPROVED');
    await a.disconnect(); await b.disconnect();
    await stopBroker(broker); broker = await startBroker();
    a = await member(aId, 'A restarted'); b = await member(bId, 'B restarted');
    assert.equal(await mode(a, bId), 'none', 'broker restart cannot revive an ended approval');

    // A new approval is shared; send order is irrelevant after restart.
    assert.equal((await b.decidePair(aId, 'remembered', 'Approved again')).mode, 'remembered');
    await a.disconnect(); await b.disconnect(); await stopBroker(broker);
    broker = await startBroker();
    a = await member(aId, 'A again'); b = await member(bId, 'B again');
    assert.equal((await send(b, a)).delivered, true);
    assert.equal((await send(a, b)).delivered, true);

    // Session-only ends when one side's runtime leaves.
    assert.equal((await a.decidePair(bId, 'session', 'Now only')).mode, 'session');
    await b.disconnect();
    assert.equal(await mode(a, bId), 'none');
    b = await member(bId, 'B new runtime');
    assert.equal((await send(a, b)).code, 'E_PAIR_NOT_APPROVED');

    // An older client gets a specific, actionable code in both directions.
    old = await member(oldId, 'Old client', false);
    await assert.rejects(a.decidePair(oldId, 'remembered', 'Not allowed'), /PEER_OUTDATED/);
    assert.equal((await send(a, old)).code, 'PEER_OUTDATED');
    assert.equal((await send(old, a)).code, 'PEER_OUTDATED');
    await assert.rejects(a.decidePair(randomUUID(), 'session', 'Offline'), /TARGET_UNAVAILABLE/);
  } finally {
    await Promise.all([a, b, old].filter(Boolean).map(client => client!.disconnect().catch(() => undefined)));
    await stopBroker(broker);
  }
});

test('F11 real broker: a dropped socket of the same runtime keeps session-only approval; a reload ends it', async () => {
  const aId = randomUUID(), bId = randomUUID(), bRuntime = randomUUID();
  let broker: ChildProcess | undefined, a: InstanceType<typeof IntercomClient> | undefined,
    b: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await startBroker();
    a = await member(aId, 'A'); b = await member(bId, 'B', true, bRuntime);
    const updates: { mode: string; reason?: string }[] = [];
    a.on('pair_update', (u: { mode: string; reason?: string }) => updates.push(u));
    assert.equal((await a.decidePair(bId, 'session', 'Review')).mode, 'session');

    // Abrupt socket loss (network blip, broker heartbeat miss) is not a runtime exit.
    (b as any).socket.destroy();
    await waitFor(async () => !(await a!.listSessions()).some(s => s.id === bId), () => 'B still listed');
    assert.equal(await mode(a, bId), 'session', 'approval waits for the same runtime');
    b = await member(bId, 'B reconnects', true, bRuntime);
    assert.equal((await send(a, b)).delivered, true, 'no new prompt after a reconnect');
    assert.equal(updates.filter(u => u.mode === 'none').length, 0);

    // A different runtime of the same saved session (reload/restart) ends it.
    (b as any).socket.destroy();
    await waitFor(async () => !(await a!.listSessions()).some(s => s.id === bId), () => 'B still listed');
    b = await member(bId, 'B reloaded', true, randomUUID());
    await waitFor(() => updates.some(u => u.mode === 'none' && u.reason === 'expired'), () => JSON.stringify(updates));
    assert.equal(await mode(a, bId), 'none');
    assert.equal((await send(a, b)).code, 'E_PAIR_NOT_APPROVED');
  } finally {
    await Promise.all([a, b].filter(Boolean).map(client => client!.disconnect().catch(() => undefined)));
    await stopBroker(broker);
  }
});

test('F11 real broker: replacing a dead-pid registration with its socket still open expires the session-only pair', async () => {
  const aId = randomUUID(), bId = randomUUID();
  let broker: ChildProcess | undefined, pidOwner: ChildProcess | undefined;
  let a: InstanceType<typeof IntercomClient> | undefined,
    stale: InstanceType<typeof IntercomClient> | undefined,
    replacement: InstanceType<typeof IntercomClient> | undefined;
  try {
    broker = await startBroker();
    a = await member(aId, 'A remains connected');
    // The advertised process dies while the registered socket stays open.
    pidOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    assert.ok(pidOwner.pid);
    stale = new IntercomClient(); stale.on('error', () => undefined);
    await stale.connect({ ...reg('B old holder'), pid: pidOwner.pid! }, bId);
    const changes: { mode: string; peer: string }[] = [];
    a.on('pair_update', (update: { mode: string; peer: string }) => changes.push(update));
    assert.equal((await a.decidePair(bId, 'session', 'One temporary A-B grant')).mode, 'session');
    assert.equal((await send(a, stale)).delivered, true);

    const exited = once(pidOwner, 'exit');
    pidOwner.kill('SIGTERM');
    await exited;
    assert.equal(stale.isConnected(), true, 'old socket is still registered despite dead claimed pid');

    replacement = await member(bId, 'B resumes same exact session');
    await waitFor(() => changes.some(u => u.peer === bId && u.mode === 'none'),
      () => JSON.stringify(changes), 2500);
    assert.equal(await mode(a, bId), 'none', 'new registration does not inherit old session-only approval');
    assert.equal((await send(a, replacement)).code, 'E_PAIR_NOT_APPROVED');
    // A late close from the retired socket must not remove the replacement.
    await stale.disconnect();
    assert.ok((await a.listSessions()).some(s => s.id === bId), 'closing stale socket cannot unregister the new holder');
  } finally {
    await Promise.all([a, stale, replacement].filter(Boolean).map(c => c!.disconnect().catch(() => undefined)));
    if (pidOwner && pidOwner.exitCode === null && pidOwner.signalCode === null) pidOwner.kill('SIGKILL');
    await stopBroker(broker);
  }
});
