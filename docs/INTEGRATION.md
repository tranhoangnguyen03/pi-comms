# Local organizer integration (M3-A, v1)

An organizing **Pi extension** (team manager, room manager, consultant launcher) can use pi-comms' existing communication from its own running Pi session. No new agent-facing tool, roster, transport, approval store or broker protocol is installed.

This is a **local in-process interface**, not an HTTP/MCP endpoint and not a way to message another Pi process by itself. The ordinary pi-comms broker still transports outgoing messages between existing Pi sessions.

## The contract

Pi's documented [shared extension event bus](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#pievents) is the discovery mechanism. There is one public channel:

`pi-comms:organizer-api:v1`

Emit once when needed, from another local extension in the *same running Pi session*:

```ts
function piComms(pi: { events: { emit: (event: string, data: unknown) => void } }) {
  let api: any;
  pi.events.emit('pi-comms:organizer-api:v1', {
    version: 1,
    accept: (service: any) => { api = service; },
  });
  return api; // undefined until pi-comms is active
}
```

The callback is synchronous in Pi's local bus. Calls made through the returned service are asynchronous. **This event is the single supported discovery path**; no separate importable discovery helper is shipped. Keep the handle only while this same Pi session is active. New calls through a handle from an earlier session return a structured `CONTEXT_LOST` error, not another session's records or permissions. A send already dispatched before replacement may return its observed delivery result; retain its message ID and inspect evidence rather than assuming the work was unsent.

The service has exactly three operations and two identifiers:

| Member | Purpose |
| --- | --- |
| `version: 1` | The supported interface version |
| `sessionId: string` | Exact native session that owns this API |
| `peers({view?: "all" \| "known",cursor?})` | Same approved/available peer discovery and pagination as `comms_peers` |
| `send(messageInput, signal?)` | Same validated, approved, exact-session send/reply path as `comms_message` |
| `inspect(inspectInput)` | Same available/approved runtime records and local transport status as `comms_inspect` |

Each operation resolves to the **same structured result** used by the public model tools: `{ok,data?,error?,observedAt}`. Errors provide `code`, `message` and `nextAction`. `send` returns the exact outgoing `message.id`, `exchange`, accepted/rejected/unknown send facts and work metadata in `data` when available. On error or uncertain send, **inspect the outbox before considering a retry**.

There is no `approve`, `revoke`, `createSession`, `acceptWork`, or `sendWithoutConsent` method. M3-B uses the same `send({to,subject,text,handoverFrom,refs?})` method with a visible earlier exchange ID. No special handover method or approval path exists. The sender can inspect the old exchange for derived `handovers` links and send outcomes. The successor sees a source pointer, not the original transcript. Owner approval still belongs to pi-comms and its native user confirmation UI.

## Example: one bounded consultant review

```ts
const comms = piComms(pi);
if (!comms) throw new Error('pi-comms is not active in this Pi session');

// The organizer chooses an existing exact Pi session and provides context.
// The first contact uses pi-comms' ordinary owner approval prompt.
const sent = await comms.send({
  to: reviewerSessionId,
  subject: 'Review retry safety',
  text: 'Check this diff, report findings, do not edit.',
  workRef: 'AUTH-42',
  recipientLabel: 'Engineering reviewer',
});
if (!sent.ok) {
  // In particular, do not retry an uncertain send.
  throw new Error(sent.error?.message ?? 'Peer send did not succeed');
}
const requestId = sent.data.message.id;

// Later, inspect the same authoritative records as a standalone Pi agent.
const inspected = await comms.inspect({ requests: [requestId] });
const report = inspected.data?.responses?.[0]?.currentReport;
if (report) {
  // Peer-reported progress or outcome, NOT acceptance of the work.
  console.log(report.message.report.state, report.message.text);
}
```

This code does not wait on a new completion mode: Pi's normal incoming path delivers questions and actionable reports automatically. Progress-only records remain inspectable. The organizing package still decides what the work means and whether to accept or reassign it.

For first-contact handling, a caller with no native human confirmation UI receives `CONTACT_APPROVAL_REQUIRED` rather than gaining access. If A has approved B, later A↔B messages using either tool or the organizer API reuse that session-pair approval while its runtime remains loaded. B↔C needs separate consent.

## Trust and lifecycle

- **Trust boundary:** This interface is available to extensions installed in the same Pi runtime. It is **not** a safe boundary against malicious local extensions. Load only extensions you trust. The channel's event data cannot grant contact approval, transfer owner identity or override native tool permissions.
- **Human priority:** The same contact approvals, explicit revocations, Pause, editor drafts and ordinary session lifetime checks apply. A send may be rejected or have an uncertain result. Approval metadata is carried separately from peer-authored message fields.
- **Privacy:** `inspect` uses pi-comms' agent-facing visibility and never reveals unapproved message contents or return handles. A connected organizer has no privileged human-only inspection method.
- **Session scope:** This is one running Pi session. On reload, session replacement, switch, restart or extension shutdown, discover a new handle. Runtime records, consent and reply handles are memory-only; no automatic replay or restore is implied.
- **No transitive permission:** A↔B consent does not grant B↔C or permit a replacement session to impersonate B. Exact IDs remain binding.
- **No task system:** The caller owns rosters, work instructions, task completion and acceptance. A peer's `report.state` is the peer's claim, never authoritative acceptance.
- **F09 (0.1.8+) uses v1:** Authored handovers supply an earlier exchange link through the same `send` method. Recipients are explicitly chosen; no transfer of sessions, identities, approvals or task acceptance occurs.

The test suite includes a **separate organizing extension** loaded beside pi-comms in a real Pi 1.4.0 fixture. It requests the v1 interface, asks for first-contact consent on its first send, reuses approval on later sends, and reads a request-linked work report through both the integration and native inspection paths. That establishes the in-process contract; it is not a claim that another production organizing package has adopted the API.

## Independently installed agents sharing one broker (proposed support)

An independent PiG/Pi application can keep its private credentials, settings and
sessions in its own agent directory while joining the same-user local pi-comms
broker as other installed agents. Set **`PI_COMMS_BROKER_DIR`** to the same
absolute private directory in each participating launch environment. For example:

```sh
export PI_CODING_AGENT_DIR="$HOME/.pig-agent/reviewer/.pi"
export PI_COMMS_BROKER_DIR="$HOME/.pig-agent/shared-comms"
```

Another agent uses its **own** `PI_CODING_AGENT_DIR` but the **same**
`PI_COMMS_BROKER_DIR`. When the override is absent, the broker stays in
`<agent-dir>/comms` as before. This option chooses **transport location only**.
It does not share agent credentials, conversations, settings or memory.
Normal exact-session identities, contact approval, Pause and revocation still apply.
Use this only among processes belonging to the same trusted OS user; the
broker is not a remote or cross-user trust boundary.

The option does not launch agents, make an offline session available, or solve
M4 history recovery. Every agent must be running, or an external controller
must start/resume it, for its exact session to be reachable. Treat a newly
started session as a different contact subject to normal consent.
