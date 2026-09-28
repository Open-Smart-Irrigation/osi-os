# RAK10701 coverage field test — design

Target date 25 September 2026: a customer-facing coverage walk at the demo site with a RAK10701 field
tester and the target gateway. The walk must produce measured coverage on the gateway's own GUI,
live feedback on the handheld, and a measured-versus-predicted comparison against an `osi-planner`
project. This document specifies the edge work that makes that possible and the rehearsals that prove
it before the day.

Two decisions were taken by the operator before drafting and are not reopened here: the tester becomes
a first-class device type rather than a radio-only source, and the handheld gets its downlink.

## Verified state of the target gateway

Read-only inspection of the target gateway (<gateway-address>) on 22 September 2026:

| Fact | Value |
|---|---|
| Hardware and OS | Raspberry Pi 4 Model B Rev 1.4, armv7l, ChirpStack Gateway OS 4.9.0 with the OSI Node-RED payload on top |
| Gateway EUI | `0016C001F1000001`, `device_eui_confidence='authoritative'` |
| Installation | `recovery_state='ACTIVE'`, uuid `dfc6df51-0a72-4c0a-9ec6-313fab4a853f` |
| Schema head | 56 (repo main is at 58) |
| Last deploys | payloads `20260916T204124Z`, `20260917T205925Z`, `20260917T221543Z` |
| Cloud sync | `osi-server.cloud.enabled='0'`, host the customer cloud host; `sync_outbox` holds 6705 rows |
| Devices | two STREGA valves; ChirpStack already has the `OSI Field Tester` application |
| Radio capture | `radio.db` absent, never run |
| Gateway position | gpsd not installed, `gateway_locations` empty |

Two of these carry the plan. Because cloud sync is disabled, the new device type is an edge-only
change: no `osi-server` `DeviceType` entry is required for the walk, and no sync rejection can result
from it. Because the F148 Pi 4 blocker does not apply here (`/srv/node-red/node_modules/sqlite3` is a
real directory and the `sqlite3` CLI is present), the normal `deploy.sh` path is available.

## Defects that would make the walk produce nothing

**The GPS decode gate has never fired on hardware.** The radio capture node passes
`testerProfileId: env.get('CHIRPSTACK_PROFILE_FIELD_TESTER')`, and nothing anywhere sets that variable:
`node-red.init` exports `CHIRPSTACK_PROFILE_RAK10701` and `CHIRPSTACK_PROFILE_CLOVER`, and the string
appears exactly once in the whole repository, in that node. The name fallback compares
`deviceProfileName` against the literal `Field Tester`, while `chirpstack-bootstrap.js` names the
profile `OSI RAK Field Tester`. Both tests fail, `isTester` stays false, and `reported_position` is
written as null for every tester uplink. A walk under this code records signal without position.

**Capture cannot be switched on.** `OSI_RADIO_CAPTURE_ENABLED` is read by two function nodes and
exported by nothing. There is no UCI key, no `node-red.init` line, and no documented operator path.

**The gateway has no position.** `receiverPosition` in `osi-radio-helper/chirpstack.js` returns null
unless `gateway_locations` holds a fix whose `last_good_fix_at` is within 300 s of the packet. The
table is empty and gpsd is not installed, so every observation would carry receivers with null
positions. Distances cannot be computed, the map has no anchor, and the downlink's distance bytes
have nothing to encode.

**The tester's profile collides with Tektelic Clover.** `CHIRPSTACK_PROFILE_CLOVER` and
`CHIRPSTACK_PROFILE_RAK10701` hold the same UUID on this gateway (`ebc4ad1f-5cec-4214-ba65-c56c26c9742e`),
by design: `chirpstack-bootstrap.js` calls CLOVER "a compatibility alias for the RAK10701 field tester
profile". Five places in `flows.json` branch on the CLOVER id. The profile carries no codec
(`payload_codec_runtime = NONE`), so ChirpStack publishes tester frames without a decoded `object` and
`Process Data` aborts at its `!data.object` guard. Today's cost is one logged error per uplink plus a
wrong classification in `Build Telemetry`, which maps that profile id to `TEKTELIC_CLOVER`. It becomes
row corruption the day anyone attaches a codec to that profile.

**The boot node will fight the new device type.** `sync-init-fn` compares the live `devices` CHECK
against its own `REQUIRED_TYPES` by set equality, and rebuilds the table whenever the sets differ in
either direction. Ship migration 0060 (numbered 0059 at authoring time; renumbered before merge to avoid
colliding with main's `0059__sync_rejection_recovery.sql`, #351) without extending that set and every reboot attempts to revert
it; with a tester row present the plain `INSERT` copy violates the reverted CHECK, so the rebuild
aborts and logs on each boot.

## Design

### Device type

Add `RAK10701_FIELD_TESTER` to `devices.type_id` as `database/migrations/ordered/0060__add_rak10701_type.sql`,
risk class `destructive`, following `0027__add_dragino_sdi12_type.sql` line for line: drop the three
sync triggers, rename to `devices_old` under `PRAGMA legacy_alter_table=ON`, create the table with the
extended CHECK, copy with a plain `INSERT`, restore triggers and the four indexes. The runner supplies
the FK fence and the writers-stopped gate; the migration must not toggle `foreign_keys` itself.

Extend `REQUIRED_TYPES` in the `sync-init-fn` boot node in both `flows.json` copies, `seed-blank.sql`,
all seven bundled `farming.db` copies, the `schemaContract` in `verify-db-schema-consistency.js`, and
the GUI type union in `web/react-gui/src/types/farming.ts`. The device registry entry names the type
for the GUI's add-device flow so the tester can be registered through the product, not by hand.

The type must not reach the telemetry path. `Build Telemetry` and `Process Data` classify by profile
id, and that id is shared with Clover, so the discriminator is the application: an uplink whose
`deviceInfo.applicationId` equals `CHIRPSTACK_APP_FIELD_TESTER` is radio-only and returns before any
decoder branch. That fence is independent of the profile alias and survives a future codec.

### Capture

Fix the gate in both `flows.json` copies to read `CHIRPSTACK_PROFILE_RAK10701`, falling back to
`CHIRPSTACK_PROFILE_CLOVER`, and to match a profile name containing `Field Tester` rather than equal
to it. Keep the existing behaviour that GPS decode runs only for `fPort === 1`.

Plumb the capture flag through the same path every other gateway knob uses: a UCI option read by
`resolve_chirpstack_value` in `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` and
exported as `OSI_RADIO_CAPTURE_ENABLED`. Default off, matching `docs/contracts/radio-observations/v1.md`.

### Gateway position

Add a `source='static'` row to `gateway_locations` carrying the surveyed antenna position, written
through a new authenticated `PUT /api/gateway/location` handler in `osi-network-api`, and exempt
static sources from the 300 s freshness rule in `receiverPosition`. gpsd keeps precedence: when a live
fix exists it wins, and the static row is used only in its absence. This does not create a second
writer for the gpsd authority frozen by blocker B3 of the 2026-09-10 consolidation, because the static
row is operator-asserted and explicitly labelled as such.

The operator supplied the site's surveyed coordinates and an antenna height of about 5 m above
ground. The coordinates are customer site data and are deliberately absent from this repository,
which is public; they live in the session workspace and are entered at deployment time. No absolute altitude exists for the site, and none is needed:
`gateway_locations.altitude_m` is nullable, nothing on the walk's path reads it, and the downlink's
distances are two-dimensional. The planner takes antenna height above terrain as `tx_height_m` and
resolves ground elevation from swisstopo itself, so 5 m is the figure it wants. Record `altitude_m`
as null rather than inventing a value.

### Handheld downlink

RAK's documentation fixes the response as six bytes on fPort 2: sequence id as `ID % 255`, minimum
RSSI plus 200, maximum RSSI plus 200, minimum distance in 250 m steps, maximum distance in 250 m
steps, gateway count. Zero distance means invalid, distances below 250 m report as 250 m, and the
scale caps at 32 km. The same documentation gives the fPort 1 uplink as six GPS bytes, altitude plus
1000 m, HDOP times ten, and satellite count, which matches `decodeTesterGps` field for field and
confirms that decoder needs no change.

A new `osi-radio-helper` encoder builds those six bytes from the observation's receivers and the
gateway position, and the capture path enqueues the downlink through the existing ChirpStack helper.
When no gateway position is known both distance bytes are zero, which the device reads as invalid
while still displaying RSSI and gateway count. The sequence-id source is the uplink's `fCnt` modulo
255; confirm against the device during the bench rehearsal, since RAK documents the field only as
"ID % 255".

### Walk surface

`NetworkPage` gains a coverage view over the existing observations endpoint: walk points coloured by
RSSI, a gateway marker from the static or gpsd position, a session window picker, and an export of the
visible window as GeoJSON and CSV. The header entry stays desktop-gated, matching the laptop-at-the-farm
decision. New strings ship in all seven locales; French carries the demo, since the site's devices are
already named in French.

### Module visibility

The Network entry appears when a field tester is registered on the gateway, and an administrator can
override that from the Settings page. `osi-module-defaults` already gives the override half: a stored
`app_settings` row always beats the shipped default, and the Settings page writes that row. Only the
default changes shape.

Replace the network module's static `defaultEnabled: true` with a derived default resolved against a
caller-supplied context, keeping the package free of runtime dependencies as its header requires. The
settings route supplies the context from one query, `SELECT 1 FROM devices WHERE
type_id='RAK10701_FIELD_TESTER' AND deleted_at IS NULL LIMIT 1`. Effective visibility is then the
stored row when one exists, and field-tester presence when none does. `GET /api/system/settings`
already reports the resolved value, so `useGatewayModules` and `DashboardHeader` need no change.

That makes the stored row a pin in either direction, with no way back to the derived state once
written. `PUT` therefore accepts an explicit `auto` that deletes the row, and the Settings control
offers auto, on and off rather than a two-position switch. The tri-state control is the cuttable part:
without it an administrator can still force the module on or off, which is the access the operator
asked for.

Roles differ between the two sides and the spec does not unify them. The edge has no superadmin:
`users.role` is constrained to `admin`, `researcher` and `viewer` by migration 0033, so `admin` is the
ceiling there. The cloud has `SUPER_ADMIN`, which `SecurityConfig` already treats as covering
`ADMIN`. Creating an edge superadmin would mean rebuilding the `users` table and is not part of this
work.

This supersedes the approach recorded in osi-os issue #283, which hides the Network entry on customer
branches by flipping the shipped default. A derived default reaches the same outcome without a
divergent customer pick: a gateway with no field tester shows nothing, and the customer's shows the entry
because a tester is registered there.

### Predicted overlay

`osi-planner` gains an import for that GeoJSON and draws measured points over predicted coverage in an
existing project. The planner is a separate repository with its own deploy to the test host, so this
work cannot affect the gateway.

## Cloud mirror

The operator asked for cloud by default, so the gateway syncs its coverage to the customer cloud host rather
than holding it locally, and this track ships with the rest rather than waiting on a gate. The gateway already has internet: it answers over the tailnet on a direct
connection, and `sync_link_state` records a link to the customer cloud host made on 2026-08-24 against
this same installation uuid. Sync is switched off, not absent, so this is a re-enable.

Two findings set the cost. Unauthenticated probes show the customer cloud host serving
`/locales/fr/common.json` with 200 while `/locales/fr/network.json` and `/locales/en/network.json`
both return 404, which is the asset the network pilot verification checks; the deployed build
therefore predates the network observations work. Against that, the cloud sync path does not validate
device type at all: `DeviceType.java` is a partial constants file that lists neither `TEKTELIC_CLOVER`
nor `MILESIGHT_UC512`, and nothing under `backend/src/main/java/org/osi/server/sync/` references it.
The `RAK10701_FIELD_TESTER` entry on the cloud is therefore cosmetic, governing how its GUI renders
the device rather than whether the row is accepted.

The track is: release an `osi-server` build carrying the network mirror and Flyway
`2026.09.17.001` through `.003` to the customer cloud host, add the `DeviceType` constant and the
`frontend/src/components/farming/deviceRegistry.tsx` entry, then set
`osi-server.cloud.enabled='1'` on the gateway. Re-enabling flushes the 6705 rows queued in
`sync_outbox` since sync was disabled. Verify before enabling that the edge marks an unsupported
history table as such rather than stalling the stream, because the radio stream is new to that cloud.

The cloud's module visibility follows the same derived rule as the edge, resolved against the
installation's devices, with `SUPER_ADMIN` able to override it from the cloud Settings page.

One operational condition survives the decision to ship this by default: the release target is a customer
instance, and the release lands three days before a customer demo. The deployment is confirmed with
the operator at the moment it runs, the way any customer deployment is, and it is the first thing cut
if the edge track is not green by Wednesday evening.

## Out of scope

Porting the planner's terrain engine into the edge, which remains consolidation item I8; the
17,959-rejection canary condition on the unrelated pilot gateway.

## Verification

Unit level: `osi-radio-helper` tests for the profile gate against a RAK-named profile and a
`CHIRPSTACK_PROFILE_RAK10701`-only environment, encoder tests covering the RSSI offset, the 250 m
quantisation, the 32 km cap and the no-position case, and `osi-network-api` tests for the location
handler.

Schema gates, each rerun in the branch: `verify-migrations.js`, `verify-seed-replay.js`,
`verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`, `verify-no-stray-ddl.js`,
`verify-profile-parity.js`, `verify-devices-rebuild-fence.js`, and
`node --test scripts/rehearse-devices-rebuild.test.js`.

Bench rehearsal: publish a captured 10-byte fPort 1 frame to the gateway's MQTT uplink topic and
confirm a `radio_uplinks` row with a decoded `reported_position`, a map point, and an encoded downlink.

Hardware rehearsal on the Pi 4 test gateway (<gateway-address>): the same armv7l Pi 4 architecture as the
target, not cloud-linked, `ACTIVE`, at schema head 53 with an empty `gateway_locations`. Deploying
there exercises migrations 54 through 59 against a live database, the static-location path, and real
radio contact with the tester before the real gateway is touched.

Target deploy: `deploy.sh` over the reverse tunnel per `osi-live-ops-runbook`, reading the self-check
verdict rather than the closing banner. The cloud canary does not apply, since sync is disabled.

## Schedule and cut line

Tuesday evening through Wednesday: migration and boot-node type work, capture gate fix, flag plumbing,
static location handler, downlink encoder, with unit tests alongside. Wednesday: deploy to
the Pi 4 test gateway, bench rehearsal, then real radio contact with the tester. Wednesday evening is
the cloud gate, judged on whether the edge track is green. Thursday: coverage view and planner
overlay, second rehearsal on the rehearsal gateway, the customer cloud release if the gate passed, then
deploy to the target gateway. Friday: the walk.

The operator registered the tester in the target gateway's ChirpStack on 22 September, in the
`OSI Field Tester` application on the `OSI RAK Field Tester` profile. Its `farming.db` row cannot be
created until 0060 lands, so registration in the product GUI is a Thursday step. The same keys must be
provisioned on the Pi 4 test gateway for the rehearsal, and the device rejoins when it moves between
the two gateways, since each runs its own network server.

Cut order if time runs short: the customer cloud release drops first, then the planner overlay, which
can be done afterwards from the exported GeoJSON, then the downlink. The device type, capture, gateway
position and coverage view are the walk itself.

## Day-of dependencies

The laptop must reach the gateway's GUI at the farm, over the tailnet or the site LAN; confirm which
before travelling. If the cloud track lands, the customer cloud host gives a second viewing surface, but it
depends on the laptop having internet at the site and on sync having caught up, so the edge GUI stays
the primary screen. The tester must be provisioned in the target gateway's ChirpStack with the same
keys used during rehearsal, and rejoined after the switch, since the two gateways run independent
network servers.
