# Source-preserving measurement history v2

This contract keeps a measurement trace tied to its physical device and channel
from the raw observation through aggregation and the serialized history response.
The response marker is `seriesIdentityVersion: 2`. A measurement consumer must
reject a response that lacks that marker or source metadata.

## Series identity

The canonical DevEUI is uppercase hexadecimal with separators removed. The
physical source identifier is `device-` followed by the first 12 lowercase
hexadecimal characters of the SHA-256 digest of that canonical EUI. A series ID
is `deviceSourceId:channelKey`; channel keys are canonical measurement fields
such as `swt_1` or `ambient_temperature`.

Every measurement series carries `id`, `deviceSourceId`, the host's existing
`sourceKey` selector, `channelKey`, device and channel labels, unit, nullable
depth, and `metadataBasis: current_configuration`. Names, depth, and list order
are display metadata and never identity. A response must fail closed if two
physical sources produce the same series ID.

The edge selector remains `soil-src-*` or `environment-src-*` by card; the cloud
selector remains `soil-src-*` or `env-src-*` by card. They identify the same
current authorized device but are host specific. Authorization is evaluated
against the requested account, gateway, and zone before a source is returned.

Three identifiers name a source, at different scopes. `deviceSourceId` is the
physical identity and is the same value on both hosts. `sourceKey` is a
per-host selector whose 12-character suffix is the `deviceSourceId` suffix.
On the edge, the history router (`displaySafeSourceKey`) and Analysis and
export (`sourceKeyForCsv` in `osi-history-helper`) derive the same soil and
environment selector; the cloud derives `soil-src-*`, `env-src-*` and
`dendro-src-*` in `HistoryCardService`.
`identity-vectors.json` pins both hosts' selectors per card. The Analysis
`seriesId` is the first 16 hexadecimal characters of the SHA-256 digest of
`zoneId|cardType|sourceKey|channelKey`. It selects one series within one zone,
so it is not a device identity: it changes when the device moves to another
zone.

An edge HTTP request that names a source resolves an explicit, authorized
physical-device list. Its retained reads use that device's source-keyed rollups
and keep the device/channel partition, including the per-device SWT3 eligibility
rule. A source-filtered request without that authoritative device list stays on
raw source-filtered reads and cannot fall back to pooled rollups. An
authoritatively empty source list returns unavailable measurement data; it does
not broaden the query to pooled or all-device history.

## Time and values

Raw values retain their stored precision. Fixed buckets retain the host's
existing boundaries and expose the actual covered interval. The edge HTTP card
route passes the zone timezone, which is also the timezone the edge rollup job
writes in. Its daily buckets end at the zone's local midnights
(`bucketAlignment: zone_calendar`, `bucketTimezone` is the zone). Its
fixed-second buckets, weekly seven-day steps included, are anchored to the
request (`bucketTimezone: UTC`, `bucketAlignment: request_anchored`). A
retained edge rollup row serves the request bucket that contains its
`bucket_start` and keeps its stored interval; when several rows fall in one
bucket, the edge keeps the one with samples, then the higher coverage, then
the latest write. Edge exports and analysis calls may pass the farm timezone.
Cloud typed rollups use UTC. Weekly alignment follows the host's current call
options. The requested display timezone is metadata and does not redefine
bucket geometry.

Timestamp placement follows each existing path. Cloud raw aggregates use the
bucket start for `t`; cloud persisted rollups use `latestRecordedAt` when it is
stored and fall back to the bucket start. Edge rollups have no stored
latest-observation timestamp, so their `t` is the bucket start. The shared
response fixture records `t`, `bucketStart`, and `bucketEnd` so a consumer can
distinguish plot placement from the covered interval.

Interactive measurement responses on both hosts expose a total point limit of
`30000` in `limits.maxPointsTotal`, alongside the existing `2000`
per-series limit and `30000` raw-row limit. For aggregated responses, the
eligible physical source/channel grid is counted before retained reads and
grid allocation, including null gap cells. Edge also preflights resolved
non-raw grids that are derived from short-range raw observations, using the
same floored bucket geometry as its output path. For resolved raw responses,
eligible returned physical points are counted after each host's existing
deduplication and validity rules and before DTO expansion. A request at
exactly `30000` points succeeds. A request over either point bound returns the
complete set of authorized source descriptors with empty point arrays and
`point_budget_exceeded` plus
`select_fewer_sources_or_coarser_aggregation`; neither host returns partial
measurements. The host's legacy `limits.truncated` metadata differs: edge
returns `false` for this whole-request rejection, while cloud returns `true`.
Clients must use `availability.available: false` and its reasons as the
authoritative rejection signal. The response retains
`limits.maxPointsTotal: 30000` so clients can recover by selecting fewer
sources or a coarser aggregation. Raw-row overflow remains distinct and
returns `raw_read_limit_exceeded` plus
`select_fewer_sources_or_shorter_interval`. These limits apply to interactive
measurement responses only; maintenance, export, and legacy interfaces retain
their existing behavior.

Within each source, the affected sensor plots use the latest observation in a
bucket. Specialized rain, counter, and analysis reducers keep their existing
semantics. Zero and valid high values remain measurements; nonfinite or missing
values remain unavailable. A missing source bucket is `null` and is rendered as
a visible break. Values from another source are never carried into it.

At the edge, equal-time duplicates are ordered by the greatest
`device_data.id` within one device/channel/timestamp before validity filtering.
An invalid newer row therefore hides an older valid row for that timestamp while
both rows remain available to raw/export evidence. Cloud keeps its existing
ingestion precedence; edge row IDs are not cloud row IDs.

The marker describes series identity, not a new storage format. It does not add
a SQLite column, Flyway migration, rollup namespace, or historical membership
ledger. Non-measurement events and derived analyses retain their existing
contracts.

## Shared fixture ownership

`identity-vectors.json` and `synthetic-cases.json` are synthetic, cross-host
fixtures. The cloud test vendor under
`backend/src/test/resources/history-source-v2/` must be byte-identical. Run
`node scripts/verify-history-source-v2-fixtures.js` from an ordinary edge
checkout to verify that parity; the default cloud root is the sibling
`../osi-server`. An isolated source-preserving worktree uses the explicit
override:

```text
export HISTORY_SOURCE_CLOUD_ROOT=/path/to/osi-server-worktree
node scripts/verify-history-source-v2-fixtures.js
```

No private field CSV or customer identity belongs in either copy.
