import { observationLabel, messageContextLines } from './communication-view.ts';
import type { ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, ScrollView, Text, truncateToWidth, type Component, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { Runtime } from './runtime.ts';

type Inspection = ReturnType<Runtime['inspect']>;
type Labels = { self: string; name: (id: string) => string; approved: (id: string) => boolean };

export function approvalPrompt(id: string, colleague: string, work: string, text: string, direction: 'send' | 'receive') {
  const preview = text.replace(/\s+/g, ' ');
  return {
    title: direction === 'send' ? `Work with ${colleague}?` : `${colleague} wants to work with you`,
    message: `Work: ${work}\n\n${direction === 'send' ? 'Yes: send this request now.' : 'Yes: admit held messages when reception is ready.'}\n${direction === 'send' ? 'No/Esc: send nothing.' : 'No/Esc: keep messages held for you, not the agent.'}\nAllows requests, clarifications and replies for this work.\n${direction === 'send' ? 'The receiver accepts this contact without another prompt; its Pause/revoke still apply.' : 'Only your explicit approval restores a refused or revoked contact.'}\nYour directions and tool permissions still apply.\n\n${direction === 'receive' ? 'Incoming preview (not yet shared with the agent)' : 'Request preview'}: ${preview.slice(0, 160)}${preview.length > 160 ? '…' : ''}\nSession: ${id}\nApproval lasts until reload/restart.`,
  };
}

export function inspectionText(data: Inspection, labels: Labels, technical = false) {
  const entries = 'items' in data ? data.items : [data];
  if (!entries.length) return 'No messages waiting.\n\nInspection does not approve contacts, consume messages or start agent work.';
  return entries.map(entry => {
    const lines = [`${labels.name(entry.message.from)} → ${labels.name(entry.message.to)}`];
    if (!('facts' in entry)) return [...lines, 'Content withheld: contact approval required.'].join('\n');
    const m = entry.message;
    lines.push(`Subject: ${m.subject}`, `Contact: ${labels.approved(m.from === labels.self ? m.to : m.from) ? 'approved' : 'not approved'}`,
      `Latest observation: ${observationLabel(entry)}`,
      `${entry.responses.length} linked response(s) — not proof of completed work.`);
    lines.push(...messageContextLines(m));
    if (m.replyTo) lines.push('Reply to an earlier message.');
    if (m.corrects) lines.push('Correction to an earlier message.');
    if (entry.linkage) lines.push('Context lost: the referenced request is unavailable.');
    lines.push('', m.text);
    if (m.refs.length) lines.push('', 'References', ...m.refs.map(ref => `${ref.label}: ${ref.uri}`));
    if (technical) {
      lines.push('', 'Technical evidence', `Message: ${m.id}`, `Exchange: ${m.exchange}`, `From session: ${m.from}`, `To session: ${m.to}`, `Created: ${m.createdAt}`, `Send/receive state: ${entry.state}`, `Evidence: ${entry.evidence}`);
      if (m.replyTo) lines.push(`Reply to: ${m.replyTo}`);
      if (m.corrects) lines.push(`Corrects: ${m.corrects}`);
      if (entry.returnHandle) lines.push(`Return handle: ${entry.returnHandle} (reusable across replies and turns)`);
      if (entry.code) lines.push(`Code: ${entry.code}`);
      lines.push(...entry.facts.map(fact => `${fact.kind} · ${fact.at} · ${fact.source}${fact.evidenceRef ? ` · evidence ${fact.evidenceRef}` : ''}`));
      if (entry.responses.length) lines.push(`Linked responses: ${entry.responses.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n\n────────────────────────\n\n');
}

export function inspectionState(load: (cursor?: string) => Inspection, labels: Labels) {
  const cursors: (string | undefined)[] = [undefined];
  let data = load();
  let technical = false;
  const nextCursor = () => 'items' in data ? data.nextCursor : null;
  return {
    title: () => `Communication inspection · read-only snapshot · page ${cursors.length}`,
    text: () => inspectionText(data, labels, technical),
    hasNext: () => !!nextCursor(), hasPrevious: () => cursors.length > 1,
    toggleDetails() { technical = !technical; },
    next() { const cursor = nextCursor(); if (!cursor) return; const next = load(cursor); cursors.push(cursor); data = next; },
    previous() { if (cursors.length < 2) return; const previous = load(cursors[cursors.length - 2]); cursors.pop(); data = previous; },
  };
}

// A bounded read-only component. Native Text wraps; native ScrollView owns scroll state.
export function inspectionScreen(state: ReturnType<typeof inspectionState>, keys: KeybindingsManager, theme: Theme, rows: () => number, requestRender: () => void, close: () => void, signal: AbortSignal): Component & { dispose(): void } {
  const text = new Text(state.text(), 0, 0);
  const scroll = new ScrollView(text);
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  const key = (action: Parameters<KeybindingsManager['getKeys']>[0]) => keys.getKeys(action)[0] ?? 'unbound';
  const refresh = (fromStart = false) => { text.setText(state.text()); if (fromStart) scroll.scrollToStart(); requestRender(); };
  return {
    render(width) {
      if (width < 1) return [];
      const height = Math.max(1, rows());
      const lines = scroll.render(width);
      const actions = `${key('tui.select.cancel')}/q Close · d Details${state.hasNext() ? ' · n More messages' : ''}${state.hasPrevious() ? ' · p Previous messages' : ''}`;
      const movement = `${key('tui.select.up')}/${key('tui.select.down')} Scroll · ${key('tui.select.pageUp')}/${key('tui.select.pageDown')} Page`;
      const footer = new Text(`${actions}\n${movement}`, 0, 0).render(width).map(line => theme.fg('dim', line));
      scroll.updateLayout(lines.length, Math.max(0, height - 1 - footer.length), requestRender);
      const end = Math.min(lines.length, scroll.scrollTop + scroll.viewportHeight);
      return [truncateToWidth(theme.fg('accent', state.title()), width), ...lines.slice(scroll.scrollTop, end), ...footer].slice(0, height);
    },
    handleInput(data) {
      if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, 'q')) { close(); return; }
      if (matchesKey(data, 'd') || keys.matches(data, 'app.tools.expand')) { state.toggleDetails(); refresh(); return; }
      if (matchesKey(data, 'n')) { state.next(); refresh(true); return; }
      if (matchesKey(data, 'p')) { state.previous(); refresh(true); return; }
      if (keys.matches(data, 'tui.select.up')) scroll.scrollBy(-1);
      else if (keys.matches(data, 'tui.select.down')) scroll.scrollBy(1);
      else if (keys.matches(data, 'tui.select.pageUp')) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
      else if (keys.matches(data, 'tui.select.pageDown')) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
      else if (matchesKey(data, 'home')) scroll.scrollToStart();
      else if (matchesKey(data, 'end')) scroll.scrollToEnd();
      requestRender();
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.type !== 'wheel') return;
      scroll.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    },
    invalidate() { scroll.invalidate(); },
    dispose() { signal.removeEventListener('abort', close); },
  };
}

export async function showInspection(ctx: ExtensionContext, load: (cursor?: string) => Inspection, labels: Labels, signal: AbortSignal) {
  if (!ctx.hasUI) { ctx.ui.notify('Human inspection needs a UI. Agent/script inspection remains available through comms_inspect.', 'warning'); return; }
  const state = inspectionState(load, labels);
  if (ctx.mode === 'tui') {
    await ctx.ui.custom<void>((tui, theme, keys, done) => inspectionScreen(state, keys, theme, () => Math.max(1, tui.terminal.rows - 2), () => tui.requestRender(), () => done(), signal), { overlay: true, overlayOptions: { width: '96%', margin: 1 } });
    return;
  }
  // RPC clients support native selections, not terminal components. Same read-only projection.
  while (!signal.aborted) {
    const action = await ctx.ui.select(`${state.title()}\n\n${state.text()}`, ['Close', 'Toggle technical details', ...(state.hasNext() ? ['More messages'] : []), ...(state.hasPrevious() ? ['Previous messages'] : [])], { signal });
    if (!action || action === 'Close') return;
    if (action === 'Toggle technical details') state.toggleDetails();
    else if (action === 'More messages') state.next();
    else if (action === 'Previous messages') state.previous();
  }
}
