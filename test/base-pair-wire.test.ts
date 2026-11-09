import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'pc-pair-broker-'));
process.env.PI_CODING_AGENT_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const { IntercomClient } = await import('../src/transport/broker/client.ts');
const { connect: connectClient } = await import('../src/transport/start.ts');
const { getBrokerSpawnOptions, spawnBrokerIfNeeded, verifyBrokerProcess } = await import('../src/transport/broker/spawn.ts');
const { PairApprovalStore } = await import('../src/transport/broker/pair-approvals.ts');
const { getBrokerSocketPath } = await import('../src/transport/broker/paths.ts');
const {
  compareSemver,
  INTERCOM_PACKAGE_VERSION,
  isBrokerVersionOlder,
} = await import('../src/transport/broker/runtime-claim.ts');
const { formatBrokerOutdatedError } = await import('../src/extension.ts');
const { createMessageReader, writeMessage } = await import('../src/transport/broker/framing.ts');
const brokerURL = new URL('../dist/transport/broker/broker.js', import.meta.url);
const brokerPath = fileURLToPath(brokerURL);
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

test('Issue #37: verified older compiled broker held open by 32 clients is retired once under lock; clients reconnect and remembered pairs survive', async () => {
  const commsDir = join(root, 'comms');
  mkdirSync(commsDir, { recursive: true });
  const pidPath = join(commsDir, 'broker.pid');
  // Create a 0.1.9 copy of the real compiled broker at transport/broker/broker.js.
  const legacyBrokerDir = join(root, 'legacy-pkg/dist/transport/broker');
  mkdirSync(legacyBrokerDir, { recursive: true });
  const legacyBrokerPath = join(legacyBrokerDir, 'broker.js');
  const compiledBrokerSource = readFileSync(brokerPath, 'utf8')
    .replaceAll(`packageVersion: INTERCOM_PACKAGE_VERSION,`, '')
    .replaceAll('"pair-consent-v1"', '"owner-contact-v1"');
  writeFileSync(legacyBrokerPath, compiledBrokerSource);

  const aId = randomUUID(), bId = randomUUID(), legacyPeerId = randomUUID();
  new PairApprovalStore(commsDir).decide(undefined, aId, bId, 'remembered', 'Survives broker upgrade', () => 'rt');

  let legacyBroker: ChildProcess | undefined;
  const fleet: { id: string; name: string; pairConsentV1: boolean; runtimeId: string; client: InstanceType<typeof IntercomClient> }[] = [];
  let newA: InstanceType<typeof IntercomClient> | undefined, newB: InstanceType<typeof IntercomClient> | undefined;
  let reconnecting = true;
  const reconnectErrors: Error[] = [];

  try {
    const spawnOpts = getBrokerSpawnOptions(process.env, true);
    legacyBroker = spawn(process.execPath, [legacyBrokerPath], { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs: string[] = [];
    legacyBroker.stdout!.on('data', chunk => logs.push(String(chunk)));
    legacyBroker.stderr!.on('data', chunk => logs.push(String(chunk)));
    await waitFor(() => logs.join('').includes('Intercom broker started'), () => logs.join(''));
    const legacyPid = legacyBroker.pid!;
    assert.equal(verifyBrokerProcess(legacyPid, commsDir), true, 'real compiled broker in commsDir passes verification');
    assert.equal(
      verifyBrokerProcess(legacyPid, join(root, 'other-agent/comms')),
      false,
      'broker running in a different agent directory must fail verification for that directory',
    );

    // Connect 32 long-lived clients (31 pair-aware + 1 pre-0.1.10) that auto-reconnect on disconnect.
    for (let i = 0; i < 32; i++) {
      const id = i === 0 ? legacyPeerId : randomUUID();
      const pairConsentV1 = i !== 0;
      const runtimeId = randomUUID();
      const name = i === 0 ? 'Old 0.1.9 peer' : `Fleet-${i}`;
      const attach = async () => {
        const client = new IntercomClient();
        client.on('error', () => undefined);
        client.on('disconnected', () => {
          if (!reconnecting) return;
          setTimeout(() => {
            if (!reconnecting) return;
            const replacement = new IntercomClient();
            replacement.on('error', () => undefined);
            const entry = fleet.find(item => item.id === id);
            if (!entry) return;
            entry.client = replacement;
            void connectClient(id, reg(name, pairConsentV1, runtimeId), replacement, brokerURL).catch(err => {
              if (reconnecting) reconnectErrors.push(err instanceof Error ? err : new Error(String(err)));
            });
          }, 80);
        });
        await client.connect(reg(name, pairConsentV1, runtimeId), id);
        return client;
      };
      fleet.push({ id, name, pairConsentV1, runtimeId, client: await attach() });
    }

    // Two upgraded clients connect concurrently, contending for BROKER_SPAWN_LOCK.
    newA = new IntercomClient(); newA.on('error', () => undefined);
    newB = new IntercomClient(); newB.on('error', () => undefined);
    await Promise.all([
      connectClient(aId, reg('Upgraded A'), newA, brokerURL),
      connectClient(bId, reg('Upgraded B'), newB, brokerURL),
    ]);

    assert.equal(newA.supportsFeature('pair-consent-v1'), true);
    assert.equal(newB.supportsFeature('pair-consent-v1'), true);
    assert.equal(newA.brokerInfo.packageVersion, INTERCOM_PACKAGE_VERSION);
    assert.equal(newA.brokerInfo.pid, newB.brokerInfo.pid, 'concurrent starters share one replacement broker');
    const upgradedPid = Number(readFileSync(pidPath, 'utf8').trim());
    assert.notEqual(upgradedPid, legacyPid, 'legacy broker PID was retired and replaced');
    assert.equal(newA.brokerInfo.pid, upgradedPid);

    // All 32 fleet clients reconnect without eviction (34 total sessions).
    await waitFor(async () => (await newA!.listSessions()).length === 34,
      async () => `connected=${(await newA!.listSessions()).length} errors=${reconnectErrors.map(e => e.message).join(';')}`, 8000);
    assert.deepEqual(reconnectErrors, []);

    // Remembered approval between A and B survived the automatic broker upgrade.
    assert.equal(await mode(newA, bId), 'remembered');
    assert.equal((await send(newB, newA)).delivered, true);
    assert.equal((await send(newA, newB)).delivered, true);

    // Pre-0.1.10 connected peer still gets per-peer PEER_OUTDATED.
    const legacyEntry = fleet.find(item => item.id === legacyPeerId)!;
    assert.equal((await send(newA, legacyEntry.client)).code, 'PEER_OUTDATED');
  } finally {
    reconnecting = false;
    await Promise.all([newA, newB, ...fleet.map(f => f.client)].filter(Boolean).map(c => c!.disconnect().catch(() => undefined)));
    await stopBroker(legacyBroker);
    try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

test('Issue #37: unverified PID in broker.pid is never killed or recommended for kill; stale lock is reclaimed on owner exit', async () => {
  const commsDir = join(root, 'comms');
  mkdirSync(commsDir, { recursive: true });
  const socketPath = getBrokerSocketPath();
  const pidPath = join(commsDir, 'broker.pid');
  const lockPath = join(commsDir, 'broker.spawn.lock');
  try { rmSync(socketPath, { force: true }); } catch {}

  let bystander: ChildProcess | undefined;
  let deceptiveBroker: ChildProcess | undefined;
  let fakeServer: net.Server | undefined;
  try {
    // 1. Both an arbitrary node process AND a deceptive *broker*.js script fail verification.
    bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const deceptivePath = join(root, 'other-broker.js');
    writeFileSync(deceptivePath, 'setInterval(() => {}, 1000);\n');
    deceptiveBroker = spawn(process.execPath, [deceptivePath], { cwd: commsDir, stdio: 'ignore' });
    assert.ok(bystander.pid && deceptiveBroker.pid);
    assert.equal(verifyBrokerProcess(bystander.pid, commsDir), false, 'non-broker process fails verification');
    assert.equal(verifyBrokerProcess(deceptiveBroker.pid, commsDir), false, 'arbitrary *broker*.js outside transport/broker/broker.js fails verification');

    writeFileSync(pidPath, String(deceptiveBroker.pid));
    fakeServer = net.createServer(socket => {
      socket.on('data', createMessageReader((msg: any) => {
        if (msg.type === 'health') {
          writeMessage(socket, { type: 'health_ok', requestId: msg.requestId, protocol: 'pi-comms', version: 1 });
        }
      }, () => socket.destroy()));
    });
    await new Promise<void>(resolve => fakeServer!.listen(socketPath, resolve));

    // spawnBrokerIfNeeded must refuse to terminate the deceptive process.
    await spawnBrokerIfNeeded(brokerURL);
    process.kill(deceptiveBroker.pid, 0);

    // Error formatter reports an unverified PID as unverified and warns NOT to kill it blindly.
    const unverifiedError = formatBrokerOutdatedError(undefined, '0.1.11', '0.1.11', commsDir);
    assert.match(unverifiedError, new RegExp(`^BROKER_OUTDATED: running broker \\(unverified broker\\.pid ${deceptiveBroker.pid}, version unreported \\(pre-0\\.1\\.11\\), pid-file timestamp 20`));
    assert.match(unverifiedError, /broker\.pid could not be verified as this pi-comms broker, so do not kill it blindly/);
    assert.doesNotMatch(unverifiedError, new RegExp(`kill ${deceptiveBroker.pid}`));

    // SemVer prerelease precedence and monotonic comparison.
    assert.equal(compareSemver('0.1.11-rc.1', '0.1.11-rc.2'), -1);
    assert.equal(compareSemver('0.1.11-rc.2', '0.1.11-rc.10'), -1);
    assert.equal(compareSemver('0.1.11-rc.10', '0.1.11'), -1);
    assert.equal(isBrokerVersionOlder('0.1.11-rc.1', '0.1.11'), true);
    assert.equal(isBrokerVersionOlder('0.1.12', '0.1.11'), false);

    // 2. When a verified broker PID is known, formatBrokerOutdatedError advises asking the user to stop that verified PID.
    await new Promise(resolve => fakeServer!.close(resolve));
    fakeServer = undefined;
    rmSync(pidPath, { force: true });
    rmSync(socketPath, { force: true });

    // Seed a stale lock from a dead process and verify a contender reclaims it and starts the broker.
    const deadOwner = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(deadOwner, 'exit');
    writeFileSync(lockPath, `${deadOwner.pid}\n${Date.now()}\nstale-token\n`);

    await spawnBrokerIfNeeded(brokerURL);
    const liveBrokerPid = Number(readFileSync(pidPath, 'utf8').trim());
    assert.equal(verifyBrokerProcess(liveBrokerPid, commsDir), true);

    const verifiedDowngradedError = formatBrokerOutdatedError(
      { pid: liveBrokerPid, packageVersion: '0.1.10', startedAt: Date.parse('2026-11-04T02:47:27.000Z') },
      '0.1.11',
      '0.1.10',
      commsDir,
    );
    assert.match(verifiedDowngradedError, new RegExp(`running broker \\(pid ${liveBrokerPid}, v0\\.1\\.10, started 2026-11-04T02:47:27\\.000Z\\) and on-disk broker \\(v0\\.1\\.10\\) are older than this session \\(v0\\.1\\.11\\)`));
    assert.match(verifiedDowngradedError, new RegExp(`ask the user to update the installed pi-comms package and then stop broker pid ${liveBrokerPid} \\(kill ${liveBrokerPid}\\)`));
  } finally {
    if (fakeServer) await new Promise(resolve => fakeServer!.close(resolve));
    if (bystander && bystander.exitCode === null && bystander.signalCode === null) bystander.kill('SIGKILL');
    if (deceptiveBroker && deceptiveBroker.exitCode === null && deceptiveBroker.signalCode === null) deceptiveBroker.kill('SIGKILL');
    try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    rmSync(pidPath, { force: true });
    rmSync(socketPath, { force: true });
    rmSync(lockPath, { force: true });
  }
});
