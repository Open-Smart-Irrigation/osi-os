# SDI-12 multi-segment uplinks (`AT+DATAUP=1`) — design

- **Status:** Approved in chat 2026-08-19 (reassembly placement A, `payver=2` discriminator, atomic-or-quarantine); implementation not started
- **Date:** 2026-08-19
- **Branch:** `AgroLink` in `/home/phil/Repos/osi-os-agrolink` (head `19ca945e` or descendant)
- **Builds on:** `docs/superpowers/specs/2026-08-13-dragino-sdi12-soil-node-design.md` (the v1 device type) — this is its reserved "phase 2 multi-segment" item
- **Why now:** the sensor trial runs on external power, which removes the only real cost of multi-segment uplinks (airtime/battery), and 8-depth EnviroSCAN / 3-quantity HydraScout configurations exceed the 51-byte single-uplink budget at DR0

## What this adds

The edge accepts Dragino SDI-12-LB/LS uplinks split across up to 15 LoRaWAN
frames (`AT+DATAUP=1`) and reassembles them into the single ASCII string the
existing normalizer consumes. Everything downstream of the gate — the device
config read, `osi-sdi12-normalize` and its bench-verified profiles, the
writer, schema, channels, identify path, GUI — is untouched. The normalizer
never learns that segments exist.

## Wire format (verified against the Dragino SDI-12-LB/LS manual)

Single uplink today (`AT+DATAUP=0`, payload version 1):

```
[bat_hi][bat_lo][payver=1][ascii...]
```

Multi-segment (`AT+DATAUP=1`, payload version 2 — set on the device with
`AT+PAYVER=2`):

```
[bat_hi][bat_lo][payver=2][count][index][ascii-slice...]
```

`count` is the total number of segments (1..15), `index` is zero-based. Each
segment carries at most 46 data bytes in a 51-byte region (EU868 etc.; 6 in
11-byte dwell-limited regions). The total sequence is at most 1500 bytes. Bit
15 of the battery word is the interrupt flag, as today.

**Contract:** a device configured for `DATAUP=1` MUST also be configured
`AT+PAYVER=2`. The codec discriminates the header layout on `payver` alone —
never on frame length — so a misconfigured device (DATAUP=1 with payver 1)
produces garbage ASCII that fails the strict grammar and quarantines, rather
than being mis-reassembled. This is recorded in the device doc next to the
recipe.

## Architecture

### Codec (`dragino_sdi12_decoder.js`, both profiles)

FPort 2, `payver === 2`: requires at least 5 bytes (else
`{unsupported_payload: 'payver2_short'}`), emits
`{BatV, EXTI_Trigger, Payver: 2, SegCount, SegIndex, data_sum}` where
`data_sum` is the ASCII slice from byte 5. `payver === 1` keeps the current
3-byte header path byte-for-byte. Any other payver → `{unsupported_payload:
'payver_' + n}`; the gate drops it observably like an unsupported FPort.
FPort 5 and FPort 100 unchanged.

### Reassembly helper (`osi-sdi12-reassemble`, new module)

A pure, unit-testable state machine with no Node-RED dependency, registered
on the three helper surfaces plus `osi-lib` `NAME_TO_PATH` exactly like
`osi-sdi12-normalize`:

```js
// state: a plain object the caller persists (flow context), keyed by deveui
// segment: { count, index, ascii, batV, extiTrigger, recordedAt, nowMs }
step(state, deveui, segment) -> {
  action: 'buffered' | 'complete' | 'passthrough' | 'reset',
  message?: { BatV, EXTI_Trigger, Payver: 2, data_sum, recordedAt },  // on complete/passthrough
  quarantine?: { channel: 'sdi12_segments_incomplete', raw: string },  // on reset
  status: string   // human text for node.status, e.g. 'seg 2/3'
}
```

Rules:

- `count === 1` → `passthrough`: emit immediately; any stale buffer for that device is discarded first (a device switching back to single-frame must not keep an orphan).
- New deveui, or buffer empty → start a buffer `{count, firstAtMs, segments: {}}`.
- Same `count`, unseen `index` within `[0, count)`, and `nowMs - firstAtMs <=
  WINDOW_MS (600000)` → store, `buffered` unless all indices present → then
  `complete`: concatenate slices in index order, `BatV`/`EXTI_Trigger`/
  `recordedAt` from the highest-index segment, clear the buffer.
- Any of: `count` differs from the buffer's, `index` already present, `index
  >= count`, or the window elapsed → `reset`: the partial set becomes ONE
  quarantine record (`sdi12_segments_incomplete`, raw = `count` + indices
  seen, e.g. `3:[0,2]`), the buffer is cleared, and the incoming segment then
  starts a fresh buffer (it is the first segment of the next sequence unless
  its own index is non-zero, in which case it is buffered anyway and will be
  reset by the window if its siblings never come).
- Window choice: 10 minutes covers Dragino's inter-segment spacing (seconds)
  with margin for LoRaWAN duty-cycle backoff, and is well under the 20-minute
  TDC so one sequence can never bleed into the next at default settings. If
  TDC is ever set below the window, the `count`-mismatch and duplicate-index
  rules still bound the damage to one quarantined sequence.
- The state object is bounded: one buffer per deveui, at most `count` slices.

Battery and timestamp come from the last segment only — segments are seconds
apart and identical, so averaging would add code for no information.

### Gate node (`sdi12-gate-fn`)

Extends the FPort 2 branch: if `decoded.Payver === 2` and `SegCount`/
`SegIndex` are present, load the reassembly state from flow context
(`flow.get('sdi12_reassembly') || {}`), call `step`, persist the state, and:

- `buffered` → `node.status({fill:'blue', shape:'ring', text: status + ' ' + deveui})`, return null.
- `complete` / `passthrough` → replace `msg.sdi12.decoded` with the emitted
  single-uplink-shaped object (`Payver` stays 2 but no `Seg*` fields) and
  forward on output 1 exactly as a payver-1 frame is forwarded today.
- `reset` → dead-letter the quarantine record through `osi-device-writer`'s
  existing quarantine path (the write node already owns the DB handle; the
  gate sends a small marker message `msg.sdi12.quarantineOnly = {...}` down
  output 1 so the writer records it and skips the row insert), then handle
  the incoming segment per the rules above.

`payver === 1` frames bypass all of this — zero behavior change for the fleet
as it is today. On the FIRST successful `complete` per deveui per Node-RED
run, the gate emits one `node.warn('sdi12 multi-segment reassembled: <eui>
<count> segments, <n> bytes')` so a live switch-over can be confirmed from
the logs without a debug sidebar.

### Write node (`sdi12-write-fn`)

One addition: if `msg.sdi12.quarantineOnly` is present, call the writer's
dead-letter for that channel/raw and return without a row insert. No other
change — the reassembled message is indistinguishable from a single uplink.

### Normalizer (`osi-sdi12-normalize`)

No parsing change. The payload-budget annotation `worstCaseUplinkBytes`
gains an optional per-profile `maxUplinks` (default 1) so 8-depth
EnviroSCAN and full HydraScout entries can declare `maxUplinks: 2` / `5` and
the budget test asserts `worstCase <= maxUplinks * 46 + …` instead of
flagging them phase-2-blocked. Their "phase 2" comments are rewritten to
"requires `AT+DATAUP=1` + `AT+PAYVER=2` on the device".

## Error handling summary

| Situation | Outcome |
|---|---|
| Segment lost (never arrives) | the NEXT segment from that device (normally the start of its next sequence, ≥ TDC later) finds the window elapsed and resets → one `sdi12_segments_incomplete` quarantine row, nothing written. The window is evaluated lazily on arrival, not by a timer: a device that goes silent after a partial sequence leaves that partial in memory until it speaks again (or Node-RED restarts) — bounded to one buffer per device, no row is written, so this is an accepted, visible non-event |
| Duplicate delivery of a segment | `reset` — treated as a corrupted sequence (Dragino does not retransmit segments; a duplicate means two sequences interleaved) |
| Late LoRaWAN delivery straddling a reset | Frames carry no sequence id, so a late tail segment of sequence N arriving after sequence N+1 has started can be buffered into N+1 and, if indices/count line up, complete a *mixed* string that still parses. This cannot be excluded in-protocol. It is bounded by the 10-min window being well under the 20-min TDC (genuine interleave cannot occur at defaults; only late/duplicate network delivery can), and by the normalizer's exact-cardinality check for fixed-count profiles. "Atomic" therefore means: never a partial string, and never two sequences merged at default timing — not a cryptographic guarantee |
| Device at `DATAUP=1` but `PAYVER=1` | codec emits the 3-byte-header reading of a 5-byte header → garbage ASCII → strict grammar fails → `unparseable_sdi12` quarantine; visible, never mis-parsed |
| `payver=2` frame under 5 bytes | `unsupported_payload`, dropped with status |
| `count === 1` | straight through; a DATAUP=1 device whose data fits one frame behaves exactly as today |
| Node-RED restart mid-sequence | flow context is in-memory by default — buffer lost, the orphan tail segments reset by window/index rules, one quarantine row; acceptable and visible |

## Testing

- Codec: payver-2 header decode, payver-1 unchanged, short payver-2 frame, unknown payver; added to `scripts/verify-sdi12-codec.js` and the robustness table.
- `osi-sdi12-reassemble/index.test.js` (`node --test`): in-order, out-of-order, passthrough, duplicate index, count mismatch, index out of range, window timeout (injected `nowMs`), bounded state, `quarantine.raw` format.
- Gate logic exercised via `scripts/verify-device-integration.js` golden vectors: a 2-segment 8-value EnviroSCAN sequence (two `bytes` arrays in one vector, runner concatenates through the helper) round-trips to 8 `vwc_N` values; a 3-segment sequence with the middle one missing produces only the quarantine row.
- Flows gates: the standard battery (fn-parse, wiring, size ratchet measure-and-raise, silent-catch, bare-require, profile parity, journal-v2 ordering, live-identity hash pins untouched).
- **Bench gate (acceptance):** the live EnviroSCAN on agrolink-test-01 switched to `AT+DATAUP=1`, `AT+PAYVER=2`, 8 sensors enabled (`AT+COMMAND1=0M!`, `AT+COMMAND2=0D1!` or the `aC!` path per the Sentek manual) — first reassembled frame observed in `device_data` with `vwc_1..8`, and the `node.warn` line in the log.

## Out of scope

`AT+DATACONV` binary encoding (Way 2), remote recipe push via `0xAF`,
multi-probe-per-node config, changes to `TDC` defaults, any cloud change
(the reassembled message is indistinguishable from today's single uplink, so
`DEVICE_DATA_APPENDED` and the cloud are unaffected).
