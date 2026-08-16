# Dendrometer production readiness for 2027

**Status:** Deferred roadmap and acceptance contract. No production deployment is authorized by this document.

**Decision date:** 2026-08-16

**Target:** A production installation in 2027, after the gates in this document pass.

**Scope:** Dendrometer hardware, LSN50 MOD3 acquisition, edge persistence and sync, OSI v5/v6/RDI analytics, the Agroscope-compatible shadow, field commissioning, and operational controls.

## Decision

The full dendrometer package will not be completed or enabled for production in 2026. The current installation is a commissioning and research setup. Work resumes as a staged readiness program for the planned 2027 installation.

Until the production gate passes:

- dendrometer outputs are observational and advisory only;
- no dendrometer or Agroscope result may open or close a valve;
- Agroscope forwarding remains disabled except for an approved staging exercise;
- deadwood measurements may test electronics and data paths, but may not calibrate crop stress thresholds or validate tree physiology;
- saturated, physically implausible, stale, duplicated, or incomplete measurements are ineligible for analytics even when they can be stored for diagnosis.

This document is the program-level source of truth. The linked design documents remain useful component references, but their older sequencing and status statements do not override this roadmap.

## Current system boundary

The system contains several related implementations. They answer different questions and must not be treated as interchangeable.

| Layer | Current role | Authority | Production status |
|---|---|---|---|
| LSN50 MOD3 acquisition | Decode CH0/CH1, calculate a ratiometric position, preserve voltage and calibration context | Edge | Shipped, not field-qualified as a package |
| Edge v5 analytics | Compute local daily extrema, MDS, TWD, stress, and schedule policy | Edge | Shipped; current local behavior |
| Cloud v6 analytics | Compute self-calibrated `TWD_rel` and cloud recommendations | Cloud mirror | Shipped; thresholds still require field calibration |
| v6-RDI | Compare a regulated-deficit strategy with v6 | Cloud shadow | Compute-only |
| Agroscope-compatible implementation | Reproduce Agroscope stress, SEM aggregation, and PID dose logic | Cloud shadow | Implemented as an opt-in compute-only arm; not field-validated end to end |
| Agroscope IoT forwarding | Publish selected raw uplinks to an external broker | Edge egress | Shipped but disabled by default; live-only and without durable retry |
| Draft edge Agroscope controller | Future recommendation mode described in architecture | Edge | Design only; not shipped behavior |

The edge remains canonical for accepted sensor data and actuation. The cloud mirrors edge facts and may compute comparisons. External Agroscope services receive observations only and must not become a cloud-to-edge command path.

## Evidence from the 2026 commissioning run

The 2026-08-15 kaba100 exercise used four installed dendrometers on deadwood. It verified acquisition, calibration updates, repeated uplinks, local storage, analytics execution, and the relevant shadow tests. It did not simulate living-tree growth, transpiration, recovery, irrigation response, seasonal growth, or a production mounting environment.

The database was backed up before calibration changes. Baselines were reset, and the devices were observed through repeated acquisition cycles.

| Device | Observation during the run | Interpretation | Current disposition |
|---|---|---|---|
| D2 | Raw derived position was about 28 mm against a configured 25 mm stroke; samples were clamped at the high endpoint and marked saturated | The transducer or its endpoint calibration was outside the usable range. Clamping concealed the over-range magnitude from downstream consumers | Quarantine from analytics; bench-check mechanics, wiring, excitation, and both endpoint ratios |
| D3 | Position remained within range during the short run | Acquisition appeared plausible, but the run was too short and deadwood cannot establish physiological validity | Provisional hardware candidate; require bench and field qualification |
| D4 | Same high-end saturation pattern as D2 | Likely measurement range, endpoint, mounting, or calibration problem rather than an Agroscope algorithm effect | Quarantine from analytics; repeat the D2 checks independently |
| D5 | CH0 remained near 2.53 V while CH1 moved between about 2.56 V and 3.67 V, creating false position shifts of roughly 20–24 mm | Reference-channel instability, wiring, supply, input interpretation, or device mode is the leading cause. A physiological signal cannot move this way on deadwood | Quarantine from analytics; diagnose CH1 and confirm MOD3 payload layout before recalibration |

A short deadwood change of tens of micrometres may be electronics, temperature, mechanics, settling, quantization, or noise. It is not evidence of tree water status. D3's apparently plausible output is therefore not a passed field result.

## Causal assessment

The findings do not support one blanket cause. They separate into four layers.

| Finding | Reference Agroscope logic | Measurement or installation | OSI implementation | Assessment |
|---|---|---|---|---|
| D2/D4 above-stroke readings and saturation | Not involved; the fault exists before daily processing | Primary suspect: endpoint calibration, stroke mismatch, mounting, excitation, or wiring | Clamping preserves display bounds but can hide the severity if consumers use only the clamped value | Measurement first, with an implementation observability gap |
| D5 large apparent movement driven by CH1 | Not involved; the ratio is already corrupted at acquisition | Primary suspect: unstable reference channel, wiring, supply, or MOD3 interpretation | Ratio processing correctly reacts to CH1, but current validity semantics allow a finite yet saturated ratio to remain `dendro_valid=1` | Measurement first, amplified by insufficient eligibility gating |
| Saturated samples retained as valid | Not an Agroscope rule | Triggered by out-of-range hardware input | `dendro_valid` currently describes calculability more than agronomic usability; saturation is a separate flag | OSI semantic defect |
| Diagnostic fields missing or inconsistent in downstream history | Not an Agroscope rule | Not caused by installation | `device_data` holds richer facts than every projection and sync payload preserves; two write paths can produce different `dendrometer_readings` rows | OSI persistence and contract defect |
| Negative daily MDS | The Agroscope pipeline has its own windows and cleaning, but MDS itself should not represent a negative amplitude | Bad timing, steps, or missing windows can contribute | Edge extrema fallback can yield `d_max < d_min`, and `mds_um` is stored without a non-negative invariant | Mostly OSI analytics and QA semantics, with input quality as a trigger |
| Java shadow matches committed oracle vectors | Confirms the implemented clean-path formulas and selected quirks | Does not exercise installed hardware | Does not prove parity for raw dirty voltage streams, gaps, resets, duplicates, saturation, or DST | Useful unit-level evidence, not end-to-end validation |
| Agroscope high-water-mark, SEM, gap, DST, and rain behavior | Genuine properties of the reference implementation | Independent of sensor installation | A faithful arm should reproduce them; an OSI-corrected arm should label any deviations | Reference-model risks that matter after acquisition is trustworthy |

The priority order follows the signal path: qualify the instrument, preserve the evidence, enforce eligibility, then compare analytics. Tuning the Agroscope controller before those gates would fit algorithms to corrupted inputs.

## Canonical measurement contract

Production work must distinguish whether a fact is stored from whether it is safe to use.

### Measurement validity

`measurement_valid` answers whether the acquisition can be interpreted as a sensor measurement. It is false when required channels are absent or non-finite, the reference voltage is too small, the payload mode is incompatible, calibration parameters are missing, timestamps are invalid, or the decoder cannot prove the channel layout.

### Analytics eligibility

`analytics_eligible` answers whether the measurement may influence daily extrema, baselines, stress, recommendations, or controller state. It is false when the measurement is invalid, saturated, physically implausible, duplicated, out of order, stale, associated with an unqualified installation, or inside a settling or configuration-change window.

An ineligible measurement is still stored with its raw diagnostics. Missing or rejected data remains missing; it is never replaced with a plausible numeric default.

### Raw and bounded position

The contract preserves both values:

- `position_raw_um` is the unbounded calibrated result and is used for diagnosis, range checks, and controlled repair;
- `position_um` is the bounded display value, if a bounded value is useful;
- `dendro_saturated` and `dendro_saturation_side` explain any range violation;
- analytics consume only a position that passed `analytics_eligible`.

Clamping is presentation behavior, not validation.

### Calibration and baseline terms

Four operations must retain distinct names and timestamps:

- **Endpoint calibration:** maps the retracted and extended electrical ratios to the physical stroke.
- **Installation zero:** establishes the mechanical position after mounting and settling.
- **Signal baseline:** records the position used for relative stem-change display after a configuration epoch.
- **Physiological baseline:** uses a qualified run of good living-tree days to establish v6 `A_ref` and field thresholds.

Resetting an installation zero does not validate endpoint calibration. A deadwood baseline is not a physiological baseline.

Every measurement must be attributable to a calibration/configuration epoch containing the mode, stroke, endpoint ratios, direction, firmware or decoder version, and installation state.

## Target data path

The production invariant is:

> One accepted uplink creates one canonical `device_data` row, one deterministic diagnostic projection, and one accounted sync event set.

The target path is:

```text
LoRaWAN uplink
  -> raw payload and radio metadata
  -> mode-aware CH0/CH1 decoding
  -> raw ratio and unbounded position
  -> measurement validity and quality flags
  -> canonical device_data insert
  -> deterministic dendrometer_readings projection
  -> edge daily analytics from eligible rows
  -> edge-to-cloud sync with the same diagnostics
  -> v6 / RDI / Agroscope shadow comparisons
```

Required properties:

- `device_data` is the sole ingest authority.
- Only one path writes the `dendrometer_readings` projection for a canonical uplink.
- The projection carries CH0, CH1, ratio, mode, raw and bounded position, validity, rejection reason, outlier state, saturation, timestamp, and the configuration epoch.
- Projection and outbox writes are transactionally coupled or recoverably reconciled.
- History hashes and replay payloads cover every diagnostic field needed to distinguish hardware faults from processing faults.
- Updates used to repair history produce explicit correction events; relying on insert-only triggers is insufficient.
- Duplicate and out-of-order uplinks are idempotent and do not update deltas, baselines, daily extrema, or controller state twice.
- Retention policy preserves the raw evidence for at least the validation and dispute window.

The current schema contains many of these columns, but the production contract is not satisfied merely because columns exist. The seed trigger and outbox payload do not currently project the full field set, and the flow also contains a direct readings writer. Consolidating this is a schema-and-flow change, not a documentation-only cleanup.

## Analytics policy

### Edge v5

Edge daily analytics remains the local fallback and must operate offline. Before production it must:

- read only eligible measurements;
- reject or explicitly mark days where extrema windows are missing;
- enforce `mds_um >= 0` or mark the day invalid rather than storing a negative amplitude;
- prevent saturation, steps, sparse coverage, and configuration changes from moving the envelope or baseline;
- retain QA flags that explain every fallback;
- keep recommendation generation separate from valve actuation.

### Cloud v6 and RDI

v6 remains a separate cloud algorithm with self-calibrated `TWD_rel`. It is not a drop-in replacement for edge v5. The 14-day physiological baseline must include only qualified living-tree days, and per-crop thresholds must be field-calibrated before recommendations are treated as operational.

The RDI arm remains a labeled shadow. It may be compared with v6 after raw-history parity is proven, but it may not silently replace the production policy.

### Agroscope reference and corrected OSI arms

Maintain two explicit purposes:

1. The **strict reference arm** reproduces the pinned Agroscope implementation, including documented quirks, so differences can be attributed.
2. The **corrected OSI arm** may improve fault handling for OSI operations, but every deviation from the reference is named, tested, versioned, and reported separately.

The strict arm must not be used as evidence that a quirk is agronomically desirable. Known reference behaviors to keep visible include cumulative-maximum poisoning after a bad high point, tree-count-dependent SEM behavior, one integral step regardless of missing-day length, DST-sensitive local-day handling, and the hard rain gate.

## Differential replay requirement

The existing cross-repo golden vectors begin at daily extrema and prove only the shared envelope/TWD/MDS core. The Agroscope oracle fixtures prove selected clean and edge cases at the Java component boundary. Production readiness requires a lower-boundary replay that begins with raw installed-sensor inputs.

Create an immutable, versioned replay corpus containing:

- raw LoRaWAN payload bytes and FPort;
- decoded CH0, CH1, battery, temperature, mode, and receive timestamp;
- device calibration and configuration epoch;
- duplicate, out-of-order, gap, reset, saturation, rail, spike, drift, and DST cases;
- reference-tree and treated-tree membership;
- rain and measured water inputs with their source and time window;
- expected measurement validity, analytics eligibility, daily features, state transitions, and dose outputs.

Run the same corpus through:

1. the pinned Agroscope Python reference;
2. the Java strict-reference candidate;
3. the OSI edge signal-processing and daily-analytics path;
4. the corrected OSI candidate, if one is proposed;
5. a hosted staging instance only after local parity and security gates pass.

Compare every intermediate value, not only the final dose. The first divergence should identify whether the cause is decoding, cleaning, resampling, day boundaries, extrema, aggregation, controller state, rain, measured water, or persistence.

## Work packages and order

| Order | Work package | Result | Entry gate | Exit gate |
|---|---|---|---|---|
| 0 | Governance and freeze | Named owner, 2027 window, data-sharing decision, no-actuation controls | Roadmap accepted | Scope, roles, and stop conditions recorded |
| 1 | Hardware qualification | Individually characterized transducers, cables, power, channels, and LSN50 modes | Bench equipment and sensor specifications available | Every production candidate passes range, repeatability, drift, soak, and channel-stability tests |
| 2 | Measurement contract | Separate validity and eligibility with preserved raw evidence | Work package 1 test vectors available | Dirty-input unit and integration tests fail closed |
| 3 | Canonical persistence and sync | One writer, complete projection, complete correction-aware sync | Contract fields locked | One uplink maps to one consistent edge/cloud history row set |
| 4 | Edge analytics hardening | QA-aware extrema, non-negative MDS, stable baselines | Eligible history is trustworthy | Synthetic and captured dirty days cannot alter state improperly |
| 5 | Controlled historical repair | Classified and reproducible repair of affected commissioning data | New pipeline deployed and verified | Backup, dry-run diff, repair, correction events, and integrity checks complete |
| 6 | Agroscope differential replay | Raw-domain parity report and intentional-deviation register | Immutable corpus and pinned reference available | Every material difference is explained and accepted |
| 7 | Living-tree pilot | Reference/control design and seasonal observations | Hardware and software gates pass | Minimum good-data and agronomic-response thresholds pass |
| 8 | Hosted shadow and operational rehearsal | Secure staging egress, result pullback, monitoring, rollback | Local replay passes | Loss, delay, mismatch, outage, and disable tests pass |
| 9 | Production go/no-go | Signed acceptance record for the 2027 installation | All previous gates pass | Production runbook, rollback, spares, and ownership approved |

Work packages 1 and 2 may proceed in parallel after the contract vocabulary is fixed. Historical repair must not be combined with writer consolidation or schema migration in one deployment. The edge/cloud contract change requires linked changes and verification in both repositories.

## Hardware qualification protocol

Each sensor, cable, and LSN50 channel is qualified as a traceable unit before installation.

### Bench tests

- Record manufacturer, model, serial identifier, stroke, supply range, output type, wiring, connector, cable length, and LSN50 firmware/mode.
- Measure supply and both ADC channels at retracted, 25%, 50%, 75%, and extended positions in both travel directions.
- Repeat the cycle enough times to estimate repeatability, hysteresis, endpoint spread, and quantization.
- Hold fixed positions for a soak that spans thermal changes and at least one normal uplink interval pattern.
- Disconnect, short, rail, brown out, and swap channels intentionally; confirm the expected fault code and analytics exclusion.
- Confirm raw payload bytes against the decoder's MOD3 layout rather than trusting decoded JSON alone.
- Reject any combination that reaches saturation during its intended mechanical range.

Acceptance thresholds must be set from the actual transducer specification and agronomic resolution requirement. Do not invent universal voltage or micrometre limits in code before the sensor model is confirmed.

### Installation tests

- Mount without side loading, mechanical end-stop contact, cable pull, or water ingress path.
- Photograph orientation, bracket geometry, cable strain relief, and initial mechanical position.
- Allow a documented settling period before installation zero.
- Use an inert reference fixture during initial deployment to separate environmental and electronics drift from tree movement.
- Keep at least one qualified reference tree and record treatment/control membership.
- Recheck endpoint headroom after mounting and after the first thermal cycle.

### Field evidence minimum

Before the living-tree pilot is considered stable, collect at least 14 good eligible days per candidate tree. For production threshold validation, plan a 21–30 day period spanning dry-down, measured irrigation, recovery, rain, temperature variation, and ordinary communications gaps. Seasonal claims need a longer crop-specific validation window.

## Production acceptance gates

### Gate A: acquisition

- No unexplained CH0 or CH1 rails, steps, or reference-channel instability.
- Intended motion stays inside calibrated raw range with documented headroom.
- Repeated physical positions reproduce within the agreed tolerance.
- Raw payload decoding and displayed channel values agree.

### Gate B: storage and sync

- One accepted uplink produces one canonical row and one diagnostic projection.
- Raw, bounded, validity, eligibility, saturation, mode, and calibration epoch survive edge history, bootstrap, outbox delivery, correction replay, and cloud ingestion.
- Duplicate and out-of-order test traffic is idempotent.
- SQLite integrity, foreign-key checks, outbox accounting, and edge/cloud row reconciliation pass after an outage simulation.

### Gate C: signal processing

- Saturated and invalid samples cannot update baselines, daily extrema, stress, or controller state.
- Missing windows remain missing and carry a reason.
- MDS is non-negative for accepted days.
- Spike removal, interpolation limits, gaps, DST transitions, and configuration changes have pinned fixtures.

### Gate D: analytics parity

- The strict Agroscope arm matches the pinned reference within declared tolerances at every compared stage.
- Reference quirks are visible in output metadata.
- Corrected OSI deviations have independent fixtures and an approved rationale.
- v5, v6, RDI, and Agroscope outputs are compared with their own inputs, units, time windows, and confidence, not by subtracting unlike final scores.

### Gate E: agronomy

- Only living-tree eligible days contribute to physiological baselines.
- Reference and treatment trees, crop stage, weather, rain, and measured applied water are available.
- Recommendations are reviewed against observed recovery and an independent plant-water-status measure chosen for the trial.
- Thresholds are site/crop validated; literature defaults are not accepted as production calibration.

### Gate F: operations

- Forwarding uses approved credentials, TLS or an explicitly accepted network control, an allowlist, bounded buffering, observability, and a tested disable path.
- The gateway remains functional during cloud or Agroscope outage.
- Operators can see why a sensor or day is excluded.
- Backup, restore, rollback, spare-sensor replacement, recalibration, and incident procedures are rehearsed.
- The final production decision names the approving people and the evidence version.

## Stop conditions

Stop commissioning or disable the affected analytics path when any of these occur:

- a sensor reaches a physical or electrical endpoint in ordinary operation;
- CH1 or supply behavior cannot be explained by measured hardware behavior;
- a configuration change cannot be tied to a new epoch;
- two history writers produce duplicate or conflicting projections;
- edge and cloud lose diagnostic fields or disagree on row identity;
- an invalid or saturated sample changes a baseline, stress level, recommendation, or controller state;
- a replay mismatch cannot be localized;
- external forwarding cannot prove authorization, isolation, or disablement;
- any dendrometer-derived path can actuate without a separate approved actuation project.

## Verification matrix

The implementation plan must select the exact gates for each changed surface. At minimum, the readiness program uses these existing checks as a base and adds failing tests for each new invariant.

### Edge logic and contracts

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.test.js
node --test scripts/test-dendro-contract.js
node scripts/verify-dendro-contract-mirror.js
node scripts/verify-agroscope-uplink-transform.js
node scripts/verify-device-integration.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-profile-parity.js
```

### Persistence and repair

Use a production-copy rehearsal, not the live database, to prove migration, writer consolidation, projection completeness, correction events, duplicate handling, and rollback. Follow the schema change-control and live-operations runbooks. Never replace a provisioned `farming.db` with a seed database.

### Cloud and Agroscope shadow

Run the focused `Agroscope*`, dendrometer contract, persistence, isolation, and poison tests in `osi-server`, followed by the relevant backend suite. Record the exact commit of the pinned Python reference and its dependency lock. A green component suite is not a substitute for raw-domain replay.

### Field checks

Store calibration sheets, photos, raw captures, environmental context, firmware versions, and pass/fail decisions under a stable trial identifier. Reports must distinguish absent data from zero movement and separate invalid samples from valid low movement.

## Change-control constraints

- Any `flows.json` edit uses the scripted edit workflow and is mirrored byte-for-byte across maintained Pi profiles.
- New or changed tables, columns, indexes, triggers, or views use ordered migrations. The boot DDL remains frozen except for a separately approved safety convergence change with its full gate.
- Consolidating the current dendrometer writers may touch the runtime-created `sync_dendro_to_readings` trigger. Treat that as a schema ownership project, with production-copy rehearsal.
- The edge/cloud schema and event contract change together. Open linked issues or pull requests in both repositories when the payload changes.
- Historical repair is idempotent, backup-first, dry-run reviewed, and emits correction events. It is deployed separately from schema and writer changes.
- No production host access is implied by this roadmap. Live production access requires explicit authorization in the active task.
- Credentials, payload keys, and personal data do not enter fixtures or documentation.

## Open decisions before implementation planning

- Confirm the exact dendrometer manufacturer, model, electrical specification, stroke, and permitted installation geometry.
- Set numeric bench and field acceptance thresholds from that specification and the required biological resolution.
- Select the independent plant-water-status measurement and trial design for threshold validation.
- Decide the long-term canonical raw-history retention window.
- Decide whether `measurement_valid` and `analytics_eligible` become explicit columns or a versioned quality object; the semantics are mandatory either way.
- Define the configuration-epoch identifier and how it syncs.
- Pin the Agroscope reference commit and Python environment used for 2027 parity.
- Approve which Agroscope quirks remain in the strict arm and which corrected behaviors enter a separately named OSI arm.
- Define hosted staging transport, authorization, TLS/network controls, buffering, loss accounting, and result pullback.
- Decide whether any future actuation project will be considered. It is outside this roadmap and requires its own safety case.

## Ready-to-start criteria

Implementation planning may start when:

- the 2027 commissioning owner and target window are named;
- the exact hardware specifications and production candidate inventory are available;
- the field trial and independent measurement method are approved;
- the raw-domain fixture format and data-governance rules are accepted;
- an edge/cloud change sequence is agreed;
- the issue linked to this document is moved from deferred roadmap to active planning.

## References

- [Agroscope integration program overview](agroscope-integration-overview.md)
- [Agroscope shadow controller design](agroscope-shadow-controller-design.md)
- [Draft edge Agroscope dendrometer controller](agroscope-dendrometer-controller.md)
- [Dendrometer analytics v6](dendrometer-analytics-v6.md)
- [Dendrometer golden-vector contract](../contracts/dendro/README.md)
- [Agroscope IoT forwarding operations](../operations/agroscope-iot-forwarding.md)
- [Edge schema and contract ownership ADR](../adr/2026-06-30-schema-and-contract-ownership.md)
- [Edge history retention operations](../operations/edge-history-retention.md)
- [Engineering playbook](../engineering-playbook.md)
- [Issue #56: lossless edge-to-cloud history](https://github.com/Open-Smart-Irrigation/osi-os/issues/56)
- [Issue #111: Agroscope forwarding allowlist](https://github.com/Open-Smart-Irrigation/osi-os/issues/111)
- [Issue #153: runtime DDL and fingerprint drift](https://github.com/Open-Smart-Irrigation/osi-os/issues/153)
