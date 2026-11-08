import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

// Short path: Unix socket paths are length-limited on macOS.
const root = mkdtempSync(join(tmpdir(), 'pc-ord-'));
process.env.PI_CODING_AGENT_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const { IntercomClient } = await import('../src/transport/broker/client.ts');
const { createMessageReader } = await import('../src/transport/broker/framing.ts');
const { getBrokerSocketPath } = await import('../src/transport/broker/paths.ts') as any;
const { Runtime } = await import('../src/runtime.ts');

const frame = (msg: unknown) => {
  const json = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4); head.writeUInt32BE(json.length);
  return Buffer.concat([head, json]);
};

// A fake broker that answers pair_list and then a pair_update in ONE socket
// write, so the client's reader dispatches both in one synchronous pass.
async function coalesced(snapshot: unknown[], update: unknown) {
  const path = getBrokerSocketPath();
  mkdirSync(join(root, 'comms'), { recursive: true });
  const server = net.createServer(socket => {
    socket.on('data', createMessageReader((msg: any) => {
      if (msg.type === 'register') socket.write(frame({ type: 'registered', sessionId: msg.sessionId, features: ['exact-send-v1', 'pair-consent-v1'] }));
      if (msg.type === 'pair_list') socket.write(Buffer.concat([
        frame({ type: 'pair_list_result', requestId: msg.requestId, items: snapshot }),
        frame({ type: 'pair_update', status: update }),
      ]));
    }, () => socket.destroy()));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return server;
}

// Mirrors the extension: snapshot and updates both go through client events.
async function connectRuntime(self: string, peer: string) {
  const runtime = new Runtime(self, async () => ({ outcome: 'accepted' }));
  const held = { id: randomUUID(), exchange: randomUUID(), subject: 'Held', text: 'WITHHELD_BEFORE_APPROVAL', refs: [], replyTo: null, corrects: null, createdAt: new Date().toISOString() };
  runtime.receive(peer, held);
  const client = new IntercomClient(); client.on('error', () => undefined);
  client.on('pair_snapshot', (items: any[]) => runtime.replacePairs(items));
  client.on('pair_update', (status: any) => runtime.syncPairStatus(status));
  await client.connect({ name: 'A', cwd: root, model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), pairConsentV1: true, runtimeId: randomUUID() }, self);
  await client.listPairs();
  return { runtime, client, held };
}

test('F11: an approved snapshot followed by an ended update in one read leaves the pair unapproved', async () => {
  const a = randomUUID(), b = randomUUID();
  const server = await coalesced([{ peer: b, mode: 'remembered', revision: 1, context: 'Review' }], { peer: b, mode: 'none', revision: 2, reason: 'ended' });
  const { runtime, client, held } = await connectRuntime(a, b);
  try {
    assert.equal(runtime.isApproved(b), false, 'a stale snapshot cannot restore an ended approval');
    // Wire order: the approval was current when the broker sent the snapshot, so it
    // legitimately made held history readable (F10: past access stays readable).
    assert.equal((runtime.inspect({ message: held.id }) as any).evidence, 'available');
  } finally { await client.disconnect(); await new Promise(r => server.close(r)); }
});

test('F11: an empty snapshot followed by a new approval in one read keeps the approval', async () => {
  const a = randomUUID(), b = randomUUID();
  const server = await coalesced([], { peer: b, mode: 'session', revision: 3, context: 'Review' });
  const { runtime, client } = await connectRuntime(a, b);
  try {
    assert.equal(runtime.isApproved(b), true, 'the snapshot cannot erase a later approval');
  } finally { await client.disconnect(); await new Promise(r => server.close(r)); }
});
