# T-Watch Ultra product and technical roadmap

Date: 2026-09-01. Builds on [01-independent-use-case-analysis.md](01-independent-use-case-analysis.md),
[02-hardware-feasibility.md](02-hardware-feasibility.md) and
[03-review-of-previous-suggestions.md](03-review-of-previous-suggestions.md). Effort
figures are planning estimates in person-weeks (pw) for one experienced embedded
developer plus review, calibrated against nothing yet built; treat them as sizing, not
commitments.

## Shape of the roadmap

Five releases, ordered so that every release retires the largest remaining risk before
new surface is added. R0 spends three to four weeks proving the hardware tells the
truth; R1 builds the survey product; R2 and R3 add the two use cases the independent
analysis ranked next (commissioning, then alerts and emergency stop); R4 holds
everything that is valuable but blocked or optional. Each release ends at a decision
gate with explicit stop conditions, because the strongest argument against this project
is developer-capacity opportunity cost, and the gates exist to make stopping cheap.

Standing non-goals for every release: the watch is never a LoRaWAN gateway, repeater or
network server; never a farmer interface; never a Class C always-listening device;
never a holder of valve session keys; never a bypass of hub permissions, interlocks,
runtime caps or audit logging. Cloud connectivity is never required for any feature.

| Release | Name | Product goal | Effort |
|---|---|---|---|
| R0 | Bench truth | Prove the hardware and stack can produce honest measurements | 3–4 pw |
| R1 | Surveyor MVP | A field-usable LoRaWAN survey instrument with hub-side maps | 16–22 pw |
| R2 | Commissioning verifier | Close the install-verify loop at the mounting point | 4–6 pw |
| R3 | Messenger | Offline alerts to the wrist; emergency stop requests | 6–9 pw |
| R4 | Optional extensions | Supervised valve tests; research and training extras | per item |

## R0: bench truth (hardware validation and bring-up)

**Product goal.** A bench-validated watch that joins a test OSI ChirpStack, answers the
five hardware questions the survey design depends on, and demonstrates the existing
field-tester compatibility path end to end. No product UI, no hub changes.

**Users served.** The development team only.

**Included.**

- The seven-step hardware identification procedure from 02-hardware-feasibility run on
  every purchased unit: SKU record, factory-firmware screen, module marking, connector
  and antenna census, RadioLib probe, on-air band confirmation, recorded result.
- RF switch characterisation: confirm which `setRFSwitch()` state reaches the real
  antenna, by comparative RSSI at a gateway in both switch states.
- Toolchain pin: Arduino-ESP32 core, LilyGoLib as HAL, RadioLib pinned explicitly;
  a reproducible build documented from a clean machine.
- OTAA join to a bench ChirpStack (EU868, LoRaWAN 1.0.4, RP002 1.0.4 profile), with
  `setDutyCycle(true)`, TCXO and DIO2 switch configured explicitly.
- Session and nonce persistence across deep sleep and across full power-off; frame
  counters verified monotonic after reboot.
- `LinkCheckReq` round trip with margin and gateway count read on the watch.
- Disk91 field-tester compatibility spike: the watch transmits the 10-byte payload on
  port 1, the existing hub backend answers, the watch displays sequence, min/max RSSI
  and gateway count from the downlink. Zero hub changes.
- Power measurements replacing the datasheet model: deep-sleep floor, GNSS acquisition
  and tracking, TX at +14 dBm (both PA configurations if reachable), display on/off,
  one simulated survey hour.

**Non-goals.** No survey storage format, no Wi-Fi sync, no GUI work, no multi-unit
fleet thinking.

**Firmware work.** Throwaway sketches plus one kept artifact: a `hw-probe` sketch that
prints the identification record.

**OSI OS / server work.** None. The compatibility spike runs against the already
deployed backend.

**Data-model changes.** None.

**Hardware dependencies.** Two 868 MHz SKU units (supply is intermittent; order first),
one USB-C power profiler or inline current meter, access to a bench gateway (kaba100 or
a lab ChirpStack), optionally an SDR for band confirmation.

**External dependencies.** Arduino-ESP32 (pinned), LilyGoLib 0.2.x, RadioLib 7.7.x.

**Security work.** Credential hygiene only: bench AppKeys generated per unit, stored
outside git, never in sketch source.

**Test requirements.** Each included item above is a pass/fail bench test with recorded
output; the reboot test runs 20 cycles without a frame-counter regression.

**Documentation.** A build-from-clean-machine guide; the per-unit identification
records; measured-power table appended to 02-hardware-feasibility.

**Field validation.** None; this release is the bench.

**Main risks.** Procurement delay (all SKUs sold out at research time); the alpha
Arduino core failing on some host platform; the RF switch answer coming out wrong
(the "USB" path is the real antenna), which would invalidate LilyGoLib's defaults and
cost a few days of rework; measured power deviating far enough from the model to
force a redesign of survey cadence.

**Exit criteria (gate G0).** All of: unit identification records complete; join,
LinkCheck, persistence and duty-cycle tests pass; compatibility spike shows live
gateway feedback on the wrist; measured deep-sleep and survey-hour figures within 2×
of the 02-hardware-feasibility model. **Stop** if the radio cannot sustain reliable
joins and receive windows under the pinned toolchain, or if measured power makes a
half-day survey unreachable, or if units cannot be procured; in the stop case the
RAK10701 remains OSI's field tester and the spend is under a month.

## R1: Surveyor MVP

**Product goal.** An installer or super-user surveys a real OSI LoRaWAN network:
quick probe, stationary point test, walk survey; every attempt logged before
transmission; results synced to the hub over Wi-Fi; the hub GUI renders the map,
correlates attempts with receptions, and exports GeoJSON and CSV. Fully offline.

**Users served.** OSI installers, super-users, researchers, the Academy (teaching mode
is the survey screen itself).

**Included.** The full MVP as specified in [05-mvp-design.md](05-mvp-design.md):
survey firmware (modes, target profiles, storage, sync, UI, power management), the hub
survey backend (ingest, correlation, storage, API, exports), the GUI survey page
(map, layers, session compare), and the field-validation protocol.

**Explicit non-goals.** No commissioning features, no alerts, no actuation of any
kind, no NFC, no BLE, no cloud sync of survey data, no smooth heatmaps, no offline
base-map tiles (deferred; the map works on a blank grid), no farmer-facing surface.

**Firmware work.** The seven modules and state machines of 05-mvp-design sections
7.8–7.10 and 7.13–7.14.

**OSI OS work.** New migration(s) for survey tables; a survey ingest/correlation
module under `/usr/share/node-red/`; thin flow wiring; authenticated survey API;
GUI survey page with map rendering; feature flag `surveyUxEnabled`; i18n for the new
namespace across the 7 locales.

**OSI server work.** None. Survey data is edge-local in R1, following the
`gateway_health_samples` precedent.

**Data-model changes.** Three new edge tables (`survey_sessions`, `survey_attempts`,
`survey_link_events`) plus reuse of `field_tester_uplinks`/`field_tester_rxinfo`;
detail in 05-mvp-design section 7.11. All local-only, no sync triggers.

**Hardware dependencies.** R0 outcomes; at least one RAK10701 or equivalent reference
device for calibration; a second watch for multi-unit sync testing.

**External dependencies.** As R0, plus LVGL 9.x (UI), a small map renderer in the GUI
(Leaflet, BSD-2), and no others. Licence review recorded in the README ADR table.

**Security work.** Watch–hub pairing with a short-lived pairing code issuing a scoped
bearer token; survey API authenticated (unlike the legacy `/download-fieldtest`,
whose missing auth is fixed or fenced in this release); no LoRaWAN keys in survey
files, exports or logs; secrets in NVS only.

**Test requirements.** The unit, protocol, storage-corruption, reboot, duty-cycle,
downlink, multi-gateway and hardware-in-the-loop matrices of
[06-implementation-backlog-and-tests.md](06-implementation-backlog-and-tests.md),
plus the acceptance criteria of 05-mvp-design section 7.17.

**Documentation.** Operator guide (survey procedure, mode selection, reading the
screen), hub admin guide (enabling the feature, retention), developer docs (payload
spec, schema, API), all under `docs/twatch-ultra/`.

**Field validation.** The pilot protocol of 06-implementation-backlog-and-tests:
repeated walk surveys around an existing gateway, stationary benchmarks at real
sensor and valve positions including installation heights, wrist-worn versus
placed-at-target comparison, and a survey compared against the RAK10701 on the same
route on the same day.

**Main risks.** UI effort on LVGL exceeding estimates (the classic embedded sink);
receive-window timing versus SD writes and display refresh; GNSS performance of the
uncharacterised antenna under canopy; the map GUI growing beyond "samples on a grid"
scope; single-developer bus factor.

**Exit criteria (gate G1).** The 05-mvp-design acceptance criteria pass, including
the multi-hour field survey and the reference-device comparison. **Stop or redirect**
if field validation shows the watch's measurements do not reproduce (same route, same
day, PDR differing beyond the defined tolerance) despite working hardware, or if the
firmware cannot keep receive windows open reliably during real surveys; redirect
options at this gate are "keep firmware, drop GUI to CSV-only" and "keep bench tool,
drop product ambition".

## R2: commissioning verifier

**Product goal.** The install-and-verify loop closes at the mounting point: an
installer arms commissioning for a device, and the watch shows join events, first
decoded uplink values and plausibility at the trench or mast, before backfill or
descent.

**Users served.** Installers and super-users; researchers installing trial hardware.

**Included.** `OSI_WATCH` ChirpStack device profile and registration path; hub-side
event mirror (join and decoded-uplink events for one armed device forwarded to the
watch's downlink queue); watch commissioning screen; device location capture (GNSS
fix written to the device's lat/lng via the existing API); installation depth entry
through the existing depth endpoint; optional hub-mediated sensor cadence toggle
during installation (`SET_LSN50_*` family), with automatic revert.

**Explicit non-goals.** No key entry on the watch (registration happens in the GUI
beforehand); no alerting; no write access to anything but location, depth and the
guarded cadence toggle.

**Firmware work.** Commissioning mode and screen; downlink event decoding; small
uplink vocabulary for arm/disarm requests.

**OSI OS work.** Event-mirror branch in flows; `OSI_WATCH` profile in
`chirpstack-bootstrap.js`; authorization check that the arming watch is paired.

**Data-model changes.** A watch registry table (paired watches, scopes) shared with
R3; no new survey tables.

**Hardware dependencies.** None beyond R1.

**Security work.** The commissioning stream must forward events, never keys; arming
requires a paired watch; audit rows for cadence toggles.

**Test requirements.** Join/uplink mirror correctness; cadence-toggle revert under
watch disappearance; downlink budget under commissioning polling.

**Documentation.** Installer runbook update; commissioning workflow in the operator
guide.

**Field validation.** One real device installation per supported type (LSN50 with
Chameleon, KIWI, valve controller) commissioned watch-in-hand on a live test farm.

**Main risks.** Downlink volume during commissioning sessions on a busy gateway;
scope creep toward configuration-from-the-watch.

**Exit criteria (gate G2).** A buried-sensor install completed with verification at
the trench and no repeat visit; downlink usage within the budget defined in
05-mvp-design. **Stop** adding hub-facing features if the event mirror destabilises
the production flow tabs; commissioning can ship watch-side against survey-only hubs
by falling back to R1 behaviour.

## R3: messenger (alerts and emergency stop)

**Product goal.** The offline hub gains its first long-range push channel to a human:
prioritised alerts reach the wrist within one poll interval, acknowledged back; a
press-and-hold emergency stop requests valve cancellation through the hub's existing
machinery.

**Users served.** Super-users and operators wearing the watch daily.

**Included.** Hub-side alert engine (condition selection, prioritisation into a few
downlink bytes, deduplication, acknowledgement tracking); watch alert UI and haptic
vocabulary; background poll scheduling within duty cycle; emergency-stop request
uplink mapped to the hub's valve-cancel path with scope checks and audit; watch
identity model completed (per-watch scopes, revocation/unclaim flow).

**Explicit non-goals.** No valve opening of any kind; no alert configuration UI on
the watch (configured in the GUI); no guarantee semantics ("the hub can now reach you
in the field", never a pager SLA).

**Firmware work.** Poll scheduler, alert store and UI, acknowledgement uplinks,
emergency-stop flow with deliberate-action UI.

**OSI OS work.** Alert engine in flows plus a versioned module; pending-alert queue
tables; scope/authorization enforcement on the stop path; GUI page for alert rules
and watch management (pairing, scopes, revocation).

**Data-model changes.** Alert queue and acknowledgement tables; watch registry gains
scopes and revocation state.

**Security work.** This release is mostly security work: the watch identity model,
revocation, rate limits on stop requests, audit rows for every request and outcome.

**Test requirements.** Alert delivery latency distribution versus poll cadence;
duplicate suppression; stop-request authorization matrix (in-scope, out-of-scope,
revoked watch); accidental-trigger resistance.

**Documentation.** Alert semantics for operators (latency expectations, ack meaning);
lost-watch runbook.

**Field validation.** Two weeks of daily wear on a test farm with injected alert
conditions; a staged stuck-valve drill using the emergency stop.

**Main risks.** Alert engine scope creep (the "restraint" the independent analysis
demands); battery reality of daily polling; trust damage from a missed alert if
expectations are set wrong.

**Exit criteria (gate G3).** Alert round trip demonstrated across the poll cadence
with acknowledgement visible hub-side; stop drill executed with correct audit trail;
battery over a wear-day within the measured budget. **Stop** at watch-count reality:
if fewer than a handful of super-users actually wear the device after R1/R2, the
alert engine's hub-side maintenance cost is not justified and R3 should not ship.

## R4: optional extensions

Unordered, each behind its own small gate; none scheduled until R1–R3 evidence exists.

- **Supervised valve test actuation (3–4 pw).** The last-built feature by design:
  short hub-clamped test opens (`OPEN_FOR_DURATION`, test caps, per-watch rate
  limits) after the R3 identity model has field mileage.
- **Structured field observations (3–5 pw).** Blocked on the journal architecture
  inversion; design against its final shape, then a 4-tap capture flow with edge
  buffering and outbox sync.
- **NFC asset tags (2–4 pw plus logistics).** Requires resolving the SLA0052 licence
  question first; revisit only if R2 commissioning shows a real misidentification
  rate.
- **Academy mode (≤1 pw).** Large-digit propagation display exists from R1; add only
  what trainers request after using it.
- **Cloud mirror of survey summaries (2–3 pw, osi-server work).** Only if
  multi-site research needs central comparison; edge stays canonical.
- **Offline base-map tiles for the hub GUI (2–3 pw).** Pre-downloaded tile packs per
  deployment region; valuable but heavy on storage and process, deferred until users
  ask for more than the blank-grid map.

## Cross-release risk register

| Risk | Bearing on | Mitigation |
|---|---|---|
| Hardware supply (all SKUs sold out 2026-08-31) | R0 start | Order early, buy spares, accept reseller pricing |
| Young vendor library (single maintainer) | All firmware | Pin everything in R0; vendor LilyGoLib as HAL only; budget upgrade windows. (2026-09-02: the alpha-core half of this risk is retired — arduino-esp32 3.3.x is stable, 3.3.11 current) |
| Band matching undocumented (per-SKU modules) | Any non-EU868 deployment | Per-unit identification; VNA measurement before any cross-band claim; Uganda band question resolved before any Uganda plan |
| No published CE/FCC for the watch | Field deployment legality | Treat as development hardware; resolve regulatory status before issuing to super-users outside supervised trials |
| Single-developer capacity vs 1.0 and Uganda scale-up | The whole roadmap | The gates: every release is individually stoppable with its artifacts intact |
| Duty-cycle compliance | R1 onward | Enforcement on by default in firmware; budget shown to operator; verified in the test matrix |

## Decision-gate summary

| Gate | After | Continue if | Stop or redirect if |
|---|---|---|---|
| G0 | R0 | Honest measurements demonstrated; power within 2× of model | Radio/toolchain unreliable; power infeasible; no supply |
| G1 | R1 | Acceptance criteria and field validation pass | Measurements do not reproduce; receive windows unreliable in the field |
| G2 | R2 | Trench verification saves a real visit; downlink budget holds | Event mirror destabilises production flows |
| G3 | R3 | Alerts round-trip; stop drill audited; daily wear is real | Too few wearers to justify hub-side surface |
| G4 | each R4 item | Item-specific demand evidence | Default is not building |
