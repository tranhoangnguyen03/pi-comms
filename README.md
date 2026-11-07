# pi-comms

> pi-comms provides shared communication for independently managed agents. Improve continuity, clarity and reach while keeping its concepts small and its behavior consistent.

Read the [product and development principles](https://github.com/tranhoangnguyen03/pi-comms/blob/main/docs/PRINCIPLES.md), [proposed features and milestones](https://github.com/tranhoangnguyen03/pi-comms/blob/main/docs/ROADMAP.md), and [contributor guidance](https://github.com/tranhoangnguyen03/pi-comms/blob/main/AGENTS.md). The roadmap describes proposals; the usage guide below describes current behavior.

Communication between existing Pi sessions: user-approved contacts, exact native session addresses, replies across turns/tools, and human-first batches. It does not launch agents or own their work.

**Independent Pi and PiG agent homes (0.2.0):** Set the same absolute `PI_COMMS_BROKER_DIR` in each participating process, while keeping each `PI_CODING_AGENT_DIR` private. By default, the original agent-home-scoped broker is unchanged. Version 0.2.0 includes F10's same-saved-session recovery (0.1.9), but runtime-only positive approvals still reset; see the [cross-home acceptance recipe](docs/PIG-CROSS-HOME-QUALIFICATION.md). No live PiG model/approval result is claimed by automated broker tests.

User-approved communication for Pi. Install the published package with `pi install npm:pi-comms`. Release availability is shown on [npm](https://www.npmjs.com/package/pi-comms) and [GitHub Releases](https://github.com/tranhoangnguyen03/pi-comms/releases). Tested with Pi 1.4.0; CI verifies Node 22.19.0/24 on Linux and Node 24 on macOS. Other Pi versions are not claimed. [Base integration evidence and limits](docs/BASE-3.md). Historical [spike delivery](docs/GATE-C-DELIVERY.md) and [Gate A/B report](docs/SPIKE-2-REPORT.md) remain unchanged.

## Common calls

```js
comms_message({to: "Reviewer", subject: "Risk review", text: "Review the current diff."})
comms_message({respondTo: "<return handle>", text: "The retry can duplicate a write."})
comms_ask({requests: [
  {to: "Reviewer B", subject: "Risk review", text: "Check correctness."},
  {to: "Reviewer C", subject: "Risk review", text: "Check recovery."}
], timeoutSeconds: 60})
comms_inspect({requests: ["<outgoing message ID>", "<outgoing message ID>"]})
comms_message({to: "Reviewer", subject: "Security review", text: "Check retry safety.", workRef: "AUTH-42", recipientLabel: "Security reviewer"})
comms_inspect({workRef: "AUTH-42"})
comms_message({respondTo: "<real handle>", text: "Risk found; tests pass.", report: {request: "<original message ID>", state: "complete"}, structured: {tests_passing: true, files_changed: []}})
comms_inspect({requests: ["<original message ID>"]})
```

Send is asynchronous; ask waits for the first linked reply to each independent request. **A reply is not task completion.** Common outputs are plain text; scripts receive matching structured details. For example: a send reports acceptance without promising a reply. An ask reports `Reviewer — Reply received`, the full answer and a reusable return handle. Timeout says the wait ended and a late reply can still arrive. Sent means transport accepted, not read or completed.

**Do not send courtesy, formality, acknowledgement-only or closing messages. No “thanks”, “you’re welcome”, “understood”, or “standing by” messages. Send only requested information, necessary questions, corrections or material updates. Once the task is satisfied, stop messaging.** This is guidance, not filtering: substantive polite messages, corrections and late useful answers remain allowed.

## Work references and contextual labels

New messages and `comms_ask` requests can include optional `workRef` (such as `"AUTH-42"`) and `recipientLabel` (such as `"Security reviewer"`). The reference groups this exchange with related work. The label describes the **exact recipient for this exchange** as supplied by the sending session. It is neither a global profile nor permission to direct the recipient. Agents may pass labels supplied by their user; organizing packages can use the same fields without managing roles inside pi-comms.

Replies use only `{respondTo,text}` (plus existing optional refs/corrections): the runtime **inherits the exchange's work reference**, and the sender's recipient label stays attached to the original request. `comms_peers` lists recent sender-supplied labels with their exchange and optional work reference; labels may differ between collaborations. `comms_inspect({workRef:"AUTH-42"})` lists exchanges under that exact reference **only from communication this session may read**; use `comms_inspect({exchange:"<actual UUID>"})` to read that exchange. Previously withheld contents and references remain unavailable to the agent. Earlier authorized history stays readable after a contact's approval expires.

Both `workRef` and `recipientLabel` are optional. Ordinary unscoped messages keep their existing wire format. To use the new metadata with another session, both participants need pi-comms **0.1.4 or later**; older receivers do not understand the added fields and may reject the message. The sender must treat uncertain outcomes as uncertain and never blindly resend. Work references do not confer access, infer task completion or combine transcripts across participants. F10 restores work-linked records in saved Pi sessions, not in fresh or ephemeral sessions.

## Structured replies and colleague-reported work (0.1.5+)

Use **plain text** for the result; add `structured` as an optional JSON object when a caller needs fields such as `tests_passing`, `files_changed` or counts. pi-comms transports the object without interpreting the claims or requiring a domain schema. Nested values must be JSON-safe (strings, booleans, null, arrays, plain objects and **finite** numbers). Invalid values are rejected before sending rather than silently converted, omitted or changed on the wire. The existing message-size bound applies to the combined payload.

A reply may also include `report: {request:"<original request message ID>",state:"complete"}`. The report is **the colleague's statement**, not transport evidence or the requester's acceptance. State can be `progress`, `needs-input` (a question or decision is required), `blocked` or `complete`. Reports are optional; an ordinary reply remains valid and does not require a status.

The original request ID appears in the recipient's incoming message as **Message ID**. The `respondTo` return handle is a separate value. A report must refer to a request actually received from this colleague in the **same exchange**. After a clarification round, reply using the current handle but continue to reference the original request ID in `report.request`. The collapsed ask view names **the reported request**, distinguishes it from the current ask when different, and warns when the report link is unverified. `comms_inspect({requests:[...]})` exposes the latest verified report and how many reports the peer sent, separate from direct reply progress—even when the report replies to a later clarification. Unknown original request records are marked unverified rather than accepted as evidence.

Reports and structured data remain available in human inspection and tool output. Contact revocation blocks new communication but does not hide previously authorized history from the same saved session. `comms_ask` continues to wait for the **first linked reply**; it does not wait for the final report. Later peer reports follow the normal incoming path, with progress-only updates grouped rather than forcing extra model turns.

New `report` and `structured` fields require **pi-comms 0.1.5 or later on both participating sessions**. Older peers may reject these messages; report an uncertain delivery rather than retrying blindly. F10 restores saved-session conversation and report links; fresh and ephemeral sessions retain volatile runtime records until Pi actually saves them.

## Explicit handover to a chosen successor (0.1.8+)

A handover is an **authored new request** to a specific existing Pi session. The lead or organizing system chooses the successor and provides the brief. Use `handoverFrom` with the **earlier exchange ID** (not a message ID or reply handle):

```js
comms_message({
  to: "<successor's exact session ID>",
  subject: "Continue AUTH-42 review",
  text: "Goal: review retries. Known: write duplication risk. Open: test idempotency guard. Report findings.",
  handoverFrom: "<earlier exchange ID>",
  workRef: "AUTH-42",
  refs: [{label:"Proposed fix", uri:"file:///path/to/proposal.md"}]
})
comms_inspect({exchange:"<earlier exchange ID>"}) // shows successor links and actual send outcomes
```

The new recipient must be separately approved. The former session stays unchanged and receives no automatic notice. Nothing copies the earlier transcript, permissions, identity, pending messages, acceptance or return handles. The source exchange must be available to this sending session; unknown or withheld sources fail before dispatch. The successor receives a **sender-supplied pointer**, not access to the old conversation. The sender can inspect the original exchange to find the new one and the observed send outcome. Do not retry uncertain sends blindly.

`comms_ask` may include `handoverFrom` in an ordinary new request; it still waits only for the first reply. The successor reports work on the **new** request ID. Both participants need pi-comms 0.1.8+ for this metadata; older peers may reject it.

## Organizing-package integration (M3-A, 0.1.7+)

A local Pi extension can discover pi-comms through Pi's shared event bus, then call the **same session's** peer discovery, message send and inspection paths. This is an optional developer interface; it adds no agent tools or new setup step for standalone users. It does not launch, replace or manage agents.

See [the organizer integration guide](docs/INTEGRATION.md) for the versioned contract, an example and its security and lifetime limits. Every new contact still requires the ordinary human confirmation. An organizing extension cannot pass a flag that creates contact approval; work and recipient labels remain descriptive. No shared credentials, new broker protocol or cross-process API is created.

## Automatic request-aware outcome delivery (0.1.6+)

No new commands or waiting modes are required. Use `comms_message` to send work without waiting, or ordinary `comms_ask` when the **first reply** is needed. After that, the colleague can use the existing reply handle and optional `report` field to send questions, findings and outcomes. pi-comms delivers useful follow-ups through its **normal incoming-message path**, even when the original ask has finished or timed out.

- A plain reply or `needs-input` report reaches the requester when reception is eligible. Answer a question with its actual `respondTo` handle.
- A `blocked` or `complete` report is delivered with its text, evidence and exact original request ID. It is the colleague's claim, **not** the requester's approval.
- A `progress`-only report remains in that session's existing communication records and `comms_inspect`, but does not create a separate model turn. Earlier progress is summarized when an actionable report is delivered. This applies to normal incoming traffic, **not** the first linked reply that an active `comms_ask` is already collecting.
- If progress arrives **after** completion or blockage, it cannot replace the last actionable state or cause a late progress wake. **Exception:** An explicit `corrects` message is delivered even when it reports `progress`—the correction may retract evidence already shown. A corrective progress report becomes the current reported state. `comms_inspect({requests:[...]})` shows `currentReport` for the latest actionable claim (including a correction), `latestReport` for the latest received report, and `laterProgressCount` when relevant. Progress remains visible in conversation previews until an actual actionable report supersedes it. All original messages remain available via exact message and exchange inspection.
- A later correction that reports `blocked` or `complete` still reaches the requester. The reported state follows receipt order; it is **not** a verified task lifecycle or an ordering guarantee for remote work.

Normal contact approval, revocation, Pause, editor-draft priority, exact session identities and existing delivery uncertainty still govern the incoming messages. Progress-only records held during Pause or pending approval are not silently admitted. The runtime marks suppressed progress as **retained in inspection, not posted to Pi**; it does not claim that the model saw it.

## Presence, message outcomes and recipes

`comms_peers({})` distinguishes whether each colleague is **online/offline** from host-observed **working/idle/unknown** activity. It shows when the last activity report was observed. The broker timestamps only status-bearing reports; normal name updates do not refresh activity freshness. Working/idle reports normally refresh every 60 seconds and become stale after 180 seconds. A stale status is **unknown**, with the earlier report available as history, not current progress. Offline peers have unavailable activity. The legacy `lastActivity` field is a general broker-contact timestamp, not proof of agent work; use `activityObservedAt` for the last working/idle report. A working session may be busy on unrelated work; these observations do not establish progress or completion of your request.

Tool results, message inspection and expanded cards use consistent labels for transport acceptance, receiver buffering, posting to Pi, observed saving, responses and uncertain outcomes. Sending still proves only transport acceptance. `comms_ask` still returns each request's first linked reply or local ending, not task completion. An interrupted or timed-out wait does not cancel remote work; do not resend when delivery is uncertain.

For short, on-demand workflows, use the bundled Pi skill **`/skill:pi-comms`**. It covers choosing `comms_message` versus `comms_ask`, multi-round clarification, late replies, Pausing reception, and drafting a deliberate handover to a different existing session. Pi advertises the skill's name and purpose when it discovers the package; the full instructions load only on demand. Loading the skill is optional; the four agent tools work without it.

## Saved-session recovery (M4-A / F10 — 0.1.9)

A saved Pi session retains communication records, original request/reply/report/correction and handover links, reusable return handles, previously authorized history, Pause and explicit revocation. pi-comms restores those facts **before broker registration** and checks native history before admitting old incoming messages. It never replays uncertain outgoing requests or restarts an old `comms_ask` wait.

**Past access is not new permission.** Previously agent-readable incoming messages remain inspectable in the same saved session after contact approval expires or a contact is revoked. Incoming content that was withheld stays withheld, and new sends/intake still need current consent. Positive contact approval remains runtime-only until F11.

**Limits:** A fresh, unused or `--no-session` run continues with live-only records until Pi writes a real saved session. We do not fabricate turns or force Pi's file flush. Storage outcomes show `saved`, `volatile` or `partial` evidence. Corrupt or unknown saved controls hold unsafe communication while verified history remains inspectable; recovery does not block unrelated Pi work. Native session persistence does not promise protection from disk loss or an interrupted host write.

**Still pending:** F11's optional remembered contact approval and F12's durable offline queue. The public exact-session send still rejects unavailable recipients. See [M4 recovery design and limits](docs/M4-RECOVERY-CONTRACT.md). The separate M3 real-agent handover evaluation is not an F10 recovery test.

## Build and try in isolation

```sh
npm ci --ignore-scripts
npm run build
npm run test:base
npm pack --ignore-scripts   # build first; produces pi-comms-0.1.9.tgz
```

To try without modifying normal Pi settings, use an owned temporary agent directory and the unpacked package:

```sh
mkdir -p /tmp/comms-try/package
# Extract the reviewed tarball into /tmp/comms-try/package (npm tarballs contain package/).
tar -xzf pi-comms-0.1.8.tgz -C /tmp/comms-try
PI_CODING_AGENT_DIR=/tmp/comms-try/agent pi -e /tmp/comms-try/package
```

Launch the second Pi with the same isolated agent directory. No mandatory init command. The local broker starts at session startup, not factory evaluation. It uses `comms/` under the configured agent directory, separately from intercom. No automatic bridge or migration of existing intercom asks.

For a reproducible installation, check the version on npm, then pin it (for example, `pi install npm:pi-comms@0.1.6`, which is published). The `0.1.8` tarball above describes this development candidate, **not** a claim that npm has published it. Use the isolated instructions above when evaluating unpublished changes. Release lifecycle and initial npm setup are documented in [RELEASING.md](RELEASING.md).

## First run

Ask your agent to work with the colleague, for example:

> Have Reviewer review the current implementation and return supported findings. Do not edit.

The agent discovers the exact colleague and attempts the send. **First contact opens a native human confirmation** with colleague, work and Yes/No consequences first. Request preview, exact session and approval lifetime follow. Allow it and that same send continues—no setup command, ID relay or repeated task prompt.

**One approval per exact pair of sessions, not per tool or work item.** In this same-owner local workflow, an approved A→B contact authorizes later `comms_message` and `comms_ask` calls between A and B in **both directions**, without more prompts while the runtimes retain approval. The initial work description is context, **not** an enforced per-task limit or permission to perform unrelated work. The requester sends this contact approval as exact-target transport metadata, separate from the agent message; the receiver accepts without another prompt but still follows its own user directives, Pause/revoke and native tool permissions. Approval of A↔B never approves B↔C. Each distinct first contact (such as A→B and A→C) needs its own decision; concurrent decisions stay independent. Approvals reset on reload/session switch/restart, and an explicit revocation blocks trust until the owner reapproves.

**No/Esc at a first-contact prompt is a durable refusal in either direction** for that saved Pi session: no outgoing message is sent and later incoming transport assertions cannot reapprove the exact peer. Stop/abort of an in-flight tool cancels that attempt without saving a refusal. `/comms requests` lets the human reconsider held incoming contacts; `/comms approve` can explicitly reapprove an exact contact for later sends. Receiver **Pause** holds admission/wakes. Already-admitted content is not retracted. Fresh/ephemeral sessions retain live-only controls until Pi saves them. Reapproval is a human choice, not automatic permission from another agent.

Unapproved content remains fully human-visible in `/comms inspect`; model inspection returns only IDs and a contact-approval hold, withholding subject, body, references and return handle. Noninteractive callers without human approval UI fail with an actionable approval-required result; no consent is inferred. Native Stop or session replacement cancels pending approval without sending. Peer messages cannot broaden approval or bypass host tool permissions. This trust model is for one owner's local sessions, not mutually untrusted users or malicious same-account processes. Runtime metadata and prompt attribution are not a security sandbox.

## Everyday commands

- `/comms` or `/comms status`: current approval, waiting count, recovery/storage state and broker location.
- `/comms requests`: review held incoming contact requests **and uncertain native admission**. For an uncertain message, choose **Deliver again** (warns of possible duplicate model work; requires current consent; retains its ID) or **Dismiss** (no further pi-comms intake). In a saved Pi session, the choice is stored for restart once the write succeeds. Fresh and `--no-session` choices are live-only until Pi actually saves the session; the confirmation and result notice state which applies.
- `/comms approve [exact-session-id]`: optional explicit contact setup/change through human selection/context/confirmation.
- `/comms revoke [exact-session-id]`: remove contact approval after confirmation; queued traffic remains held.
- `/comms pause`: keep buffering arrivals without peer admission/wakes.
- `/comms resume`: resume eligible intake.
- `/comms inspect [message-id]`: read waiting messages or a specific message without consuming/admitting it. The read-only view shows counterpart, subject, full content, references and observed state—not editable JSON. Use arrows/PageUp/PageDown to scroll, **d** for technical evidence, **n/p** for more/previous messages, and **Esc/q** to close. It is a snapshot, not a second inbox. A malformed ID produces a notice rather than opening unrelated messages; an unavailable ID explains that it is not in the current saved session (older memory-only records cannot be reconstructed). RPC clients use equivalent read-only selections; model inspection is plain text and script results retain structured evidence.

**Stop ends the current run. A queued or later peer message can wake it again. Pause holds incoming peer admission/wakes until Resume.** Pause does not stop existing work or retract admitted content. Stop/corrections do not roll back effects already performed.

Native inline cards show one counterpart/subject heading followed by the full payload. Ctrl+O reveals IDs, timestamps and receipt evidence. Corrections, context loss and unknown receipt state remain visible. The footer shows waiting/paused/hold state. Already-pending native input and checked editor drafts win at admission. Input after posting may follow the batch. There is no universal arbitrary-modal detector. Use Pause when you want reception held.

## Agent tools

- `comms_peers({})`: approved online peers first, other online peers marked approval-required, then known offline peers. Includes collaboration context and observed activity where available. `view: "known"` filters to approved peers. Discovery never contacts anyone. If none are reachable, check that all participants load pi-comms and share its broker agent directory; intercom-only sessions are not bridged.
- `comms_message({to, subject, text, refs?, corrects?})`: start an exchange using a native ID or current exact unique name; first contact asks the requester and continues this send if allowed. Do not ask the user to preconfigure contacts. Cancellation sends nothing; do not retry unless the user asks.
- `comms_message({respondTo, text, refs?, corrects?})`: answer the clearly labelled **reusable** return handle after turns/tools; it is not consumed by a reply. Omit `to` and `subject`. In a saved Pi session, original handles survive reload/restart; switching to another session does not transfer them. New sends still require current contact approval.
- `comms_ask({requests:[messageInput,...],timeoutSeconds?})`: one to 30 independent new-message or respondTo requests. Dispatches approved requests without waiting for earlier answers, including under serial host tool scheduling. Each item returns its first exact linked reply, refusal/error, timeout or local ending; one item does not cancel siblings. Multiple ask calls may overlap.
- `comms_inspect({requests:[outgoingMessageId,...]})`: who replied to each selected request and the latest reply, plus response count. An older response in the same exchange does not answer a newer request. Distinguishes no reply yet, rejected, unknown and unavailable records; never infers task completion. Use the exchange for full history.
- `comms_inspect({})`: compact overview of **normal waiting vs uncertain native admission**, paused/receiving state, recent exchanges and uncertain outgoing operations. It is read-only; the human resolves uncertain arrivals through `/comms requests`.
- `comms_inspect({peer,cursor?})`: list a peer's exchanges with latest activity/preview; peer accepts a native ID or current exact unique name.
- `comms_inspect({message})`, `({exchange,cursor?})`, `({queue:"self",cursor?})`, `({outbox:"self",cursor?})`: non-consuming runtime evidence. Use only one selector. All model views withhold incoming payloads/handles not yet authorized for that session; previously authorized history stays readable even after approval expires or is revoked. Not a polling duty.

Provider declarations expose described top-level fields. Runtime checks enforce mutually exclusive send/reply and inspection selectors; unknown fields still reject. An exact unique name resolves **once** to its native ID before validation/approval. Ambiguous names return explicit native-ID choices; no fuzzy/prefix matching or name substitution while waiting or retrying. Corrections reference the sender's prior message to the same peer. References are pointers, never uploads. Messages over 900,000 serialized bytes reject with a reference-based next step. Inspection pages retain full approved items and return a cursor. `localTransport.connectivity` describes this session's broker connection, not the counterpart's presence; use `comms_peers` for exact colleague presence. Multiple replies are allowed, not owed. Incoming model text puts sender/subject and full payload first, then `Reply with respondTo: "<handle>"`. Successful send text is concise; full structured records remain available to scripts and inspection.

### Ask timing and interruption

The default wait is **60 seconds**, configurable per call from **0.1 to 600 seconds**. These are practical bounds, not validated UX timing. Each item's clock starts when its send returns transport acceptance, after its contact decision. Human-dialog time is excluded, including another item's queued contact decision; an already running clock resumes with its remaining time. No timeout resends or cancels anything remotely. A clarification counts as the first reply, not completed work; use its reusable handle for another round.

Matched replies can enter the ask result while this session is busy with that ask, but not ahead of pending human input/drafts, Pause or contact approval/revocation. Stop/human interruption, Pause, revoke, disconnect and runtime replacement end affected local waits. Replies not yet handed off remain queued for eligible intake; late replies follow ordinary intake. No claim is made that a remote task continues running.

Direct native ask replies stay claimed until model-context admission: they are not also posted as unsolicited batches. A reply handed to a nested caller is a completed handoff, not a native post or a waiting message after restart. If interrupted before admission, the old tool result is projected without the withheld answer and the answer remains queued. Nested tool calls hand structured results to their calling tool instead; that caller owns any subsequent transformation or omission. This handoff is not evidence of a saved child transcript entry or cognitive receipt. Full underlying messages remain inspectable in existing runtime records. Saved evidence is recorded only when a native session entry is observed. A local busy label means **this session is working; incoming messages are buffered**, not that a peer is doing the requested task.

### Recovery

For a routing validation error, retry with exactly `{to, subject, text}` for a new message or `{respondTo, text}` for a reply. `refs` and `corrects` are optional; never invent a correction ID to satisfy a tool declaration. Routing validation rejects before sending. If a provider presents every routing field as required, that declaration conflicts with pi-comms: the serialized message schema requires only `text`, and runtime validation enforces the routing combination. Custom `openai-completions` gateways that treat an omitted `strict` field as required-all-fields need `"compat": {"supportsStrictMode": true}` in `~/.pi/agent/models.json` so Pi emits explicit `"strict": false`. Compare the loaded extension schema and the provider's outbound payload before changing the tool interface. Tests cover serialized schemas, Google and OpenAI Responses conversion, and the OpenAI Completions outbound payload without network access; downstream gateway rewriting is not covered.

Same-ID reconnect refresh is internal: after a definite stale-epoch rejection, re-resolve only that same native ID once and recheck approval. Unknown send outcome never automatically retries. Concurrent active claims are rejected explicitly. A fork/new session has a different identity. Renaming a session updates discovery and contact labels without changing its native ID or approval binding; clearing its name restores the UUID display fallback.

## Facts and volatile state

- **Accepted:** broker/socket transport accepted it. Not proof the recipient model saw it.
- **Queued:** receiver memory holds it.
- **Offered:** pi-comms asked Pi to handle the batch; a busy-session steer can still be cleared before admission. The item is **uncertain**, not normally waiting, until native evidence or an explicit owner choice resolves it. `/comms inspect` shows the original message; `/comms requests` offers a deliberate retry or dismissal. Retry may cause duplicate model work and never creates a fresh message ID. Dismissal stops pi-comms reoffers but cannot retract a steer that Pi already holds.
- **Posted:** the matching message appears in Pi's native session history, or a direct ask result was admitted to context; evidence is scoped to the actual host boundary, not proof the model did useful work.
- **Handed off:** a nested ask reply reached its calling tool. This is complete for that handoff, but does not prove model consumption or a saved child transcript; recovery must not queue it again.
- **Dismissed:** the owner stopped pi-comms intake for one uncertain arrival; the original message remains inspectable and any independently queued Pi steer cannot be recalled.
- **Saved:** a native session entry was actually observed on disk, distinct from an in-memory native entry.
- **Response:** a linked peer message exists. None of these means work completed.

F10 restores saved-session message/outbox records, authorized historical visibility, reply handles, Pause and explicit negative controls after reload or restart. Positive contact approvals still reset; a new send may require the existing approval flow. Fresh unused or in-memory sessions remain live-only until Pi saves them; an interrupted native write does not establish durability. Local ask waiters never resume automatically. Inspect unknown outgoing results before attempting new work. The broker's inherited mailbox remains memory-only; the public exact-send path still rejects unavailable peers until F12.

## Update and rollback

Pause and finish/inspect outstanding work before replacing the package. Record useful work products outside the transport. Exit participating sessions and their shared broker, replace the reviewed artifact, then restart and renew contacts. Requester-only approval requires the `owner-contact-v1` broker capability and matching reviewed participant artifacts; an older broker rejects this send path rather than silently dropping the approval. Rollback uses the retained older artifact, but pre-F10 builds cannot restore F10 native communication records. Do not erase or rewrite saved session files during rollback; return to a compatible build to recover those records. No automatic work replay or durable offline delivery is promised. Do not blindly repeat uncertain sends after restart.

## Verification

After `npm ci --ignore-scripts`, run the complete check in the required order:

```sh
npm run verify            # prepare pinned fixture, build/typecheck, all tests, originals, installed artifact
```

Individual steps:

```sh
npm run prepare:fixture   # required before npm test in a fresh checkout; downloads pinned MIT upstream
npm run test:base          # builds + tests production path, no paid calls
npm test                  # Base and historical/prototype tests, no paid calls
npm run test:original      # separate pinned original-intercom regressions
npm run check
npm run test:artifact     # pack/install in isolation + rerun Base model/tool and lifecycle journeys
```

Packaged-artifact installation is tested in a temporary prefix/agent directory, never a normal installation. Dependency advisory assessment, exact evidence and the outstanding **real-person walkthrough** are in [BASE-3.md](docs/BASE-3.md). Automated TUI/scripted-provider tests are not human usability validation.
