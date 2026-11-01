# Feature proposals and milestones

**Status: proposed sequence for product review.** These features are not implemented or authorized by this document. [PRINCIPLES.md](PRINCIPLES.md) supplies the development guidance; the [README](../README.md) remains the current usage contract.

The order runs from the smallest expected change to existing behavior toward the broadest state, integration and implementation changes. It is a compatibility-risk order, not an estimate of effort. Small cleanup belongs in every milestone; M6 covers deeper consolidation after useful inherited features are established.

## Current baseline

At the reviewed `main` revision `ae570644d4dc68e45c93e267eecab352ede54fe7` (package 0.1.1), pi-comms has four agent tools, exact Pi session addressing, requester-side contact approval, reusable runtime reply handles, human-first intake and independent batched asks. Peer discovery already exposes online/offline state. Tool results already include structured runtime evidence.

`comms_ask` returns a collected result after its items have replied or reached another local ending; it does not stream individual answers to the calling model. It waits for the first linked reply, which may be a clarification. Runtime records and approvals are memory-only. The public send path rejects unavailable peers. No-courtesy instructions guide the model rather than filter messages.

## Milestone overview

| Milestone | User outcome | Expected disruption |
| --- | --- | --- |
| M1: Clear live collaboration | Understand who is reachable and what happened | Low: existing tools and presentation |
| M2: Related work and explicit outcomes | Group exchanges and recognize reported progress or completion | Low to moderate: optional metadata and reply conventions |
| M3: Shared integrations and handover | Let organizing packages use the same communication contract | Moderate: supported integration API and explicit transfer flow |
| M4: Collaboration that survives interruptions | Resume exchanges and handle short disconnections | High: persistent state, recovery and delivery semantics |
| M5: Cross-harness collaboration | Exchange useful requests and replies with another harness | Higher: identity and lifecycle across independent runtimes |
| M6: A smaller, harmonized core | Retain those capabilities with fewer competing paths | Broadest internal change: transport and state consolidation |

## M1: Clear live collaboration

| Feature | Capability gained | Inherit or adapt first |
| --- | --- | --- |
| F01: Richer peer presence | Show reachability separately from activity, with observation time and useful status text | Existing broker heartbeat/status paths; pi-intercom presence updates; pi-messenger's readable activity presentation |
| F02: Consistent outcomes and inspection | Make sent, waiting, held, replied, unavailable and uncertain results easy to compare in human and agent views | Current runtime records, model view and inline cards; focused intercom presentation patterns |
| F03: Short collaboration recipes | Help agents choose send versus ask, handle clarification rounds, avoid courtesy loops and prepare a handover brief | Intercom coordination guidance and existing pi-comms tool guidance, rewritten around the four current tools |

Activity is an observation about a session, not proof of progress on a particular request. Show unavailable or stale information clearly. Improve current paths before adding new monitoring tools or services.

**Complete when:** a lead contacts two reviewers, understands partial and late answers, and handles an interruption without human ID relay or repeated setup. Verify the normal path with real use as well as focused scripted checks.

**Refinement:** remove duplicate status text and unused presence fields as the new views settle. Keep a single source for the meaning of each displayed state.

## M2: Related work and explicit outcomes

| Feature | Capability gained | Inherit or adapt first |
| --- | --- | --- |
| F04: Contextual peer labels | Discover a colleague's role or expertise for the relevant collaboration | Existing peer metadata and approved-contact context; simple roster/status patterns from intercom and messenger |
| F05: Work references | Group available exchanges under a ticket or investigation and inspect them together | Existing exchange/subject/reference records and inspection pagination |
| F06: Structured reply data and work reports | Carry machine-readable results and explicit reports such as blocked or complete, linked to the intended request | Current envelope, response linkage and structured projections; useful report patterns from intercom and messenger without their task managers |
| F07: Request-aware outcome delivery (revised) | Deliver actionable reported outcomes and clarify current state without making the lead manage a second wait | Existing human-first incoming-message path, request links, report inspection and native cards |

Roles may differ between collaborations. Work references group records already available to the participant; they do not expose other sessions' private conversations. Replies should retain their work reference.

Validate structured data for supported encoding, shape and size; leave domain-specific claims to the caller. Define a small optional work-report convention rather than requiring every message to become a form. Final reports must identify the original request even after clarification rounds.

Keep today's first-reply ask behavior **unchanged**. F07 was revised after design review: do **not** add a blocking outcome wait or a second form of `comms_ask`. Deliver questions, `needs-input`, `blocked`, `complete` and corrections through the existing human-first intake. Record progress-only updates without unnecessary model wakes; group their history with later actionable reports. Preserve raw messages and evidence, and distinguish the last actionable reported state from the latest received report so late progress cannot appear to undo completion. A reported outcome remains **the peer's claim**, never the requester's acceptance.

**Complete when:** a reviewer asks a question, later reports complete with evidence, and the lead receives the relevant outcome without re-sending or managing another wait. Progress-only messages remain inspectable without repeated model wakes; late progress cannot replace an actionable result; a later corrective report remains visible. Verify Pause, revocation, human priority and first-reply asks.

**Refinement:** converge labels, report names and result wording across tools and views. Optional fields need explicit mixed-version behavior; do not silently drop information that changes meaning.

## M3: Shared integrations and handover

| Feature | Capability gained | Inherit or adapt first |
| --- | --- | --- |
| F08: Supported owner-integration API | Let teams, rooms, specialist launchers and other packages supply participants, contextual labels, work references and explicit user approval through the same communication paths | Existing runtime methods and tool/result contract; focused bridge patterns from intercom and agent-comms |
| F09: Explicit handover support | Transfer an authored brief, findings, open questions and artifact references to a chosen replacement session, with traceable old/new exchange links | Existing message/reference/correction mechanisms and intercom's handover workflow |

Separate an owner integration carrying the user's decision from ordinary peer-authored metadata. Avoid a second roster, task ledger or approval framework. Expose only the useful integration surface; internal state objects need not become public APIs.

The work owner chooses the replacement and authorizes contact. The sending agent or caller authors the brief; pi-comms transports it. Preserve the old recipient's identity and open an explicit exchange with the replacement. A new session must not silently inherit its predecessor's approvals or pending messages.

**Complete when:** one organizing package can establish a bounded collaboration, collect linked reports and hand work to a selected replacement using the same records and controls as standalone use.

**Refinement:** remove integration-specific shortcuts once the shared interface covers the demonstrated use. Keep standalone setup equally simple.

## M4: Collaboration that survives interruptions

| Feature | Capability gained | Inherit or adapt first |
| --- | --- | --- |
| F10: Resumable communication records | Restore exchange history, request/reply links, return handles and known outgoing outcomes after reload or restart | Current runtime record model; intercom session-history handling and hcom's storage/acknowledgement patterns |
| F11: Approval and revocation continuity | Continue the same explicitly approved collaboration without unnecessary repeat prompts while preserving revocations | Current contact decisions, bound to stable session identity and their agreed lifetime |
| F12: Bounded disconnected delivery | Hold eligible messages for the exact unavailable session and expose pending, delivered, expired or uncertain outcomes | Existing inherited mailbox code, reviewed against hcom and agent-comms reconnect/delivery cases |

Choose a single coherent storage and recovery design for these outcomes. Audit the inherited mailbox before enabling or copying more of it. Queue size and expiry must follow the intended workflow rather than an arbitrary five-minute promise.

Persisted records alone do not establish model admission or safe replay. Define duplicate handling and reconcile interrupted sends from evidence. Preserve Pause, revocation, contact context and exact-recipient binding. Make expired or unrecoverable work visible. Restore only approvals whose original lifetime and scope cover the resumed collaboration.

**Complete when:** either participant restarts during a review, the same saved session resumes, known conversation links remain usable, revocation remains effective, and an interrupted send is reconciled or shown as uncertain without duplicate work. Also test broker loss and queue expiry. No general exactly-once execution claim follows from this milestone.

**Refinement:** consolidate storage ownership and remove temporary dual-write or migration paths once the supported transition is complete. Document retention, cleanup, upgrade and rollback behavior.

## M5: Cross-harness collaboration

| Feature | Capability gained | Inherit or adapt first |
| --- | --- | --- |
| F13: First complete external-harness adapter | Send to an existing external session and receive a linked answer after that session uses tools | Evaluate agent-comms bridge components and its focused `cc-peer` dependency for Claude Code; compare supported Codex routes and hcom integration patterns |
| F14: Capability-aware discovery and outcomes | Tell callers whether a peer supports live push, queued or pull reception, replies and specific receipt evidence | Shared adapter descriptions and result projections, informed by agent-comms and hcom |

Choose the first harness by a useful end-to-end workflow, integration cost and compatibility risk. `cc-peer` is a candidate, not a selected dependency: its own docs describe an unofficial, reverse-engineered protocol. hcom's AGY path uses terminal wake and hooks; assess that operating model explicitly against the product contract.

Bind harness-qualified native session identity to the correct endpoint. Keep host permissions and human controls intact, and expose only evidence that the adapter can establish. MCP tools alone do not establish inbound delivery to an existing live session.

**Complete when:** Pi and one external existing session exchange a request, clarification and final report across tools/turns; interruption, disconnection and unsupported modes have clear outcomes. Keep the same user-facing concepts used for Pi peers.

Use existing [Codex #4](https://github.com/tranhoangnguyen03/pi-comms/issues/4), [Claude Code #5](https://github.com/tranhoangnguyen03/pi-comms/issues/5) and [AGY #6](https://github.com/tranhoangnguyen03/pi-comms/issues/6) as starting points. Confirm their scope against current evidence before implementation. Additional adapters are separate slices rather than prerequisites for the first adapter's release. Valuable native-Pi work should not wait for every adapter.

**Refinement:** isolate harness-specific code, pin compatibility versions and share regression cases. Replace overlapping glue once the first real adapter reveals the useful common interface.

## M6: A smaller, harmonized core

| Feature | Capability gained | Inherit or adapt first |
| --- | --- | --- |
| F15: Lean transport core | Retain reliable communication with fewer runtime components and fewer unrelated failure paths | The exercised exact-send, connection, receipt and recovery paths already inherited and adapted |
| F16: Unified state, evidence and compatibility checks | Give users consistent inspection and upgrade behavior while making future changes cheaper to maintain | Existing records and scenario tests; consolidate overlapping stores, projections and inherited regressions |

Trace production use before removal. Candidate areas include unused extension-bus features, legacy ask machinery, pane/location branches, duplicate records and obsolete delivery paths. Remove them only where the supported contract no longer depends on them.

Prefer incremental extraction and deletion to a replacement framework. Avoid replacing a local broker with a replicated mesh solely to reduce owned lines of code. Preserve the recipient, consent, interruption and uncertain-delivery behavior established earlier.

**Complete when:** the same collaboration and recovery journeys still pass, while an explicit inventory shows fewer state owners, protocol paths or dependencies. Record actual startup, package-size or maintenance improvements where measured; do not infer them from a lower line count.

**Refinement:** refresh the upstream reuse map and remove completed transition code and obsolete documentation. Keep the resulting public contract smaller than the sum of its donors.

## Reuse sources and follow-up discipline

These are candidates and references, not verified interchangeable components:

| Source | Best fit to investigate |
| --- | --- |
| [pi-intercom](https://github.com/nicobailon/pi-intercom) | Native Pi presence, interaction, lifecycle, handover and focused tests; already a source donor |
| [pi-messenger](https://github.com/nicobailon/pi-messenger) | Readable activity, discovery context and report patterns |
| [hcom](https://github.com/aannoo/hcom) | Storage, acknowledgement, host hooks and cross-harness failure cases |
| [agent-comms](https://github.com/ExaDev/agent-comms) | Small bridge components, capability differences and reconnect cases |
| [cc-peer](https://github.com/ExaDev/cc-peer) | Focused Claude Code communication candidate with explicit protocol compatibility risk |

For each implementation slice, record the selected source/version, adaptation needed now and a concrete harmonization follow-up with an owner and milestone or issue. Recheck licenses and supported host versions at selection. Follow-up work can simplify internals later; public instructions and behavior must fit pi-comms from the first release.

Features may move between milestones when evidence changes the risk or dependencies. Keep the milestones focused on complete user outcomes rather than the number of borrowed features.
