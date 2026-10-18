# History coverage and upload cursor investigation

Read-only checks on 7 October 2026 found that the field gateway retains sensor readings from April, while the test cloud has substantially less raw detail. The mobile pilot can now navigate before its former 90-day boundary, but navigation alone cannot recover data absent from the selected host.

## Findings

The edge held 83,363 `device_data` rows at the observation time. Its sequential history cursor was in `tail`, but moved backwards from row 584 to row 414 over two observed acknowledgements. The shipped acknowledgement node copied boundaries from repair and correction batches into the same cursor used for ordered uploads. An old repair could rewind that cursor; a correction above it could skip unsent rows.

Cloud retention is separate. All 30 inspected test-cloud accounts had `data_retention_days=30`. The per-user retention service runs independently of the global 365-day cleanup job. Raising the global limit alone would therefore not extend those accounts' raw history.

The cloud history index can also outlive the readings it references. Of 581 indexed field-gateway rows, 296 had no backing `sensor_data` row at query time. All six current device-data manifest segments matched the edge by count and hash, because the comparison uses that index. A matched manifest is not proof that raw readings remain available to the chart. The code does not establish whether these surviving receipts are deliberate retention behavior or an unintended integrity gap.

The cloud rollup scheduler maintains recent hourly and daily windows and does not generate weekly rollups. Historical daily rows exist outside those maintenance windows. Neither their presence nor a successful raw upload guarantees that the root-zone source used by the pilot covers the full April archive.

## Bounded patch

The reviewed implementation separates repair, correction, and derived acknowledgements from ordered cursor movement. They still complete accepted dirty rows and record batch status. Only backfill and tail acknowledgements update the ordered cursor, with a monotonic comparison in the SQLite update itself. The separate shadow path remains unchanged.

No database schema, retention setting, sync protocol, scheduler cadence, chart aggregation policy, or live cursor is changed. Scheduling fairness is deferred: the observed cursor rewind warrants this fix, while the finite repair queue does not yet establish that a new scheduler is required.

## Recovery limits

The patch passed local verification and was subsequently deployed with backup and rollback retained. The [deployment record](field-gateway-history-cursor-deploy-2026-10-08.md) contains the live checks. The static preview cannot deliver this edge fix.

Normal numeric tail uploads can proceed without resetting the cursor after the fix. At the current batch size and table rotation, a clean transfer of the remaining archive takes roughly a day before retries and competing repairs. That is an estimate, not a recovery promise.

History protocol v1 carries only part of `device_data`, including SWT channels 1 and 2. It does not restore the full temperature, humidity, light, or third SWT archive. A separate source-key versus acknowledged-key mismatch also affects key-based tables; the numeric cursor patch does not establish recovery for those tables.

The owner must choose the intended retention policy before an archive recovery operation. Any follow-up must verify backing raw rows, generate the required rollups within that policy, and then check the actual pilot response. The existing admin backfill is fleet-wide and builds hourly as well as daily rows; it is not a safe assumption for a zone-specific April repair.

## Verification

Sol planned the patch, root narrowed and reviewed the plan, Luna implemented it, and Sol independently reviewed the final patch as GREEN.

The new tests run the shipped acknowledgement node against SQLite for both maintained Pi profiles. All ten new cases failed against the pre-fix flows. The corrected suite passes 30 tests, including dirty boundaries above and below the stream, delayed acknowledgements, a concurrent newer cursor write, partial retries, and radio generation handling.

The worker-helper tests and 12 broader checks passed: master sync verification, profile parity, MQTT topics, flow wiring, silent-catch and DDL ratchets, flow-size ratchet, bare-require scan, function parsing, durable-flow guards, durable SQLite integration, and radio-history integration. No ratchet allowances or schema baselines changed.

The inspected live acknowledgement function matches the pre-patch checkout byte-for-byte. The candidate containing only that function and its expected/current hashes was subsequently activated in the separately authorized gateway deployment. The deployment restarted Node-RED; no database rows were manually edited and retention was unchanged.

The already deployed mobile empty-range recovery is documented in [the mobile verification record](uplot-history-coverage-recovery-2026-10-07.md). This patch changes edge sync only; it does not change the static preview or establish that the missing cloud archive has recovered.
