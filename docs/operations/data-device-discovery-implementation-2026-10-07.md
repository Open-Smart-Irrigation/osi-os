# Data-view device discovery execution record

Implemented on `fix/data-device-coverage`, based on `242ca634961b5305f40197e771e197a5eaa0f61a`, and carried to `fix/data-device-coverage-main` on the same base. Commit hashes on the carried branch differ from the hashes reviewed below because test fixtures were rewritten to the documented example EUIs; the code is unchanged, so this record names commits by subject. This record covers public code and synthetic fixtures only. Deployment and branch integration remain separate actions.

## Cause and corrected behavior

Data discovery reused history-card eligibility as a device catalogue. LoRain was missing from the environment predicate, devices without assigned zones had no enumeration path, and supported historical channels disappeared when current configuration stopped advertising them. The sensor readings were already stored; repairing storage or changing the decoder would not make the omitted devices appear.

The catalogue now enumerates authorized devices first and returns explicit source descriptors. Known types expose finite supported channel sets; current configuration separates ordinary choices from collapsed historical candidates. Devices with no plottable channels remain visible with an explanation. Specialized radio sources link to Network only when that module is available. Unassigned sources have null zone membership and independent device identities.

Server-derived access options preserve owner-only behavior when scoped access is off and claimed account-wide discovery when enabled. Request parameters cannot broaden access. Series and saved views re-resolve selectors against the current authorized catalogue. Same-name devices keep distinct source IDs and independently controlled chart legends.

LoRain interval rainfall and tips sum; temperature, rates and voltage average; daily and cumulative counters use the latest finite observation. Zero remains a reading, and empty buckets remain null. Legacy LoRain export reads raw rows when existing rollups cannot supply correct interval totals. Catalogue construction does not scan measurement history or issue queries per channel.

## Delivery boundaries

No schema, seed, ingestion, device commands or cloud contract changes are required. Both maintained runtime profiles match, the new helper appears in deployment lists, and CI runs the discovery, authorization, metadata and regression tests. Nine new Luganda source-tray strings use the documented English fallback pending human translation.

Final review found that current configured depths needed an explicit qualifier on historical exports. Commit `fix(analysis): qualify configured soil depths` adds `depthReference: current_layout` to configured device depths and appends `depth_reference` to CSV without moving existing columns. A legacy response with unqualified depth exports `unspecified`; removed SDI12 layout keys keep null depth. The measured values and series IDs stay unchanged. Incomplete correlation pairs now use the insufficient-data explanation rather than claiming multiple selected series. Both findings are closed by the final reviewer.

## Verification

Independent checks at `test(analysis): tighten stale source and timestamp fixtures` passed: 81 helper tests per profile with one opt-in benchmark skipped; 122 API/access/timestamp/export tests; 74 router assertions per profile; GUI typecheck, 229 runner tests and 2,614 Vitest tests; profile, manifest, delivery, flow, contract and full-sync gates. The built-output assertion ran against the reviewed production build.

Mounted Playwright checks used synthetic intercepted APIs. They covered discovery, same-name sources, unassigned selection, saved views, CSV zero/6/null cells, source-only search, Network states, old-backend responses and the existing mobile redirect. These are mounted GUI checks, not a claim of live end-to-end deployment.

The native `sqlite3` portion of one broad verifier used its documented source fallback because that optional local dependency was missing. Real SQLite tests used Node DatabaseSync and passed. No live database mutation or deployment was performed.

The final correction received independent focused verification at the soil-depth commit: the real-SQLite depth-change regression passed in both profiles, 20 CSV/correlation tests passed, and typecheck, fresh production build, four built-output assertions, profile parity and the mounted browser checks passed. The historical reproduction changed one configured depth and removed another while preserving older measured values and selector identities. The working tree was clean at acceptance.

A later review found a shared source-identity edge case: separator variants of the same DevEUI received different source IDs. Follow-up `fix(history): canonicalize device source IDs` normalizes and validates the EUI before hashing, preserving existing canonical IDs. Its focused review and verification are recorded separately from the earlier final depth-fix acceptance.

## Carried branch

`fix/data-device-coverage-main` adds `scripts/test-history-source-guards.js` (eight tests, both profiles, registered in CI). Two of them fail if the history helper stops exporting `soilDepthCm` (the extracted history route returns 500 instead of a soil profile) or if a filtered zone export stops skipping a device whose eligible channel list is empty (hourly and daily mixed-device exports fail). The other tests pin WATERMARK evidence, Chameleon SWT3 and the raw fallback for soil cards with an SWT3-ineligible LSN50 source. Plan Task 6, the adaptation for a separate deployment line, is no longer needed: that line now follows main.
