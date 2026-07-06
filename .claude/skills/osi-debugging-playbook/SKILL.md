---
name: osi-debugging-playbook
description: Use when triaging an OSI OS symptom of unknown root cause — SWT/soil-tension null despite uplinks, "i2c_missing"/"I2C_MISSING", "duplicate column name" from a verifier/upgrade test, EBUSY on /sys/class/pwm, fan not responding, export.csv 401 vs 404, history chart gaps, stale cloud mirror/sync_outbox growth, Node-RED all-routes-404 after deploy, curl exit 52/28 hangs, or "which script checks X".
---

# OSI Debugging Playbook

## Overview

Symptoms lie about their cause more often than not: a flag named after LoRaWAN can mean a wiring fault, a schema error can mean a stale test baseline, and a 401 can mean "working as intended." Triage by running the cheapest discriminating experiment first — never patch the symptom you were told about before you've confirmed which subsystem actually owns it.

## When to use / when NOT to use

Use this skill when you have an observed symptom (an error string, a null field, a stuck counter, an HTTP status) and need to identify **which subsystem is actually broken** before touching anything.

Do NOT use this skill for:
- Executing a live-Pi deploy, backup, or stale-fingerprint recovery — see **osi-live-ops-runbook**.
- Editing `flows.json` itself (node wiring, `libs` bindings, the flows-editor workflow) — see **osi-flows-json-editing**.
- Making a schema change, migration, or reasoning about seed/bundled-DB parity — see **osi-schema-change-control**.
- Sensor/agronomy domain semantics (what SWT means agronomically, calibration formulas, wiring physics in depth) — see **osi-agronomy-sensors-reference**.
- UCI config, env vars, feature flags, or deploy-time knobs — see **osi-config-and-flags**.

This skill only routes you to the right subsystem and the right first command. Once you know the cause class, hand off to the sibling skill that owns the fix.

## Symptom triage table

Read this table top to bottom. Run the "first discriminating experiment" before forming a theory.

| Symptom (exact text) | Likely cause class | First discriminating experiment | Grounding |
|---|---|---|---|
| Chameleon soil uplinks arrive on schedule but SWT is null / `i2c_missing=1` in `chameleon_readings` | Device-side I2C acquisition fault (wiring/power) — NOT LoRaWAN, NOT calibration, NOT sync | `SELECT SUM(i2c_missing), SUM(timeout), SUM(data_invalid) FROM chameleon_readings WHERE upper(deveui)=upper('<deveui>') AND recorded_at >= '<window-start>'` — nonzero `i2c_missing` with `timeout=0` and a fixed diagnostic signature (no temp/ID fault) is the signature of the fault, not a probe or radio issue | `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md` (2026-06-28 field diagnosis); wiring/power root-cause detail lives in **osi-agronomy-sensors-reference** — one-line pointer only |
| `duplicate column name: <col>` from a schema verifier or upgrade test | Stale upgrade-test baseline (a fixed historical git ref used as the "pre-migration" seed no longer predates the migration it's testing) — NOT the frozen boot-DDL node | Check which ref the test diffs against (e.g. `OSI_HISTORY_BASE_REF` in `scripts/test-sync-history-schema.js`); if `main`'s current `database/seed-blank.sql` already contains the columns the migration tries to `ADD COLUMN`, the base ref is stale, not the schema itself | Issue #84 (closed) — root cause was exactly this: `main:database/seed-blank.sql` absorbed a migration's columns after PR #70 merged, so replaying the migration on top of `main` double-added them. AGENTS.md "Boot-DDL freeze" section documents this exact misattribution risk |
| `EBUSY` writing `/sys/class/pwm/pwmchip2/pwm3` (fan PWM) | Kernel `pwm-fan` driver owns the raw PWM channel | Check whether `dtparam=cooling_fan=okay` and `kmod-hwmon-pwmfan` are active; if so, the raw sysfs path is owned by the kernel driver — use the hwmon device instead | AGENTS.md "Fan telemetry/control" section: switch fan detection/control to `/sys/class/hwmon/*/pwm1` + `pwm1_enable` |
| Fan does not respond to `SET_FAN` cloud command | Same class as above, or command-path issue — first rule out the sysfs-ownership class before assuming a command-routing bug | Same discriminator as above | AGENTS.md "Fan telemetry/control" |
| `GET /api/history/zones/:zoneId/export.csv` returns `401` | HEALTHY — this is an auth-gated route working correctly, not a bug | Confirm the response is `401` (auth-gated) and not `404`/`500`; `401` on this route is a *standard post-deploy pass signal* | Route confirmed in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` ("GET /api/history/zones/:zoneId/export.csv"); part of the standard post-deploy checklist in **osi-live-ops-runbook** |
| `GET /api/history/zones/:zoneId/export.csv` returns `404` or `500` | Actually broken — route missing or crashing | Diff the live route table against the repo's `flows.json` for this node; check Node-RED logs for the function node's own try/catch | Same route as above; 404/500 is explicitly the "not healthy" branch of the same check |
| Gaps in sensor history charts | Ambiguous until you separate gateway-down from sensor-down — do this FIRST | Query `gateway_health_samples` / `gateway_health_hourly` for the same time window: a matching gap there means the gateway (or Node-RED) was down, not the sensor | `docs/operations/edge-history-retention.md` "Gateway health telemetry" section; see also `scripts/diagnose-sensor-history-gap.js` below, which diagnoses a *different* thing (edge-vs-cloud row presence, not gateway-down-vs-sensor-down) |
| Cloud mirror looks stale, `sync_outbox` growing | Sync backlog or broken link — need to know if it's currently healthy before acting | `node scripts/check-sync-parity.js /data/db/farming.db` — exit 0 means the DR net (cloud parity) is current; nonzero means unlinked, rejected events, pending history dirty-keys, or an old undelivered event | `scripts/check-sync-parity.js`, `docs/operations/cloud-parity-dr.md` |
| Historical data repaired on the edge (e.g. `device_data.swt_*` backfilled from `chameleon_readings`) but charts / cloud mirror still show old/null values | The device_data→outbox sync trigger fires on `INSERT` only; a historical `UPDATE` does not auto-enqueue a sync event | Check `sync_outbox` for `DEVICE_DATA_APPENDED` events covering the repaired rows' `recorded_at` range; if absent, the repair needs to explicitly enqueue them and a rollup rerun | AGENTS.md Chameleon section; confirmed in the 2026-06 field SWT repair (559 backfilled rows needed explicitly enqueued events before the cloud mirror caught up — `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md`) |
| All Node-RED HTTP routes return `404` right after a flows deploy, no obvious error in logs | A `libs`-declared npm module (e.g. `osi-db-helper`) is missing from `/srv/node-red/package.json` while `settings.js` has `functionExternalModules: true` — Node-RED fails to load ALL flows silently | Run Node-RED in the foreground: `node-red --userDir /srv/node-red` — the real load error prints there even though the standard log shows nothing useful | Documented pitfall from Pi upgrade history: missing `"osi-db-helper": "file:osi-db-helper"` entry in the userDir `package.json` causes a silent whole-flow load failure; repair procedure lives in **osi-live-ops-runbook** |
| Edge HTTP endpoint hangs; `curl` exits `52` or `28`; nothing useful in logs | A function node uses an npm module (commonly `sqlite3`) without declaring it in the node's `libs` array — the module is `undefined` at runtime and the async handler never sends a response | Check the node's JSON definition for `"libs": [{"var": "sqlite3", "module": "sqlite3"}]` (or the equivalent for whichever module the handler uses) | Known pitfall: `functionExternalModules: true` enables `require()` in function nodes but does not auto-inject a bound variable — `libs` is the only binding mechanism. Fix pattern and edit workflow live in **osi-flows-json-editing** — pointer only |
| `npm run test:unit` behaves unexpectedly, or a bare `npx vitest run` gives different/incomplete results | Wrong test invocation — the frontend splits unit tests across two runners | Read `web/react-gui/package.json` `scripts` block directly | See "GUI test invocation" section below |

## GUI test invocation (web/react-gui)

As of 2026-07-06, `web/react-gui/package.json` defines:

```
"test:unit": "npm run test:unit:tsx-runner && npm run test:unit:vitest",
"test:unit:tsx-runner": "tsx --test 'tests/**/*.test.ts'",
"test:unit:vitest": "vitest run src/analysis/__tests__ src/components/analysis/__tests__ src/components/farming/__tests__ src/components/history/__tests__ src/components/__tests__ src/pages/__tests__ src/utils/__tests__ src/channels/__tests__ src/history/__tests__ --passWithNoTests"
```

`npm run test:unit` is two runners chained: a `tsx --test` pass over `tests/**/*.test.ts`, then a scoped `vitest run` over an explicit list of `src/**/__tests__` directories. A bare `npx vitest run` only runs the vitest half and skips the `tsx --test` suite entirely — it will look "mostly green" while silently omitting a whole test population. Always use `npm run test:unit` (or `cd web/react-gui && npm run test:unit`) for a full signal, never bare `npx vitest run`.

## Diagnostics toolbox

All paths below are relative to the repo root. "Cheap" means: runs against static files or a script-local fixture, no live Pi, no `npm install`, completes in well under a minute.

| Script | Purpose | How to run | Reading the output | Caveats |
|---|---|---|---|---|
| `scripts/verify-sync-flow.js` | Master sync/flows verifier; chains device fixtures (S2120, DB-helper transaction semantics) and internally spawns `verify-profile-parity.js` | `node scripts/verify-sync-flow.js` | Prints one `OK <check>` line per assertion, prints `Sync flow verification passed` at the end of its own section, then spawns `verify-profile-parity.js`; a healthy full run ends `All parity checks passed.`, exit 0 | CI-gated (`.github/workflows/verify-sync-flow.yml`). Verified clean in this worktree on 2026-07-06 (all checks OK, includes profile-parity sub-run) |
| `scripts/verify-profile-parity.js` | Confirms bcm2709 (Pi 4) payload files are byte-identical mirrors of bcm2712 (Pi 5) canonical source | `node scripts/verify-profile-parity.js` | Per-file `OK: <path>` / `OK: absent: <path>` lines, ends `All parity checks passed.`; any `MISMATCH`/`FAIL` blocks a merge | Not its own CI workflow but is invoked from inside `verify-sync-flow.js`, which is CI-gated. Verified clean in this worktree on 2026-07-06 (output shape and check count live in **osi-flows-json-editing** §Profile parity) |
| `scripts/verify-migrations.js` | Validates the ordered migration set under `database/migrations/ordered/` (naming, checksums/structure) | `node scripts/verify-migrations.js` | One-line summary `verify-migrations: OK (<n> migrations)`; nonzero exit on malformed migration | CI-gated via `.github/workflows/migrations.yml`. Verified clean in this worktree on 2026-07-06: `verify-migrations: OK (2 migrations)` |
| `scripts/check-mqtt-topics.sh` | Enforces the MQTT-IN topic rule (`application/+/device/+/event/up`, no hardcoded per-install UUIDs) across all shipped `flows.json` profiles | `scripts/check-mqtt-topics.sh` (or `bash scripts/check-mqtt-topics.sh`) | One `OK: <path> — no UUID patterns in MQTT IN topics` line per profile; any hardcoded UUID fails the line | Not wired into a GitHub workflow file directly (no dedicated `.yml`), but is the canonical enforcement AGENTS.md cites for this rule. Verified clean in this worktree on 2026-07-06 across bcm2712/bcm2709/bcm2708 |
| `scripts/verify-seed-replay.js` | Confirms the seed DB replays cleanly through the migration runner (CI-time only invocation path for `applyPending`) | `node scripts/verify-seed-replay.js` | Pass/fail summary; consult script header for exact format | CI-gated via `migrations.yml`. Not run in this session — no live-device dependency but not in the mandatory cheap set; treat as unverified here |
| `scripts/verify-runtime-schema-parity.js` | Fails if the shipped boot-DDL flow ever downgrades `database/seed-blank.sql` (devices CHECK / triggers) | `node scripts/verify-runtime-schema-parity.js` | Pass/fail summary | CI-gated via `migrations.yml`. Not run in this session; not in the mandatory cheap set — treat as unverified here |
| `scripts/verify-devices-rebuild-fence.js` | Guards the fail-closed `devices` table rebuild fence (FK toggle ordering, transaction wrapping) | `node scripts/verify-devices-rebuild-fence.js` | Pass/fail summary | CI-gated via `migrations.yml`. Not run in this session; treat as unverified here |
| `scripts/check-sync-parity.js` | Fail-safe cloud-parity DR check: is the edge→cloud sync mirror currently current? | `node scripts/check-sync-parity.js /data/db/farming.db` | Prints a JSON object (`linked`, `pending`, `pendingHistory`, `oldestPendingSec`, `rejected`, `lastDelivered`, `healthy`); exit 0 iff `healthy: true` | Needs the `sqlite3` CLI and a real `farming.db` (live Pi copy or pulled backup) — not all Pis ship `sqlite3`; run from a workstation against a pulled copy if so. Not run against a live DB in this session (no target available); logic read and confirmed fail-safe (unhealthy on missing/garbage data, never fail-open) |
| `scripts/audit-pi-db.js` | Read-only schema/PRAGMA audit of a deployed Pi's `farming.db` against required table/column sets | `node scripts/audit-pi-db.js [/data/db/farming.db]` | JSON audit report; nonzero exit on any required-table/column/PRAGMA failure | Needs `sqlite3` CLI + a live or pulled DB; never writes. Not run against a live target in this session |
| `scripts/repair-pi-schema.js` | Idempotent live-Pi schema repair (adds missing columns/tables with `IF NOT EXISTS`-style DDL); never overwrites the DB file | `node scripts/repair-pi-schema.js [/data/db/farming.db]` | Prints `WARN:` lines for statements that no-op (already applied) and a repair count | Needs `sqlite3` CLI + a live/pulled DB. This is a repair tool, not a pure diagnostic — read **osi-schema-change-control** first, and take the **osi-live-ops-runbook** pre-repair backup before running it against a live gateway |
| `scripts/diagnose-sensor-history-gap.js` | Compares two JSON row-dumps (edge vs cloud export) over a time range and reports rows present on edge but missing on cloud | `node scripts/diagnose-sensor-history-gap.js <edge.json> <cloud.json> <rangeStart> <rangeEnd>` | JSON `{edgeCount, cloudCount, missingOnCloud: [{deveui, recordedAt}, ...]}`; exit 0 iff `missingOnCloud` is empty | This diagnoses **edge-vs-cloud row presence**, not "is the gateway down" — for that, use the `gateway_health_samples` discriminator in the triage table above. Needs pre-exported JSON dumps (no live-device or DB dependency itself); not run in this session (no fixture dumps available) |
| `web/react-gui` — `npm run test:unit` | Frontend unit test suite (see GUI test invocation section above) | `cd web/react-gui && npm run test:unit` | Two-stage pass/fail; both stages must pass | Requires `node_modules` installed — skipped in this session per environment rules (no `npm install`) |

## Debugging method

Distilled from `docs/engineering-playbook.md` §6 ("When you are stuck or debugging") — read that section for the full version:

1. **Reproduce before theorizing.** Run the failing thing yourself; capture exact output. Don't debug a described symptom you haven't seen.
2. **Read the actual code, not your memory of it.** Line numbers move; claims rot — this is why every row in the triage table above was re-verified against current source before being written down.
3. **Bisect with history when the cause isn't obvious:** `git log -S "<string>"` finds when a behavior appeared; `git show <ref>:<path>` compares generations without switching branches.
4. **Test hypotheses empirically and cheaply:** a temp SQLite DB built from the seed, a ten-line Node script in the scratchpad, one `curl`. Minutes, not arguments.
5. **Root cause, then fix.** A signal that pattern-matches a known failure may have a different cause — the "duplicate column" row above is the canonical example: it looked like a boot-DDL regression and was actually a stale test baseline.
6. **Fix the class, not the instance,** and grep for siblings once you've found the real cause.
7. **If your fix fights the harness or the conventions, you misread the system.** Stop and re-read AGENTS.md and the nearest working precedent before continuing.

## Common mistakes

- Assuming `i2c_missing=1` is a LoRaWAN, sync, or calibration problem because "the uplink arrived fine." The uplink and the I2C acquisition are different layers; a fixed diagnostic signature with `timeout=0` and no probe/ID fault means the *acquisition*, not the radio link, failed.
- Blaming the frozen boot-DDL node for any `duplicate column` error on sight. Verify which seed/ref the failing test is actually diffing against first — issue #84 was exactly this misattribution, corrected only after someone re-read the test's base-ref logic.
- Treating a `401` on `export.csv` as a failure. It is the expected, healthy response for an auth-gated route; only `404`/`500` indicate breakage.
- Writing raw PWM sysfs values directly when the kernel `pwm-fan` driver is active — this races the driver and fails `EBUSY`; check for `dtparam=cooling_fan=okay` + `kmod-hwmon-pwmfan` first.
- Diagnosing a history chart gap as "sensor died" without first checking `gateway_health_samples` for the same window — a gateway outage produces the exact same symptom in the UI.
- Forgetting that a historical `UPDATE` to `device_data` (e.g. an SWT backfill) does not auto-enqueue a sync event — the trigger is INSERT-only. A repair that looks complete on the edge can still show stale data on the cloud mirror until events are explicitly queued.
- Running bare `npx vitest run` and treating a clean result as "tests pass" — it silently skips the `tsx --test` half of `npm run test:unit`.
- Assuming any verifier script works standalone. Several (`check-sync-parity.js`, `audit-pi-db.js`) need the `sqlite3` CLI and a real device DB; `diagnose-sensor-history-gap.js` needs pre-exported JSON dumps. Check the caveats column before running one cold against a live gateway.

## Provenance and maintenance

Re-verify these facts if this skill feels stale (dates below are last-checked, not permanent):

- Re-run the cheap verifier set from repo root: `node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js && node scripts/verify-migrations.js && scripts/check-mqtt-topics.sh` — all four should exit 0 with the output shapes described above (last confirmed 2026-07-06).
- Confirm CI gating hasn't changed: `grep -n "verify-\|check-mqtt\|test:unit" .github/workflows/*.yml` — as of 2026-07-06, `verify-sync-flow.js` is gated by `.github/workflows/verify-sync-flow.yml`; `verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js` are gated by `.github/workflows/migrations.yml`.
- Confirm the export.csv route still exists and is still auth-gated: `grep -n "export.csv" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`.
- Confirm the Chameleon I2C wiring conclusion still matches the operations doc: re-read `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md` if a new Chameleon field incident occurs — do not assume the same root cause without re-running the SQL discriminator.
- Confirm issue #84's fix actually landed (it was closed with a validated fix at write time): `gh issue view 84 --repo Open-Smart-Irrigation/osi-os`; if a *new* "duplicate column" report appears, re-check which base ref the failing test uses before assuming this same root cause.
- Confirm the fan sysfs guidance against current AGENTS.md: `grep -n "pwm-fan\|EBUSY\|hwmon" AGENTS.md`.
- Confirm `web/react-gui/package.json` test scripts haven't changed: `grep -n '"test:unit' web/react-gui/package.json`.
- Confirm `gateway_health_samples`/`gateway_health_hourly` retention/columns haven't changed: re-read `docs/operations/edge-history-retention.md` "Gateway health telemetry" section.
