# Dragino SDI-12 spec/plan review — consolidated verified findings

- **Date:** 2026-08-13
- **Source:** external model review of the spec + plan, adjudicated finding-by-finding against the repo before acceptance
- **Documents under review:** `docs/superpowers/specs/2026-08-13-dragino-sdi12-soil-node-design.md`, `docs/superpowers/plans/2026-08-13-dragino-sdi12-soil-node-plan.md`
- **Verdict:** revise before execution. 14 findings raised; 14 verified at least in core; 4 trimmed in scope with reasons below. No finding was fully rejected.

Status legend: CONFIRMED (claim checked against code/docs and correct), PARTIAL (core correct, scope trimmed). Each entry ends with the fix the revision must implement.

## Blockers

**B1 — Parser grammar does not close the glued-address hazard. CONFIRMED.**
`+22.10+31.2` (value `+22.1` followed by response address `0` and `+31.2`) matches `^([+-]\d+(\.\d+)?)+$` and parses as `[22.10, 31.2]` — the exact hazard the design claims the grammar rejects. The normalizer also tolerates cardinality mismatch (skips missing indices, ignores extras) and matches `NULL` by substring.
Fix: stop claiming regex solves the ambiguity — the DATACUT recipe (strip every response address + CRC) is the real defense, and the parser is a backstop. Add per-profile exact cardinality (`expectedValues`; `GENERIC_VWC` alone stays variable as the documented escape hatch), reject the whole frame atomically on any count or structural mismatch, compare `raw === 'NULL'` exactly, and add glued-zero, short, long, and embedded-NULL test vectors.

**B2 — Codec decodes every unknown FPort as periodic telemetry; 0xF0 skip is one byte short. CONFIRMED.**
Current SDI-12-LB firmware uses FPort 3 for datalog retrieval (timestamp + length prefixed); the planned codec and gate would parse those bytes as battery/PAYVER/ASCII. Dragino's reference decoder shares this default-port sloppiness — not a reason to copy it. Its `if (bytes[i] >= 0xF0) { i = i + 1; }` inside a `for (…; i++)` loop skips the marker AND the following byte; the planned `continue` skips only the marker.
Fix: decode periodic data only on `fPort === 2`; return an explicit `{unsupported_fport: n}` object for 3 and other ports so the gate can drop them observably; mirror the two-byte skip; add a test with a printable byte after `0xF0` and an FPort 3 frame.

**B3 — Payload capacity contradicts the 24-channel claim. CONFIRMED.**
24 ASCII values ≈ 120–145 bytes + 3-byte header; Dragino documents 51 bytes at DR0 for most bands (11 bytes US915 DR0), and oversized FPort 2 payloads are not delivered. HydraScout's proposed 12 values ≈ 63 bytes already exceeds DR0. The spec's "needs a good spreading factor" phrasing is also backwards — higher SF means less capacity.
Fix: give every profile a computed worst-case payload budget, checked by a unit test; cap v1 profiles to fit 51 bytes (HydraScout drops to fewer depths or splits quantities); document the region/data-rate constraint and that `AT+DATAUP=1` reassembly is the phase-2 unlock for larger probes. Fix the SF wording.

**B4 — Boot rebuild and repair script carry hardcoded devices literals the plan does not update. CONFIRMED.**
`sync-init-fn` (flows.json:5792) embeds `DEVICES_NEW_DDL` (full CREATE with the type CHECK and column list), `DEVICES_COPY_SQL` (positional copy), and `REQUIRED_TYPES`. The plan updated only `REQUIRED_TYPES`: a live rebuild would recreate `devices` without the three `sdi12_*` columns and with a CHECK still lacking `DRAGINO_SDI12`, then re-trigger on every boot. `scripts/repair-pi-schema.js` (`ensureDeviceTypeCheckIncludesLorain`, ~L232) carries a fourth hardcoded column list.
Fix: update all three boot-node literals (both flows files), extend `scripts/repair-pi-schema.js`, run `node scripts/verify-boot-ddl-interpolation.js` + `verify-trigger-body-parity.js`, and extend the rebuild rehearsal to carry sentinel `sdi12_*` values through the rebuild and assert full column preservation (the existing verifiers compare type sets and fencing, not columns).

**B5 — None of the 24 new readings reaches any cloud path. CONFIRMED.**
`trg_dp_device_data_outbox_ai` (seed-blank.sql ~L1408) enumerates every telemetry field in its `json_object` — new columns never ride `DEVICE_DATA_APPENDED`. "Build Telemetry" enumerates fields and falls back to `KIWI_SENSOR` for unknown profiles. `osi-history-sync-helper` hashes a fixed 6-column `device_data` list.
Fix (edge side, this plan): extend the device_data outbox trigger in seed + a migration + the boot-node copy (gated by `verify-trigger-body-parity.js`); add the SDI-12 branch and fields to Build Telemetry. History-hash extension and all osi-server work (type enum, channel copies, mapper, storage) move to the paired companion plan — **upgraded from "post-merge" to an explicit lockstep merge gate**: the edge branch must not merge before the server branch is ready, matching the established lockstep constraint. (Scope trim vs the review: the server work stays out of this osi-os plan, but its gating is now explicit.)

**B6 — Local GUI and CSV export receive none of the new values. CONFIRMED.**
The `/api/devices` chain ("Format Response" ~flows:525 + "Merge Data" ~flows:561) selects and reconstructs `latest_data` fields explicitly; `types/farming.ts` enumerates `latest_data` members; the sensor export node ("Build SQL + Params" ~flows:3287) selects explicit columns. Declaring manifest entries and building a card exposes nothing.
Fix: new plan tasks extending the devices-endpoint latest-data query and merge, the `latest_data` TypeScript shape (24 + swt reuse), the export query, and an end-to-end assertion (SQLite row → `/api/devices` → card → CSV) for one VWC, one temperature, one EC value.

**B7 — Auto-identification can confidently pick the wrong profile. CONFIRMED.**
`PR2_6` matches `/DELTA-?T/i` while `PR2_4` has no matcher — a PR2/4 silently becomes a PR2/6. All named profiles are datasheet-guessed (`provisional: true`) yet auto-selectable.
Fix: v1 ships every provisional profile with `identityMatch: null` — the identify flow still runs, stores and displays the captured identity string, but never auto-selects; matchers are enabled per probe during the bench phase only for identities that uniquely determine a value layout, and ambiguous families (PR2) return an explicit needs-manual result. (Scope trim vs the review: provisional profiles stay manually selectable — bench work and informed operators need them; the GUI already labels them "(unverified)".)

**B8 — Registration never starts identification; the pending state has no exit on failure. CONFIRMED core.**
Task 11 wires catalog/auth/maps but never invokes the identify action after registration, so the spec's "registration sets pending and enqueues" is unimplemented. An unmatched identity or failed enqueue leaves `pending_identify` forever; the no-match branch's UPDATE also lacks the pending guard the matched branch has.
Fix: one shared identify-trigger sub-flow invoked both post-registration (SDI-12 type only) and from the endpoint; add `unmatched` to the status enum as the terminal no-match state (identity stored, GUI prompts manual); apply the pending guard on both UPDATE branches; validate the ChirpStack app id before enqueue and surface enqueue failure in the response. (Scope trim vs the review: no attempt counters/timeout columns in v1 — the GUI shows pending age from `updated_at` and "Detect probe" re-triggers; a retry state machine is not justified yet.)

**B9 — The plan's flows write node is not executable as written. CONFIRMED.**
The UC512 reference node (flows:11012) acquires `fs` via `global.get('fs')` (not a `libs` entry), uses `osiDb` (`new osiDb.Database`, explicit `close()`), and stages failure reporting; the planned node declared only `osiLib`, used bare `fs`, and left `var db = ...` — violating the playbook's zero-placeholder rule (engineering-playbook.md ~L51).
Fix: the revised plan carries the complete function body copied-and-adapted from node 11012: both libs, `global.get('fs')`, async open/write/close with `finally`, dead-letter-aware node status (see S1).

## Should-fix

**S1 — Quarantine is documented with the wrong tuple and is operationally invisible. CONFIRMED.**
`osi-device-writer` records normalizer unknowns as `reason='unknown_channel'` with the map key as the channel name — `unparseable_sdi12` is a channel, not a reason; the spec's troubleshooting prose says otherwise. The planned node reported green even when values were dead-lettered; the quarantine table caps at 1,000 rows and has no operator surface.
Fix: correct the documented tuple everywhere; node status yellow + rate-limited warn when `deadLettered.length > 0`. (Scope trim: a GUI/health quarantine surface is a tracked follow-up, not v1.)

**S2 — UCI-only recovery path drops every SDI-12 uplink. CONFIRMED.**
`feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` resolves each profile id via `resolve_chirpstack_value osi-server.cloud.chirpstack_profile_* CHIRPSTACK_PROFILE_*` and exports it into Node-RED's env (~L94 + ~L230). Without a `chirpstack_profile_sdi12` line, the strict gate sees an empty env var on env-file-less boots and silently drops everything.
Fix: add the resolve + export lines to `node-red.init` in the provisioning task.

**S3 — New SQL string-building violates the bound-parameters rule. CONFIRMED.**
engineering-playbook.md L153: "SQL: bound parameters only. User-influenced values (even a timezone offset) never [interpolate]". The identify/config nodes escape correctly (no exploitable injection found), but the rule is absolute for new code; the older lsn50 string-SQL chains are legacy, not license.
Fix: route the new endpoints' reads/updates through `osiDb` with `?` parameters (or prepared sqlite nodes with `msg.params`); add quote/control-character tests for identity and profile values.

**S4 — Depth model conflates channels with physical depths. CONFIRMED.**
Tensiomark: 2 channels, 1 physical depth. HydraScout: 3 quantities per depth. The modal's "default by channel position" gives temperature/EC channels no depth, and the PUT accepts depth keys for channels absent from the profile.
Fix: add a `depthSlot` to each profile value entry; the modal renders one depth input per physical slot and fans the value out to that slot's channels; storage stays channel-keyed (`soil_moisture_probe_depths_json`, KiwiSensorCard-compatible); the PUT validates the map against the selected profile's exact channel set and replaces stale keys.

**S5 — Task sequencing breaks the spec's atomicity and omits mandatory gates. CONFIRMED.**
The spec requires migration + seed + 7 bundled DBs in one commit; the plan split them across Tasks 4–6 (three commits). Task 9 declares a wire to `sdi12-identify-fn`, created in Task 10. Task 6 masked `test-journal-schema.js` with `|| true`. The final battery omits `test-flows-wiring.js`, `verify-flows-fn-parse.js`, `verify-trigger-body-parity.js`, `verify-boot-ddl-interpolation.js` (all exist in `scripts/`), and the production frontend build.
Fix: merge the schema work into one atomic task/commit; move the output-2 wiring into the identify task; replace `|| true` with an explicit existence check that fails on test failure; add the four gates plus `npm run build` (alone, per the workstation memory-pressure rule) to the battery.

## Corrections the review itself needed

1. Dragino's official decoder default-decodes unknown FPorts as periodic too — B2's fix goes beyond vendor behavior, it does not "mirror" it (only the two-byte 0xF0 skip mirrors the vendor).
2. The review's demand to block provisional profiles from ingestion entirely was rejected (B7): bench captures require ingesting through a provisional profile, and manual selection is an informed operator action.
3. The review's full osi-server implementation demand was scoped out of this osi-os plan (B5) but converted into a hard lockstep merge gate rather than the plan's original "post-merge companion" framing.
4. The review's durable identify state machine (attempt counts, timeouts) was trimmed (B8) — v1 gets a terminal `unmatched` state and manual re-trigger, nothing more.

## Revision consequences

The spec needs edits in: parser/grammar section (B1), device-facts + out-of-scope (B2, B3), schema/boot-node section (B4), sync section (B5), auto-identification (B7, B8), troubleshooting tuple (S1), depth model (S4). The plan needs: Task 1 rewritten (B2), Task 2 parser/profiles rewritten (B1, B3, B7, S4), Tasks 4–6 merged into one atomic schema task extended with the boot-node literals + repair script + device_data trigger (B4, B5), Task 8 + node-red.init (S2), Task 9 full node body + rewire (B9, S5), Task 10 state machine + shared trigger (B8), Task 11 post-registration hook (B8), Task 12 bound params + slot validation (S3, S4), Task 13/14 latest_data + endpoint/export extension (B6), telemetry task (B5), gate battery completion (S5).
