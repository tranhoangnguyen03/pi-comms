---
name: pi-comms
description: Use when coordinating existing Pi sessions, choosing send vs ask, requesting parallel reviews, handling clarifications, late replies or a handover. Short communication recipes.
---

# Communicate with Pi colleagues

Use this skill for multi-step collaboration, not every message. pi-comms connects **existing** sessions. Find peers with `comms_peers`, send requests with `comms_message`, wait for a first reply with `comms_ask`, and inspect available evidence with `comms_inspect`. The owner approves a new contact at first send; repeat approvals are not normally needed while that runtime remains loaded.

## Choose the least disruptive call

- **Share information or assign work:** `comms_message({to:"Reviewer", subject:"Risk review", text:"Inspect the diff. Do not edit. Send findings with evidence."})`. Send is asynchronous; continue useful work. Transport acceptance does not mean the colleague read it or completed it.
- **Need a reply before proceeding:** `comms_ask({requests:[{to:"Reviewer", subject:"Review question", text:"Is the retry safe?"}], timeoutSeconds:60})`. The tool returns a collected result after each item receives its **first** linked reply or another ending. A clarification is a reply, not completed work.
- **Ask several colleagues:** Put independent requests in the same `requests` array. Each starts independently. An unavailable contact does not cancel another item. The default wait ends after 60 seconds per accepted request; a late reply can still arrive.
- **Continue a conversation:** A received message gives a reusable return handle. Use `comms_message({respondTo:"<actual return handle>", text:"..."})`, omitting `to` and `subject`. Never invent handles.

## Related work and contextual labels

For requests about the same ticket or investigation, add a short work reference. To describe a recipient's role **for that specific exchange**, add a sender-supplied recipient label:

```js
comms_message({to:"Reviewer", subject:"Retry review", text:"Check duplicate writes.", workRef:"AUTH-42", recipientLabel:"Security reviewer"})
comms_inspect({workRef:"AUTH-42"})
```

The label never grants authority, creates a team or changes native tool permissions. `comms_peers` can show labels you supplied for earlier accepted requests. Replies using `respondTo` inherit the work reference automatically; **do not** repeat `workRef` or `recipientLabel` on replies. Work-reference inspection shows only exchanges available and approved in your session, not other agents' private conversations. Use matching 0.1.4+ peers for metadata-bearing sends; uncertain delivery is not proof of a failed send.

## Structured findings and work reports

Keep a clear readable text answer. Add an optional `structured` JSON object for machine-readable details. When you need to report your work state, send a **reply** with `report`; this is your report, not the requester's acceptance:

```js
comms_message({
  respondTo: "<actual return handle>",
  text: "Found one unsafe retry. Tests pass.",
  report: { request: "<original received message ID>", state: "complete" },
  structured: { finding_count: 1, tests_passing: true, files_changed: [] }
})
```

The original request's **Message ID** appears in the incoming message. It is not the return handle. Keep `report.request` linked to that original message even after clarification rounds; `respondTo` may refer to a more recent message in the same exchange. A collapsed ask result shows which request a report targets and warns if its link is unverified. Nested `structured` values must be JSON-safe, including finite numbers; invalid values are rejected rather than silently changed. Available states: `progress`, `needs-input`, `blocked`, `complete`. Choose the state that describes your actual work and provide evidence; never treat the state as verified task acceptance. Plain replies need no report or structured data. Reports require both peers running pi-comms 0.1.5 or later.

The requester can use `comms_inspect({requests:["<original outgoing message ID>"]})` to see the latest reported state even if it arrived through a later clarification. `comms_ask` still ends at the first linked reply, which may be a question.

## Request-aware outcomes without more waiting

No special wait mode is needed. Ask once with `comms_ask` when a first reply matters, or send asynchronously with `comms_message`. The colleague replies with plain text, questions or an optional `report`, using the original request ID. If clarification is needed, answer with the returned handle and continue your work; do not re-send the original request just to keep waiting.

Normal incoming delivery brings later `needs-input`, `blocked`, `complete` and useful plain replies to you. Progress-only reports are recorded and remain inspectable but do not wake you on their own. When a later outcome arrives, earlier progress is summarized and retained in the exchange history. A delayed progress update cannot override the last actionable reported state. Use `comms_inspect({requests:["<original outgoing message ID>"]})` when you need the detailed history or current peer-reported outcome.

A peer's `complete` is a **report**, not your acceptance of the work. A later correction may change the reported state. Keep exact request links and evaluate the evidence; do not invent extra task authority.

## Clarification and findings

If a colleague asks a question, reply using the handle on its message. The colleague may later send the final findings on the same exchange. Link any correction to your own earlier message only when you have its real ID. The work owner judges completion; a transport receipt or first reply does not prove it.

Avoid acknowledgement-only traffic. Send questions, corrections, findings and material updates; stop when no more information is needed.

## Late, missing and interrupted replies

Use `comms_inspect({requests:["<actual outgoing message ID>"]})` to check **that request**, or `comms_inspect({})` for a quick overview. Do not poll repeatedly without a reason. Timeout ends the local wait, not the colleague's work. Pause holds incoming admission until `/comms resume`; Stop only stops the current run. Human input and drafts take priority over peer messages.

Inspect uncertain outgoing operations before retrying. If an exact peer is offline, do not send to someone with a similar name. Contact approvals, queues, outbox records and return handles are currently memory-only and can be lost on restart or session switch.

## Handover without changing identities

A handover is an **authored new request** to an explicitly selected successor. Summarize the goal, key findings, decisions, open questions and links to work products; send that brief with `comms_message`. Keep the old session's identity and conversation intact. pi-comms does not create agents or silently transfer their authority.

For current command and parameter details see the package README. Do not treat the future roadmap as shipped capability.
