# STREGA valves

Part of the osi-agronomy-sensors-reference skill; read SKILL.md first.

## STREGA valve semantics

**`OPEN_FOR_DURATION` is the only normal-operation command.** The valve
firmware closes itself when the commanded duration elapses; there is no
paired "open" + "close" command pair in normal use, and a bare `CLOSE`
command must never be sent during normal operation or testing/debugging —
the valve is designed to self-close, and sending an unexpected CLOSE is not
a supported operational pattern. If you need to end an irrigation early,
that's a cancel, not a close (next paragraph).

**Operator cancel:** `POST /api/v1/valves/:deveui/cancel` and the local
alias `POST /api/valve/:deveui/cancel` both feed `cancel-strega-actuation-fn`
in `flows.json`, which calls `cancelActuation` and `cancelHttpResponse` in
`osi-valve-control/cancel.js` with the ChirpStack transport. Cancel tries to
stop an open that has not started running; it never closes a valve that is
already open. The outcome below says whether the cancel proved that the open
was stopped.

The target must be an active `valve_actuation_expectations` row
(`PENDING_OBSERVATION` or `OBSERVED_RUNNING`) with a positive
`commanded_duration_seconds` that is not a report-only row. A body
`expectation_id` names it: an unknown id answers 404 `no_active_actuation`,
and a known row that is not such a target answers 409
`actuation_not_active`. Without an id exactly one candidate may exist: none
answers 404 `no_active_actuation`, two or more answer 409
`ambiguous_actuation`. The route never picks the newest row.

The outcome follows the target's transport evidence:

- `cancelled` (200): the open provably never reached ChirpStack (a local
  reservation, or an enqueue that failed or was rejected before acceptance).
  Nothing is flushed. The row becomes `CANCELLED`, and `devices.target_state`
  becomes `CLOSED` only when no other actuation on the valve is still active.
  The reply's `confirmation` field still reads `queue_flushed`; its
  `queue_scope` is `not_queued`.
- `already_running` (409, error `actuation_handed_off`): the row is
  `OBSERVED_RUNNING`, so there is no pending command and nothing is flushed.
- `handed_off` (409): the open may have been sent. A completed whole-queue
  flush ends here, as does a lost enqueue answer or a flush an earlier cancel
  already completed, because a pre-flush queue read cannot prove the open
  undelivered.
- `uncertain` (503, `transport_uncertain`): the flush failed or its outcome
  is unknown.

For every outcome except `cancelled` the cancel does not mark the row
`CANCELLED` and does not change `devices.target_state`; the expectation keeps
being observed. A completed whole-queue flush can also remove other queued
work on the valve, and the cancel does not queue that work again. The reply's
`collateral` lists the other owners recorded in the flush intent, each with
`in_queue` from the queue snapshot read before the flush: true when the
snapshot still held that owner's item unsent, false when it did not, null when
the owner had no queue id or no array snapshot was available. The read and the
flush are separate calls, so this is snapshot evidence, not confirmation that
an item was deleted or never delivered, and a failed or unknown flush can
return it too. This paragraph covers the REST route only; the unclaim path
(`cancelForUnclaim`) and other callers have their own rules.

**Expectation lifecycle:** `valve_actuation_expectations` (verified schema,
`database/seed-blank.sql`) records `commanded_at`, `commanded_duration_seconds`,
`expected_close_at`, `observed_open_at`/`observed_close_at`,
`reconciliation_state` (default `'PENDING_OBSERVATION'`, active states are
`PENDING_OBSERVATION` and `OBSERVED_RUNNING`), `cancel_reason`, and an
optional `estimated_gross_liters` with its `volume_source`. The
reconciliation monitor reads live STREGA state from `devices.current_state`
and last-uplink time from `device_data.recorded_at` ("STREGA timed irrigation"
in the edge catalog above).

**Estimated vs measured volume — kept separate:** `zone_irrigation_calibration`
stores a per-zone `measured_flow_rate_lpm` (from a real flow-meter
measurement) used only to *estimate* `valve_actuation_expectations.estimated_gross_liters`
for a given commanded duration. `zone_daily_environment.flow_liters` is
reserved for actually-measured flow-meter data — the two must never be
merged into one column, so a farm without a flow meter never gets a
volume number that looks measured but isn't.

### STREGA on-valve scheduler

Separate from `OPEN_FOR_DURATION` above: STREGA valves also carry their own
weekly scheduler in firmware, which the gateway compiles and pushes
(`osi-valve-control`, spec
`docs/superpowers/specs/2026-08-19-valve-control-design.md`). FPorts:

- **14–20** — Gen1 weekday plans, one FPort per weekday (`14 + weekday`,
  `weekday` 0=Sunday…6=Saturday); each downlink carries that weekday's whole
  window list, up to 4 on/off pairs.
- **25** — Gen2 day-mask plan: one payload can target several weekdays that
  share the same window list.
- **21** — scheduler status: resume, skip-today, pause, or (never sent by
  this gateway except a documented Gen2 fallback) delete-all.
- **12** — clock set (Gen1): local wall-clock digits in the schedule's
  timezone.
- **13** — clock request (Gen2): triggers ChirpStack's `DeviceTimeReq`.

Every weekday is capped at 4 windows; a push that would exceed that is
refused before it is queued. **The valve never reports its on-board
scheduler back over LoRaWAN** — there is no read-back FPort — so the gateway
cannot reconcile drift by asking the valve what it currently holds; it can
only re-push. This is also why a Bluetooth edit made directly on an SV2 is
invisible to the gateway until the next gateway-initiated push. Vendor
encoder/decoder references for both generations are vendored at
`docs/hardware/strega-codecs/`.

### `strega_model` and `strega_generation` are independent axes

`devices.strega_model` (`STANDARD` or `MOTORIZED`) and
`valve_settings.strega_generation` (`GEN1` or `GEN2`) answer different
questions and must not be conflated. `strega_model` names the physical valve
hardware: a motorized ball valve actuates and reports differently from a
standard solenoid, independent of firmware. `strega_generation` names which
ChirpStack device profile and codec the valve's controller board speaks:
Gen1's weekday-per-FPort scheduler and Gen1 clock-set (FPort 12), or Gen2's
daymask scheduler (FPort 25) and `DeviceTimeReq`-based clock (FPort 13). A
MOTORIZED valve can be either generation, and a STANDARD valve can be either
generation. The two columns vary independently; neither is derived from the
other.

`OPEN_FOR_DURATION` (the earlier "STREGA valve semantics" section) does not
vary with `strega_generation`: both generations accept the identical command
and close themselves identically when the commanded duration elapses. Only
the on-valve *scheduler* frames differ between generations, per the FPort
table above.

The Gen2 vendor decoder
(`docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up`)
names the decoded valve-state field `Actuator`, not `Valve` (the name Gen1's
decoder uses for the same concept). `strega-process-fn` in flows.json accepts
`Actuator` as an alias so both generations' current-state derivation reads
the same way downstream.

### Enclosure temperature and humidity: Gen1 only, and not field weather

Gen1 STREGA valves report enclosure climate on the periodic uplinks that
carry the temperature/humidity block; `strega_gen1_decoder.js` gates
`Temperature` and `Hygrometry` on a payload marker, and its counter-only
and analog-only periodic variants omit both fields rather than sending a
placeholder. When present, the two values derive from two 16-bit fields as
`(v/65536)*165-40` and `(v/65536)*100`. Two independent guards null the
sentinel: the decoder itself tests `box_temp === 65535 && box_hum === 65535`
(`strega_gen1_decoder.js`, the `box_temp === 65535 && box_hum === 65535` guard, added in `d261d2c7`), and `strega-process-fn`
in flows.json separately tests the decoded pair 125 °C / 100 %
(`normalizeStregaEnvironment`) — the vendor codec at
`docs/hardware/strega-codecs/ChirpStack-STREGA-CODEC-Decoder-Gen1` has no
such guard. Both of ours landed together in `d261d2c7`, so treat them as one
defence in two places rather than one compensating for the other — and note
that ChirpStack is provisioned with our guarded decoder, not the vendor file
(`chirpstack-bootstrap.js`, the `stregaCodecPath` and `stregaGen2CodecPath` provisioning; Gen2 is provisioned from `strega_gen2_decoder.js`, not from the vendor file). The values
land in `device_data.ambient_temperature` and `relative_humidity`, the same
columns sensor devices use.

**Gen2 (SV2) payloads carry neither field, and no decoding will produce
them.** Confirmed three independent ways:
1. The Gen2 vendor decoder
   (`docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up`)
   emits no temperature or humidity field in any of its four return shapes
   (ack port 10, ack port 24, the `default` ack branch, and the standard
   periodic uplink).
2. The SV2 manual's periodical uplink
   (`/home/phil/kDrive/OSI OS/Hardware/STREGA/Gen2/HHW_SV2_STREGA_Smart_valve_Manual.pdf`,
   payload format pp. 51-53) is 3 bytes of battery millivolts plus one
   fully-mapped info-status byte (Class, Power, DI_1/LSC, DI_0/LSO,
   valve-connection, valve-position), optionally followed by a counter;
   no spare bits, no spare bytes.
3. The manual's "Data Read" specification (p. 110) names valve state,
   battery, device ID, digital inputs, counter, alarm, and RSSI, and
   nothing climate-related — though the list ends "etc.", so this
   corroborates absence from the payload rather than proving the board has
   no sensor fitted.

No Gen2 payload carries these values, and no decoder change will produce
them; whether the SV2 board has a sensor that is simply never reported is
a separate question this evidence does not settle. If a future engineer
asks "can we get temperature off the Gen2 valves", the payload-level
answer is no — re-reading the decoder or the manual will not change it.

**This is enclosure climate, not field weather.** The vendor's own variable
names are `box_temp` and `box_hum`: the sensor sits inside the valve's
buried housing, not in the crop canopy. Rising humidity in that box means
water ingress, a maintenance signal that belongs beside battery level and
last-contact time, not a growing-condition reading. The value lands in
`device_data.ambient_temperature`, the same column `SENSECAP_S2120` and
other weather sensors write to, which makes it easy to mistake for zone
air temperature. It must never be used as zone air temperature and never
fed into an agronomy calculation (SWT scheduling, ET0, dendrometer stress).

`osi-valve-control` (`store.js`, `api.js`) reads these columns back out for
the valve list as `enclosure_temperature_c`, `enclosure_humidity_pct`, and
`enclosure_measured_at`. The two readings are selected independently (a
valve can report one and not the other), and both are bounded to the newest
row within a 7-day window, so a stale reading reports as absent rather than
current. `store.js`'s SQL does not filter by generation — a valve
re-pointed GEN1→GEN2 by the ACK-ledger recovery path still returns any
historical enclosure rows it wrote as Gen1; suppressing Gen2 happens at the
interface, not the query. `ValveTile.tsx` renders whichever of the two
values is present and goes silent only when both are absent (and always
for Gen2); `StregaValveCard.tsx` explains the two distinct absences: "no
reading yet" for a Gen1 valve that has not reported one, and "not measured
on Gen2" for a payload that cannot carry it.
