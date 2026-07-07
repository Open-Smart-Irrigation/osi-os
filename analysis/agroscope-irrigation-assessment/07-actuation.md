# Piece 7 — Actuation (STREGA / Milesight Valve Control)

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Scope: `actuators.py:352-828` (`Strega`, `Milesight_UC51X`) and `mqtt.py` (`MQTTWrapper`,
`UC51XCodec`) — two unrelated valve-driver families that do not share a runtime, of which only one
is live.

**Two disconnected drivers.** `Strega` (`actuators.py:352-822`) is a self-contained, blocking
request/response driver over Swisscom Thingpark JSON. It is imported (`main.py:37`) but never
constructed and none of its methods are called anywhere in `main.py`. It also depends on
`mqtt_client.ack_event` / `.msg_decoded` / `.topic`, but the live `MQTTWrapper`
(`mqtt.py:14-84`) defines only `.timezone` — wiring Strega to today's client would raise
`AttributeError` immediately. Strega was written against an older/different MQTT client and its
blocking-ACK model is not reachable in the current system; it is dead/reference code.
`Milesight_UC51X` (`actuators.py:825-828`) is a bare stub (`__init__` does `pass`). The real
Milesight logic lives in the free-standing `UC51XCodec` (`mqtt.py:87-145`), a pure fire-and-forget
hex encoder, and that is what `main.py:734` actually calls — though the publish itself is
commented out (`main.py:752-753`, see `05-run-loop-pid-orchestration.md` Section 1).

**Strega protocol.** Downlink envelope is `{"DevEUI_downlink": {Time, DevEUI, FPort,
payload_hex}}`, published to `topic.replace('#','downlink')`, with `DevEUI =
topic.split('/')[2]` (`:437,480,513,573,604,653`). Three valve-open shapes:
`set_valvestatus` (FPort 1, `"31"`/`"30"` open/close, fire-and-forget; docstring says not for
production — actuates only on the next uplink, no duration, stays open until a separate close
succeeds); `set_timecontrolvalvestatus` (FPort 2, scale-nibble 8/4/2 for hours/min/sec + status +
hex value — open-for-duration, device auto-closes: the fail-safe primitive); `set_schedule` (FPort
`week_day+14`, 24-byte `0xFF` frame, up to 4 windows/day). Support commands: `set_time` (two-phase
FPort 13 then 12 RTC), `set_uplinkfrequency` (FPort 11), `set_scheduleinhibition` (FPort 21),
`set_sf` (FPort 10). Every method cites the device manual page (66/69/72/74/81/89).

**Milesight/UC51X protocol.** One command shape: `build_valve_status_hex` (`mqtt.py:87`) emits
`ff1d` + control byte + a 1-byte sequence number + an optional 3-byte little-endian duration; the
control byte bit-packs `time_control | flow_control | action | reserved2 | valve_target3`
(`:109-110`). Open-for-duration and immediate open/close are the *same* command — setting
`time_sec > 0` sets the time-control bit plus the LE duration. `build_downlink_payload` wraps this
in the same `DevEUI_downlink` envelope with FPort 85 but takes `dev_eui` explicitly (no
topic-parsing). `main.py:734` calls it with `time_sec=0` (immediate) plus a `sequence_number`.

**Concurrency.** Strega's `wait_for_ack` (`actuators.py:791-822`) blocks on
`threading.Event.wait(timeout)`, default `60*15*1.2 = 1080s` (18 min; docstring says 15);
`set_time` chains two waits (~36 min blocking in one call), parking the calling thread with no
async/offload/queue. The shared single `ack_event`/`msg_decoded` ACK channel is not
concurrency-safe: overlapping commands race, one command's uplink can satisfy another's wait, and
`msg_decoded=None` can null-dereference at `:807`. Timeout semantics are unreliable —
`set_uplinkfrequency` prints "Timeout... doesn't mean the command was not received" (`:582`) — so
a `-1` return conflates "failed" with "unknown." `UC51XCodec` is the opposite: it never waits;
confirmation is delegated to `main.py`'s pending-command/telemetry state machine, the correct
design for a ~15-minute uplink-latency channel.

**Robustness.** Strega has no idempotency/sequence numbers (a re-sent open/close is
indistinguishable) and no retries. `UC51XCodec` carries a 1-byte `sequence_number`
(`mqtt.py:111`, sourced from `main.py:732`) — the correct dedup primitive (wraps at 256).
`topic.split('/')[2]` is brittle (assumes DevEUI is the 3rd path segment); `UC51XCodec` avoids it
via an explicit `dev_eui` parameter. `set_time` writes local wall-clock (Europe/Zurich,
DST-shifting) to the device RTC, not UTC. ACK-matching checks `ackPort==fport` plus an expected
`ackValue` where present, but `set_valvestatus` (immediate open/close) and `set_schedule` do *not*
confirm at all — they return `0` unconditionally — so the two most safety-relevant Strega commands
report success with no device ack. Unsafe-state risk: `set_valvestatus(True)` opens with no
duration and no guaranteed close, so a lost close leaves the valve open indefinitely (flooding
risk); `set_timecontrolvalvestatus` (device self-closes) is the production-safe open;
`set_scheduleinhibition` without reactivation leaves the valve non-responsive. Validation uses bare
`raise Exception`, unable to distinguish validation failure from transport failure.
`set_timecontrolvalvestatus` encodes its value as `hex(value)[2:]`, not BCD — a hex-vs-BCD
ambiguity that is spec-critical and must be checked against the datasheet before reuse.

**Code quality.** Strega is `print()`-based (~25 calls), no logging, with maturity tags
("Not tested" / "Tested and working") that are self-reported with no test file backing them, and
heavy duplication (envelope+publish+ACK block copy-pasted across 6 methods, no shared `_send`
helper). Magic hex is built via string concatenation, `hex()[2:]` slicing, and manual `'0'+x`
padding — error-prone. `mqtt.py` uses proper logging; `UC51XCodec` is static, pure, and
dependency-free, making it trivially unit-testable — the largest quality delta between the two
families. Dead code shipped alongside the live path: the `Milesight_UC51X` stub and the unused
`Strega` import.

## 2. Strengths

- **`UC51XCodec` is genuinely production-worthy** (`mqtt.py:87-145`). Pure, static, explicit
  `dev_eui` (no topic-parsing), sequence-numbered for dedup, a single unified command for
  open/close/duration, clean bit-packing, and a correct separation of encoding, transport, and
  confirmation.
- **Strega's protocol coverage is thorough and manual-cited.** Every method references the device
  manual page (66/69/72/74/81/89) — a valuable 1:1 protocol reference independent of the dead
  runtime around it.
- **`set_timecontrolvalvestatus` is fail-safe-by-design.** The device auto-closes after the
  encoded duration — the correct primitive for unattended irrigation.
- **Reasonable input validation and ACK matching** on the commands that do confirm (port + value).
- **`MQTTWrapper` checks the publish return code** (`mqtt.py:82`) and guards callback exceptions.

## 3. Weaknesses & risks (ranked)

1. **Strega is dead, unreachable code.** Imported but never constructed
   (`actuators.py:352-822`, `main.py:37`); depends on `mqtt_client` attributes the live
   `MQTTWrapper` does not define, so wiring it up would `AttributeError` immediately. It was
   written against an older/different MQTT client and cannot run as-is.
2. **Safety-critical commands report success with no device confirmation.**
   `set_valvestatus` (immediate open/close, no duration) and `set_schedule` both return `0`
   unconditionally with no ACK check. A lost close after `set_valvestatus(True)` leaves the valve
   open indefinitely (flooding risk); `set_scheduleinhibition` without reactivation leaves the
   valve non-responsive.
3. **Blocking ACK model, ~18-36 minutes per call.** `wait_for_ack` (`actuators.py:791-822`)
   parks the calling thread for up to 1080s (18 min), and `set_time` chains two such waits
   (~36 min). No async/offload/queue exists — this would stall a scheduler or pipeline thread, or
   hold an HTTP request open, if ever wired up.
4. **Concurrency-unsafe shared ACK state.** A single `ack_event`/`msg_decoded` channel means
   overlapping commands race; one command's uplink can satisfy another's wait; `msg_decoded=None`
   can null-dereference at `:807`. No per-command correlation ID beyond `ackPort`.
5. **Timeout is ambiguous, not a failure signal.** `set_uplinkfrequency`'s own docstring notes a
   timeout "doesn't mean the command was not received" (`:582`), yet the method returns `-1`,
   conflating "failed" with "unknown."
6. **RTC set via local wall-clock, not UTC.** `set_time` writes Europe/Zurich local time
   (DST-shifting) to the device clock instead of UTC.
7. **Hex-vs-BCD encoding ambiguity.** `set_timecontrolvalvestatus` encodes its value via
   `hex(value)[2:]`; this must be verified against the datasheet before any reuse — a wrong
   encoding could silently mis-set a duration.
8. **Brittle DevEUI parsing.** `topic.split('/')[2]` assumes a fixed topic shape with no
   validation.
9. **No idempotency/sequence numbers on Strega commands**, unlike `UC51XCodec`'s sequence byte —
   a re-sent open/close is indistinguishable from a fresh one.
10. **Print-based, untested, duplicated.** ~25 `print()` calls with no logging; maturity claimed
    only in self-reported docstrings with no test file; the envelope+publish+ACK block is
    copy-pasted across 6 methods with no shared `_send` helper.
11. **Dead code shipped.** The `Milesight_UC51X` stub and the unused `Strega` import add surface
    area with no runtime value.

## 4. Integration challenges (OSI)

- **[P7] Actuation barely ports.** OSI already has a mature STREGA LoRaWAN valve integration on
  the edge using exactly the fail-safe `OPEN_FOR_DURATION` pattern (OSI policy: STREGA uses
  `OPEN_FOR_DURATION` only, never a bare CLOSE) plus async confirmation via OSI's
  pending-commands + command-ack sync infrastructure. That already satisfies the minimal command
  contract this review derives from the two Agroscope drivers (open-for-duration,
  idempotent close, async `confirm_state`, sequence/idempotency key, explicit
  unknown-on-timeout). OSI is ahead of Agroscope here — Agroscope's live actuation is a
  commented-out stub, and its Strega class is dead.
- **[P7] Different hardware — no code reuse.** Agroscope's live valves are Milesight UC51X
  (`UC51XCodec`); OSI uses STREGA. OSI does not reuse Agroscope's actuation code at all; it
  reuses its own STREGA path. The Agroscope `Strega` class is useful to OSI only as a protocol
  reference if OSI ever needs raw STREGA payload details — and OSI already speaks STREGA.
- **[P7] The only new actuation-adjacent work is the mm-to-duration conversion** (belongs to
  Piece 5's output-stage gap): `dose_mm x area/emitter geometry / dripper flow-rate ->
  open-duration seconds -> OSI's existing STREGA OPEN_FOR_DURATION`. OSI's zone model already
  carries dripper capacity and emitter spacing, so this is a bounded, net-new design task, not a
  port.

## 5. OSI v6 improvement ideas

- **[P7] Actuation is not v6's concern** — v6 is analytics/recommendation, so the improvement
  surface here is minimal. The main value is validation: confirm OSI's existing actuation design
  (fail-safe open-for-duration + async confirm + explicit unknown-on-timeout + sequence/idempotency
  key) is sound, since it already matches the contract this review derives from Agroscope's two
  driver families.
- **[P7] Close the one real gap if present.** Ensure OSI's command layer always surfaces an
  explicit `unknown` state on ack timeout rather than assuming success or failure — the discipline
  Agroscope's Strega violates (`set_valvestatus`/`set_schedule` return success with no ack; timeout
  returns `-1` ambiguously) and that `UC51XCodec` + `main.py`'s async model gets right.

## 6. Re-implementation complexity

**Rating: MEDIUM** in the abstract (small, pure codec surface once payloads are known) —
**effectively LOW for OSI specifically**, since OSI's STREGA path already exists and this piece
introduces no new driver to port.

Hard parts, if ever needed: (1) reproducing device payload formats exactly — Strega's bit/byte
packing and UC51X's control-byte/LE-duration scheme — validated against the vendor manual and
hardware, including resolving the hex-vs-BCD trap before trusting `set_timecontrolvalvestatus`;
(2) the confirmation/latency model — replacing any blocking `wait_for_ack` with async,
sequence-correlated, per-command confirmation over a ~15-minute-latency channel, with
open-for-duration as the fail-safe default and a correct open/closed/unknown state machine. OSI has
already solved (2) for STREGA; (1) only matters if OSI ever needs to speak raw Strega or adds
Milesight hardware. The production-worthy artifacts to note for any future driver work are
`UC51XCodec`/`MQTTWrapper`; Strega is a documented protocol reference but untested-in-integration,
print-driven, concurrency-unsafe dead code whose blocking-ACK model should not be reproduced.
