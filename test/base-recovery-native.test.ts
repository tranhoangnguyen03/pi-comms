import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = mkdtempSync(join(tmpdir(), 'comms-f10-native-'));
process.env.PI_CODING_AGENT_DIR = root;
const extensionPath = process.env.PI_COMMS_TEST_EXTENSION ?? fileURLToPath(new URL('../dist/extension.js', import.meta.url));
after(async () => {
  try { process.kill(Number(readFileSync(join(root, 'comms', 'broker.pid'), 'utf8')), 'SIGTERM'); } catch {}
  await new Promise(resolve => setTimeout(resolve, 100)); rmSync(root, { recursive: true, force: true });
});
const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  const until = Date.now() + 8000;
  while (!await predicate()) { if (Date.now() >= until) throw new Error('F10 native fixture timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
};
const data = (result: any) => result.structuredContent ?? result.details;
const text = (messages: any[]) => messages.map(message => typeof message.content === 'string' ? message.content : message.content?.map((block: any) => block.text ?? '').join('')).join('\n');
async function participant(label: string, manager?: SessionManager) {
  const dir = join(root, label); mkdirSync(dir, { recursive: true });
  manager ??= SessionManager.create(dir, join(root, `${label}-sessions`));
  const faux = fauxProvider({ provider: `f10-${label}-${randomUUID()}` });
  const models = await ModelRuntime.create({ authPath: join(root, `${label}-auth.json`), modelsPath: null, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const observed: any[][] = [], notifications: string[] = [], dialogs: string[] = [];
  let draft = '', confirm = true, hold = false, rememberNext = false;
  let selectChoice: ((title: string, options: string[]) => string | undefined) | undefined;
  const releases: (() => void)[] = [];
  faux.setResponses(Array.from({ length: 100 }, () => async context => {
    observed.push(structuredClone(context.messages));
    if (hold) await new Promise<void>(resolve => releases.push(resolve));
    return fauxAssistantMessage('fixture response');
  }));
  const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: models,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [extensionPath] } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), noTools: 'builtin' });
    return { ...created, services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd: dir, agentDir: root, sessionManager: manager });
  const bind = async (session: any) => session.bindExtensions({ mode: 'tui', uiContext: {
    ...session.extensionRunner.getUIContext(), getEditorText: () => draft,
    notify: (message: string) => { notifications.push(message); }, setWidget: () => {}, setStatus: () => {},
    confirm: async (title: string, message: string) => { dialogs.push(`${title}\n${message}`); return confirm; },
    input: async () => 'Review continuity', select: async (title: string, choices: string[]) => {
      if (choices.includes('Approve for this session only (default)')) {
        dialogs.push(title);
        return confirm ? (rememberNext ? choices[1] : choices[0]) : choices[2];
      }
      return selectChoice?.(title, choices) ?? choices[0];
    },
  } });
  await bind(runtime.session); runtime.setRebindSession(bind);
  return { runtime, manager, observed, notifications, dialogs,
    id: () => runtime.session.sessionId,
    file: () => runtime.session.sessionManager.getSessionFile(),
    command: (value: string) => runtime.session.prompt(`/comms ${value}`),
    confirm: (value: boolean) => { confirm = value; }, remember: (value: boolean) => { rememberNext = value; }, draft: (value: string) => { draft = value; },
    select: (next: (title: string, options: string[]) => string | undefined) => { selectChoice = next; },
    hold: (value: boolean) => { hold = value; }, release: () => { releases.shift()?.(); },
    tool: async (name: string, input: unknown) => {
      const runner = runtime.session.extensionRunner!, call = randomUUID();
      return data(await runner.getToolDefinition(name)!.execute(call, input, undefined, undefined, runner.createToolContext(call)));
    },
    close: async () => { hold = false; releases.splice(0).forEach(resolve => resolve()); await runtime.session.abort(); await runtime.dispose(); },
  };
}
function batchCount(p: Awaited<ReturnType<typeof participant>>, id: string) {
  return p.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'comms_batch' && (entry.details as any)?.ids?.includes(id)).length;
}

test('F10 native: readable history, original return handles, Pause and revocation survive reopen', async () => {
  const a = await participant('reopen-lead'); let b = await participant('reopen-reviewer');
  try {
    await a.runtime.session.prompt('Review session'); await b.runtime.session.prompt('Reviewer session');
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Review', text: 'F10_ORIGINAL_REVIEW', workRef: 'F10-NATIVE' });
    assert.equal(sent.ok, true);
    const id = sent.data.message.id;
    await waitFor(() => b.observed.some(messages => text(messages).includes('F10_ORIGINAL_REVIEW')) && b.runtime.session.isIdle);
    const incoming = (await b.tool('comms_inspect', { message: id })).data;
    await b.command('pause'); await b.command(`revoke ${a.id()}`);
    const oldId = b.id(), file = b.file()!;
    await b.close(); b = await participant('reopen-reviewer', SessionManager.open(file));
    assert.equal(b.id(), oldId);
    const old = await b.tool('comms_inspect', { message: id });
    assert.equal(old.ok, true); assert.equal(old.data.message.text, 'F10_ORIGINAL_REVIEW');
    assert.equal(old.data.returnHandle, incoming.returnHandle);
    assert.equal((await b.tool('comms_inspect', {})).data.paused, true);
    assert.equal((await b.tool('comms_peers', { view: 'known' })).data.items.length, 0);
    const fresh = await a.tool('comms_message', { to: oldId, subject: 'Held', text: 'F10_WITHHELD_AFTER_REVOKE' });
    assert.equal(fresh.ok, true);
    // Transport acceptance is not receiver admission. Wait for the exact
    // arrival before checking its privacy; do not weaken the visibility check.
    await waitFor(async () => (await b.tool('comms_inspect', { message: fresh.data.message.id })).ok === true);
    const held = await b.tool('comms_inspect', { message: fresh.data.message.id });
    assert.equal(held.ok, true, JSON.stringify(held));
    assert.equal(held.data.evidence, 'withheld');
    assert.doesNotMatch(JSON.stringify(held), /F10_WITHHELD_AFTER_REVOKE/);
    await b.command('resume'); await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(b.observed.length, 0); assert.equal(b.dialogs.length, 0, 'restored revoke does not prompt repeatedly');
    const reply = await b.tool('comms_message', { respondTo: incoming.returnHandle, text: 'F10_LINKED_ANSWER', report: { request: id, state: 'complete' } });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.data.message.replyTo, id); assert.equal(reply.data.message.workRef, 'F10-NATIVE');
    assert.equal(b.dialogs.length, 1, 'new send uses the existing owner confirmation, not history access');
    await waitFor(() => a.observed.some(messages => text(messages).includes('F10_LINKED_ANSWER')) && a.runtime.session.isIdle && b.runtime.session.isIdle);
    assert.equal(batchCount(b, id), 1, 'old native admission never becomes a second batch');
    const reports = (await a.tool('comms_inspect', { requests: [id] })).data.responses[0];
    assert.equal(reports.currentReport.message.id, reply.data.message.id);
  } finally { await b.close(); await a.close(); }
});

test('F10 native: paused never-offered mail resumes through ordinary approval and human-first intake', async () => {
  const a = await participant('held-lead'); let b = await participant('held-reviewer');
  try {
    await b.runtime.session.prompt('Existing saved review'); b.observed.length = 0;
    await b.command('pause');
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Held work', text: 'F10_PENDING_REVIEW' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const id = sent.data.message.id;
    await waitFor(async () => (await b.tool('comms_inspect', { message: id })).ok === true);
    const before = await b.tool('comms_inspect', { message: id });
    assert.equal(before.ok, true, JSON.stringify({ before, notifications: b.notifications }));
    assert.equal(before.data.evidence, 'available', 'history authorization is not native admission');
    assert.equal(batchCount(b, id), 0);
    const file = b.file()!; await b.close(); b = await participant('held-reviewer', SessionManager.open(file));
    const restored = await b.tool('comms_inspect', { message: id });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.data.evidence, 'available');
    assert.equal(b.observed.length, 0); assert.equal(b.dialogs.length, 0);
    b.draft('human draft must win'); await b.command('resume');
    await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(b.observed.length, 0);
    b.draft('');
    await waitFor(() => b.observed.length === 1 && b.runtime.session.isIdle);
    assert.equal(b.dialogs.length, 1, 'runtime-only approval expired; normal receive confirmation is sufficient');
    assert.equal(batchCount(b, id), 1);
  } finally { await b.close(); await a.close(); }
});

test('F10 native: corruption is detected before broker registration while verified old history stays readable', async () => {
  const a = await participant('corrupt-lead'); let b = await participant('corrupt-reviewer');
  try {
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Saved', text: 'F10_SALVAGEABLE_HISTORY' });
    assert.equal(sent.ok, true);
    await waitFor(() => b.observed.length === 1 && b.runtime.session.isIdle);
    const id = sent.data.message.id, peerId = b.id(), file = b.file()!;
    await b.close(); appendFileSync(file, '{"type":"custom","data":');
    const reopened = SessionManager.open(file);
    // The native loader may add a final newline; pi-comms must not repair,
    // truncate or rewrite what remains after the host has opened the file.
    b = await participant('corrupt-reviewer', reopened);
    const beforeInspection = readFileSync(file, 'utf8');
    const old = await b.tool('comms_inspect', { message: id });
    assert.equal(old.ok, true); assert.equal(old.data.message.text, 'F10_SALVAGEABLE_HISTORY');
    assert.equal(old.data.recovery.state, 'blocked');
    assert.equal((await b.tool('comms_peers', {})).error.code, 'RECOVERY_BLOCKED');
    const discovery = await a.tool('comms_peers', {});
    assert.ok(!discovery.data.items.some((item: any) => item.id === peerId && item.presence === 'online'), 'recovery hold precedes registration');
    assert.equal(b.observed.length, 0);
    assert.match(beforeInspection.trimEnd(), /\{"type":"custom","data":$/);
    assert.equal(readFileSync(file, 'utf8'), beforeInspection, 'inspection does not modify malformed host data');
  } finally { await b.close(); await a.close(); }
});

test('F10 native: first inbound use and --no-session remain live, with accurate storage evidence', async () => {
  const a = await participant('fresh-lead'); let b = await participant('fresh-reviewer');
  const memory = SessionManager.inMemory(join(root, 'ephemeral-reviewer'));
  const ephemeral = await participant('ephemeral-reviewer', memory);
  try {
    assert.equal(b.file() !== undefined, true, 'an allocated path is not itself a saved file');
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'First use', text: 'F10_FIRST_INBOUND' });
    assert.equal(sent.ok, true); assert.equal(sent.data.record.state, 'volatile', 'fresh sender was not disabled or forced to fabricate a user turn');
    await waitFor(() => b.observed.length === 1 && b.runtime.session.isIdle);
    const before = await b.tool('comms_inspect', { message: sent.data.message.id });
    assert.equal(before.data.recovery.state, 'saved', 'actual first model turn causes native host persistence');
    const file = b.file()!; await b.close(); b = await participant('fresh-reviewer', SessionManager.open(file));
    assert.equal((await b.tool('comms_inspect', { message: sent.data.message.id })).data.message.text, 'F10_FIRST_INBOUND');
    const live = await a.tool('comms_message', { to: ephemeral.id(), subject: 'No session file', text: 'F10_EPHEMERAL_INBOUND' });
    assert.equal(live.ok, true);
    await waitFor(() => ephemeral.observed.length === 1 && ephemeral.runtime.session.isIdle);
    const held = await ephemeral.tool('comms_inspect', { message: live.data.message.id });
    assert.equal(held.data.recovery.state, 'volatile');
    assert.equal(ephemeral.file(), undefined);
  } finally { await ephemeral.close(); await b.close(); await a.close(); }
});

test('F10 native: saved intent failure prevents dispatch without changing normal tool choice', async () => {
  const a = await participant('writefail-lead'), b = await participant('writefail-reviewer');
  try {
    await a.runtime.session.prompt('Existing saved session');
    const first = await a.tool('comms_message', { to: b.id(), subject: 'Initial', text: 'F10_BEFORE_WRITE_FAILURE' });
    assert.equal(first.ok, true);
    await waitFor(() => b.observed.length === 1 && b.runtime.session.isIdle);
    const file = a.file()!; rmSync(file); mkdirSync(file);
    const failed = await a.tool('comms_message', { to: b.id(), subject: 'Must not send', text: 'F10_MUST_NOT_DISPATCH' });
    assert.equal(failed.ok, false); assert.equal(failed.error.code, 'PERSISTENCE_FAILED');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(b.observed.length, 1);
    assert.doesNotMatch(JSON.stringify((await b.tool('comms_inspect', {})).data), /F10_MUST_NOT_DISPATCH/);
    assert.equal((await a.tool('comms_inspect', { message: first.data.message.id })).ok, true, 'known prior evidence stays inspectable');
  } finally { await b.close(); await a.close(); }
});

test('F10 native: cleared busy-boundary steer remains offered, not falsely posted', async () => {
  const a = await participant('cleared-steer-lead'); let b = await participant('cleared-steer-reviewer');
  let releaseSubscription: (() => void) | undefined;
  try {
    await b.runtime.session.prompt('Saved reviewer context');
    b.observed.length = 0;
    b.hold(true);
    let clearedAtBoundary = false;
    releaseSubscription = b.runtime.session.subscribe(event => {
      // Native session listeners run after extension turn_end handlers.
      // pi-comms has offered the steer, but Pi has not consumed it yet.
      if (event.type === 'turn_end' && !clearedAtBoundary) {
        b.runtime.session.clearQueue();
        clearedAtBoundary = true;
      }
    });
    const busy = b.runtime.session.prompt('Continue this busy review turn.');
    await waitFor(() => b.observed.length === 1);
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Queued during busy work', text: 'NEVER_ADMITTED_STEER' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const id = sent.data.message.id;
    await waitFor(async () => (await b.tool('comms_inspect', { message: id })).ok === true);
    b.release(); await busy;
    releaseSubscription(); releaseSubscription = undefined;
    assert.equal(clearedAtBoundary, true, 'a real turn boundary cleared Pi steering before native admission');
    const held = await b.tool('comms_inspect', { message: id });
    assert.equal(held.ok, true, JSON.stringify(held));
    assert.equal(held.data.intake, 'offered');
    assert.equal(held.data.admission, 'uncertain');
    assert.equal(held.data.facts.some((fact: any) => fact.kind === 'posted' || fact.kind === 'saved'), false);
    assert.equal(batchCount(b, id), 0, 'a cleared steer never appeared in native saved history');
    assert.equal(b.observed.length, 1, 'the peer message did not wake a second model turn');

    const file = b.file()!; await b.close(); b = await participant('cleared-steer-reviewer', SessionManager.open(file));
    const restored = await b.tool('comms_inspect', { message: id });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.data.intake, 'offered');
    assert.equal(restored.data.admission, 'uncertain');
    assert.equal(batchCount(b, id), 0);
    assert.equal(b.observed.length, 0);
    const pending = (await b.tool('comms_inspect', {})).data;
    assert.equal(pending.waiting, 0, 'uncertain work is not counted as normal waiting intake');
    assert.equal(pending.uncertain, 1);
    // The existing human requests path first obtains current consent, then
    // an explicit duplicate-risk decision. It uses the original message ID.
    await b.command('requests');
    assert.ok(b.dialogs.some(dialog => /wants to work with you/.test(dialog)), 'no silent contact reapproval after restart');
    assert.ok(b.dialogs.some(dialog => /may have already received|may make the agent act twice/.test(dialog)), 'duplicate-work risk was disclosed');
    assert.ok(b.dialogs.some(dialog => /If this write succeeds, the choice will be saved in your Pi session for restart/.test(dialog)), 'saved-session prompt states the conditional commit boundary');
    await waitFor(() => b.observed.length === 1 && b.runtime.session.isIdle);
    const admitted = await b.tool('comms_inspect', { message: id });
    assert.equal(admitted.data.intake, 'posted');
    assert.equal(admitted.data.admission, undefined);
    assert.equal(batchCount(b, id), 1);
    const afterAction = b.file()!; await b.close(); b = await participant('cleared-steer-reviewer', SessionManager.open(afterAction));
    const afterRestart = await b.tool('comms_inspect', { message: id });
    assert.equal(afterRestart.data.intake, 'posted');
    assert.equal((await b.tool('comms_inspect', {})).data.uncertain, 0);
    assert.equal(batchCount(b, id), 1, 'owner decision did not create a second message ID or duplicate native post');
    assert.equal(b.observed.length, 0, 'recovered posted message is not woken again');
  } finally {
    releaseSubscription?.();
    await b.close(); await a.close();
  }
});

test('F10 native: owner dismisses a cleared steer through /comms requests, then restart stays quiet', async () => {
  const a = await participant('dismiss-lead'); let b = await participant('dismiss-reviewer');
  let unsubscribe: (() => void) | undefined;
  try {
    await b.runtime.session.prompt('Saved reviewer context'); b.observed.length = 0;
    b.hold(true);
    let cleared = false;
    unsubscribe = b.runtime.session.subscribe(event => {
      if (event.type === 'turn_end' && !cleared) {
        b.runtime.session.clearQueue();
        cleared = true;
      }
    });
    const busy = b.runtime.session.prompt('Busy review before dismissal');
    await waitFor(() => b.observed.length === 1);
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Risk', text: 'CLEAR_THEN_DISMISS' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const id = sent.data.message.id;
    await waitFor(async () => (await b.tool('comms_inspect', { message: id })).ok === true);
    b.release(); await busy;
    unsubscribe(); unsubscribe = undefined;
    assert.equal(cleared, true);
    assert.equal((await b.tool('comms_inspect', { message: id })).data.admission, 'uncertain');
    b.select((_title, options) => options.find(option => option.startsWith('Dismiss')));
    await b.command('requests');
    const dismissed = await b.tool('comms_inspect', { message: id });
    assert.equal(dismissed.data.intake, 'dismissed', JSON.stringify(dismissed));
    assert.equal(dismissed.data.message.text, 'CLEAR_THEN_DISMISS');
    assert.deepEqual((await b.tool('comms_inspect', {})).data.uncertainAdmission, []);
    assert.equal((await b.tool('comms_inspect', {})).data.waiting, 0);
    assert.equal(batchCount(b, id), 0);
    assert.ok(b.dialogs.some(x => /Dismiss uncertain message/.test(x)));
    assert.ok(b.dialogs.some(x => /If this write succeeds, the choice will be saved in your Pi session for restart/.test(x)), 'saved-session dismissal confirmation names the save boundary');
    const file = b.file()!; await b.close(); b = await participant('dismiss-reviewer', SessionManager.open(file));
    assert.equal((await b.tool('comms_inspect', { message: id })).data.intake, 'dismissed');
    const summary = (await b.tool('comms_inspect', {})).data;
    assert.equal(summary.waiting, 0);
    assert.equal(summary.uncertain, 0);
    assert.equal(b.observed.length, 0, 'no model replay of dismissed message on restart');
  } finally { unsubscribe?.(); await b.close(); await a.close(); }
});

test('F10 native: in-memory owner dismissal is live-only, never promised to survive restart', async () => {
  const a = await participant('volatile-decision-lead');
  let b = await participant('volatile-decision-reviewer', SessionManager.inMemory(join(root, 'volatile-decision-reviewer')));
  let unsubscribe: (() => void) | undefined;
  try {
    assert.equal(b.file(), undefined, 'the --no-session equivalent has no file to save');
    b.hold(true);
    let cleared = false;
    unsubscribe = b.runtime.session.subscribe(event => {
      if (event.type === 'turn_end' && !cleared) {
        b.runtime.session.clearQueue();
        cleared = true;
      }
    });
    const busy = b.runtime.session.prompt('Live review while busy');
    await waitFor(() => b.observed.length === 1);
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Live-only decision', text: 'VOLATILE_DISMISSAL' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const id = sent.data.message.id;
    await waitFor(async () => (await b.tool('comms_inspect', { message: id })).ok === true);
    b.release(); await busy;
    unsubscribe(); unsubscribe = undefined;
    assert.equal(cleared, true, 'real native steer was cleared before admission');
    const offered = await b.tool('comms_inspect', { message: id });
    assert.equal(offered.data.admission, 'uncertain');
    assert.equal(offered.data.record.state, 'volatile');

    b.select((_title, options) => options.find(option => option.startsWith('Dismiss')));
    await b.command('requests');
    assert.ok(b.dialogs.some(dialog => /This session is live-only/.test(dialog)), 'owner sees the actual volatile storage boundary');
    assert.ok(b.dialogs.some(dialog => /lost on restart until Pi saves the session/.test(dialog)), 'prompt warns that the choice may not survive');
    const after = await b.tool('comms_inspect', { message: id });
    assert.equal(after.data.intake, 'dismissed', 'owner choice takes effect in this runtime');
    assert.equal(after.data.record.state, 'volatile', 'the native in-memory host cannot certify a saved decision');
    assert.equal((await b.tool('comms_inspect', {})).data.uncertain, 0);
    assert.equal(b.file(), undefined);
    assert.ok(b.notifications.some(note => /Choice is live-only until Pi saves this session/.test(note)), 'success notice repeats actual storage status');

    const oldSession = b.id();
    await b.close();
    b = await participant('volatile-decision-reviewer', SessionManager.inMemory(join(root, 'volatile-decision-reviewer-after-restart')));
    assert.notEqual(b.id(), oldSession, 'a fresh in-memory session cannot resume the previous state');
    assert.equal((await b.tool('comms_inspect', { message: id })).ok, false,
      'the ephemeral decision was not claimed to survive a new process');
  } finally { unsubscribe?.(); await b.close(); await a.close(); }
});

test('F11 native: owner-remembered first contact resumes without a second approval prompt', async () => {
  let a = await participant('f11-remember-lead'); const b = await participant('f11-remember-reviewer');
  try {
    await a.runtime.session.prompt('Saved owner session'); await b.runtime.session.prompt('Saved reviewer session');
    a.remember(true); a.confirm(true);
    const first = await a.tool('comms_message', { to: b.id(), subject: 'Remembered contact', text: 'F11_FIRST_REVIEW' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(a.dialogs.length, 1, 'one owner decision screen including the Remember option');
    assert.match(a.dialogs[0], /Approve and remember this exact session pair/);
    assert.ok(a.notifications.some(s => /Remembered for this exact saved session pair/.test(s)));
    await waitFor(async () => (await b.tool('comms_inspect', { message: first.data.message.id })).ok === true);

    const file = a.file()!, ownerId = a.id();
    await a.close(); a = await participant('f11-remember-lead', SessionManager.open(file));
    assert.equal(a.id(), ownerId);
    a.confirm(false); // No new first-contact prompt may be needed.
    const listed = await a.tool('comms_peers', { view: 'known' });
    assert.ok(listed.data.items.some((p: any) => p.id === b.id() && p.approved), 'only the exact saved pair is remembered');
    const second = await a.tool('comms_message', { to: b.id(), subject: 'Continue remembered work', text: 'F11_AFTER_RESTART' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(a.dialogs.length, 0, 'no repeated owner confirmation after saved-session restart');
    await waitFor(async () => (await b.tool('comms_inspect', { message: second.data.message.id })).ok === true);

    a.confirm(true); await a.command(`revoke ${b.id()}`);
    const afterRevoke = a.file()!;
    await a.close(); a = await participant('f11-remember-lead', SessionManager.open(afterRevoke));
    assert.equal((await a.tool('comms_peers', { view: 'known' })).data.items.some((p: any) => p.id === b.id()), false);
    a.confirm(false);
    const blocked = await a.tool('comms_message', { to: b.id(), subject: 'No remembered grant', text: 'F11_MUST_NOT_SEND' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'CONTACT_NOT_APPROVED');
    assert.equal(a.dialogs.length, 1, 'revoked contact requires a fresh owner decision');
  } finally { await a.close(); await b.close(); }
});

test('F11 native: transported consent does not persist for receiver owner on restart', async () => {
  const a = await participant('f11-provenance-lead'); let b = await participant('f11-provenance-reviewer');
  try {
    await a.runtime.session.prompt('Saved lead'); await b.runtime.session.prompt('Saved receiver');
    a.remember(true); a.confirm(true);
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Owner provenance', text: 'F11_A_REMEMBERS_B' });
    assert.equal(sent.ok, true);
    await waitFor(() => b.observed.some(messages => text(messages).includes('F11_A_REMEMBERS_B')) && b.runtime.session.isIdle);
    assert.equal(b.dialogs.length, 0, 'fresh sender assertion continues the normal receiver path');
    const file = b.file()!;
    await b.close(); b = await participant('f11-provenance-reviewer', SessionManager.open(file));
    const known = await b.tool('comms_peers', { view: 'known' });
    assert.equal(known.data.items.some((p: any) => p.id === a.id()), false, 'A owner choice did not become B remembered approval');
    b.confirm(false);
    const attempt = await b.tool('comms_message', { to: a.id(), subject: 'B must approve', text: 'F11_PROVENANCE_CHECK' });
    assert.equal(attempt.error.code, 'CONTACT_NOT_APPROVED');
    assert.equal(b.dialogs.length, 1, 'B receives its own contact decision, never inherits A choice');
  } finally { await b.close(); await a.close(); }
});

test('F11 native: explicit /comms approve can remember without sending or adding a second dialog', async () => {
  let a = await participant('f11-command-lead'); const b = await participant('f11-command-peer');
  try {
    await a.runtime.session.prompt('Saved owner session'); await b.runtime.session.prompt('Saved colleague session');
    a.remember(true); a.confirm(true);
    await a.command(`approve ${b.id()}`);
    assert.equal(a.dialogs.length, 1, 'explicit setup uses one consent screen, not a second permission dialog');
    assert.match(a.dialogs[0], /Approve and remember this exact session pair/);
    assert.equal((await a.tool('comms_inspect', { outbox: 'self' })).data.items.length, 0, 'approval does not send work');
    const file = a.file()!;
    await a.close(); a = await participant('f11-command-lead', SessionManager.open(file));
    a.confirm(false);
    const known = await a.tool('comms_peers', { view: 'known' });
    assert.ok(known.data.items.some((p: any) => p.id === b.id() && p.approved));
    const msg = await a.tool('comms_message', { to: b.id(), subject: 'Now review', text: 'F11_COMMAND_REMEMBERED' });
    assert.equal(msg.ok, true, JSON.stringify(msg));
    assert.equal(a.dialogs.length, 0, 'remembered explicit owner contact is reused');
  } finally { await a.close(); await b.close(); }
});
