# Data-view device discovery correction

Date: 2026-10-07. Status: ready after committee review; no runtime changes.

Data view must list every active device the current account may read, including
unassigned devices and devices whose newest uplink contains no measurements. A
supported measurement must be selectable and readable from its existing store.
Devices with specialized records must remain visible with an explicit destination
or limitation. A channel without samples must show no data, never a measured zero.

The user requested a correction plan and a fresh expert committee review. That
request authorizes this planning and review pass, not a live deployment.

Review: [committee findings and dispositions](../reviews/2026-10-07-data-device-discovery-review.md).

## Evidence and cause

The investigation reproduced a LoRain omission using the deployed history helper
and read-only database queries. A registered, zone-assigned gauge had six stored
rows, including one valid 6 mm interval and a matching daily aggregate. Its
configuration row yielded no history card and no Data-view catalogue entries.
Combining that row with the existing measurement in memory made the environment
card appear. No database mutation was used.

The current public base is `06e691e850384b1d5ecbacbe24439a257a70c983`.
`osi-history-helper/analysis.js` enumerates zone devices, then reuses
`deriveCardsForZone` and `sourceDevicesForCard` to discover channels.
`isEnvironmentSource` in `index.js` omits `AQUASCOPE_LORAIN`. The separate
`osi-history-router/index.js` predicate also omits it; both paths must use the
helper predicate. Its measurement-based
fallback receives configuration rows without `device_data` fields. Unassigned
devices are excluded earlier by the per-zone query. The same LoRain predicate is
present in the private deployment branch inspected during the investigation.

`AnalysisSeriesTray.tsx` groups only returned channels, so a device with zero
catalogue channels cannot appear. It also keys device groups by display name,
which can merge two devices named alike. Existing tests cover selected types but
have no LoRain catalogue fixture.

## Approaches considered

1. Add LoRain to the existing predicate. This fixes the immediate missing gauge,
   but leaves unassigned devices and other unsupported classifications invisible.
2. Enumerate authorized device sources independently of history cards, with a
   small static source policy and explicit channel mappings. This satisfies the
   requested visibility rule and preserves existing chart infrastructure.
3. Build a general device plugin registry and dynamically discover schema fields.
   This changes onboarding and ingestion beyond the task and conflicts with the
   registry deferral in ADR 2026-05-28.

Use approach 2. Also repair LoRain's legacy history-card predicate, since Data
view and the existing history/export surfaces must not disagree about this gauge.

## Visibility and access contract

Discovery starts with active device identities, not recent values. A registered
source remains visible before its first measurement, after a reporting gap, and
when the latest row is configuration-only. Deleted device records remain excluded;
restoring deleted-device history is a separate retention/product decision.

Preserve the actual read policy. With `OSI_SCOPED_ACCESS=1`, enabled users read
account-wide device data, including viewers and users without zone write grants.
With the flag off, reads remain owner-only. Disabled users are refused. Existing
admin-only radio/diagnostic routes retain their guards. Saved analysis views stay
per-user. No cloud access or cloud contract change is needed.

Introduce an explicit server-derived `unassignedAccess: 'none' | 'owner' |
'account'` catalogue option, defaulting to `none` for callers that have not opted
in. The authenticated analysis router passes `owner` on the flag-off path and
`account` on the scoped path. Never accept this field from an HTTP body or query.
Pass it consistently to catalogue, series, and saved-view resolution. Owner-mode
unassigned rows require `user_id = currentUserId`; account-mode unassigned rows
require `user_id IS NOT NULL`. Unclaimed devices are excluded, as in the existing
account device-list contract. Assigned devices in readable zones remain visible
even when their user_id is null. Explicit
empty `zoneUuids` must not silently become a wildcard.

## Catalogue shape and identity

Keep `channels` and add `sources` to `GET /api/analysis/channels`, including the
explicit response projection in `analysis-api-router-fn`. A device source
exists even if it has no time-series channel. Existing clients can ignore the
new field. The new GUI derives legacy source groups from channels when `sources`
is absent, so an older backend continues to work.

A source has a stable opaque device identity distinct from its display name and
per-family channel source key. Use `device-` plus the first 12 hex characters of
SHA-256 over normalized DevEUI, following the existing display-safe key pattern.
Do not expose AppKeys, raw uplinks, credentials, or full configuration records.

Device channel entries and resolved series add `deviceSourceId`; provider/weather
entries leave it null. Sources carry `hubEui: string | null`, `zoneId: number | null`, `zoneName: string | null`, name,
typeId, channel IDs, and `presentation: 'timeseries' | 'specialized' |
'unsupported'`. Unassigned groups use null, never a fake database zone 0. The GUI
renders a translated “Unassigned devices” label and groups devices by identity.

Existing assigned `seriesId` hashes remain unchanged. New unassigned series use
`unassigned` as the hash's zone component. On assignment changes an obsolete
selector is reported dropped through the existing saved-view behavior; do not
silently retarget it to another zone or owner. Rename does not change IDs.

## Source and channel policy

Add `osi-history-helper/device-sources.js`, a private helper with no registry,
loader, or database ownership. It returns source families and declared channel
keys from type and configuration. The backend remains the authority; the Data
view UI renders its answer rather than maintaining another type allowlist.

| Device | Data-view representation |
|---|---|
| AQUASCOPE_LORAIN | Environment: interval mm, tips, today mm, hourly and ten-minute rates, ambient temperature; device health: battery voltage. No humidity or wind channels. |
| KIWI_SENSOR | Existing SWT 1/2 and climate/light channels; measured battery fields. |
| TEKTELIC_CLOVER | Actual persisted temperature/humidity/light and battery channels supported by its ingest. Do not advertise unimplemented VWC. |
| SENSECAP_S2120 | Persisted weather/rain channels and battery; keep provider and hourly-station sources distinct. |
| DRAGINO_LSN50 | WATERMARK/Chameleon, external temperature, dendrometer, rain or flow according to existing configuration and evidence rules. Rain/flow enablement must not depend on temp_enabled. |
| DRAGINO_SDI12 | Existing probe layout/depth-derived channel resolver, with current WATERMARK evidence behavior preserved. |
| MILESIGHT_UC512 | Pipe pressure, pulse counters, measured battery; valve state remains clearly labeled device status, not an invented scalar agronomy value. |
| STREGA_VALVE | Measured battery and enclosure climate as device health, never zone weather; actuation history shows an explicit limitation in Data view. Gen2 enclosure channels are historical candidates, not claimed current telemetry. |
| RAK10701_FIELD_TESTER | Visible specialized source linking to the existing Network view; do not query device_data to infer last seen. Honor module visibility and destination authorization. |

A generic fallback source row names the device and states that its measurements
are not supported by this view; it must not disappear. This is a backstop, not a
substitute for the nine shipped types above. This correction does not add radio
charts or scalar encodings for textual valve states. It does make those sources
visible and explains where their specialized data can be inspected.

Retain source identity regardless of enabled channels. Separate channel support
from current configuration: emit the finite set of stored numeric keys that the
device type can produce, with `configurationState: 'current' | 'other_supported'`.
The latter appear in a collapsed “Other supported channels” section explaining
that historical samples may exist and that no data has been checked. This is not
an availability claim. This finite policy keeps old selectors resolvable without
scanning history or adding a capability database. Never enumerate arbitrary SQL
columns or all environment channels for every type.

For LSN50 retain its explicitly mapped temperature, rain, flow, dendrometer and
SWT channels after their flags turn off; classify them as other_supported. Preserve
WATERMARK/Chameleon evidence checks in the value reader, including SWT3 eligibility;
a candidate channel does not make an unqualified measurement valid. For SDI12 keep
the union of supported persisted probe keys from its ingest mapping when layouts
shrink. Current depth labels apply only to configured keys, with a current-layout
qualifier; absent keys have null depth, and historical physical depths cannot be
reconstructed. Neither layout nor configurationState enters the series hash.

Read STREGA generation from a batched LEFT JOIN to valve_settings, default GEN1,
not a nonexistent devices column. GEN2 retains enclosure keys only as
other_supported, so old GEN1 samples remain readable. Catalogue work uses
configuration plus the existing bounded evidence queries; the series reader reads
only the requested range. No full historical non-null search occurs at discovery.

Keep the manifest-derived `CHANNELS` contract unchanged. Add a separate
`DEVICE_HEALTH_CHANNELS` set in analysis.js for bat_v (V), bat_pct (%), and
valve_1_pulse/valve_2_pulse (count). Verify its keys, units and edge fields against
the existing non-exportable gateway entries in channels.json, with a fixed
allowlist of these four keys. Union it into channelMeta and the SQL field allowlist.
Its samples may be charted and exported by Data-view CSV only; this does not change
legacy zone-export eligibility or the global manifest's exportable flag. STREGA
climate reuses the existing canonical temperature/humidity fields but overrides
the source family to device_health; do not duplicate their global metadata keys.
The existing flow_pulses_delta entry stays in CHANNELS.

## Measurement and UI semantics

Reuse the existing series reader and timestamp normalization added in #456.
Raw interval rain remains the recorded value. Aggregated rain/flow deltas and tip
increments use sums; temperature, voltage and rates use means. Running daily or
cumulative counters are never summed. Use last observation with chronological ordering for running counters. An empty bucket is null, and a recorded
zero remains zero. Do not repair ingest or daily aggregation as part of discovery.

The source tree displays all authorized device sources. Weather-provider groups
retain their current ordering. Devices with identical names render separately.
Destinations are deliberately limited to `network | null`. RAK uses `/network`
when `useGatewayModules()?.network === true`, matching FieldTesterCard. While
settings load or the module is disabled, retain the source with an explanation
and no link; inherit the hook's existing failure fallback. The Network API retains
its own device-read and admin-only raw-download guards. Discovery never reads raw
radio records to decide visibility. STREGA and UC512 show “Valve events and controls
are not available in Data view” beside their numeric channels; this correction
adds no irrigation deep link. Unknown types receive an unsupported explanation.
Source visibility does not depend on the selected chart time range.

The timeline, saved views, correlation, and Data-view CSV export accept unassigned
entries. CSV uses the stable label `Unassigned devices` when resolved.zoneId is null,
even without a catalogue entry; assigned missing-entry rows retain their numeric
zone fallback. Existing assigned IDs remain unchanged.

Correlation needs explicit grouping. Preserve pairing across different devices in
one assigned zone only when exactly one selected X and one selected Y exist for
that zone. If either axis has multiple candidates, suppress that group's result
with an ambiguity explanation; never overwrite a candidate. For unassigned data,
pair within one deviceSourceId, never across devices just because both have null
zoneId. Use a separate groupId (`zone:<id>`, `device:<id>`, `pooled`) in maps, plots
and React keys; null membership is not the pooled identifier. Pool only valid,
unambiguous groups. Older assigned responses keep zone grouping; an unassigned
response without deviceSourceId is suppressed with an explanation. The across-zone
metric picker excludes unassigned rows; the source tree still selects them.

LoRain legacy history/export is also repaired: the router delegates eligibility
to the helper. Raw CSV remains raw. Its hourly/daily CSV chooses sums for interval
mm/tips, latest for today mm, and means for temperature/rates. Compute those CSV
aggregates from range-bounded device_data, including when rollups exist: old
rollup rows have no sum and must not be presented as totals. Existing history
statistics retain their meanings (mean remains mean); this does not redesign
legacy charts or rewrite rollups. Other devices' legacy CSV behavior stays
unchanged. Regression tests cover LoRain raw, aggregate and rollup-present paths.

The public implementation keeps nine new source-tray strings in Luganda as
explicit English fallbacks until a human translation is reviewed. The pending
keys are tracked in `docs/i18n/pending-luganda-translations.md` and enforced by
the locale test. Chart builders also disambiguate duplicate display labels in
`series.name`; ECharts uses that name for legend selection even when each
series has a distinct stable ID.

## Boundaries and delivery

No schema migration, device re-registration, seed rewrite, or history backfill.
No change to sensor reporting intervals, downlinks, actuator behavior, MQTT,
cloud sync, zone ownership, or existing write permissions.

Implement against a fresh isolated checkout of the public base, then adapt the
fix to the private deployment branch. Do not merge customer history into public
origin. Keep live account/device identifiers out of public fixtures and docs.
Both Pi payload profiles must match byte-for-byte. New helper files must be listed
in deploy.sh before any deploy can be considered. The offline bundle derives its
file list from deploy.sh; the deploy coverage verifier checks this path.

A successful delivery has a tested LoRain chart and export, visible unassigned
sources, complete source coverage for the nine shipped device types, and negative
authorization tests. A separate authorized live verification checks the original
installation after deployment; planning evidence is not deployment evidence.
