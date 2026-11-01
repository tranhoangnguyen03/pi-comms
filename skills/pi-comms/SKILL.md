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

## Clarification and findings

If a colleague asks a question, reply using the handle on its message. The colleague may later send the final findings on the same exchange. Link any correction to your own earlier message only when you have its real ID. The work owner judges completion; a transport receipt or first reply does not prove it.

Avoid acknowledgement-only traffic. Send questions, corrections, findings and material updates; stop when no more information is needed.

## Late, missing and interrupted replies

Use `comms_inspect({requests:["<actual outgoing message ID>"]})` to check **that request**, or `comms_inspect({})` for a quick overview. Do not poll repeatedly without a reason. Timeout ends the local wait, not the colleague's work. Pause holds incoming admission until `/comms resume`; Stop only stops the current run. Human input and drafts take priority over peer messages.

Inspect uncertain outgoing operations before retrying. If an exact peer is offline, do not send to someone with a similar name. Contact approvals, queues, outbox records and return handles are currently memory-only and can be lost on restart or session switch.

## Handover without changing identities

A handover is an **authored new request** to an explicitly selected successor. Summarize the goal, key findings, decisions, open questions and links to work products; send that brief with `comms_message`. Keep the old session's identity and conversation intact. pi-comms does not create agents or silently transfer their authority.

For current command and parameter details see the package README. Do not treat the future roadmap as shipped capability.
