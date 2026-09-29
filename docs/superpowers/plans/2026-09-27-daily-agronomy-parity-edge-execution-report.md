# Daily agronomy parity — edge execution report (sub-project 4)

> **Migration numbers after landing.** origin/main took 0060
> (`add_rak10701_field_tester_type`) and 0061 (`watermark_lsn50`) while this
> stack was open, so the stack's six migrations were renumbered on the merge
> with main, content unchanged apart from the header comment:
> `0060__weather_provider_store` -> `0062`, `0061__daily_agronomy` -> `0063`,
> `0062__fao56_stage_keys` -> `0064`, `0063__zone_weather_source_sync` ->
> `0065`, `0064__stage_started_on` -> `0066`, `0065__zone_daily_agronomy_sync`
> -> `0067`. The numbers below are the ones in use when this report was
> written.

Branch `feat/daily-agronomy-parity`. Spec:
`docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md`. Fixed
stack base: `c5bc18314` (`feat(gui): VIA water-status colours for current SWT
readings (#352)`), the commit the stack (`feat/weather-provider-store` ->
`feat/daily-agronomy` -> `feat/daily-agronomy-parity`) was cut from. Every
size/DDL/migration/identity gate below ran with `OSI_FLOWS_SIZE_BASE_REF`,
`OSI_DDL_BASE_REF`, `OSI_MIGRATIONS_BASE_REF` and `OSI_IDENTITY_BASE_REF` all
set to this fixed base (AGENTS.md, "Base ref for a stacked branch"), not the
moving `origin/main`, because this stack sat unmerged through two unrelated
merges while it was being built. E2b, E3 and E4 append their own sections
below as they land.

## E1 (contract v2)

Five tasks put the FAO-56 crop catalogue, Table 11 stage lengths, the Kc
curve (eq. 66) and an hourly FAO-56 Penman-Monteith ET0 (eq. 53) into a
version-2 contract shared with the cloud.

| Task | What it built | Commit |
|---|---|---|
| 1 | Copied the design spec into the edge repository as a byte-identical copy of the cloud's blob | `b8336c5ed` |
| 2 | `crop-kc.json` version 2: FAO-56 Table 11 stage lengths and their sources, parsed and built from the reference text, copied to both `osi-crop-kc` profiles and the GUI | `61d3006b5` |
| 3 | The Kc curve (eq. 66) in the edge helper and the GUI resolver, from a stage start date; 1,335 contract vectors | `02446de60` |
| 4 | Hourly FAO-56 Penman-Monteith ET0 (eq. 53), Example 19 reproduced, computed vectors | `43381f0fd` |
| 5 | The cloud-copies check (an osi-server checkout argument to the verifier), CI wiring, the contract v2 README section | `2c2c8499f` |

Contract file hashes (`sha256sum`, confirmed unchanged at this report's HEAD):

| File | sha256 |
|---|---|
| `docs/contracts/agronomy/crop-kc.json` | `9b58c9275b57c72b0e52d2783fe8fd57faf9fda9ee98611c6a8f59451292e27c` |
| `docs/contracts/agronomy/kc-vectors.json` | `dd3fd36c9ab1d3849adfe269871ff82e9821006b81075ea2224b1a9a28c0e92b` |
| `docs/contracts/agronomy/et0-vectors.json` | `4835134027785c7ef50634531f49202927004cb4fb65dfac4c4b9abcedb256a7` |

Verifier's final OK line at E1's head:
`verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5
hourly and 1 daily hourly-sum vectors, copies byte-identical)`.

### Deviations from the plan

- Task 2's dispatch prompt named "the contract README" under its own file
  list, but the brief and the plan put the version-2 README in Task 5. Task 2
  left the README untouched; Task 5 wrote it. Not a defect — the two
  documents disagreed and Task 2 followed the more specific one (the brief).
- Tasks 3 and 5 both flagged that `scripts/capture-zone-env-vectors.js` had
  five cases when a brief's narration said "six." This was accurate at the
  time: the sixth case (`crop-curve-kc`) did not exist until E2a Task 5 added
  it. The gates that matter (vector verification) passed at five in both E1
  tasks and pass at six now.

### Follow-ups E1 records

- **GUI bundle weight** (plan review E1-E3 minor 8, controller ruling): the
  GUI imports the whole version-2 `crop-kc.json` — 151 KB pretty, 101 KB
  minified, against 35 KB and 24 KB for version 1 (about 8 KB more after
  gzip). Roughly 39 KB of the minified file is `stage_length_alternatives`,
  which no GUI code reads. The follow-up is to lazy-load the catalogue (a
  dynamic import in the zone settings modal and the environment tabs); the
  byte-copy rule keeps the file whole until then.
- **The cloud's Java input rules**: its date parsing must refuse the years
  0-99 (`Date.UTC` in the edge's own JavaScript maps them to 1900-1999, so
  every edge runtime already refuses them; the cloud needs the same refusal)
  and a time string with no zone offset, and its `nightRsRso`/`priorRsRso`
  must return null outside [0.3, 1.0] (spec A5, A7). No contract vector
  covers these inputs, so the cross-repo verifiers cannot catch a divergence
  here — this is a manual porting obligation on whoever writes the cloud's
  CA plan.

## E2a (stage start date, core)

Five tasks give a zone a stage start date: migration 0064 and the canonical
zone trigger; the write route, zone list, both snapshots and a capability;
both cloud command paths and the contract; the daily writer freezing the
curve fields; and `osi-zone-env` resolving today's and the forecast days' Kc
through the curve, with the shared-mode merge rule. Task 6 (this report) is
the whole-plan gate run.

| Task | What it built | Commit | Status |
|---|---|---|---|
| 1 | Migration 0064 (four additive columns), the canonical zone trigger via `scripts/sync-trigger-source.json`, seed parity, seven bundled DB images, the migration-corpus pins, the Terra fixture | `60c1b549a` | DONE_WITH_CONCERNS |
| — | Repin: size/DDL/migration/identity verifiers re-pinned against the fixed stack base `c5bc18314` (see below); `OSI_IDENTITY_BASE_REF` added; AGENTS.md gained "Base ref for a stacked branch" | `10e21d768` | DONE |
| 2 | `zone-config-fn`, `get-zones-query`/`get-zones-response`, both snapshots, the `zone_config_stage_started_on_v1` capability (both names, three builders) | `b197bce2c` | DONE_WITH_CONCERNS |
| 3 | The legacy "Build UPDATE SQL" node, the protected `UPSERT_ZONE` and the Terra path in `osi-zone-commands`, the `Zone.stage_started_on` contract field and its README section | `ff74bfaac` | DONE |
| 4 | `osi-agronomy-daily` freezes the stage start date, the FAO-56 stage day and the overrun flag with the Kc snapshot | `d1f159ff0` | DONE |
| 5 | `osi-zone-env.buildWaterDaily` resolves Kc on the curve per date; `stageOverrun`/`demandComputedBy` per day; shared mode keeps the cloud's non-null days | `26f40142b` | DONE |

### Ratchet numbers

Everything below is measured against the fixed base `c5bc18314`, never the
moving `origin/main`. `origin/main` absorbed two unrelated merges while this
stack was in flight (a coverage-test field type addition, then a second
LoRaWAN sensor type), which moved its own `flows.json` total from 1,580,418
chars (both profiles, `= c5bc18314`) to 1,587,149 (during Task 1) to
1,598,196 (from Task 2 onward) — none of it caused by this stack. Pinning
node-level and total deltas against `origin/main` while it moves produces a
false reading (Task 1's `sync-init-fn` delta briefly read 1,578 instead of
its real 1,626; Task 2's `total_allowance.delta` briefly read a nonsensical
-5,465). The repin commit (`10e21d768`, run between Tasks 2 and 3) fixed
this by re-measuring every pin against `c5bc18314` directly and adding
`OSI_IDENTITY_BASE_REF` so `verify-live-gateway-identity.js` names the same
base in its own messages.

Per-node deltas (`c5bc18314` -> HEAD), each confirmed unaffected by the
`origin/main` drift because the two unrelated merges never touched these
node ids:

| Node | Task | Delta (chars) |
|---|---|---:|
| `sync-init-fn` | 1 | +1,626 |
| `zone-config-fn` | 2 | +4,065 |
| `get-zones-query` | 2 | +40 |
| `get-zones-response` | 2 | +385 |
| `sync-bootstrap-build` | 2 | +252 |
| `sync-force-build` | 2 | +252 |
| `al-link-build-req` | 2 | +68 |
| `4f4a765f36cee6f3` (legacy Build UPDATE SQL) | 3 | +5,890 |
| `zone-env-fn` | 5 | -296 (a shrink; no `node_allowances` entry needed) |

Cumulative `total_allowance.delta` (both profiles, per-profile total in
parentheses), in the order the tasks landed:

| After | Delta vs `c5bc18314` | Per-profile total |
|---|---:|---:|
| Task 1 (as first pinned, wrongly, against the then-current `origin/main`) | +1,946 | 1,589,095 |
| Repin, controller re-measurement against `c5bc18314` | **+12,313** (corrects the +1,946 and the intervening -5,465 reading) | 1,592,731 |
| Task 3 | +16,716 | 1,597,134 |
| Task 5 (final, confirmed by this task's own fresh gate run: `OK size total allowance: exact cumulative delta 16789`) | **+16,789** | 1,597,207 |

The controller's re-measurement (repin commit) confirmed every node-level
`c5bc18314`-relative delta the tasks had already computed except one:
`sync-init-fn` had been pinned at 1,578 (measured against a since-moved
`origin/main` reading of 81,784) where the true `c5bc18314`-relative growth
is 1,626 (81,736 -> 83,362). That one pin was corrected; nothing else moved.

### Test counts the runner printed (this task's fresh run, HEAD `26f40142b`)

| Command | Result |
|---|---|
| `test-stage-started-on-migration.js` + 6 other zone/Terra suites | `# tests 116` / `# pass 116` / `# fail 0` |
| `osi-agronomy-daily/*.test.js` + `osi-zone-env/index.test.js` + `osi-crop-kc/index.test.js` | `# tests 73` / `# pass 73` / `# fail 0` |
| `osi-agronomy-daily/index.test.js` alone | `# tests 30` / `# pass 30` / `# fail 0` |
| `test-sync-trigger-source.js` | `# tests 3` / `# pass 3` / `# fail 0` |
| `lib/osi-migrate/__tests__/*.test.js` (25 files, run once, ~12 minutes) | `# tests 123` / `# pass 123` / `# fail 0` |
| `capture-zone-env-vectors.js --verify` | 6 vectors verified, 0 failures |

This settles the open point the plan's ledger carried into this task: Task
4's own report described the daily-writer suite's growth as "27 -> 42,"
which was the combined count of three files
(`index.test.js` + `facade-contract.test.js` + `et0.test.js`: 30 + 1 + 11),
not `index.test.js`'s own count. `index.test.js` alone is 30 tests, both
before and after Task 4 (27 pre-existing plus the 3 the task added), matching
the independent reviewer's count, not the implementer's combined figure.

### Op-parity (Step 1) and the vendor check (Step 2)

`node scripts/verify-sync-op-parity.js`, run against the paired cloud
worktree's `EdgeSyncService.java`, prints exactly one difference and exits
non-zero:

```
server extra vs union: ZONE_AGRONOMY_UPSERTED
verify-sync-op-parity: FAIL
```

This is the second of the plan's two documented forms: the paired cloud
branch already carries plan CC1 (confirmed true since the 2026-09-28
re-anchoring), so the cloud's applier already understands an op
(`ZONE_AGRONOMY_UPSERTED`) that no edge task in E1-E2a emits yet — that
emitter is plan E4 Task 1's job. Every earlier E2a task recorded the same
single line; nothing in E2a changed this.

The cross-repo vendor check
(`EDGE_CONTRACT_ROOT=<this worktree> sh scripts/verify-edge-sync-contract-vendor.sh`,
run from the cloud checkout) prints:

```
vendored contract differs: resources.schema.json
```

and exits non-zero. This is the plan's documented expected red: the cloud's
own vendored copy of `resources.schema.json` predates E2a's addition of
`stage_started_on`. The controller's re-vendor step has not run yet.

### Deviations from the plan and why

- **Task 1**: `verify-sync-op-parity.js` failed on `ZONE_AGRONOMY_UPSERTED`
  from the start, on an axis Task 1 never touches (an op-name-set membership
  gap, not the `stage_started_on` payload). Recorded rather than routed
  around, because closing it means adding a real, audited edge emitter for
  that op — plan E4's job, not Task 1's.
- **Task 1 and Task 2**: `origin/main` moved under the stack twice while it
  was being built (see "Ratchet numbers" above), which produced two wrong
  ratchet/identity pins in sequence. Neither was a behavior defect; both were
  measurement errors from pinning against a moving base. Fixed by the repin
  commit, not by changing any flow or trigger code.
- **Task 2**: with the (transiently wrong) negative `total_allowance.delta`
  in place, `verify-flows-size-ratchet.js`'s doc-baseline sub-check could not
  pass by construction (`--write-baseline` always sets the baseline to
  HEAD's own total, so `HEAD > HEAD + negative` is always true). This is a
  latent gap in that script for the case "this branch grew less than
  `origin/main` did," never previously exercised in this repository's
  history. Left unpatched (out of Task 2's scope) and resolved procedurally
  by the repin against the fixed base, where the delta is positive again.
- **Task 3**: the brief's own scratch ratchet script hardcoded a `git show
  origin/main:...` lookup instead of reading `OSI_FLOWS_SIZE_BASE_REF`. Its
  one node-level number (`4f4a765f36cee6f3`, +5,890) was unaffected and
  matched regardless of which base the script used, but its total-delta
  arithmetic used the drifted `origin/main` figure and printed a nonsensical
  negative number. Corrected by hand to the `c5bc18314`-relative figure
  (+16,716), with the prior (wrong) computation kept in the allowances file's
  own reason text as a labeled historical note, following the pattern the
  repin commit had already established.
- **Task 5**: found a pre-existing, content-free JSON round-trip defect in
  `scripts/verify-flows-size-ratchet-allowances.json`, introduced by Task 3's
  commit: one unrelated reason string (about the outbox flush lease, dated
  2026-09-17) held a literal six-character `…` escape sequence where
  every other entry in the file stores the raw `…` character. Node's
  `JSON.stringify` never escapes non-ASCII, so no script in this stack could
  round-trip the file with that line present. Normalized in Task 5's own
  commit as a one-line, semantically null fix (same text, same bytes once
  rendered, no other content changed).
- **Task 6 (this task)**: no defect found that needed a fix. Every gate the
  spec lists for E2a's surface is green under the fixed base; the two red
  items (op-parity, the vendor check) are the plan's own documented expected
  reds, both confirmed to still be in their predicted state.

Migration number 0064 is provisional: the reconciliation owner assigns the
final migration numbers once the merge order across the in-flight branch
families is settled (see `AGENTS.md`, "Base ref for a stacked branch," for
the general mechanism; the private SDD ledger names the instances and the
order). This branch is not pushed.

## E2b (stage start date, GUI and gates)

Three tasks put the stage start date into the zone settings GUI, extended
the Water tab to name the FAO-56 curve, flag a stage overrun and mark a
cloud-computed day, and ran the plan's gates for this surface. Task 3 (this
section) is the gate run.

| Task | What it built | Commit |
|---|---|---|
| 1 | Stage start date field in the zone settings modal (pre-filled on a stage change, `HelpTip`, payload sent only when the date changed), `normaliseZone`/`IrrigationZone` typing, 11 shared locale keys across seven bundles, the cross-repo shared-text check (`scripts/test-shared-agronomy-locales.js`), CI wiring | `fc2161e44` |
| 2 | Water tab names the FAO-56 curve, flags a stage overrun with its typical stage length, marks a cloud-computed day (`stageOverrun`/`demandComputedBy` typed on `WaterDay`, the Open-Meteo credit line and cloud attribution/model-accuracy tooltip lines) | `cff2857c3` |

### Test counts the runner printed (this task's fresh run, HEAD `cff2857c3`)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run test:unit`, tsx runner | `# tests 184` / `# pass 183` / `# fail 0` / `# skipped 1` |
| `npm run test:unit`, vitest | `Test Files 203 passed (203)` / `Tests 2176 passed (2176)` |
| `node --test scripts/test-shared-agronomy-locales.js` (no `OSI_SERVER_ROOT`) | `# skipped 1` |
| same, with `OSI_SERVER_ROOT` set to the paired cloud worktree | `# compared 77 shared texts` / `# pass 1`, run against osi-server commit `27cb5c6d` |
| `node scripts/verify-agronomy-contract.js` | `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5 hourly and 1 daily hourly-sum vectors, copies byte-identical)` |
| `node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md` | `slop-check: PASS (no tier-1 findings)` |
| `node scripts/verify-sync-flow.js` | exit 0, `All parity checks passed.` |

The last row is not one of the brief's named commands: grepping `scripts/`
and `.github/` for path-pinned verifiers naming the two files this plan
touched (`ZoneConfigModal`, `WaterTab`) found one, `verify-sync-flow.js`,
which pins two legacy mixed-irrigation-fallback exclusion checks to
`WaterTab.tsx` by name. The brief's own example command
(`verify-command-safety.js`) does not name either file and was not run for
that reason. `verify-sync-flow.js` passed.

E2b touches no flow, schema or sync contract, so plan E2a Task 6's
flows-size/DDL/migration/identity ratchet gates (pinned against the fixed
base `c5bc18314`) and its two documented expected reds
(`verify-sync-op-parity.js`'s `ZONE_AGRONOMY_UPSERTED` gap, the cloud's
un-vendored `resources.schema.json`) stand unchanged from E2a; this task did
not re-run them.

### Deviations from the plan and why

- None found. Every gate the brief names for E2b's surface passed on the
  first run, with the tsx and vitest counts matching the brief's pinned
  expectation (183 and 2176) exactly.
- The one addition beyond the brief's listed commands is the grep-and-run
  step described above (`verify-sync-flow.js`), which the brief's own
  instructions called for; it is not a deviation, and it found nothing red.
- No fix commit was needed anywhere in this task.

### Review fixes

Committee review (`review-tasks-1-2.md`) found three defects after the gate run above: F1 (Critical) re-stamped `stageStartedOn` to today when the user picked their way back to the zone's already-stored stage, because the select handler compared the pick against the live form stage rather than the stored one; F2 (Important) let the overrun line interpolate `{{days}}` as empty text for a crop with no catalogue length at its stage; F3 (Minor) left a stale date in the disabled input for a zone whose stage is unset. The fix compares every stage change against the zone's stored, normalised stage — select handler, save-diff baseline, initial state and the `[zone]` reset effect alike — and suppresses the overrun paragraph when no typical length is known, with no new text key and no locale file change. Edge test counts moved from tsx 183/vitest 2176 to tsx 183/vitest 2179 (3 new cases, one per finding); the cloud GUI carries the equivalent fix at commit `070b3f88`, this edge fix at `ced9af13b`.

## E3 (hourly station tier)

Two tasks change what the station tier means: contract version 2 already
computes an hourly FAO-56 Penman-Monteith ET0 (E1 Task 4); this plan makes
the daily writer's station tier sum that hourly value over a day instead of
running the daily FAO-56 equation once, when at least three uplinks fed each
counted hour. Task 2 (this section) is the README statement and the
whole-branch gate run.

| Task | What it built | Commit |
|---|---|---|
| 1 | `osi-agronomy-daily` sums `fao56Et0HourlyDay` over the assigned station's cached hours (`sample_count >= 3` per hour, radiation plausibility unchanged, longitude required or the day falls to the provider tier, `priorRsRso` from the previous 24 cached hours, the carried night ratio), `et0_tier = 'station_fao56'` with `et0_source = 'fao56_hourly'`; both profiles' `index.js`/`index.test.js` | `5db3a1ff3` |
| 2 | README paragraph stating the station-tier rule since contract v2; the plan's whole-branch gate run | `c0c6715f7` |

E3 touches no flow node, DDL, migration or gateway-identity surface, so the
size/DDL/migration/identity ratchet gates (pinned against the fixed base
`c5bc18314`, per AGENTS.md "Base ref for a stacked branch") are unchanged
from E2a/E2b: `verify-flows-size-ratchet.js` reports the same
`c5bc18314`-relative cumulative delta as E2a's final figure, `+16789`, at the
same per-profile total, `1597207` — this task's own fresh run confirms it,
not a carried-over number.

### Test counts the runner printed (this task's fresh run, HEAD `c0c6715f7`)

| Command | Result |
|---|---|
| `node scripts/verify-agronomy-contract.js` | `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5 hourly and 1 daily hourly-sum vectors, copies byte-identical)` — unchanged from E1/E2a/E2b: E3 changes no contract file |
| `node --test osi-agronomy-daily/*.test.js osi-station-hours/*.test.js osi-zone-env/index.test.js` | `# tests 80` / `# pass 80` / `# fail 0` (56 from the five files Task 1's own report counted fresh — `index.test.js` 34, `facade-contract.test.js` 1, `et0.test.js` 11, `osi-station-hours/index.test.js` 9, its `facade-contract.test.js` 1 — plus 24 from `osi-zone-env/index.test.js`, untouched by E3) |
| `verify-profile-parity.js` | `All parity checks passed.` |
| `verify-helper-registration.js` | all modules `OK`, both profiles |
| `verify-osi-lib-db-caller-binding.js` | `verify-osi-lib-db-caller-binding: OK` |
| `verify-flows-size-ratchet.js` | `OK (HEAD total 3194414 <= c5bc18314 total 3160836; committed baseline not exceeded)`, per-profile total `1597207` |
| `verify-live-gateway-identity.js` | `Live gateway identity verification passed.` |
| `verify-sync-flow.js` | `All parity checks passed.` |
| `node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/agronomy/README.md` | `slop-check: PASS (no tier-1 findings)` |

`lib/osi-migrate`'s suite (over ten minutes) was not re-run: E3 changes no
migration, and the suite ran green at `cf2ed67b3` (E1/E2a's gate commit). The
GUI checks (`npm run typecheck`, `npm run test:unit` in `web/react-gui`) were
left out of this task's run: E3 changes no GUI file, and another agent was
running the GUI suite on this workstation at the time. E2b's GUI run stands
(`# tests 184 # pass 183 # fail 0 # skipped 1` under the tsx runner; `Test
Files 203 passed (203)` / `Tests 2176 passed (2176)` under vitest).

### Op-parity, the vendor check and the cloud contract copies

`node scripts/verify-agronomy-contract.js`, given the paired cloud worktree
as its argument, reports the contract files byte-identical there too:

```
cloud copies byte-identical in <osi-server>/.worktrees/daily-agronomy-cloud
verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5
hourly and 1 daily hourly-sum vectors, copies byte-identical)
```

`node scripts/verify-sync-op-parity.js`, run with
`OSI_SERVER_EDGE_SYNC_SERVICE` pointed at the paired cloud worktree's
`EdgeSyncService.java`, prints the same single difference E2a and E2b
recorded and exits non-zero:

```
server extra vs union: ZONE_AGRONOMY_UPSERTED
verify-sync-op-parity: FAIL
```

The cross-repo vendor check
(`EDGE_CONTRACT_ROOT=<this worktree> sh scripts/verify-edge-sync-contract-vendor.sh`,
run read-only from the cloud checkout) prints the same expected red:

```
vendored contract differs: resources.schema.json
```

Neither is new: both are the plan's documented expected reds, carried
unchanged from E2a (`ZONE_AGRONOMY_UPSERTED` is plan E4 Task 1's emitter to
write; the vendor re-copy is the controller's job after E4). E3 neither adds
nor removes a sync op or a contract field, so re-running these two checks
here only confirms neither state moved under E3 — it did not. The cloud
worktree's tree was read, not written: another agent was committing a GUI
fix there at the same time, and `git status --short` in that worktree showed
nothing from this task's read-only commands.

### What a deploy does

The first run after the deploy recomputes the last seven station days: their
`et0_mm` moves to the hourly sum and `et0_source` to `fao56_hourly`; their Kc
snapshot stays frozen, so `etc_mm` follows the new ET0. Older station days
keep the daily equation's values and `station_fao56` as source. On a gateway
that also runs plan E4, each changed row emits one `ZONE_AGRONOMY_UPSERTED`.

Whether a given station keeps the hourly tier depends on how many uplinks
feed each of its hours (`sample_count >= 3`, ruling R8), and nothing in this
repository or its notes records any station's uplink interval (plan review
E1-E3 I2). This task had no gateway access authorized in this session, so
the read-only query the brief names
(`sqlite3 -readonly /data/db/farming.db "SELECT deveui, sample_count,
COUNT(*) AS hours FROM weather_station_hours WHERE hour_start >=
strftime('%Y-%m-%dT%H:00:00Z', 'now', '-7 days') GROUP BY deveui,
sample_count ORDER BY deveui, sample_count;"`) was not run, and this report
does not name a station's hourly distribution: it is unknown until that
query runs on a test gateway with Phil's go-ahead. Acceptance 4
(`et0_source = 'fao56_hourly'`) needs a station whose hours mostly carry
three or more uplinks; the query above is how a future task finds one.

Final review E-M7: `sample_count` (`osi-station-hours/index.js`, `rows.length`)
counts `device_data` rows in the hour, not rows that actually carry a
temperature value -- if a station spreads one report over several uplinks, an
hour can reach `sample_count >= 3` with fewer than three real temperature
readings. Whichever future task runs the query above on a test gateway should
also run its `device_data` counterpart, so a station whose uplinks split
fields across rows is visible before it is trusted:
`sqlite3 -readonly /data/db/farming.db "SELECT deveui,
strftime('%Y-%m-%dT%H:00:00Z', recorded_at) AS hour, COUNT(*) AS rows,
COUNT(ambient_temperature) AS temp_rows FROM device_data WHERE recorded_at >=
strftime('%Y-%m-%dT%H:00:00Z', 'now', '-7 days') GROUP BY deveui, hour ORDER
BY deveui, hour;"`. Ruling: the stored `sample_count` stays as it is (counting
rows, not temperature values) -- cost if wrong: an hour with fewer than three
temperature values counts as complete.

### Deviations from the plan and why

- None found. The README paragraph matched the brief's expected output line
  for line, and every gate in the brief's Step 2 passed on the first run,
  including the two cross-repo checks and the cloud contract comparison this
  task added under the session's binding corrections (not in the brief's own
  Step 2, but consistent with the whole-branch gate pattern E1 Task 5 and
  E2a Task 6 established).
- No fix commit was needed anywhere in this task.

## E4 (daily record sync)

Three tasks put `zone_daily_agronomy` on the wire — the table the station and
provider tiers already filled stayed edge-only until this plan — and Task 4
(this section) runs the whole-branch gate a last time and writes this report.

| Task | What it built | Commit |
|---|---|---|
| 1 | Migration `0065__zone_daily_agronomy_sync.sql`: a `sync_version` column and the migration-owned triggers `trg_dp_zone_agronomy_outbox_ai`/`_au`, gated on the same link/zone-UUID/not-deleted guard as the other zone outbox triggers, emitting `ZONE_AGRONOMY_UPSERTED` (23-key payload, composite `zone_uuid\|date` key, version-only semantic binding — no single payload field holds the key); seed and all 7 bundled DB images rebuilt; migration-owned trigger lists, the schema contract, the migration-corpus pins and CI wiring extended to match | `9ca4c9911` |
| 2 | The writer inserts at version 1 and adds 1 per change instead of always writing 0; an unchanged row stays silent (the `au` trigger fires only when `sync_version` changes); a day the clock wrote ahead of itself is retracted by an update (null values, `null_reason = 'retracted'`, next version) instead of a delete, since the schema carries no delete op for this table | `d8c75b597` |
| 3 | Text hygiene: a real gateway EUI written by Task 1 in the trigger test replaced with a placeholder | `276f1a924` |
| 3 | `sync-bootstrap-build` gains a `zoneAgronomy` query: every live zone's (UUID present, not deleted) rows from the last 30 days, `LIMIT 1000`, ordered `date DESC, zone_id ASC`; a gateway with no rows gets `zoneAgronomy: []`; a force sync is not extended (spec decision) | `207e8a67b` |
| 4 | This section (this task): the retention document, `AGENTS.md`'s provider weather paragraph and the sync-schema README describe the sync; the whole-branch gate run below | — |

### Ratchet numbers (Task 3's growth)

Measured against the fixed base `c5bc18314`, the same base every E1–E4 task
has used (AGENTS.md, "Base ref for a stacked branch"), because `origin/main`
has moved further since the stack was cut:

| Node | `c5bc18314` | HEAD | Delta |
|---|---:|---:|---:|
| `sync-bootstrap-build` | 44956 | 46212 | +1256 (E2a/E2b/E3 stood at +252; Task 3's own growth is +1004) |
| Total (both profiles, byte-identical) | 1580418 | 1598211 | **+17793** (E2a–E3 stood at +16789) |

Informational only, since `origin/main` has moved past the stack's cut point
and keeps moving: `origin/main` total 1598196 vs `HEAD` 1598211, a +15 delta
against that moving target; `origin/main`'s own `sync-bootstrap-build` figure
is 44956, identical to `c5bc18314` at the node level, so the two base refs
agree there. This task's own fresh run of `verify-flows-size-ratchet.js`
reproduces the pinned figures exactly: `OK (HEAD total 3196422 <= c5bc18314
total 3160836; committed baseline not exceeded)` (both-profile totals, i.e.
2 × 1598211 and 2 × 1580418) and `OK size total allowance: exact cumulative
delta 17793`.

### Gate run (this task's fresh run, HEAD `207e8a67b`, base ref `c5bc18314` for every `OSI_*_BASE_REF`)

Every command below is the spec's Testing section, run in the order the
brief's Step 2 and Step 3 give, one gate at a time. Lines are verbatim tails
or key lines of each command's own output.

| Command | Result |
|---|---|
| `verify-agronomy-contract.js` | `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5 hourly and 1 daily hourly-sum vectors, copies byte-identical)` |
| `verify-agronomy-contract.js <paired cloud worktree>` | `cloud copies byte-identical in <paired cloud worktree>` then the same `OK` line |
| `verify-sync-flow.js` | `All parity checks passed.` |
| `verify-sync-op-parity.js` (`OSI_SERVER_EDGE_SYNC_SERVICE` = the paired cloud worktree's `EdgeSyncService.java`) | `verify-sync-op-parity: OK` — the gap E2a/E2b/E3 recorded (`server extra vs union: ZONE_AGRONOMY_UPSERTED`) is closed: Task 1's emitter now exists |
| `verify-sync-contract.js && test-contract-schemas.js` | `verify-sync-contract: OK`; `PASS: contract schema checks pass` |
| `verify-runtime-schema-parity.js && verify-trigger-body-parity.js && generate-sync-trigger-source.js --check && test-sync-trigger-source.js` | `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)`; `verify-trigger-body-parity: OK`; `sync trigger source check passed (31 SQL definitions)`; `# tests 3` / `# pass 3` / `# fail 0` |
| `verify-migrations.js && verify-seed-replay.js && verify-db-schema-consistency.js && verify-no-stray-ddl.js && verify-profile-parity.js` | `verify-migrations: OK (65 migrations, checksum manifest OK, base immutability OK)`; `verify-seed-replay: OK`; all 7 bundled DB images `OK`, `DB schema consistency verification passed`; `verify-no-stray-ddl: OK (HEAD total 694 <= c5bc18314 total 694; committed baseline matches HEAD total 694)`; `All parity checks passed.` |
| `test-flows-wiring.js && verify-flows-size-ratchet.js && verify-live-gateway-identity.js` | `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`; `verify-flows-size-ratchet: OK (HEAD total 3196422 <= c5bc18314 total 3160836; committed baseline not exceeded)`, `OK size total allowance: exact cumulative delta 17793`; `Live gateway identity verification passed.` |
| `node --test lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` | `# tests 2` / `# pass 2` / `# fail 0` |
| `node --test` the 7 zone/Terra suites (`test-stage-started-on-migration.js` and 6 others) | `# tests 86` / `# pass 86` / `# fail 0` |
| `node --test` `osi-crop-kc`/`osi-agronomy-daily`/`osi-station-hours`/`osi-zone-env` | `# tests 89` / `# pass 89` / `# fail 0` |
| `capture-zone-env-vectors.js --verify` | 6 vectors verified, 0 failures |
| `(cd web/react-gui && npm run typecheck && npm run test:unit)` | `typecheck`: no diagnostics; tsx runner `# tests 184` / `# pass 183` / `# fail 0` / `# skipped 1`; vitest `Test Files 203 passed (203)` / `Tests 2179 passed (2179)` — both match the brief's pinned expectation (tsx 183, vitest 2179) exactly |
| `slop-check.js` on `docs/contracts/agronomy/README.md`, `docs/operations/edge-history-retention.md`, `docs/i18n/pending-luganda-translations.md`, `docs/contracts/sync-schema/README.md`, `AGENTS.md` | `slop-check: PASS (no tier-1 findings)` (one non-blocking tier-2 note: `AGENTS.md` em-dash density 8.2/1000 words against an 8/1000 budget — informational, not a failure, and not a new finding this task introduced: `AGENTS.md` was already near that density before this task's one added sentence) |
| `OSI_SERVER_ROOT=<paired cloud worktree> node --test test-shared-agronomy-locales.js` | `# compared 77 shared texts`; `# pass 1` |

Two suites the brief's own Step 2 list does not name, each over ten minutes,
were run once each per this task's binding memory correction, since Task 1
is this sub-project's own migration-adding task and both suites carry that
migration's fixtures at HEAD for the first time:

| Command | Result |
|---|---|
| `node --test lib/osi-migrate/__tests__/*.test.js` (25 files, foreground, ~742 s) | `# tests 123` / `# pass 123` / `# fail 0` |
| `node --test scripts/reconcile-ledger-numbering.test.js` (foreground, ~780 s; includes both real-fixture lineage proofs) | `# tests 34` / `# pass 34` / `# fail 0` |

Cross-repo checks (Step 3):

| Command | Result |
|---|---|
| `git show <cloud>:backend/src/test/resources/sync-contract/resources.schema.json \| cmp - docs/contracts/sync-schema/resources.schema.json` | **Expected red**, confirmed exactly: `differ: char 3717, line 80` — line 80 is the `stage_started_on` line; the cloud has not re-vendored this file since plan CC1 copied it (before E2a added `stage_started_on`). The controller's re-vendor is still pending; nothing in this task closes it |
| `verify-sync-op-parity.js \| tail -1` | `verify-sync-op-parity: OK` |
| `verify-agronomy-contract.js <cloud> \| tail -1` | `verify-agronomy-contract: OK (136 crops, contract v2, 1335 Kc vectors, 5 hourly and 1 daily hourly-sum vectors, copies byte-identical)` |

The channels.json byte-identity check (DD5) belongs to sub-project 3's own
plan and gate list, not this one; it was not run here, per the brief's own
note that it is "sub-project 3's."

### Deviations from the plan and why

- The brief's own Step 2 command list does not include the full
  `lib/osi-migrate` suite or `reconcile-ledger-numbering.test.js`; this
  task's binding memory correction called for running each once anyway,
  because Task 1 added migration 0065 and both suites replay migration
  lineage fixtures that now include it for the first time at HEAD. Both
  passed unchanged in test count from Task 1's own fresh run
  (123/123 and 34/34) — not a deviation in outcome, only in which commands
  this task ran beyond the brief's own list.
- No other deviation: every command in Step 2 and Step 3 matched its
  predicted output exactly, including the `differ: char 3717, line 80`
  position the brief predicted for the un-vendored `resources.schema.json`
  and the exact `+17793`/`17793` ratchet figures Task 3 had already pinned.
- No defect was found and no fix commit was needed anywhere in this task.

### What sub-project 4 left out

- Spec "Not in scope": history-batch replication of `zone_daily_agronomy`.
  The sync path this sub-project built is bootstrap-snapshot only — the last
  30 days of each zone, capped at 1,000 rows — with no separate history-batch
  endpoint for this table; a force sync does not carry `zoneAgronomy` either
  (the same spec decision). A gateway that misses more than 30 days of
  bootstraps before reconnecting does not recover the gap from this path; the
  scheduled bootstrap (8 s after a Node-RED start, then every 6 hours) is the
  only repair mechanism this plan built.
- E1's follow-ups (the GUI's whole-catalogue bundle weight; the cloud's Java
  date-parsing and `nightRsRso`/`priorRsRso` range-refusal rules) remain open
  and are recorded in the E1 section above; this task does not repeat or
  extend them, since neither touches the daily record sync.
- The cloud-side re-vendor of `resources.schema.json` and any further cloud
  work are the controller's and the cloud plan's job, not an edge task; this
  section only confirms the edge file this task did not change is still
  correct and still un-vendored on the cloud.

### Deploy constraints the handover must carry

In general terms only — osi-os is public, so this report names no customer
instance, customer branch or live deployment hash; the private SDD ledger
carries those:

- Cloud before edge: no linked gateway runs this branch before the paired
  cloud plan is deployed on its cloud, on main and on every customer
  instance; a customer cloud whose branch lacks the appliers gets them
  first — running the edge trigger against a cloud that does not yet accept
  `ZONE_AGRONOMY_UPSERTED` is the `unknown_op` hazard the spec's D section
  warns about.
- The first run after the deploy recomputes the last seven station days
  (`fao56_hourly`, from sub-project 4's earlier plan) and, with a linked
  cloud, emits one `ZONE_AGRONOMY_UPSERTED` per changed row; rows older than
  seven days keep their values and `station_fao56` source.
- Rows written before migration 0065 carry `sync_version = 0` until their
  first change; the next scheduled bootstrap (8 s after a Node-RED start,
  then every 6 hours) brings the last 30 days of each zone regardless, so a
  gateway that never changes an old row still converges within 6 hours of
  its next restart.
- A force sync posts no `zoneAgronomy` (spec decision, not an oversight);
  the scheduled bootstrap is the only repair path and closes the gap within
  6 hours.

Migration numbers `0063`–`0065` (this stack's own additions on top of the
base `c5bc18314`) are provisional: the reconciliation owner assigns the
final migration numbers and the rebase target once the merge order across
the in-flight branch families is settled (AGENTS.md, "Base ref for a stacked
branch," names the general mechanism; the private SDD ledger names the
instances and the order). This branch is not pushed.

## Final review fixes

Final whole-branch review (`final-review-fable-edge.md`, 2 new Important
findings, 9 Minor, plus the E1-contract-v2 fix queue) closed in ten commits
on top of `9beb7c372`, head `ee728f8b6`. `git status --short` is empty
throughout.

`prune-sync-outbox`'s `TELEMETRY` set was missing `ZONE_AGRONOMY` (E-I1):
`scripts/test-outbox-retention.js` was red on HEAD (5/6) because the trigger
count check compared 33 declared triggers against the 35 the schema actually
carries. Fixed both profiles; the test is 6/6; the retention doc names the
new evictable aggregate. The protected `UPSERT_ZONE` applied no stage-date
rule when the command carried no `stage_started_on` (E-I2): `updateFullZone`
now shares the Terra path's rule (renamed `terraStageStartedOn` →
`ruleStageStartedOn`), with the same override the other three paths already
had — a change to unset always clears the date, whatever the key said. Four
new cases in `scripts/test-zone-command-path.js` (18/18). The edge GUI's
`ZoneConfigModal` sent the stage without the date on a save that changed it
(queued Important item): `buildConfigPayload` now sends `stageStartedOn`
whenever `phenologicalStage` changes, including empty, matching the cloud
form's `stageChanged ||` clause (osi-server `070b3f88`); two new cases plus
one updated assertion in `ZoneConfigModal.test.tsx` (24/24, tsx suite
183→183 unaffected, vitest 2179→2181).

Four Minor findings closed alongside: the legacy node's invalid-date warning
said "keeping the stored date" when the rule, not the stored value, decides
it (E-M1) — text now reads "ignoring the value", with a changed-stage
assertion added to `test-legacy-upsert-zone-config.js` (7/7).
`zone-config-fn` left its database handle open on an invalid zone id (E-M5)
— now closes it first; a new test in `test-zone-weather-source.js` spies on
the harness facade's `close()` and asserts exactly one call (37/37). The
locale-comparison test could pass while comparing zero texts after a future
key rename (E-M3) — `test-shared-agronomy-locales.js` now asserts
`compared === 77` with no silent `continue` (1/1, `OSI_SERVER_ROOT` set).
`osi-agronomy-daily`'s per-zone `existingRows` read scanned the whole table
instead of the 92 days `daysNeedingWork` actually uses (E-M6, pure
efficiency, no behavior change) — now bounded; a new test spies on the SQL
and its bound params. The queued E3 review item (the night rule's prior
window was a flat 24 UTC hours, not the zone's own prior local day) is now
`localDayWindow(addDays(date,-1), tz, memo)`; two new regression tests cover
a 23-hour Zurich DST transition day and a west-longitude
(America/Los_Angeles) zone. `osi-agronomy-daily`'s suite: 51/51 (48 + 3 new).

Docs: the legacy `UPSERT_ZONE_CONFIG` default-date timezone limit (E-M2),
the ASCE-EWRI Cd 0.34-vs-0.24/0.96 note with the 4.85 mm/5.02 mm numbers
(E-M4), and a `COUNT(ambient_temperature)` follow-up for the sample_count
acceptance query (E-M7, no code change, ruling recorded) all landed in one
commit; "clover" dropped from the transcription-notes example list (no
transcription note backs it). `parse_table11.py`/`build_table11.py`'s
unused-import, bare-`open()` and dead-assignment nits were fixed only after
confirming a rebuild still gives byte-identical `crop-kc.json` and
`table11-stage-lengths.json`. The queued op-parity `contract_version`
message did not reproduce at HEAD or at the pinned base `c5bc18314`; the
commit that reported it, `3a918101c`, is not an ancestor of HEAD — recorded,
not fixed. Hygiene pass replaced the remaining real gateway ids with
placeholder ids and the two lineage names in the two stage-date plans and
their tests with generic labels (the two lineage fixtures); the spec was
replaced with a byte copy of
the cloud's canonical version (sha256
`48a809703eb037d5c250aec07d4aabae6085e3f3abfabaaada04046c5bd40faf`, `cmp`
confirms both repos byte-identical) rather than hand-edited, per a mid-task
correction — the cloud's copy already carried the review's amendments and
placeholder ids.

Hygiene counts on the final head, one `git diff <base>..HEAD` per range,
`*.db` excluded: `24a3cd9f5..HEAD` 6 added lines with a hit,
`8eee792ce..HEAD` 72. None newly written by this stack. The 6 of the
narrower range, and 6 of the wider range, are the same three `flows.json`
nodes (both profiles), each an unchanged comment dragged along by the
single-line function-text diff. The remaining 66 of the wider range are
existing values in five sub-project 3 files outside this wave's scope, all
under `osi-history-helper` except the plan doc and the GUI test:
`__fixtures__/analysis-device-catalog.json` (56, both profiles),
`analysis.test.js` (2, both profiles), the sub-project 3 weather-data-view
plan (6), `scripts/test-zone-weather-source.js` (1) and
`AnalysisSeriesTray.test.tsx` (1).

Ratchet numbers: `prune-sync-outbox` +16 chars/profile (E-I1), then
`zone-config-fn` +19 and `4f4a765f36cee6f3` −5 (E-M5/E-M1, net +14); flows
total per profile `c5bc18314` 1580418 → HEAD 1598241 (`total_allowance.delta`
17793 → 17809 → 17823). `verify-flows-size-ratchet-baseline.json`
regenerated at 1598241 both profiles; `verify-live-gateway-identity.js`'s
exact-delta pin updated to 17823. No migration, seed or checksum file
changed in this wave.

Gates: every verifier and test file the final-fix brief named passed on the
final head, plus a further ~40 scripts read out of `.github/workflows/*.yml`
that the brief's hand-made list did not name (the same gap that let E-I1
through originally) — 275/276 of the `migrations.yml` batch, 102/102 of
`verify-sync-flow.yml`'s zone/terra/rename/outbox cluster, and the flows
output-arity/fn-parse/outbox-json-guard/scoped-access checks, all green.
One red, pre-existing: `scripts/verify-migrations.test.js` (not in the
brief's list) inherits `OSI_MIGRATIONS_BASE_REF` from the environment like
`verify-migrations.js` itself, since `runVerifier`'s `spawnSync` passes no
explicit `env`; with `OSI_MIGRATIONS_BASE_REF=c5bc18314` it is 7/7. Its
default base is `origin/main`, which has already landed a different
migration 0060 (RAK10701's field-tester-type migration — the three-way 0060
collision from `branch-reconciliation-2026-09-28`); no migration file
changed in this wave, so CI stays red on this gate (its command in
`migrations.yml` carries no base-ref override) until the merge order is
settled, not renumbered here. GUI `typecheck`
clean; GUI `test:unit` 183/184 (tsx, 1 pre-existing conditional skip) +
2181/2181 (vitest). The two long suites (`lib/osi-migrate`,
`reconcile-ledger-numbering.test.js`) were not re-run — no migration, seed
or checksum file changed, so their result at `9beb7c372` stands.
