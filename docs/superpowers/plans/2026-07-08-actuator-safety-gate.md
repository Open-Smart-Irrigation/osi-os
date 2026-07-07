# Actuator Duration-Bound CI Assertion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution notes:** (1) work inside a feature branch `feat/actuator-safety-gate` (worktree recommended, not the root `main` checkout); (2) this item touches ONLY `scripts/verify-command-safety.js` and its CI wiring — **no `flows.json` edit, no schema, no new device**; (3) run every command from the repo/worktree root; (4) CI must stay green at every commit.
> **Charter:** [`docs/architecture/refactor-program-2026.md`](../../architecture/refactor-program-2026.md) — Phase 3, item **3.0** (DD17). **Entry gate: this merges before ANY MClimate downlink code (item 3.1).**
> **No spec (S/direct item):** the design is fully specified by DD17 + the STREGA `OPEN_FOR_DURATION`-only model already enforced in `verify-command-safety.js`. This plan is the whole design record.

**Goal:** Extend `scripts/verify-command-safety.js` with one new assertion, `assertActuatorCommandsAreDurationBounded()`, that reads the **Command Type Registry** (`COMMAND_TYPES` in the `cmd-type-registry` function node of `flows.json`) as the single source of truth and fails CI if any command type with `actuator: true` is not duration-bounded — i.e. lacks `requires_duration: true` **unless** it is on a tiny, explicitly-justified exemption allow-list (today: `CLOSE`). The check is structural and prospective: a **future** actuator command type added without a device-side duration bound (the exact shape MClimate's T-Valve open command will take) fails the merge that adds it, before any downlink can reach hardware.

## Why this item exists (DD17, verbatim intent)

A valve stuck open during a Node-RED crash-loop is crop damage; the **device firmware** must be the failsafe, not edge software. STREGA already models this: the only sanctioned open is `OPEN_FOR_DURATION` (a bare/indefinite `OPEN` is rejected at dispatch — `Reject Indefinite Open` node; `Auth + Validate + Normalize` rejects "Indefinite OPEN" and normalizes timed requests to `OPEN_FOR_DURATION`), and the reconciliation monitor never issues a CLOSE downlink on timer elapse — the valve closes itself. The registry encodes this as `requires_duration: true` on `OPEN_FOR_DURATION`/`SET_STREGA_TIMED_ACTION`. Today `verify-command-safety.js` asserts the STREGA-specific *nodes* behave, but it does **not** assert the *general invariant* that every actuator command is duration-bounded. This item closes that gap so MClimate (item 3.1) — the second actuator — cannot ship an unbounded open.

## Verified ground truth (checked against `main`, 2026-07-08)

1. **The registry is the single source of truth and already carries the exact fields this check needs.** Node id `cmd-type-registry` (name in the flow: the "Command Type Registry" comment header) sets `flow.set('command_types', COMMAND_TYPES)` where each entry has `{ dispatch, actuator, requires_duration }`. Verbatim current entries:

   | command_type | actuator | requires_duration |
   |---|---|---|
   | `OPEN_FOR_DURATION` | true | true |
   | `SET_STREGA_TIMED_ACTION` | true | true |
   | `CLOSE` | true | false |
   | `SET_CHAMELEON_CONFIG` | false | false |
   | `REGISTER_DEVICE` | false | false |
   | `REBOOT_DEVICE` | false | false |
   | `REMOVE_DEVICE_FROM_ZONE` | false | false |
   | `UNCLAIM_DEVICE` | false | false |

   So exactly one entry (`CLOSE`) is `actuator: true, requires_duration: false`. `CLOSE` is safe-by-construction — a close cannot leave a valve open — and is the deliberate exemption. Everything else with `actuator: true` is already `requires_duration: true`. **The check therefore ships green today** (baseline = zero violations) and only bites a *future* unbounded actuator.

2. **`verify-command-safety.js` already parses `flows.json` and has helpers for this.** `readFlows()`, `findFunctionNode(flows, name)`, and a `main()` that chains named assertions all exist. It reads nodes by `name`, not `id` — the registry node's `name` must be resolved (see Task 1 Step 1.1: read the node's actual `name` from `flows.json`; do not assume). The file's existing `assertIndefiniteOpenRejection()` already references `requires_duration` and the registry, so the field's meaning is established in-file.

3. **The registry appears THREE times in `flows.json`** — the canonical `COMMAND_TYPES` in the registry node, plus two inline `COMMAND_TYPES_FALLBACK` copies (in `Reject Indefinite Open` and `Write STREGA Expectation`) that duplicate it for resilience when `flow.get('command_types')` is empty. The safety invariant must hold on the **canonical** registry (the source of truth); the fallbacks are a separate resilience concern. This check reads the canonical registry node only. (A follow-up could assert fallback⊆canonical parity, but that is out of scope here — noted, not built.)

4. **CI wiring:** `verify-command-safety.js` — confirm whether it is already invoked by a workflow. As of this plan it is **not** referenced in any `.github/workflows/*.yml` (grep: only `codecs.yml`, `migrations.yml`, `typecheck.yml`, `verify-sync-flow.yml` exist; none run `verify-command-safety.js`). **Finding:** the safety verifier is currently local-only. This item wires it into `migrations.yml` (the general edge-verifier workflow) so the gate is actually a merge gate, not just a local script. If a later check reveals it IS already wired, skip the wiring step and note it — do not double-wire.

5. **Registry parsing:** the registry node's `func` is a JS string, not JSON. Two robust options: (a) extract each `KEY: { ... actuator: true/false, requires_duration: true/false ... }` line with a per-entry regex; (b) evaluate the `COMMAND_TYPES` object literal in a sandboxed `new Function('return (' + objectLiteral + ')')()` after slicing it out of the `func`. **Decision: option (a), regex per entry** — no `eval`/`Function` on flow source (avoids executing arbitrary flow text in CI), and the registry's format is stable and line-oriented. The regex must tolerate the existing whitespace-aligned columns.

## Global constraints

- **`flows.json` is NOT edited by this item.** The check only *reads* it. No mutation script, no profile-parity concern for flows (it is untouched). If you find yourself editing `flows.json`, stop — that is out of scope and belongs to item 3.1.
- **Only two files change:** `scripts/verify-command-safety.js` (new assertion + wire into `main()`) and `.github/workflows/migrations.yml` (one run line). Optionally a co-located test file (Task 2).
- **The check must ship GREEN** (baseline zero violations, per verified fact 1). If it fails on `main`, the registry has drifted from the documented table — STOP and reconcile before proceeding; do not weaken the check to pass.
- **Branch `feat/actuator-safety-gate`, commit per task, open a PR at the end, do not merge it.**

## Non-goals (do not do these)

- No `flows.json` edit, no new command type, no MClimate anything (item 3.1).
- No fallback-copy parity assertion (`COMMAND_TYPES_FALLBACK` ⊆ canonical) — noted in verified fact 3, deferred.
- No change to the existing STREGA-specific assertions in the file — purely additive.
- No device-firmware verification (the firmware IS the failsafe by design; this check asserts the *edge* never dispatches an unbounded actuator command, which is the CI-checkable half of DD17).
- No runtime/behavioral test against a live gateway (documents-and-CI item; no SSH).

## File structure (all changes)

- Modify: `scripts/verify-command-safety.js` (add `parseCommandRegistry()` + `assertActuatorCommandsAreDurationBounded()`; call it in `main()`; export the pure parser+checker for the test)
- Create: `scripts/verify-command-safety.test.js` (test vectors: a duration-bounded actuator PASSES, an unbounded new actuator FAILS, the `CLOSE` exemption is honored, a non-actuator without duration PASSES)
- Modify: `.github/workflows/migrations.yml` (one `- run: node scripts/verify-command-safety.js` line — only if not already wired, per verified fact 4)

---

### Task 1: Add the duration-bound assertion to `verify-command-safety.js`

**Files:**
- Modify: `scripts/verify-command-safety.js`

**Interfaces:**
- Add a pure `parseCommandRegistry(flows) → { COMMAND_TYPE_NAME: { actuator: bool, requires_duration: bool }, ... }` that locates the canonical registry node and extracts each entry by regex.
- Add `assertActuatorCommandsAreDurationBounded(registry)` that, for every entry with `actuator === true`, requires `requires_duration === true` OR the name being in `DURATION_EXEMPT_ACTUATORS` (a named `Set`, seeded with `'CLOSE'` and a one-line comment justifying each member).
- Both exported (`module.exports = { parseCommandRegistry, assertActuatorCommandsAreDurationBounded, DURATION_EXEMPT_ACTUATORS }`) so Task 2's test imports them without running `main()`. Guard `main()` behind `if (require.main === module)` — verify the file's current bottom (`try { main(); } catch ...`) is converted to that guard so importing the module for tests does not execute the full CLI.

- [ ] **Step 1.1: Resolve the registry node's real `name`.** Run:

```bash
node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'); const n=f.find(x=>x.id==='cmd-type-registry'); console.log('name=', JSON.stringify(n && n.name)); console.log((n&&n.func||'').slice(0,120));"
```
Record the exact `name` string. Locate the node by `id === 'cmd-type-registry'` in the parser (an id is stable; a name can drift) — verified fact 2 says the file resolves nodes by name elsewhere, but for THIS node use the id, and assert the `func` contains `flow.set('command_types'` as a sanity pin so a future rename/move is caught loudly rather than silently skipping the check.

- [ ] **Step 1.2: Implement `parseCommandRegistry(flows)`** in `scripts/verify-command-safety.js`, above `main()`:

```js
// The Command Type Registry (node id 'cmd-type-registry') is the single
// source of truth for accepted command types and their safety flags. DD17: every
// actuator command MUST be duration-bounded at the device firmware; the edge
// encodes that intent as requires_duration:true. This parser reads the canonical
// registry (NOT the inline COMMAND_TYPES_FALLBACK copies) so a future actuator
// added without a duration bound fails CI before any downlink can ship.
function parseCommandRegistry(flows) {
    const node = flows.find(n => n.id === 'cmd-type-registry');
    if (!node) throw new Error("Missing Command Type Registry node (id 'cmd-type-registry')");
    const func = String(node.func || '');
    if (!func.includes("flow.set('command_types'")) {
        throw new Error("cmd-type-registry node no longer sets flow.set('command_types', ...) — registry shape drifted; reconcile the safety check before trusting it");
    }
    // Match each `KEY: { ...actuator: <bool>...requires_duration: <bool>... }` entry.
    // Whitespace-tolerant; the registry aligns columns with runs of spaces.
    const entries = {};
    const entryRe = /(\b[A-Z_]+)\s*:\s*\{([^}]*)\}/g;
    let m;
    while ((m = entryRe.exec(func)) !== null) {
        const name = m[1];
        const body = m[2];
        const actuator = /\bactuator\s*:\s*true\b/.test(body);
        const requiresDuration = /\brequires_duration\s*:\s*true\b/.test(body);
        // Only record entries that actually declare the two flags (skips unrelated
        // object literals if any appear in the function body).
        if (/\bactuator\s*:/.test(body) && /\brequires_duration\s*:/.test(body)) {
            entries[name] = { actuator, requires_duration: requiresDuration };
        }
    }
    if (Object.keys(entries).length === 0) {
        throw new Error('parseCommandRegistry found zero command-type entries — parser or registry format drifted');
    }
    return entries;
}
```

- [ ] **Step 1.3: Implement the exemption set + the assertion:**

```js
// Actuator command types that are safe WITHOUT a duration bound, each with an
// explicit reason. A close cannot leave a valve open, so it needs no auto-close
// timer. Adding a member here is a deliberate, reviewed safety decision — do not
// add one to make the check pass for a new open-style command.
const DURATION_EXEMPT_ACTUATORS = new Set([
    'CLOSE', // idempotent safe state; closing cannot cause over-irrigation
]);

function assertActuatorCommandsAreDurationBounded(registry) {
    const violations = [];
    for (const [name, entry] of Object.entries(registry)) {
        if (!entry.actuator) continue;
        if (entry.requires_duration) continue;
        if (DURATION_EXEMPT_ACTUATORS.has(name)) continue;
        violations.push(name);
    }
    if (violations.length) {
        throw new Error(
            'DD17 actuator safety: command type(s) [' + violations.join(', ') +
            '] are actuator:true but not duration-bounded (requires_duration:true) ' +
            'and not on the DURATION_EXEMPT_ACTUATORS allow-list. Every actuator ' +
            'command must be duration-bounded at the device firmware (STREGA ' +
            'OPEN_FOR_DURATION model). If this is a genuinely safe non-timed ' +
            'actuator (like CLOSE), add it to DURATION_EXEMPT_ACTUATORS with a ' +
            'one-line justification; otherwise give it requires_duration:true.'
        );
    }
    console.log('  ok all actuator command types are duration-bounded (or exempt: ' +
        [...DURATION_EXEMPT_ACTUATORS].join(', ') + ')');
}
```

- [ ] **Step 1.4: Wire into `main()`** — add a call after `assertRouteHandlesSafeValveCommands()` (near the other command-registry assertions):

```js
    const registry = parseCommandRegistry(readFlows());
    assertActuatorCommandsAreDurationBounded(registry);
```

Convert the file's bottom to guard `main()` and export the new symbols:

```js
if (require.main === module) {
    try { main(); } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
}
module.exports = { parseCommandRegistry, assertActuatorCommandsAreDurationBounded, DURATION_EXEMPT_ACTUATORS };
```

- [ ] **Step 1.5: Run — expect GREEN** (baseline zero violations):

```bash
node scripts/verify-command-safety.js
```
Expected: all existing `ok` lines, PLUS `ok all actuator command types are duration-bounded (or exempt: CLOSE)`, then `verify-command-safety: OK`, exit 0. If it FAILS, the registry drifted from verified fact 1 — reconcile, do not weaken.

- [ ] **Step 1.6: Commit**

```bash
git add scripts/verify-command-safety.js
git commit -m "feat(ci): assert every actuator command type is duration-bounded (refactor-program 3.0, DD17)"
```

---

### Task 2: Test vectors pinning the future-actuator failure class

**Files:**
- Create: `scripts/verify-command-safety.test.js`

The whole point of this item is catching a *future* unbounded actuator; a synthetic FAIL vector is what proves the check actually bites (a green-today check with no failing vector is untested).

- [ ] **Step 2.1: Write the test suite:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseCommandRegistry,
    assertActuatorCommandsAreDurationBounded,
    DURATION_EXEMPT_ACTUATORS,
} = require('./verify-command-safety');

const registryNode = (funcBody) => ([{ id: 'cmd-type-registry', type: 'function', name: 'Command Type Registry', func: funcBody }]);

test('parses the canonical registry entries with their safety flags', () => {
    const flows = registryNode([
        "const COMMAND_TYPES = {",
        "  OPEN_FOR_DURATION: { dispatch: 'x', actuator: true,  requires_duration: true  },",
        "  CLOSE:             { dispatch: 'y', actuator: true,  requires_duration: false },",
        "  REBOOT_DEVICE:     { dispatch: 'z', actuator: false, requires_duration: false }",
        "};",
        "flow.set('command_types', COMMAND_TYPES);",
    ].join('\n'));
    const r = parseCommandRegistry(flows);
    assert.deepEqual(r.OPEN_FOR_DURATION, { actuator: true, requires_duration: true });
    assert.deepEqual(r.CLOSE, { actuator: true, requires_duration: false });
    assert.deepEqual(r.REBOOT_DEVICE, { actuator: false, requires_duration: false });
});

test('a duration-bounded actuator PASSES', () => {
    assert.doesNotThrow(() => assertActuatorCommandsAreDurationBounded({
        OPEN_FOR_DURATION: { actuator: true, requires_duration: true },
    }));
});

test('the CLOSE exemption is honored', () => {
    assert.ok(DURATION_EXEMPT_ACTUATORS.has('CLOSE'));
    assert.doesNotThrow(() => assertActuatorCommandsAreDurationBounded({
        CLOSE: { actuator: true, requires_duration: false },
    }));
});

test('a non-actuator without a duration bound PASSES', () => {
    assert.doesNotThrow(() => assertActuatorCommandsAreDurationBounded({
        REBOOT_DEVICE: { actuator: false, requires_duration: false },
    }));
});

test('a FUTURE unbounded actuator FAILS (the MClimate-shaped regression)', () => {
    assert.throws(() => assertActuatorCommandsAreDurationBounded({
        MCLIMATE_OPEN: { actuator: true, requires_duration: false },
    }), /MCLIMATE_OPEN.*duration-bounded/s);
});

test('parser rejects a registry whose set-call shape drifted', () => {
    assert.throws(() => parseCommandRegistry(registryNode('const X = {}; return msg;')),
        /no longer sets flow\.set/);
});
```

- [ ] **Step 2.2: Run — expect PASS** (all 6):

```bash
node --test scripts/verify-command-safety.test.js
```

- [ ] **Step 2.3: Commit**

```bash
git add scripts/verify-command-safety.test.js
git commit -m "test(ci): pin the future-unbounded-actuator failure class for the 3.0 gate (refactor-program 3.0)"
```

---

### Task 3: Wire the safety verifier into CI + PR

- [ ] **Step 3.1: Confirm current CI wiring** (verified fact 4 — re-check on the branch):

```bash
grep -rn "verify-command-safety" .github/workflows/
```
If it prints nothing, proceed to 3.2. If it is already wired, skip 3.2, note it in the PR body, and go to 3.3.

- [ ] **Step 3.2: Wire into `.github/workflows/migrations.yml`.** Add, alongside the other edge-verifier `- run:` lines (e.g. after `verify-heartbeat-health.js` or the nearest command/flows verifier), both the CLI and the test:

```yaml
      - run: node scripts/verify-command-safety.js
      - run: node --test scripts/verify-command-safety.test.js
```
(If `verify-command-safety.js` needs `sqlite3` on the runner — it calls `execFileSync('sqlite3', ...)` for the schema checks — confirm the workflow's runner already has `sqlite3` available; the existing migration verifiers in this workflow use it, so it should. If not, that is a pre-existing gap for the whole verifier, not introduced here — note it, do not silently skip.)

- [ ] **Step 3.3: Full local gate** (every command green):

```bash
node scripts/verify-command-safety.js
node --test scripts/verify-command-safety.test.js
```

- [ ] **Step 3.4: Update the program doc.** In `docs/architecture/refactor-program-2026.md`, Phase 3 row **3.0**, append: `— done: duration-bound assertion in verify-command-safety.js + test vectors + CI wiring, PR #<FILL IN>`.

```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): record 3.0 outcome (actuator duration-bound gate shipped)"
```

- [ ] **Step 3.5: Open the PR (do not merge):**

```bash
git push -u origin feat/actuator-safety-gate
gh pr create --title "Actuator duration-bound CI assertion (refactor-program 3.0, DD17)" --body "$(cat <<'EOF'
## Summary
- New assertion in `scripts/verify-command-safety.js`: every command type with `actuator: true` in the canonical Command Type Registry must be `requires_duration: true` OR on the tiny `DURATION_EXEMPT_ACTUATORS` allow-list (today: `CLOSE`, justified inline). Ships GREEN (baseline zero violations).
- Test vectors pin the failure class: a future unbounded actuator (e.g. an MClimate open) FAILS the merge that adds it.
- Wired `verify-command-safety.js` into `migrations.yml` (it was local-only before).

## ⚠️ Entry gate
**This PR merges BEFORE any MClimate downlink code (item 3.1).** DD17: a valve stuck open during a Node-RED crash-loop is crop damage; the device firmware must be the failsafe. This gate ensures the second actuator (MClimate T-Valve) cannot ship an unbounded open.

## Evidence
- `node scripts/verify-command-safety.js` — all existing checks + `ok all actuator command types are duration-bounded (or exempt: CLOSE)`; `verify-command-safety: OK`.
- `node --test scripts/verify-command-safety.test.js` — 6/6 pass incl. the synthetic future-unbounded-actuator FAIL vector.

Part of refactor-program item 3.0 (DD17).

## Test plan
- [ ] CI green on this PR
- [ ] Reviewer confirms the check fails if `requires_duration` is flipped to false on `OPEN_FOR_DURATION` (local spot-check)
EOF
)"
```

---

## Follow-ups (not tasks in this plan)

- **Fallback-copy parity** (`COMMAND_TYPES_FALLBACK` in `Reject Indefinite Open` / `Write STREGA Expectation` ⊆ canonical registry) — a separate small assertion, deferred (verified fact 3).
- **Item 3.1 (MClimate)** depends on this gate being merged first; the MClimate open command must land as `requires_duration: true` (or the check fails), forcing its codec/downlink to carry a device-side auto-close duration.
