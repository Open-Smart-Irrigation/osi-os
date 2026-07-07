# Expert Review — IoT / Embedded Edge Systems (OSI OS refactor program)

Reviewer lens: fleet-managed OpenWrt/LoRaWAN gateways, offline-first field ops, OTA/rollback, SD durability, actuator safety. Verified against the repos (2026-07-07). I disagree with the on-the-table proposals in three places and say so below.

## Verification notes (what I checked, not assumed)
- `flows.json` = 1.26 MB, ~564 `"id"` occurrences, 212 `ADD COLUMN` in the boot node — matches "525 nodes / ~93 ADDs of load-bearing DDL, plus repeats" characterization. The bulk is real.
- Codecs live at `.../node-red/codecs/*.js` (5 files: dragino_lsn50, sensecap_s2120, strega_gen1, aquascope_lorain, agroscope_uplink_transform). KIWI/STREGA-inline claim holds (no kiwi codec file).
- Migration runner (`lib/osi-migrate/runner.js` + `runner-iface.js`) is real, uses `sqlite3 -bail`, one process per exec, `busy_timeout` + `BEGIN IMMEDIATE`, `writersStopped=true` required. This is solid.
- `0004__widen_schedule_trigger_metric_check.sql` is a genuine fail-closed table rebuild with byte-identical seed DDL — the destructive migration that has no live-delivery path. Confirmed.
- `deploy.sh` already applies `0002` via a hook **gated to `-- risk: additive` only** (regex refuses non-additive). So the deploy path can deliver additive DDL but explicitly **refuses** the one destructive migration that's stuck. This is the crux of Option B.
- Heartbeat/health already carries `schema_sig`, `disk_free`, `error_count` (grep hits in flows). Good — canary inputs mostly exist.
- procd runs Node-RED with `respawn 3600 5 -1`: 5 crashes/hour then **infinite** respawn. That is a silent crash-loop with no escalation — a field-robustness gap.
- Outbox drain is `... WHERE delivered_at IS NULL AND rejected_at IS NULL ORDER BY occurred_at ASC LIMIT 100`. No visible retention/prune of delivered rows. Matters at weeks-offline scale.

---

## 1. Design choices (the decisions that matter most)

### D1. Destructive-schema delivery to live Pis (Option B Stage 1) — **the top priority**
There is a merged farmer-facing bug fix (`0004`, #92) that **cannot reach the one production farm** because `deploy.sh` refuses non-additive migrations. This is the single highest-value, highest-risk decision.

- **Option A — Widen the existing deploy hook** to run the full runner (`lib/osi-migrate`) at deploy time with `writersStopped=true`: stop Node-RED, back up DB (backup.js exists), run ordered migrations through the ledger, restart. Reuses tested code.
- **Option B — Boot-time runner** (Node-RED invokes runner on startup before flows load). Rejected: puts destructive rebuilds on the crash-loop path (procd respawn), and a mid-rebuild power loss during boot is the worst possible timing.
- **Option C — Out-of-band one-shot repair script** per migration, hand-run per gateway. This is what happens de facto today (`ensure_*`, writable_schema surgery #93). Doesn't scale past ~10 gateways and is unauditable.

**Recommend A.** Deploy-time, writers-stopped, backup-first, ledger-recorded, with a **mandatory pre-flight `PRAGMA integrity_check` and a byte-verified backup that is fsync'd to a second path before the first destructive statement**. The runner already has the transactional guarantees; the missing pieces are (a) lifting the additive-only gate for ledger-driven migrations, (b) a restore-on-failure that the deploy script actually invokes, (c) rehearsal on an Uganda DB copy (already a stated gate — keep it). One-way-door caveat: the first destructive migration on the production farm is irreversible except via restore, so the backup+restore path must be tested *before* it runs, not after.

### D2. Fleet update model: atomicity + canary — **must land before fleet > ~10**
Today deploy is `curl deploy.sh | sh` over reverse SSH tunnel: not atomic, no health gate, no staged rollout. At 3 gateways a botched deploy is a phone call; at 100 it's a fleet outage.

- **Option A — A/B partition image swap (OpenWrt sysupgrade-style) for the OS, payload (flows/GUI/DB) staged+symlink-swapped.** Real rollback, but heavy to build and the payload (flows.json + DB migration) is where the actual risk lives, not the rootfs.
- **Option B — Keep single-slot OS, make the *payload* deploy atomic**: write new flows/GUI/DB to a staging dir, run migrations on a copy, health-probe, then symlink-flip + restart; on failed post-check, flip back. Cheapest path that covers the 90% risk.
- **Option C — Canary cohorts on heartbeat health**: mark 1–2 demo gateways as canary; a fleet rollout tool refuses to advance the cohort until canaries report N healthy heartbeats (schema_sig matches target, error_count flat, disk_free ok).

**Recommend B now, C next, defer A.** The DB migration and flows swap are the real one-way doors; rootfs A/B is gold-plating until you have an actual OTA image pipeline. Canary gating (C) is cheap because the heartbeat *already carries the signals* (schema_sig, error_count, disk_free) — it's a fleet-side consumer, not new edge code. Build the canary gate as an osi-server / operator-side check, not on the Pi.

### D3. Node-RED long-term role — **keep as runtime, extract modules; do NOT replace**
From an embedded-ops standpoint on a Pi 5 (plenty of RAM/CPU), Node-RED's footprint is a non-issue. Its real liabilities are (a) 1 MB of JS-in-JSON is undebuggable and un-unit-testable in the field, and (b) `require` outside the libs sandbox bricks a function node silently (#99).

- **Option A — Progressive replacement** (rewrite backend as a plain Node service). Rejected for a solo maintainer: throws away the working REST surface, the MQTT/ChirpStack wiring, and years of field-proven logic for a multi-month rewrite with no farmer-visible benefit.
- **Option B — Strangler extraction** (the on-table proposal): 45–76 KB nodes become `require`d modules with `node --test`, function nodes become thin adapters. Endorse, with a hard rule below.
- **Option C — Status quo.** Rejected: the FROZEN 72 KB sync-init node and 76 KB History Router are exactly the nodes you can't safely touch *because* they're untested inline blobs.

**Recommend B.** But the on-table version under-specifies the failure mode I care about most: **module-load must be a single choke point with fail-visible quarantine, not silent brick.** Concretely — one `osi-lib` loader that catches load failures, sets a health flag (surfaced in heartbeat error_count / a `libs_ok` field), and makes the affected route return a defined 503 instead of a dead node. Fix #99 (bare require) as a *precondition* of any extraction, not as a follow-up.

### D4. Narrow-waist ingest (generic channel writer) — **endorse the writer, be skeptical of the manifest-as-config leap**
The `normalize(decoded, meta) → {channels}` + one manifest-driven writer is the right shape and there's already `web/react-gui/src/channels/channels.json` + `verify-channel-manifest-parity.js` — the manifest exists and is CI-checked. Good.

- **Trade-off I'd flag:** a single generic writer that maps channels→columns from a manifest is powerful but becomes a **new load-bearing schema-coupling surface**. A wrong manifest entry silently writes to the wrong column across *all* devices, not one. Under farm-data-safety, that's a worse blast radius than the current per-device SQL builders.
- **Recommend:** ship the generic writer, but keep it **append-only to `device_data` with a manifest→column allowlist validated at CI against the actual DB schema** (extend `verify-channel-manifest-parity` to assert every channel maps to a real, correctly-typed column). MClimate as the pilot is correct — it's a new device, so a bug can't regress a live one. Do **not** retrofit the existing 4 device tabs onto the new writer until MClimate has run in the field for a full season (convert-on-touch, never big-bang — agreeing with the strangler principle, applying it here too).

### D5. Field robustness baseline — **crash-loop escalation + SD durability + time integrity are underweighted**
These are in the "General" bucket of the proposals but I'd promote three to first-class, because they're the failure modes that lose a farm silently:

- **Crash-loop escalation:** `respawn 3600 5 -1` retries forever with no signal. A gateway stuck restarting looks "alive" (SSH up) but serves nothing. Add: after N respawns, emit a distinct heartbeat health state and a local persistent flag; don't rely on the operator noticing missing telemetry.
- **Actuator safety (valve stuck open = crop damage + water loss):** verify there is a **hardware/independent max-open failsafe** for STREGA/MClimate that does not depend on Node-RED being alive. Node-RED sends `OPEN_FOR_DURATION` (never bare CLOSE), which is good *if* Node-RED runs — but if Node-RED crash-loops right after an open command, nothing re-closes. The duration-based valve firmware is the failsafe; **confirm every actuator integration is duration-bounded at the device, never a stateful open-until-told-close.** Make this a `verify-command-safety` CI assertion for any new actuator (it exists — extend it to MClimate).
- **Time integrity without NTP:** weeks-offline + clock jump breaks scheduler and `occurred_at ASC` outbox ordering. Add timestamp sanity (reject future-dated, clamp implausible) and define scheduler behavior on backward jumps *before* Uganda (production) hits it.

### D6. Offline backlog replay (weeks-offline → reconnect) — **the outbox drain is O(backlog) and unbounded**
Outbox drains `LIMIT 100 ORDER BY occurred_at ASC` with no retention on delivered rows. Weeks offline = tens of thousands of rows; on reconnect the Pi replays in 100-row sips while continuing to generate new events, and the table grows unbounded on SD.

- **Recommend:** (a) prune/archive `delivered_at IS NOT NULL` rows on a schedule (cheap, big SD-durability win); (b) size-cap the outbox with a defined drop/aggregate policy for the oldest low-value rows (telemetry can be downsampled; irrigation_events must never drop); (c) make reconnect drain rate-adaptive. Idempotency on the cloud side (SyncInbox dedup via event_uuid — the repos have `SyncInboxRepository`/`SyncCursor`) must be confirmed to tolerate replay of already-delivered UUIDs so a backlog re-send is safe.

---

## 2. Phasing (≈4–6 months; each phase ships and is strictly safer)

**Phase 0 — Preconditions & safety net (2–3 wks). Ship: nothing farmer-visible; unblocks everything.**
- Fix #99 bare-require → single `osi-lib` loader with fail-visible quarantine. dep: none. **M**
- Add crash-loop escalation health state to heartbeat + persistent flag. dep: none. **S**
- Extend `verify-command-safety` to assert every actuator is duration-bounded (incl. MClimate stub). dep: none. **S**
- Rehearse `0004` destructive migration + backup/restore on an Uganda DB copy (no live touch). dep: backup.js. **M**
- Confirm cloud SyncInbox idempotency tolerates duplicate event_uuid replay (test, not prod). dep: none. **S**

**Phase 1 — Option B Stage 1: destructive delivery + canary (3–4 wks). Ship: #92 fix reaches production; fleet gains a real update gate.**
- Deploy-time runner invocation, writers-stopped, backup-first, integrity_check pre-flight, restore-on-failure. dep: P0 rehearsal. **L**
- Lift additive-only deploy gate for ledger-driven migrations (keep gate for ad-hoc SQL). dep: above. **S**
- Canary gate (operator/server-side): refuse fleet advance until canary heartbeats healthy (schema_sig=target, error_count flat, disk_free ok). dep: heartbeat fields (exist). **M**
- Deliver `0004` to a demo gateway → canary hold → Uganda. dep: all above. **M**

**Phase 2 — Payload deploy atomicity + SD/offline durability (3–4 wks). Ship: safe, reversible deploys; outbox no longer grows unbounded.**
- Staged payload deploy: stage flows/GUI, migrate DB copy, health-probe, symlink-flip, rollback on failed post-check. dep: P1 runner. **L**
- Outbox retention/prune of delivered rows + size cap with per-aggregate drop policy (never drop irrigation_events). dep: none. **M**
- SD integrity check + `disk_free` alarm threshold in heartbeat (field exists; add the gate). dep: none. **S**
- Time-integrity guards: timestamp sanity clamp + defined scheduler behavior on clock jump. dep: none. **M**

**Phase 3 — Narrow-waist ingest, piloted on MClimate (4–5 wks). Ship: adding device #7 is a codec + normalize module + manifest row, CI-verified.**
- Generic manifest-driven `device_data` writer (append-only, allowlist). dep: manifest (exists). **L**
- `verify-device-integration.js` — 8-step checklist → CI, incl. manifest→column type check. dep: writer. **M**
- MClimate T-Valve (#18) as first device fully through the narrow waist. dep: writer + verifier. **L**
- Per-gateway UCI feature flags (enable a device/behavior per gateway). dep: none. **M**

**Phase 4 — Strangler extraction of the giant nodes (ongoing, convert-on-touch). Ship: each touched node becomes tested; no big-bang.**
- Extract History API Router (76 KB) → `node --test` module, node becomes adapter. dep: P0 loader. **L**
- Extract Daily Dendrometer Analytics (57 KB), Zone Env Summary (67 KB) as touched. dep: loader. **M each**
- FROZEN sync-init node: extract **read-path only**; leave DDL boot logic until Option B Stage 2 removes it. dep: P1+P2 proven in field. **L**

**Phase 5 (stretch) — Option B Stage 2: remove boot-node DDL.** Only after every live gateway's schema_sig matches canonical for a sustained window. dep: whole program. **M**

---

## 3. Risks & failure modes (what kills this program)

- **One-way doors:** (1) first destructive migration on the production farm — irreversible without a *proven* restore; rehearse on an Uganda copy first. (2) Retrofitting existing device tabs onto the generic writer — a manifest bug regresses live devices; don't, until MClimate proves it. (3) Removing boot-node DDL (Stage 2) — if any gateway is on the wrong schema, it silently breaks; gate on schema_sig convergence.
- **Silent bricking:** module-load failure that yields a dead node with no signal (#99). This is the failure that turns an "improvement" into a field outage. Fix the loader *first*.
- **Crash-loop invisibility:** procd infinite respawn means a broken gateway can look alive. Escalation state is cheap insurance.
- **Backlog thundering herd:** if 100 gateways reconnect after a regional outage and all replay outboxes at once, the 4 GB / 4 CPU VPS is the bottleneck, not the Pis. Cloud-side ingest must be rate-limited and idempotent before fleet growth.
- **Rehearse before prod:** destructive migration + restore on Uganda DB copy; staged payload rollback; canary hold/advance logic; outbox replay of a synthetic weeks-long backlog against a test server.
- **Solo-maintainer risk:** every phase must leave the tree shippable and each destructive step must be scriptable + rehearsable, because there's no second pair of eyes at 2 a.m. when Uganda's valve is stuck.

## 4. Explicit YAGNI list (don't build this at 3→100 gateways)
- **Full A/B OpenWrt image OTA with dual rootfs.** Payload atomicity covers the real risk; rootfs swap is months of work for the rare case. Revisit at ~100 gateways or when kernel/driver updates become routine.
- **Plugin registry / dynamic device loading.** ADR already says no; the manifest + static codec bundle is sufficient and safer. No second-party candidate exists.
- **Shared SQLite↔Postgres DDL codegen / YAML-DSL.** Already rejected; versioned sync contracts are the right seam. Don't reopen.
- **MQTT command channel (cloud→edge).** REST polling is intentional and offline-tolerant; a broker subscription adds an online dependency and a security surface for no field benefit at this scale.
- **Message queue / Kafka for sync.** SQLite outbox + REST batch is correct for weeks-offline replay; a broker doesn't survive being offline for weeks anyway.
- **Per-gateway config server / remote fleet management console.** UCI flags + heartbeat + canary gate cover 100 gateways. A management UI is post-100.
- **Node-RED replacement.** Covered in D3 — strangler, not rewrite.
- **Real-time streaming telemetry / sub-minute cadence.** Irrigation is a slow process; 30 s events / 6 h bootstrap is already generous. Faster cadence just burns SD writes and VPS.

## 5. Performance & scale — where it breaks first, cheapest durable fix

- **First break is the cloud, not the edge.** At 10× the 4 GB / 4 CPU VPS (already made unresponsive by on-host Docker builds) is the bottleneck for sync ingest + bootstrap snapshots. **Cheapest durable fix:** move Docker image builds off-host (CI/registry, pull-only on VPS) and rate-limit/idempotency-harden SyncInbox before adding gateways. This survives to 100×.
- **Bootstrap snapshot every 6 h × N gateways** is O(N × snapshot size) on the VPS. At 100 gateways full snapshots will saturate the small VPS. **Fix:** make bootstrap incremental / cursor-based (SyncCursor exists) so steady state is events-only; full snapshot only on cursor gap. Survives 100×.
- **Edge outbox unbounded growth on SD** (no delivered-row retention) is the first *edge* break under long offline periods — SD exhaustion + slow drain. **Fix:** retention/prune + size cap (Phase 2). Cheap and permanent.
- **Reconnect stampede** after a regional outage: 100 gateways draining simultaneously. **Fix:** server-side per-gateway rate limit + jittered edge drain start. Cheap, essential before growth.
- **`flows.json` boot time** grows with node count; at 1 MB it's already the slowest single artifact to parse on boot, and every destructive-boot-DDL run compounds it. Extracting the giant nodes (Phase 4) and removing boot DDL (Phase 5) directly cut cold-boot time — matters after power loss when you want the gateway back fast.
- **Not a bottleneck at any realistic scale:** Pi 5 CPU/RAM for Node-RED, SQLite query throughput per gateway, LoRaWAN uplink rate. Don't spend here.

---
**Bottom line:** the program's center of gravity should be **destructive-migration delivery + canary gating (Phases 0–1)** — it's the only thing blocking a merged farmer bug fix from the one production farm, and it's the capability the whole fleet-growth story depends on. The ingest narrow-waist and strangler extraction are correct but are *productivity* wins; do them after the *safety* path (delivery, atomicity, crash-loop/valve failsafe, outbox durability) is proven in the field. Fix the silent-brick loader (#99) before any extraction, and never retrofit live device tabs onto the generic writer until MClimate has survived a season.
