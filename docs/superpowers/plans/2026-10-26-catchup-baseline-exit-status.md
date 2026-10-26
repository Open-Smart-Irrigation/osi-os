# Catchup verifier exit status baseline repair

## Binding and decision

Base: `63c7a70f8f3b373f162b33b0669b0df89b3763fa` on the isolated `t3/catchup-baseline-exit-status` branch. This is the separate `catchup-baseline` blocker in the campaign ledger. It does not implement or close OSI #397. The accepted #397 plan remains at `d040674eae02a48ce9cb8841f39938f59c5d5263`, held until this repair is reviewed and verified.

The exact-base catchup test logged a passing named subtest, then exited 1: [capture](/home/phil/projects/osi-release-campaign-2026-10-25/reports/issue-397-plan-review-r2-evidence/baseline-catchup.json) and [log](/home/phil/projects/osi-release-campaign-2026-10-25/reports/issue-397-plan-review-r2-evidence/baseline-catchup.log). A separate fast probe confirmed that an imported `verify()` returns `false` while setting `process.exitCode=1`: [capture](/home/phil/projects/osi-release-campaign-2026-10-25/reports/issue-397-plan-review-r2-sol6-evidence/baseline-narrow.json). In `scripts/ops/generate-uganda-catchup-20260911.js:248-252`, a later successful call returns `true` without clearing the prior process state. Node therefore fails the test file after its assertions pass.

`verify()` is imported by its own test file. The schema-rebuild test imports only `generate()` and `apply()`. Repo-wide caller search found no other import of this `verify()`. CLI `main()` already maps `--verify` boolean results with `process.exit(ok ? 0 : 1)`; its catch maps thrown errors to exit 2. `--apply` and default generation do not call `verify()`. Keep those branches unchanged.

Only two product paths are in scope: `scripts/ops/generate-uganda-catchup-20260911.js` and `scripts/ops/generate-uganda-catchup-20260911.test.js`. No migration, SQL artifact, seed, database, deploy, flow, data, or destructive behavior changes. Do not set or clear process state inside the library, suppress the failing test, or change the CLI's existing mapping.

## Execution after independent plan review

1. Start from a clean isolated branch at the bound base. Confirm `git rev-parse HEAD` equals the base above and `git status --porcelain` is empty. Check `command -v node`, `command -v python3`, and `command -v sqlite3`. All test and check commands below run through `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py`, one at a time; wait for each completion. Follow its admission and deadline rules. Do not edit shared checkouts.

2. Add `const { spawnSync } = require('node:child_process');` after the `path` import in `scripts/ops/generate-uganda-catchup-20260911.test.js`. Insert this complete test immediately after `tmpDb()`:

```js
test('verify library leaves process exit state to caller; CLI maps results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-catchup-exit-'));
  const missing = path.join(dir, 'missing.db');
  const complete = path.join(dir, 'complete.db');
  const script = path.join(__dirname, 'generate-uganda-catchup-20260911.js');
  try {
    await cliRunner(missing).exec('PRAGMA user_version=0;');
    const ddl = [
      'CREATE TABLE probe (value INTEGER);',
      ...TABLES.map((name) => `CREATE TABLE "${name}" (value INTEGER);`),
      ...INDEXES.map((name) => `CREATE INDEX "${name}" ON probe(value);`),
      ...TRIGGERS.map((name) => `CREATE TRIGGER "${name}" AFTER INSERT ON probe BEGIN SELECT 1; END;`),
    ];
    await cliRunner(complete).exec(ddl.join('\n'));

    const apiProbe = `
      const assert = require('node:assert/strict');
      const { verify } = require(${JSON.stringify(script)});
      (async () => {
        const expected = process.argv[3] === 'preset' ? 7 : undefined;
        if (expected !== undefined) process.exitCode = expected;
        assert.equal(await verify(process.argv[1]), false);
        assert.equal(process.exitCode, expected);
        assert.equal(await verify(process.argv[2]), true);
        assert.equal(process.exitCode, expected);
      })().catch((error) => { console.error(error); process.exit(2); });
    `;
    for (const [label, expectedStatus] of [['unset', 0], ['preset', 7]]) {
      const child = spawnSync(process.execPath, ['-e', apiProbe, missing, complete, label], { encoding: 'utf8' });
      assert.equal(child.status, expectedStatus, child.stderr);
      assert.match(child.stderr, /--verify FAILED/);
      assert.match(child.stderr, /--verify PASSED/);
    }

    for (const [mode, db, expectedStatus] of [
      ['--verify', missing, 1],
      ['--verify', complete, 0],
      ['--verify', path.join(dir, 'absent.db'), 2],
      ['--apply', path.join(dir, 'absent.db'), 2],
    ]) {
      const child = spawnSync(process.execPath, [script, mode, db], { encoding: 'utf8' });
      assert.equal(child.status, expectedStatus, `${mode} ${db}: ${child.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

The synthetic SQLite fixture supplies all 6 table, 13 index, and 28 trigger names to the real `snapshotSchema` path. Its CLI statuses were independently probed on the unchanged base: missing 1, complete 0, absent `--verify` 2, absent `--apply` 2. Child processes isolate the API test from the Node test runner. The preset case must remain 7 throughout both calls; the unset case must remain unset and exit 0.

3. Run the negative control from repo root:

```bash
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --test --test-name-pattern 'verify library leaves process exit state to caller; CLI maps results' scripts/ops/generate-uganda-catchup-20260911.test.js
```

Expected on the unmodified product script: `verify(missing)` sets `process.exitCode` to 1, so the unset-state assertion sees `1 !== undefined`. The `apiProbe` catch calls `process.exit(2)`, making the probe child exit 2 where the parent test expects 0. The named Node test command exits 1. If it fails for another reason, stop and report. Preserve the exact command, cwd, base SHA, exit status, and output.

4. In `verify(dbPath)` of `scripts/ops/generate-uganda-catchup-20260911.js`, delete only `process.exitCode = 1;` from the `if (missing.length)` branch. Retain its diagnostic and `return false;`, the success diagnostic and `return true;`, and all of `main()` verbatim. This makes the imported API return a boolean without changing caller process state; the CLI still maps false/true to exit 1/0 and exceptions to 2.

5. Rerun the named test, then the existing catchup file and syntax check, serially:

```bash
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --test --test-name-pattern 'verify library leaves process exit state to caller; CLI maps results' scripts/ops/generate-uganda-catchup-20260911.test.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --test scripts/ops/generate-uganda-catchup-20260911.test.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --check scripts/ops/generate-uganda-catchup-20260911.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py git diff --check
```

Expected: all commands exit 0. The focused test proves false then true leave both caller exit states unchanged, while CLI missing objects and missing paths stay nonzero. The existing catchup test proves its real reference(1) repair still passes and now exits 0. Do not rerun the entire 20-command #397 baseline suite for this narrow repair. Record each child exit and output, not just an assertion line or wrapper admission.

6. Review `git diff 63c7a70f8f3b373f162b33b0669b0df89b3763fa --` for exactly the two paths above. Commit only the product script and test, using `fix: keep catchup library verification from setting process exit status`. Capture the resulting SHA and clean status. A fresh reviewer must inspect the plan before execution; a different verifier must check the implementation diff and rerun affected tests at the final SHA. No GitHub write, push, PR, merge, deployment, live access, or secret use is part of this plan stage.

## Integration dependency for OSI #397

Keep the #397 plan's original runtime base `63c7a70f8f3b373f162b33b0669b0df89b3763fa` and its exact-base byte guards. The reviewed baseline fix can enter the later #397 isolated branch through an explicit dependency after the 52-file manifest patch is extracted and checked against that original base. Verify that the baseline commit touches neither the 52 planned manifest paths nor their expected base bytes; stop for renewed plan review if that is false. If PR delivery needs two branches, make the dependency an explicit stacked PR, with the baseline repair as its own review unit. Do not merge here. At the integrated candidate SHA, rerun affected catchup and #397 gates and obtain fresh independent review of the combined diff; neither prior review alone covers that SHA.
