import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'pc-base-wire-'));
process.env.PI_CODING_AGENT_DIR = root;
const { IntercomClient } = await import('../src/transport/broker/client.ts');
// Starts the compiled production broker, not a fixture broker.
const { connect: connectClient } = await import('../src/transport/start.ts');
const connect = (id: string, registration: any, client: InstanceType<typeof IntercomClient>) => connectClient(id, registration, client, new URL('../dist/transport/broker/broker.js', import.meta.url));
const { sendExactSession } = await import('../src/transport/send.ts');
const reg = (name: string) => ({ name, cwd: root, model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });

test('broker status report timestamp is optional for legacy peers but validated when present', async () => {
  const { isSessionInfo } = await import('../src/transport/broker/protocol.ts');
  const oldPeer = { ...reg('legacy'), id: randomUUID(), status: 'working' };
  assert.equal(isSessionInfo(oldPeer), true);
  assert.equal(isSessionInfo({ ...oldPeer, statusReportedAt: Date.now() }), true);
  assert.equal(isSessionInfo({ ...oldPeer, statusReportedAt: 'recent' }), false);
});

test('production exact-send refreshes stale same-ID once on real wire; approval and unknown-outcome checks remain controlling', async () => {
  const sender = new IntercomClient(), old = new IntercomClient(), replacement = new IntercomClient(), similar = new IntercomClient();
  const target = randomUUID();
  try {
    await Promise.all([connect(randomUUID(), reg('sender'), sender), connect(target, reg('Reviewer'), old)]);
    assert.ok((await sender.listSessions()).some(p => p.id === target), 'concurrent startup clients share one broker');
    assert.ok((await old.listSessions()).some(p => p.id === sender.sessionId));
    await connect(randomUUID(), reg('Reviewer'), similar);
    let similarReceived = 0, received = 0;
    similar.on('message', () => { similarReceived++; }); replacement.on('message', (from, wire, approval) => {
      received++;
      assert.equal(from.id, sender.sessionId);
      assert.deepEqual(approval, { context: 'Owner-approved read-only review' });
      assert.equal(JSON.parse(wire.content.text).contactApproval, undefined, 'approval is outside the agent envelope');
    });
    const nativeList = sender.listSessions.bind(sender);
    let resolveCalls = 0;
    sender.listSessions = async (...args) => {
      const sessions = await nativeList(...args);
      if (++resolveCalls === 1) { await old.disconnect(); await connect(target, reg('Reviewer'), replacement); }
      return sessions;
    };
    const envelope = { id: randomUUID(), exchange: randomUUID(), subject: 'refresh', text: 'same exact saved ID', refs: [], replyTo: null, corrects: null, createdAt: new Date().toISOString() };
    const outcome = await sendExactSession(sender, () => true, target, envelope, 'Owner-approved read-only review');
    assert.equal(outcome.outcome, 'accepted'); assert.equal(resolveCalls, 2);
    await new Promise(r => setTimeout(r, 30)); assert.equal(received, 1); assert.equal(similarReceived, 0);
    // A simultaneous live claim is rejected rather than replacing the session.
    const duplicate = new IntercomClient(); duplicate.on('error', () => undefined);
    await assert.rejects(duplicate.connect(reg('duplicate'), target), error => (error as any).code === 'E_SESSION_HELD'); await duplicate.disconnect();
    let approved = true; let sends = 0;
    sender.listSessions = async (...args) => { const result = await nativeList(...args); approved = false; return result; };
    const nativeSend = sender.sendExact.bind(sender);
    sender.sendExact = async (...args) => { sends++; return nativeSend(...args); };
    assert.equal((await sendExactSession(sender, () => approved, target, { ...envelope, id: randomUUID() })).code, 'CONTACT_NOT_APPROVED'); assert.equal(sends, 0);
    sender.listSessions = nativeList; sends = 0;
    const supports = sender.supportsFeature.bind(sender);
    sender.supportsFeature = feature => feature === 'owner-contact-v1' ? false : supports(feature);
    assert.equal((await sendExactSession(sender, () => true, target, { ...envelope, id: randomUUID() }, 'review')).code, 'UNSUPPORTED_CAPABILITY');
    assert.equal(sends, 0, 'old broker rejection is known before sending, not an unknown write');
    sender.supportsFeature = supports;
    sender.sendExact = async () => { sends++; throw new Error('unknown after write'); };
    assert.equal((await sendExactSession(sender, () => true, target, { ...envelope, id: randomUUID() })).outcome, 'unknown'); assert.equal(sends, 1);
  } finally {
    await Promise.all([sender, old, replacement, similar].map(c => c.disconnect()));
    try { process.kill(Number(readFileSync(join(root, 'comms', 'broker.pid'), 'utf8')), 'SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 100)); rmSync(root, { recursive: true, force: true });
  }
});
