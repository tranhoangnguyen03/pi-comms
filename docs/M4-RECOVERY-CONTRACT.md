# M4 — native-session recovery and a small durable mailbox

**Status: design contract; F10 is merged, F11 unordered-pair implementation is under test, F12 remains proposed.** This is the simplification review for [issue #20](https://github.com/tranhoangnguyen03/pi-comms/issues/20) and PR #32. It replaces the earlier requirement for a separate participant journal and an authenticated offline-identity registry. It does **not** remove F10–F12 or weaken historical access, current consent, human priority or exact-recipient routing. The [README](../README.md) remains the shipped contract.

## Decision

**Use Pi's existing session file for participant recovery. Use the existing native session IDs and broker scope for addressing. Add disk persistence only to the broker mailbox that must outlive its process.**

Do not add a participant sidecar database, a second transcript, a general event-store service, new identity credentials, a durable peer directory or a recovery tool. Keep the four agent tools, existing `/comms` controls and M3 organizer API.

| State | Owner and proposed location | Lifetime |
| --- | --- | --- |
| Original messages, reply handles, links, readability and observed outcomes | Versioned private custom entries in the participant's **existing Pi session JSONL** | Native saved session |
| Pause and communication history | Pi native session entries | Exact saved session |
| Contact approval (remembered only) | Broker `pair-approvals.json` under the comms directory | Until either side ends it |
| Runtime maps, report views, indexes and duplicate lookup | Rebuilt from those entries | Current runtime; disposable |
| Pending offline payloads and bounded transport outcomes | One versioned broker-owned mailbox state file under the **existing comms directory** | Queue expiry and evidence retention |
| Live connection, endpoint epoch and current presence | Existing broker/client mechanisms | Current connection; not durable identity |
| Model-context history and branch selection | Pi host | Native session semantics |

The broker mailbox is necessary storage, not a second conversation history. If every process stops, an acknowledged offline message needs somewhere to remain. Removing its disk state would remove broker-restart recovery from F12; that is **not** the selected simplification.

## What the source review established

Baseline: pi-comms [ca3e74a](https://github.com/tranhoangnguyen03/pi-comms/tree/ca3e74a8f9d7b9608f2d5b102ba863f030e54c16), whose runtime is merged M3-B; pinned host **Pi 1.4.0**, [4a08025](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0).

- [`Runtime`](../src/runtime.ts) already owns messages, handles, approvals, intake and report projections. Extend it; do not invent another conversation model. Its current visibility check depends on current approval and must change for historical readability.
- Pi's [`CustomEntry` and SessionManager](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts) already support extension state that **does not enter model context**. `pi.appendEntry` is the extension write path; `ctx.sessionManager.getEntries()` supplies recovery data. Native transcript text alone is insufficient: it omits withheld arrivals, pre-dispatch intent and some organizer operations.
- **Host limits matter.** Pi 1.4.0 buffers custom entries in a fresh unused session until a user/assistant conversation exists. It updates memory before persisting, can skip malformed input lines, and uses synchronous file writes without an explicit fsync in that append path. A file path, successful in-memory lookup or parsed session is not by itself a durability certificate.
- Pi's `getEntries()` includes all branches. Native forks copy custom entries but create a new session ID. Communication controls therefore need explicit owner IDs and must not roll back with `/tree` navigation.
- The existing [broker](../src/transport/broker/broker.ts) has scoped native IDs, endpoint epochs, live-holder conflict checks, receipt tracking and a mailbox. Registration can flush mail immediately. It does **not** cryptographically authenticate a saved-session owner against malicious same-user processes.
- [`ExtensionStateManager`](../src/transport/broker/extension-state.ts) supplies an existing atomic-write/fsync/rename pattern. Its 64 KiB payload cap, namespace-owner protocol and fallback-to-backup behavior are **not** automatically appropriate for a delivery queue. Reuse the small file-writing mechanism after review, not the whole extension-state bus or its limits.

[`test/m4-storage-preflight.test.ts`](../test/m4-storage-preflight.test.ts) characterizes seven host behaviors: saved custom entries, first-conversation flushing, ephemeral sessions, branch navigation, forks, failed writes and malformed tails. These tests are architectural evidence, **not an M4 implementation or real-agent acceptance test**. See the PR's exact-head CI results for execution status.

## F10 — recover inside the native saved session

### A small record schema, not a new persistence framework

Use one versioned custom-entry namespace, for example `pi-comms:v1`. Each entry carries the native owner session ID and the existing local broker/agent-directory scope. It records one of:

| Kind | Minimum information |
| --- | --- |
| Message | Existing full envelope, exact from/to, stable message/exchange/request links, reusable return handle where relevant, historical visibility |
| Message change | Message ID plus a newly observed outcome, visibility decision or intake disposition, with its evidence source |
| Local control | Pause/resume or exact-peer contact decision, its lifetime and whether the local owner or transport supplied it |

The names above describe the proposed representation, not a new public API. Derive report state, handover links, indexes, pending intake and duplicate checks from the existing records. Do not persist a second task ledger, copy all Pi conversation entries or save full-runtime snapshots on every status tick. Existing native cards/tool results are projections and admission evidence, not an independent recovery store.

Store the original envelope once in this recovery namespace because held messages and interrupted sends may never appear in a native card. Keep ordinary native presentation; some payload also appearing in a tool result/card does not justify maintaining a separate transcript database. Do not reconstruct missing return handles or permissions from prose.

### Read old history without reopening contact

A self-authored message or incoming message previously authorized for agent inspection remains readable by the **same saved session**, even after approval expires or the contact is revoked. Persist that per-message decision. Do not recompute it from `isApproved(peer)`.

Previously withheld messages remain withheld from the agent; the human can still inspect them through the existing path. Unknown historical authorization is not permission. Reading a record, admitting it to Pi, sending a new message and accepting a work result remain separate acts. Preserve these rules across message, request, exchange, work-reference and organizer inspection, including handover-source validation.

### Restore before reconnect

1. Stop the old runtime's timers, waiters and callbacks. Bind the new runtime to the actual native session ID and local scope.
2. Read this session's matching custom records in **append order across the full session**, not just the active model branch. Restore messages, visibility, return handles, negative contact decisions, Pause and dedup evidence. Old runtime-only positive approvals do not revive.
3. Reconcile native `comms_batch` and ask-result evidence by original message ID. Restore existing report/correction/handover behavior without recreating old asks or new model turns.
4. Only then register with the broker. The broker must also restore its own mailbox before it serves queue operations. Queued arrivals still pass through current consent, Pause and the existing human-first pump.

`/tree` changes what the model sees; it does not unsend a message, undo a revocation or make an already offered message new again. A fork/new session may contain host-copied transcript and custom data, but foreign-owner control records, reply handles and pending intake must **not** become operational state for its new ID. Pi itself can copy transcript text; pi-comms must not claim it prevents that. Normal Pi forking remains supported, not forbidden.

### Write and admission boundaries

For a recovery-capable saved session, record outgoing ID and intent before dispatch. Record incoming envelope/ID before issuing a **persistent** receipt. Preserve the same ID if evidence becomes uncertain. No automatic new-ID retry.

Before offering a waiting message to Pi, record that an admission attempt is starting; later native saved-history evidence confirms posting. This distinguishes three cases after restart: definitely never offered (eligible for normal intake), already posted (do not post again), and uncertain admission (inspect/hold, do not guess). Merely saving an incoming message is neither posting it nor accepting its work.

**Resolve uncertainty without false certainty:** Count offered/uncertain arrivals separately from normal waiting intake. Keep `/comms inspect` read-only and expose explicit **Deliver again** (with current contact consent and a clear possible-duplicate warning) or **Dismiss** in the existing human `/comms requests` flow. Save the human choice under the original message ID before resuming normal intake; never synthesize a new request or retry automatically. Dismissal stops pi-comms admission attempts but cannot revoke a Pi steer already queued in the host. If native evidence later proves admission, report it honestly. Normal contact/Pause/human-input controls still apply.

A write failure must stop the affected operation and report that persistence failed. Apply a user's Pause/revoke immediately in the live runtime, but never falsely confirm it survived restart. An entry still visible in memory after an exception is not proof of a committed write. Validate the actual saved data when reconciling an ambiguous commit; do not silently fall back to a separate sidecar or erase the evidence.

### Native host limits and compatibility

- **Saved-session guarantee:** M4 targets process reload/restart using the native session's recovery boundary. Do not advertise disk-loss, power-failure durability or rollback-proof security beyond the host's guarantees.
- **Fresh and ephemeral sessions keep their existing live use.** An untouched session's custom entries may still be buffered; `--no-session` has no persistent file at all. Report live-only/volatile evidence accurately until the host actually saves it. Do not disable these sessions, ask the user to send a dummy prompt, fabricate a user message, or write directly into Pi's JSONL to force a flush. A supported host improvement is preferable if automatic early flush is needed; it requires its own evidence and compatibility review.
- **F12 receipt boundary:** A fresh/ephemeral receiver may receive live, but cannot acknowledge persistent receipt from buffered state. For an already broker-queued item, retain broker responsibility until receiver persistence is evidenced or the queue reaches its terminal outcome. Do not report plain live delivery as restart-safe.
- **Corruption:** Host parsing may omit malformed lines. F10 must check for malformed/truncated saved data and validate its own record shapes rather than treating successful `getEntries()` as proof that no control was lost. Use a narrow read-only validation of the current file where the host does not expose the needed result; no second writer, repair engine or checkpoint framework.
- A damaged message/link can be withheld or marked uncertain without disabling unrelated work. An unreadable latest contact control requires holding that peer; if the affected authority cannot be identified, hold new communication for that session. Keep verified history inspectable. Do not block the rest of Pi or reset to empty recovered state.
- Reuse native retention, export and deletion for participant data. No separate transcript cleanup or second compactor. Custom entries are outside model context, **not encrypted**; native export/share can include them. Preserve existing owner access and document this consequence. An old memory-only runtime cannot be reconstructed where no trustworthy record survived.

## F11 — one approval per unordered session pair

**Owner decisions (7–8 November 2026):** One explicit approval belongs to the **unordered pair** of exact native session IDs, scoped to the current pi-comms broker/agent directory. Either member can initiate later communication without a repeated prompt. A pair is **approved or not approved**: there is no stored refusal or block list.

- **Session-only** (default) applies in both directions for the lifetime of both **Pi runtimes**. Each client registers with a per-runtime ID; a dropped socket that reconnects with the same runtime ID keeps the approval, so a network blip or broker heartbeat miss does not re-prompt. A reload, restart, unregister, or replacement of a dead-PID stale registration by a different runtime ends it, notifies the remaining participant and ends its affected asks as disconnected. A broker restart ends it. **Remember pair** persists the same one approval across restarts of both original sessions and the broker.
- **Decline / Esc** stores nothing. The agent does not re-prompt within the same user turn; after the user's next input it may ask again. **`/comms revoke` from either endpoint** ends the approval for both directions, ends affected asks as revoked, and returns the pair to not approved. An already admitted message or running remote task cannot be recalled.
- **Exact identity:** canonical pair key = `(scope, min(sessionA,sessionB), max(sessionA,sessionB))`. Rename does not change it. A fork, new session or other broker scope inherits nothing. Do not substitute a name, path, cwd, old thread or role for a native ID.
- **One owner / one decision:** the same-owner local trust boundary remains. The human choice is the only source of approval; peer messages, model text, organizer hints and old records cannot create one.
- **One authoritative state:** the broker holds approvals; it saves only remembered approvals, in one atomic file (`pair-approvals.json`). Session-only approvals stay in broker memory, and ended pairs are deleted, so the file does not grow with history. Participants cache the broker's status and replace the cache from a fresh snapshot on every connect. Native Pi records keep message history, visibility, Pause and recovery evidence; they hold no approvals. Contact records written by 0.1.9 restore only the readability they granted.
- **Failure boundary:** the broker is the sole writer; decisions are serialized and saved before acknowledgment, then pushed to both live endpoints. Sends are checked against the same state at admission. A failed save rejects only that remembered choice (`PAIR_SAVE_FAILED`) and leaves all other state unchanged. An unreadable file is moved aside at broker start and grants nothing; affected remembered approvals must be granted again. Arbitrary rollback of a valid older file is not detected.
- **Versions:** all sessions sharing a broker must be pair-aware. A send or approval involving an older peer fails with `PEER_OUTDATED`; a pair-aware session that finds an older broker reports `BROKER_OUTDATED`. Both carry recovery guidance. There is no fallback to per-message transported approval; that path is removed.
- **One human flow:** the short first-contact screen shows who, topic, request preview and one-sentence effect, with Allow this session (default), Allow & remember or Decline. `/comms approve` is grant-only (Cancel/Esc changes nothing) and sends no message. No second routine dialog or agent-selected permission mode.

**Acceptance journeys:** A approves A–B; either side sends first without a second approval, including after *both original saved sessions* restart. End from A, then separately from B: both directions stop at once and stay stopped across broker and participant restart until a new approval. Fork B to B_new: A–B unchanged; A–B_new needs its own approval. A dropped socket of the same runtime keeps session-only approval; a reload or stale-holder replacement ends it with notification and ask cleanup. Decline stores nothing and allows a later request. Failed and torn broker writes, 0.1.9 records and mixed versions behave as above. Do not claim F12 offline delivery because remembered consent exists.

## F12 — persist the existing mailbox, not an identity service

### Addressing and trust

Use the same exact native session ID, broker/agent-directory boundary and existing scope checks as live communication. Keep live endpoint epochs and live-holder rejection. Names may help a user discover a peer, but routing remains pinned to the resolved ID. No name/cwd/prefix fallback and no successor substitution.

For an offline async send, the sender uses the exact previously resolved/approved peer in **its own recovered records**, checking current owner authority. The trusted local extension supplies that target through the same send path. If the target is not known or approval is absent, use the existing unavailable/consent result; do not create an arbitrary offline address from a model's guess.

The queue record already carries the exact target and scope. After broker restart, a matching normal registration is enough to route it under the existing trust model. There is **no separate durable offline recipient registry, identity certificate, credential exchange, liveness database or scan of other sessions' transcripts**. A peer that never returns simply reaches expiry. Do not claim to detect deletion of a remote saved-session file before it reconnects.

This protects against accidental cross-session routing within the supported local trust boundary. It is not protection from malicious code with the same OS-user access. Preserve current platform/transport support and accurately describe its existing limits rather than adding a silent Windows/backend restriction. Strong cross-user or remote authentication is a different product decision, not a hidden prerequisite for native M4.

### One bounded broker state file

Persist the current mailbox and the bounded delivery facts needed to reconcile it, keyed by existing scope, sender and message ID. Pending records contain exact recipient, original payload/fingerprint, expiry and delivery stage. Terminal records retain the small ID/fingerprint/outcome evidence needed for sender reconciliation and dedup; payloads need not become a permanent broker transcript.

The broker is the sole writer. Use a versioned atomic replacement of this bounded state, adapting the existing temp-write/fsync/rename utility pattern. Do not route it through extension-state owner election, inherit the unrelated 64 KiB cap or automatically treat an older backup as proof that the newest acceptance never happened. No new database dependency for the currently bounded workload; revisit only with measured evidence.

Commit before acknowledging `queued`. Remove a pending payload only after a supported persistent receiver receipt or a committed terminal expiry/rejection. On full capacity, **reject the new item before acceptance**, rather than silently evicting an acknowledged message. Specify time, count and byte bounds with realistic fixtures before F12 ships; the inherited 24-hour/256-message values are not already accepted promises.

Persist terminal outcomes long enough for the declared queue/reconnect window, then clean up under a documented policy. Dedup retention must cover every supported same-ID reoffer. If the required evidence is older than retention or storage is missing/corrupt, report **unknown**, not definitely unsent. A sender's saved queued-acceptance record remains evidence even when broker evidence is unavailable. Complete disk loss cannot magically produce a trustworthy detailed loss receipt.

A broker may reoffer its accepted queue item with the **same ID**. Receiver records provide dedup; do not add a receiver dedup database. Reject an ID reused with different content. Do not automatically recreate an absent/unknown accepted item from the sender's outbox. That would turn inspection into a second queue and reopen duplicate-work risk.

### Preserve existing tool behavior and useful evidence

`comms_message` and organizer send share async queue eligibility. `comms_ask` remains live-only for dispatch and waits for the first linked reply within its current runtime. The common transport needs an internal dispatch policy so a target disconnecting between lookup and send cannot silently queue an ask. This is **not** a new agent-selected mode. Each batch item reports its own unavailable/interrupted/unknown result; other items continue. Restart never revives a waiter; late replies retain their original links.

| Evidence | Meaning |
| --- | --- |
| Broker queued | Broker accepted responsibility and saved the item |
| Receiver recorded | Receiver saved the arrival; it may still be held from the model |
| Native admission observed | Pi recorded the message/result; not proof of model action |
| Expired / rejected / unknown | A terminal outcome or a gap that needs judgment |
| Peer progress / blocked / complete / correction | Attributed report; never requester acceptance |

Expose only evidence actually available to each participant. Do not add cross-process acknowledgments solely to fill every field, or label a broker receipt as native admission. Use existing inspection, result and card paths; reconcile identical meanings across them. Progress-only records remain quiet, corrections actionable, and human drafts/Stop/Pause retain their existing distinctions.

## Alternatives rejected and costs retained

| Alternative | Why it is not selected |
| --- | --- |
| Reconstruct everything from visible Pi transcript | Cannot reliably recover held messages, original handles, pre-dispatch intent or organizer-only events |
| Separate per-session JSON journal/checkpoint store | Duplicates Pi's persistence lifecycle, migration, export and cleanup for little added benefit here |
| SQLite for all session and broker state | Useful if measured volume/concurrency demands it; not justified for one native session writer and a bounded single-writer mailbox today |
| Reuse the whole extension-state bus as the mailbox | Imports owner election, unrelated cap and snapshot rollback semantics; borrow only the file utility pattern |
| Durable offline identity registry/credentials | Exceeds the existing local trust boundary and duplicates information already present in exact IDs and queued records |
| Sender-driven replay instead of a broker mailbox | Requires the sender to run, creates another queue and can repeat uncertain work; changes the accepted F12 outcome |
| Eliminate all new disk persistence or defer F12 silently | Cannot preserve acknowledged offline mail across broker restart; requires an explicit scope change, not a simplification claim |

**Costs that remain:** a small native-record schema and restore function; truthful handling of host write/admission uncertainty; one bounded broker mailbox file; a few internal queue/receipt capability changes and lifecycle tests. These costs follow from the promised behavior. Do not add factories for multiple storage backends, new registries or general recovery services around them.

## Implementation boundaries and rollout

| Slice | Focus and existing code to extend | Deliberately absent |
| --- | --- | --- |
| M4-0, this PR | Source-backed architecture, host characterization tests and acceptance contract | Runtime recovery, release or self-approval |
| M4-A / F10 | `Runtime` record restoration/visibility; `extension.ts` native entry adapter, startup barrier, native evidence; durable Pause/refusal/revocation | Participant sidecar, offline mail, remembered positive grants |
| M4-B / F11 | Short owner consent UI, one broker-held unordered pair approval, shared end, exact-ID broker check | Two directional grants, stored refusals, mirrored participant permission records, identity service |
| M4-C / F12 | Existing broker mailbox/delivery records, client/exact send policy and receipt reconciliation; small file helper | Second inbox, durable ask, peer registry, alias routing |

A single focused native-record helper may handle validation and restoration; avoid a pluggable persistence abstraction. Keep schema checks close to existing records and use the shared send/inspect paths for both tools and organizer API. Extend current model/human/card projections together when shipped behavior changes.

Gate optional capabilities honestly for mixed versions. Do not silently discard meaningful fields or downgrade durable queue acceptance to best effort. Unknown custom-record versions remain read-only evidence and cannot grant authority. Rollback is not a way to restore new M4 guarantees in pre-M4 binaries: preserve files, state the limitation and use a compatible version for recovery. Native session retention remains host-owned; broker retention remains bounded. Remove transitional paths only after the supported migration; record a concrete cleanup owner in the implementation PR.

## Acceptance: prove the benefit without extra agent work

The new host characterization tests establish only host behavior. F10 must separately exercise the actual extension write path and lifecycle in installed Pi, including fresh sessions, process kill, reload, `/tree`, fork, compaction, write failure and both ordinary tools and organizer calls. Recheck these assumptions when the supported Pi version changes.

| Scenario | Required M4 result |
| --- | --- |
| Same saved review resumes; approval expired/revoked | Authorized history and original links readable; new contact still gated |
| Earlier withheld message | Still absent from agent inspection/context until current approval |
| Pause/revoke before restart; broker has mail | Controls load before registration/flush; no unauthorized wake |
| Known pending, posted or uncertain admission | Normal intake only for definitely unoffered eligible items; no automatic repeat of posted/uncertain ones |
| Send crash before/after dispatch | Saved original ID; known outcome or unknown; no new-ID replay |
| Native append fails but entry remains in memory | No false saved/receipt claim; affected operation stops |
| Fresh unused or ephemeral session | Existing live use remains; no false persistent receipt or dummy user action |
| Branch navigation and fork | Branch cannot undo external effects; new identity cannot inherit operational control/handles |
| Broker dies after queued acknowledgment | Saved item or honest retained outcome; no alias substitution or silent success |
| Full/corrupt/old-version mailbox | No acceptance without supported storage; evidence loss is unknown; verified history remains useful |
| Offline item in `comms_ask` | Independent unavailable/interrupted result, no queue or restored waiter |
| Remembered A–B pair and both original sessions resume | Either side initiates first without renewed approval; broker remains authoritative |
| M2 reports and M3 handover after restart | Correction precedence, original request links and authored new C request remain intact |

**Real-agent evaluation, separate from [M3 handover acceptance](M3-ACCEPTANCE.md):** Ask A, “Ask B to review the retry logic and report the risks. Keep working while B reviews.” Let B ask a question or send a finding. Restart A's same saved session while B continues, then say, “Continue the review with B. Tell me what we know, what's still waiting, and whether you need anything from me.” Supply no IDs, technical tool names or recovery instructions. Observe natural recovery, no repeated request and correct treatment of approval/uncertainty. Let B finish or correct its report. Repeat targeted variants for Pause, expired approval, withheld content, offline async mail and an unavailable ask item.

Score recovered-history use, contact/readability boundaries, duplicate avoidance, honest outcomes, human priority and human effort as **0 failure / 1 brief hint / 2 natural success**. Preserve prompt/tool traces and count extra prompts and duplicate requests. No paid-model run is implied by scripted CI.

An independent reviewer must challenge this architecture and the eventual implementation: does native storage meet the actual host boundary, do controls survive branches, is queue ownership singular, are local identity claims honest, and does ordinary collaboration require fewer repairs without new routine steps? Source review and green tests are evidence, not independent sign-off or M4 completion.
