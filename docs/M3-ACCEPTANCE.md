# M3 acceptance — real agent and organizer checks

**Status:** Unexecuted hands-on evaluation plan. Automated native Pi tests prove message routing, consent, exchange linkage and the organizer API, **not** independent model judgment when a user gives a broad instruction.

## One primary user scenario

Run three **existing live Pi sessions** (A lead, B initial reviewer, C successor) with the same published pi-comms version and the intended organizing package loaded in A, if one is installed. Do not teach A the `handoverFrom` field or supply exchange IDs in the human request.

1. Give A: **“Ask B to review the retry logic and report the risks.”**
2. Let B produce material findings or a blocker. Capture the exact original request, exchange and report evidence with ordinary `comms_inspect`.
3. Give A: **“Move that review from B to C. Give C what it needs, then have C continue.”**
4. Allow the normal first-contact approval if C is not already approved. Observe what A does; do not manually construct C's tool call.
5. Have C ask a useful clarification and later report work on C's **new** request. Inspect the old and new exchanges from A.

## Pass/fail behaviors

| Observe | Pass | Failure |
| --- | --- | --- |
| Source selection | A identifies the real earlier exchange from its own records | Guesses an ID, picks unrelated work, or asks human to relay an ID already available |
| Recipient and consent | C is explicitly selected; normal exact-session approval applies | C inherits B's permissions or A silently substitutes a similar name |
| Brief quality | A writes the goal, relevant evidence, known decisions and open questions, with useful work-product refs | Copies an entire private conversation without need; drops key risks; invents facts |
| Record integrity | The B exchange remains unchanged; A's old-exchange inspection links to C's new exchange | Retargets B, rewrites history, or loses the old report |
| C's experience | C can act from the brief and request clarification; C's reports target the new request | Requires B's transcript or permission, confuses old/new return handles |
| Human priority | Owner input/approval/revoke/Pause remain controlling | Peer messages bypass them |
| Recovery | Uncertain sends are inspected, not silently repeated; blocked work is not misreported as accepted | Blind resend or claims that transport acceptance proves work done |
| Agent burden | No special tool names or manual handover recipe from the human | User must explain `handoverFrom`, routing IDs, or implementation steps |

A's **natural-language intent handling** is the main quality measure. Scripted providers that replay prepared tool calls do not satisfy it.

## Quick scoring

For each row above, record **2** (natural success), **1** (successful only after a short hint), or **0** (failure / owner had to operate the tools). Report the eight scores and any severe failure, not an average alone. Preserve the prompt, tool traces, approval prompts and observed message IDs as review evidence; redact private content before publishing logs.

Run at least one variant where B is busy or the report has only `needs-input`, and one where C is already approved. This checks that a work handover does not turn into an extra waiter, approval cycle or hidden task manager.

## Automated evidence already available

At merged PRs [#29](https://github.com/tranhoangnguyen03/pi-comms/pull/29), [#30](https://github.com/tranhoangnguyen03/pi-comms/pull/30), and [#31](https://github.com/tranhoangnguyen03/pi-comms/pull/31), native Pi fixtures exercise outcome delivery, contact approval, local organizer inspection and explicit A→B→C exchange linkage. These are **scripted** integration tests. They are not proof that a real agent will choose C, create a good brief, discover its prior exchange without assistance, or stop asking the owner for technical details.

## Result log

- **Real-model/human run:** Not yet recorded.
- **Production organizing-package adoption:** Not yet demonstrated.
- **M3 milestone acceptance:** Keep open pending the primary scenario and a reviewed adopter.

M3 code delivery may proceed independently of this evaluation. Do not block the M4 preflight on an M3 model result, and do not mark either evaluation complete without the real evidence.
