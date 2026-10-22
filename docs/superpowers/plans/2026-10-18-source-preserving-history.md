# Source-preserving sensor history

This repair keeps each sensor trace attached to one physical device and channel from storage through the history API and chart. A zone with two sensors shows two traces. It must never join alternating measurements from those sensors into one line.

The implementation uses the existing raw and per-device rollup stores. It does not change ingestion, calibration, retention, sync payloads or database schemas. Pooled historical rollups remain stored but are excluded from corrected measurement traces.

## Measurement contract

The canonical contract and synthetic vectors live in [history-source-v2](../../contracts/history-source-v2/README.md). Updated measurement responses advertise `seriesIdentityVersion: 2`. Each series contains:

| Field | Meaning |
| --- | --- |
| `id` | `deviceSourceId:channelKey` |
| `deviceSourceId` | `device-` plus the first 12 lowercase SHA-256 hex characters of the normalized uppercase DevEUI |
| `sourceKey` | Existing host selector for the currently authorized device |
| `channelKey` | Canonical channel used for units and classification |
| `sourceLabel`, `label` | Current device name and channel label |
| `unit`, `depthCm` | Channel unit and current depth, nullable when absent |
| `metadataBasis` | `current_configuration` |

An empty current authorized-source set returns an unavailable response with no measurement series and does not query a legacy pooled or unscoped fallback. Internal compatibility callers must remain distinguishable from an authoritative empty scope.

Names and depth do not define identity. A duplicate identity must fail closed. Source selectors remain host-specific: soil uses `soil-src-*`; environment uses `environment-src-*` on edge and `env-src-*` on cloud. Every selected source must belong to the currently authorized card scope. Cloud root-soil membership is deliberately independent of the device claimant; selecting a contributor already returned by that root card uses the same current manifest. Non-root claimant restrictions remain in force.

Updated clients require the marker and source metadata. The corrected API does not negotiate a pooled compatibility response. A tab still running the previous bundle may misclassify or omit new series and needs a reload; a new cache key cannot replace code already running in that tab.

## Values and time

Affected sensor plots use the latest observation within each source and bucket. Measured zero and valid high values remain visible. Missing measurements produce explicit null gaps. Specialized rain, counter and derived-analysis reducers retain their existing semantics. Exports that use a mean must say so rather than implying equality with a latest-value plot.

At the edge, equal-time duplicates are resolved by greatest `device_data.id` within a device/channel/timestamp before validity filtering. The original rows remain available as raw evidence. Cloud retains its existing ingestion precedence; cloud row IDs do not represent edge insertion order.

Each route keeps its existing bucket alignment. Cloud retained buckets use UTC. The edge history HTTP route currently omits a timezone option and therefore uses UTC; other edge callers may supply the farm timezone. This repair does not align those routes. Cloud retained points keep `latestRecordedAt` as their plot timestamp when present, with bucket start as fallback. Synthetic missing points use bucket start. Edge stored rollups have no latest-observation timestamp column.

Historical responses use current authorized membership, names and depths. They do not reconstruct past device assignments or configuration. A new numeric zone summary and cadence-based interpolation are separate work.

## Retained history

Cloud already stores per-device hourly and daily rows. Long-range reads must use those rows after raw retention expires, with a batch query scoped by zone and authorized source keys. No interactive long-range JSONB scan or blanket backfill is needed.

Season reads reconstruct missing weekly buckets from retained daily rows per source and channel. Counts sum, means use sample-count weights, and min/max/latest use the corresponding retained evidence. Daily medians cannot produce a weekly median. Unsupported or incomplete statistics have explicit `statisticAvailability`; `coverageAvailability` distinguishes missing retained rows from persisted zero-sample markers.

The expected UTC bucket grid makes absent hourly, daily and weekly buckets visible as nulls. Weekly candidates are compared per source/channel/week by positive sample count, then coverage completeness, then latest write time. A fuller old row must survive a newer partial reconstruction. The point budget is checked before allocating the retained grid.

Edge reads use the existing per-device `logical_source_key` rows. A partially populated rollup set must not suppress older reconstructable raw history. The raw recovery budget applies across the request, including its live tail; alternating missing buckets must not produce an unbounded sequence of queries. Missing intervals are reconstructed within a bounded query or returned as explicitly unavailable; pooled values are never a fallback. Selecting one source must continue reading its retained rows. The explicit source-aware path must not retain old pooled-data restrictions that disable rollups for selected sources or mixed plain-LSN50 cards. Descriptor-less filtered compatibility reads remain raw-only. Existing rolling maintenance windows do not prove full-history coverage. A wider rebuild requires a separate measured Pi workload.

Legacy edge device-history requests must keep the requested DevEUI beyond 24 hours and preserve the requested resolution. Redirecting all long requests to the oldest-first, 30,000-row raw endpoint would lose that behavior. Over-limit legacy requests must return an explicit limit error rather than a successful empty or truncated array. Soil profiles must be built within one device.

## Client behavior and limits

Legends, tooltips, colors and visibility use stable series identity. Tooltips match observations by timestamp; array position cannot align asynchronous devices. An alignment-only absence has no tooltip entry, while an explicit null retains its availability explanation. A nearest-reading inspector must show each observation’s actual timestamp. Independent source arrays preserve raw connectors, while explicit nulls still break a line. Classification uses `channelKey`. Devices with equal names and depths remain distinguishable through a stable identity suffix, including source selectors and recovery choices. Existing channel-only visibility settings apply to all matching source traces and retain a reset path.

A scalar view that cannot represent several sources requires an explicit source choice. Cloud soil profiles remain unsupported, and the reachable default soil view is a line chart. Saved view choices must not strand users on an unsupported default.

Cache keys include the identity contract version while retaining existing session, scope, range and source boundaries. Old in-flight responses must not appear under a new scope or source label. Existing invalidation behavior remains in place.

An over-budget request returns authorized source descriptors with empty points and top-level `availability.available: false` with actionable `availability.reasons`; it never returns a silently sliced chart. Clients derive authorized recovery choices from the series descriptors. The legacy `limits.truncated` flag differs between hosts and is not the shared rejection signal. Raw-scan overflow requires fewer sources or a shorter interval. A point-grid overflow can also be resolved with coarser aggregation. The UI must send a narrower server request when it offers query-cost recovery. Source visibility applied after a complete response is a separate operation.

Existing 30,000-row raw-scan and 2,000-point-per-series protections remain explicit. Measurements exposed excessive retained expansion: 384,000 points required a 143 MB JSON response and about 1 GB additional heap on the development host. The revised plan therefore adds a 30,000-point total limit to interactive measurement responses. The measured 30,000-point case produced about 11 MB JSON and a 75 MiB heap increase. Aggregated grids are checked before reads and allocation; raw output is checked before projection. This is a conservative measured bound, not a Pi 4 qualification. Source count is unrestricted when the complete request fits, and source descriptors remain available for recovery. Recheck browser render cost and response behavior at the admitted boundary.

## Implementation order

| Task | Deliverable |
| --- | --- |
| 1 | Shared synthetic contract and regressions that fail on pooled attribution |
| 2 | Cloud source identity, retained reads, weekly reconstruction, authorized selection and backend consumers |
| 3 | Edge helper and actual HTTP route, per-device rollups, profiles, duplicates and legacy history |
| 4a | Main edge and cloud consumers, cache transition and actionable limit states |
| 4b | Existing preview clients and canonical shared chart package, with byte-identical cloud vendor copy |
| 5 | Backend-to-browser evidence, required gates, measured limits and independent final review |

Main fixes use isolated branches based on main. Preview client changes use separate branches based on the existing preview tips, and are tested against the corrected main backend. Those preview branches do not replace the main backend or import unrelated preview work into main.

Luna workers implement each task. Sol reviews the committed task diff for specification compliance and code quality, then reviews the complete change after integration. Runtime edge changes must be mirrored byte-for-byte between bcm2712 and bcm2709. Frozen boot DDL is unchanged.

## Acceptance evidence

The synthetic five-observation fixture uses two devices. For `[02:45,03:30)` UTC on 3 October 2026 at 15-minute resolution, A must yield `[2.296696, null, 2.322412]` and B must yield `[9.507932, 9.507932, 9.507932]`. Edge aggregate rounding permits at most 0.0005 kPa error; raw values remain exact.

Acceptance also covers same-time cross-device observations, the edge duplicate rule with a newer invalid row, zero/high values, heterogeneous channels, equal labels/depths, all-empty sources and scope changes. Every supported resolution needs a suitable fixture: a missing 15-minute report is not necessarily an empty hour. Retained-only rows, partial rollup coverage and weekly reconstruction must pass without raw data.

Real PostgreSQL tests must exercise query through service/controller serialization. Edge tests must execute the shipped HTTP function and helper against SQLite. Browser checks consume backend-generated responses at mobile and desktop widths, including the separate preview, and verify the source legends, A gap and unchanged high B values. Old saved frontend bundles are tested against the corrected response.

Run the applicable history tests, frontend unit tests, typechecks and builds; cloud backend and architecture tests; assembled frontend packaging; edge sync, payload parity, flow-size, no-new-DDL and no-silent-catch gates; and shared chart package tests/vendor parity. Record actual commits, commands and results in the execution record. Desktop benchmarks do not establish Pi performance.

## Delivery boundary

This execution prepares reviewed local branches. Live access, deployment, customer-branch changes and publication require separate authorization. Each host's backend and compatible client should deploy together, followed by its separate preview client. Record immutable prior and new versions before a canary.

A rollback to the old binary restores its known cross-device mixing behavior and may restore stale cached results. Live history availability, external API consumers and intended release-branch inclusion still need verification before rollout.
