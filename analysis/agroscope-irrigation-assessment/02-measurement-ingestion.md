# Piece 2 — Measurement Ingestion (MQTT + REST)

Part of the [Agroscope Irrigation Logic — Integration Assessment](00-overview.md).

## 1. What it is / how it works

Scope: `iot.agroscope.ch` REST → local SQLite `SensorsTimeSeriesRaw`.

**REST pull is the only ingestion path; MQTT ingests nothing.** Hourly,
`_backend_master_pipeline` → `_run_task_get_raw_data` (`backend/main.py:1871-1919`) builds one
`api_iot()` client with one bearer token for the whole loop (`get_data_api_iot.py:16-44`). Per
sensor (`Sensors.query.all()`):

1. `_resolve_api_sensor_key` derives the upstream key from the sensor's MQTT topic strings
   (`main.py:469-489`).
2. `_get_sensor_pull_window` computes `(min_date, max_date)` in UTC (`main.py:898-964`).
3. `api_iot.get_data_api` GETs `/api/get_time_series`, parses the JSON response into a DataFrame
   (ms-epoch index), and projects a single channel renamed to `value`
   (`get_data_api_iot.py:106-116`).
4. `_store_timeseries_data` converts UTC → local-naive wall time and does an atomic
   DELETE+INSERT per `(sensor_id, timestamp)` (`main.py:1042-1062`).

Manual GUI pulls (`sensor_added` / `sensor_pull_manual`) reuse the same funnel with a different
window policy.

**MQTT is present but functionally dead.** `_init_mqtt_runtime` (`main.py:642-664`) creates an
`MQTTWrapper` with **no `on_message` callback**, subscribes to the default topic `#` (the entire
broker firehose), and discards every message. The valve downlink `publish_json` is commented out
(`main.py:752-763`) and the sequence-counter persist is commented out (`main.py:770`), but the
pending-confirmation lock still arms (`main.py:765`). Valve state is instead read back from
`sensors_time_series_raw` (`main.py:575-596`) — confirmed via the hourly REST pull, i.e. ~1 hour
of actuator-state latency; the raw table doubles as an actuator-state mirror. The MQTT/broker
connection currently serves no function.

`mqtt_bridge.py` is a standalone `loop_forever()` script referenced by nothing (not launched by
`irrigation.service`); it remaps four hardcoded Swisscom DevEUIs to one farm's AGS topics
(`mqtt_bridge.py:7-13`) — infrastructure documentation, not live code.

**Pull window & dedup.** High-water mark = `MAX(timestamp)` from the destination table,
re-localized and converted to UTC, minus a 30-minute overlap (`main.py:924-960`); `max_date` is
always "now." Empty table → `analysis_start_date`, else a 30-day bootstrap. `min_date=None` is
**not** full history: the client substitutes January 1 of the current year
(`get_data_api_iot.py:79-81`) — a January "full history" bootstrap fetches almost none of the
prior season. Dedup is in-batch last-wins plus an atomic DELETE-then-INSERT inside
`db.engine.begin()` (`main.py:1034-1062`); the table has **no unique constraint**
(`models.py:94-98`). Idempotent re-pull is achieved only if the UTC → local-naive → ISO string
conversion is byte-identical across runs.

**Failure semantics.** Token failure aborts the entire hourly pull (`main.py:1889-1891`) with no
refresh/retry. Per-sensor fetch failure logs and continues (`main.py:1911-1913`); the next hour's
window auto-stretches to cover the gap — self-healing for downtime, and the piece's best
property. An empty or misconfigured-column response yields 0 rows silently forever
(`main.py:988-1000`). `NaN` becomes `value=NULL`, and a `NULL` row still advances
`MAX(timestamp)`, so a late real value arriving >30 minutes after is lost. Out-of-order/late data
older than `MAX(timestamp) - 30min` is never re-requested on the scheduled path — a silent,
permanent gap unless someone triggers a manual full-history pull.

## 2. Strengths

- **Self-healing incremental pull.** High-water-mark + overlap, derived from the destination
  table rather than separately tracked state, is stateless, crash-tolerant, and automatically
  re-covers outage windows.
- **Idempotent-leaning upsert.** Atomic delete-insert makes re-pulls idempotent despite the
  absence of a unique constraint.
- **Deliberate value coercion.** Float coercion is applied with a documented reason (a
  numpy-scalar → SQLite BLOB bug, now fixed).
- **Single persistence funnel.** Both scheduled and manual pulls converge on the same
  `_store_timeseries_data` call, avoiding divergent write paths.
- **Narrow downstream contract.** One `value` column per sensor row keeps the consumer-side
  contract simple.
- **Per-sensor error isolation.** One sensor's fetch failure does not abort the batch.

## 3. Weaknesses & risks (ranked)

1. **Local-naive wall-clock timestamps as the dedup key** (`main.py:1007,1026`). On DST
   fall-back, two distinct UTC hours collide to one local string and the DELETE+INSERT overwrites
   one of them — roughly an hour of data destroyed per sensor, per year, silently. Spring-forward
   creates a phantom gap the other direction.
2. **Write-time timezone resolution** (`main.py:773-790`). Timezone is resolved per call via
   `TimezoneFinder` on the area's lat/lon. If coordinates change later, new rows use a different
   offset than old rows in the same table, and the window re-localization (`main.py:957-958`)
   drifts out from under the high-water mark.
3. **Hardcoded plaintext personal credentials** in both REST clients (`get_data_api_iot.py:14`,
   `get_data_api.py:14`), plus `verify = not debug` disabling TLS verification
   (`get_data_api_iot.py:30,91`). Hardcoded MQTT broker credentials also serve as env defaults
   (`main.py:646-647`), and the API token defaults to `local-dev-token` (root `main.py:66`).
4. **No request timeout on any `requests` call.** A hung upstream socket stalls the whole
   pipeline thread. Combined with one shared token and no retry/backoff, a single bad request can
   take down the hourly cycle.
5. **January-1 full-history truncation** (`get_data_api_iot.py:79-81`) — a bootstrap run in
   January fetches almost none of the prior season's data.
6. **Dead code chain.** `get_data_api.py` is never imported; its only reference
   (`GUI/GUI.py:555`) has no matching import, so it raises a swallowed `NameError` (bare
   `except`, `GUI/GUI.py:562`) that serves fake readings to the caller. `GUI/GUI.py` is itself
   dead — the service launches `GUI/main.py`. Both should be deleted, not ported.

**Minor:** cross-layer identity coupling (the REST key is string-derived from an MQTT topic; a
topic typo silently yields empty pulls forever); log/docstring drift on the processing hour
(docstring says "2 am UTC" at `main.py:1966`, a comment says "0 am UTC" at `1988`, and the code
actually gates on hour 3 Europe/Zurich).

## 4. Integration challenges (OSI OS / OSI Server)

- **[P2] This piece largely does not port.** OSI OS edge already ingests LoRaWAN uplinks natively
  via ChirpStack/MQTT and is the system of record — there is no pull window, no token, and no
  overlap math to reproduce on the edge. Agroscope's mirror machinery exists only because its app
  is a downstream mirror of `iot.agroscope.ch`. On the edge, "ingestion" reuses OSI's existing
  dendro ingestion unchanged.
- **[P2] Raw-data availability if run cloud-side.** Agroscope processing needs raw sub-daily
  (15-minute) dendro timeseries to extract min/max/MDS, not just daily params. If the ported PID
  controller runs cloud-side as a shadow, confirm the cloud actually holds raw dendro readings and
  not only the `dendro_daily` daily-params mirror. This is a second, independent argument (beyond
  Piece 1's placement discussion) for hosting the controller at the **edge**, where the raw data
  already lives.
- **[P2] Reuse OSI's sync, not Agroscope's pull.** OSI's edge→cloud sync already implements a
  watermark-style incremental transfer (see the `sync_resource_watermarks` migration) with a
  durable outbox/inbox — a more robust analogue of Agroscope's high-water-mark pull. Do not port
  Agroscope's pull logic; reuse OSI's existing sync primitives.
- **[P2] UTC discipline must not regress.** OSI already stores and handles time in UTC. Keep it
  that way and convert only at the processing boundary — this sidesteps Agroscope's local-naive
  DST dedup bug (weakness #1 above) entirely, by construction, provided nobody introduces a
  local-naive timestamp as a dedup or storage key during the port.
- **[P2] Actuator-state latency is a place OSI is already better.** OSI edge confirms valve state
  from real-time MQTT uplinks in seconds, versus Agroscope's ~1-hour REST-pull confirmation
  (Section 1 above). This makes closed-loop actuation timing strictly tighter on OSI than in the
  source system — worth preserving deliberately rather than accidentally regressing to a
  poll-based confirmation path during integration.
- **[P2] Security posture.** Never port the hardcoded credentials or the TLS-verification
  disable. OSI policy uses ephemeral, per-rollout keys and keeps secrets out of the repository;
  this applies to any REST client credentials touched during the port.

## 5. OSI v6 improvement ideas

- **[P2] Measured-data-beats-forecast reconciliation.** Ingestion sits upstream of v6 analytics,
  so this piece drives little direct v6 change — but v6 should adopt the general discipline (
  detailed further in the weather-pipeline piece) that measured data, once available, supersedes
  forecast-based estimates rather than being reconciled ad hoc.
- **[P2] Document the mirror's gap-fill guarantee.** Confirm and document that OSI's edge→cloud
  dendro mirror carries a "self-healing gap-fill" guarantee equivalent to Agroscope's
  high-water-mark + overlap pull (Section 1), so that a cloud-side shadow run of either
  controller (Agroscope port or v6) never silently sees a data gap after an outage.

## 6. Re-implementation complexity

**Rating: LOW.**

The real logic is roughly 150 lines: the pull-window algorithm (high-water mark minus overlap,
bootstrap fallbacks, `analysis_start_date` floor — `main.py:898-964`) and the atomic
delete-insert upsert with in-batch last-wins dedup (`main.py:1034-1062`). Everything else is
upstream-specific plumbing (the `api_iot` client's password grant, key format, date format,
JSON-sometimes-a-string handling), dead code (`get_data_api.py`, `GUI/GUI.py`), inert
infrastructure (the MQTT subscribe-and-discard path, `mqtt_bridge.py`), or documentation-only
artifacts.

A faithful 1:1 port is **not recommended**. For a native-ingest edge target, reimplement only the
persistence *contract* (see below) and skip the mirror machinery entirely. For a cloud mirror
(if one is ever needed independent of OSI's existing sync), keep the high-water-mark/overlap/
upsert pattern but fix four defects: UTC storage plus a real unique constraint (rather than
delete-insert against an unconstrained table), a genuine full-history bootstrap (not the
January-1 substitution), request timeouts/retries, and secrets kept out of source.

**Implicit downstream contracts that must hold in any port**, whether or not the pull mechanism
itself is reused:

- Table shape `(sensor_id, timestamp, value)` with `value` nullable, and readers filtering
  `value IS NOT NULL` (`main.py:1249,583`).
- Timestamps are naive local wall time (ISO strings, order-comparable via `datetime()`), and
  daily aggregation/cutoffs assume local wall time — a UTC-storing port must convert at the
  processing boundary or it silently moves daily boundaries.
- One scalar series per sensor row; a multi-channel device is modeled as multiple sensor rows.
- The DataFrame seam is a datetime index plus a single `value` column.
- **Non-obvious:** valve/actuator state is read from this same raw table
  (`main.py:575-596`) — so a real-time-MQTT edge target confirms valve state in seconds rather
  than ~1 hour, which changes control-loop timing versus the source system (see Section 4).
