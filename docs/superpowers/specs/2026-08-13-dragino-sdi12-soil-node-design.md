# Dragino SDI-12-LB/LS soil node — design

- **Status:** Draft for review; no implementation started
- **Date:** 2026-08-13
- **Base branch:** `AgroLink` (`origin/AgroLink` = `441c5146`; the former `design-sync/agrolink` ref was folded in, its head `f5ca4a1f` is an ancestor)
- **Depends on:** vendor payload facts verified against the Dragino wiki manual and the official decoder (sources at the end); per-probe response layouts still need bench capture

## What this adds

One new edge device type, `DRAGINO_SDI12`, covering both the SDI-12-LB
(battery) and SDI-12-LS (solar) converters. The node polls an attached SDI-12
soil probe on a schedule and uplinks the probe's raw ASCII response; the edge
parses that text into canonical `device_data` columns using a per-device probe
profile. Tension probes land in the existing `swt_1..3` kPa channels, so the
irrigation scheduler, SWT buckets, pF derivation, and CSV export work without
modification. Water-content probes land in new `vwc_1..8`, `soil_temp_1..8`,
and `soil_ec_1..8` channels. There is no Chameleon, dendrometer, rain, or flow
surface on this type.

The integration copies the UC512 narrow-waist pattern (normalize module +
`osi-device-writer` + channel manifest), not the LSN50's 15-node legacy chain.

## Device facts

Verified against the Dragino manual and their official ChirpStack v4 decoder:

| Frame | Content |
|---|---|
| FPort 2 (periodic) | bytes 0–1 battery mV (bit 15 = interrupt flag), byte 2 payload version, bytes 3+ ASCII extracted from SDI-12 responses per the device's `AT+COMMANDx`/`AT+DATACUTx` config |
| FPort 5 (status) | model byte `0x17`, firmware version, band, sub-band, battery |
| FPort 100 (debug) | raw SDI-12 response to an ad-hoc command, or the literal string `NULL` when the probe did not answer |

Configuration is on-device: up to 15 `AT+COMMANDx` SDI-12 commands, each with
an `AT+DATACUTx` rule selecting which bytes of the response ride in the
uplink. Three downlinks matter to this design: `0xA8` executes an ad-hoc
SDI-12 command and can echo the response on FPort 100, `0xAF` rewrites
`AT+COMMANDx`/`AT+DATACUTx` remotely, and `0x01` sets the uplink interval
(default 20 min). Dragino ships no data decoder for the sensor payload: the
ASCII's meaning is defined entirely by the attached probe.

LB and LS differ only in power (8500 mAh Li-SOCl2 vs solar + 3000 mAh Li-ion);
the payloads are identical, so they share one `type_id`. The GUI battery
footer's voltage-to-percent fallback curve is Li-SOCl2-shaped, which is right
for the LB and clamps harmlessly at 100% for a solar-charged LS.

## Initial probe fleet

| Probe | Quantities | Depths | Notes |
|---|---|---|---|
| Sentek EnviroSCAN | VWC per depth; salinity per depth with TriSCAN | configurable, typically 4–8 | concurrent measurement (`aC!` + `aD0!…`) needed above 9 values |
| Delta-T PR2/4, PR2/6 | VWC per depth | 4 or 6 | two profiles, one per variant |
| ecoTech Tensiomark | tension (pF or hPa, configurable) | 1 | maps to `swt_1`; needs a unit transform |
| IMKO TRIME PICO64 | VWC + temperature | 1 | TDR, single point |
| HydraScout | VWC + temperature + EC per depth | factory-configured | modular depth count |

The exact SDI-12 response layout of each probe (value order, units, identity
string) is pinned during a bench phase, not in this spec. The design below
makes probe support a data change, so a wrong guess costs a registry edit and
a test fixture, never an architecture change.

## Architecture: thin codec, probe profiles as data

### Codec

`conf/…/codecs/dragino_sdi12_decoder.js` (+ bcm2709 mirror), derived from
Dragino's official ChirpStack v4 decoder with two deliberate corrections. It
decodes periodic sensor data **only on FPort 2** — current firmware uses
FPort 3 for datalog retrieval (timestamp- and length-prefixed frames that
would decode as garbage battery/version/ASCII), so FPort 3 and every other
unlisted port return an explicit `{unsupported_fport: n}` object the ingest
gate drops observably; the vendor decoder default-decodes unknown ports and
is wrong to. Second, a control byte ≥ `0xF0` skips itself AND the following
byte, matching the vendor loop's actual two-byte behavior (`i = i + 1` inside
a `for (…; i++)`). The codec extracts `BatV`, `Payver`, `EXTI_Trigger`, and
the ASCII sensor string, decodes the FPort 5 status frame, and never
interprets probe values. Uploaded to the ChirpStack device profile by
`chirpstack-bootstrap.js`, same as every other codec.

### Normalize module

`conf/…/node-red/osi-sdi12-normalize/{index.js,index.test.js,package.json}`,
registered on all three helper surfaces plus `osi-lib` `NAME_TO_PATH`. It has
two parts.

**A generic value parser — backstop, not defense.** SDI-12 data is
sign-delimited decimals; the parser accepts only strings matching
`^([+-][0-9]+(\.[0-9]+)?)+$` and returns the ordered float array. The grammar
alone cannot detect a response address glued after a decimal value:
`+22.10+31.2` (value `+22.1`, then address `0`, then `+31.2`) parses "cleanly"
as `[22.10, 31.2]`. The real defense is layered:

1. The per-probe AT recipe MUST `DATACUT` away every response address and CRC
   so the uplink is values only — this is a hard requirement of every recipe
   in the device doc, not an optimization.
2. Every named profile declares `expectedValues`; a parsed count that differs
   rejects the entire frame atomically (no partial channel writes). Only
   `GENERIC_VWC` accepts a variable count, and it is documented as the
   operator's explicit escape hatch with exactly this residual risk.
3. Leading-address strings and other garbage fail the grammar outright.

A rejected frame produces battery-only rows; the raw string is dead-lettered
into `ingest_quarantine` as channel `unparseable_sdi12` (or
`sdi12_value_count` for a cardinality mismatch) with reason
`unknown_channel` — that reason string is how `osi-device-writer` records all
normalizer unknowns, so troubleshooting queries filter on the channel name,
not the reason. The no-answer marker is compared exactly (`raw === 'NULL'`),
never by substring.

**A probe-profile registry.** Each profile is a plain object:

```js
{
  id: 'TENSIOMARK',
  label: 'ecoTech Tensiomark',
  identityMatch: null,                // enabled per probe at bench, never while provisional
  expectedValues: 2,                  // any other parsed count rejects the frame atomically
  values: [
    { index: 0, channel: 'swt_1', transform: 'pf_to_kpa', depthSlot: 1 },
    { index: 1, channel: 'soil_temp_1', depthSlot: 1 },
  ],
  defaultDepthsCm: [30],              // one entry per physical depth slot
  atRecipe: 'docs/devices/dragino-sdi12.md#tensiomark',
}
```

`depthSlot` separates physical depths from channels: a Tensiomark has two
channels at one depth; a HydraScout has three channels per depth. The
settings modal renders one depth input per slot and fans the value out to
every channel in that slot; storage stays channel-keyed for
`KiwiSensorCard` compatibility.

Transforms are a closed named set: `linear` (scale/offset), `pf_to_kpa`
(`10^pF / 10`, the inverse of the pinned pF contract), and `hpa_to_kpa`
(`÷ 10`). Values mapped to `swt_*` are clamped to `[0, 300]` kPa and rounded
to 2 decimals, matching `resistanceOhmsToKpa` in the Chameleon helper, so the
scheduler never sees a Tensiomark's pF 7 (1,000,000 kPa) as a threshold input.
VWC values are percent, bounds-checked to `[0, 100]`; EC values normalize to
µS/cm via each profile's `linear` transform. Out-of-bounds values quarantine
rather than clamp: a VWC of 250 is a wiring or profile error, not a wet
field.

`normalize(decoded, deviceConfig, meta)` returns `{channels, unknown}` in
channel keys, and `osi-device-writer` resolves keys to columns through the
edge manifest exactly as UC512 does. A missing or unset probe profile produces
battery-only rows plus a quarantine entry, so telemetry proves the node is
alive even before commissioning finishes.

Initial registry: `SENTEK_ENVIROSCAN`, `DELTAT_PR2_4`, `DELTAT_PR2_6`,
`TENSIOMARK`, `IMKO_PICO64`, `HYDRASCOUT`, plus `GENERIC_VWC` (values in
order: vwc per depth) as the escape hatch for an unlisted probe.

## Auto-identification

Phil's requirement: several probe models will be plugged into identical nodes,
so the system should discover which probe is attached rather than trust a
label. SDI-12 provides this: the standard `aI!` command returns the SDI-12
version, an 8-character vendor, a 6-character model, and a firmware field.

The flow:

1. One shared identify-trigger sub-flow is invoked from BOTH entry points —
   automatically after a successful `DRAGINO_SDI12` registration, and from
   the GUI's "Detect probe" button. It validates the device's ChirpStack
   application id before enqueueing, sets
   `devices.sdi12_probe_status = 'pending_identify'`, publishes the Dragino
   `0xA8` downlink wrapping `0I!` with the echo flag set, and surfaces a
   publish failure in the API response rather than leaving a silent pending.
2. The node is Class A, so the downlink rides after the next uplink; the probe's
   identity string comes back on FPort 100 one cycle later, and detection
   completes within roughly two uplink intervals. The GUI shows pending age
   from `updated_at`; "Detect probe" re-triggers at any time.
3. A small FPort 100 ingest branch parses the identity when the device is
   pending, matches it against the registry's `identityMatch` patterns, and on
   a hit sets `sdi12_probe_profile`, stores the raw string in
   `sdi12_identity`, and flips status to `identified`.
4. No match transitions to the terminal status `unmatched` (identity still
   stored and shown in the GUI to assist the manual choice) — both UPDATE
   branches carry the `AND sdi12_probe_status = 'pending_identify'` guard so
   manual selection (status `manual`) always wins over a late echo.

**v1 ships every provisional profile with `identityMatch: null`**, so
auto-selection never picks a datasheet-guessed layout: the identify
infrastructure runs, captures, and displays the identity, but profile
matchers are enabled per probe during the bench phase, and only for
identities that uniquely determine a value layout. Ambiguous families stay
manual permanently — a PR2/4 and PR2/6 return the same vendor identity, and
guessing between them would silently mis-map depths.

Identification names the probe model; it cannot tell whether the node's
`AT+COMMANDx` recipe matches that model. In v1 the recipe is applied at the
bench over the USB console, following per-probe instructions in a new
`docs/devices/dragino-sdi12.md`. Pushing the recipe remotely via `0xAF`
downlinks (true zero-touch commissioning) is phase 2 and out of scope here.

## Schema

Two ordered migrations, numbered from `ls database/migrations/ordered/` on the
base branch at execution time (the AgroLink lineage is past 0032; do not
hardcode).

**Additive migration.** New columns:

- `device_data`: `vwc_1..8 REAL`, `soil_temp_1..8 REAL`, `soil_ec_1..8 REAL`
  (24 columns). The schema allows 8 depths, but **v1 profiles are capped by a
  LoRaWAN payload budget, not by the schema**: Dragino documents 51 bytes per
  FPort 2 uplink at DR0 (11 bytes US915 DR0), oversized payloads are simply
  not delivered, and lower data rates (higher spreading factors) mean less
  capacity, not more. Every profile carries a computed worst-case uplink
  budget asserted ≤ 51 bytes by a unit test — which caps EnviroSCAN at 6
  depths and HydraScout at 2 depths × 3 quantities in v1. Larger probes are
  the phase-2 `AT+DATAUP=1` multi-segment unlock; the unused columns wait for
  it.
- `devices`: `sdi12_probe_profile TEXT`, `sdi12_probe_status TEXT`
  (`pending_identify | identified | unmatched | manual`, NULL for
  non-SDI-12 types), `sdi12_identity TEXT`. Depth labels reuse the existing
  `soil_moisture_probe_depths_json` column (a channel-keyed map, e.g.
  `{"vwc_1": 10, "vwc_2": 20}`), which is already in the devices sync
  trigger payload and already rendered by `KiwiSensorCard` — no new depth
  column and no depth-related contract change.

**Destructive migration.** The `devices.type_id` CHECK rebuild adding
`DRAGINO_SDI12`, copied from the `0010__add_milesight_uc512_type.sql`
precedent (trigger drop/recreate, `legacy_alter_table`, explicit-column
copy, index recreation). The devices outbox trigger (WHEN clause + payload)
gains `sdi12_probe_profile`; probe status and raw identity stay edge-local.

The frozen `sync-init-fn` boot node embeds **three** devices literals, and
all three change together or the live rebuild corrupts: `REQUIRED_TYPES`
(the drift detector), `DEVICES_NEW_DDL` (a full CREATE TABLE with its own
CHECK and column list), and `DEVICES_COPY_SQL` (a positional copy).
Updating only the type list would make a triggered rebuild recreate the
table without the `sdi12_*` columns and with a stale CHECK that re-triggers
the rebuild on every subsequent boot. `scripts/repair-pi-schema.js` carries
a fourth hardcoded devices rebuild that needs the same extension. The
rebuild rehearsal (`rehearse-devices-rebuild.test.js`) is extended to carry
sentinel `sdi12_*` values through a rebuild and assert full column
preservation, since the existing verifiers compare type sets and fencing,
not columns.

**Telemetry trigger.** `trg_dp_device_data_outbox_ai` enumerates every
telemetry field in its `json_object` payload — new columns do NOT ride
`DEVICE_DATA_APPENDED` for free. The 24 new fields are added to that trigger
in seed, migration, and the boot-node copy, gated by
`verify-trigger-body-parity.js` and `verify-boot-ddl-interpolation.js`.

All of the above — both migrations, seed, boot-node literals, repair
script, telemetry trigger, and all seven bundled databases — lands as **one
atomic commit**, per `osi-schema-change-control`.

**Contract surfaces:** 24 new entries in `web/react-gui/src/channels/channels.json`
(canonical; `cardType: soil`), regenerated `edge-channels.json` via
`scripts/build-edge-manifest.js`, the recorded SHA-256 in
`docs/channel-manifest.md`, and the `Device.type_id` enum plus a
`sdi12_probe_profile` property in
`docs/contracts/sync-schema/resources.schema.json`. The existing
server-only `vwc` channel is untouched. The MQTT live mirror ("Build
Telemetry") enumerates fields and falls back to `KIWI_SENSOR` for unknown
profiles, so it gains an explicit `DRAGINO_SDI12` mapping and the new
fields. osi-server needs the mirrored enum, channel copies, device-type
handling, and the paired half of any bulk-history-hash extension
(`osi-history-sync-helper` hashes a fixed 6-column list; extending it alone
breaks compatibility) — that is lockstep companion work with its own plan,
and it is a **merge gate**: this branch does not merge before the server
branch is ready to pair-deploy.

## Ingest flow

A new flows.json tab (both profiles, then `cp` to bcm2709 and
`verify-profile-parity`), shaped like the UC512 tab plus a config read:

```
SDI12 IN (mqtt in, application/+/device/+/event/up)
  → Gate + Decode        (strict profileId === CHIRPSTACK_PROFILE_SDI12; FPort routing)
  → Build Config Query   (SELECT sdi12_* FROM devices WHERE deveui = ?)
  → Read Device Config   (sqlite)
  → Normalize + Write    (osiLib sdi12-normalize + device-writer + edge manifest)
  → debug
FPort 100 branch → Identify Handler (match registry, UPDATE devices)
catch → record-error link-out
```

The write node reports node status yellow and a rate-limited warning
whenever the writer dead-letters channels, so a misconfigured probe is
visible in the editor rather than silently green. The gate passes only
FPort 2 to the write path and FPort 100 to the identify handler; FPort 5
and unsupported ports (including FPort 3 datalog) are dropped with a status
note.

The strict profile-ID equality matters twice over. First, it is the UC512
discipline. Second, the LSN50, STREGA, and cloud-telemetry dispatchers all
fall back to `profileName.includes('DRAGINO')` when env vars are missing, so
the ChirpStack profile is named **"OSI SDI-12 Soil Node"** (no "Dragino", no
"LSN50") to keep those branches from swallowing its uplinks. The telemetry
node's `getProfileKind()` gains an explicit `DRAGINO_SDI12` mapping.

## Provisioning, registration, API

- `chirpstack-bootstrap.js` (both byte-identical copies): `CFG` entries for
  profile name and codec path, `toUciCloudKey` →
  `chirpstack_profile_sdi12`, a `getOrCreateProfileWithCodec` call, the
  `CHIRPSTACK_PROFILE_SDI12` env/UCI wiring, the summary line, and the
  profile-count comment.
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`: a
  `resolve_chirpstack_value osi-server.cloud.chirpstack_profile_sdi12
  CHIRPSTACK_PROFILE_SDI12` line plus the matching export — without it, a
  boot that recovers from UCI alone leaves the env var empty and the strict
  gate silently drops every SDI-12 uplink.
- `catalog-response`: `{ id: 'DRAGINO_SDI12', name: 'Dragino SDI-12 Soil Node (LB/LS)' }`.
- `post-devices-auth`: add `DRAGINO_SDI12` to the type allow-list, and fix
  the pre-existing bug while there: the list is missing `AQUASCOPE_LORAIN`
  and `MILESIGHT_UC512`, so those types currently 400 on the public
  registration path.
- `post-devices-insert`: `appMap` (OSI Sensors) and `profileMap` entries.
- New endpoints, following the LSN50 config-endpoint auth pattern and the
  command-safety registry:
  - `GET /api/sdi12/probe-profiles` — registry listing for the GUI picker.
    Session-scoped like the device catalog: the branch's scoped-access
    ratchet requires every HTTP chain to reference the scope module, and
    static registry data follows the catalog precedent, not the tiny
    Phase-A public allowlist.
  - `PUT /api/devices/:deveui/sdi12/config` — probe profile + depths,
    validated against the selected profile's exact channel set (stale depth
    keys are replaced, not merged)
  - `POST /api/devices/:deveui/sdi12/identify` — the shared identify trigger

  All new endpoint SQL runs through `osi-db-helper` with bound `?`
  parameters — the playbook's "bound parameters only" rule applies to new
  code even though older LSN50 chains still string-build.

Registration inherits `ensureDeviceProvisioned` from whichever ChirpStack
helper version the branch carries; on AgroLink that is the rewritten helper
with key read-back verification, which this type gets for free.

## GUI

- `types/farming.ts`: `DRAGINO_SDI12` joins the `DeviceType` union.
- `Sdi12SoilCard.tsx`: a per-depth table (depth labels from the channel-keyed
  `soil_moisture_probe_depths_json`, the same mechanism `KiwiSensorCard`
  uses; VWC / temperature / EC columns, or kPa with derived pF for tension
  profiles), a probe-status chip (`pending_identify` / `identified` /
  `manual`), and the shared `DeviceCardFooter` for battery.
- `Sdi12SettingsModal.tsx`: profile picker fed by `GET
  /api/sdi12/probe-profiles`, a depths editor, and the "Detect probe" button.
- The two hand-written filter lists (`FarmingDashboard.tsx`,
  `IrrigationZoneCard.tsx`) get the new type; `channels/registry.ts` gets a
  `DRAGINO_SDI12` branch; `osi-history-router` and `osi-history-helper` soil
  card eligibility extends to `type_id === 'DRAGINO_SDI12'`.
- **Declaring channels does not deliver values to the card.** The
  `/api/devices` chain ("Format Response" + "Merge Data") selects and
  reconstructs `latest_data` fields explicitly, `types/farming.ts`
  enumerates the `latest_data` members, and the sensor CSV export query
  selects explicit columns — all three are extended with the 24 new fields,
  verified by one end-to-end assertion (SQLite row → `/api/devices` → card
  render → CSV) per quantity.

## Scheduler interaction

Tension profiles write `swt_1..3`, so existing SWT trigger metrics apply if
the zone-mean query is device-type-agnostic. Verifying that query (the
"Decide + build actuator cmd" node) is an explicit implementation task; if it
filters by type, it is extended. `trigger_metric` keeps its current CHECK —
VWC-based scheduling is a follow-up with its own agronomy questions, not a
side effect of this integration.

## Verification

- `scripts/verify-sdi12-codec.js` (modeled on the LSN50 codec verifier) and a
  `verify-codec-robustness.js` table entry, both added to `codecs.yml`.
- Golden vectors under `scripts/fixtures/device-integration/sdi12/` running
  the full codec → normalize → writer → in-memory-DB round trip via
  `verify-device-integration.js`, and wire that script into `codecs.yml`,
  since today it runs nowhere.
- `node --test` units co-located in `osi-sdi12-normalize` covering the parser
  (including the glued-address-digit case), every transform, every shipped
  profile, and the quarantine paths.
- The standard gate battery: three-surface helper registration, profile
  parity, channel-manifest parity, the migration and schema verifiers, the
  devices-rebuild fence + rehearsal, MQTT topic check, flows size ratchet,
  no-stray-DDL, silent-catch, and bare-require scans.
- **Bench phase (gates profile correctness):** with each real probe wired,
  capture raw responses over `0xA8`/FPort 100, then finalize value maps,
  identity patterns, AT recipes, and golden vectors from the captures. The
  playbook rule applies: profiles guessed from datasheets are hypotheses
  until a live capture confirms them.

## Out of scope (v1)

VWC as a scheduler trigger metric; more than 8 depths; `AT+DATAUP=1`
multi-segment uplinks; remote AT-recipe push via `0xAF` (phase 2); multiple
probes on one SDI-12 bus (v1 assumes one probe at address 0); any
Chameleon/dendrometer/rain/flow surface; the osi-server side of the contract
change.

## Open items

1. Per-probe response layouts, identity strings, and AT recipes — bench
   capture, tracked as plan tasks.
2. EC normalization per probe (target unit µS/cm; TriSCAN reports an
   uncalibrated index that may need its own channel semantics — decide at
   bench).
3. Depth cap of 8 — confirm no planned EnviroSCAN install exceeds it.

## Sources

- [Dragino SDI-12-LB/LS user manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/)
- [Official Dragino ChirpStack v4 decoder](https://github.com/dragino/dragino-end-node-decoder/tree/main/SDI-12-LB)
- [ecoTech Tensiomark](https://www.ecotech.de/en/product/tensiomark) (pF/hPa output, pF 0–7 range)
- [HydraScout](https://www.hydrascout.co/?lang=en) (modular multi-depth VWC + temperature + salinity)
