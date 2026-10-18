# Data-view correction committee review

Date: 2026-10-07. Scope: design and implementation plan, not implemented behavior.
Base: `06e691e850384b1d5ecbacbe24439a257a70c983`.

Reviewed artifacts:

- [Design](../specs/2026-10-07-data-device-discovery-design.md)
- [Implementation plan](../plans/2026-10-07-data-device-discovery.md)

## Committee and method

Three fresh agents reviewed the draft independently against repository code. Each
received a bounded review-only task, without inherited conversation history. They
were instructed to find required corrections, report evidence and avoid editing
files or accessing live systems. The author amended the documents and asked all
three reviewers to check the revised plan.

| Reviewer | Responsibility | First verdict | Revised verdict |
|---|---|---|---|
| review_data_backend | Device coverage, persisted channels, history and aggregation | Not ready | Ready |
| review_data_access | Read policy, unassigned ownership, API contract and destinations | Not ready | Ready |
| review_data_delivery | Mounted GUI, correlation, CSV, tests and deployment coverage | Not ready | Ready |

All three reviewers returned Ready on re-review, with no remaining required
findings. This verdict authorizes no runtime action; it records plan readiness.

## Findings and dispositions

| Finding | Revision |
|---|---|
| A second environment predicate in osi-history-router still excludes LoRain. | Task 1 exports the helper predicate and delegates the router predicate to it, with direct router and export regressions. |
| Battery and UC512 pulse keys are absent from analysis metadata; adding them to CHANNELS conflicts with its manifest parity contract. | Task 2 preserves CHANNELS and adds a separately verified four-key DEVICE_HEALTH_CHANNELS set, with SQL-field validation and Data-view-only CSV support. Global export eligibility stays unchanged. |
| Promised history access after configuration changes has no mechanism compatible with avoiding full-history scans. | Task 2 declares finite type-supported channel keys, labels current versus other-supported configuration, and retains historical selectors. Existing measurement evidence guards remain in the reader. Removed SDI12 layout keys have unknown depth. |
| Legacy aggregate CSV uses means for LoRain interval rainfall. | Task 1 selects sum for interval mm/tips, latest for today mm, and mean for temperature/rates. Tests include raw, hourly, daily, nightly and rollup-present cases. Aggregated CSV reads range-bounded raw history because old rollups have no sum. |
| Account-wide unassigned discovery would expose unclaimed devices. | Task 3 requires user_id IS NOT NULL for account-wide unassigned rows and authenticated ownership in owner mode. Negative tests cover unclaimed/deleted/foreign rows; assigned no-owner rows retain existing readable-zone behavior. |
| The flow response projection would discard the helper's new sources field. | Task 3 explicitly changes GET /api/analysis/channels and verifies the extracted router response without leaking internal catalogue state. |
| Correlation groups all unassigned series under null and overwrites duplicate channels. | Task 4 uses distinct group identities, pairs unassigned measurements within a device, preserves unambiguous assigned-zone pairing and suppresses ambiguous groups. Pooled output has its own identity. |
| Specialized destinations and null-zone CSV fallbacks were underspecified. | Task 4 names useGatewayModules and its loading/disabled/error behavior, limits links to Network, explains valve-event limitations, and tests CSV with absent catalogue metadata. |

Optional findings were also incorporated: source/channel bijection tests, the
fact that offline bundles derive their file list from deploy.sh, and explicit
application of the valve_settings join to unassigned enumeration.

One review claim was corrected against the source: flow_pulses_delta already
exists in analysis.js. The missing pulse metadata is valve_1_pulse and
valve_2_pulse. The health subset contains those two fields plus bat_v and bat_pct.

## Evidence and limits

The author reproduced empty history-card discovery on the pinned public base for
configuration-only LoRain, UC512, rain-only LSN50 and flow-only LSN50 fixtures. The
backend reviewer independently confirmed these four omissions. Earlier read-only
live inspection established that the affected gauge already had a valid rain row
and a matching zone aggregate; registration or data repair is not this fix.
Public artifacts use synthetic device identifiers.

Planning baseline:

| Check | Result |
|---|---|
| History-helper index.test.js and analysis.test.js | 65 passed, 0 failed, 1 skipped |
| test-scoped-access-reads.js | 45 passed, 0 failed |
| verify-history-api-contract.js | Passed |

The skipped helper test is the opt-in 399-day weather benchmark, enabled by
OSI_BENCH=1. It was not run during planning. The access reviewer independently
re-ran the scoped read suite and obtained 45 passes.

These checks describe the current base. They do not establish that the proposed
correction works. Implementation must produce failing regressions first, run the
plan's gates and browser checks, and receive independent verification. Public and
private branches require separate evidence because the deployed payload may
contain fixes beyond its branch tip. Live deployment and acceptance verification
remain separate from this documentation change.
