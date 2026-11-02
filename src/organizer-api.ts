import type { MessageInput, InspectInput } from './schema.ts';
import type { Runtime } from './runtime.ts';

// An in-process discovery channel, not a broker endpoint or a new permission.
// Only extensions installed in the same Pi runtime can use this event bus.
export const ORGANIZER_API_CHANNEL = 'pi-comms:organizer-api:v1';

export type OrganizerResult<T = unknown> = {
  ok: boolean;
  observedAt: string;
  data?: T;
  error?: { code: string; message: string; nextAction: string };
};

export type OrganizerApi = Readonly<{
  version: 1;
  sessionId: string;
  peers: (input?: { view?: 'all' | 'known'; cursor?: string }) => Promise<OrganizerResult>;
  send: (input: MessageInput, signal?: AbortSignal) => Promise<OrganizerResult<ReturnType<Runtime['view']>>>;
  inspect: (input: InspectInput) => Promise<OrganizerResult>;
}>;

export type OrganizerBus = {
  on: (channel: string, listener: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

// Return an API only when pi-comms has an active session. The caller's
// callback runs synchronously on Pi's local event bus; operations are async.
// No user approval, host permission or session identity is supplied by this
// event. The API still uses pi-comms' ordinary checks on every operation.
export function serveOrganizerApi(bus: OrganizerBus, getApi: () => OrganizerApi | undefined) {
  return bus.on(ORGANIZER_API_CHANNEL, data => {
    if (!data || typeof data !== 'object') return;
    const request = data as { version?: unknown; accept?: unknown };
    if (request.version !== 1 || typeof request.accept !== 'function') return;
    const api = getApi();
    if (api) (request.accept as (api: OrganizerApi) => void)(api);
  });
}
