# M4 recovery contract — preflight for F10, F11 and F12

**Status:** Proposed design and test contract, not shipped recovery behavior. This document is a review gate before enabling persistence or offline delivery. The [README](../README.md) remains the current contract.

## The result we need

A user can resume the **same saved Pi session** after a restart, recognize the earlier conversation with the same exact colleague, and continue safely. If a message could have arrived twice or its outcome is unknown, pi-comms must say so. Recovery must not silently send again, wake a replacement, or restore contact authority that the user did not grant.

Keep these concepts distinct:

| Concept | Meaning | Authority |
| --- | --- | --- |
| Session identity | The specific native Pi saved-session ID | Pi host |
| Communication record | Original message, peer IDs, exchange/request/reply links, return handle and observed facts | pi-comms, based on observed local events |
| Contact decision | Which exact session may communicate, what lifetime was approved, and whether revoked | Human owner, not peer-supplied metadata |
| Broker delivery | Routed, queued, received, expired or uncertain transport state | Broker observations, never proof that the agent read or completed work |
| Work outcome | Peer-reported progress, blockage, completion and corrections | Peer claim, not requester acceptance |

**The record is the backbone; approvals and delivery are distinct state with explicit owners.** Keep one authoritative communication record per participant and project all human, agent and organizer views from it. Do not build another inbox, transcript copy or task database.

## Observed baseline and important inherited behavior

Reviewed against merged [M3-B main](https://github.com/tranhoangnguyen03/pi-comms/tree/3f937e80c65e0b6bcd0ede0048fff262d3b558cd), 2026-11-02.

1. **Runtime records vanish on reload/switch/restart.** `src/runtime.ts` stores approvals, revocations, message records, reply handles and waiting intake in Maps/arrays. `src/extension.ts` constructs a new `Runtime` on `session_start` and discards it on shutdown. Saved Pi session identity does not restore these maps today.
2. **Broker recovery is incomplete.** `src/transport/broker/broker.ts` keeps `mailboxMessages`, `disconnectedSessions`, delivery records and receipt routes in memory. The existing 24-hour disconnected-session/mailbox TTL and 256-message cap are inherited code, **not** a crash-durable promise. Shutdown clears the in-memory stores. Some historical pending-ask and extension-state files exist but do not make the public Pi communication records durable.
3. **The public send path does not promise offline delivery.** `src/transport/send.ts` resolves an exact currently connected target and rejects an unavailable peer. The broker's legacy disconnected-session routing also has a name/cwd matching fallback; it must **not** become the restored public path without an exact-ID audit.
4. **A successful send is not task completion.** The broker can observe socket/receipt facts, but cannot know that a model read the content or accepted work. An unconfirmed send can be `unknown`. The sender must not treat it as safely unsent.
5. **Approvals currently expire on runtime reset.** Approval prompts explicitly say so. Silently restoring a prior contact as permanently approved would change the owner's decision. Exact A↔B approval must not become A↔C approval after handover.

These are existing gaps, not M4 features already implemented. [Broker source](https://github.com/tranhoangnguyen03/pi-comms/blob/3f937e80c65e0b6bcd0ede0048fff262d3b558cd/src/transport/broker/broker.ts), [runtime source](https://github.com/tranhoangnguyen03/pi-comms/blob/3f937e80c65e0b6bcd0ede0048fff262d3b558cd/src/runtime.ts), [exact send](https://github.com/tranhoangnguyen03/pi-comms/blob/3f937e80c65e0b6bcd0ede0048fff262d3b558cd/src/transport/send.ts).

## Design contract shared by F10–F12

**Keep the current four agent tools and M3 organizer API.** Normal messages, first-linked-reply asks, correction-aware reports, human-first intake and explicit handovers retain their meanings. pi-comms restores communication; it does not become a task manager, choose replacements, replay agent work or add a recovery tool.

There are several evidence owners, but **one participant-facing communication record**:

| Fact | Source of truth | What it does not prove |
| --- | --- | --- |
| Exact saved session ID; native posted messages and tool results | Pi host | Current contact permission or continued remote work |
| Original message, exchange/request/reply/report/correction/handover links, return handle and historical visibility | Exact participant's local record | Broker delivery or another participant's private history |
| Consent lifetime, revocation and Pause | Human owner's decisions recorded locally | Task assignment, reachability or host tool permission |
| Offline identity, broker queue, expiry, delivery receipt | Scoped broker evidence | Model-context admission or peer completion |
| Progress, blocker, completion and correction | Attributed peer report | Requester acceptance |

Preserve message IDs across evidence boundaries and show the same facts in agent inspection, native cards, human controls and organizer inspection. Local and broker evidence may use separate physical files; do not create competing transcripts or an additional task ledger.

### F10 — restore records and controls **before broker registration**

**Mandatory startup order:**

1. Bind persisted records to the **exact native saved-session ID and its owner/agent-directory scope**. Reject unrelated sessions, copies, forks and conflicting simultaneous owners. No name, cwd, role or work-reference fallback.
2. Load and validate the last committed generation: message IDs, original envelopes and links, return handles, per-message visibility evidence, outgoing intent/outcome, pending intake, dedup IDs, Pause and any controls made durable by the installed milestone. Reconcile saved native Pi messages/tool results to determine what actually entered Pi, rather than treating broker acceptance as model admission.
3. **Only after the recovery barrier succeeds** register with the broker or allow reconnect mailbox flush. Apply restored revocations, Pause, current consent, user drafts and pending human input before new admission. Discard old consent-dialog callbacks, captured organizer handles and stale async operations after a session switch/reload.
4. Resume through the existing human-first intake path. Never replay all restored messages to the model, rebuild a running `comms_ask` waiter, or wake a replacement session. Late replies still belong to the original request.

**Failure and first-run distinction:** A truly new saved session without an earlier record can start clean. For an existing pre-M4 saved session, say plainly that old memory-only communication cannot be recovered; do not invent history. Corrupt/incompatible data, a missing expected generation or conflicting ownership is **not** a fresh session: hold unsafe sends, broker registration and new agent admission; preserve salvageable evidence and provide a short human-facing diagnosis/repair or export path. Never silently erase evidence and label it recovered.

**Historical access is separate from current permission:**

- All self-authored messages remain inspectable by their saved-session owner. Incoming history that was **authorized to be agent-readable at the time** remains readable by that same saved session after a runtime-only approval expires or a contact is revoked. Revocation blocks future communication, not already-authorized history.
- Persist the **per-message historical visibility decision and evidence** at the time an incoming message first became readable to the agent. Restore that decision. Do **not** derive historical access from today's `isApproved(peer)`; distinguish “authorized for inspection” from “actually posted into native Pi.”
- Content held from the agent before the restart stays withheld in agent inspection. If historical authorization cannot be established, default to withheld; it remains reviewable via the existing human path. A later valid approval may admit held messages through the ordinary pump but cannot invent earlier model admission.
- Fresh/unadmitted arrivals and outbound sends still need valid **current** contact authority. Historical readability grants no new contact, no authority to successors and no permission to read another session's records.

**Durable events:** Store outgoing message ID/intent before transport dispatch; refuse dispatch if the write fails. Store an incoming message ID/dedup fact before claiming durable receipt. Record known final transport outcome only on supporting evidence. A crash after dispatch and before final evidence save leaves **unknown**, not “not sent”; reconcile read-only broker/native evidence and never auto-resend with a new ID. Restore reusable return handles and all request/reply/report/correction/handover links. Do not persist/revive the transient first-reply wait itself.

Use a small versioned atomic journal/checkpoint (or equivalent), owner-only file permissions, integrity checks, bounded retention and last-valid-commit recovery. Choose bounds from long-running collaborations; do not silently drop links or controlling decisions. **Pause survives restart of this exact session** and must take effect before any queued intake. F10 alone does not claim the F11 persistent-approval feature.

### F11 — remembered consent is explicit and belongs to its owner

- The **compatibility default remains runtime-only approval**. Earlier approvals never become durable merely because the record survives.
- Extend the **existing human contact confirmation** with one optional lifetime choice, without a second routine approval prompt: “This session only” (default) versus “Remember this exact session pair across restarts until revoked.” State what survives and how to revoke; the agent should not select a permission mode.
- Scope the persisted grant to the **approving owner's identity/scope plus both exact saved-session IDs**. A remembering B does not mean B's owner has independently remembered A, or vice versa. Do not transfer grants to forks, renamed roles, lookalike directories or replacement sessions.
- **Transport assertion provenance:** Existing requester-side/bidirectional contact may accept a current, broker-validated sender-approval assertion for the **particular arrival and receiver's current runtime**, when no controlling local refusal exists. Bind it to the sender, exact recipient, scope and message; it is evidence of the *sender-side* owner's decision, **not** proof that the receiver's owner chose persistent consent. Never store it as the receiver's “remember until revoked” grant. Old queued/replayed assertions must not override a local denial. Without a valid receiver admission basis, hold content for human review rather than auto-granting access.
- Persist an explicit owner's revocation **before confirming it**. Restore the deny before registration; it overrides locally queued content, stale transport assertions and prior grants on subsequent send/admission. Only a fresh owner action may reapprove. Revocation does not erase authorized old history, retract already posted messages or stop an agent running in a different process.
- Remembered approval does not mean that the peer is online, working on a task or permitted to execute host tools. Keep user instructions, native permissions, Pause and human-input priority intact.

### F12 — bounded offline delivery to a verified exact identity

- Maintain a **durable, scope-bound offline recipient registry** based on a previously verified native-session registration. Record enough identity provenance to survive broker restart and reject wrong owner scope, deleted session, conflicting identity or stale/reused endpoint. Registration and reconnection must confirm the same exact session binding. A bare ID supplied by an unverified client, role, name, cwd, prefix or guessed epoch is insufficient. If this proof cannot be established with the supported broker trust model, reject the offline send.
- Queue only eligible **asynchronous exact-session messages**, through the existing public send path, after auditing inherited mailbox code. No alias/name/cwd fallback, automatic replacement, separate agent send mode or blind new-ID retry. Unsupported versions must fail clearly or retain a documented safe live-only subset.
- Before acknowledging `queued`, atomically commit the message ID, authenticated sender/target/scope, content, expiry and outcome/receipt tracking. Set expiry and count/byte caps from actual workflows; inherited 24h/256 are candidates, not promises. Reject before acceptance when full, or durably record and surface any later expiry/eviction/loss. An acknowledged queue item must not vanish silently on broker restart.
- Keep **queued → receiver durably recorded → native Pi admission observed** distinct from **expired / rejected / unknown**, and from the separate peer-reported work outcome. Broker evidence never proves model reading or task completion. Sender sees enough detail for its next safe step without receipt-log noise.
- Redelivery of the **same message ID** may be needed after a crash. Receiver persists dedup before durable acknowledgment and checks Pi-native history before possible model admission. No repeated model turn, no agent-controlled replay, no exactly-once execution claim.
- **Do not change `comms_ask`:** It still waits within the active runtime for the **first linked reply**, not final completion. An offline target is not queued as a blocking ask and restart never restores the waiter. Report unavailable/interrupted/unknown outcomes **per item** while other requests continue. Late replies, if any, remain linked to the original request. Use ordinary eligible `comms_message` for async work during a peer's temporary absence.
- On reconnection, validate identity and run all arrivals through restored consent/revocation/Pause/human-priority rules. An unapproved queued message stays held for human review; receipt, expiry or loss remains visible even if sender is offline.

## Interruption and recovery acceptance matrix

| Window or scenario | Required observed behavior |
| --- | --- |
| New session vs existing missing/corrupt record | Clean start only for truly new identity; old unrecoverable data disclosed; corrupt/conflicting state holds unsafe operations |
| Saved session restarts while broker has queued mail | Restore records, dedup, Pause and durable contact decisions **before registration/flush**; no race admitting mail |
| Earlier authorized incoming history, current approval expired | Old content and links readable without renewed approval; **new contact still requires current consent** |
| Earlier incoming content withheld from the agent | Still withheld from agent after restart; visible to owner for approval; no false historical access |
| Pause before restart with queued arrivals | Pause remains active and blocks model wake until explicit resume and valid current admission |
| Before outgoing intent saved | No send occurred; no invented outbox item |
| Intent saved, before/during network dispatch | Original message ID with **unknown** outcome until reconciled; no automatic retry |
| Broker accepted but local final status not recorded | Read-only evidence reconciliation or unknown, never “safe to resend” |
| Receiver accepted into memory before durable write | No durable-received claim; same-ID reoffer safely deduplicates |
| Receiver stored message, native Pi admission unknown | Inspectable held/uncertain state; no blind duplicate model turn |
| Pi message posted before local posted fact recorded | Reconcile native saved history; never inject twice |
| Old approval dialog/captured organizer handle after restart | Invalidated; cannot change new runtime or grant consent |
| A remembers B, but B restarts | A's owner choice is not B's persistent choice; sender assertion obeys current scoped receiver admission policy |
| Owner revokes contact while messages are queued | Durable local deny wins over stale assertions; previously authorized history remains readable |
| Previously verified offline target; broker crashes | Exact registry and queued content survive, or visible expired/lost/unknown evidence; never a replacement recipient |
| Multi-item `comms_ask` includes offline B | B item reports unavailable/interrupted; other items continue; no durable waiter or offline ask queue |
| A hands work from B to C before restart | Distinct exact C request, permissions and exchange; B history and authority never transferred |
| Mixed versions, downgrade, fork or storage overflow | Safe failure or documented subset; no identity/consent leak or overwrite of newer data |

## Human and agent experience

No new agent tool, recovery command, receipt checklist, wait mode, extra inbox, polling loop or general task manager. The normal path resumes quietly. Where action is needed, one concise summary leads with the work and safe next step, such as **“Review with B restored. One outgoing result is uncertain; no message was resent.”** Low-level transaction facts remain inspectable with the existing `comms_inspect` and human `/comms` paths, with matching evidence labels in native cards and the M3 organizer API.

**Automated gates:** For each F10/F11/F12 slice, test the relevant rows above in focused runtime tests and **installed Pi** restart, broker-kill, disconnected-peer and version-transition scenarios. Assert actual visibility/admission, revocation/Pause priority, restored reply links, per-item ask results, dedup/no duplicate native posting and rejection of ambiguous offline identity. Baseline M3 scripted tests do **not** establish M4 recovery.

**Separate real-agent interrupted-review evaluation — not the M3 handover exercise:**

1. With two **existing live Pi sessions** A (lead) and B (reviewer), ask A naturally: **“Ask B to review the retry logic and report the risks. Keep working while B reviews.”** Let B ask a clarification or share early findings.
2. Restart **A's same saved Pi session** during the review, leaving B to continue. Do not supply A with exchange IDs, special tool names, replay steps or a recovery checklist.
3. Ask A: **“Continue the review with B. Tell me what we know, what's still waiting, and whether you need anything from me.”** Observe spontaneous use of restored history and request links; no duplicate asks, no false work-completion claim and appropriate current contact approval.
4. Let B later report `complete` or `blocked` and a correction if relevant. Verify ordinary human-first delivery, report linkage, actionable-state precedence and no extra stale-progress wake.
5. Run targeted variants: A paused before restart, approval expired, an earlier incoming message withheld, B disconnected during an eligible async send, and a separate offline `comms_ask` item. Verify that no manual recovery or duplicate resend is requested.

Score **0/1/2** (failure/brief hint/natural success) for: recovered-history use; safe past-vs-new visibility; no redundant send; uncertainty and peer-reported outcome; user/Pause priority; and low agent/human burden. Preserve prompts, tool traces, relevant message IDs and counts of duplicate messages/human interventions. Redact private content before publication. Scripted-provider/native fixture passes are distinct from a real-model judgment run. [M3 A→B→C handover acceptance](M3-ACCEPTANCE.md) remains a separate exercise, not a substitute.

## Compatibility, staged delivery and cleanup

1. **M4-0 / this PR:** Reviewed recovery contract and crash/agent acceptance protocol only. No runtime change, storage, schema, release or proof of M4 behavior.
2. **M4-A / F10:** Versioned participant-local records, per-message historical visibility, restore-before-register, Pause, native history reconciliation and linked return handles. Runtime-only contact permission remains default; describe limits of revocation continuity before F11.
3. **M4-B / F11:** Optional persistent exact-pair owner consent in existing dialog, durable explicit revocation, transport approval provenance and admission behavior. No retroactive migration of earlier consent.
4. **M4-C / F12:** Durable exact-recipient offline identity registry and queue, expiry/loss evidence, receipts and dedup; remove alias fallback from the public exact-ID path; keep `comms_ask` semantics.
5. **M4 completion:** Installed Pi failure/recovery tests, real-model/human interrupted-review evaluation and independent coherence/security/agent-ergonomics review. Issue #20 remains open until evidence passes.

Each slice must say **what is not yet durable**. Guard mixed-version behavior and schema downgrade so older writers cannot overwrite an unknown newer format. Document retention, export/backup, explicit deletion, corruption/fullness handling, recovery and cleanup. Retire transitional dual writes, old unsafe mailbox paths and duplicate stores on a defined supported migration. No broad framework rewrite or permanent second communication record.

**Preflight exit criterion:** The design and failure matrix have been challenged against current source and at least one native fixture, with a bounded first F10 implementation slice. A document alone does not satisfy F10, F11, F12 or the real-agent acceptance test.
