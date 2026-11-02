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

## Proposed design

### F10 — one session-local durable record

- Bind storage to the **exact native saved-session ID** and the current Pi agent directory. Do not derive ownership from session names, role labels, work references or cwd alone.
- Persist *authored and observed* communication: exact peer/from/to, original envelope, request/reply/exchange IDs, work reports, handover links, return handles, known outgoing outcomes, evidence facts and unposted intake disposition.
- A record write must happen **before claiming a local durability milestone**, and an outgoing message's ID must be recorded **before transport dispatch**. If the write fails, refuse a new outgoing send before the network call; do not claim it was saved. Crash after dispatch but before final outcome save becomes **unknown**, not "not sent".
- Prefer a small, versioned, atomic local journal/checkpoint with checksums, owner-only file permissions and bounded retention/size; recover the last valid committed generation after partial write. Choose limits from realistic long-running-session fixtures and expose fullness and corruption. No silent truncation of needed messages, links or revocations.
- Restore message and reply links for exact-same-session inspection. **Do not auto-replay messages into model context** merely because they were saved. Reconcile prior Pi-native `comms_batch`/tool-result observations separately before admitting anything uncertain. Saving a record is not evidence of model-context admission.
- The first F10 slice may restore records without reapproving peers or auto-delivering buffered messages. Make that partial behavior explicit: incoming content stays withheld until new valid contact consent; unresolved intake remains visible as pending/recovery-uncertain rather than silently pushed. No new agent-facing tool is needed.

### F11 — approval lifetime is a product decision

- Keep the current **runtime-only** approval as the compatibility default unless the owner gives **new, explicit consent** for approval to survive restarts. Do not retroactively extend previous grants.
- Proposed consent choice when persistent contacts ship: “This session only” (default) versus “Remember this exact session pair until revoked.” The UI must state storage lifetime and how to revoke.
- A revocation must persist and take priority over transport-carried approval on resumed sessions. It must not be cleared by replayed messages, stale broker metadata or similarly named sessions.
- Never copy approvals to a fork, replacement session, a new ID, another owner account, or another work participant. User directives and native tool permissions still control execution.
- A persisted contact decision is **not** a task assignment and does not mean the old peer is still alive or doing work.

### F12 — exact-session disconnected delivery

- Introduce durable bounded queueing only after F10 records and F11 consent rules can represent and defend the arrival. The public sender must distinguish **queued**, **receiver received**, **posted into Pi**, **expired**, **rejected** and **unknown**, backed by actual evidence. Do not collapse these into one “delivered” state.
- Queue by exact stable session ID and matching scope. **No name/cwd/role fallback** and no automatic successor substitution. Offline target lookup must be based on a supported, exact authenticated session record, not guesswork.
- Pick the expiry, byte cap and queue count from real workflows; 24 hours / 256 messages in inherited code is a candidate to evaluate, not an accepted public promise. Make expiry/eviction visible to the sender after reconnect. A broker restart must not erase a previously acknowledged queued message without leaving verifiable loss evidence.
- Broker recovery and receiver intake must share a message-ID dedup contract, including crash windows before/after receiver acknowledgement. Do not promise exactly-once *agent execution*.

## Crash and recovery windows (acceptance matrix)

| Window | Required post-restart interpretation |
| --- | --- |
| Before locally recording outgoing intent | No send occurred; no fabricated outbox item |
| Recorded intent, before/during network send | Known message ID, **outcome unknown** until evidence reconciles it; no automatic resend |
| Broker accepted, local outcome not yet recorded | Reconcile read-only receipt evidence; if unavailable, remain unknown |
| Receiver accepted into memory, before durable receipt | Do not tell sender "received" without a supported receipt; re-delivery must dedup by ID |
| Receiver saved message but native Pi admission not proven | Restore for inspection, do not auto-wake model on an uncertain replay |
| Native Pi message posted before persistence of that fact | Inspect native history and reconcile once; never inject the same content twice |
| Restart during a contact approval dialog | Abandon the old dialog; no grant from a late callback |
| Restart after explicit revocation | Denial remains effective; transport metadata cannot undo it |
| A hands work from B to C, then A/B/C restart | IDs and handover links remain exact; C never inherits B's approval or private records |
| Broker crash with pending queue | Recovered queued item delivered or shown expired/failed/unknown, never silently lost as success |

## Compatibility and rollout

The compatibility story is as important as the storage format:

1. **M4-0 preflight (this PR):** Audit baseline, agree on trust, records, consent lifetime, exact queue identity, failure states and tests. No runtime behavior change or release.
2. **M4-A / F10:** Implement versioned local records and same-session read/reply recovery in isolation. Preserve current runtime-only approval behavior. Validate schema, file permissions, corruption, overflow, crash windows and native saved history.
3. **M4-B / F11:** Implement *new* explicit persistent-consent choice, sticky revocation, approval-on-resume checks and downgrade behavior. No silent migration of old consents.
4. **M4-C / F12:** Enable and test crash-durable exact-ID offline queueing, receipts, expiry and dedup. Audit the inherited mailbox and turn off unsafe alias paths for the public API.
5. **M4 acceptance:** Run the same-session restart and three-session handover scenarios through installed Pi, plus a separate real-agent/human walkthrough. Close issue #20 only after observed behavior matches the contract.

Each implementation PR should explain **what is not yet durable**. A mix of old and new peers must fail clearly or stay within known capability; it must not silently drop metadata or invent delivery. Leave legacy snapshots readable on downgrade where feasible, and never let an older binary overwrite an unknown newer schema. Document retention, backup, corruption recovery and explicit deletion of saved communication records.

## Guardrails for developer and agent experience

Do not require the agent to pick between new send/wait modes, manually manage receipt IDs, or remember another tool. Continue using four existing tools and the M3 organizer API. Expose only meaningful recovery state when an agent actually needs to act; keep low-level transaction logs available for inspection. No new agent roster, background task manager or model-driven retry loop.

**Exit criterion for this preflight:** the proposed architecture and the acceptance matrix have been challenged against current source and at least one native fixture; the first implementation slice is scoped without asserting that M4 is complete. This document does not satisfy F10, F11 or F12 on its own.
