# Agroscope Slice B — Forward Raw Data to Agroscope IoT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Steps marked ⛔ are BLOCKED on external inputs from Agroscope — do not fabricate them.**

**Goal:** Forward OSI's raw sensor uplinks to Agroscope's IoT platform (`iot.agroscope.ch`) over MQTT, so Agroscope's live hosted stack ingests and processes them (a real Agroscope instance on OSI farms), and optionally pull Agroscope's results back for the 3-way comparison.

**Architecture (revised after review — Node-RED is primary):** A **Node-RED forward branch** in `flows.json` subscribes to the local ChirpStack uplinks (`application/+/device/+/event/up`), maps each devEUI to its farm + sensor type, **reshapes ChirpStack v4 JSON → Agroscope's ThingPark/Swisscom uplink schema**, and publishes to `AGS/<farm>/Sensor/<type>` on Agroscope's broker via an MQTT-out node (**TLS native to Node.js**, creds in `flows_cred.json`). This is chosen over a mosquitto broker-bridge because the shipped firmware builds **`mosquitto-nossl`** (no TLS), mosquitto `topic out` does prefix-substitution only (can't hit fixed `AGS/.../<type>` topics), and nothing in `deploy.sh` installs `/etc/mosquitto/conf.d/`. The mosquitto bridge remains a **contingent** optimization (Task 7) only if Agroscope accepts OSI-shaped topics/payloads *and* the image swaps to `mosquitto-ssl`.

**Tech Stack:** Node-RED (edge, `flows.json`) with MQTT-out + TLS; `flows_cred.json` for secrets; osi-server (Java) only for the optional result pull-back. Edge files in `conf/full_raspberrypi_bcm27xx_bcm2712/files/` **must be mirrored** to `…bcm2709/files/` (profile-parity invariant, `verify-profile-parity.js`).

## Global Constraints
- Spec/overview: [agroscope-integration-overview.md](../../architecture/agroscope-integration-overview.md).
- **Credentials/secrets:** NEVER reuse Agroscope's hardcoded creds (`camilo.chiang@agroscope.admin.ch` / the literal password in `get_data_api_iot.py:14`) or its `verify=not debug` TLS-disable. Use Agroscope-provisioned MQTT credentials in **`flows_cred.json`** (already OSI's convention, AGENTS.md:126), **TLS on**, never committed.
- **Repo ships a TEMPLATE, enrollment renders real values.** Per-gateway values (farm id, creds, devEUI→type map) differ per Pi, but repo files are mirrored byte-for-byte — so the repo carries placeholders/env-driven config; concrete values are injected at enrollment outside the repo/image.
- **Observe-only egress.** Forward uplinks **out only**. NEVER subscribe/bridge inbound on Agroscope's `AGS/<farm>/Actuator/` topics — Agroscope's instance must not actuate OSI valves (consistent with slice C's shadow-only constraint).
- **Delivery guarantee:** live-only best-effort (Node-RED MQTT-out drops while disconnected). Backfill, if Agroscope needs it, is a separate concern tied to external input #5 — state the guarantee explicitly, don't silently imply durability.
- **Data egress / opt-in:** authorized cross-org flow; gate behind an explicit per-gateway enable.
- **Firmware minimalism:** reuse the existing Node-RED/deploy path; mirror both Pi profiles. Commit per task; branch off `main` (osi-os), not on `main`.

## ⛔ External inputs required from Agroscope (obtain before Tasks 2-5 finalize)
1. **Broker endpoint:** host, port, TLS (CA cert / client-cert?).
2. **Credentials:** provisioned MQTT username/password (or client cert) for OSI.
3. **Topic contract:** exact `AGS/<farm>/Sensor/<type>` naming — confirm farm identifiers, the water-meter topic, and the full type set.
4. **Payload contract (riskiest):** the exact uplink JSON schema. Evidence says Agroscope ingests **ThingPark/Swisscom `DevEUI_uplink`** (hex `payload_hex`, `DevEUI`, `Time`) — NOT ChirpStack v4 (`deviceInfo.*`, base64 `data`). Confirm the required fields; this decides the Task 2 transform.
5. **Scope:** which streams (dendro/rain/water-meter), live-only vs backfill, and whether OSI's `devEUI`s must be **pre-registered** on Agroscope's side (their read API keys on `fabricant_deveui`).

## Discovered from the live broker (2026-07-07 probe, `51.107.5.147:1883`)
A connectivity/auth probe against the Agroscope/FiBL broker (Frick CH) revealed:
- **Transport:** plaintext MQTT **1883** works; **8883 (TLS) filtered/closed** → no TLS listener found. Governance concern (creds + farm data in clear) — resolve via ⛔ #1.
- **`AGS/#` is silent** — the old `mqtt_bridge.py` `AGS/<farm>/Sensor/<type>` convention is **not in use**. Real ingest topics are raw-LNS:
  - `Swisscom/Dragino/<DevEUI>/uplink` → **ThingPark `DevEUI_uplink`** (`payload_hex` + decoded `{Bat_V, VDC_intput_V, Probe_mod, Water_deep_cm}`). Dendro reading = analog `VDC_intput_V`.
  - `v3/ags-iot-ttn-bridge@ttn/devices/dragino-<eui>/up` → **TTN v3** uplink JSON (`decoded_payload`).
  - `Aranet/<gw>/sensors/<id>/json/measurements` → Aranet climate/soil (not dendro).
- **Shared multi-party broker** — `#` read exposes many parties' live data; conversely OSI publishing here makes OSI data broadly readable. Explicit data-sharing agreement needed.
- **Implication:** OSI's ChirpStack-v4 JSON transform target is now concrete (Swisscom `DevEUI_uplink` or TTN v3), **but** Agroscope's processing pulls via the IoT API (`get_data_api_iot`), so devices must be **registered** in their platform — publishing raw alone is likely insufficient. The core integration path (publish-vs-register) is ⛔ pending Agroscope (question set below).

## Decisions locked (2026-07-07, from the broker probe + user)
- **Publish uplinks directly to the broker** (not device-registration in a platform). Data is **not confidential** — shared broker is fine.
- **Dedicated topic prefix `OSI_dendro/…`** (not `AGS/…`, not the Swisscom namespace).
- **Plaintext 1883 accepted** (not a sensitive application) → **TLS is no longer a requirement**; the earlier "TLS on" constraint and the mosquitto-nossl blocker (B1) are moot. A plaintext mosquitto bridge is viable again *if* raw payloads are acceptable.
- **Schema decided (Agroscope: "schema doesn't matter"): mimic the Swisscom `DevEUI_uplink`** (a format their pipeline already ingests, with real reference examples on the broker). OSI publishes to **`OSI_dendro/<DevEUI>/uplink`** a payload `{"DevEUI_uplink":{"Time","DevEUI","FPort","payload_hex","payload":{...}}}`, carrying the dendrometer **ADC voltage in `VDC_intput_V`** (their `dendro_processing` converts voltage→µm via `sensor_length`/`voltage_reference`). → **B is unblocked**; mechanism = the **Node-RED transform branch** (Task 2), transform target now concrete.
- **Remaining (minor, confirm with Agroscope, non-blocking for the build):** which decoded field they register as OSI's dendro column (recommend `VDC_intput_V`), and that they ingest the `OSI_dendro/…` prefix.

## File structure
| File | Action |
|---|---|
| `docs/operations/agroscope-iot-forwarding.md` | Create (contract table, devEUI→farm/type map, creds provisioning, enable/verify runbook) |
| `conf/.../usr/share/flows.json` (both profiles) | Modify (Node-RED forward branch: map + transform + MQTT-out) |
| `conf/.../usr/share/node-red/codecs/agroscope_uplink_transform.js` (both profiles) | Create (pure ChirpStack→ThingPark reshaper, unit-tested) |
| `backend/.../analytics/AgroscopeResultPull*.java` (osi-server) | Create **only** for the optional pull-back (Task 6) |

---

## Task 1: Forwarding contract + config doc (unblocked — placeholders)
- [ ] Write `docs/operations/agroscope-iot-forwarding.md`: the devEUI→(farm, sensor type)→`AGS/<farm>/Sensor/<type>` mapping as a table with ⛔ `TBD (Agroscope)` placeholders; the delivery guarantee (live-only best-effort); the credential provisioning/storage/rotation procedure (`flows_cred.json`, never repo); TLS requirements; the per-gateway opt-in switch; and enable/disable/verify runbook. This table is the concrete **home** for the devEUI→type mapping the Node-RED branch reads.
- [ ] Commit `docs(agroscope): IoT forwarding contract + runbook (values pending Agroscope)`.

## Task 2: Node-RED forward branch (primary path)
The reshaper is a pure function → unit-testable; the MQTT-out + subscribe live in `flows.json`.

- [ ] **Step 1: Write the failing transform test.** Create `agroscope_uplink_transform.js` exporting `toAgroscopeUplink(chirpstackMsg)` and a test (Node's `assert`, or the repo's existing codec test harness) feeding a recorded ChirpStack v4 uplink fixture. Target = **Swisscom `DevEUI_uplink`** (confirmed schema) on the dedicated prefix:
```js
// input (ChirpStack v4): { deviceInfo:{ devEui:"a84041..." }, data:"<base64>", time:"2026-07-01T22:15:00Z",
//                          fPort:2, object:{ ...decoded, adc voltage... } }
// expected topic:   "OSI_dendro/A84041.../uplink"          (dedicated prefix, upper-hex DevEUI)
// expected payload (Swisscom DevEUI_uplink shape):
//   { DevEUI_uplink: { Time:"2026-07-01T22:15:00Z", DevEUI:"A84041...", FPort:"2",
//                      payload_hex:"<hex(base64 data)>",
//                      payload:{ VDC_intput_V:<dendro ADC voltage from `object`>, Bat_V:<...> } } }
```
  Assert `toAgroscopeUplink(...)` returns `{ topic, payload }` matching, and returns `null` for a non-dendro `deviceProfileName` (only dendrometers forwarded).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `toAgroscopeUplink`: `deviceInfo.devEui`→upper `DevEUI`, `time`→`Time`, base64 `data`→`payload_hex`, and the decoded dendrometer ADC voltage (from ChirpStack's `object`) → `payload.VDC_intput_V` (the field Agroscope registers as the dendro column — confirm exact name); topic `OSI_dendro/<DevEUI>/uplink`. Return null for non-dendro devices. Keep it pure (no I/O) so it's unit-testable.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Wire into `flows.json`** a forward branch: MQTT-in on `application/+/device/+/event/up` (guard the head with a `deviceProfileName` filter per AGENTS.md:190) → a function node calling `toAgroscopeUplink` with the mapping (from an env/config node) → drop nulls → MQTT-out to the Agroscope broker (TLS on, creds ref `flows_cred.json`, QoS 1, opt-in-gated by an env flag). **Mirror byte-for-byte to the bcm2709 profile**; run `node scripts/verify-profile-parity.js` → PASS.
- [ ] **Step 6:** Commit `feat(agroscope): node-red forward branch → Agroscope IoT (transform + TLS)`.

## Task 3: Secrets, TLS, per-gateway enablement
- [ ] Add the Agroscope broker credentials to `flows_cred.json` at enrollment (never repo); TLS CA config on the MQTT-out node. Add the per-gateway opt-in env flag (branch disabled by default) + the farm id + devEUI→type mapping as enrollment-rendered config. Document in the runbook.
- [ ] Verify (staging/loopback): point the MQTT-out at a local TLS test broker, replay a recorded uplink, assert it arrives on the mapped `AGS/…` topic with the transformed payload (`mosquitto_sub`).
- [ ] Commit `feat(agroscope): forwarding secrets/TLS + per-gateway opt-in`.

## Task 4: Actuator observe-only guard (explicit non-goal)
- [ ] Confirm + document that the forward branch is **publish-only** and no flow subscribes to `AGS/<farm>/Actuator/` or bridges inbound from Agroscope. Add a runbook line: Agroscope's instance is observe-only on OSI farms; OSI actuation stays STREGA-via-ChirpStack (AGENTS.md). No code if already absent — assert via review.
- [ ] Commit `docs(agroscope): actuator observe-only non-goal`.

## Task 5: ⛔ End-to-end verification (needs Agroscope-side confirmation)
- [ ] With real credentials on a staging gateway, confirm OSI data appears in Agroscope IoT — Agroscope confirms receipt, or pull it back via `GET https://www.iot.agroscope.ch/api/get_time_series` (token auth) for a known devEUI (requires devEUI pre-registration, external input #5). Record the result in the runbook.

## Task 6 (optional): Pull Agroscope results back for the comparison
- [ ] Only if we want Agroscope's *computed* results in OSI's compare. In osi-server, a client mirroring `get_data_api_iot.py` (token → `get_time_series`, `logger_sensor` = fabricant_devEUI) fetches Agroscope's processed series for a zone/date range; surface as a 4th column in slice C's `/dendro/shadow/compare`. Creds via config/secret, TLS on. Test with a mocked HTTP response. Commit `feat(agroscope): pull Agroscope IoT results for comparison`.

## Task 7 (contingent): mosquitto broker-bridge — only if it clears three gates
Pursue **only if** Agroscope accepts OSI-shaped topics/payloads (so no transform is needed) AND the image is rebuilt with `mosquitto-ssl` (current builds are `mosquitto-nossl`, `.config`) AND `mosquitto.conf` gains an `include_dir` + `deploy.sh` installs the conf. Otherwise skip — Node-RED (Task 2) is the path. If pursued: firmware package swap, `include_dir /etc/mosquitto/conf.d`, a root-600 `agroscope-bridge.conf` (bridge creds are literal in-file by design) installed at enrollment, both profiles + parity.

## Recommendation (record in the runbook)
**Node-RED forward branch is the primary path** — it satisfies every constraint on current firmware (native TLS, `flows_cred.json` secrets, deployable via the existing `deploy.sh` flow, trivial opt-in + parity) and performs the **required** devEUI→topic mapping and ChirpStack→ThingPark payload reshape. The mosquitto bridge is contingent (Task 7). **Answer external inputs #3 and #4 first** — the payload/topic contract determines the transform and is the project's riskiest assumption (Agroscope's own code speaks Swisscom/ThingPark, which OSI's ChirpStack cannot emit unchanged).

## Self-review (coverage map)
| Spec item | Task |
|---|---|
| forwarding contract + creds/TLS/secret policy + devEUI→type home | 1, 3 |
| Node-RED forward branch (map + transform + MQTT-out, primary) | 2 |
| per-gateway opt-in + templating | 1, 3 |
| observe-only (no actuator inbound) | 4 |
| delivery guarantee (live-only best-effort) | Global Constraints, 1 |
| e2e verification (Agroscope-gated) | 5 |
| optional result pull-back | 6 |
| mosquitto bridge (contingent, gated) | 7 |
| ⛔ external inputs enumerated | top of plan |
