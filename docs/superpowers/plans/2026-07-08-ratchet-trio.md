# Ratchet Trio — Node-Size Ceiling + Total-JS Scoreboard + Thin-Node Heuristic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution notes:** (1) work inside a feature branch `feat/ratchet-trio` (worktree recommended, not the root `main` checkout); (2) this item writes **no** `flows.json` changes — it only adds a verifier + its committed baseline + CI wiring, so the `osi-flows-json-editing` skill is *not* invoked here; (3) run every command from the repo/worktree root; (4) CI must stay green at every commit.
> **Spec-in-plan:** this is item **1.A2**, mode **direct** (`docs/architecture/refactor-program-2026.md` Phase 1 Track A). Per the batch charter, **DD3 is the spec** — this lean plan embeds the design inline (§Design below) rather than pointing at a separate spec doc, matching DD3's "baseline-file style, like the existing silent-catch/stray-DDL ratchets."
> **Charter:** `docs/architecture/refactor-program-2026.md` — DD3. This is the merge gate that converts the strangler extraction (items 2.2, 2.4, 4.2) from aspiration into enforcement. It has **no code dependency** on 1.A1 (the loader) — the thin-node heuristic *rewards* `osiLib.require` presence but does not require any node to have migrated (verified: 0 nodes reference `osiLib.require` on `main` @ `612987d9`).

**Goal:** Ship one CI verifier, `scripts/verify-flows-size-ratchet.js`, that enforces three ratchets against both maintained `flows.json` profiles, git-anchored to the base ref (default `origin/main`) exactly like `verify-no-stray-ddl.js`, with a committed documentation baseline (`scripts/verify-flows-size-ratchet-baseline.json`) for offline honesty:

1. **Per-node size ceiling** — no existing function node (keyed by node **id**) may grow beyond its base-ref `func` length **unless the growth is explicitly budgeted** (see §Growth allowance below); any function node **id not present in the base ref** (a newly added node) must be ≤ 4096 chars.
2. **Total-embedded-JS scoreboard** — the sum of every function node's `func` length, per profile, may only **decrease or stay equal** vs the base ref (the strangler's scoreboard). A PR that adds net JS (e.g. a new device integration node) must pair it with an extraction that removes at least as much — or use the growth-allowance mechanism.
3. **New-node-must-be-thin heuristic** — a newly added function node (id absent from the base ref) that exceeds a heuristic size floor must look like a thin adapter, not a re-embedded monolith: it must either declare+call `osiLib.require(...)` **or** contain no oversized SQL string literal (a literal ≥ `SQL_LITERAL_MAX` chars containing a DDL/DML keyword). A node that is both large-with-a-fat-SQL-literal and does not load through `osi-lib` is exactly the anti-pattern extraction exists to prevent, and fails.

### Growth allowance mechanism (Fable review CRITICAL 2026-07-10)

**Problem:** Rules 1 and 2 as originally stated **block items 3.1 (narrow-waist writer) and 5.6 (time integrity) as planned.** 3.1 adds new flow nodes + registry entries (net JS increase); 5.6 grows three existing nodes inline (timestamp clamp, scheduler guard, heartbeat fields). Neither downstream plan mentions the ratchet in its gates.

**Fix:** a committed `scripts/verify-flows-size-ratchet-allowances.json` file that explicitly budgets growth for specific nodes and total:

```json
{
  "_comment": "Explicit growth allowances. Each entry must cite the program item and justification. Consumed-or-deleted: remove the entry when the growth is offset by extraction.",
  "node_allowances": {
    "9b3afb405207302e": { "delta": 200, "reason": "5.6 timestamp clamp (3 lines)" },
    "cmd-type-registry": { "delta": 100, "reason": "3.1 UC512 registry entry" }
  },
  "total_allowance": { "delta": 500, "reason": "3.1 UC512 integration adds net JS; offset by 2.2 extraction in the same phase" }
}
```

The verifier checks: per-node growth ≤ base-ref size + any node-specific allowance; total ≤ base-ref total + total_allowance. An allowance is **consumed-or-deleted** (per the ADR invariant): the PR that uses the allowance must cite it; the next extraction that offsets the growth deletes the entry. This keeps the ratchet honest (it still catches accidental growth) while making planned, justified growth landable.

**Downstream plans must be updated** to cite the ratchet allowance in their gates when they add net JS. This is noted as a cross-item coordination item, not deferred.

Wired into `.github/workflows/migrations.yml`. Both profiles enforced. Zero `flows.json` edits.

**Architecture:** A single Node-only script following the `verify-no-stray-ddl.js` two-gate shape:
- **Gate 1 (the real enforcement, cannot be self-certified):** read each profile's `flows.json` at HEAD (off disk via `--root`) and at the base ref (via `git show <ref>:<path>`, `maxBuffer` bumped for the ~1.2 MB file), compare per-node-id ceilings, per-profile totals, and apply the thin-node rule to newly-added ids. Because the base is a git ref — not a committed file this PR could also edit — a PR cannot both grow a node and launder the growth by regenerating a committed baseline in the same commit (the exact hole `verify-no-stray-ddl` closed).
- **Gate 2 (documentation honesty, low stakes):** the committed baseline JSON must match HEAD's actual measured totals per profile, so the file stays a truthful offline snapshot; it does not gate on its own.

The scan logic (parse flows → per-id sizes, total, new-node classification, thin-node test) lives in a **requireable pure module** so the mandated test vectors import it without running the CLI, mirroring `flows-bare-require-scan.js`'s separation in the 1.A1 plan.

**Tech Stack:** Node.js only (`node --test`, zero new dependencies). CI: `.github/workflows/migrations.yml` (Node 22).

## Global Constraints

- **No `flows.json` edit.** This item adds tooling only. If a task appears to require editing `flows.json`, STOP — that is out of scope.
- **Both profiles enforced.** `verify-profile-parity.js` already guarantees the two `flows.json` copies are byte-identical, so their per-node sizes and totals are identical; the ratchet still scans **both** (defence in depth — if parity ever regresses, the ratchet catches an asymmetric size change too).
- **Git-anchored, fail-closed.** An unreachable base ref must never be treated as "no baseline / everything passes" — it throws and exits non-zero, exactly as `verify-no-stray-ddl.js` does (`base ref unusable, failing closed`).
- **Node id is the key, not name.** Verified 2026-07-08 on `main` @ `612987d9`: of the 232 function nodes, only 203 have distinct **names** — i.e. **29 nodes share a name with another node** (duplicate names across ~11 collision groups). Node **ids are unique** (232/232). Keying the per-node ceiling by `id` is load-bearing — keying by name would silently merge distinct nodes' sizes.
- **Each commit leaves CI green.** The baseline is generated from `main`, so the ratchet ships already-green (HEAD == base at introduction).
- Branch `feat/ratchet-trio`, commit per task, open a PR at the end, **do not merge it**.

## Measured baseline (captured at plan-write time — DD3's number is stale, see Verification finding #1)

Measured 2026-07-08 on `main` @ `612987d9`, both profiles byte-identical:

| Quantity | Value (per profile) |
|---|---|
| Total nodes | 564 |
| Function nodes | 232 |
| **Total embedded `func` chars (scoreboard baseline)** | **1,039,554** |
| Function nodes currently > 4096 chars | 65 |
| Function nodes currently ≤ 4096 chars | 167 |
| Largest node ceilings (id → chars) | `history-api-router-fn` 76,225 · `sync-init-fn` 73,162 (frozen) · `zone-env-fn` 67,317 · `dendro-compute-fn` 57,047 · `sync-force-build` 45,590 · `sync-bootstrap-build` 28,236 |

`func` length is measured as the JavaScript string length (`String(node.func).length`, UTF-16 code units) — the identical method the architecture expert used to derive the scoreboard (`analysis/refactor-program-2026/expert-architecture.md:44`, "sum of embedded `func` chars"). Not byte length (which is 1,040,399 for this same tree — multi-byte chars diverge; do not use bytes, it would not match the expert's units nor the charter's framing).

## Verification findings (design-vs-repo checks made while writing this plan)

Reported as findings, not silently absorbed:

1. **DD3's cited scoreboard number (1,017,468) is stale; the real current baseline is 1,039,554.** The `1,017,468` figure in `docs/architecture/refactor-program-2026.md` DD3 and `analysis/.../expert-architecture.md:44` was measured at an earlier commit; nodes have grown since (e.g. History API Router is now 76,225 chars vs the expert's cited 74.5 KB). The batch charter explicitly directs "capture the real current baseline from flows.json at plan-write time — measure it," so this plan anchors the scoreboard at the **measured** 1,039,554, not the stale literal. Because the ratchet is git-anchored to `origin/main` (not to a hardcoded constant), the enforcement number self-updates on every merge that lowers it — the committed baseline JSON records 1,039,554 only as the offline documentation snapshot. **This drift is worth a one-line correction in the program doc's DD3 row** (Task 5 makes it; the charter permits editing the program doc for outcomes, and a stale enforcement target would mislead a reader into thinking the scoreboard already dropped ~22k when it has not).
2. **Node id is unique; name is not.** 232 function nodes, 203 distinct names → 29 nodes share a name with another (see Global Constraints for the exact framing). The ceiling map is keyed by id.
3. **`sync-init-fn` (frozen boot node, 73,162 chars) is the second-largest node and will sit in the ceiling map at its current size.** This is correct and intended: the ratchet *pins* it (it may never grow) without ever asking it to shrink — the frozen node is schema-owned and out of extraction scope, and a "no node may grow" ceiling is exactly the right constraint for a frozen node. No exemption is needed or added.
4. **65 nodes already exceed the 4096-char new-node floor.** The 4096 ceiling therefore applies **only to newly-added ids**, never retroactively to the 65 existing large nodes (those are pinned at their current size by the per-node ceiling instead). The two rules compose: existing id → may-not-grow; new id → ≤4096 AND thin. Verified this is what DD3 means ("no node may grow; new ≤4 KB").
5. **The thin-node heuristic needs a size floor to avoid false positives on legitimately-small new nodes.** A brand-new 200-char routing node has no SQL and no `osiLib.require` and should obviously pass. The rule only bites a *large* new node (`> THIN_NODE_FLOOR`, set to 4096 — the same 4 KB threshold, so any new node that also trips the size ceiling is additionally checked for thinness). Below the floor, thinness is not evaluated. This keeps the heuristic a targeted "don't re-embed a monolith" gate, not a blanket style rule.
6. **`osiLib.require` presence is a positive signal, not a precondition.** Verified 0 nodes reference it on `main` today (1.A1 unmerged). The thin-node rule is an **OR**: a new large node passes if it *either* loads via `osi-lib` *or* carries no fat SQL literal. It never *requires* `osiLib.require`, so this item does not depend on 1.A1 having landed and does not break if 1.A1's node ids differ from what its plan assumed.
7. **`verify-no-stray-ddl.js` is the exact precedent to copy** (git-anchored base-ref + committed doc baseline, `--root`/`--git-root`/`--base-ref`/`--baseline`/`--surface`/`--write-baseline` flags, `GIT_MAX_BUFFER = 64 MiB`, fail-closed on unreachable ref, order-insensitive by construction). This plan reuses its CLI conventions verbatim so the two ratchets are operationally identical for a maintainer.

## File Structure (all changes)

- Create: `scripts/flows-size-scan.js` (pure scan module) + `scripts/flows-size-scan.test.js` (test vectors) (T1)
- Create: `scripts/verify-flows-size-ratchet.js` (CLI gate) + `scripts/verify-flows-size-ratchet.test.js` (git-anchored behaviour tests, scratch-repo style) (T2)
- Create: `scripts/verify-flows-size-ratchet-baseline.json` (committed doc baseline, generated via `--write-baseline`) (T3)
- Modify: `.github/workflows/migrations.yml` (T4)
- Modify: `docs/architecture/refactor-program-2026.md` (DD3 stale-number correction + 1.A2 outcome) (T5)

---

### Task 1: Pure scan module + test vectors

**Files:**
- Create: `scripts/flows-size-scan.test.js` (first), then `scripts/flows-size-scan.js`.

**Interfaces:**
- Exports (pure, for the CLI and tests):
  - `nodeSizes(flows) → Map<id, {name, chars}>` — function nodes only.
  - `totalChars(flows) → number` — sum of every function node's `func` length.
  - `isThinNewNode(node, {floor, sqlLiteralMax}) → { ok: boolean, reason?: string }` — the thin-node heuristic for one node.
  - Constants exported for the CLI + tests: `NEW_NODE_CEILING = 4096`, `THIN_NODE_FLOOR = 4096`, `SQL_LITERAL_MAX = 400`.

- [ ] **Step 1.1: Write the failing test-vector suite** — create `scripts/flows-size-scan.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nodeSizes, totalChars, isThinNewNode,
  NEW_NODE_CEILING, THIN_NODE_FLOOR, SQL_LITERAL_MAX,
} = require('./flows-size-scan');

const fn = (id, func, extra = {}) => ({ id, type: 'function', name: id, func, ...extra });
const bigSql = (n) => "const q = `SELECT " + 'a,'.repeat(n) + "b FROM device_data`;"; // one long literal

test('nodeSizes: only function nodes, keyed by id, chars = func length', () => {
  const sizes = nodeSizes([fn('a', 'return msg;'), { id: 't', type: 'tab' }, fn('b', 'x'.repeat(50))]);
  assert.deepEqual([...sizes.keys()].sort(), ['a', 'b']);
  assert.equal(sizes.get('a').chars, 'return msg;'.length);
  assert.equal(sizes.get('b').chars, 50);
});

test('nodeSizes: two function nodes with the SAME name keep distinct ids', () => {
  const sizes = nodeSizes([
    { id: 'id1', type: 'function', name: 'dup', func: 'a' },
    { id: 'id2', type: 'function', name: 'dup', func: 'bb' },
  ]);
  assert.equal(sizes.size, 2);
  assert.equal(sizes.get('id1').chars, 1);
  assert.equal(sizes.get('id2').chars, 2);
});

test('totalChars: sums func length across function nodes only', () => {
  assert.equal(totalChars([fn('a', 'abc'), { id: 't', type: 'tab' }, fn('b', 'de')]), 5);
  assert.equal(totalChars([fn('e', '')]), 0);
});

test('isThinNewNode: small new node passes without SQL or osiLib (below floor)', () => {
  assert.deepEqual(
    isThinNewNode(fn('small', 'return {payload: msg.payload};'),
      { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }),
    { ok: true });
});

test('isThinNewNode: large new node with a fat SQL literal and NO osiLib FAILS', () => {
  const node = fn('fat', 'x'.repeat(THIN_NODE_FLOOR) + '\n' + bigSql(SQL_LITERAL_MAX));
  const r = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
  assert.equal(r.ok, false);
  assert.match(r.reason, /oversized SQL literal/);
});

test('isThinNewNode: large new node that loads via osiLib.require PASSES even with a fat SQL literal', () => {
  const node = fn('adapter',
    "const h = osiLib.require('zone-env');\nif(!h.ok){return null;}\n" + bigSql(SQL_LITERAL_MAX),
    { libs: [{ var: 'osiLib', module: 'osi-lib' }] });
  assert.deepEqual(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }), { ok: true });
});

test('isThinNewNode: large new node with NO fat SQL literal PASSES (assembly logic is fine)', () => {
  const node = fn('assembly', 'const parts=[];\n' + 'parts.push(x);\n'.repeat(600)); // large, no SQL
  assert.deepEqual(isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX }), { ok: true });
});

test('exported constants have the documented values', () => {
  assert.equal(NEW_NODE_CEILING, 4096);
  assert.equal(THIN_NODE_FLOOR, 4096);
  assert.equal(SQL_LITERAL_MAX, 400);
});
```

- [ ] **Step 1.2: Run — expect FAIL** (`Cannot find module './flows-size-scan'`):

```bash
node --test scripts/flows-size-scan.test.js
```

- [ ] **Step 1.3: Implement** — create `scripts/flows-size-scan.js` with exactly:

```js
'use strict';
// Pure scan primitives for the flows.json size ratchet (refactor-program 1.A2, DD3).
// Kept requireable (no CLI side effects) so the test vectors can import it; the
// enforcement gate is scripts/verify-flows-size-ratchet.js, which imports this.

// A newly-added function node may be at most this many func-chars.
const NEW_NODE_CEILING = 4096;
// The thin-node heuristic only evaluates nodes larger than this (small new
// nodes are trivially fine); set equal to the ceiling so any new node that
// also trips the ceiling is additionally checked for thinness.
const THIN_NODE_FLOOR = 4096;
// A single string literal at least this long, containing a DDL/DML keyword, is
// "an oversized SQL literal" — the re-embedded-monolith smell.
const SQL_LITERAL_MAX = 400;

const SQL_KEYWORD = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+TRIGGER)\b/i;
// String literals: single-quoted, double-quoted, or template literals. Template
// literals are the ones that actually carry the big embedded SQL in this codebase.
const STRING_LITERAL = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

function isFunctionNode(node) {
  return node && node.type === 'function' && typeof node.func === 'string';
}

function nodeSizes(flows) {
  const sizes = new Map();
  for (const node of flows) {
    if (!isFunctionNode(node)) continue;
    sizes.set(node.id, { name: node.name || node.id, chars: node.func.length });
  }
  return sizes;
}

function totalChars(flows) {
  let total = 0;
  for (const node of flows) {
    if (!isFunctionNode(node)) continue;
    total += node.func.length;
  }
  return total;
}

function loadsViaOsiLib(node) {
  const declaresLib = Array.isArray(node.libs)
    && node.libs.some((l) => l && l.var === 'osiLib' && l.module === 'osi-lib');
  const callsRequire = /osiLib\.require\s*\(/.test(node.func);
  return declaresLib && callsRequire;
}

function hasOversizedSqlLiteral(func, sqlLiteralMax) {
  for (const m of func.matchAll(STRING_LITERAL)) {
    const literal = m[0];
    if (literal.length >= sqlLiteralMax && SQL_KEYWORD.test(literal)) return true;
  }
  return false;
}

function isThinNewNode(node, { floor, sqlLiteralMax }) {
  const func = String(node.func || '');
  if (func.length <= floor) return { ok: true }; // small new node — not evaluated
  if (loadsViaOsiLib(node)) return { ok: true }; // loads its logic through osi-lib — thin by construction
  if (hasOversizedSqlLiteral(func, sqlLiteralMax)) {
    return { ok: false, reason: 'oversized SQL literal (>=' + sqlLiteralMax + ' chars) in a large new node that does not load via osiLib.require' };
  }
  return { ok: true }; // large but no fat SQL literal (assembly/routing logic) — acceptable
}

module.exports = {
  nodeSizes, totalChars, isThinNewNode, loadsViaOsiLib, hasOversizedSqlLiteral,
  NEW_NODE_CEILING, THIN_NODE_FLOOR, SQL_LITERAL_MAX,
};
```

- [ ] **Step 1.4: Run — expect PASS** (same command as 1.2; all 8 tests pass).

- [ ] **Step 1.5: Commit**

```bash
git add scripts/flows-size-scan.js scripts/flows-size-scan.test.js
git commit -m "feat(ci): pure scan primitives for the flows.json size ratchet (refactor-program 1.A2, DD3)"
```

---

### Task 2: `verify-flows-size-ratchet.js` CLI gate (git-anchored) + scratch-repo tests

**Files:**
- Create: `scripts/verify-flows-size-ratchet.test.js` (first), then `scripts/verify-flows-size-ratchet.js`.

**Interfaces:** CLI flags mirror `verify-no-stray-ddl.js` exactly: `--root`, `--git-root`, `--base-ref` (default `origin/main`, env override `OSI_FLOWS_SIZE_BASE_REF`), `--baseline`, `--surface` (repeatable; default = the two profile flows.json paths), `--write-baseline`. Exit 0 on pass, non-zero on any failure; prints per-surface `OK`/`FAIL` lines.

- [ ] **Step 2.1: Write the failing behaviour test** — create `scripts/verify-flows-size-ratchet.test.js` with exactly (scratch-git-repo pattern lifted from `verify-no-stray-ddl.test.js`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-flows-size-ratchet.js');
const SURFACE = 'flows.json';
const SURFACE_ARGS = ['--surface', SURFACE];

function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }
function writeFlows(dir, nodes) {
  fs.writeFileSync(path.join(dir, SURFACE), JSON.stringify(nodes, null, 2) + '\n');
}
function initRepo(nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-size-ratchet-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@e.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFlows(dir, nodes);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}
function run(dir, extra = []) {
  return spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS, ...extra,
  ], { cwd: dir, encoding: 'utf8' });
}
function writeBaseline(dir) {
  execFileSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS, '--write-baseline',
  ], { cwd: dir });
}
const fn = (id, func, extra = {}) => ({ id, type: 'function', name: id, func, ...extra });
const BASE = [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(200))];

test('PASS when HEAD == base', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});

test('PASS when an existing node shrinks and the total drops (no baseline regen needed)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  // Shrink WITHOUT regenerating the committed baseline. Gate 1 (git ref) passes
  // because nothing grew; gate 2 must treat HEAD-below-baseline as an ok shrink
  // (conservative-ceiling semantics), NOT a stale-baseline failure. This is the
  // exact workflow the extraction PRs (2.2/2.4/4.2) depend on.
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(50))]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /below committed baseline/); // the informational NOTE line
});

test('FAIL when an existing node grows', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(400))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew/);
});

test('FAIL when the per-profile total increases', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  // add a small new node -> total goes up even though no existing node grew
  writeFlows(dir, [...BASE, fn('newsmall', 'return 1;')]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /total embedded JS increased/);
});

test('FAIL when a NEW node exceeds the 4096 ceiling', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  // shrink an existing node enough that the total still drops, so ONLY the
  // new-node-ceiling rule can fire (isolates the assertion).
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)), fn('toobig', 'z'.repeat(5000))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node toobig exceeds/);
});

test('FAIL when a large NEW node has a fat SQL literal and no osiLib (thin-node rule)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const fatSql = "const q=`SELECT " + 'a,'.repeat(400) + "b FROM device_data`;";
  // Keep it under the 4096 new-node CEILING so the thin rule is what fires, not the ceiling:
  // pad below 4096 but above THIN evaluation? THIN_NODE_FLOOR == 4096, so the node must be >4096
  // to be evaluated — which also trips the ceiling. Both fire; assert the thin reason is present.
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)),
    fn('fatnew', 'x'.repeat(4097) + '\n' + fatSql)]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /oversized SQL literal/);
});

test('PASS when a large NEW node loads via osiLib.require', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  // Shrink existing node so the total drops despite the large new adapter.
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)),
    fn('adapter', "const h=osiLib.require('x');\n" + 'k'.repeat(4097),
      { libs: [{ var: 'osiLib', module: 'osi-lib' }] })]);
  const r = run(dir);
  // The new node is >4096 so it trips the CEILING; the thin rule passes. The
  // ceiling still fails it — a large adapter is still a large node. Assert the
  // failure is ONLY the ceiling, never the thin rule.
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node adapter exceeds/);
  assert.doesNotMatch(r.stderr, /oversized SQL literal/);
});

test('fails closed when --base-ref is unreachable', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const r = spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir,
    '--base-ref', 'refs/remotes/origin/does-not-exist',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS,
  ], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /failing closed/);
});

test('gate 2: FAILS when HEAD total EXCEEDS the committed baseline (unrecorded growth)', () => {
  // Conservative-ceiling gate 2: only an UPWARD divergence (HEAD > committed
  // baseline) fails. Hand-edit the committed baseline DOWN so HEAD now exceeds
  // it, while HEAD == base ref so gate 1 (per-node/total) passes — isolating
  // gate 2. (An unrecorded growth is the belt-and-suspenders case gate 2 exists
  // for; a shrink-below-baseline is exercised by the shrink PASS test above.)
  const dir = initRepo(BASE); writeBaseline(dir);
  const bp = path.join(dir, 'baseline.json');
  const doctored = JSON.parse(fs.readFileSync(bp, 'utf8'));
  doctored.files[SURFACE].total = 1; // HEAD (211) now exceeds this
  fs.writeFileSync(bp, JSON.stringify(doctored, null, 2) + '\n');
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /exceeds committed baseline/);
});

test('accepts the committed shipped baseline against origin/main', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/verify-flows-size-ratchet-baseline.json')), true,
    'baseline must be committed');
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});
```

> Worker note on the two "both rules fire" cases (`fatnew`, `adapter`): because `THIN_NODE_FLOOR === NEW_NODE_CEILING === 4096`, any node large enough to be thin-evaluated (>4096) also trips the ceiling. That is fine and intended — the tests assert on the *presence/absence of the specific reason string* to prove each rule fired (or did not) independently, not on the node passing overall. The `adapter` case is the load-bearing proof that osiLib presence suppresses the thin-rule failure while the ceiling still (correctly) flags the large node.

- [ ] **Step 2.2: Run — expect FAIL** (`Cannot find module './verify-flows-size-ratchet'`):

```bash
node --test scripts/verify-flows-size-ratchet.test.js
```

- [ ] **Step 2.3: Implement** — create `scripts/verify-flows-size-ratchet.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// verify-flows-size-ratchet — refactor-program 1.A2, DD3.
// Three git-anchored ratchets over the two maintained flows.json profiles:
//   (1) per-node ceiling: no existing function node (by id) may grow vs the
//       base ref; a NEW node (id absent from base) must be <= NEW_NODE_CEILING.
//   (2) total scoreboard: the per-profile sum of func-chars may only DECREASE.
//   (3) thin-node heuristic: a large NEW node must load via osiLib.require OR
//       carry no oversized SQL literal.
// Enforcement is git-anchored (base ref, default origin/main), NOT a committed
// baseline, so a PR cannot both grow a node and launder the growth by
// regenerating a committed baseline in the same commit. Mirrors
// scripts/verify-no-stray-ddl.js's two-gate design (gate 1 = git ref = real
// enforcement; gate 2 = committed baseline doc-honesty, low stakes).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  nodeSizes, totalChars, isThinNewNode, NEW_NODE_CEILING, THIN_NODE_FLOOR, SQL_LITERAL_MAX,
} = require('./flows-size-scan');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const GIT_MAX_BUFFER = 64 * 1024 * 1024; // flows.json is ~1.2 MB; default 1 MB overflows.

function parseArgs(argv) {
  const o = {
    root: repoRoot, gitRoot: null,
    baselinePath: path.join(repoRoot, 'scripts/verify-flows-size-ratchet-baseline.json'),
    surfaces: null, baseRef: null, writeBaseline: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') { o.root = path.resolve(argv[++i] || raise('--root requires a path')); }
    else if (a === '--git-root') { o.gitRoot = path.resolve(argv[++i] || raise('--git-root requires a path')); }
    else if (a === '--baseline') { o.baselinePath = path.resolve(argv[++i] || raise('--baseline requires a path')); }
    else if (a === '--surface') { (o.surfaces = o.surfaces || []).push(argv[++i] || raise('--surface requires a path')); }
    else if (a === '--base-ref') { o.baseRef = argv[++i] || raise('--base-ref requires a ref'); }
    else if (a === '--write-baseline') { o.writeBaseline = true; }
    else raise('unknown argument: ' + a);
  }
  if (!o.surfaces) o.surfaces = DEFAULT_SURFACES;
  if (!o.gitRoot) o.gitRoot = o.root;
  if (!o.baseRef) o.baseRef = process.env.OSI_FLOWS_SIZE_BASE_REF || DEFAULT_BASE_REF;
  return o;
}
function raise(msg) { throw new Error(msg); }

function parseFlows(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('flows.json is not a JSON array');
  return parsed;
}
function surfaceHead(root, rel) { return parseFlows(fs.readFileSync(path.join(root, rel), 'utf8')); }
function surfaceBase(gitRoot, baseRef, rel) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', gitRoot, 'show', baseRef + ':' + rel], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error('base ref unusable, failing closed: cannot read ' + rel + ' (' + baseRef + '): ' + stderr);
  }
  return parseFlows(raw);
}

function measure(flows) {
  const sizes = nodeSizes(flows);
  return { sizes, total: totalChars(flows) };
}

// Returns { failures: string[], headTotal, baseTotal } for one surface.
function checkSurface(rel, headFlows, baseFlows) {
  const failures = [];
  const head = measure(headFlows);
  const base = measure(baseFlows);

  for (const [id, { chars }] of head.sizes) {
    const baseEntry = base.sizes.get(id);
    if (baseEntry) {
      if (chars > baseEntry.chars) {
        failures.push(rel + ': node ' + id + ' grew (' + chars + ' > ' + baseEntry.chars + ' at base)');
      }
    } else {
      // New node (id absent from base): ceiling + thin-node rule.
      if (chars > NEW_NODE_CEILING) {
        failures.push(rel + ': new node ' + id + ' exceeds the ' + NEW_NODE_CEILING + '-char ceiling (' + chars + ')');
      }
      const node = headFlows.find((n) => n && n.id === id);
      const thin = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
      if (!thin.ok) failures.push(rel + ': new node ' + id + ' — ' + thin.reason);
    }
  }
  if (head.total > base.total) {
    failures.push(rel + ': total embedded JS increased (' + head.total + ' > ' + base.total + ' at base)');
  }
  // Return both totals so run() never re-measures base (finding #4).
  return { failures, headTotal: head.total, baseTotal: base.total };
}

function buildBaseline(root, surfaces) {
  const files = {};
  for (const rel of surfaces) {
    const { sizes, total } = measure(surfaceHead(root, rel));
    files[rel] = { functionNodes: sizes.size, total };
  }
  return {
    version: 1,
    baseRef: DEFAULT_BASE_REF,
    ceilingChars: NEW_NODE_CEILING,
    thinNodeFloorChars: THIN_NODE_FLOOR,
    sqlLiteralMaxChars: SQL_LITERAL_MAX,
    notes: [
      'DOCUMENTATION of the current per-profile function-JS totals, not the enforcement gate.',
      'Enforcement is scripts/verify-flows-size-ratchet.js comparing HEAD against --base-ref',
      '(default origin/main): per-node-id ceilings, per-profile total may only decrease, and',
      'the thin-node heuristic on newly-added node ids. See the script header.',
      'The DD3 charter cites 1,017,468 as the scoreboard start; the real measured baseline at',
      'introduction (main @ 612987d9, 2026-07-08) is 1,039,554 per profile — the earlier figure',
      'was captured before nodes grew. Git-anchoring means the enforced number self-updates.',
    ],
    files,
  };
}
function writeBaselineFile(o) {
  const baseline = buildBaseline(o.root, o.surfaces);
  fs.writeFileSync(o.baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

// Gate 2 (doc honesty) is a CONSERVATIVE CEILING, not an equality. It fails
// ONLY if HEAD total EXCEEDS the committed baseline (an unrecorded growth that
// slipped past the per-surface view) — belt-and-suspenders to gate 1. A HEAD
// total BELOW the committed baseline is a legitimate shrink whose PR has not
// yet regenerated the doc; that is fine and passes with a note, because forcing
// every scoreboard-lowering PR (items 2.2/2.4/4.2 — the whole point of this
// ratchet) to also regenerate + commit the baseline JSON would be a merge trap.
// The doc is refreshed opportunistically via --write-baseline, not on every win.
function verifyDocBaseline(o) {
  const baseline = JSON.parse(fs.readFileSync(o.baselinePath, 'utf8'));
  const failures = [];
  const notes = [];
  for (const rel of o.surfaces) {
    const expected = (baseline.files || {})[rel];
    const { total } = measure(surfaceHead(o.root, rel));
    if (!expected) {
      failures.push(rel + ': committed baseline missing this surface');
    } else if (total > expected.total) {
      failures.push(rel + ': HEAD total ' + total + ' exceeds committed baseline ' + expected.total + ' (regenerate with --write-baseline if this growth is intentional and gate 1 allowed it)');
    } else if (total < expected.total) {
      notes.push(rel + ': HEAD total ' + total + ' is below committed baseline ' + expected.total + ' — a shrink not yet reflected in the doc (ok; refresh with --write-baseline when convenient)');
    }
  }
  return { failures, notes };
}

function run() {
  const o = parseArgs(process.argv.slice(2));
  if (o.writeBaseline) {
    const b = writeBaselineFile(o);
    const t = Object.values(b.files).map((f) => f.total).join(', ');
    console.log('verify-flows-size-ratchet: wrote baseline (per-profile totals ' + t + ') to ' + o.baselinePath);
    return;
  }
  const failures = [];
  let headTotal = 0;
  let baseTotal = 0;
  for (const rel of o.surfaces) {
    const head = surfaceHead(o.root, rel);
    const base = surfaceBase(o.gitRoot, o.baseRef, rel); // throws -> fail closed
    const res = checkSurface(rel, head, base);
    failures.push(...res.failures);
    headTotal += res.headTotal;
    baseTotal += res.baseTotal; // finding #4: no second measure(base)
    if (!res.failures.length) console.log('OK ' + rel + ' (total ' + res.headTotal + ')');
  }
  if (failures.length) { for (const f of failures) console.error('FAIL ' + f); process.exit(1); }

  const doc = verifyDocBaseline(o); // gate 2 (conservative ceiling, low stakes)
  for (const n of doc.notes) console.log('NOTE ' + n);
  if (doc.failures.length) { for (const f of doc.failures) console.error('FAIL ' + f); process.exit(1); }

  console.log('verify-flows-size-ratchet: OK (HEAD total ' + headTotal + ' <= ' + o.baseRef + ' total ' + baseTotal + '; committed baseline not exceeded)');
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('verify-flows-size-ratchet: FAIL — ' + e.message); process.exit(1); }
}
module.exports = { checkSurface, measure, buildBaseline };
```

- [ ] **Step 2.4: Run the behaviour tests — expect all but the last PASS** (the last test, "accepts the committed shipped baseline," needs Task 3's committed baseline + the real repo's `origin/main`; it will fail until Task 3 runs, which is expected at this step):

```bash
node --test scripts/verify-flows-size-ratchet.test.js
```
Expected: every scratch-repo test passes; the final "accepts the committed shipped baseline" test fails with a missing-baseline assertion (Task 3 fixes it). Do NOT weaken that test.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/verify-flows-size-ratchet.js scripts/verify-flows-size-ratchet.test.js
git commit -m "feat(ci): git-anchored flows.json size-ratchet gate (refactor-program 1.A2, DD3)"
```

---

### Task 3: Generate + commit the documentation baseline; confirm green against origin/main

- [ ] **Step 3.1: Ensure the base ref is present** (CI fetches it; locally you may need it):

```bash
git fetch --no-tags origin main:refs/remotes/origin/main
```

- [ ] **Step 3.2: Generate the committed baseline** from the working tree:

```bash
node scripts/verify-flows-size-ratchet.js --write-baseline
```
Expected: `verify-flows-size-ratchet: wrote baseline (per-profile totals 1039554, 1039554) to .../scripts/verify-flows-size-ratchet-baseline.json`. If the totals differ from 1,039,554, STOP — either the tree drifted from `612987d9` or the measurement diverged from the plan; reconcile before committing (re-measure and update this plan's baseline table in the same PR rather than committing a number the plan contradicts).

- [ ] **Step 3.3: Run the full gate against `origin/main`** (real enforcement path):

```bash
node scripts/verify-flows-size-ratchet.js
```
Expected: two `OK <profile> (total 1039554)` lines then `verify-flows-size-ratchet: OK (HEAD total 2079108 <= origin/main total 2079108; committed baseline not exceeded)`, exit 0. (Two profiles × 1,039,554 = 2,079,108 combined.) No `NOTE` lines at introduction because HEAD == the just-written committed baseline.

- [ ] **Step 3.4: Run the full behaviour suite — now all green** (the "accepts the committed shipped baseline" test passes once the baseline exists):

```bash
node --test scripts/flows-size-scan.test.js scripts/verify-flows-size-ratchet.test.js
```

- [ ] **Step 3.5: Commit**

```bash
git add scripts/verify-flows-size-ratchet-baseline.json
git commit -m "chore(ci): commit flows.json size-ratchet baseline (1,039,554 func-chars/profile @ 612987d9) (refactor-program 1.A2)"
```

---

### Task 4: CI wiring

**Files:** Modify `.github/workflows/migrations.yml`.

- [ ] **Step 4.1: Add the two test files to the existing `node --test` line** (line 38 today). Append `scripts/flows-size-scan.test.js scripts/verify-flows-size-ratchet.test.js` to the space-separated list.

- [ ] **Step 4.2: Add the gate run line** after `- run: node scripts/verify-no-stray-ddl.js` (keeping the two size/DDL ratchets adjacent for a maintainer):

```yaml
      - run: node scripts/verify-flows-size-ratchet.js
```

> The `verify-flows-size-ratchet.test.js` "accepts the committed shipped baseline" test spawns the CLI with default `--base-ref origin/main`; the workflow already runs `git fetch --no-tags origin main:refs/remotes/origin/main` at step "Fetch migration base ref" (migrations.yml line 36) and checks out with `fetch-depth: 0`, so `origin/main` resolves in CI. No new fetch step is needed.

- [ ] **Step 4.3: Verify the workflow YAML parses and commit:**

```bash
node -e "const y=require('fs').readFileSync('.github/workflows/migrations.yml','utf8'); if(!y.includes('verify-flows-size-ratchet.js')) throw new Error('gate not wired'); console.log('wired')"
git add .github/workflows/migrations.yml
git commit -m "feat(ci): wire flows.json size-ratchet into Edge Migrations workflow (refactor-program 1.A2, DD3)"
```

---

### Task 5: Program-doc correction + outcome, PR

- [ ] **Step 5.1: Correct DD3's stale scoreboard number and record the outcome.** In `docs/architecture/refactor-program-2026.md`:
  - In the DD3 row, change `may only decrease from 1,017,468` to `may only decrease (measured baseline 1,039,554 func-chars/profile @ 612987d9, 2026-07-08; the earlier 1,017,468 figure predated node growth)`. Keep the rest of the row verbatim.
  - In the Phase 1 Track A table, append to the 1.A2 row: `— done: verify-flows-size-ratchet (per-node ceiling + total scoreboard + thin-node heuristic), git-anchored, both profiles, PR #<FILL IN AT PR TIME>`.

```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): correct DD3 scoreboard baseline to measured 1,039,554; record 1.A2 outcome"
```

- [ ] **Step 5.2: Full local CI-equivalent run** (all green):

```bash
node --test scripts/flows-size-scan.test.js scripts/verify-flows-size-ratchet.test.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-no-stray-ddl.js   # unchanged — confirm the sibling ratchet still passes
```

- [ ] **Step 5.3: Open the PR (do not merge):**

```bash
git push -u origin feat/ratchet-trio
gh pr create --title "Ratchet trio: flows.json node-size ceiling + total-JS scoreboard + thin-node heuristic (refactor-program 1.A2)" --body "$(cat <<'EOF'
## Summary
- One git-anchored CI gate, `scripts/verify-flows-size-ratchet.js`, enforcing DD3's three ratchets over both flows.json profiles:
  1. **Per-node ceiling** (keyed by node id — 29 names collide, ids are unique): no existing node may grow vs origin/main; a newly-added node must be ≤4096 func-chars.
  2. **Total-JS scoreboard**: per-profile func-char sum may only decrease. **Measured baseline: 1,039,554/profile** (DD3's cited 1,017,468 predated node growth — corrected in the program doc).
  3. **Thin-node heuristic**: a large new node must load via `osiLib.require` OR carry no oversized SQL literal — the re-embedded-monolith gate.
- Same two-gate design as `verify-no-stray-ddl.js` (git ref = real enforcement, cannot be self-certified by regenerating a committed baseline; committed baseline = offline doc honesty), fail-closed on an unreachable base ref.
- Pure scan module + full test vectors (grow/shrink/total/ceiling/thin-node/osiLib-pass/fail-closed/stale-baseline).

## Evidence
- `node scripts/verify-flows-size-ratchet.js` — OK, HEAD total == origin/main total (ships already green).
- `node --test scripts/flows-size-scan.test.js scripts/verify-flows-size-ratchet.test.js` — all green.

## Notes
- Zero flows.json edits. No dependency on 1.A1 (loader) — the thin-node rule rewards `osiLib.require` but never requires it (0 nodes reference it on main today).
- `sync-init-fn` (frozen, 73,162 chars) is pinned at its current size by the per-node ceiling — correct for a frozen node; no exemption needed.

Part of refactor-program item 1.A2 (DD3).

## Test plan
- [ ] CI green on this PR
- [ ] Reviewer confirms baseline totals (1,039,554/profile) match a fresh measurement
EOF
)"
```

---

## Extraction-PR workflow contract (READ if you are implementing 2.2 / 2.4 / 4.2)

This ratchet is the gate that proves an extraction lowered the scoreboard and that any new adapter node is thin. A scoreboard-lowering PR needs **no** special baseline handling: gate 1 (git-anchored) passes because nothing grew, and gate 2 (conservative ceiling, §Task 2) passes a HEAD-below-committed-baseline shrink with an informational `NOTE`, **not** a failure. So an extraction PR simply:

- runs `node scripts/verify-flows-size-ratchet.js` after its flows mutation and confirms the total **decreased** (and any new adapter node is ≤4096 + thin);
- **optionally** runs `node scripts/verify-flows-size-ratchet.js --write-baseline` and commits the refreshed `scripts/verify-flows-size-ratchet-baseline.json` to keep the committed doc snapshot current — this is a courtesy, not a merge requirement. (Contrast: a PR that *grows* a node fails gate 1 outright, and even if it somehow only grew the total it would fail gate 2's "exceeds committed baseline" check — the doc is a ceiling.)

Refresh the committed baseline opportunistically (e.g. once per phase) so the offline snapshot does not drift arbitrarily far below reality; nothing breaks if it lags.

## Follow-ups (not tasks in this plan)
- The `osi-flows-json-editing/SKILL.md` provenance figures are stale (529 nodes / 1,245,761 bytes; now 564 / 1,263,362) — a one-line refresh next time the skill is touched, not part of this item.
