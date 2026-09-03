# Sentek EnviroSCAN ten-channel VWC and VIC — design

- **Status:** Implemented; bench-verified 2026-08-28 and field-verified 2026-08-30
- **Date:** 2026-08-25
- **Edge branch:** `AgroLink` in `/home/phil/Repos/osi-os-agrolink`
- **Cloud branch:** paired AgroLink worktree in `/home/phil/Repos/osi-server/.worktrees/agrolink`
- **Builds on:** `2026-08-13-dragino-sdi12-soil-node-design.md` and `2026-08-19-sdi12-multi-segment-uplinks-design.md`
- **Bench hardware:** Sentek EnviroSCAN Series II PCB 2.4, firmware 1.3.9; Dragino SDI-12-LB/LS hardware 1.3

## Outcome

OSI supports at most ten connected EnviroSCAN modules on one
`DRAGINO_SDI12` device. Every connected module reports VWC. A TriSCAN module
also reports Sentek Volumetric Ion Content (VIC) at the same channel and depth.
For the legacy TriSCAN configuration verified here, its moisture value is
normalized scaled frequency. The edge applies Sentek's default moisture curve
before storing that module's VWC; EnviroSCAN values are already calibrated and
pass through unchanged.

The storage contract adds `vwc_9`, `vwc_10`, and `soil_vic_1` through
`soil_vic_10`. VIC does not use the existing `soil_ec_*` family: Sentek treats
the probe-calculated VIC value as its salinity output, but converting VIC to
electrical conductivity requires a site- and soil-specific relationship. The
channel manifest labels the value `VIC` and assigns no conductivity unit.

Ten is an OSI product limit, not a Sentek limit. Sentek documents EnviroSCAN
probes with up to sixteen modules. A probe that exceeds the OSI limit must fail
configuration or quarantine its uplink; the edge must not discard trailing
values.

## Channel identity and layout

A channel number identifies a connected Sentek module. It is not calculated
from depth. This matters for the bench probe, whose eight modules occupy 10,
20, 30, 40, 50, 60, 80, and 100 cm; `vwc_7` is the seventh connected module at
80 cm, not a reserved 70 cm position.

Channel numbers remain stable after data exists. Adding a module at 70 cm does
not renumber channels 7 and 8. The operator assigns the new module an unused
channel, then the dashboard sorts configured rows by depth for display.

Wire position is a separate identity. **Response position** means the ordinal
position of a module's VWC value in the concatenated, bench-verified Sentek VWC
response. The normalizer maps a value by response position to its configured
channel; it never maps the i-th value to channel i and never derives position
from depth. Adding the 70 cm module as channel 9 therefore requires recording
the response position that PConfig and the capture assign to it.

`devices.sdi12_channel_layout_json` is the canonical active Sentek layout. It
stores the SDI-12 address and the response-position mapping:

```json
{
  "version": 1,
  "address": "L",
  "sensors": [
    { "channel": 1, "response_position": 1, "depth_cm": 10, "type": "TRISCAN" },
    { "channel": 2, "response_position": 2, "depth_cm": 20, "type": "ENVIROSCAN" },
    { "channel": 7, "response_position": 7, "depth_cm": 80, "type": "ENVIROSCAN" },
    { "channel": 8, "response_position": 8, "depth_cm": 100, "type": "ENVIROSCAN" }
  ]
}
```

Channels and response positions are independently unique integers from 1
through 10. Response positions are contiguous for the configured active
modules unless the bench capture proves that Sentek preserves positional holes.
The address is one valid SDI-12 address character. A layout contains at least
one module and at most ten; active depths are positive integers and duplicates
are rejected.

`devices.soil_moisture_probe_depths_json` becomes a compatibility projection
for existing cards, history, and export code. A Sentek settings write derives
it from the canonical layout in the same transaction:

```json
{
  "vwc_1": 10,
  "soil_vic_1": 10,
  "vwc_2": 20,
  "vwc_3": 30,
  "vwc_4": 40,
  "vwc_5": 50,
  "soil_vic_5": 50,
  "vwc_6": 60,
  "vwc_7": 80,
  "vwc_8": 100
}
```

For every `soil_vic_N`, the projection contains `vwc_N` at the same depth.
Sentek code reads sensor identity, type, address, and response position only
from `sdi12_channel_layout_json`; it never reconstructs those facts from the
projection.

The settings API accepts a Sentek-specific sensor list:

```json
{
  "probe_profile": "SENTEK_ENVIROSCAN",
  "address": "L",
  "sensors": [
    { "channel": 1, "response_position": 1, "depth_cm": 10, "type": "TRISCAN" },
    { "channel": 2, "response_position": 2, "depth_cm": 20, "type": "ENVIROSCAN" }
  ]
}
```

The edge validates the list, stores the versioned layout, and derives the
channel-key projection before a bound SQL update. `sensors` is mutually
exclusive with the legacy `depths` and `value_count` fields. Legacy calls
remain accepted for other profiles.

`devices.sdi12_value_count` is not widened or repurposed for this Sentek
layout. Once a Sentek layout exists, the normalizer never consults the legacy
count. Saving the layout sets `sdi12_value_count` to null in the same
transaction. Retaining the existing 1–8 check avoids another destructive
`devices` rebuild and preserves the field's behavior for other homogeneous
variable-count profiles.

## Upgrade behavior

An existing Sentek device with no `sdi12_channel_layout_json` stays in legacy
mode. The normalizer continues to use `sdi12_value_count` and maps that many
sequential values to VWC only, exactly as the current branch does. A stale or
partial `soil_moisture_probe_depths_json` does not activate the new parser.

The device API derives a `legacy_count` layout status for that state, and the
settings modal asks the operator to record the address, response positions,
depths, and module types. Saving that layout is the explicit activation point:
it writes the canonical layout and projection, nulls the legacy count, and
increments `sync_version` in one transaction. Until the operator performs that
action, the live five-value device continues accepting five-value VWC uplinks.

## Measurement wire contract

The implemented mixed-layout contract is a flat, fixed-cardinality vector.
Every configured module contributes one VWC value in response-position order.
The compact salinity group follows and contributes one VIC value for each
configured TriSCAN module, also in response-position order. Each command slot
must strip its SDI-12 address and CR/LF before the Dragino concatenates the
values. `PAYVER=2` may split the resulting ASCII string across LoRaWAN uplinks;
the edge reassembles the string before normalization.

For the installed eight-module rail, the only accepted mixed vector is:

```text
VWC1 VWC2 VWC3 VWC4 VWC5 VWC6 VWC7 VWC8 VIC1 VIC5
```

This is an exact ten-value contract. Eight values are not accepted as a mixed
sample, so an old VWC-only recipe cannot silently activate TriSCAN. Nine,
eleven, malformed, non-finite, and negative VIC inputs are rejected atomically.
The fixed VWC and VIC counts provide the command boundary; no value can shift
between the two groups without failing cardinality.

“VWC value” describes the canonical result, not necessarily the number received
on the wire. A layout entry marked `TRISCAN` uses the verified legacy identity
coefficients and arrives as scaled frequency. The normalizer converts it with
`VWC = ((SF - 0.02852) / 0.1957)^(1 / 0.404)`. A layout entry marked
`ENVIROSCAN` arrives as VWC percent and is not converted. VIC never uses the
moisture curve.

The first mapping fixture combined moisture values captured over LoRaWAN on
2026-08-26 with VIC values observed in Sentek Probe Configuration Utility
(`201.7789` and `216.6983`). Later fixtures contain the complete combined bench
capture from 2026-08-28 and the complete three-segment field capture from
2026-08-30.

Every acquisition is validated in this order:

1. The `PAYVER=2` sequence completes within its bounded reassembly window.
2. The reassembled payload satisfies the strict signed-decimal grammar.
3. The total equals configured modules plus configured TriSCAN modules.
4. The VWC prefix total equals the number of configured modules,
   and each value maps through its response position.
5. The VIC suffix total equals the number of configured TriSCAN modules and
   maps through their response positions.
6. TriSCAN scaled frequency is converted to default-estimated VWC.
7. Every canonical value passes the channel family's finite-number and range
   validation.

A failure records a quarantine reason and writes no soil channels for that
cycle. Battery telemetry may still be written. The writer never stores a
partial VWC/VIC row.

An explicit numeric zero from a configured sensor remains zero. OSI uses null
for missing data and never synthesizes zero, but the current evidence does not
establish `+0.000000` as a Sentek fault sentinel. A later documented sentinel
may map to null plus a diagnostic flag.

## Edge and cloud data path

The edge migration is additive: append `sdi12_channel_layout_json` to `devices`
and twelve `REAL` columns to `device_data`, then extend the seed, bundled
database copies, writer manifest, latest-data query, edge history/export
allowlists, and additive outbox-decorator triggers. The decorators amend the
rows emitted by the existing boot-owned triggers; they do not replace or alter
those frozen trigger bodies. The maintained Raspberry Pi profiles remain
byte-identical. Runtime-schema parity and boot-rewrite rehearsals still guard
against trigger downgrade. If deploy preflight finds genuine fingerprint
drift, deployment stops; an operator may use the sanctioned restamp command
only after verifying the live schema.

The three channel manifests must agree:

- Edge React: `web/react-gui/src/channels/channels.json`
- Cloud backend: `backend/src/main/resources/channels.json`
- Cloud frontend: `frontend/src/channels/channels.json`

Cloud scope for this slice is accept, store, sync, and manifest parity. It adds
the twelve telemetry keys to both cloud manifests and data-plane fixtures,
mirrors `sdi12_channel_layout_json`, and extends the strict desired-state schema
to accept the complete existing and new SDI-12 depth projection. Cloud
HistoryCardService, sensor-history allowlists, analysis cards, and a dedicated
DRAGINO_SDI12 cloud card remain in the deferred cloud GUI-parity slice. Cloud
contract support deploys before the edge begins emitting the new fields.

## GUI behavior

The settings modal shows a dynamic list of connected modules, capped at ten.
Each row has a stable channel number, response position, positive depth in
centimeters, and an `EnviroSCAN` or `TriSCAN` type. Removing a row frees that
channel but does not renumber the others. The old manual Sentek value-count
input is absent because the layout supplies both expected counts.

The soil card renders configured rows rather than scanning only non-null latest
values. It sorts rows by depth and shows VWC and VIC beside each other for a
TriSCAN module. A configured channel without a current reading stays visible
with an em dash; an unused channel has no row. If an older device has readings
but no saved layout, the card falls back to observed channel keys so an upgrade
does not hide existing data.

History and export retain channel identity. They attach the configured depth to
each key and expose VIC separately from EC. Charts must not place VWC and VIC
on one numeric axis because the quantities have different scales.

## Remote recipe deployment

The operator authorized `0xAF` commissioning writes on 2026-08-26. Diagnostic
recipes were applied through the Class A queue and then replaced with the
last-known moisture recipe. The device interval must return to 1200 seconds
after commissioning. Bench testing on 2026-08-28 proved an 8-second 12 V
window on the tested eight-module rail; a different field rail must repeat the
acquisition check before adopting that window.

The opt-in deployment path stores desired and last-observed recipe state
in an additive table, not Node-RED context. It sends only versioned,
profile-owned command strings; the browser cannot supply arbitrary SDI-12 or
`DATACUT` text. Reapplication sends the complete owned recipe and clears stale
owned slots. It orders replacement writes before clear operations and never
clears the last known-good acquisition slot without bench-proven replacement
evidence; if the captured converter behavior cannot support that ordering,
automatic deployment remains disabled. Retries are bounded, and rollback means
reapplying the last observed-compatible recipe.

Because the Dragino has no documented command-slot dump, an uplink cannot prove
the stored slot text. One matching acquisition moves the deployment to
`observed_once`; two consecutive matching acquisitions move it to
`observed_compatible`. A mismatch or incomplete sequence leaves the deployment
degraded and keeps the last valid readings visible. These states describe
observed wire compatibility, not confirmed converter configuration.

OSI never sends Sentek calibration, normalization, address-change, module, or
depth writes. PConfig remains authoritative for the probe's internal state.
The new recipe and normalizer surfaces read the configured address and may not
assume address `0`. Retrofitting the existing identify command, which currently
sends `0I!`, is a separate known issue rather than hidden scope in this slice.

## Bench evidence and remaining gates

The edge mixed-vector parser is enabled only for exact cardinality. The
2026-08-26 remote session established:

- Downlinks were transmitted and acknowledged through ChirpStack Class A.
- `LM2!` with 5 seconds was too short for the manual's 23-second maximum.
- `LM2!` with 30 seconds, `LC1!` with 40 seconds, and a later explicit `LD0!`
  produced no salinity bytes; Dragino raw framing reported `F1 00`.
- The vendor utility had previously read two finite VIC values.

The 2026-08-28 bench session then established:

1. `M2!` returns a compact group containing only the configured TriSCAN
   modules, in response-position order.
2. Explicit `D1!` and `D2!` command slots are required for the installed
   eight-module rail.
3. The verified production vector is eight VWC values followed by two VIC
   values. It crossed `DATACUT`, `DATAUP=1`, LoRaWAN, codec decoding, edge
   reassembly, normalization, SQLite storage, and GUI rendering.
4. An 8-second switched 12 V window was sufficient for consecutive complete
   samples on Dragino battery power.

Removing or failing a middle module remains unverified: the probe may preserve
the position, compact the list, emit zero, or use another sentinel. A physical
ten-module rail also requires its own continuation, payload, and power-timing
capture.

The current field run closed the remote `0xAF` framing, confirmed-downlink,
Class A queue-pacing, three-segment reassembly, and observation-state gates for
the installed eight-module rail. The compiler's worst-case ten-TriSCAN recipe
fits eight converter slots, and the integration suite reassembles and persists
its twenty values over five segments. Power-cycle persistence on that larger
hardware arrangement and its 8-second power-window suitability remain
unverified. The production path therefore stays user-initiated and bounded; it
does not silently rewrite a saved layout or probe calibration.

## Verification boundary

Tests cover schema consistency, migration upgrade from the current AgroLink
head, exact sync-trigger payloads, channel-manifest parity, writer allowlisting,
history/export discovery, GUI layout validation, stable channel identity, and
missing-value rendering. Normalizer golden values include the complete live
LoRaWAN VWC/VIC capture from 2026-08-28. The combined transport vector is no
longer synthetic.

Upgrade tests include the live device's legacy shape: Sentek profile, learned
count 5, no canonical layout, and a stale or absent depth projection. Five VWC
values must continue to write until explicit layout activation. Mapping tests
also insert a 70 cm module as channel 9 at its captured response position and
prove that the existing 80 and 100 cm histories remain channels 7 and 8.

The live acceptance row must contain all configured VWC channels and VIC only
at configured TriSCAN channels. For the current probe that means VWC at
channels 1–8 and VIC at channels 1 and 5, with channels 9–10 absent.
