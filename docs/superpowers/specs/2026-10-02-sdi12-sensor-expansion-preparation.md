# SDI-12 sensor expansion: implementation preparation

Date: 2026-10-02. Status: proposed scope and work breakdown; hardware recipes
remain subject to the evidence gates below. Revised 2026-10-03 after external
review; the [review decisions](2026-10-03-sdi12-review-decisions.md) explain the
corrections and the evidence required for the next transport design.

Extend the unfinished PR2 shared framework to ecoTech Tensiomark, METER TEROS 11
and TEROS 12, and HydraScout. Preserve the existing Sentek installation path.
The deliverable is one setup, acquisition, storage, and presentation path with
probe-specific definitions. Each sensor family can reach hardware acceptance
independently once the common foundation is available.

This preparation supplements the
[PR2 shared-framework draft](2026-09-29-pr2-shared-sdi12-design.md). That draft is
still marked proposed, and its local file was untracked when inspected. It has
not been rewritten or treated as completed implementation. This document records
the additional requirements and stages; it is not a zero-placeholder execution
script for hardware whose protocol settings have not yet been established.

## Scope and assumptions

The user requested preparation for all four families while retaining the
unfinished PR2 work. The working assumptions are Dragino SDI-12-LB/LS converters,
one probe per converter, and fixed installations. A multi-depth PR2 or HydraScout
is one probe. Multiple separately addressed probes on one bus require another
design for discovery, addressing, cycle scheduling, and channel ownership.

“Hydrascrout” is interpreted as HydraScout. Its exact factory configuration and
depth count are not known. The installed TEROS firmware and Tensiomark variant
are also unknown. Use mineral-soil calibration for the first PR2 and TEROS
release, subject to confirming the actual installation medium. Other media and
custom calibration need explicit profile settings and their own test vectors.

Local and cloud dashboards must expose configured measurements, depth labels,
history, and exports. This work adds no irrigation policy or automatic enrollment
of new measurements into control. Production access and device reconfiguration
are outside this preparation.

## Verified starting point

Inspected edge checkout: `1939a04a6`, branch `main`. Cloud findings refer to the
local `/home/phil/Repos/osi-server` checkout at `1a473bef`, not the production host.

The canonical helper directory is
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`. In the table,
helper paths are relative to that directory. Runtime edits must also reach the
byte-identical bcm2709 mirror.

| Surface | Current behavior | Required preparation |
|---|---|---|
| `osi-sdi12-normalize/index.js` | PR2/4 and PR2/6 both accept learned variable VWC counts; no default depths | Implement the exact variant contracts already proposed in the PR2 draft |
| Same registry | Tensiomark is provisional: two values, pF then temperature | Confirm mode/order, validate raw domain, and remove sensor-inappropriate clipping through a versioned profile |
| Same registry | HydraScout is provisional: six values, assumed VWC/temperature/EC interleave at two depths | Replace assumptions only from the installed model's protocol and captures |
| Same registry | No TEROS 11/12 entries | Add separate model profiles with a shared calibration transform |
| `osi-sdi12-recipe/index.js` | Only `compileSentekRecipe`; eight command slots, eight-second power window, 1,200-second interval | Preserve Sentek output while introducing profile-owned acquisition parameters |
| `osi-sdi12-reassemble/index.js` | PAYVER 2 reassembly already exists; ten-minute window, maximum 15 segments | Reuse and test against each new recipe's real segmentation |
| `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx` | Sentek-specific layout and apply workflow | Resolve setup controls and actions from profile capabilities |
| `web/react-gui/src/components/farming/Sdi12SoilCard.tsx` | Multiple quantities supported, with a separate Sentek layout path | Render the shared resolved channel description, including before first sample |
| `osi-server/frontend/src/components/farming/Sdi12SoilCard.tsx` | Reconstructs EnviroSCAN/TriSCAN rows from VWC/VIC metadata | Extend cloud rendering to tension, temperature, and EC through the same description |
| `docs/contracts/sync-schema/resources.schema.json` | `sdi12_channel_layout_json` is the existing Sentek contract | Add a versioned configuration contract; retain the deployed field's meaning |

The channel manifest at `web/react-gui/src/channels/channels.json` currently
provides ten VWC channels (%), eight soil-temperature channels (°C), eight soil-EC
channels (µS/cm), and three tension channels (kPa). TEROS needs no new measured
quantity. HydraScout can use at most eight complete VWC/temperature/EC depth
groups within those existing channel families. This is a storage ceiling, not
a claim that every eight-depth acquisition recipe fits the converter.

Two read-only probes exposed Tensiomark normalization defects:

| Input to current `TENSIOMARK` normalizer | Current stored tension | Required behavior |
|---|---|---|
| `+4+20` | 300 kPa | A validated pF 4 reading converts to 1,000 kPa under the OSI conversion convention |
| `-9999+20` | 0 kPa, no quarantine | Reject the invalid pF input before exponentiation |

The second example is an adversarial invalid input, not a claim that Tensiomark
uses `-9999` as its documented error code. Actual sentinel values must come from
its protocol documentation. Existing tests passing does not cover these cases.

## Shared design

Retain `DRAGINO_SDI12` as the converter device type and extend the static profile
registry. Per-probe device types or cards would repeat the setup and history
logic; a dynamic plugin framework would introduce packaging and compatibility
work without helping these known profiles.

The PR2 foundation must resolve a versioned configuration into stable canonical
channel keys, physical depths, units from the manifest, and display order. Add
the following requirements to its profile boundary:

- A profile owns raw response shape, firmware compatibility, source units,
  calibration identity, error sentinels, valid raw ranges, and transforms.
- Acquisition compilers own measurement commands, retrieval sequence, response
  cuts, startup/measurement timing, and power requirements. They return bounded
  converter frames; neither React nor a cloud caller supplies executable commands.
- A pinned interpretation digest covers versioned rules and calibration settings;
  the full configuration hash additionally covers address and depth metadata.
  Two configurations with equal value counts can still mean different
  quantities, so shape alone cannot establish acquisition compatibility.
- Desired configuration and observed acquisition revision remain separate.
  During partial apply, ambiguous readings remain unavailable. A saved profile
  must never reinterpret payloads from the previously installed recipe.
- Framing/count failures and non-finite values quarantine the sensor vector while
  retaining battery diagnostics. All TEROS sentinels are vector-fatal. A PR2
  per-depth range failure or TEROS VWC range failure may omit that channel and
  retain others as `partial`, after checking every field for a fatal failure.
  This policy requires established positions and cycle completeness in live use.
- Keep normalization on the edge. Cloud stores and presents the canonical values;
  it must not apply the calibration again.

Preserve legacy Sentek layouts with an adapter. Software upgrades must not send
configuration downlinks. Existing provisional sensor histories also remain
unchanged: changing a profile definition does not recalculate or relabel old
samples. The history contract below preserves the interpretation attached to
each observation.

The proposed normalization boundary returns
`{ disposition, channels, diagnostics, configurationRevisionUuid }`, with
`disposition` in `complete`, `partial`, `quarantined`, or `no_response`. Validate
the complete raw vector and its per-position policy before returning channels.
`quarantined` and `no_response` carry no sensor channels. The versioned PR2 and
TEROS VWC range policy above permits partial acceptance; other failures remain
vector-fatal. A partial vector is not a healthy commissioning observation.
Keep battery handling outside this decision. The writer must commit the accepted channels, diagnostics and
revision reference as one observation, not commit channels while validating them.

Cloud setup must use capability-gated REST pending commands and the same edge
validation as local setup. Duplicate command delivery, reconnect, or bootstrap
must not repeat a physical apply. Preserve queue ownership, conflict detection,
partial failure reporting, and the distinction between queued and observed.

### Proposed configuration and history contract

These are proposed new names for the implementation stages, not existing APIs.
Use immutable `sdi12_configuration_revisions` records keyed by `revision_uuid`,
owned by a device EUI, with descriptor version, profile/version, address,
validated settings, resolved channels, configuration hash, and creation time.
Track desired and observed evidence separately. Start edge-local with a sidecar
keyed by `device_data.id`, written in the measurement transaction, retaining raw
ASCII, received tag, frame counters/session context, diagnostics, disposition
and immutable acquisition/presentation revision references. Unknown provenance
keeps a null revision; a saved desired revision is not evidence of production.
Do not change the existing canonical history hash in this edge-local stage.

A later paired cloud stage carries references through device history,
correction payloads, canonical hashing and exports. Replicate referenced revision
records through an additive
`SDI12_CONFIGURATION_UPSERTED` event and a `sdi12Configurations` snapshot
collection. Bootstrap and offline catch-up must include revisions referenced by
the transferred history, not only the latest configuration. An observation
arriving first retains its UUID and canonical values but shows unknown depth or
configuration until its descriptor arrives. History groups by revision and
channel; two different depths must not become one unlabeled series. Old peers
must be capability-gated out of receiving the new event and metadata; the paired
contract plan must prove legacy telemetry delivery remains compatible.

Existing measurements get a null revision reference, with historical depth
reported as unverified where no retained evidence establishes it. Do not stamp
all old rows with today's layout. Accepted candidate channels require an eligible acquisition revision selected
from retained evidence; unknown provenance stores diagnostics/raw data only. Retain referenced descriptors for as long as their history exists.
The first persistence migration is edge-local. Cloud migration, resource schemas,
history codecs and hash vectors belong to the later paired stage, with server
support deployed before new edge emission. Choose migration numbers only against
the actual implementation bases. Until then, cloud history cannot claim verified
revision-specific depth labels.

Proposed request descriptor `Sdi12ConfigurationV1` contains `version: 1`,
`revision_uuid`, `base_revision_uuid`, `profile_id`, `profile_version`, `address`,
`settings`, and `depths`. Clients supply supported settings; the edge resolves
canonical channels and units itself. No client-supplied transform or frame is
accepted. Stale base revisions are rejected visibly.

| Proposed API or command | Contract |
|---|---|
| Local `PUT /api/devices/:deveui/sdi12/configuration` | Validate and save the descriptor; return desired revision and resolved channels; no physical action |
| Cloud `PUT /api/v1/devices/{deveui}/sdi12/configuration` | Authorize device access and enqueue `UPSERT_SDI12_CONFIGURATION` carrying the same descriptor; return pending command ID |
| Local `POST /api/devices/:deveui/sdi12/acquisition/apply` | Accept `{ revision_uuid, request_uuid }`; require the saved desired revision and return deployment status |
| Cloud `POST /api/v1/devices/{deveui}/sdi12/acquisition/apply` | Enqueue `APPLY_SDI12_ACQUISITION` with the same request; require the revision to be acknowledged by the edge before offering apply |
| Capability `sdi12_configuration_v1` | Gate new commands, descriptors and revision-aware history; cloud cannot offer apply to older gateways |

Keep legacy routes unchanged during transition. The proposed configuration
effect key is `sdi12:configuration:{device_eui}:{revision_uuid}`; apply uses
`sdi12:apply:{device_eui}:{request_uuid}`. Add these formats to `effect-keys.md`
with exact intent-hash matching: reusing a key with a different descriptor or
revision is a conflict. Persist the accepted command/result and deployment
claim before enqueueing physical frames. Redelivery returns that result; an
interrupted apply must not blindly re-enqueue. An intentional operator retry
creates a new request UUID and remains subject to queue checks.

Replicate bounded `sdi12_configuration` and `sdi12_acquisition` device resources
with desired/observed revision UUIDs, deployment/request UUID, state, reason code
and observation timestamp through incremental updates and snapshots. Preserve
the existing queued/observed-once/observed-compatible/degraded distinctions.
An apply ACK reports edge acceptance, not successful probe configuration.

At any acquisition change, fence the old reassembly buffer before new data can
be interpreted. Current reassembly can combine complementary losses from separate
cycles; fixing cycle provenance precedes candidate live activation. PAYVER is a
configurable byte, while DATAUP controls layout. A future tag mapping may provide
useful evidence, but observing a final tag does not prove intervening command
writes, probe settings or sample freshness. The transport design must cover tag
exhaustion/reuse, session resets, late samples, partial apply and restart, and
retain the legacy 1/2 layout convention. See the review decisions for requirements.
If a fresh-cycle boundary cannot be established, automatic multi-segment activation
across configuration changes remains unsupported.

## Sensor-specific requirements

### PR2: finish the existing work first

Keep `DELTAT_PR2_4` and `DELTAT_PR2_6`. Their new verified profile versions require
exactly four and six measurements and the depths defined in the existing draft.
Remove learned-count behavior only for those new versions. Complete the
calibration/command readback and multi-response
retrieval work already identified there before marking either recipe verified.

The draft's correction to `M!` semantics remains a dependency. A four- or
six-number response alone does not prove VWC. Keep PR2/6 as the first hardware
target, and record PR2/4 hardware acceptance separately.

For existing PR2 installations, retain a legacy interpretation descriptor with
the saved learned count and channel mapping. Do not replace it merely because
the profile ID has a new fixed-count definition. Transition to the new revision
only after verified acquisition, atomically with the observed revision change.
An upgrade must not rewrite the live profile interpretation or send downlinks.
Record its legacy/unverified status. Add upgrade, interrupted apply and rollback
fixtures that preserve current acquisition and historical channel identity.

### TEROS 11 and TEROS 12

METER's June 2025 integrator guide targets firmware 3.00 or newer. Its `aM!`
followed by `aD0!` returns `calibratedCountsVWC` (ADC counts, not VWC), temperature, and, for
TEROS 12, bulk EC in µS/cm normalized to 25 °C. Model strings distinguish
`TER11` and `TER12`. The guide lists `-9999`, `-9992`, and `-9991` as errors.
It also documents a startup DDI string and recommends a nonzero SDI-12 address
to suppress it. Do not infer support for older firmware from this guide.
([Integrator guide](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf),
pp. 1, 5–10.)

Proposed profile IDs: `METER_TEROS_11` and `METER_TEROS_12`. For the quantities
described in the
[TEROS user manual](https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf), map to
`vwc_1`/`soil_temp_1`, plus `soil_ec_1` for TEROS 12. Require two and three
values respectively, and an explicitly entered installation depth. Reject
documented error codes before calibration; they must never become dry-soil zeros.
Keep bulk EC distinct from Sentek VIC and from pore-water conductivity.

Use the manufacturer's mineral calibration, converted from m³/m³ to OSI percent,
in one tested transform. Read equation 6 in the
[TEROS user manual](https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf),
§4.1.1, when implementing it; retain the equation/version with the profile. Do
not use the generic VWC identity transform, infer a calibration from value size,
or clamp an out-of-range result into a believable moisture value.
The candidate treats `calibratedCountsVWC` as the equation's `RAW` input. The
manual's raw-count examples support that interpretation, but do not explicitly
name the integrator field in the equation. Require METER confirmation or a
firmware-qualified capture with an independent comparison before release.

Prefer the documented measurement/data sequence as the initial compiler target.
The guide's concurrent implementation is nonstandard, so do not assume PR2's
concurrent recipe transfers. Capture startup and the full response before pinning
power delay or byte cuts. The documented temperature range starts at −40 °C;
the current shared normalizer rejects below −30 °C. Introduce profile-specific
range validation and regression-test existing profiles rather than widening
every sensor's accepted range. (Same integrator guide, pp. 2, 5, 8.)

### Tensiomark

The [ecoTech May 2014 manual, §§5.1.5 and 7](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf)
documents pF and temperature over SDI-12, without an hPa output mode. Candidate
version 2 requires explicit variant `1` (4244/1), pF 0..7 and −40..80 °C.
hPa and other variants remain unavailable pending evidence for those profiles.
Circulated manuals disagree on variant 3's maximum; installation evidence must
identify the actual calibrated range rather than guessing from its name.

Under OSI's canonical convention, pF converts with `10 ** pF / 10`. Store
positive suction in `swt_1` and temperature in `soil_temp_1`. The manual's
15–20 s warm-up and 8 s SDI-12 measurement reply rule out copying Sentek's 8 s
power window. Account for supply/current requirements and the 15 min minimum
cycle when designing a compiler. Response order and error values still need
vendor confirmation or captures.

Validate source range and error codes first. A valid pF zero is 0.1 kPa; a
negative or implausibly large pF must not survive exponentiation as a reading.
The proposal is to preserve the verified full range in canonical kPa with
profile-specific bounds, without the existing 300 kPa clamp. Audit writer,
sync, exports, charts, and scheduler consumers before enabling that behavior.
The Chameleon range and irrigation policy are separate contracts and must retain
their existing behavior.

Keep the existing profile ID compatible through definition versioning. Existing
rows that were clipped cannot be reconstructed without retained raw evidence.
Do not silently backfill them. The commissioning record must establish output
mode, installation depth, supply/current capacity and power timing; copying
Sentek's eight-second window is not evidence that Tensiomark measurements finish.

### HydraScout

The manufacturer describes a factory-configurable multi-depth probe using
SDI-12, with water, temperature, and salinity measurements. Its public page
does not establish command/response ordering, calibration, EC units, or fault
encoding. HydraProbe documentation belongs to another product and must not be
used to fill these gaps.
([HydraScout product description](https://www.hydrascout.co/?lang=en).)

Resolve an explicit installed layout from the manufacturer's configuration:
depth count, physical depths, response positions, quantities, source units,
and calibration. Do not learn a mixed-quantity layout from response count.
The existing six-value interleave, EC interpretation, and 15/30 cm defaults
remain hypotheses until verified. Only map conductivity into `soil_ec_n` when
the reported salinity quantity is established as the corresponding EC quantity.

Even the existing two-depth profile is not guaranteed to fit one uplink:
the current worst-case budget is `3 + 6 * 9 = 57` bytes against a 51-byte
single-frame limit. Reuse PAYVER 2 where required. For the current helper's
42-character slice assumption, eight triplets require
`ceil(24 * 9 / 42) = 6` segments. Both figures are software budgeting estimates,
not captured HydraScout payload widths. Verify command-slot capacity, SDI-12
response splitting, all cuts and actual LoRaWAN frames on the installed model.

Keep unsupported layouts explicitly unavailable. Extending beyond eight complete
triplets requires a separately reviewed channel/storage/sync extension; never
truncate a deeper probe to the first eight groups.

## Work to complete before the bench session

Physical sensor access is not a prerequisite for the shared software work.
The user is away from the sensors; the next delivery target is a system that
can be exercised locally, with bench-dependent assumptions recorded explicitly.
The earlier implementation sequence describes release acceptance. Its hardware
gates must not be used to postpone development of configuration, normalization,
presentation, or synchronization.

Three separate facts must remain visible: the software handles its declared
contract, the vendor documentation supports that contract, and an installed
probe/converter combination has demonstrated it. Passing a synthetic fixture
establishes only the first. A profile can be ready for bench testing while its
acquisition recipe remains provisional.

| Work package, in dependency order | Deliverable possible remotely | Evidence required before bench testing | What still needs the physical sensor |
|---|---|---|---|
| 1. Profile contract and normalization | Versioned profile resolver; legacy Sentek/PR2 adapters; PR2 exact-variant definitions; TEROS calibration and error handling; Tensiomark raw-domain validation; HydraScout explicit-layout validation | Pure tests for accepted settings, exact cardinality, source units, transforms, ranges, errors, real zero and legacy compatibility | Installed firmware/mode and captured response mapping; HydraScout's actual quantity/order contract |
| 2. Transport evidence design and simulation | Tag/layout mapping proposal, counter/session rules, acknowledgement semantics and failure/recovery simulations | Lost middle downlink, late pre-apply sample, mixed cycles, session reset and tag exhaustion must fail closed | Supported PAYVER range, command ordering/application and segment counter behavior |
| 3. Durable configuration and history | Revision tables, measurement references, desired/observed separation, migration and restart behavior | Fresh/upgrade database rehearsals; old rows preserved; historical depth labels stable across configuration edits; malformed or unknown revisions handled visibly | No hardware needed to implement or verify persistence behavior |
| 4. Acquisition and commissioning | Shared compiler dispatch; deterministic candidate PR2/TEROS recipes from documented commands; dry-run preview; queue state machine and transition fencing | Byte-level frame fixtures; command-slot/payload budgets; simulated partial queue acceptance, restart, retry, duplicate requests, stale observations and rollback | Actual startup/measurement time, cut behavior, delivery, power budget and a trustworthy fresh-cycle boundary |
| 5. Local farmer workflow | Profile/depth/unit/calibration setup; save separate from apply; all declared quantities on cards/history/exports; diagnosis and unavailable states | Component and browser checks with synthetic API data, including configured-but-never-observed channels and stale readings | Comparison with live readings and commissioning status |
| 6. Cloud parity | Paired configuration/apply endpoints and REST commands; revision events/history sync; matching cloud UI | Local edge/cloud integration tests for auth, stale revisions, idempotency, reordered delivery, offline catch-up and older peers | A final live end-to-end smoke test after each recipe is validated |
| 7. Bench handoff | Capture format, replay cases, candidate recipe report, expected values, wiring/source references and a stepwise checklist | A new capture can be added without changing test infrastructure; incomplete evidence cannot claim hardware verification | Fill the record with actual identity, settings, replies, frames and comparison readings |

Packages 1–6 should be developed before scheduling the bench session. Package 7
starts alongside them. Split execution into reviewed plans by work package;
do not turn the full expansion into one large edge/cloud change. Start with
the profile resolver and legacy regression fixtures, because persistence,
compilers and both UIs need that same interpretation of a configuration.

### Reuse the existing offline test infrastructure

`scripts/verify-device-integration.js` already drives the real codec,
reassembler, normalizer and writer into temporary SQLite databases. Extend its
SDI-12 fixtures rather than build another parallel simulator. Preserve the
captured Sentek vectors as regression evidence and label generated sensor cases
as synthetic.

`osi-sdi12-commissioning/index.test.js` already simulates ChirpStack and covers
queue conflicts, concurrent applies, partial enqueue, restart deadlines,
rollback, duplicate timestamps and compatible observations. Extend those tests
for the profile-independent compiler and revision transition. The flow harness
in `scripts/lib/flow-node-harness.js` exercises the real authenticated Node-RED
functions against temporary databases; it can verify the new routes and REST
command handlers without a gateway.

Build the following additional cases into those existing suites:

- PR2/4 and PR2/6 exact variants, plus legacy learned-count configurations that
  survive upgrade and a cancelled transition unchanged.
- TEROS 11/12 independent expected percentages from the documented calibration,
  exact two/three-value shapes, zero EC, negative temperature and each documented
  error code before transformation. A model identity alone cannot activate a
  recipe whose firmware contract has not been established.
- Tensiomark pF zero, invalid negative pF, valid readings above the old clamp,
  variant selection and rejection of unsupported hPa semantics. Exercise candidate
  version behavior
  without silently changing the interpretation of existing installations.
- HydraScout synthetic layouts with two and eight depth groups, multiple
  response blocks and transport segments, missing values and unsupported depth
  counts. These test the framework; they must not pretend to establish the
  actual HydraScout wire order or salinity unit.
- Same-shaped configurations with different units/calibration, reordered or late
  frames, and a save/apply interruption. The former recipe must not be decoded
  under the latter configuration merely because the value count matches.

### What to resolve remotely rather than defer to the bench

Finish the error policy and legacy adapters in the offline correction. Establish
the transport evidence contract before finalizing the schema/API and immutable
revision model. These software designs do not require measuring a sensor, but
activation still depends on the unresolved device behavior.
Review existing raw-capture provenance before writing new fixtures. Research
the manufacturer protocol documents by model and firmware; prepare a precise
request for any missing Tensiomark/HydraScout command tables, response units,
error codes and timing specifications. Sending that request is a separate
user-authorized communication, not an automatic part of this plan.

For cross-version rollout, distinguish gateway capabilities from cloud reader
support. The edge advertising `sdi12_configuration_v1` does not establish that
an older cloud accepts a new event or history field. The cloud package must define and
test server support negotiation or a server-first rollout gate before the edge
emits the new contract. Also verify how unsupported configurations remain
visible locally while the existing telemetry contract continues to work.

Produce candidate recipe previews from source-backed parameters. Parameters
that lack protocol evidence must be reported as unresolved, with compilation or
apply unavailable for that candidate. Do not invent HydraScout byte cuts or
Tensiomark power timing to make a preview appear complete. Software tests can
still verify compiler rejection and the rest of the workflow with synthetic
fixtures.

### Ready-for-bench acceptance

Before travelling to the sensors, the implementation should support selecting
each candidate profile, saving a versioned configuration, viewing every
configured channel without a measurement, and replaying supported synthetic
data through storage, local/cloud history and exports. Queue and sync failure
cases must already pass. The handoff must list the few observations that can
change each candidate recipe and provide the exact capture/replay procedure.

This is a future software acceptance target. The preparation document and the
existing baseline suites do not mean those new capabilities have been built.

## Implementation sequence and acceptance

Each stage needs an execution plan with exact edits after its input decisions
are fixed. Use isolated worktrees for implementation and paired edge/cloud PRs
where contracts or mirrored behavior change. Recheck both bases before assigning
migration numbers. Schema changes use ordered migrations, never `sync-init-fn`.

| Stage | Concrete changes | Acceptance before proceeding |
|---|---|---|
| 1. Common offline profiles | Versioned descriptors, rule/hash pins, legacy adapters and preview tooling | Known defects corrected; profile version 1 refused; no live interpretation changes |
| 1a. Transport evidence | Define tag/layout, counter/session and ACK contracts; simulate failed applies and mixed cycles | Evidence limitations explicit; candidate activation stays disabled until the boundary is established |
| 1b. Edge-local persistence | Immutable revisions, measurement sidecar and desired/evidence separation via ordered migrations | Atomic provenance writes; old rows remain unverified; canonical history hashes unchanged |
| 2. Acquisition dispatch | Extend `osi-sdi12-recipe` and `osi-sdi12-commissioning`; adapt SDI-12 nodes in both `flows.json` profiles and `scripts/test-sdi12-recipe-flow.js` | Existing Sentek frame fixtures remain identical; compiler dispatch is profile-driven; partial apply and old-recipe observations cannot activate a new interpretation |
| 3. Shared farmer surfaces and cloud contract | Update local settings/card, history/export consumers, `zoneSoil.ts`, corresponding cloud surfaces, sync handling and manifests where needed | Configured VWC, tension, temperature and EC render without readings; real zero survives; stale data stays stale; events/bootstrap/offline catch-up preserve the descriptor; older peers cannot receive unsupported setup commands |
| 4. PR2 completion | Exact variant profiles, mineral acquisition compiler, command readback and captured fixtures; correct the illustrative recipes in `docs/devices/dragino-sdi12.md` | PR2/6 passes the whole path on hardware; PR2/4 software checks pass and hardware status is stated separately |
| 5. TEROS 11/12 | Model profiles, calibrated-count transform, sentinel handling, temperature bounds, acquisition adapter and fixtures | Each model's count/order and calibration pass independently; no EC invented for TEROS 11; startup, negative temperatures, EC zero, errors and older firmware behavior are tested |
| 6. Tensiomark | Confirmed variant and pF output, raw validation, range audit, profile-specific normalization, acquisition adapter and fixtures | Unsupported units refused; invalid pF cannot become zero; valid high tension retains its value; unrelated tension sensors and control behavior regressions are excluded |
| 7. HydraScout | Validated installed layout, verified quantity transforms, response grouping and segmented acquisition fixtures | Every configured depth reaches both dashboards and export; wrong order/count, incomplete cycles, unknown salinity meaning and oversized layouts remain unavailable |
| 8. Release evidence | Update device documentation and add dated commissioning records; perform independent verification | Each released profile has a firmware/configuration-specific capture chain and comparison reading; unverified profiles retain explicit status |

Stages 5–7 depend on the common foundation, but one family's missing hardware
evidence need not block another family's release. PR2 remains the first complete
integration target. Do not call the whole expansion implemented when only
registry entries exist.

Stage 3 includes `configuredSdi12Keys` and `buildDeviceHistoryModel` in
`osi-server/frontend/src/pages/deviceHistoryModel.ts`, which currently select
only VWC/VIC keys for SDI-12. Replace that selection with the resolved descriptor.
Update `SentekChannelLayout` consumers in both `src/types/farming.ts` and API
normalizers through the compatibility adapter. The edge card's non-Sentek path
must render configured channels before a value exists. In
`web/react-gui/src/utils/zoneSoil.ts`, replace the profile-name assumptions in
`isTensionSensor` and `isVolumetricSensor` with declared quantities; an unknown
SDI-12 profile is not evidence of VWC. Test empty, partial, stale and real-zero
observations on the cards, zone summary and cloud history.

## Fixture and hardware evidence requirements

Use `scripts/fixtures/device-integration/sdi12/golden-vectors.json` and each
helper's `index.test.js` for software cases. Mark synthetic vectors as synthetic;
capture-backed cases must identify their source record. The shared profile
contract needs a fixture-only extra profile that exercises setup, rendering,
history and sync without adding a model-name condition to those consumers.

For each probe/model/firmware combination, retain:

1. Probe and converter model/firmware, interface variant, address, installed
   depths, power arrangement, and calibration/output-mode readback.
2. Exact identity response and measurement command/reply bytes, including
   address, signs, terminators, all data-response blocks and announced wait time.
3. Converter configuration and complete FPort 2 frames, plus FPort 100 debug
   responses where used. Keep join keys and other credentials out of fixtures.
4. Expected canonical values with an independent calculation or trusted reader
   comparison, then the stored row, API result, local/cloud history and export.
5. Fault/no-response case, a cold power cycle, interrupted acquisition and a
   configuration transition. Include multi-segment missing/duplicate/late data
   where segmentation is used; a time window alone does not prove cycle identity.

Required negative software cases include wrong cardinality, ambiguous identity,
unknown firmware/profile versions, invalid source domains, sentinels before
transforms, missing and real-zero values, stale learned counts after profile
changes, and same-shaped old/new recipes during partial deployment. If the
converter does not expose enough evidence to distinguish cycles or revisions,
keep those observations untrusted rather than asserting compatibility.

## Validation commands and evidence from this preparation

These commands ran against the existing checkout on 2026-10-02:

```bash
node --test --test-reporter=dot \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
node scripts/verify-sdi12-codec.js
```

Both exited 0. The codec printed `verify-sdi12-codec: PASS`. The targeted
Tensiomark probes above reproduced the stated outputs. This is baseline evidence,
not acceptance of new sensor support. No sensor or gateway was contacted.

Implementation must add failing regression tests for the cases above, then run
the helper suites and codec verifier, `scripts/verify-device-integration.js`,
SDI-12 registration/recipe flow/schema tests, channel-manifest parity, sync
contract tests, profile parity and `scripts/verify-sync-flow.js`. Apply the
[surface-specific verification rules](../../../.claude/skills/osi-verification-commands/SKILL.md)
for actual schema, flow and GUI changes. Run edge GUI unit tests, typecheck and
build; paired cloud changes also require the sister repo's backend/frontend
gates and cross-repo contract comparisons. These wider gates have not been run
for this documentation-only preparation.

The follow-up remote-readiness audit also ran these existing suites, without
network or sensor access; both commands exited 0:

```bash
node --test --test-reporter=dot --test-name-pattern='SDI-12' scripts/verify-device-integration.js
node --test --test-reporter=dot \
  scripts/test-sdi12-registration.js \
  scripts/test-sdi12-recipe-schema.js \
  scripts/test-sdi12-recipe-flow.js
```

These passes establish that offline replay, database and flow testing are
available now. New profile, revision and cloud behavior still needs its own
implementation and regression evidence.

An independent read-only review identified the need for concrete revision
history, new cloud setup/apply commands, legacy PR2 migration behavior, a segment
transition fence, explicit TEROS count semantics, vector validation and the cloud
history fallback changes. Those requirements are incorporated above. Hardware
captures and executable implementation plans remain future work.

## Inputs still needed for executable sensor recipes

| Input | What it determines |
|---|---|
| Confirmation of converter topology and mineral-soil scope | Whether the existing one-probe model is sufficient |
| PR2 progress/captures outside this checkout | Which parts of the proposed foundation and recipe still need execution |
| TEROS 11/12 firmware and installed medium | Applicable guide, profile version and calibration |
| Tensiomark identity, calibrated variant and response examples | Installed range, field order, errors and power timing; no mode readback assumed |
| HydraScout model, factory depth layout and protocol manual | Channel mapping, calibration, EC meaning, commands, cuts and capacity |
| Captured SDI-12 replies and converter uplinks for each target | Which recipes can move from provisional to hardware-verified |

Missing protocol evidence blocks the affected recipe's activation. It does not
prevent implementing and verifying the shared configuration and presentation
foundation against explicit synthetic fixtures.
