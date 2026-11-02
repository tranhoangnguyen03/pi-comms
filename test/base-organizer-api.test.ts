import test from 'node:test';
import assert from 'node:assert/strict';
import { findOrganizerApi, serveOrganizerApi, ORGANIZER_API_CHANNEL, type OrganizerApi, type OrganizerBus } from '../src/organizer-api.ts';

function localBus(): OrganizerBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener); listeners.set(channel, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(channel); };
    },
    emit(channel, data) { for (const listener of listeners.get(channel) ?? []) listener(data); },
  };
}
const api: OrganizerApi = Object.freeze({
  version: 1 as const,
  sessionId: '12345678-1234-1234-1234-123456789abc',
  peers: async () => ({ ok: true, data: { items: [] }, observedAt: new Date().toISOString() }),
  send: async () => ({ ok: false, error: { code: 'CONTACT_NOT_APPROVED', message: 'Explicit owner approval needed', nextAction: 'Ask user' }, observedAt: new Date().toISOString() }),
  inspect: async () => ({ ok: true, data: { items: [] }, observedAt: new Date().toISOString() }),
});
test('organizer discovery shares one in-process API with no new grant or transport', async () => {
  const bus = localBus();
  assert.equal(findOrganizerApi(bus), undefined, 'no pi-comms extension means no service');
  const off = serveOrganizerApi(bus, () => api);
  assert.equal(findOrganizerApi(bus), api);
  assert.deepEqual((await findOrganizerApi(bus)!.peers()).data, { items: [] });
  assert.equal((await findOrganizerApi(bus)!.send({ to: '', subject: '', text: '' })).error?.code, 'CONTACT_NOT_APPROVED');
  off();
  assert.equal(findOrganizerApi(bus), undefined, 'registration lifetime is bounded');
});
test('invalid event payloads and inactive sessions cannot manufacture capabilities', () => {
  const bus = localBus();
  const off = serveOrganizerApi(bus, () => undefined);
  let count = 0;
  for (const payload of [null, {}, { version: 1, accept: true }, { version: 2, accept: () => count++ }])
    bus.emit(ORGANIZER_API_CHANNEL, payload);
  assert.equal(count, 0);
  assert.equal(findOrganizerApi(bus), undefined);
  off();
});
