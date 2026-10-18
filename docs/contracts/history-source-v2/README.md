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

The edge selector remains `environment-src-*`; the cloud selector remains
`env-src-*`. They identify the same current authorized device but are host
specific. Authorization is evaluated against the requested account, gateway,
and zone before a source is returned.

## Time and values

Raw values retain their stored precision. Fixed buckets retain the host's
existing boundaries and expose the actual covered interval. Edge daily buckets
use the farm timezone; edge fixed-second buckets can be anchored to the request.
Cloud typed rollups use UTC. Weekly alignment follows the host's current call
options. The requested display timezone is metadata and does not redefine bucket
geometry.

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

## Shared fixture ownership

`identity-vectors.json` and `synthetic-cases.json` are synthetic, cross-host
fixtures. The cloud test vendor under
`backend/src/test/resources/history-source-v2/` must be byte-identical. Run
`node scripts/verify-history-source-v2-fixtures.js` from the edge worktree to
verify that parity. No private field CSV or customer identity belongs in either
copy.
