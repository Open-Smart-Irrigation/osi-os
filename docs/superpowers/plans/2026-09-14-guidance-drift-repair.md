# Guidance Drift Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three guidance errors that make an agent fail outright, remove the stale counts and dead files found in the 2026-09-14 audit, and add one verifier so path citations in guidance go red instead of rotting.

**Architecture:** One new script, `scripts/verify-guidance-refs.js`, scans AGENTS.md, CLAUDE.md, README.md, the playbook, the versioning workflow, `docs/agents/*.md` and every `.claude/skills/*/SKILL.md` for repo-relative path citations and fails when one does not exist. It runs in CI and in the session closeout. Everything else is editorial: correct wrong instructions, delete pinned counts, move dated narrative out of AGENTS.md into `docs/`, and make CLAUDE.md load AGENTS.md automatically.

**Tech Stack:** Node 22 (`node:test`, no new dependencies), bash, GitHub Actions, `gh`.

**Spec:** The audit is the spec: `/home/phil/guidance-audit-2026-09-14.md` (three reviewer reports, every claim tagged VERIFIED or STALE). The re-verification that produced this plan is summarised in "Audit corrections" below.

## Global Constraints

- Prose edits under `docs/`, `AGENTS.md`, `README.md` and `SKILL.md` files must pass `node .claude/skills/anti-slop-writing/slop-check.js <file>` (`slop-check: PASS (no tier-1 findings)`, exit 0).
- No edit to `flows.json`, `database/`, `conf/`, `deploy.sh`, or any Pi. This is a documentation and verifier change only.
- No `npm install`, no GUI build. Reviewers and verifiers do not build (workstation OOMs on concurrent frontend builds).
- Executors work in a worktree cut from `origin/main`, never in Phil's checkout. Branch name: `docs/guidance-drift-repair`.
- Commit prefix `docs:` for guidance edits, `feat(verify):` for the new script, `chore:` for deletions.
- Report rather than force: if a quoted line in this plan is not found verbatim, locate the passage by its heading and content, and note the drift in the task report. If the passage is gone, stop and report.
- Three verifiers are red on `feat/valve-control` today for branch reasons, not guidance reasons: `verify-migrations.js` (branch lacks `0026__sdi12_columns.sql` which `origin/main` has), `verify-sync-op-parity.js` (server enum has two ops the edge union lacks), `verify-profile-parity.js` (uncommitted edit to the conf bootstrap copy). On a worktree cut from `origin/main` the first and third should be green. Report any red as `red-on-base` per `osi-verification-commands`; do not fix inside this plan.

## Audit corrections

Re-verification on 2026-09-14 changed four audit findings:

| Audit claim | Re-verified state |
|---|---|
| Two divergent `chirpstack-bootstrap.js` copies | The committed copies are byte-identical. Only an uncommitted two-line comment deletion differs. The real gap is that no verifier pins the pair. Task 5 adds that pin. |
| Forge skill branch pattern is stale | The skill (2026-07-16) describes a `forge/...` contract; `osi-server/forge/pipeline.py:76` creates and `gates.py:85` requires `agent/req-*` (2026-07-11). The skill describes a contract the code never shipped. Task 8 makes the skill state what is enforced. |
| Closed issues in the memory index | Confirmed closed: 22, 50, 87, 89, 92. |
| Live-ops runbook says do not hand-restart | Confirmed at `SKILL.md:221` and `:591`. `deploy.sh` restarts Node-RED at lines 281 and 380. README tells the reader to restart in four places; the memory deploy guardrail does too. |

## Execution strategy (quality and token budget)

Tasks are grouped into three waves so that cheap mechanical edits run in parallel on a small model and the judgment work goes to a strong one.

| Wave | Tasks | Model | Why |
|---|---|---|---|
| A, parallel, disjoint files | 1, 2, 3, 4 | Sonnet | Line-anchored text edits with the replacement text given in full. No design. |
| B, sequential, after A | 5, 6, 7, 8 | Opus | New verifier with tests (its real-repo test needs Task 1 merged); AGENTS.md restructure; single-home pass-signal table; Forge contract wording. |
| C, orchestrator inline | 9, 10 | Main session | Files outside the repo (memory index, global skills). |
| Final | 11 | Opus, fresh context | Independent verification of the whole branch against this plan. |

Token rules for executors: read only the line ranges named in the task, never a whole 600-line skill. Do not re-run the audit. Do not run `verify-sync-flow.js` (it chains a dozen verifiers) unless the task names it; each task names its own gate. One commit per task.

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `scripts/verify-guidance-refs.js` | create | Path-citation checker for guidance files. |
| `scripts/verify-guidance-refs.test.js` | create | Known-bad and known-good fixtures for the checker. |
| `scripts/verify-profile-parity.js` | modify | Add the `scripts/` ↔ `conf/` bootstrap pair. |
| `scripts/session-closeout.sh` | modify | Run the checker in the documentation section. |
| `.github/workflows/verify-sync-flow.yml` | modify | Run the checker in CI. |
| `CLAUDE.md` | modify | `@AGENTS.md` import. |
| `AGENTS.md` | modify | Move dated narrative out; fix catalog; refresh verifier list; drop issue list; docs index link. |
| `docs/README.md` | create | Index of `docs/` subdirectories. |
| `docs/architecture/chameleon-calibration.md`, `docs/architecture/valve-control.md`, `docs/operations/live-gateway-identity.md` | create | Homes for the moved AGENTS.md narrative. |
| `docs/superpowers/reports/2026-07-15-live-gateway-identity-execution-report.md` | move from `execution-report.md` | Branch-scoped report out of the repo root. |
| `docs/versioning-workflow.md`, `README.md`, `docs/agents/typescript-rule-overlays.md` | modify | Executable errors and stale tables. |
| `.claude/skills/{osi-flows-json-editing,osi-debugging-playbook,osi-config-and-flags,osi-agronomy-sensors-reference,osi-live-ops-runbook,osi-schema-change-control,osi-verification-commands,osi-sync-contract-awareness,osi-forge-boundaries}/SKILL.md` | modify | Stale counts, duplicated sections, missing rows. |
| `.claude/skills/osi-hardest-problem-campaign/` | delete | Placeholder. |
| `.claude/settings.json` | modify | Drop the permission line for a deleted global skill. |
| `~/.claude/skills/code-reviewer/`, `~/.claude/skills/frontend-design/` | delete (outside repo) | Collide with built-in skills. |
| `~/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md` | modify (outside repo) | Closed issues, stale handoffs, restart step. |

---

### Task 1: Versioning workflow uses a directory that does not exist

**Files:**
- Modify: `docs/versioning-workflow.md` (Step 3 block near line 80, Step 8 block near line 194)

Vite writes to `web/react-gui/build` (`web/react-gui/vite.config.js:34`, `outDir: 'build'`). The workflow tars `dist`. Its Step 8 example also targets production by default, against the AGENTS.md production gate.

- [ ] **Step 1: Confirm the defect**

Run: `grep -n "react-gui/dist\|rocky@osicloud.ch" docs/versioning-workflow.md`
Expected: three hits (lines 80, 85, 194).

- [ ] **Step 2: Replace `dist` with `build`**

Change

```bash
tar -czf react_gui.tar.gz -C web/react-gui/dist .
```

to

```bash
tar -czf react_gui.tar.gz -C web/react-gui/build .
```

and

```bash
grep -r "v0\." web/react-gui/dist/ | head -5
```

to

```bash
grep -r "v0\." web/react-gui/build/ | head -5
```

- [ ] **Step 3: Point the Step 8 example at the test host**

Change

```bash
ssh -i /path/to/ephemeral-key rocky@osicloud.ch <<'REMOTE'
```

to

```bash
# Test host shown. Production (osicloud.ch) needs explicit consent in the current
# conversation; see AGENTS.md "Production cloud access".
ssh -i /path/to/ephemeral-key rocky@server.opensmartirrigation.org <<'REMOTE'
```

- [ ] **Step 4: Gate**

Run: `grep -c "react-gui/dist" docs/versioning-workflow.md; node .claude/skills/anti-slop-writing/slop-check.js docs/versioning-workflow.md`
Expected: `0`, then `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 5: Commit**

```bash
git add docs/versioning-workflow.md
git commit -m "docs(versioning): tar the build dir Vite writes, default the rollout example to the test host"
```

---

### Task 2: README executable errors and stale tables

**Files:**
- Modify: `README.md` (lines 59-65 device table, 85 tree comment, 125-133 flows recipe, 205-218 and 308-318 deploy blocks, 230 manual block)

- [ ] **Step 1: Remove the stray slash**

In the `<details>` manual-deployment block, delete the line containing only `/` immediately after `PI=root@<pi-ip>`.

Run: `awk 'NR>=226 && NR<=232' README.md`
Expected afterwards: `PI=root@<pi-ip>` followed directly by the first `scp` line.

- [ ] **Step 2: Bind the file server to loopback**

Replace both occurrences of

```bash
python3 -m http.server 9876
```

with

```bash
python3 -m http.server 9876 --bind 127.0.0.1
```

- [ ] **Step 3: Drop the manual restart after deploy.sh**

`deploy.sh` restarts Node-RED itself (lines 281 and 380) and the live-ops runbook tells operators not to restart by hand. In the block at lines 205-218 replace

```bash
# 4. Restart Node-RED
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

with

```bash
# 4. Nothing to restart: deploy.sh restarts Node-RED itself and prints a verdict.
#    Read the verdict; a manual restart after a green deploy only hides a failed one.
```

In the block at lines 308-318 delete the line `ssh root@<pi-ip> '/etc/init.d/node-red restart'`. Leave the standalone flows-only recipe at lines 125-133 and the bootstrap recipe at line 265 unchanged; those paths do not go through `deploy.sh`.

- [ ] **Step 4: Fix the CI comment**

Replace

```
├── Jenkinsfile             # CI/CD pipeline
```

with

```
├── Jenkinsfile             # Legacy; CI runs from .github/workflows/
```

- [ ] **Step 5: Bring the device table up to the catalog**

Replace the table body under "Supported Field Devices" with

```
| Device type          | Description                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- |
| **KIWI_SENSOR**      | Soil water tension (kPa), soil moisture                                                |
| **TEKTELIC_CLOVER**  | Volumetric water content (%), soil moisture                                            |
| **DRAGINO_LSN50**    | Multi-mode: temperature probe, ADC (dendrometer potentiometer), rain gauge, flow meter |
| **SENSECAP_S2120**   | Weather station (wind, rain, UV, barometric pressure)                                  |
| **AQUASCOPE_LORAIN** | Interval rain gauge with ambient temperature and battery                               |
| **STREGA_VALVE**     | Gen1 and Gen2 (SV2) motorized or solenoid irrigation valve with on-valve scheduler     |
| **MILESIGHT_UC512**  | Two-channel valve controller with pulse counters and pipe pressure                     |
```

- [ ] **Step 6: Gate**

Run: `grep -c "^/$" README.md; grep -c "http.server 9876 --bind" README.md; node .claude/skills/anti-slop-writing/slop-check.js README.md`
Expected: `0`, `2`, `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs(readme): remove stray slash, bind file server to loopback, drop redundant restart, refresh device table"
```

---

### Task 3: Remove pinned counts and dated claims from five skills

**Files:**
- Modify: `.claude/skills/osi-flows-json-editing/SKILL.md:528,540-543`
- Modify: `.claude/skills/osi-debugging-playbook/SKILL.md:44-54,64,75-86`
- Modify: `.claude/skills/osi-config-and-flags/SKILL.md:104-113,463-505`
- Modify: `.claude/skills/osi-agronomy-sensors-reference/SKILL.md:50-51,89,463,470`
- Modify: `.claude/skills/osi-live-ops-runbook/SKILL.md:310-320`

Each pinned number below was wrong on 2026-09-14. The replacement text states the rule and the command that recomputes the number.

- [ ] **Step 1: Flows skill, parity line count**

Replace

```
... (25 OK: / absent: lines total — 20 file-parity checks incl. flows.json, 5 absence checks)
```

with

```
... (one OK: line per CANONICAL_PAYLOAD entry, one absent: line per FORBIDDEN_IN_MIRROR entry; the lists live in scripts/verify-profile-parity.js)
```

- [ ] **Step 2: Flows skill, mqtt-in count**

Replace the sentence starting `Confirmed by inspecting all 7 \`mqtt in\`` through `all 7 use exactly that topic string.` with

```
Every `mqtt in` node in the canonical file uses exactly that topic string; list
them with `grep -c '"type": "mqtt in"' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
and let `scripts/check-mqtt-topics.sh` do the checking rather than trusting a count written here.
```

- [ ] **Step 3: Debugging playbook, GUI test block**

Replace the section body from `As of 2026-07-06, \`web/react-gui/package.json\` defines:` through the closing triple backtick of the JSON block with

```
`web/react-gui/package.json` defines `test:unit` as two chained runners; read the
current definition with `grep -n '"test:unit' web/react-gui/package.json` rather
than trusting a copy here. The vitest half runs an explicit directory allow-list,
so a new `__tests__` directory is silently skipped until it is added there.
```

Keep the paragraph that follows (the `npx vitest run` warning).

- [ ] **Step 4: Debugging playbook, migrations row**

In the `scripts/verify-migrations.js` table row replace the caveat cell text `CI-gated via \`.github/workflows/migrations.yml\`. Verified clean in this worktree on 2026-07-06: \`verify-migrations: OK (2 migrations)\`` with `CI-gated via \`.github/workflows/migrations.yml\`. Compares against \`origin/main\`; a branch behind main fails with \`base migration missing\`, which is red-on-base, not your change`.

- [ ] **Step 5: Debugging playbook, duplicated method section**

Replace the whole `## Debugging method` section (heading through item 7) with

```
## Debugging method

Follow `docs/engineering-playbook.md` §6 ("When you are stuck or debugging").
The one repo-specific addition: the `duplicate column` row in the triage table
is the canonical case of a signal with a different cause than it pattern-matches
to (issue #84, a stale test baseline, not the boot DDL).
```

- [ ] **Step 6: Config skill, missing export**

In the note starting `Note: \`chirpstack-bootstrap.js\` writes both`, change every `both` to `all three`, and change `omit both \`CHIRPSTACK_PROFILE_LORAIN\` and \`CHIRPSTACK_PROFILE_UC512\`` to `omit \`CHIRPSTACK_PROFILE_LORAIN\`, \`CHIRPSTACK_PROFILE_UC512\` and \`CHIRPSTACK_PROFILE_STREGA_GEN2\``. Change `the LoRain and Milesight UC512 profile IDs arrive only` to `the LoRain, Milesight UC512 and STREGA Gen2 profile IDs arrive only`. Change `(as of 2026-07-19)` to `(as of 2026-09-14; recheck with \`grep -c STREGA_GEN2 feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init\`, expected 0 until plumbed)`.

Also add `chirpstack_profile_strega_gen2` to the UCI key list in the section 1 table row that begins `| \`chirpstack_profile_kiwi\`` (after `chirpstack_profile_uc512`).

- [ ] **Step 7: Config skill, delete the duplicated deploy.sh section**

Replace the entire `## 6. \`deploy.sh\` knobs` section (heading through the line before `## 7. Feature flags`) with

```
## 6. `deploy.sh` knobs

`deploy.sh` tunables (`PAYLOAD_KEEP_N`, `MIGRATE_BACKUP_DIR`, canary-gate
values) are documented once, in `osi-live-ops-runbook` under "What deploy.sh
actually does end-to-end". Read them there; two descriptions of one script
drift.

```

- [ ] **Step 8: Agronomy skill, decoder inventory and line pins**

Replace the decoder file list line

```
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/{aquascope_lorain_decoder.js, dragino_lsn50_decoder.js, milesight_uc512_decoder.js, sensecap_s2120_decoder.js, strega_gen1_decoder.js}`.
```

with

```
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/` (list with `ls` there; as of 2026-09-14: aquascope_lorain, dragino_lsn50, milesight_uc512, sensecap_s2120, strega_gen1, strega_gen2).
```

Replace `The irrigation scheduler's decision rule is \`const irrigate = (meanKpa >= threshold);\`` with `The irrigation scheduler compares \`meanKpa >= threshold\` (drier soil reads as a larger positive kPa); locate the current predicate with the grep in the provenance section`.

Replace `(\`strega_gen1_decoder.js:224\`, added in \`d261d2c7\`)` with `(\`strega_gen1_decoder.js\`, the \`box_temp === 65535 && box_hum === 65535\` guard, added in \`d261d2c7\`)`.

Replace `(\`chirpstack-bootstrap.js:97\`)` with `(\`chirpstack-bootstrap.js\`, the \`stregaCodecPath\` and \`stregaGen2CodecPath\` provisioning; Gen2 is provisioned from \`strega_gen2_decoder.js\`, not from the vendor file)`.

- [ ] **Step 9: Live-ops runbook, helper and codec inventory**

Replace the step-6 sentence from `the full helper-module set (` through `five device codecs (STREGA, LSN50, S2120, LoRain, UC512),` with

```
   the full helper-module set (every `fetch_required "<name> package.json"` in
   `deploy.sh`; 20 modules on 2026-09-14, list them with
   `grep -o 'fetch_required "[^"]*package.json"' deploy.sh`), `edge-channels.json`,
   the `chirpstack-bootstrap.js` bootstrap script, every file under `codecs/`
   that `deploy.sh` names (six device decoders on 2026-09-14),
```

- [ ] **Step 10: Gate**

Run:

```bash
node .claude/skills/anti-slop-writing/slop-check.js \
  .claude/skills/osi-flows-json-editing/SKILL.md \
  .claude/skills/osi-debugging-playbook/SKILL.md \
  .claude/skills/osi-config-and-flags/SKILL.md \
  .claude/skills/osi-agronomy-sensors-reference/SKILL.md \
  .claude/skills/osi-live-ops-runbook/SKILL.md
grep -c "all 7\|25 OK\|2 migrations\|2026-07-06, \`web" .claude/skills/*/SKILL.md | grep -v ":0$"
```

Expected: `slop-check: PASS (no tier-1 findings)`; the grep prints nothing.

- [ ] **Step 11: Commit**

```bash
git add .claude/skills
git commit -m "docs(skills): replace pinned counts and dated claims with the commands that recompute them"
```

---

### Task 4: Delete the placeholder skill, fix the overlay doc, relocate the root execution report

**Files:**
- Delete: `.claude/skills/osi-hardest-problem-campaign/`
- Modify: `AGENTS.md` (skills index line 296, count at line 301)
- Modify: `docs/agents/typescript-rule-overlays.md`
- Move: `execution-report.md` → `docs/superpowers/reports/2026-07-15-live-gateway-identity-execution-report.md`

- [ ] **Step 1: Check nothing pins the skill by path**

Run: `grep -rn "hardest-problem" scripts .github .claude/settings.json .claude/settings.local.json`
Expected: no output. (Mentions in `docs/superpowers/specs` and `plans` are historical and stay.)

- [ ] **Step 2: Delete and unindex**

```bash
git rm -r .claude/skills/osi-hardest-problem-campaign
```

In `AGENTS.md` delete the line `- \`osi-hardest-problem-campaign\` — deferred stub; do not author without maintainer input.` and change `The 14 project skills above load` to `The 13 project skills above load`.

- [ ] **Step 3: Say where the overlays live**

In `docs/agents/typescript-rule-overlays.md` replace

```
This repo uses OSI-owned `architect.yaml` and `RULES.yaml` files as advisory TypeScript overlays for agent work.
```

with

```
This repo uses OSI-owned `architect.yaml` and `RULES.yaml` files, both at the repo root (not under `web/react-gui/`), as advisory TypeScript overlays for agent work.
```

- [ ] **Step 4: Move the execution report**

```bash
mkdir -p docs/superpowers/reports
git mv execution-report.md docs/superpowers/reports/2026-07-15-live-gateway-identity-execution-report.md
grep -rn "execution-report.md" AGENTS.md README.md docs/engineering-playbook.md .github/workflows
```

Expected grep: no output. (The `osi-verification-commands` and `osi-forge-boundaries` skills name `execution-report.md` as the per-worktree report convention; that is a different file and stays.)

- [ ] **Step 5: Gate**

Run: `test ! -e execution-report.md && test ! -d .claude/skills/osi-hardest-problem-campaign && ls .claude/skills | wc -l`
Expected: `13`.

- [ ] **Step 6: Commit**

```bash
git add -A AGENTS.md docs/agents/typescript-rule-overlays.md docs/superpowers/reports
git commit -m "chore(guidance): drop placeholder skill, locate the TS overlays, move the branch report out of the root"
```

---

### Task 5: `verify-guidance-refs.js` and the bootstrap pair pin

**Files:**
- Create: `scripts/verify-guidance-refs.js`
- Create: `scripts/verify-guidance-refs.test.js`
- Modify: `scripts/verify-profile-parity.js` (after the `MIRROR_PROFILES` loop, before `if (failures > 0)`)
- Modify: `scripts/session-closeout.sh` (in the "Documentation consistency" section, after the CLAUDE.md block)
- Modify: `.github/workflows/verify-sync-flow.yml` (new step after the skill-symlink step)

**Interfaces:**
- Produces: `module.exports = { scanFile, run }` where `scanFile(rootDir, relFile) → { checked: number, missing: Array<{file, line, ref}> }` and `run(rootDir, relFiles) → exitCode`.
- CLI: `node scripts/verify-guidance-refs.js [--root <dir>] [relFile ...]`. With no files it scans the default set. Prints `verify-guidance-refs: OK (<n> refs in <m> files)` or one `FAIL: <file>:<line>: <ref> (not found)` per miss and `verify-guidance-refs: FAIL (<k> missing)`, exit 1.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
// Tests for scripts/verify-guidance-refs.js. The fixture models the 2026-09-14
// audit defect: docs/versioning-workflow.md tarred web/react-gui/dist, a
// directory Vite never writes, and nothing went red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'verify-guidance-refs.js');

function fixture(docText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-refs-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'scripts', 'real.js'), '');
  fs.writeFileSync(path.join(root, 'docs', 'present.md'), '# present\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), docText);
  return root;
}

function runCli(root) {
  let out, code = 0;
  try { out = execFileSync('node', [SCRIPT, '--root', root, 'docs/guide.md'], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status; }
  return { out, code };
}

test('a missing backticked path and a missing link target go red; skips are honoured', () => {
  const root = fixture([
    '# guide',
    'Real: `scripts/real.js` and `node scripts/real.js --flag`.',
    'Gone: `scripts/gone.js`.',
    'Link ok: [p](present.md). Link gone: [q](missing.md).',
    'Skipped: `/data/db/farming.db` `../osi-server/AGENTS.md` `scripts/verify-*.js`',
    'Skipped: `docs/superpowers/plans/YYYY-MM-DD-«slug».md` `conf/...bcm2712/files/` https://example.com/scripts/x.js',
    'Line anchor ok: `scripts/real.js:42`. Placeholder: `docs/NNNN__slug.md`.',
    '```bash',
    'tar -czf x.tar.gz -C scripts/fenced-gone .',
    'node scripts/real.js',
    '```',
    '',
  ].join('\n'));
  const { out, code } = runCli(root);
  assert.strictEqual(code, 1, out);
  assert.match(out, /FAIL: docs\/guide\.md:3: scripts\/gone\.js \(not found\)/);
  assert.match(out, /FAIL: docs\/guide\.md:4: missing\.md \(not found\)/);
  assert.match(out, /FAIL: docs\/guide\.md:9: scripts\/fenced-gone \(not found\)/);
  assert.doesNotMatch(out, /real\.js/);
  assert.doesNotMatch(out, /farming\.db|osi-server|verify-\*|«slug»|bcm2712|example\.com|NNNN/);
  assert.match(out, /verify-guidance-refs: FAIL \(3 missing\)/);
});

test('a clean document exits 0 with a count', () => {
  const root = fixture('# guide\n`scripts/real.js` and [p](present.md).\n');
  const { out, code } = runCli(root);
  assert.strictEqual(code, 0, out);
  assert.match(out, /verify-guidance-refs: OK \(2 refs in 1 files\)/);
});

test('an empty root is a failure, never a green run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-refs-empty-'));
  let out, code = 0;
  try { out = execFileSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status; }
  assert.strictEqual(code, 2, out);
  assert.match(out, /no guidance files found/);
});

test('the real repo guidance set has no missing references', () => {
  const root = path.resolve(__dirname, '..');
  let out, code = 0;
  try { out = execFileSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status; }
  assert.strictEqual(code, 0, out);
});
```

Save as `scripts/verify-guidance-refs.test.js`.

- [ ] **Step 2: Run it to watch it fail**

Run: `node --test scripts/verify-guidance-refs.test.js`
Expected: 4 failing tests; the first three fail because `verify-guidance-refs.js` cannot be found (`ENOENT` or `Cannot find module`).

- [ ] **Step 3: Write the checker**

```js
#!/usr/bin/env node
'use strict';
// Fails when a guidance file cites a repo-relative path that does not exist.
// Guidance rots one citation at a time (the 2026-09-14 audit found ~1 in 5
// concrete claims stale); this turns a dead path into a red exit code.
//
// What is checked:
//   - backticked tokens and every word inside a ``` fenced block, split on
//     whitespace, whose first segment is one of ROOTS (scripts/, docs/,
//     conf/, ...). `scripts/x.js:42` drops the anchor.
//   - markdown link targets without a URL scheme, resolved from the citing
//     file's directory.
// What is skipped on purpose: absolute paths (Pi filesystem), `~`, `../`
// (sister repo), URLs, globs and placeholders (`*`, `{`, `«`, `...`, `<`,
// `NNNN`, `YYYY`).

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'docs/engineering-playbook.md',
  'docs/versioning-workflow.md',
  'docs/agents/typescript-rule-overlays.md',
  'docs/agents/workflow-prompts.md',
];
const ROOTS = new Set(['scripts', 'docs', 'conf', 'web', 'lib', 'database', 'feeds', '.claude', '.github', '.agents']);
const SKIP_CHARS = /[*{}<>«»|]|\.\.\.|NNNN|YYYY/;

function defaultSources(rootDir) {
  const out = DEFAULT_SOURCES.slice();
  const skillsDir = path.join(rootDir, '.claude', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir).sort()) {
      const rel = path.join('.claude', 'skills', d, 'SKILL.md');
      if (fs.existsSync(path.join(rootDir, rel))) out.push(rel);
    }
  }
  return out.filter((f) => fs.existsSync(path.join(rootDir, f)));
}

function normalise(token) {
  let t = token.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  if (t.startsWith('/') || t.startsWith('~') || t.startsWith('../')) return null;
  if (SKIP_CHARS.test(t)) return null;
  t = t.replace(/^\.\//, '').replace(/[.,;:)]+$/, '').replace(/:\d+(-\d+)?$/, '').replace(/\/$/, '');
  return t || null;
}

function wordRefs(text) {
  const refs = [];
  for (const word of text.split(/\s+/)) {
    const t = normalise(word);
    if (t && ROOTS.has(t.split('/')[0])) refs.push({ ref: t, fromFileDir: false });
  }
  return refs;
}

function backtickRefs(line) {
  const refs = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(line)) !== null) refs.push(...wordRefs(m[1]));
  return refs;
}

function linkRefs(line) {
  const refs = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const target = m[1].split('#')[0];
    if (!target || target.startsWith('#') || target.startsWith('mailto:')) continue;
    const t = normalise(target);
    if (t) refs.push({ ref: t, fromFileDir: true });
  }
  return refs;
}

function scanFile(rootDir, relFile) {
  const abs = path.join(rootDir, relFile);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const missing = [];
  let checked = 0;
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    const found = fenced ? wordRefs(line) : [...backtickRefs(line), ...linkRefs(line)];
    for (const { ref, fromFileDir } of found) {
      checked += 1;
      const base = fromFileDir ? path.dirname(abs) : rootDir;
      if (!fs.existsSync(path.resolve(base, ref))) missing.push({ file: relFile, line: i + 1, ref });
    }
  });
  return { checked, missing };
}

function run(rootDir, relFiles) {
  const files = relFiles.length ? relFiles : defaultSources(rootDir);
  if (files.length === 0) {
    // A run that scans nothing must not look green.
    console.error(`verify-guidance-refs: FAIL (no guidance files found under ${rootDir})`);
    return 2;
  }
  let checked = 0;
  const missing = [];
  for (const f of files) {
    const r = scanFile(rootDir, f);
    checked += r.checked;
    missing.push(...r.missing);
  }
  for (const m of missing) console.error(`FAIL: ${m.file}:${m.line}: ${m.ref} (not found)`);
  if (missing.length) {
    console.error(`verify-guidance-refs: FAIL (${missing.length} missing)`);
    return 1;
  }
  console.log(`verify-guidance-refs: OK (${checked} refs in ${files.length} files)`);
  return 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let rootDir = path.resolve(__dirname, '..');
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root') { rootDir = path.resolve(args[i + 1]); i += 1; }
    else files.push(args[i]);
  }
  process.exit(run(rootDir, files));
}

module.exports = { scanFile, run };
```

Save as `scripts/verify-guidance-refs.js`.

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/verify-guidance-refs.test.js`
Expected: the three fixture tests PASS. The fourth (real repo) PASSES if Task 1 has landed on this branch; without Task 1 it FAILS on exactly two lines, `docs/versioning-workflow.md:80` and `:85`, both `web/react-gui/dist`. A dry run of this code on 2026-09-14 found no other miss across all guidance files. If the run lists anything else, it is either a genuine stale citation (fix the citing document in this task and list it in the report) or a false positive (extend `SKIP_CHARS` or `normalise` and add the shape to the first fixture test). Rerun until all three PASS.

- [ ] **Step 5: Prove it can go red on purpose**

Run: `printf '`scripts/nope.js`\n' > /tmp/claude-guidance-bad.md && node scripts/verify-guidance-refs.js --root /tmp claude-guidance-bad.md; echo "exit=$?"`
Expected: `FAIL: claude-guidance-bad.md:1: scripts/nope.js (not found)` then `exit=1`.

- [ ] **Step 6: Pin the bootstrap pair in the parity verifier**

In `scripts/verify-profile-parity.js`, insert immediately before `if (failures > 0) {`:

```js
// deploy.sh ships scripts/chirpstack-bootstrap.js; the flashed image ships the
// conf copy. Both reach a gateway, so they must be one file.
const SCRIPT_MIRRORS = [
  ['scripts/chirpstack-bootstrap.js', SOURCE_PROFILE + '/files/usr/share/node-red/chirpstack-bootstrap.js'],
];
console.log('\n=== scripts/ mirrors ===');
for (const [a, b] of SCRIPT_MIRRORS) {
  const ha = hashPath(path.join(REPO_ROOT, a));
  const hb = hashPath(path.join(REPO_ROOT, b));
  if (ha === null || hb === null) fail(`${a} <-> ${b}: one side missing`);
  else if (ha !== hb) fail(`${a}: content differs from ${b}`);
  else ok(`${a} == ${b}`);
}
```

Run: `node scripts/verify-profile-parity.js | tail -3`
Expected: `OK:   scripts/chirpstack-bootstrap.js == conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js` then `All parity checks passed.` (On a worktree from `origin/main` the copies are identical. If this line fails, report red-on-base; do not edit either copy.)

- [ ] **Step 7: Wire into closeout and CI**

In `scripts/session-closeout.sh`, after the `fi` that closes the `if [ -f "$CLAUDE_FILE" ]` block, insert:

```bash
if node "$REPO_ROOT/scripts/verify-guidance-refs.js" >/tmp/osi-guidance-refs.out 2>&1; then
  printf 'OK: %s\n' "$(tail -n 1 /tmp/osi-guidance-refs.out)"
else
  printf 'WARN: guidance cites missing paths:\n'
  cat /tmp/osi-guidance-refs.out
fi
```

In `.github/workflows/verify-sync-flow.yml`, after the `Skill-library symlink parity` step, add:

```yaml
      # Guidance files cite paths; a dead citation sends an agent to a file that
      # is not there (versioning workflow tarred web/react-gui/dist for months).
      - name: Guidance path citations exist
        run: |
          node scripts/verify-guidance-refs.js
          node --test scripts/verify-guidance-refs.test.js
```

- [ ] **Step 8: Gate**

Run: `bash -n scripts/session-closeout.sh && node scripts/verify-guidance-refs.js && node --test scripts/verify-guidance-refs.test.js 2>&1 | tail -4`
Expected: `verify-guidance-refs: OK (...)`, then `# pass 4` / `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add scripts/verify-guidance-refs.js scripts/verify-guidance-refs.test.js scripts/verify-profile-parity.js scripts/session-closeout.sh .github/workflows/verify-sync-flow.yml
git commit -m "feat(verify): guidance path-citation checker in CI and closeout; pin the scripts/conf bootstrap pair"
```

Also commit any guidance files corrected in Step 4 in a separate commit: `docs: fix path citations flagged by verify-guidance-refs`.

---

### Task 6: AGENTS.md restructure, CLAUDE.md import, docs index

**Files:**
- Modify: `AGENTS.md` (sections "Chameleon calibration global table", "Live gateway identity convergence", the LoRain / STREGA / Valve control paragraphs under "Device catalog", "Verification commands", "Issues", "Agent skills")
- Modify: `CLAUDE.md`
- Create: `docs/architecture/chameleon-calibration.md`, `docs/architecture/valve-control.md`, `docs/operations/live-gateway-identity.md`, `docs/README.md`

Decision recorded: CLAUDE.md gains `@AGENTS.md` so Claude Code loads the operational source of truth in every session, as Codex and OpenCode already do through their own conventions. Cost is roughly 3,500 tokens per session after the moves below (AGENTS.md drops from about 3,700 words to about 2,500). The playbook stays a link; `osi-common-pitfalls` carries its most-hit rules.

- [ ] **Step 1: Move the Chameleon section**

Create `docs/architecture/chameleon-calibration.md`:

```markdown
# Chameleon calibration

Moved verbatim from AGENTS.md on 2026-09-14. AGENTS.md keeps the invariants; this file keeps the mechanism.

```

then append, verbatim, every bullet from the AGENTS.md subsection `### Chameleon calibration global table` (from `- \`chameleon_calibrations\` — keyed by` through the `apply-chameleon-calibration-seed.js` bullet).

Replace that AGENTS.md subsection body with:

```markdown
- Canonical SWT is `device_data.swt_1..3` (kPa); `chameleon_readings` is the raw mirror. The sync trigger fires on INSERT only, so a historical repair must also enqueue `DEVICE_DATA_APPENDED` events.
- Calibration rows are global (`chameleon_calibrations`, keyed by `array_id`), fetched from the cloud by the sync worker; per-device coefficients were removed in the 2026-05-19 migration.
- Wiring: power the VIA reader from LSN50 `VDD`, never from switched 5 V without isolation.
- Tables, endpoints, release scripts and the outage analysis: [docs/architecture/chameleon-calibration.md](docs/architecture/chameleon-calibration.md).
```

- [ ] **Step 2: Move the identity section**

Create `docs/operations/live-gateway-identity.md` with the header line `# Live gateway identity convergence` and the sentence `Moved verbatim from AGENTS.md on 2026-09-14.`, then the three AGENTS.md paragraphs of `### Live gateway identity convergence` verbatim.

Replace that AGENTS.md subsection body with:

```markdown
- `osi-identityd` owns live identity after boot; Node-RED keeps one boot-time `DEVICE_EUI*` snapshot and fails closed during a transition.
- Identity transitions restart Node-RED through `/var/run/osi-node-red-restart-requests/`, never through the GUI `/api/system/reboot` route, and never by editing `sync-init-fn` or `runGatewayMigrationPreflight`.
- Cache phases, restart sentinel and heal path: [docs/operations/live-gateway-identity.md](docs/operations/live-gateway-identity.md).
```

- [ ] **Step 3: Move the valve narrative**

Create `docs/architecture/valve-control.md` with the header `# STREGA valve control` and the sentence `Moved verbatim from AGENTS.md on 2026-09-14.`, then the two AGENTS.md paragraphs beginning `**STREGA timed irrigation:**` and `**Valve control (2026-08):**` verbatim.

Replace those two paragraphs in AGENTS.md with:

```markdown
**STREGA valves:** opens are `OPEN_FOR_DURATION`; normal close is the valve's own timer, never a bare `CLOSE`. Cancellation is `POST /api/v1/valves/:deveui/cancel`. Weekly plans compile into the valve's on-board scheduler and are pushed only on user change, so Bluetooth edits on an SV2 survive. `valve_schedules` is edge-only until Phase B lands its sync triggers. Ports, ACK routing, ticks and expectation states: [docs/architecture/valve-control.md](docs/architecture/valve-control.md).
```

Replace the `**Aqua-Scope LoRain:**` paragraph with:

```markdown
**Aqua-Scope LoRain:** interval rainfall, never cumulative; duplicate or out-of-order timestamps must not aggregate twice. FPorts 10 and 2 are both accepted. The AppKey is retrieved from Aqua-Scope per DevEUI and must not enter this repo. Payload and aggregation detail: `osi-agronomy-sensors-reference`.
```

- [ ] **Step 4: Device catalog rows**

In the catalog table change `| STREGA_VALVE | Actuators | STREGA | Valve state, battery |` to `| STREGA_VALVE | Actuators | STREGA, STREGA Gen2 | Valve state, battery; Gen1 enclosure temp/humidity |` and append `| MILESIGHT_UC512 | Sensors | UC512 | Two valve states, pulse counters, pipe pressure |`.

- [ ] **Step 5: Verification block**

Append to the `## Verification commands` code block, before the two `cd web/react-gui` lines:

```bash
node scripts/verify-sync-op-parity.js         # edge/cloud sync op enum parity (needs ../osi-server)
node scripts/verify-guidance-refs.js          # paths cited in AGENTS.md/skills exist
```

and after the block add the line: `Full catalog with pass signals and the red-on-base rule: \`osi-verification-commands\` skill.`

- [ ] **Step 6: Issues section**

Replace the `## Issues` section body with:

```markdown
Tracked at https://github.com/Open-Smart-Irrigation/osi-os/issues. Do not trust an issue body or any list of open work in docs or memory: re-verify against current `main` and `gh issue view <n>` before planning. Several issues have turned out already fixed. Get the live set with `gh issue list --repo Open-Smart-Irrigation/osi-os --state open`.
```

- [ ] **Step 7: Docs index and CLAUDE.md import**

Create `docs/README.md`:

```markdown
# docs/ index

Start with [AGENTS.md](../AGENTS.md) and [engineering-playbook.md](engineering-playbook.md). Everything below is reference or history; AGENTS.md wins on conflict.

| Directory | Holds |
|---|---|
| `adr/` | Architecture decision records (plugin registry deferral, schema and contract ownership, scoped multi-user access). |
| `agents/` | Prompt skeletons for the four playbook roles; TypeScript rule-overlay workflow. |
| `architecture/` | System maps (plain and technical), controller designs, refactor program, Chameleon calibration, valve control. |
| `build/` | Firmware and Pi image build. |
| `contracts/` | Cross-repo contract fixtures: `dendro`, `history-router`, `sync-schema`, `zone-env`. |
| `hardware/` | Sensor wiring and vendor codec notes. |
| `operations/` | Runbooks and incident analyses: history retention, canary gate, LSN50 writer cutover, Uganda catch-up, live gateway identity. |
| `superpowers/` | Plans, specs, prompts and execution reports produced by the agent workflow. Dated; historical once merged. |
| `sync/` | History hash fixtures. |
| `twatch-ultra/` | T-Watch Ultra surveyor design package. |
| `ux/` | History visualisation specs and the timed-valve research brief. |
| top level | `engineering-playbook.md`, `versioning-workflow.md`, `channel-manifest.md`, `chameleon-integration.md`, `THIRD_PARTY_NOTICES.md`. |
```

In `AGENTS.md`, after the `Per-module system map` paragraph in `## Architecture`, add: `Index of everything under \`docs/\`: [docs/README.md](docs/README.md).`

In `AGENTS.md` `## Agent skills`, after the skills index list add: `GitHub Copilot custom agent: \`.github/agents/cleanup-specialist.agent.md\` (not used by Claude Code, Codex or OpenCode).`

In `CLAUDE.md`, replace the line `> **Start here:** [AGENTS.md](AGENTS.md) — operational source of truth (architecture, sync, file locations, conventions).` with:

```markdown
@AGENTS.md

> AGENTS.md above is loaded automatically and is the operational source of truth (architecture, sync, file locations, conventions).
```

- [ ] **Step 8: Gate**

Run:

```bash
node scripts/verify-guidance-refs.js
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md CLAUDE.md docs/README.md docs/architecture/chameleon-calibration.md docs/architecture/valve-control.md docs/operations/live-gateway-identity.md
wc -w AGENTS.md
bash scripts/session-closeout.sh 2>&1 | grep -E "^(OK|WARN)" | head -12
```

Expected: `verify-guidance-refs: OK`, `slop-check: PASS`, AGENTS.md under 2,700 words, closeout shows the three AGENTS.md `OK:` lines and the CLAUDE.md lines still OK (the branch-entry WARN is pre-existing).

- [ ] **Step 9: Commit**

```bash
git add AGENTS.md CLAUDE.md docs/README.md docs/architecture/chameleon-calibration.md docs/architecture/valve-control.md docs/operations/live-gateway-identity.md
git commit -m "docs(agents): auto-load AGENTS.md, move dated narrative to docs/, add UC512, index docs/"
```

---

### Task 7: One home for pass signals; red-on-base recipe

**Files:**
- Modify: `.claude/skills/osi-verification-commands/SKILL.md` (Command Table, new section before `## Surface Selection`)
- Modify: `.claude/skills/osi-sync-contract-awareness/SKILL.md` (the verifier list)
- Modify: `.claude/skills/osi-schema-change-control/SKILL.md` (the `find . -name farming.db` recipe)

- [ ] **Step 1: Add the missing rows**

In the Command Table of `osi-verification-commands`, after the `Contract schemas` row, add:

```
| Sync op parity | `node scripts/verify-sync-op-parity.js` | `verify-sync-op-parity: OK`. Needs the sister checkout at `../osi-server`. `server extra vs union: <OPS>` means the server enum is ahead of the edge union; land the edge half or extend the union, never delete the server op. |
| Guidance path citations | `node scripts/verify-guidance-refs.js` | `verify-guidance-refs: OK (<n> refs in <m> files)`. A `FAIL:` line names the citing file and line. |
```

- [ ] **Step 2: Red-on-base recipe**

Before `## Surface Selection` insert:

```markdown
## Telling red-on-base from red-by-you

1. `git status --short` empty and the verifier red: it is red on base. Report `red-on-base` with the output; do not fix it inside your patch.
2. Tree dirty: `git stash -u && node scripts/<verifier>.js; echo "exit=$?"; git stash pop`. Red before your changes is red-on-base.
3. Known base-red shapes on 2026-09-14: `verify-migrations: FAIL — base migration missing: <file>` (branch behind `origin/main`), `verify-sync-op-parity: FAIL` with `server extra vs union` (server enum ahead), `verify-profile-parity` FAIL on `files/usr/share/node-red` (an uncommitted conf edit).
```

- [ ] **Step 3: Point the other two skills here**

In `osi-sync-contract-awareness`, find the list item that names `verify-sync-op-parity.js` and append the sentence `Pass signal and the server-ahead failure shape: \`osi-verification-commands\`.`

In `osi-schema-change-control`, replace the `find . -name farming.db` command (whatever flags it carries) with `git ls-files '*farming.db'` and change the surrounding sentence to say the command lists the tracked copies only, which is the set the parity verifiers compare.

- [ ] **Step 4: Gate**

Run: `node .claude/skills/anti-slop-writing/slop-check.js .claude/skills/osi-verification-commands/SKILL.md .claude/skills/osi-sync-contract-awareness/SKILL.md .claude/skills/osi-schema-change-control/SKILL.md && git ls-files '*farming.db' | wc -l`
Expected: `slop-check: PASS`, then `7`.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills
git commit -m "docs(skills): single home for verifier pass signals, red-on-base recipe, tracked-copies recipe"
```

---

### Task 8: Forge skill states what the gate enforces

**Files:**
- Modify: `.claude/skills/osi-forge-boundaries/SKILL.md:20-22` and the two table rows plus bullets that name the `forge/...` shape (lines 34, 35, 50, 127, 129, 135)

`osi-server/forge/pipeline.py:76` creates `agent/req-<shortid>-<slug>`; `gates.py:85` rejects anything else. The skill's `forge/<repo>/<issue>-<slug>/attempt-<n>` shape was never implemented.

- [ ] **Step 1: Replace the verified-context paragraph**

Replace

```
Verified context: the current controller creates branches named
`forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>`. Legacy
`agent/req-*` branches remain readable only for historical jobs.
```

with

```
Verified context (2026-09-14): the shipped controller creates branches named
`agent/req-<shortid>-<slug>` (`osi-server/forge/pipeline.py`) and
`post_execution_gate` in `osi-server/forge/gates.py` rejects any other prefix.
The `forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>` shape from the
Stage 1 design is not implemented; a worker must push the branch the controller
assigned, whatever its shape, and never rename it.
```

- [ ] **Step 2: Update the table rows and bullets**

Replace each remaining literal `forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>` and `forge/*` with `the controller-assigned branch`. Delete the bullet beginning `Treat \`agent/req-*\` as a historical read-only shape`.

- [ ] **Step 3: Gate**

Run: `grep -c "forge/<repo\|forge/\*" .claude/skills/osi-forge-boundaries/SKILL.md; node .claude/skills/anti-slop-writing/slop-check.js .claude/skills/osi-forge-boundaries/SKILL.md`
Expected: `0`, `slop-check: PASS`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/osi-forge-boundaries/SKILL.md
git commit -m "docs(forge): describe the branch contract gates.py enforces, not the unshipped one"
```

Open question for Phil, not for the executor: should osi-server adopt the designed `forge/...` shape instead? If yes, that is an osi-server change and this skill flips back with it.

---

### Task 9: Memory index prune (orchestrator, outside the repo)

**Files:**
- Modify: `/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md`

- [ ] **Step 1: Refresh the issue bullet**

Run: `gh issue list --repo Open-Smart-Irrigation/osi-os --state open --json number,title --limit 100 | jq -r '.[] | "\(.number) \(.title)"'`

Replace the `osi-os open (2026-07-05): ...` bullet with `osi-os open (2026-09-14): <numbers and short titles from the command>`. Drop the `P0 #92` sentence (closed). Re-run the same command for `osi-server` and refresh that bullet too.

- [ ] **Step 2: Fix the deploy guardrail**

In the `Safe deploy flow` bullet replace `→ \`/etc/init.d/node-red restart\`. ChirpStack reprovisions on restart (osi-bootstrap START=99).` with `. deploy.sh restarts Node-RED itself and prints a verdict; do not restart by hand (osi-live-ops-runbook). ChirpStack reprovisions on restart (osi-bootstrap START=99).`

- [ ] **Step 3: One topic list, stale handoffs demoted**

Merge `## Topic memories (newest)` and `## Topic memories` into one `## Topic memories` list ordered newest first. For every entry dated before 2026-07-16 (60 days) whose hook reads RESUME, PENDING, NEXT PRIORITY, AWAITING, READY TO EXECUTE, MERGE-READY or UNCOMMITTED, rewrite the hook as a neutral one-line statement of what the file records and prefix it with `(historical)`. Keep the `feedback_*` and `reference*` entries unchanged. Do not delete files.

- [ ] **Step 4: Gate**

Run: `wc -w ~/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md; grep -c "NEXT PRIORITY\|RESUME\|READY TO EXECUTE" ~/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md; bash scripts/session-closeout.sh 2>&1 | grep MEMORY`
Expected: under 1,700 words; at most 3 live-status markers; the three MEMORY.md `OK:` lines.

---

### Task 10: Global skills that collide with built-ins (orchestrator, outside the repo)

**Files:**
- Delete: `~/.claude/skills/code-reviewer/`, `~/.claude/skills/frontend-design/`
- Modify: `.claude/settings.json` (the `Edit(~/.claude/skills/code-reviewer/**)` line)
- Modify: `AGENTS.md` `## Agent skills` (one sentence)

Both skills are preserved in `/home/phil/agent-guidance-2026-09-14.zip` under `global-claude/skills/`.

- [ ] **Step 1: Delete**

```bash
rm -r ~/.claude/skills/code-reviewer ~/.claude/skills/frontend-design
ls ~/.claude/skills
```

Expected: empty listing.

- [ ] **Step 2: Remove the dangling permission**

In `.claude/settings.json` delete the array entry `"Edit(~/.claude/skills/code-reviewer/**)",`. Run `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json'))"`; expected no output.

- [ ] **Step 3: Keep the one useful line**

In `AGENTS.md` `## Agent skills`, after the `osi-common-pitfalls` index line, add: `Any code review, including the built-in \`/code-review\`, loads \`osi-common-pitfalls\` first.`

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.json AGENTS.md
git commit -m "chore(guidance): drop permission for a removed global skill; reviews load the pitfalls card"
```

---

### Task 11: Independent verification (fresh Opus context, read-only)

- [ ] **Step 1: Diff against the plan**

Run: `git diff origin/main...HEAD --stat` and read every hunk. Every touched file must appear in "File structure" above; report any that does not.

- [ ] **Step 2: Re-run every gate fresh**

```bash
node scripts/verify-guidance-refs.js
node --test scripts/verify-guidance-refs.test.js
node scripts/verify-profile-parity.js | tail -3
bash -n scripts/session-closeout.sh && bash scripts/session-closeout.sh 2>&1 | grep -E "^(OK|WARN)"
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md CLAUDE.md README.md docs/README.md docs/versioning-workflow.md docs/architecture/chameleon-calibration.md docs/architecture/valve-control.md docs/operations/live-gateway-identity.md .claude/skills/*/SKILL.md
git diff --check
grep -rn "react-gui/dist" docs README.md
grep -c "@AGENTS.md" CLAUDE.md
ls .claude/skills | wc -l
```

Expected: OK / pass 4 fail 0 / `All parity checks passed.` / closeout OK lines / `slop-check: PASS` / no output / no output / `1` / `13`.

- [ ] **Step 3: Semantics probe**

Make the checker fail on purpose: append `` `scripts/does-not-exist.js` `` to a scratch copy of AGENTS.md under `/tmp` and run the checker with `--root /tmp` on it. It must exit 1. Then confirm the moved AGENTS.md text is verbatim: `git show origin/main:AGENTS.md | grep -c "Schl_Port"` must equal `grep -c "Schl_Port" docs/architecture/valve-control.md`.

- [ ] **Step 4: Verdict**

Deliver `VERDICT: GREEN` or `VERDICT: RED` with blocking items, plus a PR title and body carrying: the three executable errors fixed, the new verifier and what it caught in Task 5 step 4, the AGENTS.md word count before and after, and the open Forge question from Task 8.

---

## Self-review notes

Spec coverage: every "Findings that will actually hurt an agent" item and every "Structural weaknesses" item from the assessment maps to a task (errors → 1, 2, 8; red-on-base → 7; bootstrap pair → 5; memory → 9; auto-load → 6; counts → 3; pass-signal homes → 7; deploy.sh twice → 3 step 7; playbook copy → 3 step 5; AGENTS.md narrative and UC512 → 6; unindexed docs, root report, Copilot agent → 4 and 6; dead skills → 4 and 10). Not covered by design: splitting the STREGA block out of the agronomy skill into its own skill, and a generic count-drift checker; both are new design work and out of scope for a repair pass.
