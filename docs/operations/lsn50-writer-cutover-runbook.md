# LSN50 Writer Cutover Runbook — Narrow-Waist Writer Goes Live on LSN50

**Status: NOT READY — GATED.** This runbook must NOT be executed until the DD7 shadow-parity evidence bar (§2) is met on the target gateway. It is written now so the gate criteria and the exact cutover/rollback procedure are agreed and reviewable *before* the evidence exists, not improvised under time pressure when it does.
**Refactor-program item:** 4.1 (DD7 evidence bar + DD8 single temporary kill-switch + DD17 unchanged). Depends on: item 3.1/3.2/3.3 merged (the `osi-device-writer`, `verify-device-integration.js` gate, LSN50 normalizer, and `lsn50_shadow_diff` shadow node all shipped) and item 0.2 (the deploy canary gate, `scripts/deploy-canary-gate.js`).
**Scope:** osi-os edge, live gateways, demos → production. **This runbook is live-ops execution — it is documented here but executed only per `.claude/skills/osi-live-ops-runbook/SKILL.md` conventions (backups, SSH safety, never reseed `/data/db/farming.db`).**

## What this runbook does (and does not)

**Does:** flip LSN50 uplink persistence from the legacy hand-written `lsn50-sql-fn` string-builder to the manifest-driven `osi-device-writer` (the narrow waist), on ONE gateway at a time, guarded by a single temporary UCI kill-switch and verified by the canary gate after each deploy. Demos first, then production (Uganda), convert-on-touch for the rest of the fleet.

**Does NOT:** change the writer's logic (that shipped in 3.1), migrate any other device onto the writer (convert-on-touch, DD7), or touch osi-server. It also does not run until §2's bar is objectively met — this is a promotion, not a rollout of unproven code.

## 1. Preconditions (ALL must hold before starting)

- [ ] Items 3.1/3.2/3.3 merged to `main` and deployed to the target gateway in shadow mode (old `lsn50-sql-fn` writes; `LSN50 Shadow Compare` computes + diffs into `lsn50_shadow_diff`; the writer does NOT yet persist LSN50 rows).
- [ ] Item 0.2's `scripts/deploy-canary-gate.js` is available and the gateway reports heartbeats the gate can read (schema_sig, disk_free_pct, errors_total).
- [ ] `verify-device-integration.js` is green on `main` for LSN50 (the round-trip gate proves the writer produces exactly the manifest columns).
- [ ] A pre-cutover backup of `/data/db/farming.db` taken per `osi-live-ops-runbook` (`.backup` dot-command, integrity-checked) — cutover changes which node writes, not the schema, but a backup is mandatory before any live flows change.

## 2. The DD7 evidence bar (LAW — consumed verbatim, do not soften)

The cutover may proceed on a gateway **only when, on that gateway:**

> **≥ 14 days OR ≥ 500 live LSN50 uplinks per gateway, with ZERO row diffs and ZERO dead-letters** in the shadow window.

Evaluated from `lsn50_shadow_diff` (the 3.3 shadow table) and `ingest_quarantine`:

- [ ] **Uplink/time bar:** either the earliest `observed_at` in `lsn50_shadow_diff` is ≥ 14 days ago, OR the count of distinct LSN50 uplinks compared is ≥ 500 (per gateway). Whichever comes first satisfies the bar.
- [ ] **Zero row diffs:** `SELECT COUNT(*) FROM lsn50_shadow_diff WHERE diff_kind != 'zero_diff'` returns **0**. Any non-zero-diff row is a discrepancy between the old path and the writer — the cutover is BLOCKED until it is root-caused (usually a missing manifest row, per spec §D — which means item 3.3 was incomplete and must be fixed and re-shadowed, not worked around here).
- [ ] **Zero dead-letters:** `SELECT COUNT(*) FROM ingest_quarantine WHERE deveui IN (<the gateway's LSN50 EUIs>) AND received_at >= <shadow window start>` returns **0**. Any LSN50 dead-letter during shadow means the writer would have quarantined a real reading — BLOCKED until resolved.

**Order:** demos (kaba100, Silvan) must each clear the bar and be cut over and observed healthy **before** production (Uganda) is even evaluated. Rest of fleet: convert-on-touch only (next time a gateway is deployed for another reason), two writers coexisting is acceptable (DD7).

**If the bar is not met, STOP.** This is not a judgment call — a non-zero diff or dead-letter count is a hard block. Escalate a persistent diff to a code fix in 3.3's normalizer/manifest, re-shadow, re-measure. Do not hand-edit `lsn50_shadow_diff` to pass the bar.

## 3. The temporary UCI kill-switch (DD8 — ONE switch, named, deleted after convergence)

**Name:** `osi-server.ingest.lsn50_writer` (UCI). Values: `shadow` (default; old path writes, writer shadows — the pre-cutover state) | `live` (writer persists LSN50, old `lsn50-sql-fn` disabled) | absent/unset ≡ `shadow`.

- The `LSN50` ingest branch in `flows.json` reads this UCI value once at flow-start (via the existing UCI→env mechanism; see `osi-config-and-flags`) and routes the uplink to either `lsn50-sql-fn` (shadow) or the writer-live node (live). Exactly one of the two persists per uplink — never both, never neither.
- This is the **only** flag introduced by the whole narrow-waist program (DD8: no flag framework). It exists solely to make the cutover reversible on a live gateway without a redeploy, and to make the rollback in §5 a one-command operation.
- **Deletion is a mandatory step (§6), not optional.** Once the fleet has converged (all touched gateways on `live`, sustained-healthy window passed), the kill-switch and its dual-path routing are removed in a follow-up PR — the writer-live path becomes the sole LSN50 path. Consumed-or-deleted (ownership ADR).

## 4. Cutover procedure (per gateway, demos first)

Run per `osi-live-ops-runbook` (SSH safety, backup, never reseed the DB). For each gateway in order [kaba100, Silvan, … Uganda last]:

- [ ] **4.1** Confirm §2's bar is met on THIS gateway (re-query `lsn50_shadow_diff` + `ingest_quarantine` live; do not trust a stale check).
- [ ] **4.2** Take the pre-cutover backup (§1 last bullet) if not already fresh.
- [ ] **4.3** Set the kill-switch live: `uci set osi-server.ingest.lsn50_writer='live'; uci commit osi-server`, then restart Node-RED (`/etc/init.d/node-red restart`) so the flow re-reads it. (The flows code + writer are already deployed from the 3.1 merge; this deploy is config-only — no new flows.json ships here unless a fix from a blocked diff required it.)
- [ ] **4.4** **Canary gate verification (item 0.2, mandatory after each cutover deploy):** run `scripts/deploy-canary-gate.js` against this gateway's EUI with `--since <cutover-ts>`. It must return exit 0 (PASS): 5 consecutive healthy heartbeats, `errors_total` flat (a writer fault would raise it), disk OK, no failure reasons. **Do not advance to the next gateway until the gate passes.** Exit 1/2 → treat as FAIL → roll back (§5).
- [ ] **4.5** Post-cutover spot-check (in addition to the canary gate): fresh LSN50 rows appear in `device_data` with the expected columns; `ingest_quarantine` gains no new LSN50 rows; `error_counts.total` did not jump. Observe for the gateway's defined healthy window before the next gateway.
- [ ] **4.6** Repeat 4.1–4.5 for the next gateway. **Uganda (production) only after both demos are cut over and healthy** — and Uganda's cutover rides inside its own #87 catch-up window per that runbook, with the canary gate as the final go/no-go.

## 5. Rollback (one command, always available while the kill-switch exists)

If the canary gate fails (4.4), `ingest_quarantine` gains LSN50 rows, `error_counts` climbs, or `device_data` LSN50 writes stop/malform on a live gateway:

- [ ] **5.1** `uci set osi-server.ingest.lsn50_writer='shadow'; uci commit osi-server`; restart Node-RED. The old `lsn50-sql-fn` immediately resumes as the sole LSN50 writer; the writer returns to shadow. **No data is lost** — the old path is byte-for-byte what it was pre-cutover, and shadow mode never persisted, so there is no divergent state to reconcile.
- [ ] **5.2** Confirm LSN50 rows resume in `device_data` and the canary gate goes green in shadow.
- [ ] **5.3** Root-cause the failure against `lsn50_shadow_diff` / `ingest_quarantine` / `error_counts`. A live failure after a green shadow window means the shadow window missed a payload variant — extend the golden vectors / manifest in 3.1/3.3, re-shadow, re-measure §2's bar before re-attempting. Do NOT re-flip to `live` without a fix + a fresh clean shadow window.

Because rollback is a UCI flip (no redeploy, no schema change, no data migration), it is safe to invoke at any hour on any gateway — the reason the kill-switch exists.

## 6. Convergence + kill-switch deletion (closes the item)

- [ ] **6.1** All intended gateways (both demos + Uganda; rest convert-on-touch) on `live`, each with a sustained healthy window (canary-gate-green, zero new LSN50 dead-letters, `device_data` LSN50 writes nominal) — the fleet-convergence condition.
- [ ] **6.2** Follow-up PR (osi-os): remove the `osi-server.ingest.lsn50_writer` UCI knob, the dual-path routing in `flows.json` (the writer-live node becomes the sole LSN50 persistence path), the now-dead `lsn50-sql-fn` node, and — once no longer needed for evidence — optionally retire the `LSN50 Shadow Compare` node + `lsn50_shadow_diff` table (or keep the table as a historical record; decide at PR time). This deletion is the DD8 "deleted after convergence" clause and the consumed-or-deleted invariant.
- [ ] **6.3** Update `docs/architecture/refactor-program-2026.md` Phase 4 row 4.1 with the outcome (dates + PR links per gateway).

## Cross-references

- DD7 evidence bar, DD8 kill-switch, DD17 actuator safety: `docs/architecture/refactor-program-2026.md`.
- Writer / shadow / round-trip gate design: `docs/superpowers/specs/2026-07-08-mclimate-narrow-waist-design.md` (§B writer, §D shadow, §F gate).
- Canary gate (0.2): `docs/superpowers/specs/2026-07-07-deploy-canary-gate-design.md`.
- Live-ops safety (backups, SSH, never-reseed): `.claude/skills/osi-live-ops-runbook/SKILL.md`.
- Config/kill-switch mechanics (UCI→env): `.claude/skills/osi-config-and-flags/SKILL.md` — the runner implementing this cutover MUST confirm the exact UCI namespace/key wiring there before adding `osi-server.ingest.lsn50_writer`; the name above is the intended contract, and its concrete UCI plumbing is a plan-time detail owned by item 3.3/4.1's flows change, not invented in this runbook.

## Honest caveats

- **This runbook cannot be validated end-to-end from documents** — its correctness depends on the 3.1/3.3 code shipping the kill-switch, the writer-live node, and the shadow table as specified. If those diverge from the spec at implementation time, this runbook's step 4.3/5.1 UCI names and node references must be reconciled to what actually shipped before first live use. Treat the UCI key name and node wiring as the intended contract, subject to a one-time reconciliation against the merged 3.1/3.3 PRs.
- **The bar is per-gateway and non-transferable:** a clean shadow window on kaba100 says nothing about Uganda's LSN50 payload variants. Each gateway clears §2 on its own evidence.
