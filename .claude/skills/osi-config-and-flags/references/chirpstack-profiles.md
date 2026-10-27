# ChirpStack profiles and applications

Part of the osi-config-and-flags skill; read SKILL.md first.

## 3. `CHIRPSTACK_PROFILE_*` / `CHIRPSTACK_APP_*`

`chirpstack-bootstrap.js` (repo copies: `scripts/chirpstack-bootstrap.js` and
mirrored under both hardware profiles'
`files/usr/share/node-red/chirpstack-bootstrap.js`) runs once per gateway (via
`osi-bootstrap` init script, `START=99`, after ChirpStack's gRPC API answers)
and creates-or-reuses:

- 3 ChirpStack applications: **OSI Sensors**, **OSI Actuators**, **OSI Field Tester**
- 10 device profiles: **KIWI Sensor**, **CLOVER Sensor**, **STREGA Valve**,
  **STREGA Valve Gen2**, **Dragino LSN50**, **RAK Field Tester**,
  **SenseCAP S2120**, **Aqua-Scope LoRain**, **OSI Milesight UC512**,
  **SDI-12 Soil Node**
- 1 API key (`osi-nodered`)

Verified full set of env vars it writes (`writeEnvFile` / `envVars` object in
`chirpstack-bootstrap.js`):

| Env var | Maps to | UCI key (via `toUciCloudKey`) |
|---|---|---|
| `CHIRPSTACK_API_URL` | ChirpStack gRPC endpoint | none (env-file only) |
| `CHIRPSTACK_API_KEY` | **Secret.** osi-nodered API key | none (env-file only) |
| `OSI_CHIRPSTACK_GRPC_DEADLINE_MS` | Deadline of every ChirpStack gRPC call made through `osi-chirpstack-helper`, in ms. Default 20000, at most 120000; a missing, zero, negative or non-numeric value falls back to the default and a larger one is clamped, so the deadline cannot be switched off. Read from the process environment at call time | none |
| `CHIRPSTACK_APP_SENSORS` | OSI Sensors app UUID | `chirpstack_app_sensors` |
| `CHIRPSTACK_APP_ACTUATORS` | OSI Actuators app UUID | `chirpstack_app_actuators` |
| `CHIRPSTACK_APP_FIELD_TESTER` | OSI Field Tester app UUID | `chirpstack_app_field_tester` |
| `CHIRPSTACK_PROFILE_KIWI` | KIWI Sensor profile UUID (Tektelic agriculture codec, attached only when the profile has none) | `chirpstack_profile_kiwi` |
| `CHIRPSTACK_PROFILE_STREGA` | STREGA Valve profile UUID (Gen1) | `chirpstack_profile_strega` |
| `CHIRPSTACK_PROFILE_STREGA_GEN2` | STREGA Valve Gen2 profile UUID | `chirpstack_profile_strega_gen2` |
| `CHIRPSTACK_PROFILE_LSN50` | Dragino LSN50 profile UUID | `chirpstack_profile_lsn50` |
| `CHIRPSTACK_PROFILE_CLOVER` | CLOVER Sensor profile UUID (`OSI CLOVER Sensor`, Tektelic agriculture codec `codecs/tektelic_agriculture_decoder.js`). Bootstraps before this profile existed wrote the RAK10701 field-tester UUID here; see the repair note below | `chirpstack_profile_clover` |
| `CHIRPSTACK_PROFILE_RAK10701` | RAK Field Tester profile UUID | `chirpstack_profile_rak10701` |
| `CHIRPSTACK_PROFILE_S2120` | SenseCAP S2120 profile UUID | `chirpstack_profile_s2120` |
| `CHIRPSTACK_PROFILE_LORAIN` | Aqua-Scope LoRain profile UUID | `chirpstack_profile_lorain` — mapped to UCI by `chirpstack-bootstrap.js`, but **not exported by `node-red.init`** (runtime sees it via the env-file path only; see section 1 note) |
| `CHIRPSTACK_PROFILE_UC512` | Milesight UC512 profile UUID | `chirpstack_profile_uc512` — mapped to UCI by `chirpstack-bootstrap.js` but, like LORAIN, not exported by `node-red.init` (runtime sees it via the env-file path only; see section 1 note) |

All `CHIRPSTACK_APP_*`/`CHIRPSTACK_PROFILE_*` values are validated as
ChirpStack UUIDs (`assertValidUciValue`, regex
`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) before being
written to UCI, and a readback check (`uci -q get` immediately after `uci
set`) confirms the commit landed.

**Why UUIDs are per-installation:** each gateway's `chirpstack-bootstrap.js`
run creates its own tenant/apps/profiles against its own local ChirpStack
instance — there is no shared/global UUID. Hardcoding a UUID observed on one
gateway into flows.json or a script will silently break every other gateway
(confirmed pattern the codebase actively guards against — see
`extract_from_legacy_flow`'s comment in `scripts/prepare-pi-communication-config.sh`
about not trusting a bare `FIXED_APP_ID` fallback).

**Who consumes them:** `node-red.init` resolves each one **except
`CHIRPSTACK_PROFILE_LORAIN` and `CHIRPSTACK_PROFILE_UC512`** with
`resolve_chirpstack_value` (UCI first, then per-key `.chirpstack.env` fallback
via `load_chirpstack_env_value`, logging the source via `logger -t
node-red.init`) and exports the result as a Node-RED process env var; LORAIN
and UC512 reach the runtime only through `settings.js`'s `.chirpstack.env`
compat loader (see section 1 note, as of 2026-07-19).
flows.json function nodes then read them with `env.get('CHIRPSTACK_PROFILE_S2120')`
etc. to discriminate device type on uplink. The actual MQTT topic
subscription rule and the `deviceProfileName`-fallback discrimination pattern
inside flows.json are mechanics of `osi-flows-json-editing` — not duplicated
here.

**Kiwi and Clover profiles on existing gateways:** earlier bootstraps created
the Kiwi profile without a codec and aliased `CHIRPSTACK_PROFILE_CLOVER` to the
codec-less RAK10701 field-tester profile, so Kiwi and Clover uplinks never
decoded there (they are decoded only by the profile codec). `deploy.sh` runs
`node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles` on every
provisioned gateway: it reuses the existing API key and never provisions; it
attaches the Tektelic codec to the Kiwi and Clover profiles that have none (a
codec already there, also one attached by hand, is left alone), gets or
creates the `OSI CLOVER Sensor` profile when CLOVER is unset or aliased, and
rewrites only the `chirpstack_profile_clover` UCI key and the
`CHIRPSTACK_PROFILE_CLOVER` env line. Once everything is correct it makes no
write; a failure only warns. A Clover registered before the repair stays on
the field-tester profile until it is re-registered (the registration paths
repoint an existing device's profile) or moved with
`--repoint-clover-device=<DevEUI>`, which refuses a device on any other
profile.

**`CHIRPSTACK_PROFILE_STREGA_GEN2` on existing gateways:** a fresh
`chirpstack-bootstrap.js` run writes it like any other profile var, but a
gateway that was already deployed before the Gen2 profile existed has a
`.chirpstack.env` with no such line. `deploy.sh` closes that gap with a
one-shot step (around the codec-fetch block): if `/srv/node-red/.chirpstack.env`
exists and lacks a `CHIRPSTACK_PROFILE_STREGA_GEN2=` line, it reruns
`chirpstack-bootstrap.js` with the gateway's existing `osi-nodered` API key so
the rerun only adds the missing profile instead of minting a second admin key.
A provisioning failure there is non-fatal — deploy continues and new Gen1
registrations still work; only Gen2 registration and profile reconciliation
are degraded until the next successful deploy. The deploy now secures the
canonical `/srv/node-red/.chirpstack.env` before provisioning and checks it
again after each writer. New and replaced credential files are root-owned mode
`0600`; the first Gen2 provisioning attempt keeps an exact raw-byte
`.pre-gen2` recovery copy and does not replace an older copy. Full and soil
updates retain unrelated valid UTF-8 lines; malformed UTF-8 stops text
mutation before ChirpStack API or UCI work. A credential filesystem failure
exits deploy with status `74` (recovery for `UNSAFE_ENTRY`, including an
interrupted publication's leftover staging link: `osi-live-ops-runbook`,
"Credential env-file refusal"); API/profile failure status `1` may still warn
when the later safety check succeeds. Direct CLI use may set `ENV_FILE` for a
separate file, while deploy always pins the canonical path. An older image can keep selecting its ROM
`/usr/share/node-red/chirpstack-bootstrap.js` even after deploy installs the
updated `/srv/node-red/` copy. `osi-bootstrap` prefers the ROM path whenever it
exists; only a new image supplies the updated ROM writer. Deploy's file checks
cover its own `/srv/node-red/` invocations. These checks
cover file handling only; they do not change key lifecycle (issue 181). CLI
API-key redaction in diagnostics shipped separately in #530.

Five flows.json nodes read
the resulting env var: `post-devices-insert` and `cs-reg-cloud-fn` (both
registration paths select it for a Gen2 STREGA valve); `valve-ack-fn`
(re-points a valve's ChirpStack profile to it once the valve's stored
`strega_generation` reads `GEN2`); and `strega-process-fn` and the cloud
telemetry builder (node `8809bb5239dfb3d4`, "Build Telemetry"), which both
whitelist it alongside `CHIRPSTACK_PROFILE_STREGA` so a valve already
re-pointed to the Gen2 profile is still recognised as `STREGA_VALVE` instead
of falling through to a generic sensor payload.

**Deploy-time post-check:** `deploy.sh` does **not** assert
`CHIRPSTACK_PROFILE_RAK10701` or `CHIRPSTACK_PROFILE_S2120` anywhere
(re-verified 2026-07-19: it fetches, seeds the DB conditionally, runs the
ordered-migration runner, and flips the flows payload — it still has no
ChirpStack-profile assertions at all). The actual
check for "is RAK10701/S2120 provisioned" is `scripts/diagnose-pi-communication.sh`
(prints `uci.chirpstack_profile_rak10701` / `env.CHIRPSTACK_PROFILE_S2120`) and
`scripts/prepare-pi-communication-config.sh` (repairs missing UCI values from
the env-file/legacy-flow fallback, `--dry-run` by default). Both are operator
tools run manually on the Pi, not something `deploy.sh` gates automatically —
if you were told a "deploy post-check" enforces this, that check is a manual
operator step (`osi-live-ops-runbook`), not code in `deploy.sh`.

The preflight `deploy.sh` *does* run
(`run_communication_preflight` → `scripts/verify-communication-contract.js`)
only checks that `node-red.init` **exports** `CHIRPSTACK_PROFILE_RAK10701` as
a shell variable — it does not check the UUID is valid or present on the
target Pi.

**Re-verify:**
```
grep -n "CFG = {" -A 25 scripts/chirpstack-bootstrap.js
grep -n "toUciCloudKey\|mapping = {" -A 15 scripts/chirpstack-bootstrap.js
grep -n "CHIRPSTACK_PROFILE_RAK10701\|CHIRPSTACK_PROFILE_S2120" deploy.sh   # expect: no matches
grep -n "chirpstack_profile" scripts/diagnose-pi-communication.sh
```

---
