# Changelog

## [0.1.11] - 2026-11-09

- Automatically retire and replace an older running `pi-comms` broker under `BROKER_SPAWN_LOCK` when a connecting session has a newer broker artifact on disk (#37). Verify that the target PID runs `transport/broker/broker.(js|ts)` for the current comms directory before sending `SIGTERM`—a stale or unverified `broker.pid` is never terminated.
- Stamp the package version into built bundles and include `{ packageVersion, pid, startedAt }` on broker `health_ok` and `registered` responses, surfaced in `/comms status`. Raise the broker's unregistered-connection cap to `2 × MAX_SESSIONS` (`256`) so simultaneous health probes and registrations during a broker-upgrade reconnect burst do not evict each other.
- Keep version replacement monotonic (`runningBrokerVersion < diskBrokerVersion`, including SemVer prerelease precedence) and protect `BROKER_SPAWN_LOCK` with per-acquisition tokens, live-owner preservation, and atomic stale-lock reclamation when a starter exits early.
- Document broker-replacement interruption limits: remembered pair approvals in `pair-approvals.json` survive, while in-memory session-only approvals, active `comms_ask` waits, and any RAM-only mail in a pre-F12 broker end on replacement. Record the F12 automatic-upgrade offline-mail survival regression in the M4 contract.
- Include broker version (`unreported (pre-0.1.11)` when absent), start/PID-file timestamp, and verified-versus-unverified PID guidance in `BROKER_OUTDATED` and `/comms status` when a pre-F11 broker cannot be replaced automatically, without advising users or agents to blindly kill an unverified PID.

## [0.1.10] - 2026-11-08

- M4-B / F11: one owner approval for an **unordered exact A–B pair**, valid in either direction. **Allow this session** (default) lasts until either Pi session reloads or is replaced, or the broker restarts; a dropped connection that reconnects in the same Pi session keeps it. **Allow & remember** survives restart of both original sessions and the broker.
- Contact is **approved or not approved**; there is no stored refusal or block list. **Decline**/Esc stores nothing; the agent does not re-prompt in the same turn and may ask again after the user's next message. `/comms revoke` from either side ends an approval for both directions and affected asks.
- Shorten the first-contact decision to **who, topic, request preview and effect**. Detailed UUIDs and transport rules move to inspection/help.
- The broker stores only remembered approvals, in one atomic file under the comms directory. Session-only approvals stay in memory, and ended pairs leave no records. The broker checks approval at send admission and pushes status changes to both endpoints.
- A failed save rejects only that remembered choice (`PAIR_SAVE_FAILED`); other pairs keep working. An unreadable approvals file is moved aside and grants nothing.
- Approvals now live only in the broker. Removed the per-message transported approval and the native record's approval role. Approvals and refusals saved by 0.1.9 are history only; message readability they granted is kept.
- **Upgrade:** all sessions sharing a broker must run 0.1.10. Older peers yield `PEER_OUTDATED`; an older running broker yields `BROKER_OUTDATED` until its sessions reload. Both carry recovery guidance for agents. The four agent tools and the organizer API are unchanged. F12 durable offline delivery is not part of F11.

## [0.1.9] - 2026-11-04

- M4-A / F10: restore communication messages, work/report/correction/handover links, return handles, known outcomes and historical agent readability for the **same saved Pi session**, using Pi's native extension-state entries instead of another transcript database.
- Restore records, Pause and explicit negative contact decisions before broker registration; new outgoing/incoming communication still requires current approval. Old authorized history remains readable after approval expires or the peer is revoked; previously withheld content stays withheld.
- Keep native Pi's real persistence limits visible: fresh/ephemeral sessions can be live-only; failed writes, malformed records and uncertain native admission are not silently reported as saved or replayed. Restore without reviving local `comms_ask` waits or automatically resending unknown operations.
- Preserve existing four agent tools, human-first intake, corrections and M3 organizer API. F11 remembered positive approvals and F12 broker-crash-durable offline mail are **not** included.
- Cover saved-session restart, Pause/revocation, read versus admission, withheld mail, forks/branches, corruption, storage failure and installed-package recovery paths. See the M4 contract for remaining host and acceptance limits.
- Keep a busy-boundary batch **offered/uncertain** until native Pi history proves admission; a cleared steering queue cannot manufacture a posted receipt. Keep a completed nested-ask **handed-off** result out of the recovery waiting queue, without claiming a saved child transcript or model consumption.
- Add human resolution of uncertain intake via existing `/comms requests`: owner-confirmed same-ID redelivery (possible duplicate work, current contact approval required) or dismissal, persisted when Pi confirms a saved session entry, otherwise marked live-only until the host saves them; confirmation and outcome text reflect this limit. Separate uncertain from normal waiting counts; no automatic resend or new agent tool.
- Treat a completed **No/Esc** on both incoming and outgoing first-contact prompts as a persisted refusal; explicit owner reapproval is required to clear it. Stop/abort only cancels the attempt and never saves a refusal. Tests cover transport assertion and same-session restart.

## [0.1.8] - 2026-11-02

- M3-B/F09: optional `handoverFrom` on a new `comms_message` or `comms_ask` request links a visible earlier exchange to an explicitly addressed successor.
- The lead authors the brief and artifact pointers. No former transcript, identity, approvals, pending work, return handles or task acceptance transfer.
- The sender's `comms_inspect({exchange:oldId})` derives successor-exchange links and observed send outcomes from the same records; recipient messages and native cards label provenance as sender-supplied.
- Preserve original tools, first-reply waits, normal first-contact approvals, privacy boundaries and uncertain-send evidence. No handover task store.
- Test three-session delivery, lineage, unchanged old work, lack of automatic disclosure and invalid-link rejection, including native Pi behavior.

## [0.1.7] - 2026-11-02

- M3-A: introduce an optional, versioned **same-Pi-runtime** organizer integration API using Pi's shared `pi.events` bus. Supports peer discovery, exact-session send/reply, and read-only inspection over the existing pi-comms records.
- Reuse ordinary first-contact human confirmation, exact-recipient resolution, bidirectional pair approval, Pause/revoke and transport-result handling. Other extensions cannot assert owner approval or grant permissions through this interface.
- Give integration clients session-scoped capabilities that reject use after runtime replacement; no added model tools, broker transport, independent inbox, task ledger or persistent state.
- Verify a separate organizing extension uses the published local bus contract and returns original-request reports via the same inspection as standalone tools. F09 explicit handover remains a separate reviewed step.
- Share exact inspection logic between the organizer API and `comms_inspect`; keep peer discovery bound to its starting session across async calls. New calls through stale organizer handles now return the same structured `CONTEXT_LOST` error shape as normal tool failures; a send already dispatched retains its observed delivery result rather than being misreported as unsent. Drop an unused, unshipped discovery helper so the event bus remains the one documented entry point.

## [0.1.6] - 2026-11-02

- Deliver request-linked questions, blocked reports, completion reports and later corrections automatically through the existing human-first incoming-message path. No new ask mode or follow-up waiting call.
- Keep progress-only reports in the existing communication record and inspection without waking the model. Group the progress history with the next actionable report; retain exact original messages and source evidence.
- Preserve the last actionable peer-reported state when later progress arrives. Expose both the latest received report and current reported state in request inspection, noting any later progress. A later blocked or complete report updates that state; no peer claim becomes requester acceptance.
- Keep `comms_ask`'s existing first-linked-reply behavior and all four agent tools unchanged. Preserve approval, Pause, human-input priority and exact request/peer linkage.
- Verify automatic delivery and no-progress wake, late progress after completion, corrections, held/unapproved intake, native cards and installed Pi behavior.
- Preserve conversation previews when no real actionable report supersedes progress; deliver explicit progress-state corrections even after the earlier result reached the requester. Corrective progress updates become the current reported state without letting ordinary late progress override them.
- Clarify that approval belongs to the exact session pair for both communication tools and both directions during the current runtime; work labels are context rather than per-message consent limits. Add three-session pairwise consent regression.

## [0.1.5] - 2026-11-01

- Allow optional `structured` JSON objects alongside readable messages and replies without a new tool or data store.
- Add optional reply-only `report: { request, state }` for colleague-reported progress, needs-input, blocked and complete, linked to the exact original request in the same exchange.
- Preserve report links across clarification turns; `comms_inspect({requests:[...]})` exposes the latest attributed report separately from the first direct reply and never infers work acceptance.
- Show reported states and structured evidence in incoming native messages, human cards, inspection and tool results. Expose original message IDs to recipients so reports can name the correct request.
- Test schema conversions, attribution, mixed-version limits, privacy, error cases and packaged native communication. Reporting metadata requires both peers on 0.1.5 or later.
- Keep the original report target and unverified-link warning in collapsed ask results; reject non-JSON nested structured data, including non-finite numbers, before transport can change values.

## [0.1.4] - 2026-11-01

- Add optional `workRef` to new messages and independent asks. Linked replies inherit it, and `comms_inspect({workRef})` groups exchanges visible to the inspecting participant.
- Add optional `recipientLabel` on new requests to describe a colleague's role in that exchange, not their global identity or authority. Discovery shows requester-supplied labels with their exchange/work context.
- Show work references and attributed labels in native incoming messages, human cards, tool outputs and inspection; preserve existing unscoped messages and the four-tool API.
- Validate scope immutability through reply rounds, exact recipient identity, selector privacy and backwards-compatible unscoped wire payloads. Metadata-bearing messages require participating sessions running 0.1.4 or later; mixed-version delivery may be uncertain.

## [0.1.3] - 2026-11-01

- Report observed working/idle activity and timestamp freshness in peer discovery, separately from connection state. Preserve unknown and offline activity instead of guessing.
- Use a shared, plain-language status vocabulary for request results, message inspection and expanded human cards; surface useful recovery actions without changing delivery guarantees.
- Ship an on-demand pi-comms skill for practical collaboration patterns; keep the existing four agent tools and send/ask behavior.
- Add focused presence, projection and native lifecycle regression coverage.
- Clarify that activity freshness comes from status-bearing broker reports, not unrelated presence updates; align user/tool guidance and test installed-package skill discovery.

## [0.1.2] - 2026-11-01

- Remove duplicate error-code prefix in plain-text tool error results (`INVALID_INPUT: ...` instead of `INVALID_INPUT: INVALID_INPUT: ...`).
- Instruct models to stop retrying in a loop and report the provider schema issue when a tool interface forces optional fields to be populated.
- Document and test `compat.supportsStrictMode: true` for custom `openai-completions` gateways that require explicit `"strict": false`.

## [0.1.1] - 2026-10-30

- Clarify routing validation errors with explicit new-message and reply forms, without inferring intent from conflicting fields or encouraging fabricated IDs.
- Document recovery from provider schemas that incorrectly require optional routing fields.
- Add offline regression coverage for serialized schemas and Google/OpenAI provider conversions.

## [0.1.0] - 2026-10-29

Initial public release.

- User-approved communication between existing Pi sessions, exact native identities and reusable reply handles.
- Independent batched asks with bounded waits, partial outcomes, late replies and exact-request response progress.
- Human-first intake: Pause, revoke, interruption and open contact decisions hold unadmitted replies.
- Plain-text tool results with structured evidence, full payload inspection and response links.
- Isolated artifact verification, Linux/macOS CI and versioned npm/GitHub release automation.

State is memory-only. Reloads/restarts lose approval and runtime linkage. Scripted native-session tests do not establish real-model compliance or human usability. Tested against Pi 1.4.0; other Pi versions are not claimed.
