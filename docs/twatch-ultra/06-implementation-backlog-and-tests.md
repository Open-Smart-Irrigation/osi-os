# Implementation backlog and validation plan

Date: 2026-09-01. Executes [05-mvp-design.md](05-mvp-design.md) (releases R0 and R1 of
the [roadmap](04-product-roadmap.md)). Effort is in person-days (pd) for one embedded
developer plus review; priorities: P0 blocks everything after it, P1 is MVP-critical,
P2 is MVP-included but schedulable. Definition of done (DoD) always includes: code
reviewed, tests listed in the matrix passing, and the relevant design section still
true (or amended in the same change).

## Blocking decisions

Open items that gate specific tasks below; each names its resolver.

| # | Decision | Resolved by | Blocks |
|---|---|---|---|
| B1 | Which RF-switch state reaches the real antenna | E1/T1.3 bench measurement | All radio work beyond bring-up |
| B2 | Does `setOutputPower(14)` select the optimal PA config | E1/T1.5 current measurement | Power model only |
| B3 | TCXO present at 3.0 V | E1/T1.2 | Radio init defaults |
| B4 | Procurement: 2 units of the 868 MHz SKU | Ordering (start now) | E1 entirely |
| B5 | Watch token revocation approach (table vs short-lived re-pairing) | Design confirmed in T7.2 review | Sync auth hardening |
| B6 | Retire or gate legacy unauthenticated `/download-fieldtest` | Repo issue, decided with Phil | T7.4 |
| B7 | Grid cell size default (50 m proposed) | First field data, T11.3 | Final map defaults only |

## Epics

### E1: hardware validation (R0) — P0, 15–20 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T1.1 | Run the 7-step identification procedure on both units; record results | 1 pd | B4 |
| T1.2 | Bring-up sketch: pinned toolchain, `hal/` init, TCXO + DIO2 config, build docs from clean machine | 3 pd | T1.1 |
| T1.3 | RF-switch characterisation (comparative RSSI both states, at a gateway) | 1 pd | T1.2 |
| T1.4 | OTAA join + persistence: NVS nonces, RTC-RAM session, 20-reboot fcnt test | 3 pd | T1.3 |
| T1.5 | Power bench: per-state currents, PA-config check, one simulated survey hour | 3 pd | T1.2 |
| T1.6 | LinkCheck round trip; duty-cycle enforcement demo (`timeUntilUplink` waits) | 2 pd | T1.4 |
| T1.7 | Disk91 compatibility spike against an unmodified hub | 2 pd | T1.4 |
| T1.8 | G0 gate review: measured table into 02-hardware-feasibility, go/stop memo | 1 pd | all E1 |

Stories: *As the project owner I know by G0 whether this hardware can tell the truth,
for under a month of effort.* DoD for E1: every 05-design hardware assumption either
confirmed or the design amended.

### E2: firmware platform — P0, 12–16 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T2.1 | Repo scaffold `osi-surveyor-fw`, arduino-cli CI build, header-include lint, host-side test harness | 3 pd | T1.2 |
| T2.2 | Task/queue skeleton: radio/gnss/survey/storage/ui/sync tasks, `osi_event_t`, snapshot publishing | 4 pd | T2.1 |
| T2.3 | Power states + sleep entry/exit with persistence hooks (7.14 ladder) | 3 pd | T2.2, T1.5 |
| T2.4 | Diagnostics: ring log, fault records, overflow counters | 2 pd | T2.2 |

### E3: LoRaWAN — P0, 10–14 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T3.1 | `lorawan/` wrapper: join, session restore, uplink with pre-TX RF-switch assert, duty budget API | 4 pd | T1.4, T2.2 |
| T3.2 | LinkCheck + DeviceTime scheduling per mode tables | 2 pd | T3.1 |
| T3.3 | Downlink dispatch: FPort 10 ACK decode, compat-mode FPort 2 decode | 2 pd | T3.1 |
| T3.4 | Payload codec (7.10) with host-side golden-vector tests | 2 pd | T2.1 |

### E4: GNSS — P1, 6–8 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T4.1 | UART NMEA parse, fix-state machine, accuracy/stale tracking | 3 pd | T2.2 |
| T4.2 | UBX power modes (continuous / cyclic / off) per mode tables | 2 pd | T4.1 |
| T4.3 | Movement trigger (25 m) + stationarity warning for point tests | 1 pd | T4.1 |

### E5: storage — P0, 8–10 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T5.1 | Record codec + CRC, header, golden vectors shared with the hub decoder | 2 pd | T2.1 |
| T5.2 | Session files on FFat: write-ahead flush, buffered flush windows, sidecars via temp-rename | 3 pd | T5.1 |
| T5.3 | Recovery: CRC scan, truncate, quarantine, resume/close flow | 2 pd | T5.2 |
| T5.4 | SD export copy + `tools/` dump/verify utility (host-side) | 1 pd | T5.2 |

### E6: survey engine and UI — P1, 18–24 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T6.1 | SessionManager + mode state machines (7.4, 7.8 diagrams) | 4 pd | T3.x, T4.x, T5.x |
| T6.2 | Profiles: cache, region guard, padding, DR sweep | 2 pd | T6.1 |
| T6.3 | LVGL screens (7.13), physical-button mapping, haptic vocabulary | 8 pd | T2.2 |
| T6.4 | Live feedback plumbing (snapshots → screens) + trace widget | 2 pd | T6.3 |
| T6.5 | Recovery and fault screens | 2 pd | T5.3 |

### E7: sync and security (watch + hub auth) — P1, 8–11 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T7.1 | Wi-Fi client: AP/LAN connect, chunked upload with resume, finalize verdict display | 3 pd | T5.2 |
| T7.2 | Pairing: code entry, token storage in `creds/`, hub allowlist for debug builds | 2 pd | T7.1, B5 |
| T7.3 | USB provisioning mode (AppKey injection, factory reset) | 2 pd | T2.1 |
| T7.4 | Hub: pairing endpoint, revocation table, bearer scope checks; decide B6 | 2 pd | E8, B6 |

### E8: OSI backend — P1, 10–13 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T8.1 | Migration `0026__survey_backend.sql` + seed mirror + CHECKSUMS + verifier run (osi-schema-change-control) | 2 pd | design 7.11 |
| T8.2 | `osi-survey-helper`: record decode (golden vectors from T5.1), correlation, SQL | 4 pd | T8.1 |
| T8.3 | Flow wiring: uplink branch (profile filter, FT-table writes, FPort 10 stamp), ACK enqueue via ChirpStack API, retention tick | 3 pd | T8.2 |
| T8.4 | `CHIRPSTACK_PROFILE_SURVEYOR` in chirpstack-bootstrap.js (+ env/UCI mapping) | 1 pd | — |
| T8.5 | Survey REST API router (verifyBearer pattern), status endpoint | 2 pd | T8.2 |

### E9: OSI dashboard — P1, 10–14 pd

| Task | Description | Effort | Depends on |
|---|---|---|---|
| T9.1 | Survey page scaffold: route, `surveyUxEnabled` flag, sessions list | 2 pd | T8.5 |
| T9.2 | Leaflet map: blank grid base, points/missing/route layers, per-gateway + count layers, uplink/downlink split | 5 pd | T9.1 |
| T9.3 | Grid aggregation view + session comparison (ΔPDR) | 3 pd | T9.2, B7 |
| T9.4 | Exports UI, SD-file import dialog, pairing-code dialog | 2 pd | T9.1 |
| T9.5 | i18n `survey.json` ×7 locales (translation pass follows the existing GUI process) | 2 pd | strings frozen |

### E10: documentation — P2, 5–7 pd

Operator guide (survey procedure, reading the screens, haptics, privacy note); hub
admin guide (enable, retention, retention/deletion, lost-watch runbook); developer
docs (payload, file format, API, schema); build guide from E1. DoD: a technician who
was not the author runs a survey end to end from the guide alone.

### E11: field validation — P1, 8–10 pd + calendar time

Tasks: pilot protocol execution (below), reference-device calibration, threshold
calibration for the service classification, G1 gate review memo.

**Total R0+R1: roughly 110–140 pd (≈ 22–28 person-weeks), consistent with the
roadmap's 16–22 pw for R1 plus 3–4 pw for R0.**

## Test matrix

| Test class | What is tested | Where | Automated? |
|---|---|---|---|
| Unit (host) | Record codec, payload codec, correlation logic, duty-budget arithmetic, grid keys | `test/` + `osi-survey-helper` tests | Yes, CI |
| Protocol | Golden vectors shared watch↔hub; version-mismatch rejections; padded payloads; ACK decode | Both repos | Yes, CI |
| Storage corruption | Truncated tail, bit-flipped record, corrupt header, sidecar orphan; salvage tool output | Host, fault-injection files | Yes, CI |
| Reboot / power loss | Cut power at randomised points during sampling and during flush; recovery invariants (05 §7.17 no. 4) | Rig: relay-switched supply | Semi (scripted rig) |
| Hardware-in-the-loop | Join, uplink, LinkCheck, downlink against bench ChirpStack; RF-switch assert observed | Bench | Semi |
| Join / frame counters | 20-cycle reboot matrix incl. full power-off; DevNonce growth audit | Bench | Semi |
| Duty cycle | Airtime accounting vs `TX_RESULT` logs over forced-fast sessions; per-sub-band ≤ 1%/rolling hour | Bench + log analysis script | Yes (analysis) |
| Downlink | ACK sampling schedule honoured; DL_QUEUED vs DL_RX bracketing; gateway half-duplex impact noted at high rates | Bench + hub | Semi |
| Multi-gateway | Two-gateway rig (Silvan + kaba100 class); rx_info fan-out rows; per-gateway map filter | Field/bench hybrid | Manual + asserts |
| GNSS accuracy | Fix accuracy vs surveyed reference points, open sky and under canopy; stale/no-fix paths | Field | Manual, recorded |
| Battery | 7.14 measurement plan; 4 h point and 3 h walk targets; gauge drift | Bench + field | Manual, recorded |
| Sunlight / ergonomics | Glance readability outdoors at noon; glove and wet-finger operation of button-mapped actions | Field | Manual checklist |
| Reference comparison | Watch vs RAK10701, same route same day, per-cell agreement (criterion 17) | Field | Analysis script |
| Installation heights | Point tests at 20 cm (soil node), 60 cm (valve), 2 m (weather station) vs wrist height at same spot | Field | Analysis script |
| Wrist vs placed | Same position, worn vs strapped-to-target; offset recorded per profile | Field | Analysis script |
| Canopy / wet soil | Point tests inside crop canopy and at wet-soil grade where the farm allows | Field | Manual, recorded |
| Route repeatability | Same route walked 3× across two days; per-cell PDR spread quantified (feeds criterion 17 tolerance) | Field | Analysis script |

## Pilot field protocol

Site: an existing OSI gateway with known-good devices (kaba100 or Silvan; EU868;
two-gateway overlap achievable between them if within range, otherwise single-gateway
plus the bench gateway transported). One day, two people, both watches.

1. **Setup (30 min).** Identification records checked; watches paired; profiles
   synced; RAK10701 charged; reference positions marked (5 stakes: near-gateway,
   mid-field, field edge, known shadow, under canopy).
2. **Stationary series (2 h).** At each stake: join test, then 30-sample point test
   at `lsn50-worst-case`, watch strapped at 20 cm; repeat at wrist height. One stake
   repeated with `strega-valve` profile at 60 cm.
3. **Walk survey (1 h).** Fixed perimeter route, `watch-default`, screen off; the
   second operator walks the same route with the RAK10701 30 min later.
4. **Downlink emphasis (30 min).** Point test at the shadow stake with ACK sampling
   raised (strega profile) to exercise DL_QUEUED vs DL_RX divergence.
5. **Interruption drills (30 min).** Mid-walk power cut; hub Node-RED restart during
   a session; sync with Wi-Fi dropped mid-transfer.
6. **Sync and review (1 h).** All sessions synced (one via SD import deliberately);
   correlation verdicts recorded; map reviewed against ground truth; exports opened
   in QGIS/spreadsheet.
7. **Repeat (day 2, 1 h).** Walk route again for repeatability; thresholds
   calibrated from the two days.

Outputs: filled acceptance-criteria checklist (05 §7.17), calibration offsets per
profile, threshold set v1, G1 gate memo.
