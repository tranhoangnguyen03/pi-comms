import { observationLabel, messageContextLines } from './communication-view.ts';
import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export type CardMessage = { id: string; from: string; to: string; subject: string; text: string; workRef?: string; recipientLabel?: string; report?: { request: string; state: string }; structured?: object; reportLinkage?: 'context-lost'; exchange: string; replyTo?: string | null; corrects?: string | null; at: string; fact: 'queued' | 'posted' | 'saved' | 'unknown' };

// Adapted from intercom's MIT InlineMessageComponent; notice in THIRD-PARTY-NOTICES.md.
export class InlineCard implements Component {
  constructor(private messages: CardMessage[], private theme: Theme, private expansion: { expanded: boolean }) {}
  invalidate() {}
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left' || event.shift || event.alt || event.ctrl || (event.clickCount ?? 1) !== 1) return;
    this.expansion.expanded = !this.expansion.expanded;
    return { handled: true, render: true };
  }
  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const headline = this.messages.length === 1 ? `${this.messages[0].from} → ${this.messages[0].to} · ${this.messages[0].subject}` : `${this.messages.length} peer messages`;
    if (safeWidth < 3) return [truncateToWidth(headline, safeWidth)];
    const inner = safeWidth - 2;
    const frame = (text: string) => {
      const clipped = truncateToWidth(text, inner, '');
      return this.theme.fg('muted', '│') + clipped + this.theme.fg('muted', ' '.repeat(Math.max(0, inner - visibleWidth(clipped))) + '│');
    };
    const lines = [this.theme.fg('muted', `╭${'─'.repeat(inner)}╮`), frame(this.theme.fg('toolTitle', headline))];
    for (const message of this.messages) {
      if (this.messages.length > 1) lines.push(frame(`${message.from} → ${message.to} · ${message.subject}`));
      for (const context of messageContextLines(message)) for (const line of wrapTextWithAnsi(context, inner)) lines.push(frame(line));
      if (message.reportLinkage) lines.push(frame('Reported request unavailable — link unverified'));
      if (message.fact === 'unknown') lines.push(frame('Receipt state unknown'));
      if (message.corrects) lines.push(frame('Correction to an earlier message'));
      for (const line of wrapTextWithAnsi(message.text, inner)) lines.push(frame(line));
      if (this.expansion.expanded) {
        lines.push(frame(`Observed: ${observationLabel({ facts: message.fact === 'unknown' ? [] : [{ kind: message.fact }], state: message.fact })}`));
        for (const line of wrapTextWithAnsi(`Message ${message.id} · exchange ${message.exchange} · ${message.at}${message.replyTo ? ` · response to ${message.replyTo}` : ''}${message.corrects ? ` · corrects ${message.corrects}` : ''}`, inner)) lines.push(frame(this.theme.fg('dim', line)));
      }
    }
    lines.push(frame(this.theme.fg('dim', this.expansion.expanded ? 'Ctrl+O hides details · Click (fullscreen)' : 'Ctrl+O details · Click (fullscreen)')));
    lines.push(this.theme.fg('muted', `╰${'─'.repeat(inner)}╯`));
    return lines;
  }
}

export function registerInlineCards(pi: ExtensionAPI) {
  const states = new WeakMap<object, { expanded: boolean; global: boolean }>();
  pi.registerMessageRenderer('comms_batch', (message, options, theme) => {
    const details = message.details as { messages: CardMessage[] } | undefined;
    if (!details?.messages?.length) return undefined;
    let state = states.get(message);
    if (!state) { state = { expanded: options.expanded, global: options.expanded }; states.set(message, state); }
    else if (state.global !== options.expanded) { state.expanded = options.expanded; state.global = options.expanded; }
    return new InlineCard(details.messages, theme, state);
  });
}
