# Manual Pi ↔ PiG ↔ PiG qualification (issue #35)

**Status:** Execution recipe and evidence ledger, not a claim of live acceptance.
Use the exact build identities in the PR's evidence, not just the package version.
The terminal approval and a natural-language model exchange require an operator
with three live terminals and working model accounts.

## Pin and release order

- **pi-comms baseline:** `0.1.12` merge `19d668f0153a81dbb85dd11940271f9fda387182` includes **F10 session continuity, F11 unordered A–B contact approval, and F12 bounded durable offline mail**. The new shared-broker branch stages **0.2.0** on top of these completed changes. Pin its reviewed PR head, **not** old PR #34's `39ad5a78` candidate.
- **PiG-Agent shell:** [PR #2](https://github.com/tranhoangnguyen03/PiG-Agent/pull/2) merged into [PR #1](https://github.com/tranhoangnguyen03/PiG-Agent/pull/1)'s still-open feature branch, **not main**. PiG **0.5.3**, Node **24.15.0**. Its previous Comms pin is stale; rebuild and qualify the *same* candidate committed to this PR.
- Native Pi test host: `@earendil-works/pi-coding-agent@1.4.0` on Linux Node 22.19.0/24 and macOS Node 24. Record actual installed versions and model/providers in the real TUI.
- Compatible peer versions must match the new F12 contract: remembered approval can survive reload; session-only approval ends on Pi runtime or broker restart; `comms_message` supports eligible exact offline async mail while `comms_ask` remains live-only.

## Preparation (macOS / Linux)

Use a clean throwaway test root. Paths must be **absolute**. Do not copy the
owner's main Pi home into either specialist.

```sh
export LAB="$(mktemp -d)"
export PI_COMMS_BROKER_DIR="$LAB/shared broker"
mkdir -p "$LAB/main/.pi" "$LAB/main/sessions" "$LAB/agent-a" "$LAB/agent-b"
# Build or install one pinned pi-comms package in a separate checkout.
# Run in that checked-out revision:
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
# Record: git rev-parse HEAD; shasum -a 256 pi-comms-*.tgz
```

Give native main Pi its own agent dir. Load the **built** Comms package through
Pi's normal package installation, or pass its checked-out *package directory*
via `-e`. Make sure the package that Pi loaded matches the source pin:

```sh
PI_CODING_AGENT_DIR="$LAB/main/.pi" \
PI_COMMS_BROKER_DIR="$PI_COMMS_BROKER_DIR" \
  pi --session-dir "$LAB/main/sessions" -e /ABSOLUTE/PATH/TO/BUILT/pi-comms
```

Separately build the PiG-Agent PR #1 feature branch with `shell/source-lock.json` changed to
the **same Comms commit**, retaining all other exact pins. Install two distinct
copies of that built shell; one shell may be a different role and model:

```sh
/ABSOLUTE/BUILT/bundle/shell-reference install --home "$LAB/agent-a"
/ABSOLUTE/BUILT/bundle/shell-reference install --home "$LAB/agent-b"

PI_COMMS_BROKER_DIR="$PI_COMMS_BROKER_DIR" \
  "$LAB/agent-a/bin/shell-reference" new
# in another terminal:
PI_COMMS_BROKER_DIR="$PI_COMMS_BROKER_DIR" \
  "$LAB/agent-b/bin/shell-reference" new
```

In each TUI, sign in to a working model if needed. Check the actual Comms
version, session ID, broker endpoint, shell build ID and provider through
`/comms status`, `comms_peers`, shell `info`, and the package manifest.
The **actual native session UUID** is the address: never invent or reuse a
display name as a substitute. Record the two PiG installations' distinct
private `PI_CODING_AGENT_DIR` values; credentials and transcripts must
remain only in the respective private homes.

## Assignment → question → answer → report

1. Leave all three hosts open. In main Pi, call `comms_peers` and record
   the exact running session ID for agent A. If both specialists share a name,
   confirm both IDs appear and the name-only send is rejected as ambiguous.
2. Ask main Pi to send a substantive read-only review through
   `comms_message({to:"<A native UUID>",subject:"Retry review",
   text:"Inspect the test case, ask if needed, and report concrete findings.",
   workRef:"PIG-COMMS-35"})`.
   **Approve in the real TUI dialog.** The original tool call must finish
   without retyping the task. Record one human confirmation, the outgoing
   `message.id` and `exchange`. Do not preapprove in code.
3. In agent A, verify the incoming text, source ID, original request ID and
   `returnHandle` via the actual `comms_inspect({message:"<request ID>"})`
   result. Have A ask a material clarification via
   `comms_message({respondTo:"<actual returnHandle>",
   text:"Clarify whether write retries are permitted.",
   report:{request:"<original request ID>",state:"needs-input"}})`.
   Main Pi should receive it with **no second approval**.
4. Main Pi inspects the clarification, obtains its *new* return handle and
   replies `comms_message({respondTo:"<clarification returnHandle>",
   text:"Retry reads only; no write retries."})`.
   A resumes the same work, sends its findings using the latest return handle
   with `report:{request:"<original request ID>",state:"complete"}`.
   Main Pi calls `comms_inspect({requests:["<original request ID>"]})`
   and checks the exact report/request and work reference links.
   A peer's complete report is **not** automatic requester acceptance.
5. Send one **new substantive message** from each direction: neither should
   ask again for this exact pair. Contacting B must still require an
   independent decision. Use `comms_ask` on one direction: it returns
   the **first linked reply**, even when that reply merely requests input.
   Check `comms_inspect` for the eventual report after that early result.
6. Repeat steps 1–5 with **agent A ↔ agent B**. Use distinct models or provider
   accounts when available. Do not copy credentials or session files.

## Negative paths and lifecycle

- **First No/Esc:** try a new exact pair. Refuse in native TUI. The same send
  must not go through; an ordinary retry must not grant approval.
  Operator `/comms approve <exact ID>` may later make a deliberate change.
  Distinguish refusal from Stop or abort (which cancels this attempt).
- **Pause/Resume:** with A actively waiting or working, `/comms pause`
  before a new incoming message, then `/comms resume`. Observe queue,
  model wake, and whether the active task continues. With text in A's editor,
  confirm inbound does not overwrite or interrupt the pending human input.
- **Revoke:** `/comms revoke <exact ID>`. Verify no new message is shown to
  the agent until explicit reapproval; previously authorized history remains
  inspectable in the same saved Pi session. A third session's approval is unaffected.
- **Stop:** interrupt a current model run. Later approved incoming traffic
  may wake the host unless paused. Stop must not quietly create a refusal.
- **Fresh / resume / reload / exit:** log active IDs, prompt count, incoming
  history, return handles and status before/after each boundary. A new
  session gets a new UUID and no old contact authorization. A saved-session
  exact resume can restore **F10 records** from native Pi session entries.
  Fresh, never-saved and `--no-session` records may be volatile. `Allow this session` ends on either Pi runtime or broker restart; `Allow & remember` persists until explicit revoke. Pause and prior authorized history recover from the original Pi session. Do not revive a prior local `comms_ask` waiter or treat a peer report as model execution proof.
- **Broker restart:** stop the owned broker via its recorded `broker.pid`,
  then restart the exact running Pi sessions as needed. Verify reconnect
  and no silent retarget to an agent with the same name but different UUID.
  F12 broker-persisted eligible exact-ID offline mail survives broker restart under current approval and expiry. Earlier pre-F12 RAM-only mail cannot be rescued retroactively. Never blindly repeat an unknown send.
- **RPC/headless:** attempt an unapproved first send. Expect
  `CONTACT_APPROVAL_REQUIRED` if no supported human-dialog bridge exists.
  If the RPC host genuinely forwards Pi's UI confirmation to a person, record
  the UI request/response and the original send's continuation. Never
  return synthetic approval.

**Physical human control:** Test actual Escape and owner approval dialogs in the installed Pi/PiG TUIs; scripted broker pair decisions do not substitute for this evidence. Verify session-only approval across a *socket drop* separately from a full runtime/broker restart.

## Evidence ledger

| Journey / check | Result | Evidence required |
| --- | --- | --- |
| Broker path under separate homes | Existing path tests | Source/path selection only; not runtime connection |
| Real broker startup, listen, exact routing, duplicate names | New process test; **verify CI result** | Broker PID, endpoint IDs, client send/receipt |
| Default homes without override | New process test; **verify CI result** | Distinct broker PIDs / rosters |
| Incompatible live Unix broker | New process test; **verify CI result** | Rejection text; original socket remains live |
| Installed-package shared broker | Installed package test; **verify CI result** | Installed broker code from npm tarball |
| Native main Pi → PiG natural-language cycle | **NOT RUN** | Three live terminal/model records, real TUI approval |
| PiG A ↔ PiG B, different accounts | **NOT RUN** | Two private installed homes, full linked exchange |
| First refusal, pause/revoke, human draft and Stop | **NOT RUN** in PiG TUI | Human/agent views and exact state changes |
| Exact resume, reload, exit, broker restart | **NOT RUN** in installed PiG | F10 saved history, F11 current/remembered consent, F12 queued/recorded/expired evidence |
| RPC first contact | **NOT RUN** in installed PiG | Actual UI forwarding or approval-required code |
| Windows shared broker | **NOT RUN** | No platform acceptance claim |

The code tests use synthetic protocol clients or Pi 1.4.0 native fixtures.
Only the actual TUI operator/model run can close the remaining live-agent
acceptance items. Always record **PASS / FAIL / NOT RUN**, tested OS, commit,
package tarball SHA256, Pi/PiG/Node versions, model or provider, first-contact
dialog count, original request ID, reply handle, peer-reported state, and
actual human and agent-visible results.
