import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { RECORD_TYPE } from '../src/session-records.ts';

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
  const observed: any[][] = [], notifications: string[] = [], dialogs: string[] = [], consentChoices: string[][] = [];
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
      if (choices.includes('Allow this session')) {
        dialogs.push(title); consentChoices.push([...choices]);
        if (choices.includes('Cancel') && selectChoice) return selectChoice(title, choices);
        return confirm ? (rememberNext ? choices[1] : choices[0]) : choices[2];
      }
      return selectChoice ? selectChoice(title, choices) : choices[0];
    },
  } });
  await bind(runtime.session); runtime.setRebindSession(bind);
  return { runtime, manager, observed, notifications, dialogs, consentChoices,
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
    a.confirm(false);
    const blocked = await a.tool('comms_message', { to: oldId, subject: 'Blocked', text: 'F10_MUST_NOT_CROSS_REVOKE' });
    assert.equal(blocked.error.code, 'CONTACT_NOT_APPROVED', 'broker refuses new sends after either endpoint revokes');
    await b.command('resume'); await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(b.observed.length, 0);
    // The saved return handle remains valid once the same owner explicitly
    // reapproves the pair. Historic content is not erased by revocation.
    b.confirm(true);
    await b.command(`approve ${a.id()}`);
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
    assert.ok(b.dialogs.some(dialog => /to contact you/.test(dialog)), 'no silent contact reapproval after restart');
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
    assert.ok(a.consentChoices[0].some(choice => /Allow & remember/.test(choice)));
    assert.ok(a.notifications.some(s => /allowed and remembered for this pair/.test(s)));
    await a.command('status');
    assert.match(a.notifications.at(-1)!, /remembered until revoked/, 'human status shows the saved choice');
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
    await a.command('status');
    assert.match(a.notifications.at(-1)!, /remembered until revoked/);
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

test('F11 native: one remembered A-B pair lets B send first after both original sessions restart', async () => {
  let a = await participant('f11-bilateral-lead'), b = await participant('f11-bilateral-reviewer');
  try {
    await a.runtime.session.prompt('Saved lead'); await b.runtime.session.prompt('Saved reviewer');
    a.remember(true); a.confirm(true);
    const initial = await a.tool('comms_message', { to: b.id(), subject: 'Remember bilateral pair', text: 'F11_SHARED_PAIR' });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    await waitFor(async () => (await b.tool('comms_inspect', { message: initial.data.message.id })).ok === true);

    const aFile = a.file()!, bFile = b.file()!;
    const aId = a.id(), bId = b.id();
    await a.close(); await b.close();
    a = await participant('f11-bilateral-lead', SessionManager.open(aFile));
    b = await participant('f11-bilateral-reviewer', SessionManager.open(bFile));
    assert.equal(a.id(), aId); assert.equal(b.id(), bId);
    a.confirm(false); b.confirm(false);
    const reverse = await b.tool('comms_message', { to: a.id(), subject: 'B first after restart', text: 'F11_B_FIRST' });
    assert.equal(reverse.ok, true, JSON.stringify(reverse));
    assert.equal(b.dialogs.length, 0, 'the one remembered pair authorizes B first without another dialog');
    await waitFor(async () => (await a.tool('comms_inspect', { message: reverse.data.message.id })).ok === true);
    const forward = await a.tool('comms_message', { to: b.id(), subject: 'A second', text: 'F11_A_SECOND' });
    assert.equal(forward.ok, true, JSON.stringify(forward));
    assert.equal(a.dialogs.length, 0, 'A also reuses the same pair consent');
  } finally { await b.close(); await a.close(); }
});

test('F11 native: explicit /comms approve can remember without sending or adding a second dialog', async () => {
  let a = await participant('f11-command-lead'); const b = await participant('f11-command-peer');
  try {
    await a.runtime.session.prompt('Saved owner session'); await b.runtime.session.prompt('Saved colleague session');
    a.remember(true); a.confirm(true);
    await a.command(`approve ${b.id()}`);
    assert.equal(a.dialogs.length, 1, 'explicit setup uses one consent screen, not a second permission dialog');
    assert.ok(a.consentChoices[0].some(choice => /Allow & remember/.test(choice)));
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

test('F11 native: editing an existing remembered grant can be cancelled or Esc without changing saved consent', async () => {
  let a = await participant('f11-grant-cancel-lead');
  const b = await participant('f11-grant-cancel-peer');
  try {
    await a.runtime.session.prompt('Saved owner session');
    await b.runtime.session.prompt('Saved peer session');
    a.remember(true);
    await a.command(`approve ${b.id()}`);
    await a.command('status');
    assert.match(a.notifications.at(-1)!, /remembered until revoked/);
    const firstCount = a.dialogs.length;

    for (const result of [
      (_title: string, choices: string[]) => choices.find(choice => choice.startsWith('Cancel')),
      (_title: string, _choices: string[]) => undefined, // Escape
    ]) {
      a.select(result);
      await a.command(`approve ${b.id()}`);
      assert.ok(a.consentChoices.at(-1)?.some(choice => /Cancel/.test(choice)));
      assert.ok(a.dialogs.at(-1)?.includes('This command sends nothing'));
      assert.ok(a.dialogs.at(-1)?.includes("Cancel leaves existing approval unchanged"));
      await a.command('status');
      assert.match(a.notifications.at(-1)!, /remembered until revoked/);
    }
    assert.equal(a.dialogs.length, firstCount + 2, 'only the two grant editing screens were added');
    assert.equal((await a.tool('comms_inspect', { outbox: 'self' })).data.items.length, 0);

    const file = a.file()!, id = a.id();
    await a.close(); a = await participant('f11-grant-cancel-lead', SessionManager.open(file));
    assert.equal(a.id(), id);
    a.confirm(false);
    const known = await a.tool('comms_peers', { view: 'known' });
    assert.ok(known.data.items.some((item: any) => item.id === b.id()), 'cancel and Escape did not remove the saved grant');
    const sent = await a.tool('comms_message', { to: b.id(), subject: 'Still approved', text: 'RETAINED_REMEMBERED_CONSENT' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(a.dialogs.length, 0, 'restart uses the preserved grant without another owner prompt');
  } finally { await a.close(); await b.close(); }
});


test('F11 native: revoking from B ends one shared pair for both sides and survives restart', async () => {
  let a = await participant('f11-revoke-b-a'), b = await participant('f11-revoke-b-b');
  try {
    await a.runtime.session.prompt('Saved A'); await b.runtime.session.prompt('Saved B');
    a.remember(true); a.confirm(true);
    const first = await a.tool('comms_message', { to: b.id(), subject: 'Shared contact', text: 'PAIR_BEFORE_B_REVOKE' });
    assert.equal(first.ok, true, JSON.stringify(first));
    await waitFor(async () => (await b.tool('comms_inspect', { message: first.data.message.id })).ok === true);
    assert.ok((await b.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === a.id()));

    b.confirm(true); await b.command(`revoke ${a.id()}`);
    await waitFor(async () => !(await a.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === b.id()));
    assert.equal((await b.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === a.id()), false);
    const afile = a.file()!, bfile = b.file()!;
    await a.close(); await b.close();
    a = await participant('f11-revoke-b-a', SessionManager.open(afile));
    b = await participant('f11-revoke-b-b', SessionManager.open(bfile));
    assert.equal((await a.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === b.id()), false);
    assert.equal((await b.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === a.id()), false);
    a.confirm(false); b.confirm(false);
    const blocked = await a.tool('comms_message', { to: b.id(), subject: 'Blocked after B revoked', text: 'MUST_NOT_CROSS_REVOKE' });
    assert.equal(blocked.error.code, 'CONTACT_NOT_APPROVED');
    a.confirm(true);
    await a.command(`approve ${b.id()}`); // Fresh explicit owner action after a completed revoke.
    const regrant = await a.tool('comms_message', { to: b.id(), subject: 'Fresh owner reapproval', text: 'PAIR_RESTORED' });
    assert.equal(regrant.ok, true, JSON.stringify(regrant));
    await waitFor(async () => (await b.tool('comms_inspect', { message: regrant.data.message.id })).ok === true);
  } finally { await a.close(); await b.close(); }
});

test('F11 native: forking B never grants new A-B_new pair', async () => {
  const a = await participant('f11-fork-a'), b = await participant('f11-fork-b');
  let bNew: Awaited<ReturnType<typeof participant>> | undefined;
  try {
    await a.runtime.session.prompt('Saved A'); await b.runtime.session.prompt('Saved B');
    a.remember(true); a.confirm(true);
    const first = await a.tool('comms_message', { to: b.id(), subject: 'Old pair', text: 'OLD_PAIR_WORK' });
    assert.equal(first.ok, true);
    await waitFor(async () => (await b.tool('comms_inspect', { message: first.data.message.id })).ok === true);
    const fork = SessionManager.forkFrom(b.file()!, join(root, 'f11-fork-b-new'), join(root, 'f11-fork-sessions'));
    bNew = await participant('f11-fork-b-new', fork);
    assert.notEqual(b.id(), bNew.id());
    assert.equal((await a.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === bNew!.id()), false);
    a.confirm(false); bNew.confirm(false);
    assert.equal((await a.tool('comms_message', { to: bNew.id(), subject: 'No fork inheritance', text: 'UNAUTHORIZED_FORK' })).error.code, 'CONTACT_NOT_APPROVED');
    assert.equal((await bNew.tool('comms_message', { to: a.id(), subject: 'No reverse inheritance', text: 'UNAUTHORIZED_REVERSE_FORK' })).error.code, 'CONTACT_NOT_APPROVED');
    const original = await a.tool('comms_message', { to: b.id(), subject: 'Original pair continues', text: 'STILL_OLD_PAIR' });
    assert.equal(original.ok, true, JSON.stringify(original));
  } finally { await bNew?.close(); await b.close(); await a.close(); }
});

test('F11 native: normal unregister expires session-only pair and ends outstanding ask', async () => {
  let a = await participant('f11-unregister-a');
  let b = await participant('f11-unregister-b');
  try {
    await a.runtime.session.prompt('Saved A'); await b.runtime.session.prompt('Saved B');
    a.remember(false); a.confirm(true);
    const subject = 'PENDING_ASK_DURING_NORMAL_UNREGISTER';
    const pending = a.tool('comms_ask', {
      requests: [{ to: b.id(), subject, text: 'Please answer after you finish' }],
      timeoutSeconds: 60,
    });
    await waitFor(async () => (await a.tool('comms_inspect', { outbox: 'self' }))
      .data.items.some((entry: any) => entry.message.subject === subject));
    const bId = b.id(), bFile = b.file()!;
    assert.ok((await a.tool('comms_peers', { view: 'known' })).data.items.some((p: any) => p.id === bId));

    // This is the production normal path: client sends 'unregister' before
    // closing, not an abrupt socket.destroy or process kill.
    await b.close();
    const outcome = await Promise.race([pending, new Promise<never>((_, reject) =>
      setTimeout(() => reject(Error('Normal unregister stranded an active ask')), 1500).unref())]);
    assert.equal(outcome.data.items[0].outcome, 'disconnected',
      'expiry event reaches remaining participant and ends its actual ask');
    await waitFor(async () => !(await a.tool('comms_peers', { view: 'known' }))
      .data.items.some((p: any) => p.id === bId));
    await a.command('status');
    assert.ok(!a.notifications.at(-1)!.includes(bId), 'human approval status is no longer stale');

    b = await participant('f11-unregister-b', SessionManager.open(bFile));
    assert.equal(b.id(), bId);
    assert.equal((await a.tool('comms_peers', { view: 'known' }))
      .data.items.some((p: any) => p.id === bId), false,
      'reconnecting the same original session does not revive session-only approval');
    a.confirm(false);
    const blocked = await a.tool('comms_message', {
      to: bId, subject: 'New consent needed', text: 'No silent approval after reconnect',
    });
    assert.equal(blocked.error.code, 'CONTACT_NOT_APPROVED');
  } finally { await b.close(); await a.close(); }
});

test('F11 native migration: saved F10 refusal at B cancels A remembered grant, until explicit reapproval', async () => {
  let a = await participant('f11-migrate-a'), b = await participant('f11-migrate-b');
  try {
    await a.runtime.session.prompt('A existing saved session');
    await b.runtime.session.prompt('B existing saved session');
    a.confirm(true); a.remember(true);
    const before = await a.tool('comms_message', {
      to: b.id(), subject: 'Old collaboration', text: 'BEFORE_F10_UPGRADE',
    });
    assert.equal(before.ok, true, JSON.stringify(before));
    await waitFor(async () => (await b.tool('comms_inspect', { message: before.data.message.id })).ok === true);
    assert.ok((await a.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === b.id()));

    // Model an actual saved refusal left by a prior F10 build at B.
    // B joins with its original native ID. It must import this negative
    // before the broker permits the old remembered grant from A.
    const bId = b.id(), bFile = b.file()!, aId = a.id();
    await b.close();
    const bSaved = SessionManager.open(bFile);
    bSaved.appendCustomEntry(RECORD_TYPE, {
      version: 1, owner: bId, scope: root, writeId: randomUUID(),
      event: { kind: 'contact', peer: aId, revoked: true },
    });
    b = await participant('f11-migrate-b', bSaved);
    assert.equal(b.id(), bId);
    await waitFor(async () => !(await a.tool('comms_peers', { view: 'known' }))
      .data.items.some((peer: any) => peer.id === bId));
    assert.equal((await b.tool('comms_peers', { view: 'known' }))
      .data.items.some((peer: any) => peer.id === aId), false);
    assert.equal((await a.tool('comms_message', {
      to: bId, subject: 'Do not bypass refusal', text: 'MUST_NOT_SEND_WITH_OLD_GRANT',
    })).error.code, 'CONTACT_NOT_APPROVED', 'an old remembered A grant cannot cancel B saved No');

    // One fresh explicit owner choice can restore the same unordered pair.
    a.confirm(true); a.remember(true);
    await a.command(`approve ${bId}`);
    assert.ok((await a.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === bId));
    assert.ok((await b.tool('comms_peers', { view: 'known' })).data.items.some((peer: any) => peer.id === aId));
    b.confirm(false);
    const reverse = await b.tool('comms_message', {
      to: aId, subject: 'B first after reapproval', text: 'MIGRATION_OWNER_REAPPROVED',
    });
    assert.equal(reverse.ok, true, JSON.stringify(reverse));
    assert.equal(b.dialogs.length, 0, 'one shared owner decision is enough for either direction');

    // Restart B with the exact same old F10 refusal still in its file:
    // importing its already-seen native entry must NOT revoke anew.
    const savedAgain = b.file()!;
    await b.close();
    b = await participant('f11-migrate-b', SessionManager.open(savedAgain));
    assert.equal(b.id(), bId);
    assert.ok((await b.tool('comms_peers', { view: 'known' }))
      .data.items.some((peer: any) => peer.id === aId),
      'the older native refusal is already imported, not replayed over new approval');
    assert.ok((await a.tool('comms_peers', { view: 'known' }))
      .data.items.some((peer: any) => peer.id === bId));
  } finally { await b.close(); await a.close(); }
});
