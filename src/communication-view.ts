// One vocabulary for runtime evidence, peer activity and request outcomes.
// Keep transport facts separate from peer-reported work progress.
export const factLabels: Record<string, string> = {
  accepted: 'Accepted by transport',
  queued: 'Buffered in receiver memory',
  posted: 'Posted to Pi',
  saved: 'Observed in native history',
  rejected: 'Rejected',
};

export function observationLabel(entry: { facts?: readonly { kind: string }[]; state?: string }): string {
  const fact = entry.facts?.at(-1);
  if (fact) return factLabels[fact.kind] ?? `Observed: ${fact.kind}`;
  if (entry.state === 'rejected') return 'Rejected before delivery';
  return 'Outcome unknown — check evidence before resending.';
}

// Activity is a host observation, never an assessment of a colleague's task progress.
// Active sessions refresh status every minute; age out after three minutes without an update.
export const ACTIVITY_STALE_MS = 180_000;
export function peerActivity(session?: { status?: string; lastActivity?: number }, now = Date.now()) {
  if (!session) return { activity: 'unknown', activityFreshness: 'unavailable', activityObservedAt: null, lastReportedActivity: null };
  const reported = session.status === 'working' || session.status === 'idle' ? session.status : null;
  const at = session.lastActivity;
  if (!reported || !Number.isFinite(at) || (at ?? 0) <= 0) {
    return { activity: 'unknown', activityFreshness: 'unknown', activityObservedAt: null, lastReportedActivity: null };
  }
  const time = new Date(at!).toISOString();
  if (now - at! > ACTIVITY_STALE_MS) return { activity: 'unknown', activityFreshness: 'stale', activityObservedAt: time, lastReportedActivity: reported };
  return { activity: reported, activityFreshness: 'recent', activityObservedAt: time, lastReportedActivity: reported };
}

export function peerSummary(row: { presence: string; activity?: string; activityFreshness?: string; activityObservedAt?: string | null; lastReportedActivity?: string | null }): string {
  if (row.presence !== 'online') return 'offline · activity unavailable';
  if (row.activityFreshness === 'stale') return `online · activity unknown (last ${row.lastReportedActivity ?? 'status'}: ${row.activityObservedAt}; stale)`;
  if (row.activityFreshness === 'recent') return `online · ${row.activity} (observed ${row.activityObservedAt})`;
  return 'online · activity unknown';
}

export function requestOutcomeLabel(outcome?: string): string {
  switch (outcome) {
    case 'reply-received': case 'replied': return 'Reply received';
    case 'no-reply-yet': return 'No reply yet';
    case 'timeout': return 'No reply before wait ended';
    case 'interrupted': return 'Wait interrupted';
    case 'paused': return 'Reception paused';
    case 'revoked': return 'Contact revoked';
    case 'disconnected': return 'Disconnected';
    case 'context-lost': return 'Context lost';
    case 'not-sent': return 'Not sent';
    case 'rejected': return 'Rejected';
    case 'unknown': return 'Outcome unknown';
    case 'accepted': return 'Accepted by transport';
    default: return outcome ?? 'No outcome observed';
  }
}

export function requestNextAction(outcome?: string): string | undefined {
  switch (outcome) {
    case 'timeout': case 'no-reply-yet': return 'A later reply can still arrive; inspect this request when needed.';
    case 'interrupted': return 'The local wait ended; inspect any later reply before asking again.';
    case 'paused': return 'Resume reception when ready; held replies may then arrive.';
    case 'revoked': return 'Contact is revoked; only the owner can approve it again.';
    case 'disconnected': return 'Check the exact colleague’s presence; do not assume the remote work stopped.';
    case 'unknown': return 'Inspect the outbox and evidence before considering a resend.';
    case 'context-lost': return 'The runtime lost its link; inspect available records before starting a new exchange.';
    case 'rejected': case 'not-sent': return 'Check the error and contact decision before sending a new request.';
    default: return undefined;
  }
}
