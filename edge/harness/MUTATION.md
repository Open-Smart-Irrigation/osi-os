# Tier-B mutation pass

`mutate.js` checks the tier-B rule of the rewrite charter (§1.4 point 3): on
hostile or never-written input the Go backend must never do more than the
Node-RED oracle. It rewrites one scenario input at a time with a mutation
operator, runs the result on both backends from the same database snapshot,
and compares effects, not responses.

```bash
source /home/phil/builds/edge-rewrite-20261123/spike/env.sh
node edge/harness/mutate.js --scenario edge/harness/scenarios/07K-manual-indexed-query.json \
  --steps open-with-bracket-index-20 --sites duration \
  --backend-cmd /abs/path/osi-edge --out /abs/scratch/dir
```

Options: `--scoped`, `--operators a,b`, `--steps id,id`, `--sites REGEX`,
`--ids REGEX`, `--limit N`, `--continue sql|all|none` (default `sql`),
`--ticks a,b`, `--rounds N` (default 3), `--no-control`, `--keep`, `--list`
(prints mutant ids and exits). The run writes `summary.json` and, for every
mutant that is not OK, `records/<label>.json` with both backends' raw step
records. The exit code is 1 when any mutant is TIER-B-FAIL or ERROR.

## Operators

Each operator is one file, `lib/mutate-op-*.js`, loaded by
`lib/mutate-ops.js`. A new tier-B family is a new file with a `value(v, site)`
and/or `pair(p, site)` function; the runner has no per-case code.

| Operator | Value sites | Query and form keys |
|---|---|---|
| `tostring-object` | `{"toString":0}` | `key[toString]=0` |
| `array-wrap` | `[v]`, `[v,v]` | `key[]=v`, `key=v&key=v`, `key=v&key[]=v` |
| `numeric-string` | `"15"`, `"0x10"`, `" 15 "`, `"1e3"` for leaves whose text starts like a number (this includes dates and UUIDs with a leading digit) | same, as the value |
| `bracket-index` | none | `key[0]`, `key[20]`, `key[21]`, `key[a]` |
| `legacy-date` | for ISO dates and epoch-millisecond numbers: `Y/M/D h:m:s GMT`, `Y-M-DZ`, an RFC 1123 PST time, minutes-only ISO, all the same instant | same |
| `real-in-integer` | `126.5` in an INTEGER column of a sql setup step | none |
| `nul-char` | a U+0000 at the end, in the middle and at the start of a string (sql sites store it through `char(0)`) | same, as the value |
| `malformed-valve-eui` | a 16-hex key written into `devices.deveui` or a valve table's `device_eui` (sql sites only): non-hex first digit (`nonhex`), last digit dropped (`short`), lower case (`lower`, only when the key has a letter); the rewrite is carried, see below | none |
| `unparseable-timestamp` | `garbage` in place of a string that `Date.parse` reads, written into a column whose name ends in `_at` (sql sites only) | none |
| `whitespace-trim` | for strings: the value padded with a tab (`pad-tab`), NBSP, U+FEFF, U+2028, CRLF or NEL, and each of those characters alone (`only-*`); body values carry like `nul-char`, a 16-hex sql key carries like `malformed-valve-eui` | same, as the value |
| `case-flip` | every ASCII letter of a string swaps case (`flip`); the valve key columns are left to `malformed-valve-eui` `lower`; carries as `whitespace-trim` | same |
| `blob-text` | a sql string literal stored as a BLOB with the same bytes (`X'…'`) | none |
| `numeric-text` | numbers and decimal strings as text that `Number()` reads as the same value: `pad-space`, `pad-tab` (tab and LF), `nbsp`, `plus`, `hex`, `exp`; in an INTEGER, REAL or NUMERIC column only `nbsp` and `hex`, because SQLite converts the others back to the number | same |

`malformed-valve-eui` stands for a stored device key that a hostile import
or an older claim path wrote. Every Node-RED valve radio writer passes the key
through `normalizeDevice` (`osi-valve-control/dispatch.js`: trim, upper case,
`/^[0-9A-F]{16}$/`) and refuses before its first write. One literal on its
own would only break the joins between the device row and its schedules or
settings, so the variant *carries the key*: every quoted literal equal to the
original key in the mutated sql step and in later sql steps, and every later
`http.path` segment equal to it, takes the same rewrite
(`lib/mutate-sites.js` `carriedKey`). Sites that name the same key give one
mutant per variant, under the id of the first site. `lower` checks the other
direction: Node-RED upper-cases the key and matches `UPPER(deveui)`, so a
backend that matches the stored key exactly does less, which the pass logs.

`unparseable-timestamp` stands for stored text that `Date.parse` cannot read.
Node-RED's due tests then compare NaN and are false (`workers.js`
`runClockTick`), while a parser that falls back to the zero time treats the
row as never stamped.

`whitespace-trim` targets the three trims in play. JavaScript's `trim()`
strips tab, LF, CR, NBSP, U+FEFF and the line separators; SQLite's `trim()`
strips only U+0020; Go's `strings.TrimSpace` strips NEL (U+0085), which
JavaScript keeps, and keeps U+FEFF. A Go port that moves a JavaScript trim
into SQL reads `\tKEY\t` or a lone tab differently (dispatch review B2: a tab
gateway EUI that Node-RED treats as missing). `numeric-text` differs from
`numeric-string` in that every form keeps the original value, so a difference
can only come from parsing.

The mixed spelling `key=v&key[]=v` matters: qs folds it into a two-element
array, while a backend that reads only the plain key sees one scalar.

`nul-char` covers the legacy nodes that splice a value into SQL text as a
quoted literal: SQLite reads the statement as a C string, so the node fails at
the NUL, while a backend that binds the value goes on. Its body variants
*carry*: when a later step's body holds the same value under the same key (the
username of `register` echoed by `login`), that step gets the same rewrite and
the mutant runs the rest of the scenario, captures included, so the value
reaches the routes that use it. A carried mutant continues unless
`--continue none`; its control runs the unmutated rest. Mutants without an
echo follow the `--continue` rule.

## Input sites

`lib/mutate-sites.js` finds, per step:

- JSON body leaves (`http.body`, or `rawBody` when it is JSON);
- query parameters of `http.path` and urlencoded `rawBody` fields;
- every leaf of an uplink payload (`uplink`, `uplinks[i]`);
- the literals a sql step writes into a column (`lib/mutate-sql.js`:
  `INSERT … VALUES`, `INSERT … SELECT`, `UPDATE … SET`), and the leaves of
  JSON text inside such a literal. Literals nested in expressions (format
  strings, `json_set` paths, `WHERE` clauses) are not written values and are
  skipped. Column affinity comes from `database/farming.db`.

Mutant ids are `scenario/step/site/operator/variant` and stay the same across
backend heads, so two runs with the same filters cover the same mutants.

## How one mutant runs

1. A prefix pass boots the oracle on a fresh seed, runs the scenario and saves
   a `VACUUM INTO` snapshot plus the captured variables (tokens) just before
   every step that has selected mutants.
2. For each such step, a control runs the unmutated step from that snapshot on
   both backends. Each mutant then runs the mutated step from the same
   snapshot. `lib/mutate-backend.js` boots the oracle on the snapshot (the same
   environment as `startNodeRed` in `lib/backend.js`) and the backend through
   `startCommand`, which first runs the boot runner (`edge/boot/run-sync-init.js`)
   on the database, as the osi-edge init does on a device. Node-RED's boot node
   repairs the database on every start (the zone and device gateway EUI
   backfills among others); without the runner, Go started on a snapshot that
   only the oracle had repaired and wrote `irrigation_events.event_uuid` NULL
   where Node-RED wrote `irrig-<gateway>-<n>`. `OSI_HARNESS_NO_BOOT_RUNNER=1`
   starts Go on the database as it is. The runner needs the release-smoke Node
   and `npm ci --prefix scripts/fixtures/release-smoke`.
   The probe's recording environment applies to the prefix pass and both
   sides (`lib/probe-env.js`): the noapp, nokey, nourl, blank-EUI, empty-EUI
   and field-tester probes get the oracle's `OSI_ORACLE_NODE` wrapper
   (`scenarios/dispatch/oracle-*-node.sh`) and the same variable change on the
   Go side, and a probe whose name says "scoped" runs scoped. The profile
   comes from the scenario name. `DUAL` lists the probes recorded both legacy
   and `--scoped`; `mutate.js` runs them in the mode `--scoped` picks, and
   the inventory pass runs both (the scoped group is `<group>@scoped`).
3. Mutants of a sql setup step also run the rest of the scenario: setup values
   are read by later steps, and a tick alone does not reach them (in
   `090-daily-schedule` the DENDRO zones are enabled after the seed step).
   `--continue all` does this for every mutant, `none` for no mutant.
4. Quiescence ticks follow: the timers the scenario itself drives, then
   `valve-once-tick`, `valve-clock-tick`, `valve-observe-tick`,
   `strega-reconciliation-tick`, `conditional-due-tick`, then the sync family
   (`sync-outbox-flush`, `sync-history-batch`, `sync-history-manifest`,
   `sync-pending-commands`, `command-ack-flush`, `sync-token-refresh`,
   `sync-bootstrap`, `journal-v2-replication`). Rounds repeat until a round has
   no effect after normalisation, at most `--rounds`. A timer the backend does
   not register (HTTP 500 `unknown timer`) is recorded as `unregistered`, not
   as an error; a panic in a registered tick is an ERROR.

## Effects and verdicts

`lib/mutate-effects.js` turns each run into a multiset of effects:

- database rows added, removed or changed, in every table (accounts,
  sessions, grants, roles and the outbox are rows);
- gRPC calls on the ChirpStack stand-in;
- MQTT publications to the local broker other than the harness's own uplinks
  (this includes `command/down`);
- cloud MQTT publishes (scenarios with `"cloud": true` only);
- tokens in a response body;
- files added, changed or removed under `data/`, `srv/` and `var/` of the run
  directory, the live database excluded.

Values pass through `lib/normalize.js`; placeholder numbering, `__rowid` and
integer `id` columns are then removed, so a backend that writes a subset of
the oracle's rows never shows "more" because its ids shifted. A changed row
counts one effect per changed column, so changing fewer columns than the
oracle is "less".

| Verdict | Meaning |
|---|---|
| TIER-B-FAIL | The backend produced an effect the oracle did not, at the step, in the continued steps or in the ticks. |
| LOGGED | Only status or body differ, a request timed out, or the oracle produced an effect the backend did not ("less"). |
| OK | Same effects and responses. |
| ERROR | A boot failure, crash, harness error or tick panic: no verdict. Never counted as a pass. |
| REJECTED | The schema refused the mutated sql setup step (CHECK, foreign key), so no backend saw the value. Not a pass. |
| FLAKY | A TIER-B-FAIL that its confirmation run did not repeat. Listed with both records (`<label>` and `<label>-confirm`), not counted as a failure. |

Every TIER-B-FAIL, control or mutant, runs once more (`--no-confirm` skips
this). The two sides run seconds apart from a snapshot whose stamps keep
ageing, so a time window can close between the oracle's run and the
backend's: the 30-second snapshot debounce and its 5-minute cap, the
10-minute one-time grace. A control that fails once and not again is
replaced by its re-run. Both sides of one control or mutant expand the
scenario's date tokens (`{{datetime:-1h}}`) from the same instant, and an
operator variant that does not keep a token verbatim is not generated.

Oracle effects from ticks the backend does not register are listed as
`lessUnported` and do not make a mutant LOGGED.

`attributable` says whether a TIER-B-FAIL comes from the mutation: it is
false when every extra effect also appears in the control run from the same
snapshot, which happens when the base scenario already holds the hostile
value. `fidelity` compares each control's oracle record with the continuous
prefix pass for the same step; a difference shows state that a restart from
the snapshot loses.

## Fail-first evidence (23–24 Nov 2026)

The charter requires the pass to catch the valve review r5 and r6 blockers
at their pre-fix heads. Binaries were built from `git archive <sha> edge/go`,
never from a live worktree. Each target below ran at three heads with the same
mutant ids: `f5318382d8` (before the r5 fix), `3884a6c9d6` (before the r6 fix)
and `7d70f47636` (after both).

| Blocker | Mutant (base scenario, step, operator) | f5318382d8 | 3884a6c9d6 | 7d70f47636 |
|---|---|---|---|---|
| r5 DENDRO `reasoning` String() | `096` seed-numeric-computed-control, `water.action.reasoning` "Synthetic probe" to `{"toString":0}` | TIER-B-FAIL | OK | OK |
| r5 same, daily-schedule base | `090` seed-observations, zone 11 `reasoning` to `{"toString":0}`; Go opens at step `dendro-11` | TIER-B-FAIL | OK | OK |
| r5 query arrays | `07K` index-20 step and `07J` step, `duration_minutes=15&duration_minutes[]=15` (array-wrap, mixed) | TIER-B-FAIL | OK | OK |
| r6 query index 21 | `07K` index-20 step and `07J` step, `duration_minutes[21]=15` (bracket-index) | OK | TIER-B-FAIL | OK |
| r6 Date ToPrimitive | `097` (scratch base, see below), `display.lastReceivedAt` ISO to `{"toString":0}` | TIER-B-FAIL | TIER-B-FAIL | OK |
| r6 sibling Date site | `096` seed-numeric-computed-control, `display.sharedGeneratedAt` 1893456000000 to `{"toString":0}` | TIER-B-FAIL | TIER-B-FAIL | OK |

No row's control was TIER-B-FAIL at the failing head (the 07J and 07K
controls at f5318382d8 are LOGGED: the reviewer input is in the base), so
each flag is attributable to the mutation.

Two blockers needed a note:

- The r5 reviewer's literal input `duration_minutes[]=15` makes Node-RED open
  the valve and the f5318382d8 binary refuse it, so Go did less. "Never more"
  cannot flag a refusal: the pass reports it as LOGGED with 5 missing effects.
  The same defect (Go read only the plain key) shows as "more" with the mixed
  spelling, where qs builds `['15','15']` and Node-RED refuses while Go opens.
- No repository scenario has a well-formed `display.lastReceivedAt`. In 095
  and 096 the base value is already `{"toString":0}`, so the mutants there fail
  together with their control (`attributable: false`). The supplementary base
  `097-daily-dendro-received-benign.json` (spike scratch, not in the
  repository) is 095 with `reasoning: "Synthetic probe"` and
  `lastReceivedAt: "2026-11-23T06:00:00.000Z"`.

At `7d70f47636`, all 76 mutants and 9 controls of the matrix were OK: none
LOGGED, none ERROR. Restart fidelity matched the continuous prefix pass for
every control step; that check compares only the mutated step itself, so it
means something for the HTTP steps (070, 07J, 07K) and nothing for sql steps,
which the harness executes directly. A mutant took 13 to 25 s, almost all of it the oracle
(4 s boot plus ticks); one target of 7 to 14 mutants took 2 to 5 minutes.

Beyond the matrix, at `7d70f47636`:

| Run | Mutants | Result |
|---|---|---|
| `094` unfiltered, every site and operator | 107 | 85 OK, 22 REJECTED (CHECK and foreign-key refusals), 1,799 s |
| `077` form-open step (form sites) | 20 | 20 OK |
| `070` report-open step, uplink `object` leaves | 28 | 28 OK |
| `096` real-in-integer | 2 | both refused by a foreign key (run before REJECTED existed; reported OK then) |
| `077` real-in-integer on `valve_schedules` and `valve_schedule_pushes` | 4 | LOGGED, inherited from the control (below) |

The 077 control from `seed-weekly` exposed a difference in the quiescence
`valve-clock-tick`: Node-RED clears an expired SKIP_TODAY through
`upsertSettings` (`osi-valve-control/workers.js`, `store.js`), which also bumps
`valve_settings.sync_version`; the Go tick (`valve_timers.go`) runs the same
UPDATE without the bump. The pass reports it as LOGGED, "less".

Re-run (one target; the matrix is these nine at each of the three binaries):

```bash
source /home/phil/builds/edge-rewrite-20261123/spike/env.sh
B=/home/phil/builds/edge-rewrite-20261123/spike/tmp/mutation-bins   # osi-edge-<sha>
S=edge/harness/scenarios
node edge/harness/mutate.js --scenario $S/07K-manual-indexed-query.json --steps open-with-bracket-index-20 --sites duration --backend-cmd $B/osi-edge-<sha> --out <dir>
node edge/harness/mutate.js --scenario $S/07J-manual-open-extended-query.json --steps open-with-single-value-bracket-query --sites duration --backend-cmd … --out …
node edge/harness/mutate.js --scenario $S/096-daily-dendro-noncoercible-dates.json --steps seed-numeric-computed-control --sites 'reasoning|sharedGeneratedAt' …
node edge/harness/mutate.js --scenario $S/095-daily-dendro-received-fallback.json --steps seed-fresh-local-and-malformed-shared-date --sites lastReceivedAt …
node edge/harness/mutate.js --scenario $S/096-daily-dendro-noncoercible-dates.json --steps seed-received --sites lastReceivedAt …
node edge/harness/mutate.js --scenario $S/094-daily-dendro-noncoercible.json --steps seed-shared-recommendation --sites reasoning …
node edge/harness/mutate.js --scenario $S/090-daily-schedule.json --steps seed-observations --sites 'summary_json#1\$water.action.reasoning' …
node edge/harness/mutate.js --scenario $S/070-timed-open.json --steps open-again --sites duration_minutes …
node edge/harness/mutate.js --scenario <spike>/runs/mutation/scenarios/097-daily-dendro-received-benign.json --steps seed-fresh-local-and-malformed-shared-date --sites lastReceivedAt …
```

Build a binary with `git archive <sha> edge/go | tar -x -C <dir>` and
`CGO_ENABLED=0 go build -trimpath ./cmd/osi-edge` inside `<dir>/edge/go`.

## Fail-first evidence for `nul-char` (24 Nov 2026)

The zones, settings and devices confirming review (B1, B2) found two
NUL-splice blockers that no operator could see. Run against `827c92eb5d`
(before the fix) and `b7fd7146f8` (the fix), with the same mutant ids;
binaries built from `git archive`:

| Blocker | Mutant (base scenario, step, site) | 827c92eb5d | fix head |
|---|---|---|---|
| B1 username spliced by the legacy auth nodes | `030` register, `body.username` (carried into login; the rest of the scenario runs) | TIER-B-FAIL ×3 (Go inserts the `irrigation_zones` row of `zone-create-ok` and later rows) | OK ×3 |
| B2 claim DevEUI spliced by `check-existing-device` | `040` device-add-kiwi, `body.deveui` | TIER-B-FAIL ×3 (Go calls ChirpStack `get`, `create`, keys, `delete`) | OK ×3 |

Both controls (the unmutated step plus the rest) were OK at both heads, so
every flag is attributable. These runs used legacy mode only.

Commands in this file without `--operators` now also generate `nul-char`
mutants. Existing mutant ids are unchanged, but counts such as the 76 of the
valve matrix above, and any `--limit` selection, include the new mutants.
Pass `--operators` with the six earlier names to reproduce those runs. A carried mutant of `030` took about 70 s, one
of `040` about 30 s.

```bash
node edge/harness/mutate.js --scenario edge/harness/scenarios/030-zones.json --operators nul-char --steps register --sites username --backend-cmd <bin> --out <dir>
node edge/harness/mutate.js --scenario edge/harness/scenarios/040-devices.json --operators nul-char --steps device-add-kiwi --sites deveui --backend-cmd <bin> --out <dir>
```

## Fail-first evidence for `malformed-valve-eui` and `unparseable-timestamp` (24 Nov 2026)

The dispatch-boundary review (runs/review-dispatch, B1 and B2) found that Go
dispatched to stored STREGA keys that Node-RED refuses and sent a clock frame
for an unparseable `last_clock_sync_queued_at`. Both operators were run against
`54def6ca17` (before the fix; binary built in a clean detached worktree) and the
fix head, with the same mutant ids:

| Blocker | Mutant (base scenario, step, site, variant) | 54def6ca17 | fix head |
|---|---|---|---|
| B1, 06:00 tick | `r1-dispatch-mutation-eui` seed, `devices.deveui#1`, `nonhex` and `short` | TIER-B-FAIL ×2 (Go writes `actuator_log`, `devices.target_state`, an expectation and enqueues `4114`) | OK ×2 |
| S1, 06:00 tick | same site, `lower` | LOGGED, less 4 (Node-RED opens the valve, Go does not) | OK |
| B1, one-time tick | `074-valve-timers` setup-extra, `devices.deveui#2` (the ONCE valve), `nonhex` and `short` | TIER-B-FAIL ×2 (Go opens it and marks the schedule FIRED) | OK ×2 |
| B1, clock tick | `074-valve-timers` setup-extra, `devices.deveui#1` (the WEEKLY valve), `nonhex` and `short` | TIER-B-FAIL ×2, attributable (Go enqueues FPort 12 to the malformed key, adds the push and a `valve_settings` row) | only the control's `event_uuid` difference, not attributable (below) |
| S1, clock tick | same site, `lower` | TIER-B-FAIL, attributable (Go writes the push and `valve_settings` under the lower-case key; Node-RED upper-cases it) | as above |
| B2, clock tick | `r1-dispatch-mutation-clock` setup, `valve_settings.last_clock_sync_queued_at#1` and `#2`, `garbage` | TIER-B-FAIL ×2 (Go inserts a CLOCK_SYNC push, enqueues FPort 12 or 13 and stamps `valve_settings`) | OK ×2 |

Every other mutant of `r1-dispatch-mutation-eui` (10) and
`r1-dispatch-mutation-clock` (22) was OK at both heads, and both controls were
OK. A first head of the fix still failed the `074` `nonhex` and `short`
mutants: Node-RED's `store.updateSchedule` also refuses a non-hex key, which
rolls back the one-time skip, fire and settlement writes. The pass found it
and the fix head carries it.

The `074` control from setup-extra is TIER-B-FAIL at both heads, and so are
the mutants that inherit it (marked `[base]`, among them every
`devices.deveui#1` variant at the fix head) plus `devices.deveui#2/lower`.
Every flagged effect there is the same `irrigation_events` row with
`event_uuid` NULL on Go against `irrig-<gateway>-<n>` on the oracle after the
restart from the snapshot. The continuous cassette replay of `074` is GREEN,
and the difference is not in a dispatch path. It came from the restart: the
harness now runs the boot runner before Go (How one mutant runs, step 2).

```bash
node edge/harness/mutate.js --scenario edge/harness/scenarios/r1-dispatch-mutation-eui.json --operators malformed-valve-eui,unparseable-timestamp --backend-cmd <bin> --out <dir>
node edge/harness/mutate.js --scenario edge/harness/scenarios/r1-dispatch-mutation-clock.json --operators malformed-valve-eui,unparseable-timestamp --backend-cmd <bin> --out <dir>
node edge/harness/mutate.js --scenario edge/harness/scenarios/074-valve-timers.json --operators malformed-valve-eui --steps setup-extra --backend-cmd <bin> --out <dir>
```

Commands in this file without `--operators` now also generate these two
operators' mutants; pass `--operators` with the earlier names to reproduce the
earlier counts. One mutant took 40 to 120 s on a loaded host; the two r1 bases took about 25
and 45 minutes in parallel with other runs.

## Inventory pass

`inventory-mutate.js` runs every check of `edge/contracts/dispatch-inventory.json`
through its probe under the operators that fit its inputs: `whitespace-trim`,
`nul-char`, `case-flip`, `blob-text`, `numeric-text`, `malformed-valve-eui` and
`unparseable-timestamp` (CTO ruling: a row is ok only through its probe, and the
probe must hold under these too).

```bash
source /home/phil/builds/edge-rewrite-20261123/spike/env.sh
node edge/harness/inventory-mutate.js --list --quick          # derivation and counts, no run
node edge/harness/inventory-mutate.js --quick --jobs 8 --backend-cmd /abs/osi-edge --out /abs/scratch/dir
node edge/harness/inventory-mutate.js --rows '^outbox-valve-runtime/' --backend-cmd … --out …   # full mode, one entry
```

Options: `--rows REGEX` (matches `entry/check` or `row41`), `--jobs N`
(default 2), `--chunk N` (mutants per mutate.js run, default 40), `--depth N`,
`--rounds N`, `--inventory FILE`, `--report-only`. The run writes
`inventory-mutation.json` and `REPORT-TABLE.md` and exits 1 when a mutant is
TIER-B-FAIL or ERROR.

### Which inputs a check gets

`lib/inventory-derive.js` reads the check's `js`, `go` and `refs` line
ranges, plus the bodies of the functions those lines call (Go: any function
under `edge/go`; JavaScript: functions of the module a ref points into, and
for `flows.json` only the referenced node). Every identifier in that text is
a name. A site fits when its name (sql column, last JSON key, query or form
key) is one of them:

- probe step sites: request fields, query and form keys, uplink payload
  leaves. A step with several uplinks keeps one uplink per payload field.
  When no probe step site matches a name, all of them are kept.
- stored literals: the values earlier sql steps of the probe scenario write.
- stored columns: a table and one of its columns that the code both names,
  that no earlier sql literal writes, and that is not a key (`id`, `deveui`,
  `device_eui`, `*_id`, `*_uuid`) or the outbox. The driver puts a column
  step just before the probe step: `UPDATE t SET c = c WHERE 0` in the
  control (no row, so no trigger fires), and in a mutant an SQL expression of
  the stored value (`char(9) || c || char(9)`, `CAST(c AS BLOB)`, `'garbage'`
  for an `_at` column, …). This reaches values that HTTP steps or the boot
  wrote. The `only-*` variants also fill NULL rows, which is B2's input
  (`devices.gateway_device_eui` set to a tab).

An optional `mutation` field on a check replaces the derivation:
`{"sites": "REGEX", "steps": ["id"], "operators": ["name"], "columns":
[{"table": "t", "column": "c", "where": "SQL"}]}` (`where` limits a column
step to some rows, so a key column can be rewritten on one device), or `{"skip": "why"}` when no operator can
rewrite the input (an environment variable, the HTTP method). The field is
additive; the verifier and the generated DISPATCH-INVENTORY.md ignore it.

Each probe scenario is one group: its steps up to the last probe step that
any check names, with each check's column steps in place. Mutant ids keep
the `scenario/step/site/operator/variant` form (a column step's id is
`col-<probe step>-<table>.<column>`), so a mutant that several checks share
runs once. `mutate.js` runs each probe in its recording environment and mode
(`lib/probe-env.js`, above). `--groups REGEX` limits a run to the probe
groups whose name matches.

`mutate.js` leaves a column step's own row changes out of the verdict: they
are harness input, and they differ between the sides whenever the boot from
the snapshot changed the column on one side only. A column mutant that ends
OK while the snapshot before it had no row (`only-*`) or no non-NULL value
(the other variants) is counted as vacuous, not as coverage.

### Full and quick mode

| | Full | Quick (`--quick`, review rounds) |
|---|---|---|
| Code read | check lines and their callees (`--depth 1`) | check lines; callees only when those name no input |
| Stored literals | every literal | the first literal per column and JSON path |
| Variants | all | `whitespace-trim` `only-feff`, `pad-tab`; one each for the rest (`QUICK` in `lib/inventory-derive.js`) |
| Tick rounds | 3 | 2 |
| Mutants at `a670c9e8ac` and later | 26,193 | 3,440 |

A mutant takes about 14 s (12.6 s of it the oracle: 3.8 s boot plus steps and
ticks); at 8 to 10 jobs the measured wall rate was 1.9 to 2.8 s per mutant.
Full mode over every row would take 14 to 20 hours of wall time, so use it
per entry with `--rows`. The run resumes: a mutant id already in a group's
summaries for the same binary is not run again.

A row's verdict is the worst of its mutants (TIER-B-FAIL, ERROR, LOGGED,
REJECTED, OK). A row is covered when at least one non-vacuous mutant ended OK,
LOGGED or TIER-B-FAIL. NO-PROBE, SKIP and NOT-COVERED rows are listed.

### Evidence at `5ae283e4d3` (24 Nov 2026)

Binary built from `git archive 5ae283e4d3 edge/go` (sha256 `9ad93b75…`). Quick
mode over all 122 checks: 3,450 mutants in about 2 h 40 min wall at 8 to 10
jobs (the run was resumed once after a 2-hour limit), then row 16 again with
its corrected `where`; 114 rows covered. The other 8: two have no probe, two
carry a `skip` (the noapp environment variable, the HTTP method), and four
lost every fitting mutant to a CHECK or foreign-key refusal (rows 29, 30, 35
and `valve-once/late-duration`).

Review B2 (row 41) is caught mechanically, and only through mutants the
derivation chose on its own (no explicit field on row 41):

| Mutant (`07I-linked-stale-plan`) | Result |
|---|---|
| `link-gateway-for-cancel`, `sql.sync_link_state.gateway_device_eui#1`, `only-feff` and `pad-tab` | TIER-B-FAIL, attributable, twice: Go writes a `VALVE_RUNTIME_CHANGED` outbox row stamped with the raw value, Node-RED stamps `0016C001F1000001` |
| column step `devices.gateway_device_eui`, `only-feff` (B2's own input column, set on every row just before the clock tick) | TIER-B-FAIL, attributable, twice: Go stamps `\ufeff`, Node-RED trims it away and falls back to the link gateway |
| full mode, same check: 240 mutants in 7.6 min at 10 jobs | 25 TIER-B-FAIL: every `whitespace-trim` variant on the link gateway, NUL in the middle and at the start, the case flip, and a BLOB `valve_schedule_pushes.device_eui` that Go renders as `[OBJECT OBJECT]` |

The second inventory row 41 check (`outbox-valve-archive`, which review B2
listed as affected by reading only) fails the same way through
`07I-linked-observed-close`. The other failures the pass found, and the base
and timing classes it separates out, are in the run report
(`runs/inventory-mutation/REPORT.md` in the spike scratch, not in the
repository).

Two restart differences between the backends showed up across the pass at
`5ae283e4d3`: Go wrote `irrigation_events.event_uuid` NULL where Node-RED
wrote `irrig-<gateway>-<n>` (the 074 note above), and a case-flipped or
blank gateway EUI ended up in different `devices` columns. Both came from the
boot node `sync-init-fn` ("Sync Init Schema + Triggers"), whose backfills
(`UPDATE irrigation_zones SET gateway_device_eui = … WHERE gateway_device_eui
IS NULL OR gateway_device_eui = ''` and the same for `devices`) ran on the
oracle's restart only. Since 25 Nov 2026 the harness runs the boot runner
before every Go start (How one mutant runs, step 2), as the device does.

## Not covered

- Cloud REST calls: the harness has no REST stand-in. Outbox rows, which
  precede every sync REST call, are compared.
- Cloud MQTT: only for scenarios with `"cloud": true` (Podman required).
- In-memory flow context and Go in-process state do not survive the restart
  from the snapshot; `fidelity` lists the steps where this changed the oracle's
  result.
- Ticks the Go backend does not register yet are not exercised on that side:
  at `7d70f47636` that is 11 of the 14 used here (`valve-observe-tick`,
  `strega-reconciliation-tick`, `conditional-due-tick` and the 8 sync ticks).
- The daily tick appends SKIP events on every run, so daily scenarios always
  use all `--rounds` without reaching a quiet round.
- Full-scenario runs: one scenario has 107 to 1,450 mutants (090 the most),
  about 20 s each, so the matrix above uses step and site filters.
- `cloud-heartbeat`, gateway health, weather, retention and rollup timers are
  not part of the quiescence set.
- Headers, path segments and literals inside SQL expressions are not
  mutated. A path segment changes only as part of a carried device key.
- A missing oracle effect can cancel a different-time backend effect with the
  same normalised content, because the multiset spans the whole run.
- A Gen1 clock frame (radio call or `CLOCK_SYNC` push) is compared without
  its time, so a wrong clock offset is invisible here; cassette replay checks it.
- Inventory pass: a check whose code names none of its inputs needs the
  explicit field. A key column is a column step only through the explicit
  field. Earlier HTTP steps are not mutated for a later probe. Only a 16-hex
  key is carried, so a probe whose key is deliberately not hex (the nonhex
  probes) loses the foreign key and ends REJECTED. Day-boundary fields can
  flip between the two sides' runs: re-run a daily-scheduler failure before
  calling it. `analytics_age_hours` is compared as present or null, not by
  value (`lib/mutate-effects.js` `WALL_CLOCK_AGES`): the oracle and the
  backend compute it from the frozen snapshot minutes apart.
