# Two-address Tensiomark field integration

The installed node must retain two addressed temperature/pF replies, convert pF once on the edge, and deliver separate canonical SWT and temperature channels through existing history and cloud sync. The operator authorized planning, independent review, implementation and verification on 2026-10-15. Hardware identifiers, keys and gateway addresses stay in private operational evidence.

## Evidence and scope

The bench produced complete battery-powered two-sensor uplinks, including a wet/dry distinction. The observed payload is `1+16.11+0.000\r\n4+18.25+5.359\r\n`, with PAYVER=1 and DATAUP=0. Identities belong to the `TENSIOMARK_2Vh_10` family. Temperature precedes pF. The user selected pF acquisition and edge conversion. Calibration range remains unverified; model `_2` is not a calibration-variant claim. A configured field trial may store derived measurements with that qualification explicit. It must not silently qualify unknown hardware or configure irrigation.

Reuse the existing device type, canonical `swt_1`, `swt_2`, `soil_temp_1`, `soil_temp_2`, battery, depth maps, device history and REST sync. Add a discriminated Tensiomark member to the existing channel-layout field without changing Sentek layout semantics. Keep the existing offline v3 API unchanged.

## Runtime layout

```json
{"version":1,"kind":"tensiomark","source_unit":"pF","field_order":"temperature_pf","qualification":"bench_observed","sensors":[{"address":"1","channel":1,"identity":"111TENSIOMARK_2Vh_10A00001","depth_cm":null,"calibration_range":"unverified"},{"address":"4","channel":2,"identity":"411TENSIOMARK_2Vh_10A00002","depth_cm":null,"calibration_range":"unverified"}]}
```

Require exact keys, one or two sensors, unique single-character SDI-12 addresses, unique integer channels 1..2, an identity beginning with its address and matching the observed family, and depth null or integer 1..1000 cm. Require every explicit interpretation field above; no defaults that activate normalization. Sensor order is normalized by channel. Null depth means not recorded. Preserve identity verbatim; never rewrite or infer calibration range. Reject settings, layout kind or protocol versions outside this contract.

Require one CRLF-framed response per configured address, exactly two signed decimal fields, no extra text/fields, missing or duplicate addresses, or malformed delimiters. Accept records in either order and map by address. Reject a bad batch atomically for all soil channels while retaining battery and original evidence. Temperature range is -40..80 C; pF input 0..7 is a protocol plausibility range, not a calibrated-range assertion. Convert `10 ** pF / 10`, round to two decimal places, never clip at 300. Negative pF, non-finite values and temperature -99.88 reject; -9.88 C remains a valid temperature. Unconfigured legacy Tensiomark continues to quarantine.

## Persistence and UI

Persist each Tensiomark acquisition's original addressed text, payload bytes when available, timestamp, layout/configuration hash and snapshot, disposition and normalized channel snapshot in a local observation table. Retain accepted and rejected observations; do not put successful raw readings into capped ingest quarantine. Retain observations indefinitely locally, without pruning. Link each observation to the exact canonical row through nullable `device_data_id REFERENCES device_data(id) ON DELETE SET NULL`. Configured parse refusals retain battery-only data and evidence outside capped quarantine. The observation and canonical device_data insert belong to one transaction; storage failure must not leave a canonical row without provenance. Local evidence is not a new cloud measurement contract.

The settings UI must let operators save one or two explicit address/identity/depth mappings and show the bench-observed/unverified-calibration qualification. The card shows both mapped channels and available depths, including kPa above 300, and retains main's history affordance. Saving interpretation must not send measurement/configuration downlinks. The tested converter recipe remains unchanged. Registration sends no automatic discovery. First-uplink discovery remains only for an unconfigured Sentek profile. Identify action, trigger and reply re-read the layout and refuse configured Tensiomark without altering it, including replies already in flight.

Extend the authoritative sync resource schema additively with the Tensiomark layout and mirror it into the server. Confirm server persistence, latest data, chart/export and DTO paths carry both channels and metadata. Change server code only where a demonstrated blocker exists. Do not change existing controller thresholds or automatically assign this node to an irrigation zone.

## Operational boundary

Identify the target customer gateway Pi before mutation; preserve all gateway data and existing identity. Transfer only this node's OTAA registration secrets through protected channels without printing or committing them. Use supported registration APIs/helpers and verify readback. Do not copy an active LoRaWAN session. A fresh join at field handover is required if the target does not own the session. Do not reset credentials or hardware. Production cloud host access requires the repository's explicit authorization; local cloud preparation and edge-side sync evidence may proceed without it.

Back up before deployment, use the ordered migration runner, and rehearse against a protected gateway DB copy. Verify actual incoming addressed uplinks, canonical rows, raw evidence, and sync outcome separately. A temporary lack of radio contact while installation proceeds does not prove failure or success. Record outstanding physical checks (idle rail, startup current, calibrated range, installed depths) honestly.
