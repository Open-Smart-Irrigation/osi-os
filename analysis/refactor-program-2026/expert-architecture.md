# Expert Architecture Review — OSI Refactor Program

*Senior architect, incremental modernization / strangler-fig. 2026-07-07. Read-only verification against both repos.*

## Verified ground truth (corrects/sharpens the briefing)

- flows.json: **564 nodes, 232 function nodes, 1.017 MB of embedded JS**, 97 http-in, 74 sqlite. Top nodes confirmed (History API Router 74.5 KB, Sync Init 72.9 KB frozen, Zone Env Summary 65.9 KB, Daily Dendro 56 KB, Run Force Sync 44.6 KB).
- **The strangler already started and works.** `conf/.../node-red/osi-history-helper/` is a real extracted module (`index.js` 105 KB + `analysis.js` 18.7 KB), loaded from flows via **bare absolute `require('/usr/share/node-red/osi-history-sync-helper')`**. This IS the #99 brick risk and it is *already in production paths*, not hypothetical.
- **But the extraction contract is not enforced**: that helper has **no co-located `node --test` tests**. The pattern exists; the "done" definition does not.
- **`web/react-gui/src/channels/channels.json` is a mature channel manifest** (`key/unit/edgeField/serverField/legacyAliases/exportable/deprecated`) already CI-parity-checked by `scripts/verify-channel-manifest-parity.js` against the history helper. The narrow-waist writer's backbone already exists — this changes my recommendation.
- migrations `0001–0004` present, `0004` is the destructive rebuild awaiting delivery. `lib/osi-migrate` is well-tested (20+ `__tests__`). ~40 verifier scripts, 4 CI workflows.
- **osi-server has NO `.github/workflows`** — confirmed. This is the single largest program risk, not a nice-to-have.
- Dendro logic genuinely duplicated: edge `osi-history-helper/analysis.js` + `Daily Dendrometer Analytics` node vs server `prediction-service/app/engine.py`. Different algorithms, different languages.

The headline: **you are ~20% into the strangler already and don't have the guardrails that make the remaining 80% safe.** The right program is not "start extracting" — it's "ratchet what you started, then extend it."

---

## 1. Design choices (the decisions that matter)

### D1 — Extraction target: what a "seam module" is and how it loads
The bare absolute-path `require` is the immediate liability: any typo, missing file, or partial deploy silently bricks a function node, and there's no quarantine.

- **Option A** — keep bare `require`, add try/catch guards per call site. *Cheap, but every new node re-implements the guard; drift guaranteed.*
- **Option B** — one shared `osi-lib` loader module: single choke point, `functionGlobalContext`-injected at settings.js load, exposes `osiLib.require('history')` with quarantine (load failure → node emits a typed error + increments the existing `global.error_counts`, never throws into the flow). All seam modules resolve through it.
- **Option C** — proper `functionExternalModules` npm packages. *Rejected: OpenWrt image packaging + offline install friction, no upside over B for in-image code.*

**Recommend B.** It matches ADR-2026-05-28 (static, in-image, no hot-reload), reuses the already-wired error counter, and gives you the "single-choke-point with quarantine" the briefing asks for. **The loader is Phase 1, item 1 — it is a prerequisite for every subsequent extraction**, and it retires #99 as a side effect.

**"Done" per seam (make this a ratchet, not a vibe):** a seam is extracted when (1) logic lives in a pure module with `node --test` co-located and green in CI; (2) the function node is a thin adapter (< ~2 KB: unwrap `msg`, call, wrap result, guard); (3) a golden-vector test pins behavior *captured before* the extraction; (4) it loads via the D1 choke point. A `verify-seam-adapters.js` ratchet asserts adapters stay thin and modules keep tests.

### D2 — Ordering the flows.json extraction
Do **not** start with History API Router (76 KB) because it's biggest. Start where the test harness is cheapest and blast radius smallest.

- **Recommend order: (1) Daily Dendrometer Analytics → (2) Get Zone Environment Summary → (3) History API Router → last: Run Force Sync / Sync Init (frozen, touch only under Option B).**
- Rationale: dendro analytics is **pure compute** (input rows → output metrics), trivially golden-vector-testable, and extracting it lets you *converge the cross-repo duplication* (see D4). Zone Env is next-purest. History Router is HTTP-shaped (harder harness) so it comes after you've proven the pattern twice. The sync nodes are the frozen boot path — they move only inside Option B, never opportunistically.
- **Convert-on-touch is the governing rule, with one exception:** the 4 named seams get *scheduled* extraction because they will otherwise never be "touched." Everything else waits until a real change lands on it.

### D3 — Stopping the JSON-embedded-code regrowth (ratchets)
The repo already ratchets silent-catch and stray-DDL successfully; reuse that muscle.

- **Recommend three ratchets, baseline-file style (like `verify-no-stray-ddl-baseline.json`):**
  1. **Per-node size ceiling** — no function node may *grow*; new nodes cap at e.g. 4 KB. Baseline the current sizes; CI fails on regression. Forces big logic into modules.
  2. **Total-JS ratchet** — sum of embedded `func` chars may only decrease. This is the strangler's scoreboard (start: 1,017,468).
  3. **New-node-must-be-thin** — any function node created after baseline must be an adapter (import + call), enforced by a simple heuristic (presence of `osiLib.require`, absence of SQL/DDL string literals over N chars).
- These convert "we should extract" from aspiration into a merge gate. **This is the highest-leverage, lowest-cost item in the whole program.**

### D4 — Cross-repo dendro/analytics duplication: contract, don't deduplicate
Tempting to "share one dendro implementation." **Reject.** Edge is offline-first JS-in-Node-RED computing *live* stress locally; server is Python computing *forecast/water-balance* over mirrored history. They have different inputs, latency, and failure semantics. Forcing one implementation couples two release cadences and breaks offline-first.

- **Recommend: deliberate duplication behind a shared *golden-vector contract*, not shared code.** Define canonical `(input fixture → expected dendro metric)` vectors in `docs/contracts/`; both repos run them in their own test frameworks. Divergence is then *detected*, not *prevented* — which is the correct goal for two systems that legitimately differ. This mirrors the codec golden-vector approach (#106) that already works.
- Naming drift (`swt_wm1` vs `swt_1`) is already handled by `channels.json legacyAliases`. **Make `channels.json` the single source of field-name truth for BOTH repos** — export it into osi-server's build so serverField is not hand-maintained. That's the one place dedup pays off.

### D5 — Narrow-waist ingest: interface shape
The proposal is directionally right and *already half-built* (channels.json + parity verifier). Critique of the interface:

- **Keep** `normalize(decoded, meta) → { channels: {key: value} }` pure, mirroring codecs. Good.
- **Fix the writer contract**: it must be **manifest-driven with a closed allow-list**. The generic writer accepts only keys present in `channels.json` (with `edgeField != null`); unknown keys go to a **dead-letter/quarantine**, never silently dropped and never auto-INSERTed (that's how you'd get schema surprises on a live Pi). This aligns with #89's dead-letter-unknown-ops instinct — apply the same discipline to ingest.
- **The verifier (`verify-device-integration.js`) must assert the round trip**, not just presence: for each device, `codec output → normalize → writer → row` produces the manifest-declared columns and nothing else. That turns the 8-step checklist into a CI gate honestly.
- **Reject** per-gateway UCI feature flags *for ingest* at this stage (see YAGNI). A device either has a normalizer in the image or it doesn't; there is no second consumer needing runtime toggling yet.
- **MClimate pilot validation**: build the normalizer + writer path for MClimate T-Valve (#18) *first, as the second consumer that justifies the abstraction*. Do NOT generalize the writer until MClimate proves the manifest covers an actuator with downlink state, not just a sensor. If MClimate needs a writer field the manifest can't express, that's the signal the abstraction is wrong — cheaper to learn now than after retrofitting 6 devices.

### D6 — osi-server test/CI foundation
No CI on a Spring Boot monolith that mirrors irreplaceable farm data is the program's biggest silent risk. Mockito-mocked repos with no test DB means sync-apply logic (the thing that writes the mirror) is effectively untested against real Postgres.

- **Recommend: Testcontainers Postgres for the sync inbox/apply path only** (not the whole app), plus a minimal GitHub Actions workflow (build + test + the cross-repo op-parity gate that currently only runs edge-side). The 4 GB VPS never builds; CI builds. Scope tightly — this is a foundation item, not a rewrite.

---

## 2. Phasing (≈4–6 months, each phase shippable + safer)

**Phase 0 — Deliver what's already merged (2–3 wk).** Nothing new; retire deployed-vs-merged drift.
- Deploy merged flows (error counter, contract_version) to the 2 demo gateways via canary → *dep: none · S*
- Option B **Stage 0**: canonicalize fleet schema, fold `ensure_*`/repair drift into seed+migrations, retire `writable_schema` surgery (#93) → *dep: none · L*
- Heartbeat canary gate: deploy blocks if post-deploy heartbeat health regresses → *dep: heartbeat #100 (done) · M*
- Uganda schema catch-up rehearsal on a **Uganda-copy** before touching prod (#87) → *dep: Stage 0 · M*

**Phase 1 — Extraction guardrails (3–4 wk). No behavior change.**
- `osi-lib` single-choke-point loader + quarantine; migrate history helper's bare require to it (kills #99) → *dep: none · M*
- Three ratchets: per-node size ceiling, total-JS scoreboard, new-node-thin → *dep: none · S*
- Backfill `node --test` for the *existing* `osi-history-helper` (pattern proof) → *dep: loader · M*
- osi-server minimal CI: build + test + op-parity gate → *dep: none · M*

**Phase 2 — Prove strangler on pure seams (4–5 wk).**
- Extract Daily Dendrometer Analytics → tested module + thin adapter → *dep: Ph1 · M*
- Dendro cross-repo golden-vector contract (detect divergence) → *dep: above · M*
- Extract Get Zone Environment Summary → *dep: Ph1 · L*
- `channels.json` becomes shared field-name truth for osi-server build → *dep: Ph1 CI · S*

**Phase 3 — Narrow-waist ingest via MClimate pilot (4–6 wk).**
- MClimate normalizer + generic manifest-driven writer w/ dead-letter, as the *second consumer* (#18) → *dep: Ph1 loader · L*
- `verify-device-integration.js` round-trip gate → *dep: writer · M*
- Migrate ONE existing device (LSN50) onto the writer to prove parity, keep others on old path → *dep: writer · M*

**Phase 4 — Option B completion + History Router (4–6 wk).**
- Option B Stage 1 (deploy-time runner invocation, writers stopped) → *dep: Ph0 Stage 0 · L*
- Deliver migration 0004 to live gateways via the new path (retires the destructive-delivery gap) → *dep: Stage 1 · M*
- Extract History API Router → tested module → *dep: Ph2 pattern · L*
- Option B Stage 2 (remove boot-node DDL) — **only after** two clean fleet deliveries → *dep: Stage 1 proven · M*

**Phase 5 — Durability/scale hygiene (ongoing, interleave).**
- SD-card integrity check + disk-free in heartbeat → *dep: none · M*
- Offline outbox-replay soak test (weeks-offline, clock jump) → *dep: none · M*
- Deploy atomicity (staged symlink swap) → *dep: canary gate · M*

Each phase leaves a shippable, strictly-safer system: Ph0 gives a delivery path, Ph1 stops regrowth + adds a net, Ph2/4 shrink the monolith, Ph3 makes devices cheap.

---

## 3. Risks & one-way doors

- **One-way door: Option B Stage 2 (removing boot DDL).** Once boot-node DDL is gone, a gateway that missed the runner is unrecoverable in the field. Do not cross until Stage 1 has cleanly delivered to *all* live gateways twice, and Uganda (the stale one) is caught up. Rehearse on Uganda-copy first.
- **One-way door: destructive migration 0004 on live data.** Backup-before + verified restore path is mandatory; the `lib/osi-migrate/backup.js` path must be exercised on a real Pi copy, not just in unit tests.
- **Behavior-change-during-refactor** is the classic killer here, and AI agents make it *more* likely (they "improve" while extracting). **Mandate: every extraction PR must be behavior-preserving, proven by golden vectors captured from the OLD node before extraction.** Any behavior change is a separate, later PR. Put this in the engineering playbook as a hard gate.
- **Abstraction-before-second-consumer** on the ingest writer: if you generalize before MClimate, you'll encode LSN50/S2120 assumptions. The pilot IS the risk control — don't skip it to "save time."
- **Big-bang temptation on History Router (76 KB, HTTP-shaped).** It will feel efficient to rewrite it wholesale. Forbid it; it's the node most likely to have undocumented edge-case behavior farmers depend on.
- **Rehearse before prod:** Stage 0 schema canonicalization, 0004 delivery, and Uganda catch-up all on a byte-copy of the target DB. Chaos rig (power-loss mid-migration) before Stage 2.
- **osi-server has no CI** — every mirror-side change is currently unverified. Treat Phase 1's CI item as blocking for any further server sync work.

---

## 4. Explicit YAGNI list

- **Plugin registry / dynamic device loading** — ADR-locked, no second party. The static in-image bundle is correct at this scale.
- **Shared SQLite↔Postgres DDL codegen / YAML DSL** — already rejected; the golden-vector contract gives the same safety without the coupling.
- **Per-gateway runtime feature flags for ingest** — no consumer needs runtime toggling; a device is in the image or not. (Keep flags only where already justified, e.g. health retention.)
- **Unifying edge+server dendro into one implementation** — different runtimes, different jobs, breaks offline-first. Contract, don't merge.
- **Full E2E test DB for the whole Spring monolith** — scope Testcontainers to the sync-apply path only; the rest stays Mockito.
- **Message queue / event bus for sync** — REST-poll + outbox scales fine to 100s of gateways (see §5); Kafka-shaped ambition is unwarranted.
- **Multi-tenant / multi-region cloud** — 3 gateways, one 4 GB VPS. Not now.
- **Hot-reload / OTA plugin delivery** — image-based deploy is the safety model; don't undermine it.

---

## 5. Performance & scale — where it breaks first at 10× / 100×

- **First break (~10×, 30 gateways): the 4 GB VPS ingest, not the edge.** 30 gateways each REST-posting events every 30 s + 6 h bootstrap snapshots against an untested Spring app on 4 CPU / 4 GB. **Cheapest durable fix:** the CI'd sync-apply path (Ph1) + a bootstrap-snapshot backoff/jitter so 100 gateways don't sync in lockstep. Batch inbox apply. No new infra.
- **Second break (~100×): bootstrap snapshot cost.** "Full snapshot every 6 h" × 100 gateways is the thundering-herd. Fix: make bootstrap *incremental/on-demand* (only when the event stream shows a gap), driven by the sync_version watermark you already have. Cheap, survives 100s.
- **Edge scales fine** — each gateway is independent, SQLite is local, offline-first means no fan-in on the edge. The 1 MB flows.json is a *maintainability* problem, not a runtime one; extraction doesn't change runtime cost.
- **Postgres mirror at 100 gateways:** partition/index the high-write mirror tables (`device_data`, `zone_environment`) by gateway+time; this is a schema decision to make *before* 100, cheap now, expensive later. Flyway-owned, no cross-repo impact.
- **Deploy at 100 gateways:** manual `python3 -m http.server` + per-Pi ssh doesn't scale past ~10. The canary-gated atomic deploy (Ph5) is the seed of fleet rollout; that's the right place to invest, not a config-management platform.

---

## Bottom line

The program's real state is "strangler in progress without guardrails." Sequence it as: **deliver the backlog (Ph0) → build the net (Ph1: loader + ratchets + server CI) → prove the pattern on pure compute (Ph2) → make devices cheap via the MClimate pilot (Ph3) → finish Option B and the hard node (Ph4)**. The single highest-leverage item is the trio of ratchets in Phase 1 — they convert good intentions into merge gates, which is exactly what a solo maintainer driving AI agents needs. **Stop when**: flows.json total-JS is ratcheting down, the 4 named seams are extracted-and-tested, adding a device is a CI-gated round-trip, boot DDL is gone, and osi-server has CI. That is a good-enough end state; resist scaling ambition beyond it until a real second party or 10th gateway forces the next decision.
