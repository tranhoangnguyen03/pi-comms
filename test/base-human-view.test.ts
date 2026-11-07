import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, Text, visibleWidth } from '@earendil-works/pi-tui';
import { Runtime } from '../src/runtime.ts';
import { approvalPrompt, contactDecisionTitle, explicitApprovalTitle, CONTACT_SESSION, CONTACT_REMEMBER, CONTACT_REFUSE, CONTACT_CANCEL, CONTACT_CHOICES, CONTACT_GRANT_CHOICES, admissionDecisionStorageNotice, inspectionText, inspectionState, inspectionScreen, showInspection } from '../src/human-view.ts';

const self = randomUUID(), peer = randomUUID();
const labels = { self, name: (id: string) => id === self ? 'Coordinator' : 'Reviewer', approved: () => false };
const theme = { fg: (_key: string, text: string) => text } as any;
const keys = () => new KeybindingsManager({ ...TUI_KEYBINDINGS, 'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Details' } });
const envelope = (text = 'Complete finding 日本語 🔎') => ({ id: randomUUID(), exchange: randomUUID(), subject: 'Design review', text, refs: [{ uri: 'file:///design.md', label: 'Design' }], replyTo: null, corrects: null, createdAt: new Date().toISOString() });
function fixture(count = 1, body?: string) {
  const runtime = new Runtime(self, async () => ({ outcome: 'accepted' }));
  const messages = Array.from({ length: count }, (_, i) => ({ ...envelope(body ?? `Finding ${i}`), subject: `Review ${i}` }));
  messages.forEach(m => runtime.receive(peer, m));
  return { runtime, messages, load: (cursor?: string) => runtime.inspect({ queue: 'self', ...(cursor ? { cursor } : {}) }, 'human') };
}

test('F11: approval prompt shows only who, topic, short preview and decision effect', () => {
  for (const direction of ['send', 'receive'] as const) {
    const prompt = approvalPrompt(peer, 'Reviewer', 'Read-only review', 'long request '.repeat(100), direction);
    const visible = contactDecisionTitle(prompt.title, prompt.message);
    assert.match(prompt.title, /Reviewer/);
    assert.match(prompt.message, /Topic: Read-only review/);
    assert.match(prompt.message, /long request/);
    assert.match(prompt.message, /Allows messages between these sessions, not approval of the work/);
    assert.ok(prompt.message.length <= 310, 'prompt body must remain short even with long source text');
    assert.ok(visible.length < 450, 'decision text must be readable without a wall of copy');
    assert.doesNotMatch(visible, /Session:|broker|return handle|native session|UUID|technical/);
    assert.doesNotMatch(visible, new RegExp(peer));
    assert.doesNotMatch(visible, /long request /.test('') ? /never/ : /long request long request long request long request long request long request long request long request long request long request long request long request long request/);
  }
});

test('F11: first-contact choices are short and grant editing never claims to send', () => {
  assert.deepEqual(CONTACT_CHOICES, [CONTACT_SESSION, CONTACT_REMEMBER, CONTACT_REFUSE]);
  assert.equal(CONTACT_SESSION, 'Allow this session');
  assert.equal(CONTACT_REMEMBER, 'Allow & remember');
  assert.equal(CONTACT_REFUSE, 'Decline');
  assert.deepEqual(CONTACT_GRANT_CHOICES, [CONTACT_SESSION, CONTACT_REMEMBER, CONTACT_CANCEL]);
  assert.equal(CONTACT_CANCEL, 'Cancel');
  const p = approvalPrompt(peer, 'Reviewer', 'Review changes', 'Need a code review', 'send');
  const title = contactDecisionTitle(p.title, p.message);
  assert.match(title, /Remember keeps this contact across restarts/);
  assert.match(title, /Either session can revoke/);
  const explicit = explicitApprovalTitle(peer, 'Reviewer', 'Review changes');
  assert.match(explicit, /Allow contact with Reviewer/);
  assert.match(explicit, /This command sends nothing/);
  assert.match(explicit, /Cancel leaves existing approval unchanged/);
  assert.doesNotMatch(explicit, /send this request now/);
  assert.ok(explicit.length < 320);
});

test('uncertain admission confirmation distinguishes saved, volatile and blocked Pi session records', () => {
  const saved = admissionDecisionStorageNotice('saved');
  assert.match(saved, /if this write succeeds/i);
  assert.match(saved, /saved in your Pi session for restart/);
  assert.doesNotMatch(saved, /live-only/);

  for (const state of ['volatile', undefined] as const) {
    const live = admissionDecisionStorageNotice(state);
    assert.match(live, /live-only/);
    assert.match(live, /lost on restart/);
    assert.doesNotMatch(live, /will be saved with your Pi session/);
  }

  const blocked = admissionDecisionStorageNotice('blocked');
  assert.match(blocked, /storage is blocked/);
  assert.doesNotMatch(blocked, /will be saved|live-only/);
});

test('human view presents full content/references in plain language; evidence/handles are available on demand', () => {
  const { runtime, messages, load } = fixture(1, 'First line\nSecond line\nComplete finding 日本語 🔎');
  const view = load();
  const summary = inspectionText(view, labels);
  assert.match(summary, /Reviewer → Coordinator/); assert.match(summary, /Contact: not approved/);
  assert.match(summary, /Buffered in receiver memory/); assert.match(summary, /not proof of completed work/);
  assert.match(summary, /First line\nSecond line/); assert.match(summary, /Design: file:\/\/\/design.md/);
  assert.ok(!summary.includes(messages[0].id)); assert.doesNotMatch(summary, /Return handle:/);
  const details = inspectionText(view, labels, true);
  assert.ok(details.includes(messages[0].id)); assert.ok(details.includes(messages[0].exchange));
  assert.match(details, /Technical evidence/); assert.match(details, /Return handle:/); assert.match(details, /receiver runtime/);
  assert.doesNotMatch(inspectionText(runtime.inspect({ queue: 'self' }), labels, true), /First line|file:\/\/\/design.md/);
  assert.equal(runtime.waiting.length, 1); assert.equal(runtime.isApproved(peer), false);
});

test('human inspection pagination reaches every full message and can navigate back without consuming anything', () => {
  const { runtime, messages, load } = fixture(65);
  const state = inspectionState(load, labels);
  assert.match(state.text(), /Finding 0\b/); assert.doesNotMatch(state.text(), /Finding 30\b/);
  assert.equal(state.hasPrevious(), false); assert.equal(state.hasNext(), true);
  state.next(); assert.match(state.title(), /page 2/); assert.match(state.text(), /Finding 30\b/);
  state.next(); assert.match(state.text(), /Finding 64\b/); assert.equal(state.hasNext(), false);
  state.toggleDetails(); assert.ok(state.text().includes(messages[64].id));
  state.previous(); assert.match(state.text(), /Finding 30\b/); state.previous(); assert.match(state.text(), /Finding 0\b/);
  assert.deepEqual(runtime.waiting, messages.map(m => m.id));
});

test('read-only screen supports bounded wrapping, scroll/details/page keys, mouse and abort without editing', () => {
  const { messages, load } = fixture(32, `FIRST_LINE\n${'full body 日本語 🔎\n'.repeat(60)}LAST_LINE`);
  const state = inspectionState(load, labels);
  const controller = new AbortController(); let height = 18, closed = 0, rendered = 0;
  const screen = inspectionScreen(state, keys(), theme, () => height, () => { rendered++; }, () => { closed++; }, controller.signal);
  try {
    for (const width of [0, 1, 20, 40, 80]) {
      const lines = screen.render(width); assert.ok(lines.length <= height);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
    const beforeTyping = state.text(); screen.handleInput!('accidental typing'); assert.equal(state.text(), beforeTyping);
    screen.render(80); screen.handleInput!('\x1b[6~'); assert.ok(!screen.render(80).join('\n').includes('FIRST_LINE'));
    screen.handleInput!('d'); screen.render(80); screen.handleInput!('\x1b[F');
    assert.match(screen.render(80).join('\n'), /Technical evidence|Return handle|receiver runtime/);
    assert.equal(screen.handleMouse!({ type: 'wheel', wheelDelta: -2 } as any)?.handled, true);
    screen.handleInput!('n'); assert.match(state.title(), /page 2/); assert.ok(state.text().includes(messages[31].id));
    screen.handleInput!('p'); assert.match(state.title(), /page 1/);
    height = 10; assert.ok(screen.render(35).length <= height);
    controller.abort(); assert.equal(closed, 1); assert.ok(rendered > 0);
  } finally { screen.dispose(); }
});

test('native regular/fullscreen overlay keeps read-only inspector bounded and closes back to underlying work', () => {
  for (const NativeTui of [TuiMainScreen, TuiAltScreen]) {
    let input!: (data: string) => void; const output: string[] = [];
    const terminal: any = { columns: 60, rows: 24, kittyProtocolActive: false, start: (fn: any) => { input = fn; }, stop() {}, write: (text: string) => output.push(text), moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
    const tui = new NativeTui(terminal); const { load } = fixture(1, `NATIVE_FULL_BODY\n${'review evidence\n'.repeat(80)}END_OF_CONTENT`);
    const signal = new AbortController(); let closed = false;
    const screen = inspectionScreen(inspectionState(load, labels), keys(), theme, () => terminal.rows - 2, () => tui.requestRender(), () => { closed = true; }, signal.signal);
    tui.addChild(new Text('Underlying human work', 0, 0)); tui.start();
    try {
      const overlay = tui.showOverlay(screen, { width: '96%', margin: 1 }); tui.renderNow(true);
      assert.equal(tui.hasOverlay(), true); input('\x1b[F'); tui.renderNow(true);
      assert.match(output.join(''), /END_OF_CONTENT/);
      terminal.columns = 35; terminal.rows = 16; tui.renderNow(true);
      input('q'); assert.equal(closed, true); overlay.hide(); tui.renderNow(true);
      assert.equal(tui.hasOverlay(), false); assert.match(output.join(''), /Underlying human work/);
    } finally { screen.dispose(); tui.stop(); }
  }
});

test('RPC inspection uses read-only native selections; no UI never emits human-only content', async () => {
  const { load } = fixture(32, 'RPC full message');
  const actions = ['Toggle technical details', 'More messages', 'Previous messages', 'Close']; const views: string[] = [];
  const rpc = { hasUI: true, mode: 'rpc', ui: { select: async (title: string) => { views.push(title); return actions.shift(); } } } as any;
  await showInspection(rpc, load, labels, new AbortController().signal);
  assert.match(views[0], /RPC full message/); assert.doesNotMatch(views[0], /Return handle:/);
  assert.match(views[1], /Return handle:/); assert.match(views[2], /page 2/); assert.match(views[3], /page 1/);
  let loaded = false; const notices: string[] = [];
  await showInspection({ hasUI: false, ui: { notify: (text: string) => notices.push(text) } } as any, () => { loaded = true; return load(); }, labels, new AbortController().signal);
  assert.equal(loaded, false); assert.ok(!notices.join('').includes('RPC full message'));
});
