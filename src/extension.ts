import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Runtime, NESTED_HANDOFF, type Entry } from './runtime.ts';
import { NativeSessionRecords, RECORD_TYPE, isRecoveryEvent, type NativeEntry } from './session-records.ts';
import { Asks, type AskItem } from './ask.ts';
import { modelView } from './model-view.ts';
import { peerActivity, requestOutcomeLabel, messageContextLines } from './communication-view.ts';
import { Id, EnvelopeSchema, MessageInput, AskInput, PeersInput, InspectInput, Output, validate } from './schema.ts';
import { sendExactSession } from './transport/send.ts';
import { connect } from './transport/start.ts';
import { IntercomClient } from './transport/broker/client.ts';
import { randomUUID } from 'node:crypto';
import { PAIR_APPROVAL_FEATURE, DURABLE_MAILBOX_FEATURE, type BrokerRuntimeInfo, type SessionInfo, type PairStatus, type Message as WireMessage } from './transport/types.ts';
import { registerInlineCards, type CardMessage } from './inline-card.ts';
import { approvalPrompt, contactDecisionTitle, explicitApprovalTitle, CONTACT_SESSION, CONTACT_REMEMBER, CONTACT_CHOICES, CONTACT_GRANT_CHOICES, admissionDecisionStorageNotice, showInspection } from './human-view.ts';
import { getAgentDirPath, getBrokerConnectTarget, getBrokerPidFilePath, getIntercomDirPath } from './transport/broker/paths.ts';
import { INTERCOM_PACKAGE_VERSION, isBrokerVersionOlder, readBrokerArtifactVersion, readBrokerPidMetadata, verifyBrokerProcess } from './transport/broker/runtime-claim.ts';
import { serveOrganizerApi, type OrganizerApi } from './organizer-api.ts';

const RESET = 'One approval covers both directions of an exact session pair. "This session" lasts until either Pi session reloads or the broker restarts; "remember" survives restarts until either side runs /comms revoke. Native Pi records retain communication history and Pause. Approved exact offline peers can receive durable async mail; asks remain live-only. No automatic new-ID replay.';
const HELP = 'Stop ends the current run; later peers may wake it. Pause holds peer admission/wakes, not current work or already-posted content. /comms approve | revoke | pause | resume | status | inspect | requests';
const errorCode = (error: unknown, fallback = 'TARGET_UNAVAILABLE') =>
  (error instanceof Error ? error.message : String(error)).split(':')[0]?.trim() || fallback;

export function formatBrokerOutdatedError(
  info: BrokerRuntimeInfo | undefined,
  sessionVersion: string = INTERCOM_PACKAGE_VERSION,
  diskVersion?: string,
  intercomDir: string = getIntercomDirPath(),
): string {
  const pidPath = getBrokerPidFilePath(intercomDir);
  const fallback = readBrokerPidMetadata(pidPath);
  const candidatePid = info?.pid !== undefined && (fallback.pid === undefined || info.pid === fallback.pid)
    ? info.pid
    : info?.pid === undefined
      ? fallback.pid
      : undefined;
  const verifiedPid = candidatePid !== undefined && verifyBrokerProcess(candidatePid, intercomDir) ? candidatePid : undefined;
  const versionText = info?.packageVersion ? `v${info.packageVersion}` : 'version unreported (pre-0.1.11)';
  const startedText = info?.startedAt
    ? `started ${new Date(info.startedAt).toISOString()}`
    : fallback.mtimeMs
      ? `pid-file timestamp ${new Date(fallback.mtimeMs).toISOString()}`
      : 'start time unknown';
  if (verifiedPid !== undefined) {
    if (diskVersion && isBrokerVersionOlder(diskVersion, sessionVersion)) {
      return `BROKER_OUTDATED: running broker (pid ${verifiedPid}, ${versionText}, ${startedText}) and on-disk broker (v${diskVersion}) are older than this session (v${sessionVersion}); ask the user to update the installed pi-comms package and then stop broker pid ${verifiedPid} (kill ${verifiedPid}) so sessions reconnect to the updated broker`;
    }
    return `BROKER_OUTDATED: running broker (pid ${verifiedPid}, ${versionText}, ${startedText}) is older than this session (v${sessionVersion}); ask the user to stop broker pid ${verifiedPid} (kill ${verifiedPid}) so connected sessions reconnect and start the${diskVersion ? ` v${diskVersion}` : ' current'} broker`;
  }
  const unverifiedText = fallback.pid !== undefined ? `unverified broker.pid ${fallback.pid}` : `no verified broker.pid at ${pidPath}`;
  return `BROKER_OUTDATED: running broker (${unverifiedText}, ${versionText}, ${startedText}) is older than this session (v${sessionVersion}); broker.pid could not be verified as this pi-comms broker, so do not kill it blindly — ask the user to inspect the process holding ${JSON.stringify(getBrokerConnectTarget())} or reload older Pi sessions`;
}

const recovery: Record<string, string> = {
  CONTACT_NOT_APPROVED: 'Contact is not approved. Nothing was sent. Do not retry in this turn; if the contact is still needed, tell the user. You may ask again after their next message, or they can use /comms approve.',
  CONTACT_APPROVAL_REQUIRED: 'No message was sent. Contact needs a human confirmation UI; open /comms approve in an interactive session.',
  AMBIGUOUS_PEER: 'Choose one of the listed native IDs; no message was sent. Exact names must be unique.',
  BROKER_OUTDATED: 'The shared broker lacks a required pi-comms capability. Nothing was sent. Restarting this session alone may not replace a broker held open by other sessions. Ask the user to follow the broker details above (stop a verified PID or inspect an unverified holder); update the installed package when needed.',
  PEER_OUTDATED: 'The colleague runs an older pi-comms without the required shared communication protocol. Nothing was sent. Ask the user to update pi-comms in that session and reload it, then try again.',
  MAILBOX_FULL: 'The offline mailbox is full; this new message was rejected, not queued. Wait for delivery/expiry or ask the user to address capacity. Do not substitute a different peer.',
  MAILBOX_UNREADABLE: 'The broker cannot trust its saved mailbox state, so it rejected this new message. Preserve the unreadable file, repair storage and restart the broker; no automatic resend.',
  MAILBOX_SAVE_FAILED: 'The broker could not confirm the offline write. Treat the result as uncertain if storage may have committed; inspect the original message ID before any retry.',
  E_DELIVERY_EXPIRED: 'The older queued message expired. Do not assume the colleague saw it; tell the user if the work is still needed.',
  E_TARGET_DISCONNECTED: 'The exact peer is offline. Live-only asks are not queued; try again later only on a new user request.',
  E_PAIR_NOT_APPROVED: 'The contact approval ended before delivery. Nothing was delivered. Ask again only if the user still wants this contact.',
  PAIR_SAVE_FAILED: 'The broker could not save the remembered approval; nothing changed. Choose "Allow this session", or free disk space / fix permissions in the Pi agent directory and try again.',
  CONTACT_CANCELLED: 'The operation was stopped or the session changed. Nothing was sent. Wait for the user to continue.',
  CONTEXT_LOST: 'Linkage/evidence is unavailable in this exact saved session. Inspect available records; never invent a return handle or silently replace the colleague.',
  IDENTITY_CONFLICT: 'Close the other live process claiming this saved session, then reload.',
  OUTCOME_UNKNOWN: 'Inspect the prior message/outbox. Do not blindly resend; verify through the approved colleague if needed.',
  TARGET_UNAVAILABLE: 'The exact session is unavailable. Resume it or try again later; do not substitute a similar name.',
  PERSISTENCE_FAILED: 'The native session save failed. Inspect the outbox before any retry. Repair the session storage and reload; a live Pause or revoke may not yet be saved.',
  RECOVERY_BLOCKED: 'Communication is held because saved state is incomplete. Verified history remains inspectable. Preserve and repair the native session file, then reload; do not resend uncertain work.',
  INVALID_INPUT: 'Follow the specific validation message above. Supply only fields needed for this operation; never fabricate IDs to fill optional fields. If the tool interface still forces optional fields, stop retrying and report the provider schema issue.',
};

export default function comms(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let client: IntercomClient | undefined;
  let runtime: Runtime | undefined;
  let records: NativeSessionRecords | undefined;
  let asks: Asks | undefined;
  const askStops = new Map<string, AbortController>();
  const pendingSavedReceipts = new Set<string>();
  let lastReceiptScanAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let active = false;
  let wakeReserved = false;
  let connecting: Promise<void> | undefined;
  let connectionError: string | undefined;
  let connectionErrorDetail: string | undefined;
  let approvalDialog = false;
  let stopped = true;
  let nextReconnect = 0;
  let reconnectDelay = 1000;
  const declined = new Set<string>();
  const localPairDecisions = new Set<string>();
  let runtimeId = randomUUID(); // Session-only pair approvals last for this runtime.
  const peerNames = new Map<string, string>();
  const prompted = new Set<string>();
  let dialogTail: Promise<unknown> = Promise.resolve();
  const contactStops = new Map<string, AbortController>();
  let lifetime = new AbortController();
  let lastWidget: string | undefined | null = null;
  let lastStatus: string | undefined;
  let lastPresenceSentAt = 0;
  registerInlineCards(pi);
  serveOrganizerApi(pi.events, () => {
    const current = runtime;
    if (!current || stopped) return undefined;
    const activeRuntime = () => {
      if (stopped || runtime !== current || ctx?.sessionManager.getSessionId() !== current.self) throw new Error('CONTEXT_LOST: organizer API belongs to an earlier Pi session');
    };
    const api: OrganizerApi = Object.freeze({
      version: 1, sessionId: current.self,
      peers: async (input = {}) => (await run(async () => {
        validate(PeersInput, input); const found = await peers(input.view, input.cursor); activeRuntime(); return found;
      }, false, activeRuntime)).structuredContent,
      send: async (input, signal) => (await run(() => sendApproved(input, signal), false, activeRuntime)).structuredContent,
      inspect: async input => (await run(() => inspectCommunication(input, activeRuntime), false, activeRuntime)).structuredContent,
    });
    return api;
  });
  // Cancelling an outgoing request is transient, not a durable peer refusal.
  pi.on('input', event => { if (event.source !== 'extension') { declined.clear(); endAsks('interrupted'); } });
  function endAsks(reason: Parameters<Asks['end']>[0], peer?: string) {
    asks?.end(reason, undefined, peer);
    if (!peer) for (const stop of askStops.values()) stop.abort();
  }
  function admitAsks() {
    if (!runtime || !asks) return;
    if (runtime.holdReason()) return endAsks('interrupted');
    if (runtime.paused) return endAsks('paused');
    if (ctx?.hasPendingMessages() || (ctx?.hasUI && ctx.ui.getEditorText().length)) return endAsks('interrupted');
    if (!approvalDialog) asks.admit();
  }
  async function approveContact(id: string, label: string, work: string, text: string, direction: 'send' | 'receive', signal?: AbortSignal, explicit = false) {
    const current = runtime, context = ctx;
    if (!current || !context || lifetime.signal.aborted || signal?.aborted) throw new Error('CONTACT_CANCELLED');
    current.assertOperational();
    if (current.isApproved(id)) return;
    if (!context.hasUI) throw new Error('CONTACT_APPROVAL_REQUIRED');
    if (direction === 'send' && declined.has(id) && !explicit) throw new Error('CONTACT_NOT_APPROVED');
    const stop = contactStops.get(id) ?? new AbortController(); contactStops.set(id, stop);
    await withDialog(async abort => {
      if (runtime !== current || stopped) throw new Error('CONTACT_CANCELLED');
      if (current.isApproved(id)) return;
      if (direction === 'send' && declined.has(id) && !explicit) throw new Error('CONTACT_NOT_APPROVED');
      if (direction === 'receive') prompted.add(id);
      const prompt = approvalPrompt(id, label, work, text, direction);
      const choice = await context.ui.select(contactDecisionTitle(prompt.title, prompt.message), CONTACT_CHOICES, { signal: abort });
      if (abort.aborted || runtime !== current || stopped) throw new Error('CONTACT_CANCELLED');
      // Decline and Esc both mean "not approved". Nothing is stored; the agent
      // may ask again after the user's next input.
      if (choice !== CONTACT_SESSION && choice !== CONTACT_REMEMBER) { declined.add(id); throw new Error('CONTACT_NOT_APPROVED'); }
      const mode = choice === CONTACT_REMEMBER ? 'remembered' : 'session';
      // The broker commits one unordered A-B approval before either side uses it.
      const state = await submitPairDecision(id, mode, work.trim().slice(0, 300));
      current.syncPairStatus(state, label);
      declined.delete(id);
      context.ui.notify(`Contact with ${label} allowed${mode === 'remembered' ? ' and remembered for this pair' : ' for this session'}.`, 'info');
    }, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
  }
  async function submitPairDecision(peer: string, mode: 'session' | 'remembered' | 'none', work: string) {
    await ensureConnection();
    localPairDecisions.add(peer);
    try { return await client!.decidePair(peer, mode, work); }
    finally { localPairDecisions.delete(peer); }
  }
  function cancelContact(id: string) { contactStops.get(id)?.abort(); contactStops.set(id, new AbortController()); }
  async function withDialog<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = runtime;
    const abort = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('CONTACT_CANCELLED'));
      if (abort.aborted) cancel(); else abort.addEventListener('abort', cancel, { once: true });
    });
    const operation = dialogTail.catch(() => {}).then(async () => {
      if (abort.aborted || stopped || runtime !== owner) throw new Error('CONTACT_CANCELLED');
      approvalDialog = true; asks?.approvalDialog(true);
      try { return await work(abort); }
      finally { if (runtime === owner) { approvalDialog = false; asks?.approvalDialog(false); admitAsks(); status(); } }
    });
    dialogTail = operation.catch(() => {});
    try { return await Promise.race([operation, cancelled]); }
    finally { abort.removeEventListener('abort', cancel); }
  }
  function contactRequests() {
    const requests = new Map<string, { name: string; subject: string; text: string }>();
    if (!runtime) return [...requests.entries()];
    for (const id of runtime.waiting) {
      const entry = runtime.entry(id)!;
      if (entry.intake !== 'waiting') continue; // Ambiguous admission is not another permission request.
      const message = entry.message;
      if (!runtime.isApproved(message.from) && !requests.has(message.from)) requests.set(message.from, { name: name(message.from), subject: message.subject, text: message.text });
    }
    return [...requests.entries()];
  }
  function offerIncoming() {
    if (!ctx?.hasUI || !runtime || runtime.holdReason() || approvalDialog || runtime.paused || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().length) return;
    const request = contactRequests().find(([id]) => !prompted.has(id));
    if (!request) return;
    const [id, peer] = request; prompted.add(id);
    void approveContact(id, peer.name, peer.subject, peer.text, 'receive').catch(error => {
      if (!stopped) ctx?.ui.notify(error instanceof Error && error.message === 'CONTACT_NOT_APPROVED' ? `Contact not approved. Messages from ${peer.name} remain held for you, not the agent. /comms requests reopens the decision.` : String(error), 'info');
    });
  }
  function hold() {
    if (runtime?.holdReason()) return 'recovery';
    if (runtime?.paused) return 'paused';
    if (approvalDialog || ctx?.hasPendingMessages() || (ctx?.hasUI && ctx.ui.getEditorText().length)) return 'human-pending';
    if (ctx && !ctx.isIdle()) return 'busy';
    return null;
  }
  function publishActivity(force = false) {
    if (!client?.isConnected()) return;
    const now = Date.now(); if (!force && now - lastPresenceSentAt < 60_000) return;
    client.updatePresence({ status: active ? 'working' : 'idle' }); lastPresenceSentAt = now;
  }
  function status() {
    if (!ctx || !runtime) return;
    const unapproved = runtime.waiting.filter(id => { const entry = runtime!.entry(id)!; return entry.intake === 'waiting' && !runtime!.isApproved(entry.message.from); }).length;
    const pending = runtime.pendingCounts();
    const hints = [
      unapproved ? `${unapproved} message(s) held for contact approval · /comms requests to review · /comms inspect for full content` : '',
      pending.uncertain ? `${pending.uncertain} uncertain message(s) need your choice: deliver again (possible duplicate) or dismiss · /comms requests` : '',
    ].filter(Boolean);
    const widget = runtime.holdReason() ? `Communication held: ${runtime.holdReason()} /comms inspect retains available history.` : hints.join('\n') || undefined;
    if (widget !== lastWidget) { ctx.ui.setWidget('comms-requests', widget ? [widget] : undefined); lastWidget = widget; }
    const line = `${runtime.paused ? 'Paused' : 'Receiving'} · ${pending.waiting} waiting${pending.uncertain ? ` · ${pending.uncertain} uncertain` : ''}${unapproved ? ` (${unapproved} unapproved)` : ''} · ${runtime.holdReason() ? 'recovery hold' : connectionError ?? hold() ?? 'ready'}${records?.info().state === 'volatile' ? ' · live-only records' : ''}`;
    if (line !== lastStatus) { ctx.ui.setStatus('comms', line); lastStatus = line; }
  }
  function name(id: string) { return id === runtime?.self ? ctx?.sessionManager.getSessionName() ?? 'You' : peerNames.get(id) ?? runtime?.known().find(p => p.id === id)?.name ?? id; }
  function card(entry: Entry, reportNote = ''): CardMessage {
    const m = entry.message; const kinds = entry.facts.map(f => f.kind);
    const fact = kinds.includes('saved') ? 'saved' : kinds.includes('handed-off') ? 'handed-off' : kinds.includes('posted') ? 'posted' : kinds.includes('queued') ? 'queued' : 'unknown';
    return { id: m.id, from: name(m.from), to: name(m.to), subject: m.subject, workRef: m.workRef, recipientLabel: m.recipientLabel, handoverFrom: m.handoverFrom, report: m.report, structured: m.structured, reportLinkage: entry.reportLinkage, text: (entry.linkage ? 'Context lost: referenced request is unavailable; do not infer restored linkage.\n' : '') + reportNote + m.text + m.refs.map(r => `\n${r.label}: ${r.uri}`).join(''), exchange: m.exchange, replyTo: m.replyTo, corrects: m.corrects, at: m.createdAt, fact };
  }
  function pump(busyBoundary = false) {
    if (!ctx || !runtime || runtime.holdReason() || runtime.paused || approvalDialog || ctx.hasPendingMessages() || (ctx.hasUI && ctx.ui.getEditorText().length)) return;
    if (busyBoundary ? !active || ctx.isIdle() : !ctx.isIdle() || wakeReserved) return;
    const current = runtime;
    const ids: string[] = []; let bytes = 0;
    for (const id of current.eligible()) {
      if (asks?.claimed(id)) continue;
      const entry = current.entry(id)!; const size = Buffer.byteLength(JSON.stringify(entry));
      if (ids.length && bytes + size > 900_000) break;
      ids.push(id); bytes += size;
    }
    if (!ids.length) return;
    const plan = current.planIntake(ids);
    try {
      if (!plan.deliver.length) { current.summarized(plan.summarized); status(); return; }
      const entries = plan.deliver, deliveredIds = entries.map(entry => entry.message.id);
      const content = entries.map(e => `From ${name(e.message.from)} · ${e.message.subject}\n${messageContextLines(e.message).map(line => `${line}\n`).join('')}${e.linkage ? 'Context lost: referenced request unavailable.\n' : ''}${e.reportLinkage ? 'Reported request is unavailable; work report link unverified.\n' : ''}${e.message.corrects ? `Correction to message ${e.message.corrects}\n` : ''}${current.reportNote(e)}${e.message.text}${e.message.refs.map(r => `\n${r.label}: ${r.uri}`).join('')}\n\nMessage ID: ${e.message.id} (use as report.request when reporting on this request)\nReply with respondTo: "${e.returnHandle}" (reusable)`).join('\n\n---\n\n');
      // Save the attempt before crossing the host boundary. If posting or its
      // confirmation is interrupted, recovery holds it instead of guessing.
      current.offered(deliveredIds);
      if (!busyBoundary) wakeReserved = true;
      pi.sendMessage({ customType: 'comms_batch', display: true, content,
        details: { owner: current.self, messages: entries.map(e => ({ ...card(e, current.reportNote(e)), fact: 'posted' })), ids: deliveredIds } },
        busyBoundary ? { deliverAs: 'steer' } : { triggerTurn: true });
      // pi.sendMessage() can only queue a steer. It does NOT confirm that Pi
      // admitted this batch: queued items can be interrupted or cleared.
      // Keep the offer uncertain until a matching native Pi entry appears.
      current.summarized(plan.summarized);
    } catch (error) { wakeReserved = false; ctx.ui.notify(`pi-comms could not confirm batch admission: ${String(error)}. Inspect before repeating work.`, 'error'); }
    status();
  }
  async function ensureConnection() {
    if (!ctx || !runtime || stopped) throw new Error('TARGET_UNAVAILABLE');
    runtime.assertOperational();
    if (client?.isConnected()) return;
    if (connecting) return connecting;
    const current = runtime, context = ctx;
    connecting = (async () => {
      const candidate = new IntercomClient();
      candidate.on('error', () => undefined);
      candidate.on('disconnected', () => { if (client === candidate) { endAsks('disconnected'); connectionError = 'offline; reconnecting'; connectionErrorDetail = undefined; nextReconnect = Date.now() + 1000; status(); } });
      candidate.on('presence_update', (peer: SessionInfo) => { if (runtime === current && !stopped) peerNames.set(peer.id, peer.name ?? peer.id); });
      candidate.on('pair_update', (state: PairStatus) => {
        if (runtime !== current || stopped) return;
        const wasApproved = current.isApproved(state.peer);
        try { current.syncPairStatus(state, name(state.peer)); }
        catch (error) { context.ui.notify(`Pair contact state could not be applied: ${String(error)}`, 'warning'); return; }
        if (state.mode === 'none' && state.reason === 'ended') {
          // An owner ended the contact: no automatic re-prompt until the user's next input.
          endAsks('revoked', state.peer);
          if (!localPairDecisions.has(state.peer)) cancelContact(state.peer);
          declined.add(state.peer); prompted.add(state.peer);
        } else if (wasApproved && state.mode === 'none') endAsks('disconnected', state.peer);
        status();
      });
      candidate.on('pair_snapshot', (items: PairStatus[]) => {
        if (runtime !== current || stopped) return;
        try { current.replacePairs(items, name); }
        catch (error) { context.ui.notify(`Pair contact state could not be applied: ${String(error)}`, 'warning'); }
      });
      candidate.on('message', (from: SessionInfo, wire: WireMessage) => {
        if (runtime !== current || stopped) return;
        try {
          const envelope = JSON.parse(wire.content.text ?? ''); validate(EnvelopeSchema, envelope);
          if (envelope.id !== wire.id) throw new Error('INVALID_INPUT: envelope ID mismatch');
          const fresh = current.receive(from.id, envelope);
          // Modern pair consent is a broker decision, never transported message metadata.
          peerNames.set(from.id, from.name ?? from.id);
          if (fresh && !current.isApproved(from.id)) context.ui.notify(`Contact request from ${from.name ?? from.id}: ${envelope.subject}. Held for you, not the agent. Approval appears when idle; /comms requests to review.`, 'info');
          // Native Pi may buffer a fresh session's custom entry before its
          // first conversation. Keep broker responsibility until it really saves.
          const saved = current.isSavedIncoming(wire.id);
          if (saved) pendingSavedReceipts.delete(wire.id);
          else pendingSavedReceipts.add(wire.id);
          candidate.sendMessageReceipt({ messageId: wire.id, status: saved ? 'receiver_recorded' : 'queued', timestamp: Date.now() });
          admitAsks(); status();
        } catch (error) { context.ui.notify(`pi-comms held or rejected incoming message: ${String(error)}`, 'warning'); status(); }
      });
      try {
        const brokerURL = new URL('./transport/broker/broker.js', import.meta.url);
        await connect(current.self, { name: context.sessionManager.getSessionName() ?? current.self, cwd: context.cwd, model: context.model?.id ?? 'unknown', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), pairConsentV1: true, durableMailboxV1: true, runtimeId }, candidate, brokerURL);
        if (!candidate.supportsFeature(PAIR_APPROVAL_FEATURE) || !candidate.supportsFeature(DURABLE_MAILBOX_FEATURE)) {
          throw Error(formatBrokerOutdatedError(candidate.brokerInfo, INTERCOM_PACKAGE_VERSION, readBrokerArtifactVersion(brokerURL)));
        }
        // The pair_snapshot handler replaces the cache: approvals may have ended while offline.
        await candidate.listPairs();
        if (runtime !== current || stopped) { await candidate.disconnect(); return; }
        client = candidate; candidate.updatePresence({ name: context.sessionManager.getSessionName() ?? current.self, status: active ? 'working' : 'idle' }); lastPresenceSentAt = Date.now();
        connectionError = undefined; connectionErrorDetail = undefined; reconnectDelay = 1000; status();
      } catch (error) {
        await candidate.disconnect();
        if (runtime !== current || stopped) throw new Error('CONTEXT_LOST');
        const reason = error instanceof Error ? error.message : String(error);
        const isOutdated = errorCode(error) === 'BROKER_OUTDATED';
        connectionError = (error as { code?: string }).code === 'E_SESSION_HELD' ? 'IDENTITY_CONFLICT' : isOutdated ? 'BROKER_OUTDATED' : 'TARGET_UNAVAILABLE';
        connectionErrorDetail = isOutdated ? reason : undefined;
        nextReconnect = Date.now() + reconnectDelay; reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        status(); throw new Error(isOutdated ? reason : connectionError);
      }
    })().finally(() => { if (runtime === current) connecting = undefined; });
    return connecting;
  }
  function observeSaved(owner = runtime, log = records, entries?: NativeEntry[]) {
    if (!owner || !log) return;
    // Only the real native file proves a disk save. Pi's in-memory session
    // entries can prove a live host append, but not restart durability.
    const native = entries ?? log.nativeEntries();
    if (log.info().state === 'blocked') {
      owner.holdRecovery(log.info().reason ?? 'Native session recovery failed');
    }
    const savedIds = new Set(native.map(entry => entry.id).filter((id): id is string => !!id));
    for (const entry of native) {
      if (entry.type === 'custom' && entry.customType === RECORD_TYPE) {
        const data = entry.data as { version?: number; owner?: string; scope?: string; event?: unknown } | undefined;
        if (data?.version === 1 && data.owner === owner.self && data.scope === log.scope && isRecoveryEvent(data.event) && data.event.kind === 'message') owner.observedRecord(data.event.entry.message);
      }
      if (entry.type === 'custom_message' && entry.customType === 'comms_batch') {
        const details = entry.details as { owner?: string; ids?: string[] } | undefined;
        if (details?.owner && details.owner !== owner.self) continue;
        const ids = Array.isArray(details?.ids) ? details.ids.filter(id => typeof id === 'string') : [];
        if (entry.id) owner.observedNative(ids, entry.id, 'batch', true);
      }
      if (entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === 'comms_ask') {
        const details = entry.message.details as { data?: { items?: AskItem[] } } | undefined;
        const items = details?.data?.items;
        if (Array.isArray(items) && entry.id) owner.observedNative(items.flatMap(item => typeof item?.reply === 'string' ? [item.reply] : []), entry.id, 'ask', true);
      }
    }
    if (log.info().state === 'blocked' || !ctx || ctx.sessionManager.getSessionId() !== owner.self) return;
    for (const entry of ctx.sessionManager.getEntries() as unknown as NativeEntry[]) {
      // An actually appended host entry may still be live-only in a fresh or
      // ephemeral session. Do not label it saved or claim model consumption.
      if (entry.type !== 'custom_message' || entry.customType !== 'comms_batch' || !entry.id || savedIds.has(entry.id)) continue;
      const details = entry.details as { owner?: string; ids?: string[] } | undefined;
      if (details?.owner && details.owner !== owner.self) continue;
      const ids = Array.isArray(details?.ids) ? details.ids.filter(id => typeof id === 'string') : [];
      owner.observedNative(ids, entry.id, 'batch', false);
    }
  }
  // When Pi later flushes an initially volatile session, upgrade the receipt
  // without another broker offer, user prompt, or message ID.
  function flushSavedReceipts(now = Date.now()) {
    const owner = runtime, log = records, currentClient = client;
    if (!pendingSavedReceipts.size || !owner || !log || !currentClient?.isConnected() ||
        now - lastReceiptScanAt < 1000) return;
    lastReceiptScanAt = now;
    observeSaved(owner, log);
    for (const id of pendingSavedReceipts) {
      if (!owner.isSavedIncoming(id)) continue;
      try {
        currentClient.sendMessageReceipt({ messageId: id, status: 'receiver_recorded', timestamp: now });
        pendingSavedReceipts.delete(id);
      } catch { /* Same-ID broker reoffer on reconnect remains safe. */ }
    }
  }
  async function stopRuntime() {
    stopped = true; endAsks('context-lost'); lifetime.abort(); records?.close();
    if (timer) clearInterval(timer); timer = undefined;
    const old = client; client = undefined; runtime = undefined; records = undefined; asks = undefined; ctx = undefined; connecting = undefined;
    active = false; wakeReserved = false; approvalDialog = false; lastPresenceSentAt = 0;
    pendingSavedReceipts.clear(); lastReceiptScanAt = 0;
    askStops.clear(); contactStops.clear(); declined.clear(); localPairDecisions.clear(); prompted.clear(); peerNames.clear(); dialogTail = Promise.resolve();
    lastWidget = null; lastStatus = undefined; connectionError = undefined; connectionErrorDetail = undefined; nextReconnect = 0; reconnectDelay = 1000;
    await old?.disconnect();
  }
  pi.on('session_start', async (_event, context) => {
    await stopRuntime();
    ctx = context; stopped = false; lifetime = new AbortController();
    const self = context.sessionManager.getSessionId();
    runtimeId = randomUUID();
    const log = new NativeSessionRecords(self, getAgentDirPath(), {
      getSessionId: () => context.sessionManager.getSessionId(), getSessionFile: () => context.sessionManager.getSessionFile(),
      getEntries: () => context.sessionManager.getEntries() as unknown as NativeEntry[],
      append: (type, data) => pi.appendEntry(type, data),
    });
    const current = new Runtime(self, async (id, envelope, policy) => {
      if (runtime !== current || stopped) return { outcome: 'rejected', code: 'CONTEXT_LOST' };
      try { await ensureConnection(); }
      catch (error) { return { outcome: 'rejected', code: errorCode(error) }; }
      if (runtime !== current || stopped || !client) return { outcome: 'rejected', code: 'CONTEXT_LOST' };
      return sendExactSession(client, current.isApproved, id, envelope, policy);
    }, log.append);
    runtime = current; records = log;
    const restored = log.load();
    current.restore(restored.events, log.info().state === 'saved' ? 'saved' : 'volatile');
    observeSaved(current, log, restored.native);
    asks = new Asks(current);
    const note = current.holdReason() ? `Communication held: ${current.holdReason()}` : restored.events.length ? 'Saved communication restored. Contact approval still requires current consent.' : restored.legacy ? 'Earlier native messages remain in Pi history; their old memory-only reply handles cannot be reconstructed.' : 'First contact asks for your approval.';
    context.ui.notify(`pi-comms ready. ${note}\n${RESET}\nStop ends a run; /comms pause holds peer messages. /comms shows status.`, current.holdReason() ? 'warning' : 'info');
    if (!current.holdReason()) try { await ensureConnection(); } catch { /* Tools/status expose the connection failure. */ }
    if (stopped || ctx !== context) return;
    timer = setInterval(() => {
      if (runtime !== current || stopped) return;
      if (!current.holdReason() && !client?.isConnected() && !connecting && Date.now() >= nextReconnect) void ensureConnection().catch(() => undefined);
      try { publishActivity(); flushSavedReceipts(); offerIncoming(); admitAsks(); pump(); status(); }
      catch (error) { current.holdRecovery(String(error)); status(); }
    }, 150); timer.unref();
    status();
  });
  pi.on('session_info_changed', event => { if (runtime) client?.updatePresence({ name: event.name ?? runtime.self }); });
  pi.on('agent_start', () => { active = true; wakeReserved = false; publishActivity(true); });
  pi.on('agent_end', () => { active = false; publishActivity(true); endAsks('interrupted'); observeSaved(); status(); });
  pi.on('agent_settled', () => { wakeReserved = false; });
  pi.on('turn_end', event => { if (event.message.role === 'assistant' && event.message.stopReason !== 'aborted' && event.message.stopReason !== 'error') pump(true); });
  pi.on('session_shutdown', stopRuntime);
  async function resolvePeer(target: string) {
    try { validate(Id, target); return target; } catch { /* Otherwise resolve a current exact name. */ }
    await ensureConnection();
    const matches = (await client!.listSessions()).filter(peer => peer.id !== runtime!.self && peer.name === target);
    if (matches.length > 1) throw new Error(`AMBIGUOUS_PEER: ${matches.map(peer => `${peer.name} · ${peer.id}`).join('; ')}`);
    if (!matches.length) throw new Error('TARGET_UNAVAILABLE: no current exact-name match');
    peerNames.set(matches[0].id, matches[0].name!); return matches[0].id;
  }
  async function peers(view = 'all', cursor?: string) {
    const owner = runtime;
    if (!owner || stopped) throw new Error('CONTEXT_LOST');
    await ensureConnection();
    if (stopped || runtime !== owner) throw new Error('CONTEXT_LOST');
    const live = (await client!.listSessions()).filter(p => p.id !== owner.self);
    if (stopped || runtime !== owner) throw new Error('CONTEXT_LOST');
    live.forEach(peer => peerNames.set(peer.id, peer.name ?? peer.id));
    const known = owner.known();
    const all = [...new Set([...known.map(p => p.id), ...(view === 'all' ? live.map(p => p.id) : [])])];
    const ranked = all.map(id => {
      const approval = known.find(p => p.id === id); const session = live.find(p => p.id === id);
      return { id, name: session?.name ?? peerNames.get(id) ?? approval?.name ?? id, approved: !!approval, context: approval?.context ?? null, peerLabels: owner.peerLabels(id), presence: session ? 'online' : 'offline', ...peerActivity(session), reason: approval ? 'approved exact-session contact' : 'approval required', cwd: session?.cwd, lastActivity: session?.lastActivity };
    });
    ranked.sort((a, b) => (a.presence === 'offline' ? 2 : a.approved ? 0 : 1) - (b.presence === 'offline' ? 2 : b.approved ? 0 : 1));
    const start = cursor ? ranked.findIndex(p => p.id === cursor) + 1 : 0;
    if (cursor && !start) throw new Error('CONTEXT_LOST');
    const items = ranked.slice(start, start + 30);
    return { items, nextCursor: start + items.length < ranked.length ? items.at(-1)!.id : null, nextAction: !live.length ? 'No reachable pi-comms peers. All participants must load pi-comms and share the broker agent directory. Legacy intercom-only sessions are not bridged. /comms status shows runtime location.' : view === 'known' && !items.length ? 'No approved peers. Omit view to discover online colleagues.' : 'Send to a native ID or exact unique name. First contact asks the requester for approval.' };
  }
  pi.registerCommand('comms', { description: HELP, handler: async (args, commandCtx) => {
    if (!runtime) return commandCtx.ui.notify('pi-comms unavailable', 'error');
    const [action = 'status', id] = args.trim().split(/\s+/);
    if (action === 'pause' || action === 'resume') {
      if (action === 'pause') endAsks('paused');
      try {
        runtime.paused = action === 'pause'; status();
        commandCtx.ui.notify(`${runtime.paused ? 'Reception paused; arrivals remain buffered.' : 'Reception resumed.'} ${records?.info().state === 'volatile' ? 'This control is live-only until Pi saves the session. ' : ''}${HELP}`, 'info');
        if (!runtime.paused) pump();
      } catch (error) { commandCtx.ui.notify(`${String(error)}. Live control: ${runtime.paused ? 'paused' : 'receiving'}; save not confirmed.`, 'error'); status(); }
      return;
    }
    if (action === 'requests') {
      if (!commandCtx.hasUI) return commandCtx.ui.notify('Pending contact and admission decisions require a human confirmation UI; messages remain held.', 'warning');
      const current = runtime;
      observeSaved();
      const requests = contactRequests();
      const uncertain = current.uncertainIncoming();
      const choices = [
        ...requests.map(([peer, request]) => ({ kind: 'contact' as const, peer, label: `Contact · ${request.name} · ${request.subject} · ${peer}` })),
        ...uncertain.map(entry => ({ kind: 'uncertain' as const, id: entry.message.id, peer: entry.message.from,
          label: `Uncertain admission · ${name(entry.message.from)} · ${entry.message.subject} · ${entry.message.id}` })),
      ];
      if (!choices.length) return commandCtx.ui.notify('No contact or uncertain-admission decisions waiting.', 'info');
      try {
        const selected = choices.length === 1 ? choices[0].label :
          await commandCtx.ui.select('Pending communication decisions', choices.map(choice => choice.label));
        if (!selected || runtime !== current || stopped) return;
        const choice = choices.find(item => item.label === selected);
        if (!choice) return;
        if (choice.kind === 'contact') {
          const request = requests.find(([peer]) => peer === choice.peer);
          if (!request) return;
          const [peer, details] = request;
          await approveContact(peer, details.name, details.subject, details.text, 'receive', undefined, true);
          return;
        }
        const entry = current.entry(choice.id!);
        if (!entry || !current.uncertainIncoming().some(item => item.message.id === choice.id)) {
          return commandCtx.ui.notify('Native admission has since been reconciled. Inspect the message before acting.', 'info');
        }
        const deliver = 'Deliver again (may make the agent act twice)';
        const dismiss = 'Dismiss (stop pi-comms redelivery)';
        const actionChoice = await commandCtx.ui.select(`Uncertain admission from ${name(entry.message.from)} · ${entry.message.subject}`,
          [deliver, dismiss, 'Keep unresolved']);
        if (!actionChoice || actionChoice === 'Keep unresolved' || runtime !== current || stopped) return;
        const retry = actionChoice === deliver;
        if (retry && !current.isApproved(entry.message.from)) {
          // Reuse the existing human contact flow; resolving delivery is not
          // a backdoor around a prior refusal or expired approval.
          await approveContact(entry.message.from, name(entry.message.from), entry.message.subject,
            entry.message.text, 'receive', undefined, true);
        }
        let resolved = false;
        let persisted: 'saved' | 'volatile' | 'partial' | undefined;
        await withDialog(async signal => {
          if (runtime !== current || stopped) throw new Error('CONTACT_CANCELLED');
          observeSaved();
          if (!current.uncertainIncoming().some(item => item.message.id === choice.id)) {
            throw new Error('CONTEXT_LOST: native admission has changed; inspect again before deciding');
          }
          const consequence = retry
            ? 'Pi may have already received this message. Delivering it again with the SAME message ID and return handle may make the agent act twice. This is not an outgoing resend.'
            : 'pi-comms will stop offering this message. If Pi still has a previously queued steer, dismissal cannot withdraw it from Pi. The original record stays inspectable.';
          const confirmed = await commandCtx.ui.confirm(retry ? 'Deliver this message again?' : 'Dismiss uncertain message?',
            `${entry.message.subject} · ${entry.message.id}\n\n${consequence}\n\n${admissionDecisionStorageNotice(records?.info().state)}`, { signal });
          if (signal.aborted || runtime !== current || stopped) throw new Error('CONTACT_CANCELLED');
          if (!confirmed) return;
          // A queued steer could have reached native Pi while the human read
          // the warning. Reconcile again before changing the saved intake.
          observeSaved();
          const outcome = current.resolveUncertainFromOwner(choice.id!, retry ? 'retry' : 'dismiss');
          persisted = outcome.record.state;
          resolved = true;
        });
        if (!resolved || runtime !== current || stopped) return;
        status();
        const storageNote = persisted === 'saved'
          ? 'Choice saved in your Pi session.'
          : 'Choice is live-only until Pi saves this session; it may be lost on restart.';
        commandCtx.ui.notify((retry
          ? 'You approved another admission attempt. Original ID retained; duplicate action was possible. Normal Pause, user input and contact approval still govern delivery.'
          : 'Uncertain message dismissed from pi-comms intake. Its history remains inspectable. A pre-existing native Pi steer cannot be recalled.') + ' ' + storageNote, 'info');
        if (retry) pump();
      } catch (error) {
        commandCtx.ui.notify(`${String(error)}. No uncertain message was automatically replayed.`, 'warning');
        status();
      }
      return;
    }
    if (action === 'approve' || action === 'revoke') {
      if (!commandCtx.hasUI) return commandCtx.ui.notify('Contact approval requires a human confirmation UI. No approval was recorded.', 'error');
      try {
        if (action === 'revoke' && id) { validate(Id, id); cancelContact(id); }
        await withDialog(async signal => {
          const current = runtime!;
          const available: Awaited<ReturnType<typeof peers>>['items'] = [];
          if (action === 'approve') {
            let cursor: string | undefined;
            do { const page = await peers('all', cursor); available.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
          }
          const choices = action === 'revoke' ? current.known().map(peer => ({ ...peer, name: name(peer.id) })) : available;
          const labels = choices.map(p => `${p.name} · ${p.id}`);
          const selected = id ?? (await commandCtx.ui.select(`${action === 'approve' ? 'Approve' : 'Revoke'} exact colleague`, labels))?.split(' · ').at(-1);
          if (!selected) return;
          validate(Id, selected);
          if (action === 'revoke') {
            if (await commandCtx.ui.confirm('End this contact?', 'Stops both sessions from sending new messages to each other until someone approves again. Past messages remain readable.', { signal })) {
              if (signal.aborted || runtime !== current) throw new Error('CONTACT_CANCELLED');
              const pair = await submitPairDecision(selected, 'none', '');
              current.syncPairStatus(pair, name(selected));
              endAsks('revoked', selected); cancelContact(selected);
              declined.add(selected); prompted.add(selected); status();
              commandCtx.ui.notify('Contact ended for both sessions.', 'info');
            }
            return;
          }
          const peer = available.find(p => p.id === selected);
          if (!peer || selected === current.self) throw new Error('TARGET_UNAVAILABLE');
          const collaboration = await commandCtx.ui.input('What work is this colleague approved for?'); if (!collaboration?.trim()) return;
          // /comms approve only grants or edits consent. Unlike a first-contact
          // No, Cancel/Esc here never revokes an existing peer or ends its asks.
          const choice = await commandCtx.ui.select(
            explicitApprovalTitle(selected, peer.name, collaboration.trim()), CONTACT_GRANT_CHOICES, { signal });
          if (signal.aborted || runtime !== current || stopped) throw new Error('CONTACT_CANCELLED');
          if (choice !== CONTACT_SESSION && choice !== CONTACT_REMEMBER) return;
          const pair = await submitPairDecision(selected, choice === CONTACT_REMEMBER ? 'remembered' : 'session', collaboration.trim().slice(0, 300));
          current.syncPairStatus(pair, peer.name);
          declined.delete(selected);
          commandCtx.ui.notify(choice === CONTACT_REMEMBER ? 'Contact allowed and remembered for both sessions.' : 'Contact allowed for this session.', 'info');
        });
      } catch (error) { commandCtx.ui.notify(String(error), 'error'); status(); }
      return;
    }
    if (action === 'inspect') {
      const current = runtime;
      if (id !== undefined) {
        try { validate(Id, id); }
        catch { commandCtx.ui.notify('That is not a valid message ID. Use an exact message ID, or /comms inspect with no ID to view waiting messages.', 'warning'); return; }
        if (!current.entry(id)) { commandCtx.ui.notify('That message is not available in this saved session. Older memory-only records cannot be reconstructed. /comms inspect with no ID shows waiting messages.', 'info'); return; }
      }
      observeSaved();
      if (id) await refreshMailEvidence([id]);
      try { await withDialog(signal => showInspection(commandCtx, cursor => id !== undefined ? current.inspect({ message: id }, 'human') : current.inspect({ queue: 'self', ...(cursor ? { cursor } : {}) }, 'human'), { self: current.self, name, approved: current.isApproved }, signal)); }
      catch (error) { commandCtx.ui.notify(String(error), 'info'); }
      return;
    }
    const connectedInfo = client?.isConnected() ? client.brokerInfo : undefined;
    const brokerDetails = connectedInfo ? [
      connectedInfo.pid ? `pid ${connectedInfo.pid}` : '',
      connectedInfo.packageVersion ? `v${connectedInfo.packageVersion}` : '',
      connectedInfo.startedAt ? `started ${new Date(connectedInfo.startedAt).toISOString()}` : '',
    ].filter(Boolean).join(' · ') : '';
    commandCtx.ui.notify(`${HELP}\n${runtime.pendingCounts().waiting} waiting · ${runtime.pendingCounts().uncertain} uncertain · ${runtime.holdReason() ? 'recovery hold' : connectionError ?? hold() ?? 'ready'}\n${runtime.known().map(p => `${name(p.id)} · ${p.id} · ${p.context} · ${p.remembered ? 'remembered until revoked' : 'this runtime only'}`).join('\n')}\n${RESET}\nRecord storage: ${records?.info().state ?? 'volatile'}${runtime.holdReason() ? ` · ${runtime.holdReason()}` : ''}\nBroker: ${JSON.stringify(getBrokerConnectTarget())}${brokerDetails ? ` (${brokerDetails})` : ''}${connectionErrorDetail ? `\n${connectionErrorDetail}` : ''}`, 'info');
  } });
  const result = (data: unknown, error?: { code: string; message: string; nextAction: string }) => {
    const body = { ok: !error, ...(error ? { error, ...(data ? { data } : {}) } : { data }), observedAt: new Date().toISOString() };
    return { content: [{ type: 'text' as const, text: error ? `${error.message}\n${error.nextAction}` : modelView(data, name) }], details: body, structuredContent: JSON.parse(JSON.stringify(body)), ...(error ? { isError: true } : {}) };
  };
  const run = async (work: () => Promise<unknown> | unknown, compact = false, guard?: () => void) => {
    try {
      guard?.(); if (!runtime) throw new Error('TARGET_UNAVAILABLE');
      const data = await work(); const output = result(data);
      if (compact) {
        const sent = data as ReturnType<Runtime['view']>;
        output.content = [{ type: 'text', text: `${sent.delivery === 'queued' ? 'Queued at broker for exact offline peer' : sent.delivery === 'receiver_recorded' ? 'Receiver recorded' : 'Sent'} to ${name(sent.message.to)} · ${sent.message.subject}.${sent.message.workRef ? ` Work: ${sent.message.workRef}.` : ''}${sent.message.recipientLabel ? ` Recipient label (sender-supplied, not authority): ${sent.message.recipientLabel}.` : ''}${sent.message.handoverFrom ? ` Handover from exchange ${sent.message.handoverFrom} (link only, no authority transferred).` : ''}${sent.message.report ? ` Peer reports ${sent.message.report.state} on request ${sent.message.report.request} (not acceptance).` : ''} Replies may arrive later; sending does not prove reading or completion.\nMessage: ${sent.message.id} · Exchange: ${sent.message.exchange}${sent.record.state === 'partial' ? `\n${sent.record.warning}` : sent.record.state === 'volatile' ? '\nCommunication record is live-only until Pi saves this session.' : ''}` }];
      }
      return output;
    } catch (error) {
      status(); const message = error instanceof Error ? error.message : String(error); const code = errorCode(error);
      return result(undefined, { code, message, nextAction: recovery[code] ?? 'Inspect current runtime status with /comms; do not infer delivery or retry an uncertain send.' });
    }
  };
  const renderResult = (value: { details?: unknown; content?: { type: string; text?: string }[] }, _options: unknown, theme: { fg: (color: string, text: string) => string }) => {
    const body = value.details as { ok?: boolean; data?: any; error?: { message: string; nextAction: string } };
    if (typeof body?.ok !== 'boolean') return new Text(value.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') || 'No textual communication result available.', 0, 0);
    const summary = body.data?.timeoutSeconds !== undefined
      ? body.data.items.map((item: AskItem & { response?: { message: { report?: { request: string; state: string } }; reportLinkage?: 'context-lost'; linkage?: 'context-lost' } }) => {
          const report = item.response?.message.report;
          const outcome = `${item.peer ? name(item.peer) : 'Request'} · ${item.subject ?? ''}${item.workRef ? ` · ${item.workRef}` : ''} · ${requestOutcomeLabel(item.outcome)}`;
          if (!report) return outcome;
          const differentRequest = report.request !== item.request ? ` (not this ask${item.request ? ` ${item.request}` : ''})` : '';
          const linkWarning = item.response?.reportLinkage ? ' · Reported request unavailable: link unverified' : '';
          const replyWarning = item.response?.linkage ? ' · Reply link unavailable' : '';
          return `${outcome} · Peer reports ${report.state} on request ${report.request}${differentRequest} (not requester acceptance)${linkWarning}${replyWarning}`;
        }).join('\n')
      : value.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').split('\n').slice(0, 3).join('\n');
    return new Text(body?.ok ? `${summary}${(_options as { expanded?: boolean }).expanded ? `\n${JSON.stringify(body.data, null, 2)}` : '\nCtrl+O expands evidence'}` : theme.fg('error', body?.error ? `${body.error.message}\n${body.error.nextAction}` : 'Communication failed'), 0, 0);
  };
  pi.registerTool({ name: 'comms_peers', label: 'Communication colleagues', description: 'Discover exact colleagues and requester-supplied labels for each collaboration. Reachability is separate from working/idle status; labels are not authority. Approved online peers first; discovery sends nothing. For examples load /skill:pi-comms.', parameters: PeersInput, outputSchema: Output,
    execute: async (_id, input) => run(() => { validate(PeersInput, input); return peers(input.view, input.cursor); }), renderResult });
  async function prepareSend(input: MessageInput, signal?: AbortSignal, item?: AskItem) {
    const current = runtime!; current.assertOperational(); validate(MessageInput, input);
    const resolved = input.to ? { ...input, to: await resolvePeer(input.to) } : input;
    const { to, source } = current.contactFor(resolved);
    if (item) { item.peer = to; item.subject = source?.subject ?? input.subject; item.workRef = source?.workRef ?? input.workRef; }
    if (!current.isApproved(to)) {
      await ensureConnection();
      // Remembered A-B works whichever endpoint sends first after restart.
      if (current.isApproved(to)) return resolved;
      const peer = (await client!.listSessions()).find(p => p.id === to);
      if (!peer || to === current.self) throw new Error('TARGET_UNAVAILABLE');
      await approveContact(to, peer.name ?? to, source?.subject ?? input.subject!, input.text, 'send', signal);
    }
    if (signal?.aborted || runtime !== current) throw new Error('CONTACT_CANCELLED');
    return resolved;
  }
  async function sendApproved(input: MessageInput, signal?: AbortSignal) {
    const current = runtime!;
    const sent = await current.send(await prepareSend(input, signal));
    if (sent.state !== 'accepted') throw new Error(`${sent.code ?? (sent.state === 'unknown' ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE')}: message ${sent.message.id}; inspect outbox for evidence`);
    return sent;
  }
  const guidance = 'Send only necessary requests, questions, findings, corrections or material updates. Skip acknowledgement-only exchanges; stop when the request is satisfied.';
  pi.registerTool({ name: 'comms_message', label: 'Peer message', description: 'Send {to,subject,text,workRef?,recipientLabel?,handoverFrom?,structured?}. For explicit handover, supply earlier exchange ID in handoverFrom on a new request and author the brief; no automatic context or approval transfer. Reply {respondTo,text,structured?,report?}; report:{request:originalMessageId,state:progress|needs-input|blocked|complete} is a peer claim, not work acceptance. Reply inherits workRef; omit to/subject/workRef/recipientLabel. Exact identity and current owner approval still apply after recovery. Unknown send: inspect before retry.', promptGuidelines: [guidance], parameters: MessageInput, outputSchema: Output,
    execute: async (_id, input, signal) => run(() => sendApproved(input, signal), true), renderResult });
  pi.registerTool({ name: 'comms_ask', label: 'Ask colleagues', description: 'Ask 1–30 existing peers: {requests:[{to,subject,text,workRef?,recipientLabel?,handoverFrom?},...],timeoutSeconds?}. Optional workRef groups each exchange; labels describe recipients, not authority. Returns the first linked reply (possibly clarification) or local ending, not work completion. Wait starts after acceptance; late replies remain possible. Restart ends the wait, not the request. Never automatically resend.', promptGuidelines: [guidance], parameters: AskInput, outputSchema: Output,
    execute: async (call, input, signal) => run(async () => {
      validate(AskInput, input);
      const current = runtime!, pending = asks!;
      const seconds = input.timeoutSeconds ?? 60;
      const items: AskItem[] = input.requests.map(() => ({})); pending.open(call, items);
      const stop = new AbortController(); askStops.set(call, stop);
      const abort = signal ? AbortSignal.any([signal, stop.signal, lifetime.signal]) : AbortSignal.any([stop.signal, lifetime.signal]);
      const interrupted = () => pending.end(pending.ended(call) ?? 'interrupted', call);
      abort.addEventListener('abort', interrupted, { once: true }); if (abort.aborted) interrupted();
      try {
        await Promise.all(input.requests.map(async (input, index) => {
          const item = items[index];
          try {
            const resolved = await prepareSend(input, abort, item);
            if (pending.ended(call)) { item.outcome = pending.ended(call); return; }
            if (current.paused) { item.outcome = 'paused'; return; }
            let waiting: Promise<void> | undefined;
            const sending = current.send(resolved, entry => { waiting = pending.register(call, item, entry, seconds); }, 'live_only');
            const dispatched = sending.then(sent => { pending.sent(sent.message.id, sent.state, sent.code); if (runtime === current) admitAsks(); });
            if (waiting) { void dispatched.catch(() => pending.end('unknown', call)); await waiting; } else await dispatched;
          } catch (error) { item.outcome = pending.ended(call) ?? 'not-sent'; item.code = errorCode(error); }
        }));
        return pending.project(call, seconds);
      } finally { abort.removeEventListener('abort', interrupted); if (askStops.get(call) === stop) askStops.delete(call); }
    }), renderResult });
  const admissionFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error, 'PERSISTENCE_FAILED');
    status();
    return result(undefined, { code, message, nextAction: recovery[code] ?? recovery.PERSISTENCE_FAILED });
  };
  pi.on('tool_result', (event, context) => {
    if (event.toolName !== 'comms_ask' || !asks?.has(event.toolCallId)) return;
    if (context.signal?.aborted || approvalDialog) asks.end('interrupted', event.toolCallId);
    admitAsks();
    try {
      if (event.parentToolCallId) asks.present(event.toolCallId, NESTED_HANDOFF);
      return result(asks.project(event.toolCallId, Number(event.input.timeoutSeconds ?? 60)));
    } catch (error) { return admissionFailure(error); }
  });
  pi.on('context', (event, context) => {
    // A queued steer becomes real only after the host appends its native
    // message. Reconcile before the model uses this context.
    observeSaved();
    if (!asks) return;
    if (context.signal?.aborted || approvalDialog) endAsks('interrupted');
    admitAsks();
    return { messages: event.messages.map(message => {
      if (message.role !== 'toolResult' || message.toolName !== 'comms_ask') return message;
      const data = (message.details as { data?: { timeoutSeconds?: number } })?.data;
      if (!asks!.has(message.toolCallId)) {
        const restored = asks!.restoredProjection(data);
        if (restored === undefined) return message;
        const output = result(restored);
        return { ...message, content: output.content, details: output.structuredContent };
      }
      try {
        asks!.present(message.toolCallId);
        const output = result(asks!.project(message.toolCallId, data?.timeoutSeconds ?? 60));
        return { ...message, content: output.content, details: output.structuredContent };
      } catch (error) {
        const output = admissionFailure(error);
        return { ...message, content: output.content, details: output.structuredContent };
      }
    }) };
  });
  async function refreshMailEvidence(ids: string[]) {
    if (!runtime || !client?.isConnected() || !client.supportsFeature(DURABLE_MAILBOX_FEATURE)) return;
    for (let i = 0; i < ids.length; i += 30) {
      try { runtime.updateBrokerEvidence(await client.mailboxEvidence(ids.slice(i, i + 30))); }
      catch { /* No new broker evidence; saved sender observations remain. */ }
    }
  }
  async function inspectCommunication(input: InspectInput, guard: () => void = () => {}) {
    guard(); validate(InspectInput, input);
    const owner = runtime; if (!owner || stopped) throw new Error('CONTEXT_LOST');
    const resolved = input.peer ? { ...input, peer: await resolvePeer(input.peer) } : input;
    guard(); if (stopped || runtime !== owner) throw new Error('CONTEXT_LOST');
    observeSaved();
    const projected = owner.inspect(resolved);
    const ids = new Set<string>();
    if (input.requests) for (const id of input.requests) if (owner.entry(id)?.message.from === owner.self) ids.add(id);
    const visit = (value: any, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 5) return;
      if (value.message?.from === owner.self && typeof value.message.id === 'string') ids.add(value.message.id);
      if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
      else if (depth < 5) for (const [key, item] of Object.entries(value)) if (key !== 'message' && key !== 'text' && key !== 'structured') visit(item, depth + 1);
    };
    visit(projected);
    await refreshMailEvidence([...ids].slice(0, 30));
    guard();
    return { ...owner.inspect(resolved), localTransport: { hold: hold(), connectivity: client?.isConnected() ? 'online' : 'offline' }, recovery: records?.info() };
  }
  pi.registerTool({ name: 'comms_inspect', label: 'Inspect communication', description: 'Inspect without consuming: {} overview; {requests:[messageId,...]} reply progress and current peer report; {workRef:"TICKET"}, {peer}, {exchange}, {message}, {queue:"self"}, {outbox:"self"}. One selector. Saved authorized history remains readable after approval expires; previously withheld content stays hidden. Historical access is not current contact permission. Peer reports are claims, not acceptance.', parameters: InspectInput, outputSchema: Output,
    execute: async (_id, input) => run(() => inspectCommunication(input)), renderResult });
}
