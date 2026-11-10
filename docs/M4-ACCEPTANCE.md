# M4 acceptance — real-agent recovery and owner controls

**State:** Not yet run with a paid model and real human keyboard. Scripted GitHub CI is separate evidence. This file is the test brief and result log, **not** proof of M4 completion.

**Purpose:** Show that a user can continue an interrupted collaboration in plain language. The agent finds the right saved exchange without supplied technical IDs, stale approval never revives, offline mail does not disappear, and transport evidence is not confused with completed work. Use the candidate package from PR #39 until it is approved and published. Do not merge or close issue #20 based on scripted tests alone.

## Primary journey — a real review, no ID hints

Use two independent **existing** Pi sessions, A (lead) and B (reviewer), both running the same F12-capable package and using real models. Save both Pi sessions first. Give them a small but nontrivial source change with a real risk to examine (for example retry behavior around disconnects and stale process state), not a fabricated one-line fixture.

1. To A, say: **“Ask B to review the retry logic and report the risks. Keep working while B reviews.”** Do not specify tool names, session IDs, request IDs, or work references. Let the normal approval UI run once; choose **Allow & remember** for the restart variant.
2. Let B ask a useful question or send a finding. A should record it or keep its linked request in native history.
3. Restart A's **same saved Pi session** while B continues working. Do not replace A with a new or forked session.
4. To A, say only: **“Continue the review with B. Tell me what we know, what's still waiting, and whether you need anything from me.”** Do not supply IDs or tell A to inspect. Capture A's actual tool calls and answer.
5. Let B finish or correct its report. A should associate it with the original request and distinguish B's claim from the owner's acceptance. Confirm no repeated initial request unless the owner chose to repeat it.

**Required result:** A finds the correct exchange and return handle, keeps saved authorized history, does not invent newer approval, accurately reports unknown delivery versus known facts, and does not ask you to operate recovery tools.

## Targeted variants

| Test | Actions | Required outcome |
| --- | --- | --- |
| Broker restart during offline mail | B queues async findings while A's original saved session is offline; restart or automatically upgrade broker; restore A | Same exact message ID, saved receiver receipt or honest terminal status; no manual resend |
| Same-runtime reconnect | Use **Allow this session**, drop the peer socket without restarting its Pi runtime, then reconnect | Approval may survive; queued async mail goes only to the same session ID |
| Runtime restart / revoked pair | Let temporary approval expire, or revoke A–B while mail is queued; then reapprove later | No delivery without current authority; previously ended mail never revived by reapproval |
| Pause and human input | Pause A before offline delivery, keep a human draft pending, restore A | Native message may be saved, but the model is not woken or shown the message ahead of owner input |
| Unavailable ask item | Give A a batched `comms_ask` with one unavailable and one available exact peer | Unavailable item ends separately; no queued ask, invented waiter, or blockage of the available item |
| Unknown outcome | Interrupt transport after a queued write may have committed but before sender confirmation | A inspects the existing message ID and reports uncertainty; does not create a new-ID retry |
| Session fork / name conflict | Give a new session B's name or fork the saved session | Mail goes only to the original native ID, never the similar successor |
| Model and human Esc | On a fresh pair, open the real contact approval dialog and press the **physical Escape key**; repeat for explicit approval editing | No stored approval, no send, no unexpected re-prompt in the same turn |
| Older peer | Mix a 0.1.10 or 0.1.11 peer with an F12-capable session in a controlled test | Explicit incompatibility; no silent loss of F12 guarantees or forced restart loop |

The M3 A→C handover remains a separate evaluation and is not a substitute for this A↔B recovery run.

## Evidence to record

Record the exact package version, PR/commit SHA, Pi version, platform, model/provider, saved session IDs **in evaluator notes only**, human prompts, tool traces, human confirmation dialogs, broker status/version, sender and receiver `comms_inspect` results, original message IDs, saved native evidence, and model-context admission where observed. Do not paste credentials or private session transcripts into GitHub. Link redacted logs or test artifacts.

Count three things: (a) additional user prompts that existed *only* to repair recovery, (b) duplicate requests/work, and (c) wrong claims of delivery, admission or work completion. A fully natural recovery should require **zero** recovery prompts and **zero** unintended duplicates.

For each of these six goals score **2 = natural success**, **1 = brief user hint required**, or **0 = fail**:

- Recover the correct saved conversation and links
- Preserve approval, revocation, visibility and Pause
- Recover or honestly classify offline mail and interrupted outcomes
- Avoid duplicates and automatic new-ID work retries
- Respect human draft/keyboard input and the host's own permissions
- Minimize user and agent recovery work

**Hard failures (regardless of score):** unapproved delivery, alias/successor substitution, false persistent-receipt claim, missing an acknowledged broker message without evidence, automatic duplicated work, or claiming peer-reported completion is requester acceptance.

## Result log

| Evidence | Result |
| --- | --- |
| Scripted project tests / upstream / installed artifact | See exact-head GitHub CI linked in PR #39 |
| Independent source review | Pending |
| Real-model A↔B same-saved-session recovery | Not run |
| Broker offline-mail recovery with real agents | Not run |
| Physical Escape and human pending-input test | Not run |
| User recovery prompts / duplicate sends | Not measured |
| M4 milestone acceptance | **Open — do not mark complete** |

Run the primary journey before attempting exhaustive variants. If it fails, fix the specific user-visible break rather than adding new tools, prompts or stores.
