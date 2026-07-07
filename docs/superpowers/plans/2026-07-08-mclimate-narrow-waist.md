# MClimate T-Valve Narrow-Waist Pilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) feature branch `feat/mclimate-narrow-waist` (worktree strongly recommended — this is an L item touching schema, flows, codecs, and React); (2) `flows.json` edits ONLY via one-shot Node scripts per `.claude/skills/osi-flows-json-editing/SKILL.md`, roundtrip-guarded, both profiles; (3) schema changes ONLY per `.claude/skills/osi-schema-change-control/SKILL.md` — the `MCLIMATE_TVALVE` type is a **destructive** CHECK-rebuild + the full boot-node merge gate; (4) every `conf/` file changes in BOTH profiles (bcm2712 canonical, bcm2709 mirror) in the same commit; (5) CI green at every commit; (6) **item 3.0 (actuator duration-bound gate) and item 1.A1 (osi-lib loader) MUST be merged before this item's MClimate downlink / helper-load code lands** — hard dependency.
> **Spec:** [`docs/superpowers/specs/2026-07-08-mclimate-narrow-waist-design.md`](../specs/2026-07-08-mclimate-narrow-waist-design.md) (approved — this plan elaborates, does not redesign). §A–§F references point there.
> **Charter:** [`docs/architecture/refactor-program-2026.md`](../../architecture/refactor-program-2026.md) — Phase 3, items **3.1 + 3.2 + 3.3** (DD6/DD7/DD8/DD17).

**Goal:** Ship the DD6 narrow waist: pure per-device `normalize(decoded, meta) → {channels}` modules (MClimate + LSN50), ONE manifest-driven closed-allow-list writer (`osi-device-writer`) that never emits DDL and dead-letters unmapped channels to `ingest_quarantine`, a `verify-device-integration.js` round-trip CI gate, the `MCLIMATE_TVALVE` device type through every catalog surface, the MClimate codec + ChirpStack profile + live ingest node with a DD17-duration-bounded downlink, and LSN50 shadow mode producing the DD7 evidence in `lsn50_shadow_diff` (measured, NOT cut over — cutover is item 4.1).

## ⚠️ Execution-time operator inputs (BLOCKING — obtain before coding the codec)

1. **MClimate T-Valve LoRaWAN payload datasheet** — the codec's byte layout is NOT in the repo and is NOT invented here (spec §3). The worker MUST have the datasheet in hand to write `codecs/mclimate_tvalve_decoder.js` and its golden vectors. Cite the datasheet (title/version/page) in the codec header.
2. **Confirm the T-Valve has a device-side auto-close / timed-open** capability (spec §C, DD17). If the datasheet shows NO firmware auto-close, STOP and escalate to a FABLE-DECISION — an unbounded valve cannot ship under DD17. Do not proceed with the downlink until this is confirmed.
3. **Enumerate the T-Valve's uplink fields from the datasheet** and decide per-field (spec §A): maps to an existing manifest channel (`bat_v`, `ambient_temperature`, …), needs a NEW manifest channel (+ additive `device_data` column migration), or is not persisted (`unknown`). This decision drives Task 3's scope.

## Global constraints

- **Both profiles byte-parity** for every `conf/` file. `verify-profile-parity.js` gates flows, seed DBs, node-red tree, seed script.
- **Frozen `sync-init-fn`** touched ONLY for the sanctioned `REQUIRED_TYPES` set-equality extension (spec §5) — nothing else.
- **Closed allow-list is inviolable:** the writer emits ZERO DDL; a channel with no manifest `edgeField` (or naming a non-existent column) is dead-lettered or hard-errors, never `ADD COLUMN`'d (DD6).
- **No osi-server change; no SSH; no live gateway.** Shadow mode is measured on demos by item 4.1's operators reading the table — this item stands up the table + node.
- Branch `feat/mclimate-narrow-waist`, commit per task, PR at end, do NOT merge.

## Dependency order (why the tasks are sequenced this way)

Schema (device type + quarantine + any new channel columns) must exist before the writer can target columns; the writer + normalizers must exist before the round-trip gate can prove them; the gate must be green before the live MClimate node and the LSN50 shadow node wire them in. Task order: **1** schema (device type) → **2** schema (`ingest_quarantine`) → **3** channel/column additions from the datasheet → **4** LSN50 normalizer (extraction, golden vectors first) → **5** MClimate codec + normalizer → **6** `osi-device-writer` → **7** `verify-device-integration.js` gate → **8** ChirpStack profile + catalog surfaces → **9** MClimate live ingest node (flows) → **10** LSN50 shadow node (flows) → **11** full gate + PR.

**Ordered-migration numbering (avoid collisions):** this item adds up to FOUR ordered migrations — Task 1 (device type), Task 2 (`ingest_quarantine`), Task 3.1 (any new T-Valve columns, conditional), Task 10 (`lsn50_shadow_diff`). The current highest is `0004__widen_schedule_trigger_metric_check.sql`, so these take **0005 / 0006 / 0007 / 0008 in task order** (Task 1 = 0005, Task 2 = 0006, Task 3.1 = 0007 if created, Task 10 = 0008 — renumber down by one if Task 3.1 is a no-op). Re-run `ls database/migrations/ordered/` before creating each so the numbers stay contiguous and unique; do NOT let two tasks both grab 0005.

---

### Task 1: `MCLIMATE_TVALVE` device type — destructive CHECK rebuild + full boot-node merge gate

**This is the single largest schema sub-task. Follow `osi-schema-change-control` exactly; do NOT invent an ad hoc path.**

**Files:**
- Create: `database/migrations/ordered/NNNN__mclimate_tvalve_device_type.sql` (next contiguous 4-digit version; **`-- risk: destructive`** header — a CHECK change is a table rebuild).
- Modify: `database/seed-blank.sql` (add `'MCLIMATE_TVALVE'` to the `devices.type_id` CHECK list).
- Modify: all 7 bundled `farming.db` copies (rebuild the `devices` CHECK — see the skill's exact FK-fenced procedure).
- Modify (both profiles): `sync-init-fn` `REQUIRED_TYPES` array (via flows one-shot mutation script) — add `'MCLIMATE_TVALVE'` for set-equality convergence.
- Modify: `scripts/verify-runtime-schema-parity.js`, `scripts/verify-db-schema-consistency.js`, `scripts/verify-devices-rebuild-fence.js` (extend the canonical type set); re-run `rehearse-devices-rebuild.test.js`.

- [ ] **Step 1.1:** Determine the next migration version (`ls database/migrations/ordered/`). Write the destructive migration performing the FK-fenced `devices` CHECK rebuild for the new 7-type set, mirroring the sanctioned boot-node rebuild shape (DROP `devices_new` if present → CREATE `devices_new` with the 7-type CHECK → plain `INSERT` copy → rename swap → recreate the four indexes), inside the runner's destructive fence (`PRAGMA foreign_keys=OFF` outside the tx; DDL inside `BEGIN IMMEDIATE`/`COMMIT`; `PRAGMA foreign_keys=ON`). The runner does not run on-device (Key Fact), but the file is the durable checksummed authority.
- [ ] **Step 1.2:** Add `'MCLIMATE_TVALVE'` to `seed-blank.sql`'s `devices.type_id` CHECK (the multi-line `CHECK(type_id IN (...))` block).
- [ ] **Step 1.3:** Rebuild the `devices` CHECK in all 7 bundled DBs. Because SQLite cannot `ALTER` a CHECK in place, use the FK-fenced rebuild per the skill's NEVER-do FK-fence rule (foreign_keys OFF across the swap, or the `device_data`/`chameleon_readings` cascade wipes child rows). Then `cp` the bcm2712 full DB over the bcm2709 mirror for byte-parity.
- [ ] **Step 1.4:** Extend `REQUIRED_TYPES` in `sync-init-fn` (both profiles) via a one-shot flows mutation script (roundtrip guard; assert only the `REQUIRED_TYPES` array literal changes and it is the sole edit to `sync-init-fn`). The set-equality guard then converges any live Pi's CHECK to the 7-type set on next boot.
- [ ] **Step 1.5:** Extend the canonical type set in `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js` (its `type_id` CHECK assertion), and `verify-devices-rebuild-fence.js` if it enumerates the set. Update `rehearse-devices-rebuild.js`'s canonical set (its `legit-upgrade`/`extra-type` cases assume the 6-type set).
- [ ] **Step 1.6: Full boot-node merge gate** (must all pass):

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-profile-parity.js
```
All green. A production-copy rehearsal is expected before any live rollout (that is item 4.1's runbook, not this item).
- [ ] **Step 1.7: Commit** (`feat(schema): add MCLIMATE_TVALVE device type (destructive CHECK rebuild) (refactor-program 3.1)`).

---

### Task 2: `ingest_quarantine` dead-letter table (additive)

**Files:**
- Create: `database/migrations/ordered/NNNN__ingest_quarantine.sql` (**`-- risk: additive`**).
- Modify: `database/seed-blank.sql` + all 7 bundled DBs (apply the additive migration to each, then mirror-copy).
- Modify: `scripts/verify-db-schema-consistency.js` (add the table to the hand-maintained contract).

- [ ] **Step 2.1:** Write the additive migration creating `ingest_quarantine` per the pre-ruled shape (spec §B): columns `id` (PK), `deveui`, `channel`, `payload` (raw hex + decoded JSON as TEXT), `reason`, `received_at`; row-cap ~1,000 with oldest-eviction. **Oldest-eviction mechanism:** a trigger `AFTER INSERT` that deletes the oldest rows when count exceeds 1,000 (`DELETE FROM ingest_quarantine WHERE id NOT IN (SELECT id FROM ingest_quarantine ORDER BY id DESC LIMIT 1000)`), OR the writer prunes on insert — decide: a trigger keeps the cap enforced regardless of writer, prefer the trigger. Prefer `IF NOT EXISTS` on table + trigger for re-runnability.
- [ ] **Step 2.2:** Add the same DDL to `seed-blank.sql`; apply to all 7 DBs; mirror-copy bcm2712→bcm2709.
- [ ] **Step 2.3:** Extend `verify-db-schema-consistency.js`'s `schemaContract` with `ingest_quarantine` (columns) and any trigger fragment.
- [ ] **Step 2.4:** Gate: `verify-migrations.js`, `verify-seed-replay.js`, `verify-db-schema-consistency.js`, `verify-profile-parity.js` all green.
- [ ] **Step 2.5: Commit** (`feat(schema): add ingest_quarantine dead-letter table (additive) (refactor-program 3.1)`).

---

### Task 3: Channel / column additions from the datasheet (conditional)

Only if the T-Valve (Task 5's datasheet enumeration) or LSN50 shadow (Task 10) requires channels/columns not already present. Two sub-cases:

- [ ] **Step 3.1 (T-Valve channels):** For each T-Valve uplink field that needs a NEW manifest channel (per the §A per-field decision), add: an additive `device_data` column migration (if the column doesn't exist), `seed-blank.sql` + 7 DBs, and a `channels.json` row (`key`, `unit`, `edgeField` = the column, `serverField`, `exportable`, `category`, `cardType`, `legacyAliases: []`). Run `verify-channel-manifest-parity.js` + the schema verifier set.
- [ ] **Step 3.2 (LSN50 manifest coverage — the §D decision (a)):** `lsn50-sql-fn` writes 36 `device_data` columns; **18 have no manifest entry** (verified — the exact list is in spec §2: `counter_interval_seconds`, `dendro_mode_used`, `dendro_saturated`, `dendro_saturation_side`, `dendro_valid`, `flow_count_cumulative`, `flow_delta_status`, `flow_liters_delta`, `flow_liters_per_10min`, `flow_liters_per_min`, `flow_liters_today`, `flow_pulses_delta`, `lsn50_mode_code`, `lsn50_mode_label`, `lsn50_mode_observed_at`, `rain_count_cumulative`, `rain_delta_status`, `rain_tips_delta`). For faithful zero-diff shadow, EVERY LSN50-written column must have a manifest entry. These columns **already exist** in `device_data`, so this is adding **~18 manifest rows**, NOT new columns/migrations. For each: add a `channels.json` row with `edgeField` = the column; pure-diagnostic columns (`lsn50_mode_*`, `dendro_saturation_side`, `*_delta_status`) get `exportable: false` (like `bat_v`/`bat_pct`); flow-metering columns (`flow_liters_today`, etc.) get `exportable: true` — never an allow-list bypass. Run `verify-channel-manifest-parity.js`.
- [ ] **Step 3.3:** If TypeScript-visible, add fields to `web/react-gui/src/types/farming.ts`.
- [ ] **Step 3.4: Commit** (`feat(channels): manifest rows/columns for MClimate + LSN50 shadow coverage (refactor-program 3.1/3.3)`).

> **Note:** if the datasheet enumeration (Task 5) shows the T-Valve maps entirely onto existing channels and LSN50's columns all already have manifest rows, Task 3 may be a no-op for T-Valve and a manifest-rows-only change for LSN50. Do not create columns speculatively.

---

### Task 4: LSN50 normalizer (behavior-preserving extraction, golden vectors FIRST)

**Files:**
- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-lsn50-normalize/{index.js,package.json,index.test.js}`.
- Register in `osi-lib` `NAME_TO_PATH` (add `'lsn50-normalize': 'osi-lsn50-normalize'`), runtime `package.json`+lock, seed loop, `deploy.sh` — the three-surface registration (1.A1 §D2); `verify-helper-registration.js` must stay green.

- [ ] **Step 4.1: Capture golden vectors from the OLD path FIRST** (the extraction mandate). Extract the field mapping currently inline in `lsn50-sql-fn` (the `d.swt1Kpa`, `d.dendroRatio`, `d.batV`, MOD9 branch, etc.) into a pure `normalize(decoded, meta) → { channels, unknown }` (spec §A signature). The `channels` keys are manifest keys; the mapping is byte-for-byte the old node's field→column logic, re-expressed as field→channel-key. Write `index.test.js` with golden decoded inputs and asserted `{channels}` outputs BEFORE finalizing `index.js`.
- [ ] **Step 4.2:** Implement `index.js` (pure Node, zero deps, `osiLib.require`-loadable). Both branches (MOD9 counter mode + default dendro/soil mode).
- [ ] **Step 4.3:** Register in all three delivery surfaces + `NAME_TO_PATH`. Run `node --test .../osi-lsn50-normalize/index.test.js` and `node scripts/verify-helper-registration.js` — green.
- [ ] **Step 4.4:** Mirror to bcm2709; `verify-profile-parity.js` green.
- [ ] **Step 4.5: Commit** (`feat(edge): pure LSN50 normalizer extracted from lsn50-sql-fn + golden vectors (refactor-program 3.3)`).

---

### Task 5: MClimate codec + normalizer (datasheet-sourced)

**Files:**
- Create (both profiles): `conf/<profile>/files/usr/share/node-red/codecs/mclimate_tvalve_decoder.js` (uplink `decodeUplink` + downlink `encodeDownlink`).
- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-mclimate-normalize/{index.js,package.json,index.test.js}`; register three-surface + `NAME_TO_PATH` (`'mclimate-normalize': 'osi-mclimate-normalize'`).
- Create: codec golden-vector test (co-located, `codecs.yml` CI workflow already runs codec tests — confirm and wire).

- [ ] **Step 5.1:** With the datasheet (BLOCKING input), write `mclimate_tvalve_decoder.js`. Header cites datasheet title/version/page. `decodeUplink(input) → { data: {...} }`; `encodeDownlink(input) → { bytes, fPort }` for the timed-open command encoding the auto-close duration (DD17). Golden vectors transcribed from datasheet worked examples.
- [ ] **Step 5.2:** Write `osi-mclimate-normalize` mapping the codec's decoded fields to manifest channels per the §A per-field decision. Golden-vector `index.test.js` first, then `index.js`.
- [ ] **Step 5.3:** Register normalizer three-surface + `NAME_TO_PATH`; `verify-helper-registration.js` green. Wire the codec test into `codecs.yml` (confirm the workflow's codec-test pattern).
- [ ] **Step 5.4:** Mirror both profiles; `verify-profile-parity.js` green.
- [ ] **Step 5.5: Commit** (`feat(edge): MClimate T-Valve codec + normalizer (datasheet-sourced) (refactor-program 3.1)`).

---

### Task 6: `osi-device-writer` — the one manifest-driven writer

**Files:**
- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-device-writer/{index.js,package.json,index.test.js}`; register three-surface + `NAME_TO_PATH` (`'device-writer': 'osi-device-writer'`).
- Decide + create: the edge's manifest/allow-list source (spec §C open decision — a derived edge copy of `channels.json` or a derived writable-column allow-list JSON, shipped + parity-checked). Prefer a small derived allow-list JSON generated from `channels.json` with a parity verifier, mirroring the DD5 "channels.json as shared truth" direction.

- [ ] **Step 6.1:** Implement `writeDeviceData(db, manifest, normalizeResult, meta, opts) → { inserted, deadLettered, columns }` per spec §B: resolve `key → edgeField`; writable columns = manifest `edgeField != null` ∩ actual `PRAGMA table_info(device_data)` columns (cached); a manifest `edgeField` naming a non-existent column is a HARD ERROR (dead-letter + `node.error`), never `ADD COLUMN`; build a PARAMETERIZED insert (`?` placeholders); `unknown` + unmapped + server-only channels → `ingest_quarantine` row + `node.error`; `opts.shadow === true` COMPUTES + returns the row but does NOT persist to `device_data` (for Task 10).
- [ ] **Step 6.2:** Co-located `index.test.js`: writes only manifest columns; unknown channel → quarantine not dropped; manifest edgeField for a missing column → hard error, zero DDL; shadow mode returns computed row without inserting; parameterization handles SQL-hostile values. (Use `node:sqlite`/a scratch DB seeded from `seed-blank.sql`.)
- [ ] **Step 6.3:** Build the edge manifest/allow-list source + its parity verifier (`scripts/verify-edge-channel-allowlist-parity.js` or fold into `verify-channel-manifest-parity.js`). Register the writer three-surface + `NAME_TO_PATH`; `verify-helper-registration.js` green.
- [ ] **Step 6.4:** Mirror; `verify-profile-parity.js` green.
- [ ] **Step 6.5: Commit** (`feat(edge): osi-device-writer — manifest-driven closed-allow-list writer, no DDL (refactor-program 3.1)`).

---

### Task 7: `verify-device-integration.js` round-trip CI gate (item 3.2)

**Files:**
- Create: `scripts/verify-device-integration.js` + `scripts/verify-device-integration.test.js`.
- Create: `scripts/fixtures/device-integration/{mclimate,lsn50}/*.json` (golden decoded vectors; MClimate's cite datasheet examples).
- Modify: the appropriate CI workflow (`migrations.yml` or a new entry) to run it.

- [ ] **Step 7.1:** Implement the five-assertion round-trip gate (spec §F): for each registered normalizer, feed golden decoded vectors → `normalize` → `writeDeviceData` against a scratch DB seeded from `seed-blank.sql`, and assert (1) every `channels` key is a manifest key; (2) written `device_data` columns == exactly the manifest writable columns for those keys + `deveui`/`recorded_at`, nothing else; (3) well-formed vector → empty `unknown`, malformed → dead-lettered not dropped; (4) schema fingerprint byte-identical before/after (zero DDL); (5) SQL-hostile value round-trips safely.
- [ ] **Step 7.2:** Co-located `.test.js` with synthetic PASS/FAIL vectors (a normalizer emitting a non-manifest channel FAILS; a writer that would ADD COLUMN FAILS).
- [ ] **Step 7.3:** Wire into CI (`- run: node scripts/verify-device-integration.js` + `node --test scripts/verify-device-integration.test.js`). Green for both MClimate and LSN50.
- [ ] **Step 7.4: Commit** (`feat(ci): verify-device-integration round-trip gate (refactor-program 3.2)`).

---

### Task 8: ChirpStack profile + React catalog surfaces (minimal)

**Files:**
- Modify (both profiles): `conf/<profile>/files/usr/share/node-red/chirpstack-bootstrap.js` (add `MCLIMATE_CODEC_PATH`, `CS_PROFILE_MCLIMATE_NAME`, a `getOrCreateProfileWithCodec()` call, `CHIRPSTACK_PROFILE_MCLIMATE` output).
- Modify: `web/react-gui/src/types/farming.ts` (`DeviceType` union += `'MCLIMATE_TVALVE'`).
- Modify (both profiles): `catalog-response` node in flows.json (add `{ id: 'MCLIMATE_TVALVE', name: 'MClimate T-Valve' }`) — via one-shot flows mutation.
- Modify: `AddDeviceModal`/`IrrigationZoneCard` filters if they hardcode a per-type list (they read the catalog + `type_id`, so likely minimal).

- [ ] **Step 8.1:** Add the MClimate profile+codec to `chirpstack-bootstrap.js` mirroring the LSN50 pattern (env defaults, `readCodecScript`, `getOrCreateProfileWithCodec`, the `CHIRPSTACK_PROFILE_MCLIMATE` output alongside `CHIRPSTACK_PROFILE_LSN50`). Both profiles byte-identical.
- [ ] **Step 8.2:** `DeviceType` union + `catalog-response` entry (flows one-shot). React card is DEFERRED (spec §E #13) — generic/valve fallback renders it; note the follow-up UI item.
- [ ] **Step 8.3:** `typecheck.yml`-equivalent (`npm run` typecheck) green; flows pre-commit checklist green for the `catalog-response` edit.
- [ ] **Step 8.4: Commit** (`feat(catalog): register MCLIMATE_TVALVE in ChirpStack bootstrap + device catalog (refactor-program 3.1)`).

---

### Task 9: MClimate live ingest node + duration-bounded downlink (flows)

**Files:**
- Modify (both profiles, one-shot flows mutation): add `MClimate Normalize + Write` function node (MQTT-routed by profile), wired into the existing uplink path; add the T-Valve open to the Command Type Registry as `actuator: true, requires_duration: true`; add the downlink command wiring.

- [ ] **Step 9.1:** Add the `MClimate Normalize + Write` node: `libs` = `osiLib` + `osiDb`; body `osiLib.require('device-writer')` + `osiLib.require('mclimate-normalize')` + load the edge allow-list; open `osiDb.Database`, `normalize` then `writeDeviceData`, `.close(` (the audit requires it), `node.error` on failure. Route MClimate uplinks to it by the existing profile-based discrimination (mirror how LSN50 uplinks reach `lsn50-sql-fn`).
- [ ] **Step 9.2:** Add the T-Valve open command type to the `cmd-type-registry` node as `MCLIMATE_OPEN` (or the datasheet's command name) with `actuator: true, requires_duration: true` — **item 3.0's gate will FAIL the merge if this is unbounded** (the intended guardrail). Wire the downlink encoder (Task 5) so the payload carries the auto-close duration.
- [ ] **Step 9.3: Flows pre-commit checklist:** `verify-profile-parity.js`, `verify-sync-flow.js`, `check-mqtt-topics.sh`, `test-flows-wiring.js`, `verify-no-new-silent-catch.js`, `verify-command-safety.js` (item 3.0's, now including the new actuator — must stay green), all green. Update `test-flows-wiring.js` pins if the new node's wiring is pinned.
- [ ] **Step 9.4: Commit** (`feat(edge): MClimate live ingest node + duration-bounded T-Valve downlink (refactor-program 3.1)`).

---

### Task 10: LSN50 shadow node (flows) — DD7 evidence, no persistence

**Files:**
- Create: `database/migrations/ordered/NNNN__lsn50_shadow_diff.sql` (**`-- risk: additive`**) + `seed-blank.sql` + 7 DBs + consistency verifier — the `lsn50_shadow_diff` table.
- Modify (both profiles, one-shot flows mutation): add `LSN50 Shadow Compare` node teeing off the LSN50 uplink AFTER the old `lsn50-sql-fn` path (old path unchanged), running `normalize('lsn50-normalize')` + `writeDeviceData(..., {shadow:true})`, diffing against what the old path wrote, logging row-level diffs (incl. NULL-vs-absent and dedup semantics) to `lsn50_shadow_diff`.

- [ ] **Step 10.1:** Additive `lsn50_shadow_diff` table (columns: `deveui`, `recorded_at`, `field`, `old_value`, `new_value`, `diff_kind`, `observed_at` — enough for the 4.1 runbook to judge zero-diff/zero-dead-letter). Migration + seed + 7 DBs + consistency verifier + mirror.
- [ ] **Step 10.2:** Add the `LSN50 Shadow Compare` node. The old `lsn50-sql-fn` path is UNCHANGED (source of truth during shadow). Shadow computes the writer's row, diffs field-by-field against the old INSERT's values, writes only DIFFS (or a zero-diff marker) to `lsn50_shadow_diff`. Semantically-aware diff (spec §D): a column the old path writes but the manifest lacks would show as a diff UNLESS Task 3.2 added its manifest row — so Task 3.2 must be complete for a faithful zero-diff.
- [ ] **Step 10.3: Flows pre-commit checklist** green (shadow node opens+closes `osiDb`; `test-flows-wiring.js` `.close(` audit applies).
- [ ] **Step 10.4: Commit** (`feat(edge): LSN50 shadow-mode compare → lsn50_shadow_diff (DD7 evidence) (refactor-program 3.3)`).

---

### Task 11: Full gate, program-doc update, PR

- [ ] **Step 11.1: Full local CI-equivalent run** — the schema verifier set, `verify-helper-registration.js`, `verify-channel-manifest-parity.js`, `verify-device-integration.js`, `verify-command-safety.js`, `verify-sync-flow.js`, `check-mqtt-topics.sh`, `test-flows-wiring.js`, all normalizer + writer + gate `node --test` suites, `verify-profile-parity.js`, and the React typecheck — every one green.
- [ ] **Step 11.2:** Update `docs/architecture/refactor-program-2026.md` Phase 3 rows 3.1/3.2/3.3 with the outcome + PR number.
- [ ] **Step 11.3:** Open the PR (do NOT merge). Body: the narrow-waist summary, the DD7 shadow-measurement note (cutover is 4.1), the DD17 downlink-is-duration-bounded note, and the hard dependency that 3.0 + 1.A1 merged first. Include the full green gate output.

---

## Follow-ups (not tasks in this plan)

- **Item 4.1** — LSN50 writer cutover on the DD7 evidence bar this item measures (`docs/operations/lsn50-writer-cutover-runbook.md`), temporary UCI kill-switch, demos→prod.
- **Item 3.4** — server-side MClimate `SyncEventApplier` (osi-server, DD12).
- **MClimate React card** — the deferred bespoke `MClimateValveCard.tsx` UI item (spec §E #13).
- **Fallback-copy parity** for the Command Type Registry (item 3.0's noted follow-up) — now that MClimate adds a registry entry, the `COMMAND_TYPES_FALLBACK` copies should gain it too; consider the parity assertion.
