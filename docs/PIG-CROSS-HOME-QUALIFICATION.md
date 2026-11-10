# Pi ↔ PiG ↔ PiG cross-home qualification (issue #35)

**Status:** reproducible test plan and evidence record, not completed real-user acceptance. The shared broker feature is staged for **pi-comms 0.2.0**, based on the fully merged M4 `0.1.12` code. Do not reuse the older PR #34's F10-only assumptions. This guide uses normal pi-comms tools and user controls; no agent manager, extra broker, extra approval store or automatic privilege.

## Tested source baseline and pin policy

- Native Pi fixture: `@earendil-works/pi-coding-agent@1.4.0`, Node 22.19.0/24 (Linux) and Node 24 (macOS) in Comms CI.
- PiG reusable shell: `PiG-Agent` branch `docs/agent-catalogue-foundation`, **PiG 0.5.3**, bundled **Node 24.15.0**. Shell PR #2 merged **into that branch**, not `main`. Its current Comms source lock still references obsolete shared-broker candidate `39ad5a7` (`0.2.0` before M4 F11/F12); **repin to this new branch's exact reviewed head before building**.
- Broker source: this PR's exact tested commit and packed broker must match each agent's extension version. A successful test of an old shell does not qualify its new source pins.
- Real human/model acceptance remains **NOT RUN** until actual TUI sessions and provider access are used. No fake approval events are acceptable.

## Environment

Every agent has its own `PI_CODING_AGENT_DIR` and Pi session files, model selection, credentials, and extension settings. They join the same-user broker using one **identical absolute** `PI_COMMS_BROKER_DIR`, a path used only for broker address/lock/mail/approvals. With no override, Comms still uses `<PI_CODING_AGENT_DIR>/comms`.

```sh
LAB="$(mktemp -d)"
mkdir -p "$LAB/main/.pi" "$LAB/main/sessions" "$LAB/pig-a" "$LAB/pig-b"
export PI_COMMS_BROKER_DIR="$LAB/shared-broker"
# Build pi-comms at the precise commit from this PR:
npm ci --ignore-scripts && npm run verify
npm pack --ignore-scripts
# Record: git rev-parse HEAD; shasum -a 256 pi-comms-0.2.0.tgz
```

Install the same built version into native Pi, and pin the PiG shell's `shell/source-lock.json` Comms commit to that exact head. Rebuild two complete PiG shells from the updated lock. Do not point the shell at the main user's Pi home, and do not copy session files or secrets between homes.

Start native main Pi in one terminal:

```sh
PI_CODING_AGENT_DIR="$LAB/main/.pi" PI_COMMS_BROKER_DIR="$PI_COMMS_BROKER_DIR" \
  pi --session-dir "$LAB/main/sessions" -e /ABSOLUTE/PATH/TO/pi-comms
```

Start installed PiG shell **A** and **B** with distinct private `--home` installations, but with the same `PI_COMMS_BROKER_DIR`. Example shell invocations after installing the PiG reference app:

```sh
PI_COMMS_BROKER_DIR="$PI_COMMS_BROKER_DIR" "$LAB/pig-a/bin/shell-reference" new
PI_COMMS_BROKER_DIR="$PI_COMMS_BROKER_DIR" "$LAB/pig-b/bin/shell-reference" new
```

Run each shell's `info`/`doctor`; in the Pi TUI use `/comms status` and `comms_peers`. Record actual package and broker versions, model/provider, private agent paths, broker PID and **exact native session IDs**. Two agents may use different models/accounts and matching display names; names do not replace exact identity or create trust.

## Human and model test — main Pi to PiG and PiG to PiG

1. Start with three independent **running** sessions. Give main Pi a meaningful read-only retry-code review; ask it to delegate to PiG A. Do **not** give it an ID unless natural discovery cannot select a unique named peer. If A and B have the same display name, require exact-ID selection rather than guessing.
2. Approve **one exact unordered A–B pair** in the genuine owner dialog. The **original send continues** after approval; do not retype the request. Record one decision, outgoing message ID and exchange. An unapproved third session gets no transitive grant.
3. In specialist A, inspect the received request and saved `returnHandle`. Send a linked clarification using `respondTo`. Main Pi replies using the new return handle; specialist sends a final `report: {request:<original ID>, state:"complete"}`. Main Pi should show it as a *peer report*, not requester acceptance. Check work reference, exchange, links and no repeated approvals.
4. Repeat A ↔ B using their own private PiG homes. Test both directions, `comms_message`, one `comms_ask` whose first reply is a clarification, `comms_inspect` and any useful structured output. No additional work-manager or per-message handshake.
5. Repeat targeted human constraints: first No/Esc, Pause/Resume, revoke, pending human draft, busy recipient, Stop then new incoming mail. An ordinary socket drop of the same runtime keeps session-only consent; restarting Pi/broker expires it. Remembered consent survives both original saved sessions and broker restarts.
6. Close A's **saved session** while B sends exact async mail; restart the broker, then resume A's same saved session. Under M4, the broker saves eligible offline payloads before acknowledging `queued`; only a native disk receipt proves `receiver_recorded`. No alias substitution, duplicate work or new-ID auto-resend. `comms_ask` remains live-only.
7. In RPC/headless mode, if human approval cannot be forwarded to a real person, return a clear approval-required outcome. Do not invent owner consent.

## Verification ledger

| Journey | Current evidence |
| --- | --- |
| Path selection: default vs absolute shared broker | Pending latest exact-head CI |
| Three real OS processes/private homes: one broker, same-name ambiguity, request→clarification→answer→finding, F11 pair approval | Pending latest exact-head CI |
| Incompatible live Unix socket with missing PID remains intact | Pending latest exact-head CI |
| Packed `0.2.0` broker run through installed-package suite | Pending latest exact-head CI |
| Native Pi's existing F10/F11/F12 regression suites retained | Pending latest exact-head CI |
| Native main Pi ↔ PiG genuine model exchange and real approval | **NOT RUN** |
| PiG A ↔ PiG B genuine model exchange and real approval | **NOT RUN** |
| Physical Esc/No, Pause/revoke/human drafts, Stop, resume and mixed-version runtime | **NOT RUN** in PiG TUI |
| RPC forwarding or refusal without synthetic consent | **NOT RUN** in PiG |
| Windows and macOS Intel interactive qualification | **NOT RUN** |

**Pass/fail rule:** A broker process test proves routing only. Full #35 requires a real assignment, clarification, answer and final report across separate installed hosts, normal one-time human consent, Pause/revoke and truthful saved-session recovery. Preserve redacted prompts, tool traces, peer/message IDs, package commits and installed artifact SHA256 for the final review. Do not claim tests performed elsewhere.
