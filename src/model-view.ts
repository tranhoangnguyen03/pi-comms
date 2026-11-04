import { observationLabel, peerSummary, requestOutcomeLabel, requestNextAction, messageContextLines } from './communication-view.ts';
const holdText: Record<string, string> = { busy: 'This session is working; incoming messages are buffered', paused: 'Reception paused; incoming messages are buffered', 'human-pending': 'Human input has priority; incoming messages are buffered', recovery: 'New communication is held; verified history remains inspectable' };
export function modelView(data: any, name: (id: string) => string): string {
  const view = communicationView(data, name);
  const issue = data.recoveryHold ?? (data.recovery?.state === 'blocked' ? data.recovery.reason : undefined);
  const notice = issue
    ? `Recovery hold: ${issue}\nPreserve the native session file and resolve the storage problem before reloading. Do not resend uncertain work.`
    : data.recovery?.state === 'volatile' || data.record?.state === 'volatile'
      ? 'Communication records are live-only until Pi saves this session; no restart guarantee.' : '';
  return notice ? `${view}\n${notice}` : view;
}
function communicationView(data: any, name: (id: string) => string): string {
  const message = (entry: any, detailed = true) => {
    const m = entry.message;
    if (entry.evidence === 'withheld') return `${name(m.from)} — content withheld (contact not approved).`;
    const recovery = [
      entry.admission === 'uncertain' ? 'Native admission is uncertain; this message is held, not automatically posted again.' : '',
      entry.record?.state === 'partial' ? 'The latest observation was not saved. Inspect the known outcome; do not resend because of this save failure.' : '',
    ].filter(Boolean).join('\n');
    return `${detailed ? `${name(m.from)} → ${name(m.to)} · ${m.subject}\n` : ''}${messageContextLines(m).map(line => `${line}\n`).join('')}${m.text}${(m.refs ?? []).map((r: any) => `\n${r.label}: ${r.uri}`).join('')}\nMessage: ${m.id} · Exchange: ${m.exchange}${entry.returnHandle ? `\nReply with respondTo: "${entry.returnHandle}" (reusable)` : ''}${detailed && m.replyTo ? `\nResponse to: ${m.replyTo}` : ''}${detailed && entry.responses?.length ? `\nResponses: ${entry.responses.join(', ')}` : ''}${m.corrects ? `\nCorrection to: ${m.corrects}` : ''}${entry.linkage ? '\nContext lost: referenced request unavailable.' : ''}${entry.reportLinkage ? '\nReported request unavailable: link unverified.' : ''}${detailed ? `\nObservation: ${observationLabel(entry)}${entry.code ? ` · ${entry.code}` : ''}` : ''}${recovery ? `\n${recovery}` : ''}`;
  };
  const next = data.nextCursor ? `\nNext cursor: ${data.nextCursor}` : '';
  if (data.timeoutSeconds !== undefined) return data.items.map((item: any) => {
    const who = item.peer ? name(item.peer) : 'Request';
    const heading = `${who} — ${requestOutcomeLabel(item.outcome)} · ${item.subject ?? ''}${item.workRef ? ` · ${item.workRef}` : ''}`;
    const timeout = item.outcome === 'timeout' ? `No reply from ${who} within ${data.timeoutSeconds} seconds. The wait ended; a late reply can still arrive.` : '';
    return [heading, timeout || requestNextAction(item.outcome), item.code, item.request ? `Request: ${item.request}` : '', item.response ? message(item.response, false) : ''].filter(Boolean).join('\n');
  }).join('\n\n');
  if (data.message) return message(data);
  if (data.responses) return `Responses\n${data.responses.map((row: any) => {
    const current = row.currentReport ?? row.latestReport;
    const heading = `${row.peer ? name(row.peer) : row.request} — ${requestOutcomeLabel(row.outcome)}${row.code ? ` · ${row.code}` : ''}\nRequest: ${row.request}${row.subject ? ` · ${row.subject}` : ''}${row.workRef ? ` · Work: ${row.workRef}` : ''}`;
    const replies = row.replies?.length ? `\n${row.replies.map((entry: any) => message(entry)).join('\n\n')}` : '';
    const reported = current ? `\nPeer reports ${current.message.report.state} (current reported state) (${row.reportCount} report${row.reportCount === 1 ? '' : 's'} received; not requester acceptance)${row.laterProgressCount ? `\n${row.laterProgressCount} later progress update(s) retained in inspection, not treated as a new outcome.` : ''}${row.replies?.some((entry: any) => entry.message.id === current.message.id) ? '' : `\n${message(current)}`}` : '';
    return heading + replies + reported;
  }).join('\n\n')}`;
  if (data.recentExchanges) return [`Reception: ${data.paused ? 'paused' : 'receiving'} · ${data.waiting} waiting`, data.localTransport?.hold ? holdText[data.localTransport.hold] : '', ...(data.recentExchanges.length ? ['Conversations', ...data.recentExchanges.map(exchange)] : ['No recent exchanges.']), ...(data.uncertainOutgoing.length ? ['Uncertain sends', ...data.uncertainOutgoing.map((m: any) => `${name(m.to)} · ${m.message} · ${m.code}`)] : []), ...(data.uncertainAdmission?.length ? ['Uncertain native admission — held; not automatically posted again', ...data.uncertainAdmission.map((id: string) => `Message: ${id}`)] : [])].filter(Boolean).join('\n');
  if (data.items) return (data.items.length ? data.items.map((item: any) => item.message ? message(item) : item.exchange ? exchange(item) : `${item.name} · ${item.id} · ${peerSummary(item)} · ${item.approved ? 'approved' : 'approval required'}${item.context ? `\n${item.context}` : ''}${item.peerLabels?.length ? `\nYour labels: ${item.peerLabels.map((label: any) => `${label.label}${label.workRef ? ` [${label.workRef}]` : ''} (${label.source}, exchange ${label.exchange})`).join('; ')}` : ''}`).join('\n\n') : 'No matching records.') + (data.handovers?.length ? `\nHandover links from this exchange (not acceptance):\n${data.handovers.map((h: any) => `${name(h.toPeer)} · new exchange ${h.toExchange} · message ${h.message} · ${requestOutcomeLabel(h.state)}${h.code ? ` · ${h.code}` : ''}`).join('\n')}` : '') + next + (data.nextAction ? `\n${data.nextAction}` : '') + (data.localTransport?.hold && holdText[data.localTransport.hold] ? `\n${holdText[data.localTransport.hold]}` : '');
  return 'No communication records.';
  function exchange(e: any) { return `${name(e.peer)} · ${e.subject ?? 'content withheld'} · ${requestOutcomeLabel(e.state)}${e.workRef ? `\nWork: ${e.workRef}` : ''}${e.recipientLabel ? `\nRecipient label for ${name(e.labeledSession)} (sender-supplied, not authority): ${e.recipientLabel}` : ''}\nExchange: ${e.exchange} · Message: ${e.latestMessage}${e.preview ? `\n${e.preview}` : ''}${e.code ? `\n${e.code}` : ''}`; }
}
