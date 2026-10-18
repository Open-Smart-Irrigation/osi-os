# Tensiomark acceptance hardening

The final review found three defects in the two-probe feature. A malformed
reply can become valid after the shared decoder drops bytes, and a cloud history
snapshot omits the saved layout that keeps channels available after a rejected
sample. The deployed card also lacks its Details link. Fix these before field acceptance. Customer identities and operational
evidence remain outside the public repositories.

## Edge transport boundary

Reproduction: a PAYVER 1 payload containing
`1+16.11+0.\t000\r\n4+18.25+5.359\r\n` is decoded into an ordinary pF reply.
The configured normalizer accepts it and stores four soil channels. The original
bytes survive in `payload_base64`, but `raw_response` has lost the tab.

Add a Tensiomark-only uplink entry point in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/tensiomark-live.js`
and export it through that module's `index.js`. In
`osi-sdi12-commissioning/write-handler.js`, use this entry point when the profile
is TENSIOMARK and the explicit layout validates. Pass the original base64 payload
and FPort from `msg.sdi12`. Keep the existing text parser for direct parser tests
and the shared codec and other sensor paths unchanged.

The uplink entry point must:

1. Require FPort 2, canonical nonempty base64 and a complete three-byte PAYVER 1
   header. Missing or malformed wire evidence rejects the batch. PAYVER 2 is
   unsupported for this whole-response recipe; never accept a reassembled sample
   whose evidence contains only its final fragment.
2. Read response bytes without filtering, using `Buffer.toString('latin1')` to
   preserve every byte. Node's ASCII decode masks the high bit and UTF-8 can
   replace bytes; neither is suitable. For an ALLDATAMOD envelope, consume
   each command marker `0xF1` through `0xFF`, its unsigned one-byte length, and
   exactly that many bytes. Refuse incomplete headers, overruns, duplicate slots,
   and trailing unframed bytes. A bare response body remains eligible for the
   same strict text parser. A body that starts as an envelope must never fall
   back to bare parsing after an envelope error. Never delete control bytes.
   Each wrapped command body must independently match one complete addressed
   record. Empty blocks, a record split across blocks, and multiple records in
   one block reject; concatenation must not manufacture valid response framing.
   Preserve all recovered bodies in the rejection evidence before this check.
3. Derive the battery voltage from the actual header. Pass the byte-preserving
   response string to the existing address/value parser. An invalid envelope or
   unsupported transport yields `rejected_framing`, battery-only canonical data
   where available, and retained original payload evidence. Use the existing
   disposition set; no schema change.
4. Preserve valid configured address mapping, pF conversion, raw/canonical atomic
   writes and no-discovery behavior. Mirror every payload edit into bcm2709.

Resolve the configured Tensiomark layout before the write handler's existing
`quarantineOnly` early return. For that configured branch, bypass capped
quarantine and retain original bytes plus a rejected observation when an
unsupported PAYVER or reassembly reset reaches the handler. Other profiles keep
their existing quarantine behavior. PAYVER 2 fragments buffered by the common
gate still await completion/reset there; this whole-response recipe does not
support segmented acquisition and must never accept its completed output as
wire-verified Tensiomark evidence.

Dragino documents command/length envelopes in its
[SDI-12-LB/LS manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/),
section 2.3. This envelope interpretation must also pass the previously captured
whole-response payloads in private evidence.

First add failing tests through the real codec, gate and write handler in
`scripts/test-tensiomark-runtime.js`. Cover a valid wrapped two-probe reply,
TAB/NUL/backspace and high-bit bytes inside values, wrapper length truncation,
duplicate command slots, absent wire bytes, and a completed PAYVER 2 sequence.
Include unsupported-PAYVER and reset messages already carrying `quarantineOnly`,
a high-bit encoded digit `0xB1` retained as U+00B1, and a decoded battery value
that disagrees with the actual header.
Assert rejected input never writes soil channels, keeps its original base64,
and retains the invalid response byte where a body was recovered. Update earlier
runtime fixtures that used `AAEC` with unrelated decoded text to use real wire
payloads. Those fixtures must no longer represent valid acquisition.

Run `node --test scripts/test-tensiomark-runtime.js` before and after the fix.
Then run the normalizer and commissioning suites, `node scripts/verify-sdi12-codec.js`,
`node scripts/verify-profile-parity.js`, and the relevant flow verification gates.
An independent reviewer must re-run the malformed-wire probe through production
ingest and confirm it fails closed, while recorded valid packets still normalize.

## Cloud history boundary

In the sister repository,
`backend/src/main/java/org/osi/server/history/JdbcHistoryScopeReader.java` already
has `readJsonMap`. Extend `SCOPE_SQL` beside `device_state_json` with
`CAST(d.sdi12_channel_layout_json AS TEXT) AS device_sdi12_layout_json`.
In its device builder add
`.sdi12ChannelLayoutJson(readJsonMap(rs.getString("device_sdi12_layout_json")))`.
No new parser, defaults, migration or root-zone contribution is needed.

First extend
`backend/src/test/java/org/osi/server/history/RootZoneHistoryScopePostgresIT.java`
with a real PostgreSQL regression. Register an assigned, owner-claimed SDI-12
device with a valid two-sensor Tensiomark layout, both depths null, and current
state `{"sdi12_error":"no_response","bat_v":3.6}`. Store an earlier sample with
`swt_1=0.1`, `swt_2=12.5`, `soil_temp_1=16.11`, `soil_temp_2=18.25`.
Use synthetic identities `111TENSIOMARK_2Vh_10A00001` and
`411TENSIOMARK_2Vh_10A00002` in the layout, with the existing explicit
`pF`, `temperature_pf`, `bench_observed` and `unverified` fields.

Assert the authorized JDBC snapshot exposes exactly the four configured channels;
the catalog lists them with null depths and kPa/°C units; all four
analysis series remain accessible; and raw zone CSV contains the four canonical
rows plus the two derived pF rows with empty depths. Keep current missing values
missing. Run the test red before the projection fix and green afterward, followed
by the soil policy and catalog suites. The cloud reviewer must independently
re-run the PostgreSQL test and review the exact diff.

## Deployed card navigation

The private cloud overlay added a Details link to `DeviceCardFooter`, gated on
its `deviceEui` prop. Its `frontend/src/components/farming/Sdi12SoilCard.tsx`
caller omits that prop. Other device cards pass it, so an unassigned Tensiomark
has no link from its card to the full device-history page.

In the private cloud worktree, first add a rendered MemoryRouter regression for
the SDI-12 card, asserting the Details link points to
`/devices/<fixture-device-eui>`. Watch that assertion fail, then pass
`deviceEui={deviceEui}` to the existing footer. Keep this overlay-specific fix
in the private branch. A route-string guard alone does not verify navigation
from the card; record the rendered assertion as the evidence.

## Release and acceptance

Commit generic fixes in the public feature worktrees and port those commits to
the private deployed branches. Do not push customer refs. Build and verify the
new candidates before replacing any live payload, retain a rollback artifact,
and check current monitor state before deployment. The radio handover remains
owned by its existing watcher; do not duplicate its writes or change the sensor
recipe. Record actual deployed hashes after activation.

Field acceptance requires a fresh target-network session, addressed readings from both
probes, one atomic raw/canonical row and a cloud row matching its timestamp and
four values. Inspect multiple cycles for continuity when available. Chart/API
checks require an ordinary authenticated session; neither missing browser access
nor a synthetic fixture is proof of a successful live view. Installation depths,
zone assignment and calibrated hardware range remain unknown until established.

## Follow-up: unverified calibration presentation

The acceptance review also found that the edge Tensiomark card uses the generic
wet/moist/dry status indicator even when its explicit layout declares the
calibration range unverified. Remove that indicator only for Tensiomark layouts
and show the existing calibration-range note. Keep measured kPa, derived pF and
temperature visible; do not change thresholds or other probe cards.

Use the existing language mechanism for the Tensiomark note and its depth/unit
labels, correcting the English text in the German Tensiomark locale block where
needed. Cover the unverified case in a rendered card test, verify that another
probe still renders its ordinary status, and rerun the focused frontend tests,
typecheck and build. Review the patch independently before porting it to the
customer edge and deploying the updated GUI.
