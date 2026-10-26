# Unified soil water tension

Canonical `device_data.swt_1`, `swt_2` and `swt_3` values are kPa tension magnitudes. Cards, history, exports and zone calculations use these channels independently of the reporting sensor family. Threshold irrigation uses them for every family except WATERMARK, which the phase 1 scheduler interlock keeps out (see below). Display preferences select kPa or pF; the shared conversion remains `pF = log10(abs(kPa)) + 1`. Zero has no finite pF representation, so in pF mode the GUI shows a measured zero as `0.0 kPa`. Native Tensiomark pF tokens remain in observation provenance on edge and cloud.

WATERMARK conversion `wm-lsn50-p3-v3` publishes a finite clipped boundary value as the ordinary numerical estimate. For example, a channel previously represented by `kpa=null, kpa_upper_bound=11.2` now has `kpa=11.2`. This is an explicit estimate policy; it does not recover the electrical information lost to clipping. Raw samples, status and bound fields remain available for diagnosis. An invalid sample, missing usable temperature, suspected short or unavailable finite bound still produces null.

The shared GUI domain is finite 0 through 1,000,000 kPa, inclusive. This preserves the existing Tensiomark display range and treats the same canonical number identically across sensor types. Sensor-specific validation occurs in the ingestion adapters. Water-state colors use the existing thresholds: below 20 kPa wet, 20 through 50 moist, above 50 dry. The configured irrigation threshold bounds are unchanged.

The scheduler keeps the WATERMARK phase 1 interlock: an observation linked from `watermark_readings` never drives irrigation, whatever its frame status, until the owner decides on the phase 3 explicit enable. Clipped-bound estimates are therefore stored, synced and shown, but they are not scheduler input. KIWI, Tektelic CLOVER, SDI-12 (including Tensiomark) and Chameleon-enabled LSN50 observations count. The existing averaging policy remains: SWT_1/2/3 averages available observations of that channel; SWT_AVG first averages each observation's available channels, then averages those observation means. Sampling frequency therefore still affects temporal weighting.

The ordinary WATERMARK card uses canonical channel kPa, without a client-side bound fallback, quality label or electrical details. Tensiomark uses the same numeric formatting and water-state colors. Device identity, channel mapping and depth provenance still identify which physical probe supplied each value. These are needed for correct history and depth selection.

## Historical correction

New ingestion follows v3. Historical nulls remain unchanged until the explicit correction tool runs:

```bash
node scripts/repair-watermark-clipped.js /path/to/farming.db
node scripts/repair-watermark-clipped.js /path/to/farming.db --apply
```

The first command is read-only. The apply command takes an integrity-checked online backup, then copies stored finite clipped bounds into both the raw channel's kPa field and its linked canonical SWT field. Both fields must be null. Matching device and timestamp, accepted status, usable measured temperature and trusted sample flags are required. Existing values, raw electrical measurements, historical conversion versions and calibration provenance are preserved. The tool uses Node.js, the SQLite CLI and the repository's `lib/osi-migrate` backup/runner helpers; stage those dependencies with it on a gateway.

Apply requires an active cloud link and refuses pending canonical append events for candidate rows. These checks run again under the write transaction. Canonical corrections use the existing `device_data` dirty-key mechanism. WATERMARK raw readings remain edge-local; their corrected kPa fields and original diagnostic evidence are retained there. Do not enqueue replacement `DEVICE_DATA_APPENDED` events or edit the cloud database directly.

Rehearse on a database copy before live use. Deploy the converter and both consumer implementations, confirm ingestion and sync, then inspect the correction dry run. After apply, verify that the corrected edge and cloud values agree. Existing rollup workers refresh only their configured windows: edge hourly 8 days/daily 120 days, cloud hourly 7 days/daily 90 days. Corrections older than those windows need a separate rollup backfill before historical aggregates can be called reconciled.

This change supersedes the clipped-value presentation in the September 2026 WATERMARK design; its phase 1 scheduler exclusion stays in force. It changes no sync payload shape and requires no schema migration or transmitter firmware update.

## Check the Tensiomark history cursor

```bash
sqlite3 /data/db/farming.db "SELECT table_name, state, last_acked_id, retry_count, next_attempt_at, last_error FROM sync_history_cursors WHERE peer_node='cloud' AND table_name='tensiomark_observations';"
```

A cloud without `tensiomark_observations` support answers `unsupported_table` with no ACK boundary. The edge then retries that table with exponential backoff (at most 300 s), `last_error` shows the reason, and other history tables continue. Sync resumes on its own once the cloud accepts the table.
