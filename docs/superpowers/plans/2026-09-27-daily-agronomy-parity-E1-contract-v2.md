# Daily Agronomy Parity E1: Agronomy Contract v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docs/contracts/agronomy/` moves to contract version 2: every crop carries its FAO-56 Table 11 stage lengths with their provenance, the Kc resolver follows the FAO-56 curve (equation 66) from a stage start date in the edge helper, the edge GUI and the vector generator, `et0.js` gains the hourly FAO-56 Penman-Monteith chain (equation 53) proven against FAO-56 Example 19, and `verify-agronomy-contract.js` checks all of it, the cloud copies included when an osi-server checkout is given.

**Architecture:** The Table 11 transcription and its scripts move into `docs/contracts/agronomy/sources/`; `build_table11.py` writes `crop-kc.json` v2, which is byte-copied to the two edge helper profiles and the GUI. `scripts/build-kc-vectors.js` carries its own copy of the curve rule and writes 1,335 vectors that `osi-crop-kc`, `cropKc.ts` (and later the cloud) must reproduce exactly. `sources/hourly_et0.py`, an independent Python implementation, writes the two hourly vector groups that `et0.js` reproduces. No zone has a start date yet and the station tier does not call the hourly functions, so edge behaviour is unchanged (spec E).

**Tech Stack:** Node.js 22 (`node:test`), Python 3 (stdlib only), React + TypeScript + vitest + tsx (GUI tests only; no build), FAO-56 Table 11, Table 12, equations 7, 8, 11, 13, 22-33, 37-40, 45-47, 53, 54, 66.

**Spec:** `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` (Task 1 copies it into this repository from the osi-server branch). This plan implements A1-A9 and B1, and E row "E1".

**Prerequisites:** none. This plan runs first of the edge plans (the order the edge plan chair adopted: sub-project 3, E1, CA, CB, CC1, CC2, a controller rebase, E2a, E2b, E3, E4). The worktree `<osi-os>/.worktrees/daily-agronomy-parity` is on branch `feat/daily-agronomy-parity`, stacked on `feat/weather-data-view` (sub-project 3), which is stacked on `feat/daily-agronomy` (sub-project 2). E1 does not depend on sub-project 3's code: it touches neither the zone schema nor flows.json. The FAO-56 reference material, with the parsed Table 11 rows and the text rendering of the fetched page, lies in the git-ignored `.superpowers/sdd/2026-09-27-daily-agronomy-parity/fao56-ref/` of this worktree; it is called `$REF` below.

## Global Constraints

From the spec, verbatim:

- "The edge's `docs/contracts/agronomy/` stays the only source. Its `crop-kc.json` moves to `"version": 2`; every copy (edge helper, edge GUI, cloud backend, cloud frontend) is a byte copy, checked on both sides."
- "The parsed Table 11 rows and the parse script move from the SDD scratch directory into `docs/contracts/agronomy/sources/` (`table11-stage-lengths.json`, `build_table11.py`, `parse_table11.py`, `hourly_et0.py`), so the transcription can be re-run from the tree (spec decision; sub-project 2's README had to admit its Table 12 check could not be reproduced). The raw HTML is not committed. `build_table11.py` applies the A3 promotions and the three swaps above, so the committed `crop-kc.json` is its output."
- "`d` is computed on calendar dates, never on instants: `Date.UTC` parts in JavaScript, `ChronoUnit.DAYS.between` in Java. Daylight saving never shifts it."
- "The operation order is part of the contract: `prev + p * (next - prev)` in IEEE doubles, then `Math.round(kc * 100) / 100` (`Math.round` in Java and JavaScript both round half up for positive values)."
- "Every runtime reproduces every vector exactly (`kc` equal as a double after rounding, the three strings, `kcStageDay` and `stageOverrun` equal)."
- "The resolver returns `{ kc, kcSource, cropId, stage, kcStageDay, stageOverrun }` on every runtime."
- "`σh = 4.903e-9 / 24` written as that expression in every runtime."
- "The daily `fao56Et0` stays unchanged on the edge and remains the function the cloud's forecast tiers use."
- "GUI explanations in tooltips only" (E1 adds no GUI text).
- Cloud-side rule this plan feeds: the four cloud copies (`backend/src/main/resources/agronomy/crop-kc.json`, `frontend/src/agronomy/crop-kc.json`, `backend/src/test/resources/agronomy/kc-vectors.json`, `backend/src/test/resources/agronomy/et0-vectors.json`) are byte copies of the edge files (spec C1).

Operational rules for this plan:

- Work only in `<osi-os>/.worktrees/daily-agronomy-parity`; every command runs from its root unless a step says otherwise. Never `cd` into `<osi-os>` or `<osi-server>`; read osi-server with `git -C <osi-server>/.worktrees/daily-agronomy-cloud show <ref>:<path>` only. Never bare `git stash`. Never push.
- `$SCRATCH` is the session scratchpad directory; one-shot scripts live there and are never committed. `$REF` is `.superpowers/sdd/2026-09-27-daily-agronomy-parity/fao56-ref`.
- Every file changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is mirrored byte for byte to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`.
- GUI: `npm ci` once in `web/react-gui` (it installs, it does not build). Gates are `npm run typecheck`, `npm run test:unit`, and single files through `npx vitest run <file>` or `npx tsx --test <file>`. Never `npm run build`: the workstation runs out of memory.
- Commits use `git -c user.name=Project-OSI commit`.
- Prose (README) passes `node .claude/skills/anti-slop-writing/slop-check.js`.

## Review Focus

1. **A stage start date and a target date on either side of the spring clock change** (20 March to 9 April 2026 spans 29 March). The day count must be whole calendar days, day 21 of maize development, Kc 0.77, not one day less. Pinned in Task 3 (edge: "the curve counts calendar days: the spring clock change, a future start date, an impossible date"; GUI: "counts calendar days across the spring clock change and ignores an impossible start date").
2. **A start date that is not a calendar date** (`2026-02-30`, `05/01/2026`, an empty string, `yesterday`). The resolver must return the stage's table value with `kcStageDay` and `stageOverrun` null, never NaN or a thrown error. Pinned in Task 3 (same two tests).
3. **A stage whose Table 11 length is null** (`grass` late season, `conifer` in every stage). The table value applies and the curve fields stay null, never a division by null. Pinned in Task 3 (the `grass` vectors, the edge `stageLengths` test and the GUI test "keeps the table value for a stage without a length").
4. **A start date in the future** (the user types next week's date). p clamps at 0, Kc is the stage's starting value, `kcStageDay` is 0 or negative and `stageOverrun` false. Pinned in Task 3 (edge test, `dev('2026-05-10', '2026-05-01')`, and the `d = −5` vectors).
5. **A station day whose hourly values sum below zero** (a saturated winter day without sun) **and a day with one missing field.** The day is 0 mm, never negative; one null field voids the day instead of summing 23 hours. Pinned in Task 4 ("fao56Et0HourlyDay: priorRsRso before the first carry hour, a negative day is 0, one missing field voids the day").

## File Map

| File | Change | Task |
|---|---|---|
| `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` | byte copy of osi-server commit `ae1ecd93` (the spec without customer specifics) | 1 |
| `docs/contracts/agronomy/sources/table11_rows.json`, `table11-stage-lengths.json`, `parse_table11.py`, `build_table11.py`, `hourly_et0.py` | new: the Table 11 transcription and the two reference scripts | 2, 4 |
| `docs/contracts/agronomy/crop-kc.json` and its copies in both `osi-crop-kc` profiles and `web/react-gui/src/agronomy/` | version 2 | 2 |
| `scripts/verify-agronomy-contract.js` | v2 fields (2), curve vectors (3), hourly vectors (4), cloud copies (5) | 2-5 |
| `scripts/build-kc-vectors.js`, `docs/contracts/agronomy/kc-vectors.json` | the curve rule, 1,335 vectors | 3 |
| `.../osi-crop-kc/index.js`, `index.test.js` (both profiles) | `resolveKc` v2, `stageLengths`, `kcRamp` | 3 |
| `web/react-gui/src/agronomy/cropKc.ts`, `src/agronomy/__tests__/cropKc.test.ts`, `tests/agronomyKcVectors.test.ts` | the same in TypeScript | 3 |
| `.../osi-agronomy-daily/et0.js`, `et0.test.js` (both profiles), `docs/contracts/agronomy/et0-vectors.json` | `fao56HourlyTerms`, `fao56Et0Hourly`, `fao56Et0HourlyDay`; groups `fao56Hourly`, `fao56HourlyDays` | 4 |
| `.github/workflows/migrations.yml`, `docs/contracts/agronomy/README.md` | the cross-repo check; the v2 README | 5 |

In the tasks below `.../` stands for `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`.

---

### Task 1: The spec in the edge repository

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` (byte copy)

**Interfaces:**
- Produces: the spec every later edge plan (E2a, E2b, E3, E4) cites by this path.

- [ ] **Step 1: Copy the committed spec from the cloud branch**

osi-os is public and osi-server is private, so the edge repository carries only the spec commit that dropped the customer specifics (controller ruling on plan review E1-E3 I1: no live cloud hashes, no customer deploy-branch names, no commercial-instance line; the details stay in the private SDD ledger). That commit is osi-server `ae1ecd93` ("docs: spec errata (A9, B5, B6, stage-date default rule, generic customer wording); CB stage-date default") on `feat/daily-agronomy-parity`, checkout `<osi-server>/.worktrees/daily-agronomy-cloud`. Copy that commit's blob, not the working file, so the copy is byte-exact:

```bash
CLOUD_WT=<osi-server>/.worktrees/daily-agronomy-cloud
SPEC=docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md
git -C "$CLOUD_WT" log -1 --format='%h %s' feat/daily-agronomy-parity -- "$SPEC"
git -C "$CLOUD_WT" show "ae1ecd93:$SPEC" > "$SPEC"
cmp <(git -C "$CLOUD_WT" show "ae1ecd93:$SPEC") "$SPEC" && echo identical
grep -n -i -F -f .superpowers/sdd/2026-09-27-daily-agronomy-parity/customer-terms.txt "$SPEC" || echo "no customer specifics"
```
`customer-terms.txt` lies in the git-ignored SDD directory and lists the customer names, branch prefixes and live hashes the public tree must not carry; the plan does not repeat them. Expected: the log line names `ae1ecd93`, then `identical`, then `no customer specifics`. If the log names a later spec commit, stop and ask the controller which commit to copy: a later commit has not been checked for customer material, and the grep above is the minimum check, not a replacement for that review.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md
git -c user.name=Project-OSI commit -m "docs(spec): daily agronomy parity (byte copy of osi-server ae1ecd93)"
```

---

### Task 2: Table 11 sources and `crop-kc.json` version 2

**Files:**
- Create: `docs/contracts/agronomy/sources/table11_rows.json` (copied from `$REF/raw/`), `sources/table11-stage-lengths.json` (written by `build_table11.py`), `sources/parse_table11.py`, `sources/build_table11.py`, `sources/hourly_et0.py` (copied from `$REF`, the first two patched here)
- Modify: `docs/contracts/agronomy/crop-kc.json` (written by `build_table11.py`), its three copies (`.../osi-crop-kc/crop-kc.json`, the bcm2709 mirror, `web/react-gui/src/agronomy/crop-kc.json`), `scripts/verify-agronomy-contract.js`
- Scratch: `$SCRATCH/patch-parse-table11.py`, `$SCRATCH/patch-build-table11.py`

**Interfaces:**
- Produces: `crop-kc.json` with `"version": 2`; every crop keeps `id, group, label, kc_ini, kc_mid, kc_end, variant_of, fao_row` and gains `stage_lengths_days` and `stage_length_alternatives`, objects of the shape `{ initial, development, mid_season, late_season, table11_row, plant_date, region, selection_rule, verified }` (lengths: positive integers or null; an alternative may hold Table 11's printed 0). Task 3 reads `stage_lengths_days[stage]`.

- [ ] **Step 1: Write the failing check**

Replace `scripts/verify-agronomy-contract.js` with the version below. It adds the v2 checks (version 2, the nine fields of every length object, the alternatives array) and keeps the v1 vector loop, so it fails now on `version must be 2`:

```js
#!/usr/bin/env node
'use strict';
// verify-agronomy-contract: docs/contracts/agronomy is the source; every copy
// must be byte-identical, and the edge modules must reproduce the vectors.
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A1 and B1).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'contracts', 'agronomy');
const source = fs.readFileSync(path.join(dir, 'crop-kc.json'));
const copies = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'web/react-gui/src/agronomy/crop-kc.json',
];
const LENGTH_FIELDS = ['initial', 'development', 'mid_season', 'late_season'];
const PROVENANCE_FIELDS = ['table11_row', 'plant_date', 'region', 'selection_rule'];
const failures = [];
for (const rel of copies) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(rel + ': missing'); continue; }
  if (Buffer.compare(fs.readFileSync(abs), source) !== 0) failures.push(rel + ': differs from docs/contracts/agronomy/crop-kc.json');
}
const catalogue = JSON.parse(source.toString('utf8'));
if (catalogue.version !== 2) failures.push('crop-kc.json: version must be 2, found ' + catalogue.version);
const groups = new Set((catalogue.groups || []).map((g) => g.id));
for (const g of catalogue.groups || []) if (!['woody', 'annual'].includes(g.stageFamily)) failures.push('group ' + g.id + ': stageFamily must be woody or annual');
// A default length is a positive integer or null (A1). An alternative may
// also carry Table 11's printed 0 ("Faba bean, broad bean - green", late
// season): no code reads alternatives, and the cell stays verbatim.
function lengthRowProblems(label, s, allowZero = false) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [label + ' must be an object'];
  const keys = Object.keys(s);
  const want = [...LENGTH_FIELDS, ...PROVENANCE_FIELDS, 'verified'];
  if (keys.length !== want.length || want.some((k) => !keys.includes(k))) out.push(label + ' must have exactly ' + want.join(', '));
  for (const k of LENGTH_FIELDS) if (!(s[k] === null || (Number.isInteger(s[k]) && (s[k] > 0 || (allowZero && s[k] === 0))))) out.push(label + '.' + k + ' must be a positive integer or null');
  for (const k of PROVENANCE_FIELDS) if (typeof s[k] !== 'string') out.push(label + '.' + k + ' must be a string');
  if (typeof s.verified !== 'boolean') out.push(label + '.verified must be a boolean');
  return out;
}
const ids = new Set();
for (const crop of catalogue.crops) {
  if (ids.has(crop.id)) failures.push('duplicate crop id ' + crop.id);
  ids.add(crop.id);
  if (!groups.has(crop.group)) failures.push(crop.id + ': unknown group ' + crop.group);
  for (const k of ['kc_ini', 'kc_mid', 'kc_end']) if (!(crop[k] > 0 && crop[k] < 2)) failures.push(crop.id + ': ' + k + ' out of range');
  if (crop.variant_of && !catalogue.crops.some((c) => c.id === crop.variant_of && c.group === crop.group && !c.variant_of)) failures.push(crop.id + ': variant_of must name a default entry of the same group');
  failures.push(...lengthRowProblems(crop.id + '.stage_lengths_days', crop.stage_lengths_days));
  if (!Array.isArray(crop.stage_length_alternatives)) failures.push(crop.id + ': stage_length_alternatives must be an array');
  else crop.stage_length_alternatives.forEach((s, i) => failures.push(...lengthRowProblems(crop.id + '.stage_length_alternatives[' + i + ']', s, true)));
}
if (catalogue.crops.length !== 136) failures.push('expected 136 crops, found ' + catalogue.crops.length);
const kcModulePath = path.join(root, copies[0], '..', 'index.js');
if (fs.existsSync(kcModulePath)) {
  const kc = require(kcModulePath);
  const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'kc-vectors.json'), 'utf8'));
  let bad = 0;
  for (const v of vectors) {
    const r = kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage });
    if (r.kc !== v.kc || r.kcSource !== v.kcSource || r.cropId !== v.cropId || r.stage !== v.stage) { bad += 1; if (bad <= 5) failures.push('kc vector mismatch: ' + JSON.stringify(v) + ' got ' + JSON.stringify(r)); }
  }
  if (bad > 5) failures.push('kc vector mismatches: ' + bad);
}
const et0ModulePath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js');
if (fs.existsSync(et0ModulePath)) {
  const et0 = require(et0ModulePath);
  const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'et0-vectors.json'), 'utf8'));
  const near = (got, want, tol) => (want == null ? got === null : typeof got === 'number' && Math.abs(got - want) <= tol);
  for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) {
    const got = et0.fao56Et0(v.input);
    if (!near(got, v.et0Mm, 0.005)) failures.push('fao56 vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
  }
  for (const v of vectors.hargreaves) {
    const got = et0.hargreavesEt0(v.input);
    if (!near(got, v.et0Mm, 0.005)) failures.push('hargreaves vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
  }
  for (const v of vectors.luxToRadiation) {
    const got = et0.luxToWm2(v.lux, catalogue.luxPerWm2);
    if (!near(got, v.wm2, 0.01)) failures.push('lux vector ' + v.lux + ': expected ' + v.wm2 + ' got ' + got);
  }
  for (const v of vectors.elevationFromPressure) {
    const got = et0.elevationFromPressure(v.pressureKpa);
    if (!near(got, v.elevationM, 0.05)) failures.push('pressure vector ' + v.pressureKpa + ': expected ' + v.elevationM + ' got ' + got);
  }
}
if (failures.length) { console.error('verify-agronomy-contract: FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('verify-agronomy-contract: OK (' + catalogue.crops.length + ' crops, copies byte-identical, vectors reproduced where implementations exist)');
```

Run: `node scripts/verify-agronomy-contract.js`
Expected: `verify-agronomy-contract: FAIL` with `crop-kc.json: version must be 2, found 1` and 272 lines `<crop>.stage_lengths_days must be an object` / `<crop>: stage_length_alternatives must be an array`.

- [ ] **Step 2: Copy the sources into the tree**

```bash
REF=.superpowers/sdd/2026-09-27-daily-agronomy-parity/fao56-ref
mkdir -p docs/contracts/agronomy/sources
cp "$REF/raw/table11_rows.json" "$REF/parse_table11.py" "$REF/build_table11.py" "$REF/hourly_et0.py" docs/contracts/agronomy/sources/
sha256sum docs/contracts/agronomy/sources/table11_rows.json
```
Expected: `3b2c5ae085e884d12e3016ef05772b465998964e5b84d7b6e0278244926fbc9b`. The raw HTML and its text rendering stay in `$REF/raw/` and are not committed.

- [ ] **Step 3: `parse_table11.py` writes beside itself**

`$SCRATCH/patch-parse-table11.py`:
```python
# One-shot (plan E1, Task 2): parse_table11.py writes the committed table11_rows.json.
import pathlib
p = pathlib.Path("docs/contracts/agronomy/sources/parse_table11.py")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:70])
    s = s.replace(old, new)
swap('''"""Parse Table 11 rows from the fetched FAO-56 chapter 6 page (raw/x0490e0b.txt)."""
import re, json
txt = open("raw/x0490e0b.txt").read()
''', '''"""Parse Table 11 rows from a text rendering of the fetched FAO-56 chapter 6 page
(https://www.fao.org/4/x0490e/x0490e0b.htm) into table11_rows.json beside this file.
The text rendering is not committed; pass its path as the first argument."""
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
txt = open(sys.argv[1], encoding="utf-8").read()
''')
swap('''json.dump(rows, open("raw/table11_rows.json","w"), indent=1, ensure_ascii=False)''',
     '''json.dump(rows, open(os.path.join(HERE, "table11_rows.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)''')
p.write_text(s, encoding="utf-8")
print("parse_table11.py patched")
```
```bash
python3 "$SCRATCH/patch-parse-table11.py"
python3 docs/contracts/agronomy/sources/parse_table11.py "$REF/raw/x0490e0b.txt" > /dev/null
sha256sum docs/contracts/agronomy/sources/table11_rows.json
```
Expected: `parse_table11.py patched`, then the same hash as Step 2: the parse reproduces the committed rows byte for byte.

- [ ] **Step 4: `build_table11.py` writes `crop-kc.json` version 2**

The patch makes the script read `table11_rows.json` and `../crop-kc.json` relative to itself and appends the v2 writer: the A1 selection policy (already in the script's mapping `M`), the A4 rows without numbers (`PARTIAL`), the 16 A3 promotions with the agronomy review's basis (`PROMOTED`, `sudan_grass` keeping its first two lengths, `sisal` and `conifer` all null), the 21 crops that keep their group default, and the three R9 swaps (`SWAPS`).

`$SCRATCH/patch-build-table11.py`:
```python
# One-shot (plan E1, Task 2): build_table11.py runs from the tree and writes crop-kc.json v2.
import pathlib
p = pathlib.Path("docs/contracts/agronomy/sources/build_table11.py")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:70])
    s = s.replace(old, new)
swap('''import json, re

ROWS = json.load(open("raw/table11_rows.json"))
CAT = json.load(open("<osi-os>/.worktrees/daily-agronomy/docs/contracts/agronomy/crop-kc.json"))
''', '''import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE_PATH = os.path.join(HERE, "..", "crop-kc.json")
ROWS = json.load(open(os.path.join(HERE, "table11_rows.json"), encoding="utf-8"))
CAT = json.load(open(CATALOGUE_PATH, encoding="utf-8"))
''')
swap('''"""Build table11-stage-lengths.json from the fetched Table 11 rows (raw/table11_rows.json)''',
     '''"""Build table11-stage-lengths.json from the fetched Table 11 rows (table11_rows.json beside this file)''')
swap('"fetched": "2026-09-26 (raw HTML saved in raw/x0490e0b.htm; parsed rows in raw/table11_rows.json)",',
     '"fetched": "2026-09-26 (parsed rows in table11_rows.json, written by parse_table11.py from a text rendering of the page; the raw HTML is not committed)",')
swap('''json.dump(doc, open("table11-stage-lengths.json", "w"), indent=2, ensure_ascii=False)
print(doc["counts"])
''', '''with open(os.path.join(HERE, "table11-stage-lengths.json"), "w", encoding="utf-8") as fh:
    fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\\n")
print(doc["counts"])

# ---- crop-kc.json v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A1-A4) ----
# Every crop keeps its v1 fields and gains stage_lengths_days (the default row the
# code uses, provenance inline) and stage_length_alternatives (every other row).
STAGE_KEYS = ("initial", "development", "mid_season", "late_season")
V1_KEYS = ("id", "group", "label", "kc_ini", "kc_mid", "kc_end", "variant_of", "fao_row")

def lengths_of(idx, first_two_only=False):
    r = row(idx)
    if r["stage_lengths_days"] is not None:
        st = [r["stage_lengths_days"][k] for k in STAGE_KEYS]
    else:  # 'var.' and '--' rows print only the initial and development lengths (A4)
        st = [int(r["html_cells"]["init"]), int(r["html_cells"]["dev"]), None, None]
    if first_two_only:
        st = st[:2] + [None, None]
    return r, st

def v2_object(idx, selection_rule, verified, first_two_only=False):
    r, st = lengths_of(idx, first_two_only)
    out = dict(zip(STAGE_KEYS, st))
    out.update({"table11_row": r["table11_row"], "plant_date": r["plant_date"] or "", "region": r["region"] or "",
                "selection_rule": selection_rule, "verified": verified})
    return out

def null_object(selection_rule):
    out = dict.fromkeys(STAGE_KEYS)
    out.update({"table11_row": "", "plant_date": "", "region": "", "selection_rule": selection_rule, "verified": False})
    return out

def group_default_object(group_id):
    rule = "group default (%s): no Table 11 row for this crop" % group_id
    idx = GROUP_DEFAULTS[group_id][0]
    return null_object(rule) if idx == "evergreen" else v2_object(idx, rule, False)

# A3, controller ruling (b) and R4: the reference's closer row becomes the default;
# the basis is the agronomy review's reason. sudan_grass keeps the first two lengths.
PROMOTED = {
    "garlic": "bulb allium, 150-day season",
    "parsnip": "Apiaceae taproot like carrot",
    "turnip": "fresh root of 60-80 days",
    "chickpea": "cool-season grain legume harvested dry",
    "garbanzo": "same species as chickpea",
    "sisal": "perennial agave without seasonal stages",
    "rapeseed": "spring-sown oil crop of the same group",
    "alfalfa_seed": "same species",
    "clover_hay": "multi-cut legume hay, averaged cuttings",
    "clover_hay_cutting": "consistent with the alfalfa default",
    "sudan_grass": "averaged cuttings, as alfalfa_averaged",
    "berries": "deciduous shrubs leafing out in March-April",
    "blueberry": "as berries",
    "raspberry": "as berries",
    "avocado": "evergreen subtropical tree, no concerted leaf drop",
    "conifer": "evergreen with Kc 1.00 in every stage",
}
# A1, ruling R9: three defaults changed in the agronomy review.
SWAPS = {
    "cantaloupe": (43, False, "the policy's pick (Cantaloupe, Calif., January) is a desert winter planting; Sweet melons, Mediterranean, May fits a European sowing"),
    "sugar_beet": (63, True, "Idaho is closer to Swiss sowing (March-April) and lifting (September-November)"),
    "almond": (160, True, "almonds grow where that row applies"),
}

v2_crops = []
for c in CAT["crops"]:
    cid, grp = c["id"], c["group"]
    e = {k: c[k] for k in V1_KEYS}
    if cid in SWAPS:
        idx, verified, why = SWAPS[cid]
        cands = M[cid][1]
        e["stage_lengths_days"] = v2_object(idx, "agronomy review 2026-09-27: " + why, verified)
        e["stage_length_alternatives"] = [v2_object(i, "alternative", True) for i in cands if i != idx]
    elif cid in M:
        d, cands, rule, _extra = M[cid]
        e["stage_lengths_days"] = v2_object(d, rule, True)
        e["stage_length_alternatives"] = [v2_object(i, "alternative", True) for i in cands if i != d]
    elif cid in PARTIAL:
        e["stage_lengths_days"] = v2_object(PARTIAL[cid][0], "only row; Table 11 gives no numeric mid/late lengths", True)
        e["stage_length_alternatives"] = [v2_object(i, "alternative (cutting-cycle rows)", True) for i in (134, 135, 136, 137)] if cid == "alfalfa_averaged" else []
    elif cid in PROMOTED:
        idx = NOROW[cid][0]
        rule = "reference proposal (UNVERIFIED): " + PROMOTED[cid]
        e["stage_lengths_days"] = null_object(rule) if idx == "evergreen" else v2_object(idx, rule, False, first_two_only=(cid == "sudan_grass"))
        e["stage_length_alternatives"] = [group_default_object(grp)]
    else:
        e["stage_lengths_days"] = group_default_object(grp)
        e["stage_length_alternatives"] = []
    v2_crops.append(e)

assert len(v2_crops) == 136 and len(PROMOTED) == 16 and set(PROMOTED) <= set(NOROW)
catalogue = {k: CAT[k] for k in ("version", "luxPerWm2", "stationWindHeightM", "stages", "groups")}
catalogue["version"] = 2
catalogue["crops"] = v2_crops
with open(CATALOGUE_PATH, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\\n")
print("crop-kc.json v2:", len(v2_crops), "crops,",
      sum(1 for e in v2_crops if e["stage_lengths_days"]["verified"]), "verified defaults,",
      sum(1 for e in v2_crops if e["stage_lengths_days"]["initial"] is None), "without lengths")
''')
p.write_text(s, encoding="utf-8")
print("build_table11.py patched")
```
```bash
python3 "$SCRATCH/patch-build-table11.py"
python3 docs/contracts/agronomy/sources/build_table11.py
sha256sum docs/contracts/agronomy/crop-kc.json docs/contracts/agronomy/sources/table11-stage-lengths.json
python3 docs/contracts/agronomy/sources/build_table11.py > /dev/null && sha256sum docs/contracts/agronomy/crop-kc.json
```
Expected: `build_table11.py patched`; `{'crops': 136, 'with_verified_numeric_row': 95, 'row_exists_but_no_numeric_lengths': 4, 'no_table11_row': 37}`; `crop-kc.json v2: 136 crops, 98 verified defaults, 12 without lengths`; hashes `9b58c9275b57c72b0e52d2783fe8fd57faf9fda9ee98611c6a8f59451292e27c` (crop-kc.json) and `3579962e474e4d88cabe02ddc06ec3d4b3e6f8f00406c1242b84e7c86feca422` (table11-stage-lengths.json); the second run prints the same crop-kc.json hash (the script reads back only the v1 fields, so it is idempotent). The fix wave changed the cantaloupe reason text (plan review E1-E3 minor 3), which moved the crop-kc.json hash from `90142172…` to `9b58c927…`; `kc-vectors.json` keeps `dd3fd36c…`, because no vector reads the reason text. Plan CA's pinned hash is whatever `sha256sum` prints here: CA copies the file and pins the copy. 98 verified defaults are the 94 own rows in use plus the 4 rows without numbers; the 12 without lengths are `sisal`, `conifer` and the 10 tropical evergreens.

Spot-check the entries the spec names:
```bash
node -e "
const c = require('./docs/contracts/agronomy/crop-kc.json'); const by = Object.fromEntries(c.crops.map((x) => [x.id, x]));
for (const id of ['maize', 'grapevine', 'grass', 'garlic', 'sudan_grass', 'conifer', 'cantaloupe', 'sugar_beet', 'almond', 'reed_swamp_moist_soil']) {
  const s = by[id].stage_lengths_days;
  console.log(id, [s.initial, s.development, s.mid_season, s.late_season].join('/'), s.table11_row, '|', s.region, '|', s.verified, '|', by[id].stage_length_alternatives.length);
}"
```
Expected, one line each: `maize 30/40/50/30 Maize (grain) | Spain (spr, sum.); Calif. | true | 5`, `grapevine 30/60/40/80 Grapes | Mid Latitudes (wine) | true | 3`, `grass 10/20// Grass Pasture | 7 days before last -4°C in spring until 7 days after first -4°C in fall | true | 0`, `garlic 15/25/70/40 Onion (dry) | Mediterranean | false | 1`, `sudan_grass 25/25// Sudan, 1st cutting cycle | Calif. Desert, USA | false | 1`, `conifer /// | | false | 1`, `cantaloupe 25/35/40/20 Sweet melons | Mediterranean | false | 2`, `sugar_beet 50/40/50/40 Sugarbeet | Idaho, USA | true | 6`, `almond 30/50/130/30 Deciduous Orchard | Calif., USA | true | 2`, `reed_swamp_moist_soil 10/30/80/20 Wetlands (Cattails, Bulrush) | Utah, USA; killing frost | false | 0`.

- [ ] **Step 5: The three copies**

```bash
for dest in conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc web/react-gui/src/agronomy; do
  cp docs/contracts/agronomy/crop-kc.json "$dest/crop-kc.json"
done
```

- [ ] **Step 6: Run the gates**

```bash
node scripts/verify-agronomy-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js
node scripts/verify-profile-parity.js
(cd web/react-gui && npm ci && npx tsx --test tests/agronomyKcVectors.test.ts && npm run typecheck)
```
Expected: `verify-agronomy-contract: OK (136 crops, copies byte-identical, vectors reproduced where implementations exist)` (the v1 resolver still reproduces the 1,252 v1 vectors: v2 keeps every v1 field); `# pass 4`; `All parity checks passed.`; the GUI vector test `# pass 2` and typecheck exit 0. `npm ci` installs only; it does not build.

- [ ] **Step 7: Commit**

```bash
git add docs/contracts/agronomy scripts/verify-agronomy-contract.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json web/react-gui/src/agronomy/crop-kc.json
git -c user.name=Project-OSI commit -m "feat(agronomy): contract v2 catalogue with FAO-56 Table 11 stage lengths and their sources"
```

---

### Task 3: The FAO-56 Kc curve in the edge helper, the GUI and the vectors

**Files:**
- Modify: `scripts/build-kc-vectors.js`, `docs/contracts/agronomy/kc-vectors.json` (regenerated), `.../osi-crop-kc/index.js`, `.../osi-crop-kc/index.test.js` (both profiles), `web/react-gui/src/agronomy/cropKc.ts`, `web/react-gui/src/agronomy/__tests__/cropKc.test.ts`, `web/react-gui/tests/agronomyKcVectors.test.ts`, `scripts/verify-agronomy-contract.js`

**Interfaces:**
- Consumes: `crop.stage_lengths_days` (Task 2).
- Produces, in `osi-crop-kc` and `cropKc.ts` with the same names and shapes:
  - `resolveKc({ cropType, phenologicalStage, stageStartedOn = null, date = null })` → `{ kc: number, kcSource: 'fao56_crop' | 'fao56_crop_stage_unset' | 'fao56_curve' | 'heuristic_phenology', cropId: string | null, stage: StageId | null, kcStageDay: number | null, stageOverrun: boolean | null }`. `stageStartedOn` and `date` are `YYYY-MM-DD` strings; anything else counts as absent.
  - `stageLengths(cropId)` → `{ initial, development, mid_season, late_season }` (numbers or null), or null for a crop outside the catalogue.
  - `kcRamp(prev, next, d, L)` → the rounded Kc of day `d + 1` of a stage of length `L`.
  - `cropKc.ts` also exports the types `StageLengths`, `StageLengthRow`, `KcResult`.
  - `kc-vectors.json`: 1,335 records `{ cropType, phenologicalStage, stageStartedOn, date, kc, kcSource, cropId, stage, kcStageDay, stageOverrun }`. E2a, E3, the cloud's CA plan and every later test read these names.

- [ ] **Step 1: Write the failing tests**

`.../osi-crop-kc/index.test.js`, whole file:
```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const kc = require('./index');
const REPO = path.resolve(__dirname, '../../../../../../..');
const vectors = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/kc-vectors.json'), 'utf8'));

test('normalizeStage accepts FAO keys, maps legacy keys, treats default/unknown/null as unset', () => {
  for (const s of ['initial', 'development', 'mid_season', 'late_season', 'dormancy']) assert.equal(kc.normalizeStage(s), s);
  assert.equal(kc.normalizeStage(' Mid_Season '), 'mid_season');
  assert.equal(kc.normalizeStage('budbreak'), 'initial');
  assert.equal(kc.normalizeStage('bud_break'), 'initial');
  assert.equal(kc.normalizeStage('fruitset'), 'development');
  assert.equal(kc.normalizeStage('cell_expansion'), 'development');
  assert.equal(kc.normalizeStage('veraison'), 'mid_season');
  assert.equal(kc.normalizeStage('harvest'), 'late_season');
  assert.equal(kc.normalizeStage('post_harvest'), 'late_season');
  assert.equal(kc.normalizeStage('default'), null);
  assert.equal(kc.normalizeStage(null), null);
  assert.equal(kc.normalizeStage('flowering'), null);
});

test('resolveKc reproduces every contract vector, the 83 dated ones included', () => {
  assert.equal(vectors.length, 1335);
  for (const v of vectors) {
    assert.deepEqual(
      kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date }),
      { kc: v.kc, kcSource: v.kcSource, cropId: v.cropId, stage: v.stage, kcStageDay: v.kcStageDay, stageOverrun: v.stageOverrun },
      JSON.stringify(v)
    );
  }
});

test('resolveKc: maize by stage, unset stage, unknown crop, dormancy; grapevine is the wine row', () => {
  assert.deepEqual(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'mid_season' }), { kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'mid_season', kcStageDay: null, stageOverrun: null });
  assert.equal(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'development' }).kc, 1.2);
  assert.deepEqual(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'default' }), { kc: 1.2, kcSource: 'fao56_crop_stage_unset', cropId: 'maize', stage: null, kcStageDay: null, stageOverrun: null });
  assert.deepEqual(kc.resolveKc({ cropType: 'other', phenologicalStage: 'mid_season' }), { kc: 0.9, kcSource: 'heuristic_phenology', cropId: null, stage: 'mid_season', kcStageDay: null, stageOverrun: null });
  assert.equal(kc.resolveKc({ cropType: 'apple', phenologicalStage: 'dormancy' }).kc, 0.25);
  assert.equal(kc.resolveKc({ cropType: 'grapevine', phenologicalStage: 'veraison' }).kc, 0.7);
  assert.equal(kc.cropById('grapevine').variant_of, null);
  assert.equal(kc.cropById('grapes_table').variant_of, 'grapevine');
  assert.equal(kc.catalogue.crops.length, 136);
});

test('the ramp stages take the FAO-56 table values: development kc_mid, late season kc_end', () => {
  const late = (cropType) => kc.resolveKc({ cropType, phenologicalStage: 'late_season' }).kc;
  assert.deepEqual(['maize', 'grapevine', 'apple', 'potato', 'alfalfa'].map(late), [0.35, 0.45, 0.7, 0.75, 1.15]);
  assert.equal(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'harvest' }).kc, 0.35);
  assert.equal(kc.resolveKc({ cropType: 'soybean', phenologicalStage: 'development' }).kc, 1.15);
});

test('kcRamp reproduces FAO-56 Example 28 (Kc ini 0.15, Kc mid 1.19, Kc end 0.35): day 40 = 0.77, day 95 = 0.56', () => {
  // Day 40 of the season is day 15 of the 25-day development stage (d = 14);
  // day 95 is day 15 of the 20-day late season (d = 14).
  assert.equal(kc.kcRamp(0.15, 1.19, 14, 25), 0.77);
  assert.equal(kc.kcRamp(1.19, 0.35, 14, 20), 0.56);
});

test('stageLengths: an own row, a promoted proposal, a swapped default, a partial row, no row, an unknown id', () => {
  assert.deepEqual(kc.stageLengths('maize'), { initial: 30, development: 40, mid_season: 50, late_season: 30 });
  assert.deepEqual(kc.stageLengths(' Garlic '), { initial: 15, development: 25, mid_season: 70, late_season: 40 });
  assert.deepEqual(kc.stageLengths('sugar_beet'), { initial: 50, development: 40, mid_season: 50, late_season: 40 });
  assert.deepEqual(kc.stageLengths('grass'), { initial: 10, development: 20, mid_season: null, late_season: null });
  assert.deepEqual(kc.stageLengths('conifer'), { initial: null, development: null, mid_season: null, late_season: null });
  assert.equal(kc.stageLengths('other'), null);
  assert.equal(kc.catalogue.version, 2);
});

test('the curve counts calendar days: the spring clock change, a future start date, an impossible date', () => {
  const dev = (stageStartedOn, date) => kc.resolveKc({ cropType: 'maize', phenologicalStage: 'development', stageStartedOn, date });
  assert.deepEqual(dev('2026-03-20', '2026-04-09'), { kc: 0.77, kcSource: 'fao56_curve', cropId: 'maize', stage: 'development', kcStageDay: 21, stageOverrun: false });
  assert.deepEqual(dev('2026-05-10', '2026-05-01'), { kc: 0.3, kcSource: 'fao56_curve', cropId: 'maize', stage: 'development', kcStageDay: -8, stageOverrun: false });
  // A naive time string and a year below 100 are not calendar dates either (spec A5).
  for (const bad of ['2026-02-30', '05/01/2026', '', 'yesterday', '2026-03-20T00:00', '0099-03-20']) {
    assert.deepEqual(dev(bad, '2026-05-21'), { kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'development', kcStageDay: null, stageOverrun: null }, bad);
  }
});
```

`web/react-gui/tests/agronomyKcVectors.test.ts`, whole file:
```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { kcRamp, resolveKc } from '../src/agronomy/cropKc.ts';

const contractDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'contracts', 'agronomy');

test('the GUI resolver reproduces every contract Kc vector, dated ones included', () => {
  const vectors = JSON.parse(readFileSync(join(contractDir, 'kc-vectors.json'), 'utf8'));
  assert.equal(vectors.length, 1335);
  for (const v of vectors) {
    assert.deepEqual(
      resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date }),
      { kc: v.kc, kcSource: v.kcSource, cropId: v.cropId, stage: v.stage, kcStageDay: v.kcStageDay, stageOverrun: v.stageOverrun },
      JSON.stringify(v),
    );
  }
});

test('FAO-56 Example 28 through kcRamp: day 40 of the season is 0.77, day 95 is 0.56', () => {
  assert.equal(kcRamp(0.15, 1.19, 14, 25), 0.77);
  assert.equal(kcRamp(1.19, 0.35, 14, 20), 0.56);
});

test('the GUI copy of crop-kc.json is byte-identical to the contract', () => {
  assert.equal(readFileSync(join(import.meta.dirname, '..', 'src', 'agronomy', 'crop-kc.json'), 'utf8'), readFileSync(join(contractDir, 'crop-kc.json'), 'utf8'));
});
```

`web/react-gui/src/agronomy/__tests__/cropKc.test.ts`, whole file:
```ts
import { describe, expect, it } from 'vitest';
import { CROP_OPTION_GROUPS, cropById, kcRamp, normalizeStage, resolveKc, stageFamily, stageLengths } from '../cropKc';

describe('cropKc', () => {
  it('groups the 136 crops into 15 FAO groups with variants under their default', () => {
    expect(CROP_OPTION_GROUPS).toHaveLength(15);
    const total = CROP_OPTION_GROUPS.reduce((n, g) => n + g.crops.reduce((m, c) => m + 1 + c.variants.length, 0), 0);
    expect(total).toBe(136);
    const grapes = CROP_OPTION_GROUPS.find((g) => g.group.id === 'grapes_berries')!.crops.find((c) => c.crop.id === 'grapevine')!;
    expect(grapes.variants.map((v) => v.id)).toEqual(['grapes_table']);
  });
  it('maps legacy stages and uses two label families', () => {
    expect(normalizeStage('veraison')).toBe('mid_season');
    expect(normalizeStage('default')).toBeNull();
    expect(stageFamily('grapevine')).toBe('woody');
    expect(stageFamily('citrus_50_cover')).toBe('woody');
    expect(stageFamily('maize')).toBe('annual');
    expect(stageFamily('banana')).toBe('annual');
    expect(stageFamily('other')).toBe('annual');
  });
  it('resolves grapevine at veraison to the wine row', () => {
    expect(resolveKc({ cropType: 'grapevine', phenologicalStage: 'veraison' })).toEqual({ kc: 0.7, kcSource: 'fao56_crop', cropId: 'grapevine', stage: 'mid_season', kcStageDay: null, stageOverrun: null });
    expect(cropById('pear')?.kc_mid).toBe(0.95);
  });
  it('takes the FAO-56 table values for the ramp stages: development kc_mid, late season kc_end', () => {
    const late = (cropType: string) => resolveKc({ cropType, phenologicalStage: 'late_season' }).kc;
    expect(['maize', 'grapevine', 'apple', 'potato', 'alfalfa'].map(late)).toEqual([0.35, 0.45, 0.7, 0.75, 1.15]);
    expect(resolveKc({ cropType: 'soybean', phenologicalStage: 'development' }).kc).toBe(1.15);
  });
  it('reproduces FAO-56 Example 28 through kcRamp (day 40 = 0.77, day 95 = 0.56)', () => {
    expect(kcRamp(0.15, 1.19, 14, 25)).toBe(0.77);
    expect(kcRamp(1.19, 0.35, 14, 20)).toBe(0.56);
  });
  it('gives the default Table 11 lengths: own row, promoted proposal, swapped default, partial row, none, unknown', () => {
    expect(stageLengths('maize')).toEqual({ initial: 30, development: 40, mid_season: 50, late_season: 30 });
    expect(stageLengths('garlic')).toEqual({ initial: 15, development: 25, mid_season: 70, late_season: 40 });
    expect(stageLengths('sugar_beet')).toEqual({ initial: 50, development: 40, mid_season: 50, late_season: 40 });
    expect(stageLengths('grass')).toEqual({ initial: 10, development: 20, mid_season: null, late_season: null });
    expect(stageLengths('conifer')).toEqual({ initial: null, development: null, mid_season: null, late_season: null });
    expect(stageLengths('other')).toBeNull();
  });
  it('counts calendar days across the spring clock change and ignores an impossible start date', () => {
    // 20 March to 9 April 2026 spans the 29 March switch: still d = 20, day 21 of 40.
    expect(resolveKc({ cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-03-20', date: '2026-04-09' }))
      .toEqual({ kc: 0.77, kcSource: 'fao56_curve', cropId: 'maize', stage: 'development', kcStageDay: 21, stageOverrun: false });
    expect(resolveKc({ cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-02-30', date: '2026-04-09' }))
      .toEqual({ kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'development', kcStageDay: null, stageOverrun: null });
  });
  it('keeps the table value for a stage without a length (grass late season, conifer)', () => {
    expect(resolveKc({ cropType: 'grass', phenologicalStage: 'late_season', stageStartedOn: '2026-05-01', date: '2026-05-11' }).kc).toBe(1);
    expect(resolveKc({ cropType: 'conifer', phenologicalStage: 'development', stageStartedOn: '2026-05-01', date: '2026-05-11' }))
      .toEqual({ kc: 1, kcSource: 'fao56_crop', cropId: 'conifer', stage: 'development', kcStageDay: null, stageOverrun: null });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js
(cd web/react-gui && npx tsx --test tests/agronomyKcVectors.test.ts; npx vitest run src/agronomy/__tests__/cropKc.test.ts)
```
Expected: the edge suite fails five tests: `resolveKc reproduces every contract vector` (1252 !== 1335), `resolveKc: maize by stage, …` (its `deepEqual` objects now carry `kcStageDay` and `stageOverrun`), `kcRamp …` (`kc.kcRamp is not a function`), `stageLengths …` and the calendar-day test; the GUI runs fail on the missing exports `kcRamp` and `stageLengths` and on the vector count.

- [ ] **Step 3: The vector generator**

`scripts/build-kc-vectors.js`, whole file (its own copy of the rule, so the vectors do not come from the code they test):
```js
#!/usr/bin/env node
'use strict';
// Regenerates docs/contracts/agronomy/kc-vectors.json from crop-kc.json and
// the Kc rules in the README (contract v2: the FAO-56 curve, spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A5-A6).
// It carries its own copy of the rule, so the vectors do not come from the
// code they test. Every runtime (edge helper, edge GUI, cloud backend, cloud
// frontend) reproduces every record exactly.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'docs', 'contracts', 'agronomy');
const catalogue = JSON.parse(fs.readFileSync(path.join(dir, 'crop-kc.json'), 'utf8'));
const HEURISTIC = { initial: 0.45, development: 0.70, mid_season: 0.90, late_season: 0.60, dormancy: 0.25, unset: 0.75 };
const LEGACY = { budbreak: 'initial', bud_break: 'initial', fruitset: 'development', cell_division: 'development', cell_expansion: 'development', veraison: 'mid_season', fruit_maturation: 'mid_season', harvest: 'late_season', post_harvest: 'late_season', dormancy: 'dormancy' };
const STAGES = ['initial', 'development', 'mid_season', 'late_season', 'dormancy'];
const DAY_MS = 86400000;
function round2(v) { return Math.round(v * 100) / 100; }
function normalizeStage(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  return LEGACY[s] || null;
}
function isoDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value));
  // Date.UTC maps the years 0-99 to 1900-1999; the contract refuses them (spec A5).
  if (!m || Number(m[1]) < 100) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms / DAY_MS : null;
}
function ramp(prev, next, d, L) {
  const p = Math.min(1, Math.max(0, (d + 1) / L));
  return round2(prev + p * (next - prev));
}
function resolve(cropType, stageIn, stageStartedOn, date) {
  const stage = normalizeStage(stageIn);
  const id = String(cropType == null ? '' : cropType).trim().toLowerCase();
  const crop = catalogue.crops.find((c) => c.id === id);
  if (!crop) return { kc: HEURISTIC[stage || 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage, kcStageDay: null, stageOverrun: null };
  const table = { initial: crop.kc_ini, development: crop.kc_mid, mid_season: crop.kc_mid, late_season: crop.kc_end, dormancy: 0.25 };
  if (!stage) return { kc: round2(crop.kc_mid), kcSource: 'fao56_crop_stage_unset', cropId: crop.id, stage: null, kcStageDay: null, stageOverrun: null };
  const out = { kc: round2(table[stage]), kcSource: 'fao56_crop', cropId: crop.id, stage, kcStageDay: null, stageOverrun: null };
  if (stage === 'dormancy') return out;
  const L = crop.stage_lengths_days[stage];
  const start = isoDay(stageStartedOn);
  const day = isoDay(date);
  if (L == null || start == null || day == null) return out;
  const d = day - start;
  out.kcStageDay = d + 1;
  out.stageOverrun = d + 1 > L;
  if (stage === 'development') { out.kc = ramp(crop.kc_ini, crop.kc_mid, d, L); out.kcSource = 'fao56_curve'; }
  if (stage === 'late_season') { out.kc = ramp(crop.kc_mid, crop.kc_end, d, L); out.kcSource = 'fao56_curve'; }
  return out;
}
function record(cropType, phenologicalStage, stageStartedOn, date) {
  return { cropType, phenologicalStage, stageStartedOn, date, ...resolve(cropType, phenologicalStage, stageStartedOn, date) };
}
function plusDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }

const vectors = [];
// The 1,252 v1 records, undated: their values do not change.
for (const crop of catalogue.crops) {
  for (const stage of [...STAGES, null, 'default', 'budbreak', 'veraison']) vectors.push(record(crop.id, stage, null, null));
}
for (const cropType of ['other', 'unknown_crop', null, '']) {
  for (const stage of [...STAGES, null, 'harvest']) vectors.push(record(cropType, stage, null, null));
}
// 70 dated ramp cases (A6): five crops, both ramp stages, seven cases each.
const START = '2026-05-01';
for (const cropType of ['maize', 'tomato', 'potato', 'grapevine', 'apple']) {
  const crop = catalogue.crops.find((c) => c.id === cropType);
  for (const stage of ['development', 'late_season']) {
    const L = crop.stage_lengths_days[stage];
    for (const d of [0, Math.floor(L / 2), L - 1, L, L + 10, -5]) vectors.push(record(cropType, stage, START, plusDays(START, d)));
    vectors.push(record(cropType, stage, null, '2026-05-21'));
  }
}
// 13 cases on the edges of the rule (A6).
for (const cropType of ['maize', 'tomato', 'potato', 'grapevine', 'apple']) vectors.push(record(cropType, 'dormancy', START, '2026-05-11'));
vectors.push(record('grass', 'development', START, '2026-05-11'));
vectors.push(record('grass', 'late_season', START, '2026-05-11'));
vectors.push(record('maize', 'initial', START, '2026-05-11'));
vectors.push(record('maize', 'initial', START, '2026-06-05'));
vectors.push(record('maize', 'mid_season', START, '2026-05-11'));
vectors.push(record('maize', 'late_season', START, '2026-05-15'));
vectors.push(record('maize', 'default', START, '2026-05-11'));
vectors.push(record('other', 'development', START, '2026-05-11'));
fs.writeFileSync(path.join(dir, 'kc-vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log('kc-vectors:', vectors.length);
```
```bash
node scripts/build-kc-vectors.js
sha256sum docs/contracts/agronomy/kc-vectors.json
node -e "
const v = require('./docs/contracts/agronomy/kc-vectors.json'); const dated = v.slice(1252);
for (let i = 0; i < 70; i += 7) { const g = dated.slice(i, i + 7); console.log(g[0].cropType, g[0].phenologicalStage, g.map((x) => x.kc.toFixed(2)).join(' ')); }
for (const x of dated.slice(70)) console.log(x.cropType, x.phenologicalStage, x.date, x.kc, x.kcSource, x.kcStageDay, x.stageOverrun);"
```
Expected: `kc-vectors: 1335`; hash `dd3fd36c9ab1d3849adfe269871ff82e9821006b81075ea2224b1a9a28c0e92b`; the ten ramp lines reproduce the spec's A6 table in the order d = 0, ⌊L/2⌋, L − 1, L, L + 10, −5, no start date:
```
maize development 0.32 0.77 1.20 1.20 1.20 0.30 1.20
maize late_season 1.17 0.75 0.35 0.35 0.35 1.20 0.35
tomato development 0.61 0.89 1.15 1.15 1.15 0.60 1.15
tomato late_season 1.14 0.91 0.70 0.70 0.70 1.15 0.70
potato development 0.52 0.83 1.15 1.15 1.15 0.50 1.15
potato late_season 1.14 0.94 0.75 0.75 0.75 1.15 0.75
grapevine development 0.31 0.51 0.70 0.70 0.70 0.30 0.70
grapevine late_season 0.70 0.57 0.45 0.45 0.45 0.70 0.45
apple development 0.46 0.71 0.95 0.95 0.95 0.45 0.95
apple late_season 0.94 0.82 0.70 0.70 0.70 0.95 0.70
```
and the 13 edge cases end with `grass development 2026-05-11 0.96 fao56_curve 11 false`, `grass late_season 2026-05-11 1 fao56_crop null null`, `maize initial 2026-06-05 0.3 fao56_crop 36 true`, `maize late_season 2026-05-15 0.77 fao56_curve 15 false`, `maize default 2026-05-11 1.2 fao56_crop_stage_unset null null`, `other development 2026-05-11 0.7 heuristic_phenology null null`. If a value differs from the spec's table, stop and report; do not adjust the rule to the table.

- [ ] **Step 4: The edge helper**

`.../osi-crop-kc/index.js`, whole file:
```js
'use strict';
// osi-crop-kc: the FAO-56 crop coefficient resolver. crop-kc.json here is a
// byte copy of docs/contracts/agronomy/crop-kc.json (verify-agronomy-contract).
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A5): with a stage start date and the stage's Table 11 length, the
// development and late-season stages follow FAO-56 equation 66 day by day.
const catalogue = require('./crop-kc.json');

const STAGES = Object.freeze(['initial', 'development', 'mid_season', 'late_season', 'dormancy']);
const LEGACY = Object.freeze({
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
  dormancy: 'dormancy',
});
const HEURISTIC = Object.freeze({ initial: 0.45, development: 0.70, mid_season: 0.90, late_season: 0.60, dormancy: 0.25, unset: 0.75 });
const DAY_MS = 86400000;
const byId = new Map(catalogue.crops.map((crop) => [crop.id, crop]));

function round2(value) { return Math.round(value * 100) / 100; }

function normalizeStage(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  return LEGACY[s] || null;
}

function cropById(id) {
  return byId.get(String(id == null ? '' : id).trim().toLowerCase()) || null;
}

// A calendar date 'YYYY-MM-DD' as whole days since 1970-01-01 (Date.UTC
// parts, so daylight saving never moves it); null for anything else,
// including an impossible date such as 2026-02-30.
function dayNumber(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value));
  // Date.UTC maps the years 0-99 to 1900-1999; the contract refuses them (spec A5).
  if (!m || Number(m[1]) < 100) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms / DAY_MS : null;
}

// FAO-56 eq. 66 for a stage that started d whole days ago (d = 0 on the start
// date): FAO's day in the stage is d + 1, clamped to the stage's length. The
// operation order is part of the contract (A5).
function kcRamp(prev, next, d, L) {
  const p = Math.min(1, Math.max(0, (d + 1) / L));
  return round2(prev + p * (next - prev));
}

function stageLengths(cropId) {
  const crop = cropById(cropId);
  if (!crop) return null;
  const s = crop.stage_lengths_days;
  return { initial: s.initial, development: s.development, mid_season: s.mid_season, late_season: s.late_season };
}

function resolveKc({ cropType, phenologicalStage, stageStartedOn = null, date = null }) {
  const stage = normalizeStage(phenologicalStage);
  const crop = cropById(cropType);
  if (!crop) return { kc: HEURISTIC[stage || 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage, kcStageDay: null, stageOverrun: null };
  if (!stage) return { kc: round2(crop.kc_mid), kcSource: 'fao56_crop_stage_unset', cropId: crop.id, stage: null, kcStageDay: null, stageOverrun: null };
  // Without a start date the ramp stages take the table value they end on
  // (development: kc_mid) or reach (late season: kc_end).
  const table = { initial: crop.kc_ini, development: crop.kc_mid, mid_season: crop.kc_mid, late_season: crop.kc_end, dormancy: 0.25 };
  const out = { kc: round2(table[stage]), kcSource: 'fao56_crop', cropId: crop.id, stage, kcStageDay: null, stageOverrun: null };
  if (stage === 'dormancy') return out;
  const L = crop.stage_lengths_days[stage];
  const start = dayNumber(stageStartedOn);
  const day = dayNumber(date);
  if (L == null || start == null || day == null) return out;
  const d = day - start;
  out.kcStageDay = d + 1;
  out.stageOverrun = d + 1 > L;
  if (stage === 'development') { out.kc = kcRamp(crop.kc_ini, crop.kc_mid, d, L); out.kcSource = 'fao56_curve'; }
  if (stage === 'late_season') { out.kc = kcRamp(crop.kc_mid, crop.kc_end, d, L); out.kcSource = 'fao56_curve'; }
  return out;
}

module.exports = { catalogue, STAGES, normalizeStage, cropById, resolveKc, stageLengths, kcRamp };
```

- [ ] **Step 5: The GUI resolver**

`web/react-gui/src/agronomy/cropKc.ts`, whole file (`AgronomicTab.tsx` keeps calling `resolveKc({ cropType, phenologicalStage })`; the two new inputs are optional):
```ts
import catalogueJson from './crop-kc.json';
import predictionCropCatalog from '../components/farming/predictionCropCatalog.json';

/** The FAO-56 Kc resolver, the GUI copy of osi-crop-kc (same contract vectors). */
export type StageId = 'initial' | 'development' | 'mid_season' | 'late_season' | 'dormancy';
export type StageFamily = 'woody' | 'annual';
export type KcSource = 'fao56_crop' | 'fao56_crop_stage_unset' | 'fao56_curve' | 'heuristic_phenology';
export interface StageLengths { initial: number | null; development: number | null; mid_season: number | null; late_season: number | null }
export interface StageLengthRow extends StageLengths { table11_row: string; plant_date: string; region: string; selection_rule: string; verified: boolean }
export interface CropEntry { id: string; group: string; label: string; kc_ini: number; kc_mid: number; kc_end: number; variant_of: string | null; fao_row: string | null; stage_lengths_days: StageLengthRow; stage_length_alternatives: StageLengthRow[] }
export interface KcResult { kc: number; kcSource: KcSource; cropId: string | null; stage: StageId | null; kcStageDay: number | null; stageOverrun: boolean | null }
export interface CropGroupEntry { id: string; order: number; label: string; stageFamily: StageFamily }
interface Catalogue { version: number; luxPerWm2: number; stationWindHeightM: number; stages: Array<{ id: StageId; order: number; label: string }>; groups: CropGroupEntry[]; crops: CropEntry[] }

export const CATALOGUE = catalogueJson as Catalogue;
export const STAGES: StageId[] = ['initial', 'development', 'mid_season', 'late_season', 'dormancy'];
const LEGACY: Record<string, StageId> = {
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
  dormancy: 'dormancy',
};
const HEURISTIC: Record<StageId | 'unset', number> = { initial: 0.45, development: 0.7, mid_season: 0.9, late_season: 0.6, dormancy: 0.25, unset: 0.75 };
const BY_ID = new Map(CATALOGUE.crops.map((crop) => [crop.id, crop]));
const round2 = (v: number) => Math.round(v * 100) / 100;
const DAY_MS = 86400000;

export function normalizeStage(value: unknown): StageId | null {
  const s = String(value ?? '').trim().toLowerCase();
  if ((STAGES as string[]).includes(s)) return s as StageId;
  return LEGACY[s] ?? null;
}

export function cropById(id: unknown): CropEntry | null {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

/**
 * A stored crop as the crop selector's value: a catalogue id or 'other' in
 * the catalogue's lower case (a stored 'Maize' selects the maize option),
 * anything else as stored, so a legacy value keeps its own option.
 */
export function formCropValue(value: unknown): string {
  const stored = String(value ?? '').trim();
  const lower = stored.toLowerCase();
  return cropById(lower) || lower === 'other' ? lower : stored;
}

/** A calendar date 'YYYY-MM-DD' as whole days since 1970-01-01 (Date.UTC parts); null for anything else. */
function dayNumber(value: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  // Date.UTC maps the years 0-99 to 1900-1999; the contract refuses them (spec A5).
  if (!m || Number(m[1]) < 100) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms / DAY_MS : null;
}

/** FAO-56 eq. 66: FAO's day in the stage is d + 1 (1 on the start date), clamped to the stage length. */
export function kcRamp(prev: number, next: number, d: number, L: number): number {
  const p = Math.min(1, Math.max(0, (d + 1) / L));
  return round2(prev + p * (next - prev));
}

/** The default Table 11 lengths of a catalogue crop, or null for a crop outside the catalogue. */
export function stageLengths(cropId: unknown): StageLengths | null {
  const crop = cropById(cropId);
  if (!crop) return null;
  const s = crop.stage_lengths_days;
  return { initial: s.initial, development: s.development, mid_season: s.mid_season, late_season: s.late_season };
}

export function resolveKc({ cropType, phenologicalStage, stageStartedOn = null, date = null }: { cropType: unknown; phenologicalStage: unknown; stageStartedOn?: unknown; date?: unknown }): KcResult {
  const stage = normalizeStage(phenologicalStage);
  const crop = cropById(cropType);
  if (!crop) return { kc: HEURISTIC[stage ?? 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage, kcStageDay: null, stageOverrun: null };
  if (!stage) return { kc: round2(crop.kc_mid), kcSource: 'fao56_crop_stage_unset', cropId: crop.id, stage: null, kcStageDay: null, stageOverrun: null };
  // Without a start date the ramp stages take the table value they end on
  // (development: kc_mid) or reach (late season: kc_end), contract v2 A5.
  const table: Record<StageId, number> = { initial: crop.kc_ini, development: crop.kc_mid, mid_season: crop.kc_mid, late_season: crop.kc_end, dormancy: 0.25 };
  const out: KcResult = { kc: round2(table[stage]), kcSource: 'fao56_crop', cropId: crop.id, stage, kcStageDay: null, stageOverrun: null };
  if (stage === 'dormancy') return out;
  const L = crop.stage_lengths_days[stage];
  const start = dayNumber(stageStartedOn);
  const day = dayNumber(date);
  if (L == null || start == null || day == null) return out;
  const d = day - start;
  out.kcStageDay = d + 1;
  out.stageOverrun = d + 1 > L;
  if (stage === 'development') { out.kc = kcRamp(crop.kc_ini, crop.kc_mid, d, L); out.kcSource = 'fao56_curve'; }
  if (stage === 'late_season') { out.kc = kcRamp(crop.kc_mid, crop.kc_end, d, L); out.kcSource = 'fao56_curve'; }
  return out;
}

export function stageFamily(cropType: unknown): StageFamily {
  const crop = cropById(cropType);
  return CATALOGUE.groups.find((g) => g.id === crop?.group)?.stageFamily ?? 'annual';
}

export const CROP_OPTION_GROUPS = [...CATALOGUE.groups].sort((a, b) => a.order - b.order).map((group) => ({
  group,
  crops: CATALOGUE.crops.filter((c) => c.group === group.id && !c.variant_of).map((crop) => ({ crop, variants: CATALOGUE.crops.filter((v) => v.variant_of === crop.id) })),
}));

export const PREDICTION_CROP_NAMES: string[] = (predictionCropCatalog as Array<{ displayName: string }>).map((c) => c.displayName);
```

- [ ] **Step 6: The verifier runs the curve vectors**

`scripts/verify-agronomy-contract.js`, whole file (the vector loop now passes all four inputs, compares all six outputs, requires 1,335 vectors and runs Example 28 through `kcRamp`):
```js
#!/usr/bin/env node
'use strict';
// verify-agronomy-contract: docs/contracts/agronomy is the source; every copy
// must be byte-identical, and the edge modules must reproduce the vectors.
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A1 and B1).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'contracts', 'agronomy');
const source = fs.readFileSync(path.join(dir, 'crop-kc.json'));
const copies = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'web/react-gui/src/agronomy/crop-kc.json',
];
const LENGTH_FIELDS = ['initial', 'development', 'mid_season', 'late_season'];
const PROVENANCE_FIELDS = ['table11_row', 'plant_date', 'region', 'selection_rule'];
const failures = [];
for (const rel of copies) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(rel + ': missing'); continue; }
  if (Buffer.compare(fs.readFileSync(abs), source) !== 0) failures.push(rel + ': differs from docs/contracts/agronomy/crop-kc.json');
}
const catalogue = JSON.parse(source.toString('utf8'));
if (catalogue.version !== 2) failures.push('crop-kc.json: version must be 2, found ' + catalogue.version);
const groups = new Set((catalogue.groups || []).map((g) => g.id));
for (const g of catalogue.groups || []) if (!['woody', 'annual'].includes(g.stageFamily)) failures.push('group ' + g.id + ': stageFamily must be woody or annual');
// A default length is a positive integer or null (A1). An alternative may
// also carry Table 11's printed 0 ("Faba bean, broad bean - green", late
// season): no code reads alternatives, and the cell stays verbatim.
function lengthRowProblems(label, s, allowZero = false) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [label + ' must be an object'];
  const keys = Object.keys(s);
  const want = [...LENGTH_FIELDS, ...PROVENANCE_FIELDS, 'verified'];
  if (keys.length !== want.length || want.some((k) => !keys.includes(k))) out.push(label + ' must have exactly ' + want.join(', '));
  for (const k of LENGTH_FIELDS) if (!(s[k] === null || (Number.isInteger(s[k]) && (s[k] > 0 || (allowZero && s[k] === 0))))) out.push(label + '.' + k + ' must be a positive integer or null');
  for (const k of PROVENANCE_FIELDS) if (typeof s[k] !== 'string') out.push(label + '.' + k + ' must be a string');
  if (typeof s.verified !== 'boolean') out.push(label + '.verified must be a boolean');
  return out;
}
const ids = new Set();
for (const crop of catalogue.crops) {
  if (ids.has(crop.id)) failures.push('duplicate crop id ' + crop.id);
  ids.add(crop.id);
  if (!groups.has(crop.group)) failures.push(crop.id + ': unknown group ' + crop.group);
  for (const k of ['kc_ini', 'kc_mid', 'kc_end']) if (!(crop[k] > 0 && crop[k] < 2)) failures.push(crop.id + ': ' + k + ' out of range');
  if (crop.variant_of && !catalogue.crops.some((c) => c.id === crop.variant_of && c.group === crop.group && !c.variant_of)) failures.push(crop.id + ': variant_of must name a default entry of the same group');
  failures.push(...lengthRowProblems(crop.id + '.stage_lengths_days', crop.stage_lengths_days));
  if (!Array.isArray(crop.stage_length_alternatives)) failures.push(crop.id + ': stage_length_alternatives must be an array');
  else crop.stage_length_alternatives.forEach((s, i) => failures.push(...lengthRowProblems(crop.id + '.stage_length_alternatives[' + i + ']', s, true)));
}
if (catalogue.crops.length !== 136) failures.push('expected 136 crops, found ' + catalogue.crops.length);
const kcModulePath = path.join(root, copies[0], '..', 'index.js');
const kc = require(kcModulePath);
const kcVectors = JSON.parse(fs.readFileSync(path.join(dir, 'kc-vectors.json'), 'utf8'));
if (kcVectors.length !== 1335) failures.push('kc-vectors.json: expected 1335 vectors, found ' + kcVectors.length);
let bad = 0;
for (const v of kcVectors) {
  const r = kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date });
  if (r.kc !== v.kc || r.kcSource !== v.kcSource || r.cropId !== v.cropId || r.stage !== v.stage || r.kcStageDay !== v.kcStageDay || r.stageOverrun !== v.stageOverrun) {
    bad += 1;
    if (bad <= 5) failures.push('kc vector mismatch: ' + JSON.stringify(v) + ' got ' + JSON.stringify(r));
  }
}
if (bad > 5) failures.push('kc vector mismatches: ' + bad);
// FAO-56 Example 28 (climate-adjusted Kc ini 0.15, Kc mid 1.19, Kc end 0.35): no catalogue row.
if (kc.kcRamp(0.15, 1.19, 14, 25) !== 0.77) failures.push('kcRamp: FAO-56 Example 28 day 40 must be 0.77');
if (kc.kcRamp(1.19, 0.35, 14, 20) !== 0.56) failures.push('kcRamp: FAO-56 Example 28 day 95 must be 0.56');
const et0 = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js'));
const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'et0-vectors.json'), 'utf8'));
const near = (got, want, tol) => (want == null ? got === null : typeof got === 'number' && Math.abs(got - want) <= tol);
for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) {
  const got = et0.fao56Et0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('fao56 vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.hargreaves) {
  const got = et0.hargreavesEt0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('hargreaves vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.luxToRadiation) {
  const got = et0.luxToWm2(v.lux, catalogue.luxPerWm2);
  if (!near(got, v.wm2, 0.01)) failures.push('lux vector ' + v.lux + ': expected ' + v.wm2 + ' got ' + got);
}
for (const v of vectors.elevationFromPressure) {
  const got = et0.elevationFromPressure(v.pressureKpa);
  if (!near(got, v.elevationM, 0.05)) failures.push('pressure vector ' + v.pressureKpa + ': expected ' + v.elevationM + ' got ' + got);
}
if (failures.length) { console.error('verify-agronomy-contract: FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('verify-agronomy-contract: OK (' + catalogue.crops.length + ' crops, contract v2, ' + kcVectors.length + ' Kc vectors, copies byte-identical)');
```

- [ ] **Step 7: Mirror and run the gates**

```bash
for f in index.js index.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/$f; done
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js
node scripts/verify-agronomy-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js
node scripts/capture-zone-env-vectors.js --verify
node scripts/verify-profile-parity.js
(cd web/react-gui && npx tsx --test tests/agronomyKcVectors.test.ts && npx vitest run src/agronomy/__tests__/cropKc.test.ts && npm run typecheck && npm run test:unit)
```
Expected: `# pass 7`; `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, copies byte-identical)`; the zone-env and daily-writer suites pass unchanged (they pass no start date, so every Kc is the table value as before); the six zone-env vectors verify unchanged; parity passes; GUI: tsx `# pass 3`, vitest `Tests  8 passed (8)`, typecheck exit 0, `test:unit` green.

- [ ] **Step 8: Commit**

```bash
git add scripts/build-kc-vectors.js scripts/verify-agronomy-contract.js docs/contracts/agronomy/kc-vectors.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc web/react-gui/src/agronomy web/react-gui/tests/agronomyKcVectors.test.ts
git -c user.name=Project-OSI commit -m "feat(agronomy): FAO-56 Kc curve (eq. 66) from a stage start date; 1,335 contract vectors"
```

---

### Task 4: Hourly FAO-56 Penman-Monteith ET0

**Files:**
- Modify: `docs/contracts/agronomy/sources/hourly_et0.py` (the contract chain and the vector writer), `docs/contracts/agronomy/et0-vectors.json` (two new groups), `.../osi-agronomy-daily/et0.js`, `.../osi-agronomy-daily/et0.test.js` (both profiles), `scripts/verify-agronomy-contract.js`
- Scratch: `$SCRATCH/patch-hourly-et0.py`, `$SCRATCH/et0-patch.py`

**Interfaces:**
- Produces, in `et0.js`:
  - `fao56HourlyTerms(input)` → terms or null. `input = { tMeanC, rhPct, windSpeedMs, windHeightM, solarRadMjM2h, elevationM, latDeg, lonDeg, dayOfYear, hourStartUtc, nightRsRso }`; `hourStartUtc` an ISO instant or epoch ms; `lonDeg` degrees east. Terms: `u2, pressureKpa, gamma, es, delta, ea, declination, dr, omegaS, omega, omega1, omega2, ra, rso, rns, rsRso, rnl, rn, g, radTerm, aeroTerm, et0Mm` (signed, not rounded), `sunUp`, `rsRsoSource` (`'measured'` for a day hour, `'prior'` for a night hour with `nightRsRso`, `'default'` with 0.5), `carryCandidate`.
  - `fao56Et0Hourly(input)` → `terms.et0Mm` or null.
  - `fao56Et0HourlyDay({ hours, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, priorRsRso })` → `{ et0Mm, sumMm, lastRsRso, hourly: [{ hourStartUtc, et0Mm, sunUp, rsRsoSource }] }` or null; `hours` = `[{ hourStartUtc, tMeanC, rhPct, windSpeedMs, solarRadMjM2h }]` in time order; a night hour's source is `'carried'`, `'prior'` or `'default'`.
  - `hourlyExtraterrestrialRadiation` keeps its signature and values (it now shares `solarHour` with the terms).
  - `et0-vectors.json`: `fao56Hourly` (five entries: `{ name, input, et0Mm, tolerance, terms?, termTolerance? }`) and `fao56HourlyDays` (one entry: `{ name, input: { hours, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, priorRsRso }, sumMm, et0Mm, lastRsRso, hourly }`). E3's station tier and the cloud's CA plan consume these names.

- [ ] **Step 1: Write the failing tests**

Append to `.../osi-agronomy-daily/et0.test.js`:
```js
// Contract v2, hourly FAO-56 Penman-Monteith (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A7-A9).
const termTolerance = (v, name) => (v.termTolerance ? (v.termTolerance[name] ?? v.termTolerance.default) : v.tolerance);

test('fao56HourlyTerms reproduces FAO-56 Example 19 and the computed hours within their tolerances', () => {
  assert.equal(vectors.fao56Hourly.length, 5);
  for (const v of vectors.fao56Hourly) {
    const terms = et0.fao56HourlyTerms(v.input);
    assert.ok(terms, v.name);
    assert.ok(Math.abs(terms.et0Mm - v.et0Mm) <= v.tolerance, `${v.name}: et0 ${terms.et0Mm}`);
    assert.equal(et0.fao56Et0Hourly(v.input), terms.et0Mm, v.name);
    for (const [name, want] of Object.entries(v.terms || {})) {
      assert.ok(Math.abs(terms[name] - want) <= termTolerance(v, name), `${v.name}.${name}: ${terms[name]} vs ${want}`);
    }
  }
  const byName = Object.fromEntries(vectors.fao56Hourly.map((v) => [v.name, et0.fao56Et0Hourly(v.input)]));
  assert.ok(Math.abs(byName.fao56_example19_1400_1500 - 0.63) <= 0.005);
  assert.ok(Math.abs(byName.fao56_example19_0200_0300) <= 0.005);
  assert.ok(Math.abs(byName.payerne_summer_noon_10m - byName.payerne_summer_noon) <= 1e-5, 'the 10 m wind equals the 2 m case');
  assert.ok(byName.payerne_winter_night < 0 && Math.abs(byName.payerne_winter_night + 0.0021) <= 1e-4, 'the winter night hour stays signed');
});

test('fao56Et0HourlyDay reproduces the synthetic Payerne day hour by hour; the 16:00 UTC hour carries its ratio to the evening', () => {
  const [v] = vectors.fao56HourlyDays;
  const day = et0.fao56Et0HourlyDay(v.input);
  assert.ok(Math.abs(day.sumMm - v.sumMm) <= 1e-4);
  assert.equal(day.et0Mm, 4.85);
  assert.equal(day.et0Mm, v.et0Mm);
  assert.ok(Math.abs(day.lastRsRso - v.lastRsRso) <= 1e-4);
  assert.equal(day.hourly.length, 24);
  day.hourly.forEach((h, i) => {
    const want = v.hourly[i];
    assert.equal(h.hourStartUtc, want.hourStartUtc);
    assert.ok(Math.abs(h.et0Mm - want.et0Mm) <= 1e-4, want.hourStartUtc);
    assert.deepEqual([h.sunUp, h.rsRsoSource], [want.sunUp, want.rsRsoSource], want.hourStartUtc);
  });
  const sources = day.hourly.map((h) => h.rsRsoSource);
  assert.deepEqual(sources.slice(0, 6), Array(6).fill('default'), 'no carry hour yet: 0.5');
  assert.equal(day.hourly[6].hourStartUtc, '2026-07-19T04:00:00Z');
  assert.equal(day.hourly[6].sunUp, true, 'sunrise at 4.05 UTC: the 04:00 hour is the first day hour');
  const carries = v.input.hours.filter((h) => et0.fao56HourlyTerms({ ...h, windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 200 }).carryCandidate);
  assert.deepEqual(carries.map((h) => h.hourStartUtc), ['2026-07-19T16:00:00Z']);
  const straddle = et0.fao56HourlyTerms({ ...v.input.hours[21], windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 200, nightRsRso: 0.79 });
  assert.deepEqual([straddle.sunUp, straddle.ra > 0, straddle.g / straddle.rn], [false, true, 0.5], 'the hour across sunset takes the night rules with Ra above 0');
  assert.deepEqual(sources.slice(21), ['carried', 'carried', 'carried']);
});

test('fao56Et0HourlyDay: priorRsRso before the first carry hour, a negative day is 0, one missing field voids the day', () => {
  const hour = { hourStartUtc: '2026-07-18T22:00:00Z', tMeanC: 15, rhPct: 80, windSpeedMs: 2, solarRadMjM2h: 0 };
  const site = { windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 200 };
  const prior = et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 0.7 });
  assert.deepEqual([prior.hourly[0].rsRsoSource, prior.lastRsRso], ['prior', 0.7]);
  const fallback = et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: null });
  assert.deepEqual([fallback.hourly[0].rsRsoSource, fallback.lastRsRso], ['default', 0.5]);
  // A saturated winter day at Payerne without sun: every hour loses longwave radiation.
  const winter = Array.from({ length: 24 }, (_, h) => ({ hourStartUtc: new Date(Date.parse('2026-12-20T23:00:00Z') + h * 3600000).toISOString(), tMeanC: 1, rhPct: 100, windSpeedMs: 1, solarRadMjM2h: 0 }));
  const negative = et0.fao56Et0HourlyDay({ ...site, dayOfYear: 355, hours: winter, priorRsRso: null });
  assert.ok(negative.sumMm < 0, String(negative.sumMm));
  assert.equal(negative.et0Mm, 0);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour, { ...hour, hourStartUtc: '2026-07-18T23:00:00Z', tMeanC: null }] }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour, null] }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [] }), null);
  // A carried ratio is a clamped day ratio: outside [0.3, 1.0] it is an input error (spec A7).
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 0.29 }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 1.2 }), null);
  assert.equal(et0.fao56Et0HourlyDay({ ...site, hours: [hour], priorRsRso: 0.3 }).lastRsRso, 0.3);
});

test('fao56HourlyTerms null rules and the standalone night ratio', () => {
  const base = vectors.fao56Hourly.find((v) => v.name === 'payerne_summer_noon').input;
  assert.ok(et0.fao56HourlyTerms(base));
  for (const [field, value] of [['tMeanC', null], ['rhPct', 101], ['rhPct', -1], ['windSpeedMs', -0.1], ['solarRadMjM2h', -0.1], ['latDeg', null], ['lonDeg', undefined], ['dayOfYear', 0], ['dayOfYear', 367], ['hourStartUtc', 'not a time'], ['hourStartUtc', '2026-07-19T11:00:00'], ['nightRsRso', 0.2], ['nightRsRso', 1.01], ['nightRsRso', 'x'], ['windHeightM', null], ['windHeightM', 0.09], ['elevationM', NaN]]) {
    assert.equal(et0.fao56HourlyTerms({ ...base, [field]: value }), null, `${field}=${value}`);
  }
  assert.ok(et0.fao56HourlyTerms({ ...base, elevationM: null }), 'a null elevation is 0 m');
  const night = vectors.fao56Hourly.find((v) => v.name === 'payerne_winter_night').input;
  assert.equal(et0.fao56HourlyTerms({ ...night, nightRsRso: null }).rsRsoSource, 'default');
  assert.equal(et0.fao56HourlyTerms({ ...night, nightRsRso: null }).rsRso, 0.5);
  assert.equal(et0.fao56HourlyTerms({ ...night, nightRsRso: 0.8 }).rsRsoSource, 'prior');
  assert.equal(et0.fao56HourlyTerms({ ...base, hourStartUtc: Date.parse(base.hourStartUtc) }).et0Mm, et0.fao56HourlyTerms(base).et0Mm, 'epoch ms or ISO');
  assert.equal(et0.fao56HourlyTerms({ ...base, hourStartUtc: '2026-07-19T13:00:00+02:00' }).et0Mm, et0.fao56HourlyTerms(base).et0Mm, 'an offset names the same instant');
});
```

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js`
Expected: the four new tests fail (`vectors.fao56Hourly` is undefined, then `et0.fao56HourlyTerms is not a function`); the seven existing tests pass.

- [ ] **Step 2: The reference writes the hourly vectors**

`hourly_et0.py` keeps its FAO-form function `hourly_et0()` (the Example 19 comparison, now behind `--reference`) and gains the contract chain of spec A7 (clipped ω1 and ω2, `Rso ≥ 1e-4`, the day ratio clamped to [0.3, 1.0], the carried night ratio) and the writer of the two groups. The Example 19 entries carry the values FAO-56 prints with the A8 tolerances; the computed entries carry five decimals and 1e-4.

`$SCRATCH/patch-hourly-et0.py`:
```python
# One-shot (plan E1, Task 4): hourly_et0.py gains the contract chain (spec A7) and
# writes the fao56Hourly and fao56HourlyDays groups of et0-vectors.json.
import pathlib
p = pathlib.Path("docs/contracts/agronomy/sources/hourly_et0.py")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:70])
    s = s.replace(old, new)
swap("import json, math, sys\n", "import datetime, json, math, os, sys\n")
swap("def main():\n", "def reference_report():\n")
swap('    json.dump(out, open("hourly-et0-vectors.json", "w"), indent=2, ensure_ascii=False)\n', "")
swap('''if __name__ == "__main__":
    main()
''', '''# ---- contract v2 chain (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A7) ----
# Differs from hourly_et0() above in four contract rules: omega1/omega2 are always
# clipped to [-ws, ws]; Rso is floored at 1e-4; a day hour's Rs/Rso is clamped to
# [0.3, 1.0]; a night hour takes the carried ratio. Clock time is UTC with the
# longitude in degrees east (eq. 31 with Lz = 0, Lm = -lon).
HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS_PATH = os.path.join(HERE, "..", "et0-vectors.json")
NIGHT_DEFAULT = 0.5


def epoch_ms(iso):
    return int(datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def contract_solar_hour(lat_deg, J, start_ms, lon_deg):
    phi = math.pi / 180 * lat_deg
    dr = 1 + 0.033 * math.cos(2 * math.pi / 365 * J)
    dec = 0.409 * math.sin(2 * math.pi / 365 * J - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(dec))))
    b = 2 * math.pi * (J - 81) / 364
    Sc = 0.1645 * math.sin(2 * b) - 0.1255 * math.cos(b) - 0.025 * math.sin(b)
    mid = math.fmod(math.fmod(start_ms / 3600000 + 0.5, 24) + 24, 24)
    w = math.pi / 12 * ((mid + lon_deg / 15 + Sc) - 12)
    w = math.atan2(math.sin(w), math.cos(w))
    w1 = max(-ws, min(ws, w - math.pi / 24))
    w2 = max(-ws, min(ws, w + math.pi / 24))
    Ra = 0.0
    if w2 > w1:
        Ra = max(0.0, 12 * 60 / math.pi * GSC * dr * ((w2 - w1) * math.sin(phi) * math.sin(dec)
                                                    + math.cos(phi) * math.cos(dec) * (math.sin(w2) - math.sin(w1))))
    return ws, w, Ra


def contract_terms(*, T, RH, uz, zw, Rs, z, lat_deg, lon_deg, J, hour_start, night):
    u2 = uz if abs(zw - 2) < 1e-9 else u2_from_uz(uz, zw)
    P = 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26
    gamma = 0.000665 * P
    es = 0.6108 * math.exp(17.27 * T / (T + 237.3))
    delta = 4098 * es / (T + 237.3) ** 2
    ea = es * RH / 100
    ws, w, Ra = contract_solar_hour(lat_deg, J, epoch_ms(hour_start), lon_deg)
    sun_up = -ws <= w <= ws
    Rso = max(1e-4, (0.75 + 2e-5 * z) * Ra)
    Rns = 0.77 * Rs
    ratio = max(0.3, min(1.0, Rs / Rso)) if sun_up else night
    Rnl = SIGMA_HR * (T + 273.16) ** 4 * (0.34 - 0.14 * math.sqrt(ea)) * (1.35 * ratio - 0.35)
    Rn = Rns - Rnl
    G = 0.1 * Rn if sun_up else 0.5 * Rn
    D = delta + gamma * (1 + 0.34 * u2)
    rad = 0.408 * delta * (Rn - G) / D
    aero = gamma * 37 / (T + 273) * u2 * (es - ea) / D
    carry = sun_up and ws - 0.79 <= w <= ws - 0.52
    return dict(ra=Ra, rso=Rso, rn=Rn, g=G, rsRso=ratio, et0=rad + aero, sunUp=sun_up, carry=carry)


def contract_day(hours, *, zw, z, lat_deg, lon_deg, J, prior):
    carried = NIGHT_DEFAULT if prior is None else prior
    source = "default" if prior is None else "prior"
    total = 0.0
    hourly = []
    for h in hours:
        t = contract_terms(T=h["tMeanC"], RH=h["rhPct"], uz=h["windSpeedMs"], zw=zw, Rs=h["solarRadMjM2h"], z=z,
                           lat_deg=lat_deg, lon_deg=lon_deg, J=J, hour_start=h["hourStartUtc"], night=carried)
        hourly.append({"hourStartUtc": h["hourStartUtc"], "et0Mm": round(t["et0"], 5), "sunUp": t["sunUp"],
                       "rsRsoSource": "measured" if t["sunUp"] else source})
        if t["carry"]:
            carried, source = t["rsRso"], "carried"
        total += t["et0"]
    return total, carried, hourly


def num(x):
    """Integral floats as integers, so the file keeps the JSON.stringify style of the rest."""
    return int(x) if isinstance(x, float) and x.is_integer() else x


def hourly_entry(name, inp, **extra):
    t = contract_terms(T=inp["tMeanC"], RH=inp["rhPct"], uz=inp["windSpeedMs"], zw=inp["windHeightM"],
                       Rs=inp["solarRadMjM2h"], z=inp["elevationM"], lat_deg=inp["latDeg"], lon_deg=inp["lonDeg"],
                       J=inp["dayOfYear"], hour_start=inp["hourStartUtc"],
                       night=NIGHT_DEFAULT if inp["nightRsRso"] is None else inp["nightRsRso"])
    entry = {"name": name, "input": {k: num(v) for k, v in inp.items()}, "et0Mm": round(t["et0"], 5), "tolerance": 0.0001}
    entry.update(extra)
    if "terms" in extra and extra["terms"] == "computed":
        entry["terms"] = {k: round(t[k], 5) for k in ("ra", "rso", "rn", "g")}
    return entry


def contract_vectors():
    ex19 = dict(windHeightM=2, elevationM=8, latDeg=16.21667, lonDeg=-16.25, dayOfYear=274)
    night19 = dict(tMeanC=28, rhPct=90, windSpeedMs=1.9, solarRadMjM2h=0, hourStartUtc="2026-10-01T03:00:00Z", nightRsRso=0.8)
    day19 = dict(tMeanC=38, rhPct=52, windSpeedMs=3.3, solarRadMjM2h=2.45, hourStartUtc="2026-10-01T15:00:00Z", nightRsRso=None)
    order = ("tMeanC", "rhPct", "windSpeedMs", "windHeightM", "solarRadMjM2h", "elevationM", "latDeg", "lonDeg", "dayOfYear", "hourStartUtc", "nightRsRso")
    def inp(**kw):
        return {k: kw[k] for k in order}
    payerne = dict(elevationM=490, latDeg=46.8, lonDeg=6.95)
    u10 = round(2 / (4.87 / math.log(67.8 * 10 - 5.42)), 10)
    hourly = [
        # FAO-56 Example 19, published values (https://www.fao.org/4/x0490e/x0490e08.htm); A8 tolerances.
        {"name": "fao56_example19_0200_0300", "input": inp(**ex19, **night19), "et0Mm": 0, "tolerance": 0.005,
         "terms": {"delta": 0.22, "gamma": 0.0673, "es": 3.78, "ea": 3.402, "omega": -2.46, "ra": 0, "rso": 0, "rns": 0,
                   "rsRso": 0.8, "rnl": 0.1, "rn": -0.1, "g": -0.05, "radTerm": -0.01, "aeroTerm": 0.01},
         "termTolerance": {"default": 0.001, "radTerm": 0.01, "aeroTerm": 0.01}},
        {"name": "fao56_example19_1400_1500", "input": inp(**ex19, **day19), "et0Mm": 0.63, "tolerance": 0.005,
         "terms": {"delta": 0.358, "gamma": 0.0673, "es": 6.625, "ea": 3.445, "omega": 0.682, "ra": 3.543, "rso": 2.658,
                   "rns": 1.887, "rsRso": 0.922, "rnl": 0.137, "rn": 1.749, "g": 0.175, "radTerm": 0.46, "aeroTerm": 0.17},
         "termTolerance": {"default": 0.001, "radTerm": 0.005, "aeroTerm": 0.005}},
        hourly_entry("payerne_summer_noon", inp(tMeanC=28, rhPct=45, windSpeedMs=2, windHeightM=2, solarRadMjM2h=3, **payerne,
                     dayOfYear=200, hourStartUtc="2026-07-19T11:00:00Z", nightRsRso=None), terms="computed"),
        hourly_entry("payerne_summer_noon_10m", inp(tMeanC=28, rhPct=45, windSpeedMs=u10, windHeightM=10, solarRadMjM2h=3, **payerne,
                     dayOfYear=200, hourStartUtc="2026-07-19T11:00:00Z", nightRsRso=None)),
        hourly_entry("payerne_winter_night", inp(tMeanC=1, rhPct=90, windSpeedMs=1, windHeightM=2, solarRadMjM2h=0, **payerne,
                     dayOfYear=355, hourStartUtc="2026-12-21T01:00:00Z", nightRsRso=0.5)),
    ]
    # One synthetic station day (A9): local day 2026-07-19 in Europe/Zurich.
    start = epoch_ms("2026-07-18T22:00:00Z")
    hours = []
    for h in range(24):
        iso = datetime.datetime.fromtimestamp((start + h * 3600000) / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        s_ = math.sin(2 * math.pi * (h - 9) / 24)
        ra_h = contract_solar_hour(46.8, 200, epoch_ms(iso), 6.95)[2]
        hours.append({"hourStartUtc": iso, "tMeanC": num(round(20 + 7 * s_, 4)), "rhPct": num(round(65 - 20 * s_, 4)),
                      "windSpeedMs": 2, "solarRadMjM2h": num(round(0.6 * ra_h, 4))})
    total, last, per_hour = contract_day(hours, zw=2, z=490, lat_deg=46.8, lon_deg=6.95, J=200, prior=None)
    day = {"name": "payerne_synthetic_2026_07_19",
           "input": {"hours": hours, "windHeightM": 2, "elevationM": 490, "latDeg": 46.8, "lonDeg": 6.95, "dayOfYear": 200, "priorRsRso": None},
           "sumMm": round(total, 6), "et0Mm": math.floor(max(0.0, total) * 100 + 0.5) / 100, "lastRsRso": round(last, 4), "hourly": per_hour}
    return hourly, [day]


def main():
    if "--reference" in sys.argv:
        reference_report()
        return
    with open(VECTORS_PATH, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc["fao56Hourly"], doc["fao56HourlyDays"] = contract_vectors()
    note = (" fao56Hourly and fao56HourlyDays: written by docs/contracts/agronomy/sources/hourly_et0.py (stdlib Python, sigma = 4.903e-9 / 24)"
            " with the contract chain of spec 2026-09-27-daily-agronomy-parity A7, reproduced by osi-agronomy-daily/et0.js;"
            " the two Example 19 entries carry the values FAO-56 prints, with the A8 tolerances.")
    base = doc["provenance"].split(" fao56Hourly and fao56HourlyDays:")[0]
    doc["provenance"] = base + note
    with open(VECTORS_PATH, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\\n")
    day = doc["fao56HourlyDays"][0]
    print("et0-vectors.json: %d hourly entries, synthetic day sumMm %s et0Mm %s lastRsRso %s"
          % (len(doc["fao56Hourly"]), day["sumMm"], day["et0Mm"], day["lastRsRso"]))


if __name__ == "__main__":
    main()
''')
p.write_text(s, encoding="utf-8")
print("hourly_et0.py patched")
```
```bash
python3 "$SCRATCH/patch-hourly-et0.py"
python3 docs/contracts/agronomy/sources/hourly_et0.py
python3 docs/contracts/agronomy/sources/hourly_et0.py --reference | head -1
sha256sum docs/contracts/agronomy/et0-vectors.json
node -e "const v = require('./docs/contracts/agronomy/et0-vectors.json'); for (const e of v.fao56Hourly) console.log(e.name, e.et0Mm); const d = v.fao56HourlyDays[0]; console.log(d.hourly.map((h) => h.rsRsoSource[0] + (h.sunUp ? '+' : '-')).join(' '));"
```
Expected: `hourly_et0.py patched`; `et0-vectors.json: 5 hourly entries, synthetic day sumMm 4.845356 et0Mm 4.85 lastRsRso 0.7897`; `fao56_example19_0200_0300 max |published - recomputed| = 0.008`; hash `4835134027785c7ef50634531f49202927004cb4fb65dfac4c4b9abcedb256a7`; the entries `fao56_example19_0200_0300 0`, `fao56_example19_1400_1500 0.63`, `payerne_summer_noon 0.61171`, `payerne_summer_noon_10m 0.61171`, `payerne_winter_night -0.0021`; and the day's sources `d- d- d- d- d- d- m+ m+ m+ m+ m+ m+ m+ m+ m+ m+ m+ m+ m+ m+ m+ c- c- c-` (six default night hours, the 04:00 UTC hour the first day hour, the 19:00 UTC hour across sunset a night hour that takes the carried ratio). The spec's `sumMm 4.845367` came from unrounded inputs; with every input stored to 4 decimals, as A9 asks, the sum is 4.845356, within the 1e-4 tolerance.

- [ ] **Step 3: The hourly chain in `et0.js`**

`$SCRATCH/et0-patch.py`:
```python
# One-shot (plan E1, Task 4): the hourly FAO-56 chain in et0.js.
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:70])
    s = s.replace(old, new)
swap("""// radiation), 28-33 (hourly extraterrestrial radiation). Vapour pressure from mean relative humidity, as the cloud's""",
     """// radiation), 28-33 (hourly extraterrestrial radiation), 53 (hourly
// Penman-Monteith, contract v2 A7). Vapour pressure from mean relative humidity, as the cloud's""")
swap("""const SIGMA = 4.903e-9;  // MJ K-4 m-2 day-1
""", """const SIGMA = 4.903e-9;  // MJ K-4 m-2 day-1
const SIGMA_HOURLY = 4.903e-9 / 24; // MJ K-4 m-2 h-1, written as this expression in every runtime (A7)
const DEFAULT_NIGHT_RS_RSO = 0.5;   // FAO-56 ch. 4: 0.4-0.6 at night in humid and subhumid climates
""")
old_start = s.index("// FAO-56 eq. 28-33 for one hour starting at")
old_end = s.index("function fao56Et0(input) {")
s = s[:old_start] + """// FAO-56 eq. 22-33 for one hour starting at `hourStartMs` (epoch ms): the
// sun's position at mid-hour and the hour's extraterrestrial radiation. Solar
// time from UTC and the longitude (degrees east positive): t_solar = t_utc +
// lon / 15 + Sc (eq. 31-33 with Lz = 0 and Lm = -lon). The hour's end angles
// are clipped to sunrise and sunset (ASCE-EWRI 2005 practice, README), so a
// night hour is 0 and an hour that straddles sunrise or sunset keeps its lit part.
function solarHour(latDeg, dayOfYear, hourStartMs, longitudeDeg) {
  const phi = (Math.PI / 180) * latDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI / 365) * dayOfYear);
  const declination = 0.409 * Math.sin((2 * Math.PI / 365) * dayOfYear - 1.39);
  const omegaS = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(declination))));
  const b = 2 * Math.PI * (dayOfYear - 81) / 364;
  const sc = 0.1645 * Math.sin(2 * b) - 0.1255 * Math.cos(b) - 0.025 * Math.sin(b);
  const midUtcHours = (((hourStartMs / 3600000) + 0.5) % 24 + 24) % 24;
  let omega = (Math.PI / 12) * ((midUtcHours + longitudeDeg / 15 + sc) - 12);
  omega = Math.atan2(Math.sin(omega), Math.cos(omega)); // into (-pi, pi]
  const omega1 = Math.max(-omegaS, Math.min(omegaS, omega - Math.PI / 24));
  const omega2 = Math.max(-omegaS, Math.min(omegaS, omega + Math.PI / 24));
  const ra = omega2 > omega1
    ? Math.max(0, (12 * 60 / Math.PI) * GSC * dr * ((omega2 - omega1) * Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * (Math.sin(omega2) - Math.sin(omega1))))
    : 0;
  return { declination, dr, omegaS, omega, omega1, omega2, ra };
}
// Epoch ms, or an ISO instant with 'Z' or an offset. Date.parse reads a time
// string without a zone as local time, and Java's Instant.parse refuses it, so
// the contract refuses it too (spec A7). Every edge caller passes hourStartIso
// values ('…:00Z') or epoch ms.
const ISO_INSTANT = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$/;
function hourMs(hourStartUtc) {
  if (typeof hourStartUtc === 'number') return hourStartUtc;
  return typeof hourStartUtc === 'string' && ISO_INSTANT.test(hourStartUtc) ? Date.parse(hourStartUtc) : NaN;
}
// A carried night ratio is a clamped day ratio, so anything outside [0.3, 1.0]
// is an input error (spec A7); null and undefined mean "not given".
function badRatio(value) { return value != null && !(finite(value) && value >= 0.3 && value <= 1); }
// MJ m-2 for the hour starting at `hourStartUtc` (an ISO instant or epoch ms).
function hourlyExtraterrestrialRadiation(latDeg, dayOfYear, hourStartUtc, longitudeDeg) {
  const startMs = hourMs(hourStartUtc);
  if (!finite(latDeg) || !finite(longitudeDeg) || !validDay(dayOfYear) || !Number.isFinite(startMs)) return null;
  return solarHour(latDeg, dayOfYear, startMs, longitudeDeg).ra;
}
// Every term of FAO-56 eq. 53 for one hour (contract v2 A7). A day hour (sun
// above the horizon at mid-hour) takes its measured Rs/Rso clamped to
// [0.3, 1.0]; a night hour takes `nightRsRso` ('prior'), else 0.5
// ('default'). The ET0 is signed and not rounded: FAO-56 ch. 11 reads a
// negative hour as net condensation. Null for a missing or out-of-range input.
function fao56HourlyTerms(input) {
  const { tMeanC, rhPct, windSpeedMs, windHeightM, solarRadMjM2h, elevationM, latDeg, lonDeg, dayOfYear, hourStartUtc, nightRsRso } = input || {};
  if (![tMeanC, rhPct, windSpeedMs, solarRadMjM2h, latDeg, lonDeg].every(finite) || !validDay(dayOfYear)) return null;
  if (rhPct < 0 || rhPct > 100 || windSpeedMs < 0 || solarRadMjM2h < 0) return null;
  if (elevationM != null && !finite(elevationM)) return null;
  if (badRatio(nightRsRso)) return null;
  const startMs = hourMs(hourStartUtc);
  if (!Number.isFinite(startMs)) return null;
  const u2 = windAt2m(windSpeedMs, windHeightM);
  if (u2 == null) return null;
  const z = elevationM == null ? 0 : elevationM;
  const pressureKpa = 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26);
  const gamma = 0.000665 * pressureKpa;
  const es = satVapourPressure(tMeanC);
  const delta = 4098 * es / Math.pow(tMeanC + 237.3, 2);
  const ea = es * rhPct / 100;
  const sun = solarHour(latDeg, dayOfYear, startMs, lonDeg);
  const sunUp = -sun.omegaS <= sun.omega && sun.omega <= sun.omegaS;
  const rso = Math.max(1e-4, (0.75 + 2e-5 * z) * sun.ra);
  const rns = 0.77 * solarRadMjM2h;
  let rsRso;
  let rsRsoSource;
  if (sunUp) { rsRso = Math.max(0.3, Math.min(1, solarRadMjM2h / rso)); rsRsoSource = 'measured'; }
  else if (finite(nightRsRso)) { rsRso = nightRsRso; rsRsoSource = 'prior'; }
  else { rsRso = DEFAULT_NIGHT_RS_RSO; rsRsoSource = 'default'; }
  // FAO-56 ch. 4 night rule: the hour 2-3 h before sunset.
  const carryCandidate = sunUp && sun.omega >= sun.omegaS - 0.79 && sun.omega <= sun.omegaS - 0.52;
  const rnl = SIGMA_HOURLY * Math.pow(tMeanC + 273.16, 4) * (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * rsRso - 0.35);
  const rn = rns - rnl;
  const g = sunUp ? 0.1 * rn : 0.5 * rn;
  const denominator = delta + gamma * (1 + 0.34 * u2);
  if (!(denominator > 0)) return null;
  const radTerm = 0.408 * delta * (rn - g) / denominator;
  const aeroTerm = gamma * 37 / (tMeanC + 273) * u2 * (es - ea) / denominator;
  return {
    u2, pressureKpa, gamma, es, delta, ea,
    declination: sun.declination, dr: sun.dr, omegaS: sun.omegaS, omega: sun.omega, omega1: sun.omega1, omega2: sun.omega2, ra: sun.ra,
    rso, rns, rsRso, rnl, rn, g, radTerm, aeroTerm, et0Mm: radTerm + aeroTerm,
    sunUp, rsRsoSource, carryCandidate,
  };
}
function fao56Et0Hourly(input) {
  const terms = fao56HourlyTerms(input);
  return terms ? terms.et0Mm : null;
}
// One local day as the sum of its signed hours, clamped at 0 once and rounded
// to 2 decimals (ruling R3). `hours` is every hour of the day in time order,
// { hourStartUtc, tMeanC, rhPct, windSpeedMs, solarRadMjM2h }; a null hour, a
// null field or a failed hour makes the day null, so the caller decides
// completeness first. Night hours take the ratio of the day's carry hour, else
// `priorRsRso`, else 0.5 (the FAO-56 ch. 4 night rule).
function fao56Et0HourlyDay({ hours, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, priorRsRso } = {}) {
  if (!Array.isArray(hours) || !hours.length || badRatio(priorRsRso)) return null;
  let carried = finite(priorRsRso) ? priorRsRso : DEFAULT_NIGHT_RS_RSO;
  let carriedSource = finite(priorRsRso) ? 'prior' : 'default';
  let sumMm = 0;
  const hourly = [];
  for (const hour of hours) {
    if (!hour || hour.hourStartUtc == null || [hour.tMeanC, hour.rhPct, hour.windSpeedMs, hour.solarRadMjM2h].some((v) => v == null)) return null;
    const terms = fao56HourlyTerms({ ...hour, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, nightRsRso: carried });
    if (!terms) return null;
    const rsRsoSource = terms.sunUp ? 'measured' : carriedSource;
    if (terms.carryCandidate) { carried = terms.rsRso; carriedSource = 'carried'; }
    sumMm += terms.et0Mm;
    hourly.push({ hourStartUtc: hour.hourStartUtc, et0Mm: terms.et0Mm, sunUp: terms.sunUp, rsRsoSource });
  }
  return { et0Mm: round2(Math.max(0, sumMm)), sumMm, lastRsRso: carried, hourly };
}
""" + s[old_end:]
swap("module.exports = { fao56Et0, hargreavesEt0, windAt2m, luxToWm2, wm2HoursToMjPerDay, extraterrestrialRadiation, hourlyExtraterrestrialRadiation, elevationFromPressure };",
     "module.exports = { fao56Et0, hargreavesEt0, windAt2m, luxToWm2, wm2HoursToMjPerDay, extraterrestrialRadiation, hourlyExtraterrestrialRadiation, elevationFromPressure, fao56HourlyTerms, fao56Et0Hourly, fao56Et0HourlyDay };")
p.write_text(s, encoding="utf-8")
print("et0.js: hourly chain added")
```
```bash
python3 "$SCRATCH/et0-patch.py"
node -e "
const e = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js');
const ex = { latDeg: 16.21667, lonDeg: -16.25, elevationM: 8, windHeightM: 2, dayOfYear: 274 };
for (const t of [e.fao56HourlyTerms({ ...ex, tMeanC: 28, rhPct: 90, windSpeedMs: 1.9, solarRadMjM2h: 0, hourStartUtc: '2026-10-01T03:00:00Z', nightRsRso: 0.8 }), e.fao56HourlyTerms({ ...ex, tMeanC: 38, rhPct: 52, windSpeedMs: 3.3, solarRadMjM2h: 2.45, hourStartUtc: '2026-10-01T15:00:00Z', nightRsRso: null })])
  console.log(['delta', 'gamma', 'es', 'ea', 'omega', 'ra', 'rso', 'rns', 'rsRso', 'rnl', 'rn', 'g', 'radTerm', 'aeroTerm', 'et0Mm'].map((k) => t[k].toFixed(5)).join(' '), t.sunUp, t.rsRsoSource);"
```
Expected: `et0.js: hourly chain added`, then the two columns of spec A8 ("Contract recomputed"):
```
0.22008 0.06730 3.77993 3.40194 -2.45945 0.00000 0.00010 0.00000 0.80000 0.10032 -0.10032 -0.05016 -0.01361 0.01796 0.00434 false prior
0.35820 0.06730 6.62476 3.44487 0.68215 3.54341 2.65813 1.88650 0.92170 0.13728 1.74922 0.17492 0.45922 0.16770 0.62693 true measured
```
(Rso prints 0.00010 at night: the 1e-4 floor, within 0.001 of the book's 0.)

- [ ] **Step 4: The verifier runs the hourly vectors**

`scripts/verify-agronomy-contract.js`, whole file:
```js
#!/usr/bin/env node
'use strict';
// verify-agronomy-contract: docs/contracts/agronomy is the source; every copy
// must be byte-identical, and the edge modules must reproduce the vectors.
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A1 and B1).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'contracts', 'agronomy');
const source = fs.readFileSync(path.join(dir, 'crop-kc.json'));
const copies = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'web/react-gui/src/agronomy/crop-kc.json',
];
const LENGTH_FIELDS = ['initial', 'development', 'mid_season', 'late_season'];
const PROVENANCE_FIELDS = ['table11_row', 'plant_date', 'region', 'selection_rule'];
const failures = [];
for (const rel of copies) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(rel + ': missing'); continue; }
  if (Buffer.compare(fs.readFileSync(abs), source) !== 0) failures.push(rel + ': differs from docs/contracts/agronomy/crop-kc.json');
}
const catalogue = JSON.parse(source.toString('utf8'));
if (catalogue.version !== 2) failures.push('crop-kc.json: version must be 2, found ' + catalogue.version);
const groups = new Set((catalogue.groups || []).map((g) => g.id));
for (const g of catalogue.groups || []) if (!['woody', 'annual'].includes(g.stageFamily)) failures.push('group ' + g.id + ': stageFamily must be woody or annual');
// A default length is a positive integer or null (A1). An alternative may
// also carry Table 11's printed 0 ("Faba bean, broad bean - green", late
// season): no code reads alternatives, and the cell stays verbatim.
function lengthRowProblems(label, s, allowZero = false) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [label + ' must be an object'];
  const keys = Object.keys(s);
  const want = [...LENGTH_FIELDS, ...PROVENANCE_FIELDS, 'verified'];
  if (keys.length !== want.length || want.some((k) => !keys.includes(k))) out.push(label + ' must have exactly ' + want.join(', '));
  for (const k of LENGTH_FIELDS) if (!(s[k] === null || (Number.isInteger(s[k]) && (s[k] > 0 || (allowZero && s[k] === 0))))) out.push(label + '.' + k + ' must be a positive integer or null');
  for (const k of PROVENANCE_FIELDS) if (typeof s[k] !== 'string') out.push(label + '.' + k + ' must be a string');
  if (typeof s.verified !== 'boolean') out.push(label + '.verified must be a boolean');
  return out;
}
const ids = new Set();
for (const crop of catalogue.crops) {
  if (ids.has(crop.id)) failures.push('duplicate crop id ' + crop.id);
  ids.add(crop.id);
  if (!groups.has(crop.group)) failures.push(crop.id + ': unknown group ' + crop.group);
  for (const k of ['kc_ini', 'kc_mid', 'kc_end']) if (!(crop[k] > 0 && crop[k] < 2)) failures.push(crop.id + ': ' + k + ' out of range');
  if (crop.variant_of && !catalogue.crops.some((c) => c.id === crop.variant_of && c.group === crop.group && !c.variant_of)) failures.push(crop.id + ': variant_of must name a default entry of the same group');
  failures.push(...lengthRowProblems(crop.id + '.stage_lengths_days', crop.stage_lengths_days));
  if (!Array.isArray(crop.stage_length_alternatives)) failures.push(crop.id + ': stage_length_alternatives must be an array');
  else crop.stage_length_alternatives.forEach((s, i) => failures.push(...lengthRowProblems(crop.id + '.stage_length_alternatives[' + i + ']', s, true)));
}
if (catalogue.crops.length !== 136) failures.push('expected 136 crops, found ' + catalogue.crops.length);
const kcModulePath = path.join(root, copies[0], '..', 'index.js');
const kc = require(kcModulePath);
const kcVectors = JSON.parse(fs.readFileSync(path.join(dir, 'kc-vectors.json'), 'utf8'));
if (kcVectors.length !== 1335) failures.push('kc-vectors.json: expected 1335 vectors, found ' + kcVectors.length);
let bad = 0;
for (const v of kcVectors) {
  const r = kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date });
  if (r.kc !== v.kc || r.kcSource !== v.kcSource || r.cropId !== v.cropId || r.stage !== v.stage || r.kcStageDay !== v.kcStageDay || r.stageOverrun !== v.stageOverrun) {
    bad += 1;
    if (bad <= 5) failures.push('kc vector mismatch: ' + JSON.stringify(v) + ' got ' + JSON.stringify(r));
  }
}
if (bad > 5) failures.push('kc vector mismatches: ' + bad);
// FAO-56 Example 28 (climate-adjusted Kc ini 0.15, Kc mid 1.19, Kc end 0.35): no catalogue row.
if (kc.kcRamp(0.15, 1.19, 14, 25) !== 0.77) failures.push('kcRamp: FAO-56 Example 28 day 40 must be 0.77');
if (kc.kcRamp(1.19, 0.35, 14, 20) !== 0.56) failures.push('kcRamp: FAO-56 Example 28 day 95 must be 0.56');
const et0 = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js'));
const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'et0-vectors.json'), 'utf8'));
const near = (got, want, tol) => (want == null ? got === null : typeof got === 'number' && Math.abs(got - want) <= tol);
for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) {
  const got = et0.fao56Et0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('fao56 vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.hargreaves) {
  const got = et0.hargreavesEt0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('hargreaves vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.luxToRadiation) {
  const got = et0.luxToWm2(v.lux, catalogue.luxPerWm2);
  if (!near(got, v.wm2, 0.01)) failures.push('lux vector ' + v.lux + ': expected ' + v.wm2 + ' got ' + got);
}
for (const v of vectors.elevationFromPressure) {
  const got = et0.elevationFromPressure(v.pressureKpa);
  if (!near(got, v.elevationM, 0.05)) failures.push('pressure vector ' + v.pressureKpa + ': expected ' + v.elevationM + ' got ' + got);
}
for (const v of vectors.fao56Hourly || []) {
  const terms = et0.fao56HourlyTerms(v.input);
  if (!terms) { failures.push('fao56Hourly vector ' + v.name + ': got null'); continue; }
  if (!near(terms.et0Mm, v.et0Mm, v.tolerance)) failures.push('fao56Hourly vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + terms.et0Mm);
  for (const [name, want] of Object.entries(v.terms || {})) {
    const tol = v.termTolerance ? (v.termTolerance[name] ?? v.termTolerance.default) : v.tolerance;
    if (!near(terms[name], want, tol)) failures.push('fao56Hourly vector ' + v.name + '.' + name + ': expected ' + want + ' got ' + terms[name]);
  }
}
for (const v of vectors.fao56HourlyDays || []) {
  const day = et0.fao56Et0HourlyDay(v.input);
  if (!day) { failures.push('fao56HourlyDays vector ' + v.name + ': got null'); continue; }
  if (!near(day.sumMm, v.sumMm, 1e-4) || day.et0Mm !== v.et0Mm || !near(day.lastRsRso, v.lastRsRso, 1e-4)) failures.push('fao56HourlyDays vector ' + v.name + ': got ' + JSON.stringify({ sumMm: day.sumMm, et0Mm: day.et0Mm, lastRsRso: day.lastRsRso }));
  v.hourly.forEach((want, i) => {
    const got = day.hourly[i];
    if (!got || got.hourStartUtc !== want.hourStartUtc || !near(got.et0Mm, want.et0Mm, 1e-4) || got.sunUp !== want.sunUp || got.rsRsoSource !== want.rsRsoSource) failures.push('fao56HourlyDays vector ' + v.name + ' hour ' + want.hourStartUtc + ': got ' + JSON.stringify(got));
  });
}
if (!(vectors.fao56Hourly || []).length || !(vectors.fao56HourlyDays || []).length) failures.push('et0-vectors.json: fao56Hourly and fao56HourlyDays must not be empty');
if (failures.length) { console.error('verify-agronomy-contract: FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('verify-agronomy-contract: OK (' + catalogue.crops.length + ' crops, contract v2, ' + kcVectors.length + ' Kc vectors, ' + vectors.fao56Hourly.length + ' hourly and ' + vectors.fao56HourlyDays.length + ' daily hourly-sum vectors, copies byte-identical)');
```

- [ ] **Step 5: Mirror and run the gates**

```bash
for f in et0.js et0.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily/$f; done
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js
node scripts/verify-agronomy-contract.js
node scripts/verify-profile-parity.js
```
Expected: `# pass 11`; the daily writer suites pass unchanged (the station tier still calls the daily `fao56Et0`); `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5 hourly and 1 daily hourly-sum vectors, copies byte-identical)`; `All parity checks passed.`

- [ ] **Step 6: Commit**

```bash
git add docs/contracts/agronomy/sources/hourly_et0.py docs/contracts/agronomy/et0-vectors.json scripts/verify-agronomy-contract.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily/et0.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily/et0.test.js
git -c user.name=Project-OSI commit -m "feat(agronomy): hourly FAO-56 Penman-Monteith ET0 (eq. 53), Example 19 and computed vectors"
```

---

### Task 5: The cloud copies check, CI and the README

**Files:**
- Modify: `scripts/verify-agronomy-contract.js`, `.github/workflows/migrations.yml`, `docs/contracts/agronomy/README.md`
- Scratch: `$SCRATCH/readme-v2.py`, `$SCRATCH/fakecloud/` (a throwaway copy tree for the check)

**Interfaces:**
- Produces: `node scripts/verify-agronomy-contract.js [<osi-server checkout>]`. With the argument it byte-compares `backend/src/main/resources/agronomy/crop-kc.json`, `frontend/src/agronomy/crop-kc.json`, `backend/src/test/resources/agronomy/kc-vectors.json` and `backend/src/test/resources/agronomy/et0-vectors.json` of that checkout against this directory and prints `cloud copies byte-identical in <path>`; without it, `cloud copies not checked (pass an osi-server checkout as the first argument)`. The cloud's CA plan copies the files; the cross-repo command of spec "Cross-repo" runs this.

- [ ] **Step 1: Write the failing check**

Build a throwaway checkout layout with one stale copy, and see the current verifier ignore it:
```bash
FAKE="$SCRATCH/fakecloud"; rm -rf "$FAKE"
mkdir -p "$FAKE/backend/src/main/resources/agronomy" "$FAKE/frontend/src/agronomy" "$FAKE/backend/src/test/resources/agronomy"
cp docs/contracts/agronomy/crop-kc.json "$FAKE/backend/src/main/resources/agronomy/"
git show feat/weather-data-view:docs/contracts/agronomy/crop-kc.json > "$FAKE/frontend/src/agronomy/crop-kc.json"
cp docs/contracts/agronomy/kc-vectors.json docs/contracts/agronomy/et0-vectors.json "$FAKE/backend/src/test/resources/agronomy/"
node scripts/verify-agronomy-contract.js "$FAKE"
```
Expected: `verify-agronomy-contract: OK (…)`: the argument is ignored, so the stale v1 frontend copy (the base branch's file) goes unnoticed. That is the failure this task fixes.

- [ ] **Step 2: Compare the cloud copies when a checkout is given**

`scripts/verify-agronomy-contract.js`, whole file:
```js
#!/usr/bin/env node
'use strict';
// verify-agronomy-contract: docs/contracts/agronomy is the source; every copy
// must be byte-identical, and the edge modules must reproduce the vectors.
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A1 and B1). Given an osi-server checkout as the first argument (CI passes
// `osi-server`; locally `node scripts/verify-agronomy-contract.js $CLOUD_WT`),
// the four cloud copies are byte-compared too.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'contracts', 'agronomy');
const source = fs.readFileSync(path.join(dir, 'crop-kc.json'));
const copies = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'web/react-gui/src/agronomy/crop-kc.json',
];
const CLOUD_COPIES = [
  ['backend/src/main/resources/agronomy/crop-kc.json', 'crop-kc.json'],
  ['frontend/src/agronomy/crop-kc.json', 'crop-kc.json'],
  ['backend/src/test/resources/agronomy/kc-vectors.json', 'kc-vectors.json'],
  ['backend/src/test/resources/agronomy/et0-vectors.json', 'et0-vectors.json'],
];
const LENGTH_FIELDS = ['initial', 'development', 'mid_season', 'late_season'];
const PROVENANCE_FIELDS = ['table11_row', 'plant_date', 'region', 'selection_rule'];
const failures = [];
for (const rel of copies) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(rel + ': missing'); continue; }
  if (Buffer.compare(fs.readFileSync(abs), source) !== 0) failures.push(rel + ': differs from docs/contracts/agronomy/crop-kc.json');
}
const catalogue = JSON.parse(source.toString('utf8'));
if (catalogue.version !== 2) failures.push('crop-kc.json: version must be 2, found ' + catalogue.version);
const groups = new Set((catalogue.groups || []).map((g) => g.id));
for (const g of catalogue.groups || []) if (!['woody', 'annual'].includes(g.stageFamily)) failures.push('group ' + g.id + ': stageFamily must be woody or annual');
// A default length is a positive integer or null (A1). An alternative may
// also carry Table 11's printed 0 ("Faba bean, broad bean - green", late
// season): no code reads alternatives, and the cell stays verbatim.
function lengthRowProblems(label, s, allowZero = false) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [label + ' must be an object'];
  const keys = Object.keys(s);
  const want = [...LENGTH_FIELDS, ...PROVENANCE_FIELDS, 'verified'];
  if (keys.length !== want.length || want.some((k) => !keys.includes(k))) out.push(label + ' must have exactly ' + want.join(', '));
  for (const k of LENGTH_FIELDS) if (!(s[k] === null || (Number.isInteger(s[k]) && (s[k] > 0 || (allowZero && s[k] === 0))))) out.push(label + '.' + k + ' must be a positive integer or null');
  for (const k of PROVENANCE_FIELDS) if (typeof s[k] !== 'string') out.push(label + '.' + k + ' must be a string');
  if (typeof s.verified !== 'boolean') out.push(label + '.verified must be a boolean');
  return out;
}
const ids = new Set();
for (const crop of catalogue.crops) {
  if (ids.has(crop.id)) failures.push('duplicate crop id ' + crop.id);
  ids.add(crop.id);
  if (!groups.has(crop.group)) failures.push(crop.id + ': unknown group ' + crop.group);
  for (const k of ['kc_ini', 'kc_mid', 'kc_end']) if (!(crop[k] > 0 && crop[k] < 2)) failures.push(crop.id + ': ' + k + ' out of range');
  if (crop.variant_of && !catalogue.crops.some((c) => c.id === crop.variant_of && c.group === crop.group && !c.variant_of)) failures.push(crop.id + ': variant_of must name a default entry of the same group');
  failures.push(...lengthRowProblems(crop.id + '.stage_lengths_days', crop.stage_lengths_days));
  if (!Array.isArray(crop.stage_length_alternatives)) failures.push(crop.id + ': stage_length_alternatives must be an array');
  else crop.stage_length_alternatives.forEach((s, i) => failures.push(...lengthRowProblems(crop.id + '.stage_length_alternatives[' + i + ']', s, true)));
}
if (catalogue.crops.length !== 136) failures.push('expected 136 crops, found ' + catalogue.crops.length);
const kcModulePath = path.join(root, copies[0], '..', 'index.js');
const kc = require(kcModulePath);
const kcVectors = JSON.parse(fs.readFileSync(path.join(dir, 'kc-vectors.json'), 'utf8'));
if (kcVectors.length !== 1335) failures.push('kc-vectors.json: expected 1335 vectors, found ' + kcVectors.length);
let bad = 0;
for (const v of kcVectors) {
  const r = kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date });
  if (r.kc !== v.kc || r.kcSource !== v.kcSource || r.cropId !== v.cropId || r.stage !== v.stage || r.kcStageDay !== v.kcStageDay || r.stageOverrun !== v.stageOverrun) {
    bad += 1;
    if (bad <= 5) failures.push('kc vector mismatch: ' + JSON.stringify(v) + ' got ' + JSON.stringify(r));
  }
}
if (bad > 5) failures.push('kc vector mismatches: ' + bad);
// FAO-56 Example 28 (climate-adjusted Kc ini 0.15, Kc mid 1.19, Kc end 0.35): no catalogue row.
if (kc.kcRamp(0.15, 1.19, 14, 25) !== 0.77) failures.push('kcRamp: FAO-56 Example 28 day 40 must be 0.77');
if (kc.kcRamp(1.19, 0.35, 14, 20) !== 0.56) failures.push('kcRamp: FAO-56 Example 28 day 95 must be 0.56');
const et0 = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js'));
const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'et0-vectors.json'), 'utf8'));
const near = (got, want, tol) => (want == null ? got === null : typeof got === 'number' && Math.abs(got - want) <= tol);
for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) {
  const got = et0.fao56Et0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('fao56 vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.hargreaves) {
  const got = et0.hargreavesEt0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('hargreaves vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.luxToRadiation) {
  const got = et0.luxToWm2(v.lux, catalogue.luxPerWm2);
  if (!near(got, v.wm2, 0.01)) failures.push('lux vector ' + v.lux + ': expected ' + v.wm2 + ' got ' + got);
}
for (const v of vectors.elevationFromPressure) {
  const got = et0.elevationFromPressure(v.pressureKpa);
  if (!near(got, v.elevationM, 0.05)) failures.push('pressure vector ' + v.pressureKpa + ': expected ' + v.elevationM + ' got ' + got);
}
for (const v of vectors.fao56Hourly || []) {
  const terms = et0.fao56HourlyTerms(v.input);
  if (!terms) { failures.push('fao56Hourly vector ' + v.name + ': got null'); continue; }
  if (!near(terms.et0Mm, v.et0Mm, v.tolerance)) failures.push('fao56Hourly vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + terms.et0Mm);
  for (const [name, want] of Object.entries(v.terms || {})) {
    const tol = v.termTolerance ? (v.termTolerance[name] ?? v.termTolerance.default) : v.tolerance;
    if (!near(terms[name], want, tol)) failures.push('fao56Hourly vector ' + v.name + '.' + name + ': expected ' + want + ' got ' + terms[name]);
  }
}
for (const v of vectors.fao56HourlyDays || []) {
  const day = et0.fao56Et0HourlyDay(v.input);
  if (!day) { failures.push('fao56HourlyDays vector ' + v.name + ': got null'); continue; }
  if (!near(day.sumMm, v.sumMm, 1e-4) || day.et0Mm !== v.et0Mm || !near(day.lastRsRso, v.lastRsRso, 1e-4)) failures.push('fao56HourlyDays vector ' + v.name + ': got ' + JSON.stringify({ sumMm: day.sumMm, et0Mm: day.et0Mm, lastRsRso: day.lastRsRso }));
  v.hourly.forEach((want, i) => {
    const got = day.hourly[i];
    if (!got || got.hourStartUtc !== want.hourStartUtc || !near(got.et0Mm, want.et0Mm, 1e-4) || got.sunUp !== want.sunUp || got.rsRsoSource !== want.rsRsoSource) failures.push('fao56HourlyDays vector ' + v.name + ' hour ' + want.hourStartUtc + ': got ' + JSON.stringify(got));
  });
}
if (!(vectors.fao56Hourly || []).length || !(vectors.fao56HourlyDays || []).length) failures.push('et0-vectors.json: fao56Hourly and fao56HourlyDays must not be empty');
let cloudLine = 'cloud copies not checked (pass an osi-server checkout as the first argument)';
const serverArg = process.argv[2];
if (serverArg) {
  const serverRoot = path.resolve(process.cwd(), serverArg);
  for (const [rel, name] of CLOUD_COPIES) {
    const abs = path.join(serverRoot, rel);
    if (!fs.existsSync(abs)) { failures.push('osi-server ' + rel + ': missing'); continue; }
    if (Buffer.compare(fs.readFileSync(abs), fs.readFileSync(path.join(dir, name))) !== 0) failures.push('osi-server ' + rel + ': differs from docs/contracts/agronomy/' + name);
  }
  cloudLine = 'cloud copies byte-identical in ' + serverRoot;
}
if (failures.length) { console.error('verify-agronomy-contract: FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log(cloudLine);
console.log('verify-agronomy-contract: OK (' + catalogue.crops.length + ' crops, contract v2, ' + kcVectors.length + ' Kc vectors, ' + vectors.fao56Hourly.length + ' hourly and ' + vectors.fao56HourlyDays.length + ' daily hourly-sum vectors, copies byte-identical)');
```
```bash
node scripts/verify-agronomy-contract.js "$FAKE"
cp docs/contracts/agronomy/crop-kc.json "$FAKE/frontend/src/agronomy/crop-kc.json"
node scripts/verify-agronomy-contract.js "$FAKE"
node scripts/verify-agronomy-contract.js
node scripts/verify-agronomy-contract.js /nonexistent || true
```
Expected: first `verify-agronomy-contract: FAIL` with `osi-server frontend/src/agronomy/crop-kc.json: differs from docs/contracts/agronomy/crop-kc.json`; after the copy `cloud copies byte-identical in …/fakecloud` and the OK line; without the argument `cloud copies not checked (pass an osi-server checkout as the first argument)` and the OK line; with a missing checkout, four `osi-server …: missing` lines and FAIL.

- [ ] **Step 3: CI runs the check against the paired osi-server branch**

`.github/workflows/migrations.yml` runs the verifier once today, at line 88 (`      - run: node scripts/verify-agronomy-contract.js`), in the `migrations` job that checks out the paired osi-server branch at `osi-server/` before its first step. Replace that line, so the check runs once, with the cloud copies:
```yaml
      # Daily agronomy parity: the contract, and the cloud's copies of crop-kc.json,
      # kc-vectors.json and et0-vectors.json in the same-named osi-server branch.
      - run: node scripts/verify-agronomy-contract.js osi-server
```
Check: `grep -c 'verify-agronomy-contract.js' .github/workflows/migrations.yml` prints `1`. The step pairs with osi-server `feat/daily-agronomy-parity`; it goes green once that branch carries plan CA's copies (spec D: both branches are pushed while either PR's CI runs; pushing stays Phil's call).

- [ ] **Step 4: The README**

`$SCRATCH/readme-v2.py`:
````python
# One-shot (plan E1, Task 5): docs/contracts/agronomy/README.md for contract v2
# (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A2).
import pathlib
p = pathlib.Path("docs/contracts/agronomy/README.md")
s = p.read_text(encoding="utf-8")


def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)


def replace_between(start, end, new):
    """Replace the text from `start` (included) up to `end` (excluded)."""
    global s
    i = s.index(start)
    j = s.index(end, i)
    if s.count(start) != 1:
        raise SystemExit("expected one match for: " + start[:80])
    s = s[:i] + new + s[j:]


swap("""| `crop-kc.json` | Stages, crop groups and 136 crops transcribed from FAO-56 Table 12, plus the two constants `luxPerWm2` and `stationWindHeightM` |
| `kc-vectors.json` | 1,252 Kc resolutions (crop, stage) → (kc, kcSource, cropId, stage), generated from `crop-kc.json` |
| `et0-vectors.json` | ET0 inputs and the values the cloud's `WeatherMath.java` returns for them |
""", """| `crop-kc.json` | Contract version 2: stages, crop groups and 136 crops transcribed from FAO-56 Table 12, each with its default Table 11 stage lengths and every other Table 11 row for the crop, plus the two constants `luxPerWm2` and `stationWindHeightM` |
| `kc-vectors.json` | 1,335 Kc resolutions (crop, stage, stage start date, date) → (kc, kcSource, cropId, stage, kcStageDay, stageOverrun), generated from `crop-kc.json` |
| `et0-vectors.json` | Daily ET0 inputs and the values the cloud's `WeatherMath.java` returns for them; the hourly FAO-56 groups `fao56Hourly` and `fao56HourlyDays` |
| `sources/` | The Table 11 transcription (`table11_rows.json`, `table11-stage-lengths.json`), the scripts that parse it and build `crop-kc.json` from it (`parse_table11.py`, `build_table11.py`), and the hourly ET0 reference that writes the hourly vectors (`hourly_et0.py`) |
""")

swap("""- later, a copy in osi-server
""", """- osi-server `backend/src/main/resources/agronomy/crop-kc.json` and `frontend/src/agronomy/crop-kc.json`
- osi-server `backend/src/test/resources/agronomy/kc-vectors.json` and `backend/src/test/resources/agronomy/et0-vectors.json`, which the Java tests and the cloud's frontend vector test read
""")

swap("""`node scripts/verify-agronomy-contract.js` fails when a copy differs from the `crop-kc.json` in this directory by a single byte. Once the edge modules exist it also runs both vector files against them (`osi-crop-kc/index.js` for Kc, `osi-agronomy-daily/et0.js` for ET0).
""", """`node scripts/verify-agronomy-contract.js` fails when a copy in this repository differs from the `crop-kc.json` in this directory by a single byte. It checks the version-2 fields of every crop, runs both vector files against the edge modules (`osi-crop-kc/index.js` for Kc, `osi-agronomy-daily/et0.js` for ET0) and runs the two FAO-56 Example 28 cases through `kcRamp`. Given an osi-server checkout as its first argument (`node scripts/verify-agronomy-contract.js ../osi-server`; CI passes `osi-server`) it also compares the four cloud copies byte for byte. Without the argument it prints one line saying the cloud copies were not checked.
""")

replace_between("## Kc rules\n", "A crop outside the catalogue (`other`", """## Kc rules

The inputs are the crop, the stage, the stage start date (`stageStartedOn`, `YYYY-MM-DD` or null) and the date the Kc is for. The stage is normalised first (the table above); the crop is matched after trimming and lower-casing. For a crop in the catalogue:

| Stage | Start date and stage length present | Otherwise |
|---|---|---|
| `initial` | `kc_ini`, `fao56_crop`, stage day set | `kc_ini`, `fao56_crop` |
| `development` | equation 66 from `kc_ini` to `kc_mid`, `fao56_curve`, stage day set | `kc_mid`, `fao56_crop` |
| `mid_season` | `kc_mid`, `fao56_crop`, stage day set | `kc_mid`, `fao56_crop` |
| `late_season` | equation 66 from `kc_mid` to `kc_end`, `fao56_curve`, stage day set | `kc_end`, `fao56_crop` |
| `dormancy` | 0.25, `fao56_crop` | 0.25, `fao56_crop` |
| unset | `kc_mid`, `fao56_crop_stage_unset` | `kc_mid`, `fao56_crop_stage_unset` |

FAO-56 equation 66, `Kc i = Kc prev + [(i − Σ(L prev)) / L stage] · (Kc next − Kc prev)`, puts each day of the development and late-season stages on the straight line between the Kc the stage starts from and the Kc it ends on (figure 25). `i` counts the days of the season from 1, so a stage that starts on date S has `i − Σ(L prev) = d + 1` on date S + d. The contract computes:

```
d        = whole calendar days from stageStartedOn to date   (0 on the start date; negative before it)
stageDay = d + 1                                             (FAO's day in the stage: 1 on the start date)
L        = stage_lengths_days[stage]
p        = min(1, max(0, stageDay / L))
kc       = prev + p * (next - prev)                          (development: kc_ini to kc_mid; late season: kc_mid to kc_end)
kc       = Math.round(kc * 100) / 100
```

`kc_stage_day` is FAO's day number within the stage, 1 on the start date, 0 or less before it; `stage_overrun` is true when it exceeds the stage's Table 11 length. Both are set for the four FAO stages whenever the date, the start date and that stage's length are present, and are null for dormancy, an unset stage, a crop outside the catalogue or a missing input. `kcSource` is `fao56_curve` whenever the ramp formula ran, the clamped days before the start date (p = 0) and past the length (p = 1) included. On the stage's last day (d = L − 1) Kc equals the value the stage ends on.

`d` counts calendar dates (`Date.UTC` parts in JavaScript, `ChronoUnit.DAYS.between` in Java), so daylight saving never shifts it. The operation order is part of the contract: the maize late season at d = 14 is 0.775 on paper and 0.77499999999999991 in doubles, so every runtime returns 0.77; the tomato late season at d = 0 is 1.135 on paper and exactly 113.5 after the multiplication, so every runtime returns 1.14. FAO-56 Example 28 (Kc ini 0.15, Kc mid 1.19, Kc end 0.35, climate-adjusted values no catalogue crop has) reproduces through `kcRamp(prev, next, d, L)`: day 40 of the season is 0.77 and day 95 is 0.56.

The stage never advances by itself. A zone left in a stage past its length keeps the value the stage ends on, and `stage_overrun` flags the day so the user can choose the next stage. Without a start date, or for a stage whose length is null, the stage keeps its table value: `kc_mid` for development and `kc_end` for the late season, as before version 2.

A row of `zone_daily_agronomy` keeps the crop, stage, start date and Kc current when it was first computed with a value, backfilled days included. A change to the crop, the stage or the start date applies to days computed after it; there is no stage history.

""")

swap("""## Variant defaults
""", """## Stage lengths (Table 11)

Every crop carries `stage_lengths_days`, the default Table 11 row the code uses, and `stage_length_alternatives`, every other Table 11 row for the crop, kept for review and for a later length picker; no code reads the alternatives. Both hold objects of one shape:

| Field | Content |
|---|---|
| `initial`, `development`, `mid_season`, `late_season` | Days, a positive integer or null. A null length switches the curve off for that stage only. An alternative may carry Table 11's printed 0 (Faba bean, broad bean, green: late season). |
| `table11_row`, `plant_date`, `region` | The Table 11 cells as the FAO page prints them, footnote markers removed; empty where the row has none |
| `selection_rule` | Why the row was chosen, in the words of the reference, or `group default (<group id>): no Table 11 row for this crop`, `reference proposal (UNVERIFIED): <basis>`, `agronomy review 2026-09-27: <reason>` |
| `verified` | true when the numbers are the crop's own Table 11 row, or the class row the reference assigns it; false for a row borrowed from another crop |

The default row follows one policy: the first European row (Europe, Italy, Spain), else the first Mediterranean spring row (March to June), else the first temperate row (Continental, High or Mid Latitudes, 35-45 °L, Central USA, Idaho, Utah), else the first row. A catalogue variant takes the row whose label names it (winter wheat on frozen soils: the Idaho dormancy row; faba bean, dry: the "- dry" row; grapevine: the "(wine)" row). The class rows Crucifers and Deciduous Orchard apply where a crop has no own row, or no European, Mediterranean or temperate one (broccoli, cabbage, cauliflower; apple, pear, cherry and the stone fruits).

Counts over the 136 crops: 95 have an own Table 11 row with four numbers (94 use it; `cantaloupe` uses the Sweet melons row), 4 have an own row that prints no mid-season or late-season length, and 37 have no Table 11 row.

The agronomy review of 2026-09-27 changed three defaults. They are marked for a signing agronomist:

| Crop | Policy pick | Default now | Lengths | `verified` |
|---|---|---|---|---|
| `cantaloupe` | Cantaloupe, Calif., USA, January (a desert winter planting) | Sweet melons, Mediterranean, May | 25/35/40/20 | false (another crop's row) |
| `sugar_beet` | Sugarbeet, Mediterranean, May | Sugarbeet, Idaho, USA, April (closer to Swiss sowing and lifting) | 50/40/50/40 | true |
| `almond` | Deciduous Orchard, High Latitudes, March | Deciduous Orchard, Calif., USA, March (where almonds grow) | 30/50/130/30 | true |

**Rows without numbers.** `alfalfa_averaged` (Alfalfa, total season: 10, 30, "var.", "var.") and `grass`, `pasture_extensive`, `pasture_rotated` (Grass Pasture: 10, 20, "--", "--") keep the two printed lengths, with mid-season and late season null. The development ramp follows the curve; the late season keeps `kc_end`, which for these four is within 0.05 of `kc_mid`.

**Crops without a Table 11 row.** Where the reference proposes a closer row, that row is the default with `verified: false`, and the group default moves to the alternatives. Every number below is a verbatim Table 11 value; applying it to the crop is judgement, not FAO text, and the list waits for a signing agronomist. Lengths read initial/development/mid-season/late season; a dash is null.

| Crop | Group | Default used | Lengths | Basis |
|---|---|---|---|---|
| `garlic` | small_vegetables | Onion (dry), Mediterranean, April | 15/25/70/40 | bulb allium, 150-day season |
| `parsnip` | roots_tubers | Carrots, Mediterranean, Feb/Mar | 30/40/60/20 | Apiaceae taproot like carrot |
| `turnip` | roots_tubers | Beets, table, Mediterranean, Apr/May | 15/25/20/10 | fresh root of 60-80 days |
| `chickpea`, `garbanzo` | legumes | Lentil, Europe, April | 20/30/60/40 | cool-season grain legume harvested dry; the same species |
| `sisal` | fibre | none: year-round crop | –/–/–/– | perennial agave without seasonal stages |
| `rapeseed` | oil_crops | Safflower, High Latitudes, March | 25/35/55/30 | spring-sown oil crop of the same group |
| `alfalfa_seed`, `clover_hay` | forages | Alfalfa, total season (frost window) | 10/30/–/– | same species; multi-cut legume hay with averaged cuttings |
| `clover_hay_cutting` | forages | Alfalfa, 1st cutting cycle, Idaho, April | 10/30/25/10 | consistent with the `alfalfa` default |
| `sudan_grass` | forages | Sudan, 1st cutting cycle, Calif. Desert, April, first two lengths | 25/25/–/– | averaged cuttings, as `alfalfa_averaged` |
| `berries`, `blueberry`, `raspberry` | grapes_berries | Deciduous Orchard, High Latitudes, March | 20/70/90/30 | deciduous shrubs leafing out in March-April |
| `avocado` | fruit_trees | Citrus, Mediterranean, January | 60/90/120/95 | evergreen subtropical tree, no concerted leaf drop |
| `conifer` | fruit_trees | none: year-round crop | –/–/–/– | evergreen with Kc 1.00 in every stage |
| `mint`, `strawberry` | perennial_vegetables | Grass Pasture (frost window) | 10/20/–/– | group default |
| `ryegrass_hay`, `turf_cool`, `turf_warm` | forages | Grass Pasture (frost window) | 10/20/–/– | group default |
| `cocoa`, `coffee`, `coffee_with_weeds`, `date_palm`, `mango`, `palm`, `papaya`, `rubber`, `tea`, `tea_shaded` | tropical_fruits | none: year-round crop | –/–/–/– | group default |
| `fig`, `hazelnut`, `kiwi`, `pomegranate` | fruit_trees | Deciduous Orchard, High Latitudes, March | 20/70/90/30 | group default |
| `reed_swamp_moist_soil`, `reed_swamp_standing_water` | wetlands | Wetlands (Cattails, Bulrush), Utah, killing frost, May | 10/30/80/20 | group default |

"Frost window" is the season of the Grass Pasture and Alfalfa rows: Table 11 footnote 4 runs it from the last −4 °C in spring to the first −4 °C in fall (for grass, 7 days before and after). The reference gives the perennial-vegetable and forage group defaults no numbers of their own, so they take the two lengths the Grass Pasture row prints. The tropical group has no default row: FAO-56 describes these evergreens as growing year round with near-equal Kc values, so their curve never applies.

**Regional defaults.** The default rows are European and Mediterranean. Table 11 prints low-latitude or tropical rows for maize, sweet maize, barley, oats, wheat, sweet potato, soybean, groundnut, castor bean, grapes and the deciduous-orchard class; a low-latitude default for Uganda is a follow-up. At development day 21 Ugandan maize reads 0.77 on the Spanish row, where the Nigeria row would give 0.84 and the East Africa row 0.68. On frost-free sites `turf_warm` grows year round, and reed swamp fits the Florida row (180/60/90/35).

**Caveats from the agronomy review.** Winter rapeseed overwinters: set Initial at the spring regrowth. Forages restart Initial after each cut. An orchard with grassed alleys has a Kc of 0.50-0.80 after leaf fall (FAO-56 Table 12, footnote 18), where Dormancy's 0.25 assumes bare soil.

## Variant defaults
""")

swap("""## Regeneration
""", """### Hourly ET0 (contract version 2)

`fao56HourlyTerms`, `fao56Et0Hourly` and `fao56Et0HourlyDay` in `osi-agronomy-daily/et0.js` compute FAO-56 equation 53 for one hour and sum a local day of hours. The cloud's `WeatherMath` carries ports of the same three functions with the same vectors. The chain per hour: wind at 2 m (equation 47), pressure (7) and γ (8) from the elevation (null counts as 0 m), e°(T) and Δ (11, 13) at the hour's mean temperature, `ea = e°(T) × RH / 100` (54), the sun's position at mid-hour from UTC and the longitude in degrees east (equations 31 to 33 with Lz = 0, which equals the FAO form for every site), Ra for the hour (28 to 30), `Rso = max(1e-4, (0.75 + 2e-5 z) Ra)` (37), `Rns = 0.77 Rs` (38), the hourly net longwave radiation with σ written as `4.903e-9 / 24` (39), `Rn = Rns − Rnl` (40), `G = 0.1 Rn` while the sun is up at mid-hour and `0.5 Rn` otherwise (45, 46). The hour's ET0 is signed and not rounded: FAO-56 chapter 11 reads a negative value as possible net condensation.

A day hour uses its measured `Rs/Rso`, clamped to [0.3, 1.0] as the daily path clamps it. A night hour uses the carried ratio (FAO-56 chapter 4): the clamped ratio of the day's last hour whose ω lies in `[ωs − 0.79, ωs − 0.52]`, 2 to 3 hours before sunset; before such an hour, the ratio the caller passes as `priorRsRso` (the previous evening's), else 0.5, the middle of FAO's 0.4-0.6 range for humid and subhumid climates. The day sums its signed hours and clamps the day, not the hour, at 0, then rounds to 2 decimals. A per-hour clamp would add 0.1 to 0.18 mm (2 to 4 %) on a clear, humid summer night.

Three notes:

- Clipping the hour's end angles ω1 and ω2 to [−ωs, ωs] for the hours that contain sunrise or sunset is ASCE-EWRI 2005 practice, not FAO-56 text. On the synthetic Payerne day it moves the sum by 1.2·10⁻⁴ mm. An hour that straddles sunset keeps its clipped Ra above 0 while its midpoint is below the horizon, so it takes the night ratio and G = 0.5 Rn; the vectors pin such an hour.
- The first and last daylight hours use a measured Rs/Rso that low sun angles make unreliable; the [0.3, 1.0] clamp bounds it.
- The night default 0.5 fits Switzerland and most of Uganda. Semi-arid north-eastern Uganda (Karamoja) sits in FAO's 0.7-0.8 class.

On the synthetic clear summer day of the vectors the hourly sum is 4.85 mm, the daily equation with the mean relative humidity, as the edge computes it, gives 4.73 mm, and the daily equation with RHmax and RHmin (equation 17) gives 4.98 mm. The gap comes mostly from the vapour-pressure method, not from the hourly step; FAO-56 calls the forms generally equivalent.

FAO-56 Example 19 (N'Diaye, Senegal, 1 October) is the golden vector: the contract reproduces the published 0.63 mm for 14:00-15:00 and 0.00 mm for 02:00-03:00 (with the example's night ratio of 0.8) within 0.005 mm, and every published intermediate within 0.001, except the two night terms of equation 53, which the book prints truncated (0.01).

## Regeneration
""")

swap("""`node scripts/build-kc-vectors.js` rewrites `kc-vectors.json` from `crop-kc.json` and the Kc rules above: 9 stage inputs for each of the 136 crops plus 7 for each of 4 non-catalogue crop values, 1,252 vectors. Run it after any change to `crop-kc.json` and commit both files together.
""", """`python3 docs/contracts/agronomy/sources/build_table11.py` rewrites `crop-kc.json` (the version-2 fields; the Table 12 fields are read back unchanged) and `sources/table11-stage-lengths.json` from `sources/table11_rows.json`, applying the selection policy, the proposals for crops without a row and the three review changes above. `crop-kc.json` is the authority: where the two files differ (44 crops: the three review swaps, and the 41 crops the transcription gives no default, the 37 without a Table 11 row and the 4 rows without numbers), `crop-kc.json` wins. `sources/table11-stage-lengths.json` is the transcription with the reference's policy picks, kept to show where each default came from. `sources/parse_table11.py` wrote `table11_rows.json` from a text rendering of the fetched page, which is not committed; it takes that file's path as its argument.

`node scripts/build-kc-vectors.js` rewrites `kc-vectors.json` from `crop-kc.json` with its own copy of the Kc rules above: 9 stage inputs for each of the 136 crops plus 7 for each of 4 non-catalogue crop values (1,252 undated vectors, whose values version 2 did not change), then 83 dated vectors (five crops, both ramp stages, seven cases each, and 13 cases on the edges of the rule), 1,335 in all. Run it after any change to `crop-kc.json` and commit both files together.

`python3 docs/contracts/agronomy/sources/hourly_et0.py` rewrites the `fao56Hourly` and `fao56HourlyDays` groups of `et0-vectors.json` with an independent Python implementation of the chain above, and names itself in the `provenance` field; `--reference` prints the Example 19 comparison of the FAO-form script. The Example 19 entries carry the values FAO-56 prints; the computed entries carry five decimals and a tolerance of 1e-4 mm.
""")

swap("""`et0-vectors.json` is not generated by a repo script. Its `provenance` field records the source:""",
     """The daily groups of `et0-vectors.json` are not generated by a repo script. The `provenance` field records their source:""")

p.write_text(s, encoding="utf-8")
print("README: contract v2")
````
```bash
python3 "$SCRATCH/readme-v2.py"
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/agronomy/README.md
```
Expected: `README: contract v2`; `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 5: Run the gates**

```bash
node scripts/verify-agronomy-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js
node scripts/capture-zone-env-vectors.js --verify
node scripts/verify-profile-parity.js && node scripts/verify-helper-registration.js
(cd web/react-gui && npm run typecheck && npm run test:unit)
git -C <osi-server>/.worktrees/daily-agronomy-cloud log -1 --format=%h feat/daily-agronomy-parity -- backend/src/main/resources/agronomy/crop-kc.json
```
Expected: the verifier's two lines ending `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5 hourly and 1 daily hourly-sum vectors, copies byte-identical)`; every suite `# fail 0`; six zone-env vectors verified; parity and helper registration pass; GUI green. The last command prints nothing until plan CA has copied the files; once it prints a hash, also run `node scripts/verify-agronomy-contract.js <osi-server>/.worktrees/daily-agronomy-cloud` and expect `cloud copies byte-identical in <osi-server>/.worktrees/daily-agronomy-cloud`.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-agronomy-contract.js .github/workflows/migrations.yml docs/contracts/agronomy/README.md
git -c user.name=Project-OSI commit -m "feat(agronomy): verify the cloud's contract copies; README for contract v2"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| A1 v2 shape, selection policy, counts, three swaps, `sources/` | 2 |
| A2 README (v2 fields, policy, curve rule and `kc_stage_day` sentence, hourly chain, night rule, three notes, comparison, regional note, A3/A4 tables, caveats, cloud copies) | 5 (the station-tier statement belongs to E3) |
| A3 16 promotions, `sudan_grass` two lengths, `conifer`/`sisal` null, 21 group defaults | 2 |
| A4 rows without numbers | 2 |
| A5 rule, `kcRamp`, Example 28 | 3 |
| A6 1,335 vectors, both half cases | 3 |
| A7 three hourly functions, null rules, night rule, day clamp | 4 |
| A8 Example 19 within the stated tolerances | 4 |
| A9 computed vectors, synthetic day | 4 |
| B1 `osi-crop-kc`, `cropKc.ts`, `build-kc-vectors.js`, `verify-agronomy-contract.js` with the osi-server argument, CI line | 2-5 |
| E row E1: no zone has a start date, the station tier untouched | 3, 4 (writer suites pass unchanged) |

## Follow-ups (recorded, not fixed here)

- GUI bundle weight (plan review E1-E3 minor 8, controller ruling): the GUI imports the whole v2 `crop-kc.json`, 151 KB pretty and 101 KB minified against 35 KB and 24 KB for v1 (about 8 KB more after gzip). About 39 KB of the minified file is `stage_length_alternatives`, which no GUI code reads. The follow-up is to lazy-load the catalogue (a dynamic import in the zone settings modal and the environment tabs); the byte-copy rule keeps the file whole until then. The execution report lists it (plan E2a Task 6 starts the report).
- The cloud's CA plan ports `resolveKc` and the hourly chain: its Java date parsing must refuse the years 0-99 and a time string without a zone, and its `nightRsRso` / `priorRsRso` must give null outside [0.3, 1.0] (spec A5, A7). No vector covers these inputs, so the cross-repo verifiers cannot catch a difference.

## Self-review notes

- Names used across tasks: `resolveKc`, `stageLengths`, `kcRamp`, `fao56HourlyTerms`, `fao56Et0Hourly`, `fao56Et0HourlyDay`, the term names and `rsRsoSource` values match the cloud's CA plan (`WeatherMath.HourlyTerms`, `"prior"` for a standalone night ratio, `"default"`, `"carried"`, `"measured"`), which reads the same vector files.
- The verifier changes in Tasks 2 to 5 are whole-file replacements; each state is green on its own commit.
