# Matric potential precision and WATERMARK temperature execution report

Tensiomark acquisition now preserves native pF tokens and full-precision canonical kPa on the edge and cloud. Both dashboards place WATERMARK soil temperature beside probe 1, with its own history action, and expose the same temperature in the device's Data source. The existing unit setting continues to select pF or kPa for soil tension.

Implementation, deployment and independent live verification passed. All 25 final checks were green, including acknowledgement of every historical repair.

## Conversion and preservation

The shared mathematical contract uses the requested hPa convention:

```text
pF = log10(abs(kPa)) + 1
kPa magnitude = 10 ** (pF - 1)
```

Finite zero has no finite pF. Signed nonzero input uses its magnitude, and negative pF is mathematically valid. Sensor adapters still reject their own sentinels and invalid layouts before conversion. Tensiomark retains its qualified 0–7 pF range. Conventional centimetres of water use a different conversion factor; the acquisition contract consistently uses hPa.

The edge, both frontends and Java share numerical vectors. Canonical kPa values are aggregated before conversion to pF. Display formatting cannot change stored values, and raw SWT exports retain the calculated double. The live Tensiomark path removes early decimal rounding; unrelated legacy calibration and offline interpretation contracts retain their existing behavior.

Each Tensiomark observation retains the original packet, raw reply and acquisition configuration. Its versioned normalization also records native pF tokens, including signs and trailing zeros, alongside canonical channels. The cloud mirrors the exact JSON text and source bytes through a separate observation history table. Existing measurement-history hashes are unchanged. Rejected replies remain audit evidence without valid native pF entries.

The ordinary measurement outbox is corrected inside the insertion transaction to preserve the original JavaScript doubles. This avoids SQLite JSON formatting shortening a value before cloud delivery. Tests distinguish numerical conversion tolerance from exact IEEE754 transport equality.

An independent 80-digit decimal calculation also checked a fresh field sample. Native pF `+1.406` gives approximately 2.54683025258504103 kPa; the stored double is 2.5468302525850404. Native `+0.259` gives approximately 0.1815515662773135548 kPa; the stored double is 0.18155156627731356. The differences are below 7 × 10⁻¹⁶ kPa and arise from finite binary input and exponentiation precision. No decimal-place rounding is applied, and both exact source tokens remain available.

## WATERMARK presentation and Data

Both cards use canonical `ext_temperature_c`, place it beside the first tension probe and suppress the duplicate standalone temperature tile. A missing canonical reading remains missing even when diagnostic metadata contains a temperature. Probe 2 retains its tension reading.

Data exposes “Soil temperature” once under the WATERMARK device, with no inferred installation depth. It remains separate from root-zone tension aggregation and environmental weather inputs. The source policy handles retained WATERMARK calibration alongside a stale Chameleon flag, excludes other LSN50 modes and keeps queries scoped to the selected device.

## Review and verification

Independent Sol and Astra reviews covered the numerical contract, source ownership, observation transport, historical repair and affected card/Data behavior. Review fixes added transaction-time repair guards, exact source-token validation and the active Pi helper path. Tests cover rejected malformed Base64 evidence, lexical-only provenance corrections and older-cloud history backoff.

| Check | Result |
|---|---|
| Private edge frontend | 2,780 Vitest tests passed across 253 files; build passed |
| Private cloud frontend | 2,611 Vitest and 249 Node tests passed; two existing Vitest skips; release build passed |
| Edge precision and observation tests | 41 passed |
| Historical repair tests | 13 passed |
| Edge affected Data tests | 65 passed, one existing skip |
| Cloud WATERMARK backend tests | 113 passed, including 22 PostgreSQL tests |
| Cloud observation persistence | PostgreSQL hash, exact-text, replay and correction checks passed; five unit and ten ownership tests passed |
| Edge sync and packaging | Full sync verifier, profile parity, history contract, migrations, seed ledger and helper delivery passed |

The public runtime revisions are edge `b34066cc97e8a6e185ee28eba8054c3e294f47c7` and cloud `a530ec9f`. Reviewed changes were ported to the existing private customer branches. Customer release identifiers and operational evidence remain in the private bench capture directory.

## Historical repair and delivery

The repair first ran against a fresh gateway database copy. It recomputes only unambiguous accepted observations with matching raw replies, configuration and canonical row identities. Each repaired observation preserves the exact previous normalization JSON. The command takes and verifies a backup, rechecks eligibility inside the write transaction and uses the existing history correction queues. It creates no replacement append events.

The cloud deployed before the edge so the new history table was available before emission. Cloud health was UP and all 11 other containers retained their IDs. The edge applied additive migration 75, activated its paired runtime and GUI payload and passed startup and GUI health checks.

The live repair updated 31 historical observations and their canonical readings. One fresh observation was already correct. A second read-only pass found all 32 observations correct with no remaining repairs. The original packets and acquisition configuration remain retained.

Independent live comparisons matched all 32 observations by their edge IDs, including exact source text and IEEE754 values for both tension and temperature channels. A comparison against the preactivation cloud backup retained all 31 prior sensor rows, their identities, timestamps and every non-SWT JSON field; only the intended SWT values changed. The latest WATERMARK soil temperature, 14.69 °C, also matched between the edge and cloud.

The observation history cursor reached `tail` and acknowledged through ID 32. All 31 correction keys completed with zero retry attempts or errors. Database integrity and foreign-key checks passed, and no observation ingestion failures or quarantines were present. Independent checks matched the deployed helpers, rendered flow, GUI assets and cloud image to their release sources. The final verification completed at 09:56 UTC on 16 October 2026.

## Verification limits

The supported in-app browser bridge was unavailable. Rendered component tests cover card placement, independent history controls and missing-data behavior; no signed-in live browser session was exercised. Backend tests cover authenticated Data source discovery and query scope.
