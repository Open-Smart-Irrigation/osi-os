# Mobile history real-data integration specification

**Status:** Revised after external review on 2026-10-24. The earlier readiness verdict is superseded by the [review consolidation](../reviews/2026-10-24-mobile-history-real-data-external-review.md). No production integration or deployment has been performed.

**Scope:** Replace the accepted mobile-history fixture with authentic edge and cloud data in small reviewed slices. The existing preview stays fixture-only until a production slice passes edge/cloud contract tests and browser acceptance.

## Audited refs

This audit read local cached Git refs. It does not claim that any ref is deployed.

| Checkout or ref | Commit | State during audit |
| --- | --- | --- |
| Mobile prototype worktree | `2d67ed1bacfeb0b299b588029b265d448bad734d` | Branch `plan/mobile-history-zoom-prototypes`; 70 ahead and 45 behind its upstream comparison |
| Edge root checkout | `a6b3d9b1f5e784b1df00227355b6ecdd631b61bf` | Local `main`; dirty; 1 ahead and 77 behind `origin/main` |
| Edge cached `origin/main` | `55ec323f90d12864eab50cfeda74cb3bf8910834` | Read with `git show`; source of the current findings below |
| Cloud checkout | `0534ae13fd50c3fa16d8bb130721bb126a498510` | Local `main`; two modified test files; 13 behind `origin/main` |
| Cloud cached `origin/main` | `f214163f29153c35821fe8f554b28ca7359760c2` | Read with `git show`; source of the current cloud findings below |

Implementation must start in clean worktrees at refs that root reviews at execution time. Do not build production backend work on the October prototype fork. Port the accepted preview behavior selectively.

## Integration decision

Use the existing Analysis catalog and series APIs as the production Chart read path:

- edge: `GET /api/analysis/channels`, `POST /api/analysis/series`
- cloud: `GET /api/v1/analysis/channels`, `POST /api/v1/analysis/series`

Their common catalog fields already identify one authentic series by `seriesId`, zone, `sourceKey`, `channelKey`, unit, device name and depth. The series endpoints accept a list of those opaque IDs. Both cap a request at 25 series and support an explicit `90d` label. This is closer to the accepted measurement/source model than the card-history API, whose series are card-level and can merge devices.

Keep the frontend catalog closed and typed. The backend reports available data facts; it does not define presentation names, status rules or allowed views. For example, the frontend maps `swt_1..3` to Water tension and `vwc_1..10` to Volumetric water content. It must not group semantic quantities because their unit strings match.

The first internal slice uses hourly aggregates on both platforms. Cloud Analysis does not currently expose the pilot's raw/15-minute detail; restoring that detail is a release gate alongside 90-day parity. Edge card-history source filtering has no equivalent request parameter in the audited cloud card-history route, so mixing that route with Analysis discovery would not preserve per-source parity.

The card-history endpoints remain the source for existing card screens and exports. This project does not replace them or introduce a device plugin framework.

## Facts from the audited code

### Source and channel discovery

Edge `osi-history-helper/device-sources.js` derives configured channels from device type, flags, SDI-12 profile, channel layout and depth maps. `analysis.js` turns those facts into catalog entries. Each edge entry also carries `configurationState: current | other_supported`. That flag describes current configuration; it is not a historical-retention policy.

Cloud `SoilDevicePolicy.perDeviceChannels` applies the corresponding device and access rules. `AnalysisCatalogService` emits only the resulting per-device channels. Cloud does not currently return edge's `configurationState`, `sourceKind`, `deviceSourceId` or `sources` list.

The accepted preview keeps known historical sources discoverable when the current interval is empty. Neither current catalog proves what should happen after a device is reconfigured or removed. Filtering edge entries permanently to `current` could erase access to retained history, while exposing every `other_supported` entry could advertise a channel that never produced data. Slice 1 must preserve this distinction and collect evidence. A later review decides whether availability needs retained-history bounds, an explicit retired state, or another small additive fact.

Treat `seriesId` as an opaque selector returned by the active platform. Do not construct it in the mobile client or assume that edge and cloud hashes are interchangeable. `sourceKey + channelKey` is the semantic identity within one zone; `seriesId` is the API selection token.

### Range, aggregation and limits

The Analysis APIs are the only existing pair with a first-class `90d` range. Cloud maps 30 and 90 days to 86,400-second buckets and rejects grids over 2,000 buckets. Edge accepts explicit ranges up to 400 days, scans at most 30,000 raw rows and rejects oversized requests. Both reject more than 25 selectors. Successful series report `truncated: false`; this does not prove that every requested series is present. Refused selectors usually appear in `dropped`, but cloud can remove changed-scope series after its retry without adding a dropped entry. Validate the returned ID set against the requested set.

The older card-history path has different behavior. It exposes no `90d` label, the shared viewport adapter sends a 90-day request as `range=30d` plus explicit dates, and both card backends cap each series at 2,000 points. Edge retains the latest 2,000 points while cloud retains the first 2,000. The real-data mobile Chart must not inherit that mismatch.

All query windows use `[from, to)`. Separate the logical viewport request from the backend transport range. For hourly edge requests, floor `from` and ceil `to` to UTC hour boundaries; edge otherwise anchors buckets to arbitrary request starts and clips the final bucket. Cloud receives the exact logical bounds and aligns its grid internally. Neither changes the displayed viewport.

Do not pad a logical request of at most 24 hours. Send label `24h` for that span and `7d` for larger spans in this tranche, with `aggregation: hourly`. Cloud chooses raw-hourly versus stored-rollup reads from the original request duration, before grid alignment. The request/cache policy must distinguish those paths even though both return hourly values. A cached seven-day rollup must not satisfy the 24-hour raw-hourly request. Edge transport can exceed the seven-day viewport limit only by the hour alignment at its boundaries.

Transport coverage is a query guarantee, not sample coverage or freshness. The client must reject incomplete series sets and expose missing data. Preserve each bucket's actual interval, count and quality; validate cloud grid metadata and derive edge hourly intervals only after checking its aligned transport bounds and applied aggregation.

### Timezone and locale

Edge Analysis daily buckets use the zone's farm timezone. Cloud Analysis currently aligns daily buckets to UTC and returns `range.timezone = UTC`. Before the 30-day and 90-day options can ship, cloud and edge must agree that daily buckets represent the zone's local day, including 23-hour and 25-hour DST days.

The shared uPlot core is also incomplete for production use. Axis ticks are created with `Intl.DateTimeFormat('en-GB')`, while the visible-window and inspector timestamps use the browser defaults. Add explicit `locale` and IANA `timeZone` inputs to the shared core and pass the interface locale and zone timezone. The audited cloud main has no shared-core vendor package; establish its copy and parity workflow as part of the first slice. A browser timezone must not change the instant or date shown for the same zone.

### Validity and units

The old fixture rule that rejected SWT above 300 kPa is stale. Edge cached `origin/main` defines the common display domain as finite `0..1,000,000 kPa`, with Wet below 20, Moist from 20 through 50, and Dry above 50. The cloud frontend uses the same broad display domain. This is not a backend raw-reading validation guarantee. Production integration must update fixture-derived text, invalid examples and tests before cutover.

Hourly aggregation can hide invalid constituent readings: `30` and `1,000,001` average to `500,015.5`, inside the frontend domain. This slice validates only returned hourly averages; label its diagnostic accordingly. It must not claim to detect all invalid raw readings. Paired upstream validation/correction remains a data-quality release requirement and is outside this UI slice.

VWC uses the separate `0..100 %` display contract. Measured zero is valid for both quantities. Catalog units are evidence to validate a mapped series, not the key used to choose a measurement or status policy.

## Slice 1 internal Chart design

The first integration tranche is an internal opt-in Water tension Chart for one zone, initially over 24 hours and 7 days. These ranges are temporary seam work. They prove the read and rendering path without depending on daily-bucket parity; they are not the release range set.

1. Filter the Analysis catalog to the active zone, `cardType=soil`, `channelKey` matching `swt_1..3` and `availability=available`. Keep `configurationState` and any history evidence intact until the historical-source policy is reviewed.
2. Map each entry to the accepted source model using its opaque `seriesId`, stable `sourceKey`, channel key, device name, depth and `kPa` unit. Keep multiple devices and repeated depths separate.
3. Send the selected `seriesId` values to the platform's Analysis series endpoint with explicit `from` and `to`. Display every eligible source, but allow at most 25 included series. Initially include up to eight, ordered by source key then channel key; never silently discard a saved selection or auto-fill a deliberately empty one. At the cap, keep unchecked sources visible with an explanation that a selected source must be removed first; selected sources remain deselectable.
4. Adapt returned instants and values into the canonical uPlot core. Reject an unexpected unit, an unrequested or duplicate response ID, a missing selected ID even when `dropped` is empty, `truncated=true`, a dropped selected series, or a non-finite timestamp. Preserve coverage and the applied aggregation in the client result.
5. Render Chart time in the configured zone timezone and values in the interface locale. Apply the display-domain check to returned averages. The inspector selects the bucket containing the tap, labels its interval as an hourly average, and formats numbers with at most six significant digits. Null buckets stay unavailable; never substitute a neighbouring hour.
6. Preserve source inclusion, legend focus, viewport and empty-interval behavior. With only Water tension, omit redundant measurement and presentation controls. Keep the compact header, Time sheet, tall chart, aligned unit and compact legend. Calendar, Profile and Irrigation history remain unavailable on this route.

The tranche uses protected routes `#/internal/mobile-history/zones/:zoneId` on edge and `/internal/mobile-history/zones/:zoneId` on cloud, enabled only by a build with `VITE_MOBILE_HISTORY_INTERNAL=true`. It must not replace the existing default history route, fixture preview or real-data pilot; their accepted 90-day behavior remains available during the work.

The client partitions catalog, range and prefetch caches by platform, authenticated session and zone. Logout, account change and zone change invalidate the relevant entries. Abort obsolete requests and reject responses whose request identity no longer matches the active session, zone, selection or viewport. During range loading within the same authenticated source context, retain cached samples at their true timestamps under the active viewport and show a compact loading state. Never stretch old samples into the requested interval or label them as newly loaded. Clear plotted data immediately on account, zone or measurement changes. Removing a source from a loaded selection filters it locally without requesting the remaining sources again. Adding sources keeps compatible existing series visible while the addition loads. Source selection and transport revisions must not reset the viewport or permit stale responses to commit.

Zero selected sources means Choose sources and no history request. An interval is empty only after successful coverage of the visible interval and when no selected bucket overlapping it contains a valid finite average. Pending or uncovered intervals remain loading. Empty intervals retain gestures and Show latest 24 hours.

Dropped or missing selected IDs trigger one catalog refresh and a per-source removal action; a server-side cached catalog must not cause an automatic retry loop. Access-denied sources disappear from plots and caches immediately. HTTP 413 or the explicit cloud `range_too_large` code offers a shorter window or fewer sources, without retrying the identical request. Map 401/403 through the shared authentication error contract; keep transient network Retry separate.

Reuse the existing bounds of at most one foreground request, one adjacent prefetch, eight cached entries and 20,000 cached points. Deduplicate equal requests and prioritize foreground work. Reproduce the dense pilot baseline separately from valid hourly API fixtures, and measure discovery time as well as series time. Client cancellation prevents stale display; it does not prove the server stopped a query.

The next Chart step adds 30-day, 90-day and custom ranges after farm-day aggregation matches on edge and cloud. Ninety-day parity is a release gate. The response must name the applied aggregation and zone timezone. Preserve the accepted preset semantics: 90 days means 90 × 24 elapsed hours. Farm-local daily bucket boundaries are a separate aggregation concern; intersect them with the requested interval and identify partial boundary buckets rather than extending the window. Inclusive custom local dates remain subject to the same elapsed-span limit and explicit validation. Test both DST directions, boundary coverage and an interval containing no samples; do not silently redefine the preset as 90 whole local dates.

## Calendar contract required before implementation

Current history calendars classify aggregate points into generic states. They do not return the accepted named per-source summary, its observation timestamp, or the complete rain and irrigation context. Calendar therefore needs a reviewed additive read contract. One day must carry:

- local `date`, zone timezone and day bounds;
- primary `seriesId`, `sourceKey`, summary kind, value, unit, reading state, coverage and `observedAt` when the summary is an observation;
- zone rain amount, source label, coverage and received-only amount when the total is uncertified;
- irrigation event count, known total duration and read-only event rows.

The edge-authored `zone_daily_environment` row already supplies the correct rain projection: one selected gauge, `rainfall_mm`, `rain_source`, `rain_coverage`, `rain_selected_deveui`, `rain_received_mm` and quality reasons. The cloud mirror receives those fields. The API must resolve a farmer-facing gauge name and preserve unknown, partial, complete-so-far and legacy states. It must never add gauges or substitute received-only rain for a certified total.

`flow_liters` is measured flow and is not irrigation event duration. Event count and duration must come from the irrigation event records. Before implementation, decide which event states count, how missing duration is represented, and which field supplies the recorded outcome.

Water tension's fixture summary is a `14:30 reading`. Production needs an explicit selection rule for days without an observation at exactly 14:30. The API may require an exact timestamp, or a reviewed nearest-observation tolerance; the client must not invent one.

## Profile contract required before implementation

The existing profile DTO contains depth, value, unit and status but no snapshot timestamp. Card aggregation can also take the latest value of each channel from different rows or devices. That cannot support the accepted exact-snapshot claim.

The first real Profile contract must select one source device and return `snapshotAt`, timezone and layers from the same device row. Each layer carries channel key, depth, value, unit, state and `observedAt`; null layers remain present. A later design may compare probes. Multiple devices at the same depth must not be averaged or silently merged.

## Open decisions and gates

Root review must settle these points before Calendar or Profile work starts:

1. Exact observation rule for the 14:30 Calendar summary.
2. Single-probe selector and snapshot choice for Profile.
3. Irrigation event inclusion, duration and outcome fields.
4. Whether Calendar reads a new history endpoint or a zone-scoped daily-summary endpoint shared with other screens.
5. Cloud farm-day aggregation change and the common top-level timezone field for 30/90-day Chart.
6. Historical-source policy across `current`, `other_supported`, retired configurations and retained data bounds.
7. Raw-reading validation before aggregation and verification of timezone configuration; a valid `UTC` value can be a database default rather than an explicit farm choice.

No schema migration is justified by the Chart slice. Calendar appears able to use existing telemetry, rain projection and irrigation-event storage, but that must be confirmed against representative edge and cloud rows before its API design is implementation-ready.

The [Slice 1 implementation plan](../plans/2026-10-24-mobile-history-real-data-slice-1.md) specifies the internal hourly route and its verification gates. The [controlled loading baseline](../../operations/mobile-history-loading-baseline-2026-10-24.md) records desktop browser measurements with synthetic delayed responses.
