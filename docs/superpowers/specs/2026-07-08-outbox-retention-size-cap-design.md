# `sync_outbox` Retention + Size Cap with Per-Aggregate Drop Policy

**Status:** Spec — refactor-program item **1.A5**, DD18. Track A (extraction guardrails / edge durability). No dependency on Option B.
**Scope:** osi-os edge only — extends the existing `prune-sync-outbox` Node-RED node + its `outbox-retention-tick` inject in both flows profiles. No schema change (no new columns, no triggers). No boot-node touch. No live gateway.
**Governs:** DD18 ("`sync_outbox` delivered-row pruning + size cap with per-aggregate drop policy; telemetry may downsample, `irrigation_events` never drop") and the "Where it breaks at scale" edge row ("`sync_outbox` unbounded on SD under weeks offline → 1.A5").
**Domain law:** `.claude/skills/osi-schema-change-control/SKILL.md`, `.claude/skills/osi-flows-json-editing/SKILL.md` (this is a flows.json function-node edit).

## Problem

`sync_outbox` accumulates one row per farm-state change (16 outbox triggers write it — enumerated in §B). Rows are marked `delivered_at` when the cloud acks them; undelivered rows survive across offline periods. On a weeks-offline gateway (the Uganda catch-up scenario) the table grows unbounded on the SD card. Refactor-program ground-truth item 9: "`sync_outbox` has no delivered-row pruning (unbounded SD growth under weeks-offline)."

**Verified correction to that framing (corrected-DD pattern):** delivered-row pruning **already exists**. There is a shipped `outbox-retention-tick` inject (daily `0 2 * * *`) → `prune-sync-outbox` function node that runs:
```
DELETE FROM sync_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?
```
with `? = now - OSI_OUTBOX_RETENTION_DAYS` (env, **default 30**, floored at 1). So the *delivered-row time-retention* half of 1.A5 is already live; what is genuinely missing is:
1. A **total-row size cap** — time-retention does nothing for a weeks-offline gateway whose rows are *undelivered* (never acked → never pruned). That is exactly the unbounded-growth failure mode DD18 names, and the current node cannot touch it.
2. A **per-aggregate drop policy** so the cap evicts only telemetry-class rows and never protected farm-command rows.

This spec adds those two to the existing node rather than building a new one — the retention-tick precedent is already the sanctioned place (the gateway-health plan explicitly modeled its own prune job on "the `outbox-retention-tick` → `Prune Sync Outbox` precedent").

**Note on the Fable pre-ruling's "default 7 days":** the pre-ruling specified pruning `delivered_at IS NOT NULL` after N days (default 7). The shipped node already does exactly this delete with **default 30** (`OSI_OUTBOX_RETENTION_DAYS`). Lowering the live default from 30→7 is a behavior change to a shipped, deployed retention window with no farm-data upside (delivered rows are already safely in the cloud; 30 days of delivered-row backlog is bounded and harmless). **Decision: keep the existing `OSI_OUTBOX_RETENTION_DAYS` default at 30 for the delivered-row time-prune (no change to shipped behavior), and introduce the size cap as the mechanism that actually bounds the weeks-offline undelivered growth the pre-ruling was reaching for.** The pre-ruling's intent — bound the table, protect farm data — is fully served by the size cap; the "7" was a number for a delete that already ships at 30. This is flagged as a FABLE-DECISION for confirmation (§ Open decisions), and is the only contested number.

## Goal

Extend `prune-sync-outbox` (both flows profiles, byte-identical) so that, after the existing delivered-row time-prune, it enforces a **total-row size cap** by evicting **oldest telemetry-class rows only**, never protected rows, and — if protected rows alone exceed the cap — does NOT evict but surfaces the condition via `node.error` (Node-RED log + the `error_counts` global context, through the sanctioned catch→`record-error-fn` path; remote heartbeat visibility depends on item 0.2 — §D) and keeps accepting writes. Two env-overridable numbers; the aggregate classification derived from the actual trigger set.

## A. The two knobs (both env-overridable, justified)

| Knob | Env | Default | Justification |
|---|---|---|---|
| Delivered-row time-retention (existing) | `OSI_OUTBOX_RETENTION_DAYS` | **30** (unchanged) | Delivered rows are already in the cloud; 30 days of acked backlog is bounded and gives operators a forensic window. Not lowered — see Problem note. |
| Total-row size cap (new) | `OSI_OUTBOX_MAX_ROWS` | **50000** | A weeks-offline gateway at the fleet's telemetry cadence (~1-min device_data per active sensor + rollups) reaches tens of thousands of undelivered rows over weeks; 50k rows of outbox JSON is on the order of tens of MB — bounded on the SD, far below disk exhaustion, and large enough that a gateway offline for a normal reconnect window (days) never trips it. The cap only bites during genuinely pathological offline duration, which is precisely when disk protection matters. |

Both parsed with the shipped node's exact idiom (`parseInt(String(env.get(...) || 'default').trim(), 10)`, floored/validated). `OSI_OUTBOX_MAX_ROWS` floored at a sane minimum (e.g. 1000) so a mis-set tiny value can't evict aggressively.

## B. Aggregate classification (derived from the trigger set — the drop policy's spine)

Verified from `database/seed-blank.sql`: **seventeen** `INSERT INTO sync_outbox` trigger bodies (one, `trg_sync_irrigation_events_uuid_ai`, inserts via `INSERT … SELECT` rather than `VALUES`) write **eleven distinct `aggregate_type` literals**. Several triggers emit multiple `op` values via a `CASE` (e.g. `ZONE` → `ZONE_UPSERTED`/`ZONE_CONFIG_UPSERTED`/`ZONE_LOCATION_UPSERTED`/`ZONE_DELETED`; `DEVICE` → `DEVICE_ASSIGNED`/`DEVICE_UNASSIGNED`/`DEVICE_UNCLAIMED`/`DEVICE_FLAGS_UPDATED`). **Classification is by `aggregate_type` only** (the `op` variants below are illustrative, not exhaustive), so multi-op triggers do not affect the policy:

**TELEMETRY-CLASS — evictable oldest-first under the cap** (high-volume append aggregates; re-derivable from source tables or acceptably lossy as historical telemetry):
- `DEVICE_DATA` (`DEVICE_DATA_APPENDED`) — the highest-volume aggregate; one row per sensor uplink.
- `CHAMELEON_READING` (`CHAMELEON_READING_APPENDED`).
- `DENDRO_READING` (`DENDRO_READING_APPENDED`).
- `DENDRO_DAILY` (`DENDRO_DAILY_UPSERTED`) — daily rollup; upserted, so latest state re-emits.
- `ZONE_ENVIRONMENT` (`ZONE_ENVIRONMENT_APPENDED`).
- `ZONE_RECOMMENDATION` (`ZONE_RECOMMENDATION_UPSERTED`) — upserted rollup.

**PROTECTED-CLASS — NEVER evicted** (farm-command / structural aggregates; dropping one is permanent farm-data or control loss — DD18: "`irrigation_events` never drop"):
- `IRRIGATION_EVENT` (`IRRIGATION_EVENT_APPENDED`) — the DD18-named never-drop aggregate; actuation history.
- `SCHEDULE` (`SCHEDULE_UPSERTED`) — irrigation schedules.
- `ZONE` (multi-op: `ZONE_UPSERTED`/`ZONE_CONFIG_UPSERTED`/`ZONE_LOCATION_UPSERTED`/`ZONE_DELETED`) — zone lifecycle/config.
- `DEVICE` (multi-op: `DEVICE_ASSIGNED`/`DEVICE_UNASSIGNED`/`DEVICE_UNCLAIMED`/`DEVICE_FLAGS_UPDATED`) — device lifecycle.
- `GATEWAY_LOCATION` (`GATEWAY_LOCATION_UPSERTED`) — low-volume, structural; not telemetry.

The classification lives as two explicit `Set`s of `aggregate_type` literals in the node (a named allowlist/denylist, not a heuristic — matching the Stage 0 §D(b) "named entries, not a general rule" bias). If a future outbox trigger adds a new `aggregate_type`, it defaults to **PROTECTED** (fail-safe: an unclassified aggregate is never silently evicted). A CI guard (§E) asserts the node's two sets partition exactly the trigger set's `aggregate_type` literals, so a new trigger forces an explicit classification decision rather than silently landing in PROTECTED-by-default forever.

## C. The cap algorithm (in the node, after the existing delivered-prune)

Runs on the same daily tick, after the delivered-row time-prune, all in the one `_db` connection the node already opens:

1. `total = SELECT COUNT(*) FROM sync_outbox`. If `total <= MAX_ROWS` → done (status: within cap).
2. `overBy = total - MAX_ROWS`.
3. `evictable = SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type IN (<telemetry set>)`.
   - **Prefer already-delivered telemetry first:** evict oldest `delivered_at IS NOT NULL` telemetry rows before undelivered ones — an already-acked telemetry row is the safest possible eviction (the cloud has it). Only if delivered telemetry is exhausted does it evict undelivered telemetry (older telemetry is the acceptable loss per DD18's "telemetry may downsample").
4. Evict `min(overBy, evictable)` oldest telemetry rows by `occurred_at` (the trigger's timestamp), delivered-first, protected rows untouched:
   ```
   DELETE FROM sync_outbox
   WHERE event_uuid IN (
     SELECT event_uuid FROM sync_outbox
     WHERE aggregate_type IN (<telemetry set>)
     ORDER BY (delivered_at IS NULL), occurred_at   -- delivered (0) before undelivered (1); oldest first
     LIMIT ?                                          -- min(overBy, evictable)
   )
   ```
   (Subquery-by-`event_uuid` PK, not a bare `LIMIT` on the delete, so the ordering is well-defined and the PK index drives it.)
5. **If protected rows alone still exceed the cap** (`total - evicted > MAX_ROWS` because the remainder is all protected): **DO NOT evict any protected row.** Instead:
   - Surface via `node.error('outbox size cap exceeded by protected rows: <n> protected > cap <MAX_ROWS>', msg)` — this reaches the Node-RED log AND, via the global "Catch unhandled errors" catch node → `record-error-fn`, bumps the `error_counts` global context (§D). Remote heartbeat visibility of this is gated on item 0.2; today it is log + global context. No direct `global.set('error_counts', …)` (that key is owned by `record-error-fn`).
   - **Keep accepting writes** — do nothing destructive. Rationale (Fable pre-ruling, restated): disk exhaustion is slower and recoverable; evicting an `irrigation_events`/schedule row is permanent, unrecoverable farm-data loss. A bounded-but-over-cap protected backlog on a weeks-offline gateway is a *loud operational signal*, not a reason to destroy farm records. The cap protects against telemetry runaway; it must never become a farm-data shredder.
6. Status + `msg.payload` report: total before/after, delivered-pruned count, evicted-telemetry count, protected-over-cap flag. Follows the existing node's `node.status({...})` + `msg.payload = {...}` + `PRAGMA wal_checkpoint(TRUNCATE)` (only when rows were actually deleted) shape.

## D. Surfacing the protected-over-cap condition (corrected — verified against current main)

**Correction (the review caught a false premise in the draft):** the heartbeat does **not** carry `error_counts` today. `Build Heartbeat` (node `062a0f9bf66d9789`) reads `global.get('edge_health')`, whose health object has exactly 7 keys (`schema_sig, sync_linked, sync_pending, sync_oldest_age_s, sync_rejected, sync_dirty_pending, disk_free_pct`) — `verify-heartbeat-health.js` `REQUIRED_HEALTH_KEYS` hard-gates that list; `Gather Edge Health` does not merge `error_counts`. So `global.set('error_counts', …)` reaches no heartbeat field on current main (corroborated by `docs/superpowers/specs/2026-07-07-deploy-canary-gate-design.md` and `AGENTS.md`: heartbeat surfacing of `error_counts` is intentionally deferred). Item **0.2 (deploy-canary-gate)** is the change that adds `errors_total`/`errors_last_at` to `Gather Edge Health` and bumps the required-keys list — and it has NOT landed.

**Corrected mechanism (two layers, honest about what's visible today):**
1. **On-device now (log + global context):** on the protected-over-cap branch the node calls `node.error(message, msg)` with `message = 'outbox size cap exceeded by protected rows: <n> protected > cap <MAX_ROWS>'`. This appears in the Node-RED log AND — because the global **"Catch unhandled errors"** catch node routes to `record-error-fn` — bumps `global.get('error_counts')` via the *sanctioned* path (the same node that owns `error_counts`), no direct-global write, no new wire. The counter is thus populated for whenever the heartbeat surface exists. `node.error` is de-duplicated by `record-error-fn`'s own 60s-per-message throttle (verified in its body), so a daily tick cannot inflate the counter.
2. **Remote when 0.2 lands (heartbeat):** once item 0.2 adds `errors_total` to `Gather Edge Health`, this condition becomes remotely visible with zero further change here — the counter is already being bumped. **This spec does NOT depend on 0.2 to be correct** (the cap's *safety behavior* — never evicting protected rows — is fully local); it depends on 0.2 only for *remote* visibility, and says so.

**Explicitly rejected:** a direct `global.set('error_counts', …)` in the cap node — it duplicates `record-error-fn`'s ownership of that key and risks races with the catch path; `node.error` through the existing catch→record path is the one sanctioned way to increment `error_counts`.

**Dependency stated:** remote (heartbeat/canary) visibility of the protected-over-cap signal is gated on item 0.2. Until then the signal is on-device log + `error_counts` global context. This is called out in the Non-goals and DoD.

## E. Tests (TDD guard, CI-wired)

A `node:test` guard (`scripts/test-outbox-retention.js`, wired into `.github/workflows/migrations.yml`) that, against the real seed schema (extract the node's SQL from `flows.json`, execute it via `node:sqlite` — the exact pattern `test-gateway-health-persistence.js` uses):
- **Delivered-prune unchanged:** old delivered rows past `OSI_OUTBOX_RETENTION_DAYS` still deleted; undelivered rows untouched by the time-prune.
- **Cap evicts oldest telemetry, delivered-first:** seed `MAX_ROWS + K` rows mixing telemetry (delivered + undelivered) and protected; assert exactly the oldest-delivered-then-oldest-undelivered telemetry rows are evicted, count drops to `MAX_ROWS`, and **zero protected rows deleted**.
- **Protected-over-cap:** seed `> MAX_ROWS` protected rows and few/no telemetry; assert **no protected row deleted**, total stays over cap, and the node calls `node.error` exactly once (the message names the protected-row overflow). The guard asserts the `node.error` call, not `error_counts` internals — the counter bump happens in `record-error-fn` via the catch path, whose `src` is derived from the error source, not a literal set by this node.
- **Aggregate-partition guard (§B):** assert the node's telemetry∪protected sets equal exactly the set of distinct `aggregate_type` literals across **all 17** `INSERT INTO sync_outbox` triggers extracted from `seed-blank.sql` (parse each trigger body — including the one `INSERT … SELECT` trigger — for its `aggregate_type` literal(s); a new trigger introducing a new `aggregate_type` fails CI until it is explicitly classified). This is the guard that makes "new trigger → forced classification decision" real rather than aspirational.
- **Both-profile parity:** the two `flows.json` copies' `prune-sync-outbox` node bodies are byte-identical (already covered by `verify-profile-parity.js`; the guard additionally extracts and compares the SQL).

## Non-goals

- No new schema/columns/triggers (the cap reads existing columns: `aggregate_type`, `delivered_at`, `occurred_at`, `event_uuid`).
- No change to the sync *delivery* logic (which rows get `delivered_at` set) — only retention.
- No downsampling/aggregation of telemetry rows before eviction (DD18 says "may downsample"; eviction of oldest is the v1 mechanism — a true downsample-then-drop is a heavier follow-up, not needed to bound the SD).
- No Uganda-specific work; the cap is fleet-general and helps the Uganda catch-up (item 2.1) by bounding pre-catch-up growth, but 2.1 owns that window.
- No lowering of `OSI_OUTBOX_RETENTION_DAYS` (see Problem note / Open decisions).
- **Not delivering heartbeat visibility of the protected-over-cap signal.** That requires item 0.2's `Gather Edge Health` change (adds `errors_total`). This spec bumps `error_counts` via the sanctioned catch→`record-error-fn` path so the signal is ready to surface the moment 0.2 lands, but does not modify `Gather Edge Health`/`Build Heartbeat` or `verify-heartbeat-health.js` here (§D).

## Definition of Done

- `prune-sync-outbox` extended in both `flows.json` profiles (byte-identical via the mandated `cp` mirror), edited via a one-shot Node script (never by hand), with the two `Set`s (telemetry + protected), the cap algorithm (§C), and the protected-over-cap `node.error` surfacing through the sanctioned catch→`record-error-fn` path (§D — no direct global write).
- `scripts/test-outbox-retention.js` (all §E cases) green and wired into `migrations.yml`.
- `verify-profile-parity.js`, `test-flows-wiring.js` (osiDb `.close(` + libs guard), `verify-sync-flow.js` all green.
- `docs/operations/edge-history-retention.md` gains a new operator section documenting both retention knobs (`OSI_OUTBOX_RETENTION_DAYS`, `OSI_OUTBOX_MAX_ROWS` — neither is documented there today) and the protected-over-cap signal (on-device log + `error_counts` now; heartbeat once item 0.2 lands). This is the one sanctioned existing-file edit besides the flows/CI/test files.
- No boot-node change, no schema change, no live gateway. Remote (heartbeat) visibility of the protected-over-cap signal is a **noted dependency on item 0.2**, not delivered here (§D).

## Open decisions

1. **`OSI_OUTBOX_RETENTION_DAYS` default (30 vs the pre-ruling's 7).** This spec keeps 30 (no change to shipped behavior; the size cap does the real bounding). Flagged as a FABLE-DECISION because it diverges from the pre-ruling's stated "7" — but the divergence is grounded in the verified fact that the delivered-row delete already ships at 30 and lowering it has no farm-data benefit. If Fable prefers 7, it is a one-line default change; the cap logic is unaffected either way.
