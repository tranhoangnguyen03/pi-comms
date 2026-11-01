# Changelog

## [0.1.6] - 2026-11-01

- Add optional `waitFor:"reported-outcome"` to `comms_ask({requests:[...]})`. A peer's `complete`, `blocked` or `needs-input` report on the exact request ends that wait; ordinary replies also return promptly without implying completion.
- Add `comms_ask({outcomes:[originalOutgoingRequestId,...]})` to wait for new reports on existing work after clarification, without re-sending the request. Waits stay tied to exact session and request identities.
- Keep the default first-linked-reply ask unchanged. Progress-only reports do not end outcome waits. Human interruption, Pause, revocation, timeout and disconnection still end only the local wait; late messages remain available.
- Preserve reported outcomes and first-reply semantics in plain and structured results, on-demand guidance and collapsed human cards, without adding tools, state stores or an acceptance workflow.
- Verify requested-outcome and existing-request waiting through focused runtime tests and native Pi integration; include recovery and duplicate-wait checks.
- Keep outcome-watch admission behind existing human-priority checks, and route unclassified replies to the closest matching active request in a clarification chain. Trim the ask tool guidance while keeping long recipes on demand.

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
