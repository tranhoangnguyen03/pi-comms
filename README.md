# pi-comms

> pi-comms provides shared communication for independently managed agents. Improve continuity, clarity and reach while keeping its concepts small and its behavior consistent.

Read the [product and development principles](https://github.com/tranhoangnguyen03/pi-comms/blob/main/docs/PRINCIPLES.md), [proposed features and milestones](https://github.com/tranhoangnguyen03/pi-comms/blob/main/docs/ROADMAP.md), and [contributor guidance](https://github.com/tranhoangnguyen03/pi-comms/blob/main/AGENTS.md). The roadmap describes proposals; the usage guide below describes current behavior.

Communication between existing Pi sessions: user-approved contacts, exact native session addresses, replies across turns/tools, and human-first batches. It does not launch agents or own their work.

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
```

Send is asynchronous; ask waits for the first linked reply to each independent request. **A reply is not task completion.** Common outputs are plain text; scripts receive matching structured details. For example: a send reports acceptance without promising a reply. An ask reports `Reviewer — Reply received`, the full answer and a reusable return handle. Timeout says the wait ended and a late reply can still arrive. Sent means transport accepted, not read or completed.

**Do not send courtesy, formality, acknowledgement-only or closing messages. No “thanks”, “you’re welcome”, “understood”, or “standing by” messages. Send only requested information, necessary questions, corrections or material updates. Once the task is satisfied, stop messaging.** This is guidance, not filtering: substantive polite messages, corrections and late useful answers remain allowed.

## Presence, message outcomes and recipes

`comms_peers({})` distinguishes whether each colleague is **online/offline** from host-observed **working/idle/unknown** activity. It shows when the last activity report was observed. The broker timestamps only status-bearing reports; normal name updates do not refresh activity freshness. Working/idle reports normally refresh every 60 seconds and become stale after 180 seconds. A stale status is **unknown**, with the earlier report available as history, not current progress. Offline peers have unavailable activity. The legacy `lastActivity` field is a general broker-contact timestamp, not proof of agent work; use `activityObservedAt` for the last working/idle report. A working session may be busy on unrelated work; these observations do not establish progress or completion of your request.

Tool results, message inspection and expanded cards use consistent labels for transport acceptance, receiver buffering, posting to Pi, observed saving, responses and uncertain outcomes. Sending still proves only transport acceptance. `comms_ask` still returns each request's first linked reply or local ending, not task completion. An interrupted or timed-out wait does not cancel remote work; do not resend when delivery is uncertain.

For short, on-demand workflows, use the bundled Pi skill **`/skill:pi-comms`**. It covers choosing `comms_message` versus `comms_ask`, multi-round clarification, late replies, Pausing reception, and drafting a deliberate handover to a different existing session. Pi advertises the skill's name and purpose when it discovers the package; the full instructions load only on demand. Loading the skill is optional; the four agent tools work without it.

## Build and try in isolation

```sh
npm ci --ignore-scripts
npm run build
npm run test:base
npm pack --ignore-scripts   # build first; produces pi-comms-0.1.2.tgz
```

To try without modifying normal Pi settings, use an owned temporary agent directory and the unpacked package:

```sh
mkdir -p /tmp/comms-try/package
# Extract the reviewed tarball into /tmp/comms-try/package (npm tarballs contain package/).
tar -xzf pi-comms-0.1.2.tgz -C /tmp/comms-try
PI_CODING_AGENT_DIR=/tmp/comms-try/agent pi -e /tmp/comms-try/package
```

Launch the second Pi with the same isolated agent directory. No mandatory init command. The local broker starts at session startup, not factory evaluation. It uses `comms/` under the configured agent directory, separately from intercom. No automatic bridge or migration of existing intercom asks.

For a reproducible installation, check the version on npm, then pin it (for example, `pi install npm:pi-comms@0.1.1` while that version is published). The `0.1.2` tarball above describes this development candidate, **not** a claim that npm has published it. Use the isolated instructions above when evaluating unpublished changes. Release lifecycle and initial npm setup are documented in [RELEASING.md](RELEASING.md).

## First run

Ask your agent to work with the colleague, for example:

> Have Reviewer review the current implementation and return supported findings. Do not edit.

The agent discovers the exact colleague and attempts the send. **First contact opens a native human confirmation** with colleague, work and Yes/No consequences first. Request preview, exact session and approval lifetime follow. Allow it and that same send continues—no setup command, ID relay or repeated task prompt.

**One approval, at the requester.** In this same-owner local workflow, that human decision authorizes the chosen receiver and normal replies for the collaboration. The runtime carries it as exact-target transport metadata, separately from the agent's message payload. The receiver accepts without another prompt, but still follows its own user directives and native tool permissions. Approval of A↔B cannot create approval of B↔C or authorize unrelated missions. Concurrent first sends queue their human decisions; each original send continues once if allowed. Cancelling one does not decide the others.

Cancel/refuse an outbound prompt: nothing is sent. Receiver **Pause** holds admission/wakes. Receiver **revoke/refusal** holds that peer's content until the receiver explicitly reapproves; an ordinary resend cannot undo it. Already-admitted content is not retracted. `/comms requests` reviews held contacts, including legacy traffic without trusted approval; `/comms approve` establishes/changes a contact explicitly. Further arrivals do not repeatedly reopen refused decisions. A new human instruction can reconsider an outbound refusal. These commands are recovery/management options, not first-run prerequisites.

Unapproved content remains fully human-visible in `/comms inspect`; model inspection returns only IDs and a contact-approval hold, withholding subject, body, references and return handle. Noninteractive callers without human approval UI fail with an actionable approval-required result; no consent is inferred. Native Stop or session replacement cancels pending approval without sending. Peer messages cannot broaden approval or bypass host tool permissions. This trust model is for one owner's local sessions, not mutually untrusted users or malicious same-account processes. Runtime metadata and prompt attribution are not a security sandbox.

## Everyday commands

- `/comms` or `/comms status`: approval/context, waiting count, hold reason, broker location and reset limitations.
- `/comms requests`: review/reconsider held incoming contact requests, including queued messages from a contact you revoked.
- `/comms approve [exact-session-id]`: optional explicit contact setup/change through human selection/context/confirmation.
- `/comms revoke [exact-session-id]`: remove contact approval after confirmation; queued traffic remains held.
- `/comms pause`: keep buffering arrivals without peer admission/wakes.
- `/comms resume`: resume eligible intake.
- `/comms inspect [message-id]`: read waiting messages or a specific message without consuming/admitting it. The read-only view shows counterpart, subject, full content, references and observed state—not editable JSON. Use arrows/PageUp/PageDown to scroll, **d** for technical evidence, **n/p** for more/previous messages, and **Esc/q** to close. It is a snapshot, not a second inbox. A malformed ID produces a notice rather than opening unrelated messages; an unavailable ID explains the memory-only reset limit. RPC clients use equivalent read-only selections; model inspection is plain text and script results retain structured evidence.

**Stop ends the current run. A queued or later peer message can wake it again. Pause holds incoming peer admission/wakes until Resume.** Pause does not stop existing work or retract admitted content. Stop/corrections do not roll back effects already performed.

Native inline cards show one counterpart/subject heading followed by the full payload. Ctrl+O reveals IDs, timestamps and receipt evidence. Corrections, context loss and unknown receipt state remain visible. The footer shows waiting/paused/hold state. Already-pending native input and checked editor drafts win at admission. Input after posting may follow the batch. There is no universal arbitrary-modal detector. Use Pause when you want reception held.

## Agent tools

- `comms_peers({})`: approved online peers first, other online peers marked approval-required, then known offline peers. Includes collaboration context and observed activity where available. `view: "known"` filters to approved peers. Discovery never contacts anyone. If none are reachable, check that all participants load pi-comms and share its broker agent directory; intercom-only sessions are not bridged.
- `comms_message({to, subject, text, refs?, corrects?})`: start an exchange using a native ID or current exact unique name; first contact asks the requester and continues this send if allowed. Do not ask the user to preconfigure contacts. Cancellation sends nothing; do not retry unless the user asks.
- `comms_message({respondTo, text, refs?, corrects?})`: answer the clearly labelled **reusable** return handle after turns/tools; it is not consumed by a reply. Omit `to` and `subject`. Handles may be lost on reload/switch/restart; no preflight is required.
- `comms_ask({requests:[messageInput,...],timeoutSeconds?})`: one to 30 independent new-message or respondTo requests. Dispatches approved requests without waiting for earlier answers, including under serial host tool scheduling. Each item returns its first exact linked reply, refusal/error, timeout or local ending; one item does not cancel siblings. Multiple ask calls may overlap.
- `comms_inspect({requests:[outgoingMessageId,...]})`: who replied to each selected request and the latest reply, plus response count. An older response in the same exchange does not answer a newer request. Distinguishes no reply yet, rejected, unknown and unavailable records; never infers task completion. Use the exchange for full history.
- `comms_inspect({})`: compact overview of waiting intake, paused/receiving state, recent exchanges and uncertain outgoing operations.
- `comms_inspect({peer,cursor?})`: list a peer's exchanges with latest activity/preview; peer accepts a native ID or current exact unique name.
- `comms_inspect({message})`, `({exchange,cursor?})`, `({queue:"self",cursor?})`, `({outbox:"self",cursor?})`: non-consuming runtime evidence. Use only one selector. All model views withhold unapproved/revoked incoming payloads and handles. Not a polling duty.

Provider declarations expose described top-level fields. Runtime checks enforce mutually exclusive send/reply and inspection selectors; unknown fields still reject. An exact unique name resolves **once** to its native ID before validation/approval. Ambiguous names return explicit native-ID choices; no fuzzy/prefix matching or name substitution while waiting or retrying. Corrections reference the sender's prior message to the same peer. References are pointers, never uploads. Messages over 900,000 serialized bytes reject with a reference-based next step. Inspection pages retain full approved items and return a cursor. `localTransport.connectivity` describes this session's broker connection, not the counterpart's presence; use `comms_peers` for exact colleague presence. Multiple replies are allowed, not owed. Incoming model text puts sender/subject and full payload first, then `Reply with respondTo: "<handle>"`. Successful send text is concise; full structured records remain available to scripts and inspection.

### Ask timing and interruption

The default wait is **60 seconds**, configurable per call from **0.1 to 600 seconds**. These are practical bounds, not validated UX timing. Each item's clock starts when its send returns transport acceptance, after its contact decision. Human-dialog time is excluded, including another item's queued contact decision; an already running clock resumes with its remaining time. No timeout resends or cancels anything remotely. A clarification counts as the first reply, not completed work; use its reusable handle for another round.

Matched replies can enter the ask result while this session is busy with that ask, but not ahead of pending human input/drafts, Pause or contact approval/revocation. Stop/human interruption, Pause, revoke, disconnect and runtime replacement end affected local waits. Replies not yet handed off remain queued for eligible intake; late replies follow ordinary intake. No claim is made that a remote task continues running.

Direct native ask replies stay claimed until model-context admission: they are not also posted as unsolicited batches. If interrupted before admission, the old tool result is projected without the withheld answer and the answer remains queued. Nested tool calls hand structured results to their calling tool instead; that caller owns any subsequent transformation or omission. This handoff is not evidence of a saved child transcript entry or cognitive receipt. Full underlying messages remain inspectable in existing runtime records. Saved evidence is recorded only when a native session entry is observed. A local busy label means **this session is working; incoming messages are buffered**, not that a peer is doing the requested task.

### Recovery

For a routing validation error, retry with exactly `{to, subject, text}` for a new message or `{respondTo, text}` for a reply. `refs` and `corrects` are optional; never invent a correction ID to satisfy a tool declaration. Routing validation rejects before sending. If a provider presents every routing field as required, that declaration conflicts with pi-comms: the serialized message schema requires only `text`, and runtime validation enforces the routing combination. Compare the loaded extension schema and the provider's outbound payload before changing the tool interface. Tests cover serialized schemas, Google and OpenAI Responses conversion, and the OpenAI Completions outbound payload without network access; downstream gateway rewriting is not covered.

Same-ID reconnect refresh is internal: after a definite stale-epoch rejection, re-resolve only that same native ID once and recheck approval. Unknown send outcome never automatically retries. Concurrent active claims are rejected explicitly. A fork/new session has a different identity. Renaming a session updates discovery and contact labels without changing its native ID or approval binding; clearing its name restores the UUID display fallback.

## Facts and volatile state

- **Accepted:** broker/socket transport accepted it. Not proof the recipient model saw it.
- **Queued:** receiver memory holds it.
- **Posted:** handed to native Pi, admitted as a direct ask result, or handed to a nested caller; the fact's source distinguishes these boundaries.
- **Saved:** a native session entry was actually observed locally.
- **Response:** a linked peer message exists. None of these means work completed.

No crash durability. Approvals, buffers, local asks, message/outbox records and return handles reset on reload, session switch or process restart. Resuming the same saved session preserves its native address, not lost runtime linkage/approval. The next contact attempt asks for approval again; report context lost/unknown instead of inventing recovery. The broker retains legacy best-effort mailbox behavior internally, but the public exact-send path rejects unavailable peers instead of promising offline delivery.

## Update and rollback

Pause and finish/inspect outstanding work before replacing the package. Record useful work products outside the transport. Exit participating sessions and their shared broker, replace the reviewed artifact, then restart and renew contacts. Requester-only approval requires the `owner-contact-v1` broker capability and matching reviewed participant artifacts; an older broker rejects this send path rather than silently dropping the approval. Rollback uses the previously retained artifact in the same way. Buffers/linkage may be lost in either direction. There is no durable schema migration or guaranteed replay. Do not blindly repeat uncertain sends after restart.

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
