# Product and development principles

> pi-comms provides shared communication for independently managed agents. Improve continuity, clarity and reach while keeping its concepts small and its behavior consistent.

Be opinionated about clear, reliable communication. Let users and organizing systems decide how agents are arranged and how their work is managed.

This document guides product and implementation decisions. The [README](../README.md) describes shipped behavior; the [roadmap](ROADMAP.md) contains proposals. A principle expresses direction, not a claim that a proposed capability already exists.

## Development emphasis

1. **Make the Pi experience reliably pleasant.** Make contact, requests, replies, inspection and interruption easy to understand in real work.
2. **Make persistent collaboration practical.** Improve conversation continuity, peer context and clear work reports together.
3. **Add cross-harness adapters selectively.** Deliver useful complete exchanges through a small number of well-understood integrations.
4. **Let other packages organize collaboration.** Offer shared communication that team, room, specialist and workflow tools can use without duplicating it.

The opportunity is shared communication across independent agent systems. Preserve that focus as capabilities grow; feature breadth is useful only when it serves that purpose.

## 1. Keep responsibility clear

| Responsibility | Owner |
| --- | --- |
| Addressing, contact decisions, message delivery, reply linkage, reception and communication evidence | pi-comms |
| Agent creation, rosters, roles, assignments, work acceptance and replacement decisions | User or organizing system |
| Model execution, native tool permissions and native session behavior | Host harness |
| Findings, questions, progress and completion reports | Participating agents, attributed to their authors |

Carry useful roles, work references and reports supplied by those owners. Keep organization choices outside the transport. Standalone use should remain useful without a team manager or another package.

## 2. Grow one coherent product

Extend existing concepts and paths before adding another tool, store, registry or protocol. Choose the smallest complete change that serves the user journey. Consider both human effort and agent effort, including setup, instructions, tool choice, recovery and ongoing maintenance.

Review changes across schemas, runtime behavior, tool descriptions, human views, tests and docs. Resolve conflicting assumptions together rather than attaching another exception or workaround. Keep consequential restrictions, approval requirements and compatibility changes explicit product decisions.

## 3. Preserve identity, user control and evidence

Keep session identity, live connection and conversation identity distinct. Resolve convenient names to an exact recipient; preserve that recipient through waits and recovery. Treat a replacement agent as an explicit handover decision.

User directives and native permissions remain controlling. Preserve contact approval, revocation, Pause and human-input priority as communication grows. Discovery and role labels provide context; authority comes from the user or an integration carrying the user's approval.

Distinguish what the runtime observed from what a peer reports. A connection can be live while the agent is busy. A reply can contain a question. A peer can report completion while the requester still needs to assess the result. Keep delivery facts, reported work outcomes and work acceptance separate and easy to read.

Represent uncertainty at the point where it affects a decision. Recovery must preserve known outcomes and avoid blindly repeating an operation whose outcome is unknown.

## 4. Use one authoritative communication record

Human views, model-facing text, structured results and integration APIs should project the same underlying records, with the right detail and access for each audience. Avoid parallel inboxes or competing versions of conversation state.

Link replies and work reports to the request they concern. Grouping exchanges by a work reference should expose only communication available to the participant. Keep original messages and the links to later corrections.

Design continuity around user outcomes: resume an exchange, preserve an intended collaboration, receive eligible messages sent during a gap, and understand interrupted operations. Choose storage after these behaviors are clear. Durable records must not imply automatic replay, renewed authority or successful execution.

## 5. Inherit first; adapt, then harmonize

Inspect existing implementations before building a capability from scratch. Prefer a focused dependency or an extracted component when it fits; reuse useful tests, failure cases and interaction patterns as well as code. A direct implementation is reasonable when adaptation would cost more or import conflicting assumptions.

For borrowed code, record its source, pinned revision or version, license, retained behavior and local changes. Evaluate the dependencies and lifecycle assumptions it brings. Preserve required notices.

Make the public behavior coherent in the first shipped slice: consistent names, instructions, results, permissions and evidence. Internal consolidation can follow. Name the follow-up precisely: duplicated state, obsolete branches, unused dependencies or competing protocol paths to remove. Give it an owner and a target milestone or issue rather than an indefinite cleanup promise.

Do small, safe pruning alongside feature work. Schedule broad transport or state replacement separately, after the useful inherited behavior is understood. Compare the result against real journeys and measured maintenance costs.

## 6. Write and design for a tired reader

Lead with the result, who it concerns and the next useful action. Use plain words, stable terms and the same structure for comparable peers, requests and outcomes. Put payload and meaning before technical identifiers; keep full evidence available on demand.

Keep essential instructions short and close to the action. Put longer examples and workflow recipes in on-demand guidance. Include conditions and exceptions where they change a decision. Remove repeated warnings, defensive contrasts and unexplained internal vocabulary.

Favor requested information, necessary questions, corrections and material updates. Reduce acknowledgement-only exchanges through clear guidance and useful defaults. Describe model guidance as guidance rather than claiming runtime enforcement.

## 7. Prove useful behavior at reasonable cost

Seek sufficient confidence at the lowest reasonable ongoing cost. Use focused regressions for demonstrated failures and end-to-end journeys for the important contracts. Test the installed artifact and relevant host lifecycle when a change crosses those boundaries.

Exercise ordinary collaboration with real users and models where needed. Record what automated tests, scripted providers and live use each establish. Report untested combinations and failures accurately; test count alone is not a quality measure.

For each feature, explain the user capability, the existing implementation to inherit, the compatibility impact and the observable completion criterion. Keep unselected proposals separate from implementation scope. Follow [RELEASING.md](../RELEASING.md) for verification and publication.
