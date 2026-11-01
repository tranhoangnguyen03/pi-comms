import { observationLabel, peerSummary, requestOutcomeLabel, requestNextAction } from './communication-view.ts';
const holdText: Record<string, string> = { busy: 'This session is working; incoming messages are buffered', paused: 'Reception paused; incoming messages are buffered', 'human-pending': 'Human input has priority; incoming messages are buffered' };
export function modelView(data: any, name: (id: string) => string): string {
  const message = (entry: any, detailed = true) => {
    const m = entry.message;
    if (entry.evidence === 'withheld') return `${name(m.from)} — content withheld (contact not approved).`;
    return `${detailed ? `${name(m.from)} → ${name(m.to)} · ${m.subject}\n` : ''}${m.text}${(m.refs ?? []).map((r: any) => `\n${r.label}: ${r.uri}`).join('')}\nMessage: ${m.id} · Exchange: ${m.exchange}${entry.returnHandle ? `\nReply with respondTo: "${entry.returnHandle}" (reusable)` : ''}${detailed && m.replyTo ? `\nResponse to: ${m.replyTo}` : ''}${detailed && entry.responses?.length ? `\nResponses: ${entry.responses.join(', ')}` : ''}${m.corrects ? `\nCorrection to: ${m.corrects}` : ''}${entry.linkage ? '\nContext lost: referenced request unavailable.' : ''}${detailed ? `\nObservation: ${observationLabel(entry)}${entry.code ? ` · ${entry.code}` : ''}` : ''}`;
  };
  const next = data.nextCursor ? `\nNext cursor: ${data.nextCursor}` : '';
  if (data.timeoutSeconds !== undefined) return data.items.map((item: any) => {
    const who = item.peer ? name(item.peer) : 'Request';
    const heading = `${who} — ${requestOutcomeLabel(item.outcome)} · ${item.subject ?? ''}`;
    const timeout = item.outcome === 'timeout' ? `No reply from ${who} within ${data.timeoutSeconds} seconds. The wait ended; a late reply can still arrive.` : '';
    return [heading, timeout || requestNextAction(item.outcome), item.code, item.request ? `Request: ${item.request}` : '', item.response ? message(item.response, false) : ''].filter(Boolean).join('\n');
  }).join('\n\n');
  if (data.message) return message(data);
  if (data.responses) return `Responses\n${data.responses.map((row: any) => `${row.peer ? name(row.peer) : row.request} — ${requestOutcomeLabel(row.outcome)}${row.code ? ` · ${row.code}` : ''}\nRequest: ${row.request}${row.subject ? ` · ${row.subject}` : ''}${row.replies?.length ? `\n${row.replies.map((entry: any) => message(entry)).join('\n\n')}` : ''}`).join('\n\n')}`;
  if (data.recentExchanges) return [`Reception: ${data.paused ? 'paused' : 'receiving'} · ${data.waiting} waiting`, data.localTransport?.hold ? holdText[data.localTransport.hold] : '', 'Conversations', ...data.recentExchanges.map(exchange), 'Uncertain sends', ...data.uncertainOutgoing.map((m: any) => `${name(m.to)} · ${m.message} · ${m.code}`)].filter(Boolean).join('\n');
  if (data.items) return (data.items.length ? data.items.map((item: any) => item.message ? message(item) : item.exchange ? exchange(item) : `${item.name} · ${item.id} · ${peerSummary(item)} · ${item.approved ? 'approved' : 'approval required'}${item.context ? `\n${item.context}` : ''}`).join('\n\n') : 'No matching records.') + next + (data.nextAction ? `\n${data.nextAction}` : '') + (data.localTransport?.hold ? `\n${holdText[data.localTransport.hold]}` : '');
  return 'No communication records.';
  function exchange(e: any) { return `${name(e.peer)} · ${e.subject ?? 'content withheld'} · ${requestOutcomeLabel(e.state)}\nExchange: ${e.exchange} · Message: ${e.latestMessage}${e.preview ? `\n${e.preview}` : ''}${e.code ? `\n${e.code}` : ''}`; }
}
