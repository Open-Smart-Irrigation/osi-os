# Issue 519: close public bootstrap when any account exists

This plan changes public registration to require an empty `users` table in both modes and documents a trusted operator transition for an existing no-admin gateway. Scoped first setup still inserts an explicit admin. Flag-off first setup still creates a default-role researcher.

Status: amended design after round-1 REQUEST CHANGES; fresh independent Sol approval required. The resource hold remains active. No amended source, extraction tool, CLI test, gate or prose checker has been executed. No product code has been applied. The later implementation requires independent Sol verification and the campaign's fresh Opus PR review. The current assignment authorizes a local plan commit only, with no push, PR, child delegation, merge, deployment, SSH or live access.

## Reviewed base and evidence

The T3-created worktree is `/home/phil/.t3/worktrees/osi-os/t3-f199e2f1`, branch `t3/issue-519-bootstrap-plan`. It was clean at `c37207b30b002fb79da8ae57253d78c04613b6a5`. `git fetch origin` followed by `git merge --ff-only origin/main` advanced only that branch to `63c7a70f8f3b373f162b33b0669b0df89b3763fa`. The user root checkout was not operated on. No credentials were inspected.

[Issue 519](https://github.com/Open-Smart-Irrigation/osi-os/issues/519) was open with its original five acceptance bullets, priority P0, and zero comments when read through the GitHub connector. This is a locally reproduced exposure conditional on scoped mode becoming effective with existing users and no admin and on an untrusted client reaching the listener. No deployed exposure was measured.

The campaign's `PLAN.md`, `COORDINATION.md`, `reports/issue-468-review.md` and full `reports/issue-519-security-consult.md` were read before design. The current AGENTS.md, engineering playbook, common-pitfalls, flows editing, config, schema, sync, verification, live-ops safety/backup sections and anti-slop writing guidance supplied the repository rules. Live-ops guidance was consulted only to document future maintenance.

Independent source checks on this base established:

- The actual registration route is `auth-register-http -> auth-register-func -> auth-db-query -> auth-process-result -> auth-db-insert -> auth-insert-complete -> auth-response`. The success body is `{success:true}`, not a token. Login subsequently issues a seven-day HMAC token.
- `auth-db-insert` has one conditional INSERT per mode. Scoped mode currently tests absence of `role='admin'`; flag-off already tests absence of every user. The INSERT callback's own row-change count controls success. Credential state is request-local on `msg._authwork`.
- `0044__scoped_access_schema.sql` defaults roles to researcher. `0045__scoped_access_backfill.sql` selects the lowest enabled id only when no admin row exists. Disabled admins block it; all-disabled non-admins remain non-admin. `applyPending` skips already-applied migrations. Changing the service environment does not rerun 0045.
- `96_osi_server_config` defaults `scoped_access_enabled` to 0. `node-red.init` reads it and exports `OSI_SCOPED_ACCESS` at service start. The account router is 404 with the flag off and checks fresh admin/disabled state with it on.
- The USER role trigger fires on username/role/disabled-state updates and only emits with the existing emit gate enabled. It carries the caller's incremented `sync_version`; it does not automatically version a direct repair. Password-hash-only mutation is outside that trigger's column list.
- The shipped protected `UPSERT_SCOPED_USER` applier can create/update an admin without requiring an existing admin or consulting the feature flag. Its cloud-originator authorization was not established here. It is not this plan's recovery mechanism.
- `deploy.sh` stops the service for migration, then may activate/start the paired payload. Failure/rollback paths can restart a retained payload. Containment must already exist and survive that restart.

Saved-file probes ran through the campaign wrapper before the subsequent resource hold. Existing auth/migration coverage passed 18/18. The full chained `verify-sync-flow.js` exited 0 with both `Sync flow verification passed` and `All parity checks passed.`. An earlier revision of the proposed actual-flow regression ran 67 tests against unchanged product code: 49 passed, 18 failed on the scoped nonempty-account cases. The prior plan's focused transition run produced two tests, both failing `201 !== 403`. The prior plan's 67-test source passed against external simulated copies containing only the proposed node body. That simulation is design evidence, not an implemented candidate or a deployed test.

Historical evidence in this section belongs to original plan commit `f9e75a25785d99e4d7fe5757de8b04cbb014474c`; it does not validate this amendment. Two separate saved-file probes passed and reproduced collateral defects: the same token is accepted after disable/reset/re-enable, and linked password reset reports 200 while the old linked credential works and the new local password fails. The initial duplicate check found no dedicated issue in searches for `"re-enable" "token"`, `"revocation"`, `"password-reset"`, `"session" "reset"`, and `"linked" "reset"`; #434 is a different cached-role problem. The parent has published [#520](https://github.com/Open-Smart-Irrigation/osi-os/issues/520) for token revival and [#521](https://github.com/Open-Smart-Irrigation/osi-os/issues/521) for ineffective linked reset. Their product fixes remain outside #519; the earlier draft-publication step is complete.

The coordinator subsequently ordered a hold on new heavy commands after resource review found supervisor-crash admission and malformed-policy defects. The pre-amendment command already running finished normally with 67/67 simulated tests. The amended target is 109 tests: bootstrap 67, recovery 26 and CLI 16. These are source-derived expectations awaiting execution after hold lift, not new results. Do not start the commands below until that hold is explicitly lifted. Source and prose work continued; final plan prose checks and the complete planned gate runner have not run. Existing evidence includes actual test counts/output, so it does not depend on a silent wrapper exit 0. It does not certify the resource controller.

## Round-1 required changes

The full review is `/home/phil/projects/osi-release-campaign-2026-10-25/reports/issue-519-plan-review-r1.md`. The amendments below respond to R1–R3. They have not been approved or executed.

- R1: `recover` reserves a create name with a bound query against both username columns inside `BEGIN IMMEDIATE`, with no disabled-account filter. The runbook selection includes server_username. Four cases per profile cover enabled/disabled linked aliases with v1/v2 verifier login, unchanged full state/outbox after alias and local-name refusals, preserved original alias login after distinct-name recovery, and quote-bearing bound names.
- R2: four post-write cases per profile inject readback failure after a real UPDATE/INSERT and assert that the mutation and expected trigger event were observed before failure, then require complete state/sequence/outbox rollback and successful transaction reacquisition. One two-connection case per profile tests both a blocked competing writer and repair lock refusal with unchanged state, followed by a successful repair. Three cases per profile start with only a disabled admin, all-disabled non-admins or unsuitable no-admin credentials. A separate 0045 fixture tests last-admin undo refusal, actual historical promotion and selected correction. Populated linked credentials/metadata, plot ownership and plot grants replace empty/fallback-only controls.
- R3: the exact CLI is copied byte-for-byte into a temporary scripts tree and started in 16 saved-file subprocess cases. The tests cover mode-0600 ownership/file requirements, malformed/stale/invalid specs, missing DB and sidecars, absent/short/multiline password data, promotion/creation, dependency/open/pragma/close failures, limited output, credential privacy and subsequent operations. Password data goes through a protected file descriptor, never arguments or shell interpolation. The CLI prints success only after close completes.

The original runtime body, size delta and single-node ownership remain unchanged. No schema, migration or product flag is added. The recovery helper is a private raw-connection tool; its local login-name guard does not expand #519 into changes to every account API.

`node:sqlite` supplies the test-only raw callback driver in `scripts/fixtures/account-recovery/sqlite3.cjs`. A subprocess-only preloader verifies the CLI's exact resolver paths and restricts dependency lookup to its temporary scripts tree; it cannot read host `/srv` or `/usr/share` runtime modules. The sqlite3 fixture opens a private connection and checks mode 2, FK setup and closure. It never imports `osi-db-helper`. A temporary bcryptjs shim points to the already bundled repository module. These are authored fixture files, not a package install; no native addon exists in this worktree and none is installed by this plan. Subprocesses use `--no-warnings` to suppress the test adapter's Node SQLite experimental warning while retaining the CLI's own stderr contract. Actual installed native sqlite3 resolution and Pi/Node-RED qualification remain a separately authorized operational gate.

After hold lift, stage the tests and maintenance sources through the extraction steps, then run all three suites through the wrapper. The regression target remains a red/green check against actual flow source. For the review amendments, retain the first run's failures with their exact reason, repair only the planned source if needed and return divergences to design review. An import/fixture/CLI resolution failure is not a valid bootstrap red result. CI runs all three suites together; the gate runner separately requires 67, 26 and 16 cases with no skip/cancel/failure and records the actual head SHA and plan digest. The prior 67-pass simulation is historical evidence only.

## Acceptance mapping and limits

| Original issue acceptance | Planned enforcement and evidence |
|---|---|
| Define supported transition and trusted administrator selection | Full runbook replacement below; explicit exact-row promotion, deliberate disabled-admin restoration or named recovery admin. Authority comes from the owner/operator's verified identity record, never ordering or a public request. |
| Refuse unauthenticated bootstrap when any account exists; preserve empty setup | One `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)` in each existing branch. No exception for role, auth mode, disabled state or incomplete UUID metadata. No new provisioning bypass. |
| Actual-flow empty-migration / flag-off signup / flag-on signup regression | Source below follows the shipped HTTP node wiring to the response and tests login/admin access, peer refusal with identical original rows, and isolated operator continuation. The transition fixture performs its empty backfill before signup and never reruns it afterward. |
| Existing admin, upgrade ordering, concurrency, flag-off preservation | Both profiles; empty/nonempty matrix; separate one-time-backfill fixtures; controlled driver barrier over the real `osi-db-helper` queue for distinct and same-name/different-password races, plus a trusted insert between lookup and write. |
| Operator recovery without deleting accounts or replacing DB; both profiles | Guarded maintenance tool and rehearsals preserve credentials/links, every other account, ownership, assignments and device history. Runtime edit mirrors canonical bcm2712 to bcm2709 byte-for-byte. |

The new policy does not add a schema object, migration, persistent provisioning latch, environment flag, cloud contract or boot hook. Do not edit 0044/0045, CHECKSUMS.json, seeds, bundled DBs, `sync-init-fn`, deploy.sh, auth verifiers or scoped command appliers. Privileged deletion of all users or restoring an empty DB can reopen first-run eligibility; both are prohibited recovery. A trusted network remains required for first commissioning.

No new automatic promotion is introduced. Historical pending 0045 behavior remains and requires supervised review under containment. A guarantee against every unattended historical promotion is a separate design. Session revocation and linked credential reset remain separate defects; the touched runbook must stop advertising either false recovery path now.

The harness uses Node SQLite behind a sqlite3-shaped adapter and the actual facade queue, not a complete Node-RED HTTP runtime, procd/UCI or Pi sqlite3 driver. Its seed-schema plus one-time-backfill fixture models completed account migrations without running the complete migration runner. The shipped migration is tested separately and left unchanged. A separately authorized isolated test-gateway smoke check is required before operational adoption; no live work is part of this task.

## Owned surfaces

The executor owns `auth-db-insert` in both maintained flows and only that runtime node. Its id, libs, outputs, wires, DB cleanup and request-local credential behavior stay intact. No other auth node changes.

The executor also owns the `auth-db-insert` key in `scripts/verify-flows-size-ratchet-allowances.json`; the two message expectations/comment in `scripts/test-auth-credential-isolation.js`; the final copied-bootstrap test in `scripts/rehearse-scoped-access-migration.test.js`; one three-suite test invocation adjacent to that test in `.github/workflows/migrations.yml`; the new test/harness, recovery suite, CLI suite, two test-only fixture modules and standalone maintenance sources below; `docs/operations/account-recovery-runbook.md`; and bootstrap/recovery wording in `docs/adr/2026-07-19-scoped-multiuser-access-model.md`. This plan is its own review record. The parent records these claims in the campaign ledger before implementation. No migration-number slot or shared helper/node is claimed beyond these entries.

The maintenance sources live in `scripts/`; they are not payload modules, have no HTTP route, are not installed by deploy.sh, and need no profile/helper registry entry. A future authorized operator stages the reviewed pair together explicitly. They do not run during ordinary startup or flag changes.

## Execution order

Stop on any source, test or gate result that differs from this plan. Refresh the current issue body/comments and relevant open PR work before execution; do not publish duplicate work. Preserve the root checkout. Use the reviewed isolated branch or a new T3-bound isolated worktree based on the reviewed local commit. If origin/main has advanced or a claimed shared surface changed, return the plan for review rather than silently updating predicates, sizes or baselines.

Before edits, require a clean status and record worktree, branch, plan commit and base SHA. After the resource hold lifts, save the extraction script below as `/tmp/extract-519.py` and run it from the repo root. Every probe and gate uses saved files, never `node` or Python program text only on stdin.

```python
from pathlib import Path
import sys
plan = Path('docs/superpowers/plans/2026-10-25-issue-519-bootstrap.md').read_text()
groups = {
    'tools': ['/tmp/issue-519-plan/auth-db-insert.js.txt', '/tmp/issue-519-plan/apply-flow.cjs',
              '/tmp/issue-519-plan/update-existing.cjs', '/tmp/issue-519-plan/scan.cjs',
              '/tmp/issue-519-plan/gates.py'],
    'tests': ['scripts/lib/bootstrap-auth-harness.js', 'scripts/test-auth-bootstrap-policy.js',
              'scripts/test-account-recovery.js', 'scripts/test-account-recovery-cli.js',
              'scripts/fixtures/account-recovery/sqlite3.cjs', 'scripts/fixtures/account-recovery/resolve.cjs'],
    'implementation': ['scripts/lib/account-recovery-transaction.js', 'scripts/account-recovery.js',
                       'docs/operations/account-recovery-runbook.md'],
}
for name in groups[sys.argv[1]]:
    marker = '<!-- file: ' + name + ' -->\n'
    assert plan.count(marker) == 1, name
    block = plan.split(marker, 1)[1].splitlines()
    fence = block[0].split()[0]
    assert fence.startswith('````'), name
    delimiter = fence.rstrip('abcdefghijklmnopqrstuvwxyz')
    end = block.index(delimiter, 1)
    target = Path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('\n'.join(block[1:end]) + '\n')
    print('wrote ' + name)
```

1. Extract only `tools` with `python3 /tmp/extract-519.py tools`. Run `python3 /tmp/issue-519-plan/gates.py base`. It runs the existing auth, scoped, wiring, parse, arity, catch, size and full chained sync gates serially through `run-heavy.py`, records command/exit/output JSON, and rejects missing pass artifacts. A red base stops the surface; it never licenses a baseline repair here. The direct bare-require file is only a module and prints nothing when invoked alone; `scan.cjs` calls its exported scanner on both profiles and proves it rejects a negative control.
2. Extract `tests` with `python3 /tmp/extract-519.py tests`. Run the focused regression before writing either runtime or maintenance implementation:

   ```sh
   python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --test --test-name-pattern='empty migration' scripts/test-auth-bootstrap-policy.js > /tmp/issue-519-red.log 2>&1
   ```

   Require exit 1, exactly two tests and two failures, each `201 !== 403` at the peer-refusal assertion. No missing-module or helper-load failure is acceptable. The recovery import is lazy; the red test must fail before needing the new operator helper. Inspect the saved log and retain it. Do not weaken the assertion. Commit the six test/fixture sources as `test: reproduce nonempty public bootstrap (#519)`.
3. Extract `implementation` with `python3 /tmp/extract-519.py implementation`. Its runbook replacement is exact. Run these two saved edit tools from repo root:

   ```sh
   python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node /tmp/issue-519-plan/apply-flow.cjs
   python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node /tmp/issue-519-plan/update-existing.cjs
   ```

    The latter updates the two existing message pins, copied SQL rehearsal, CI invocation and ADR. It makes no product edit outside the owned files. The runtime script verifies no-op JSON roundtrip and profile equality before mutation. Expected `auth-db-insert`: 2812 -> 2428 characters, delta -384; per-profile embedded JS: 1633361 -> 1632977. Remove the consumed +531 `node_allowances.auth-db-insert` entry. Leave every other allowance, total allowance and committed size baseline unchanged. No new headroom is needed.
4. Run `python3 /tmp/issue-519-plan/gates.py candidate`. Require bootstrap 67/67, recovery 26/26 and CLI 16/16 (109 new cases in CI), existing auth/migration suite 18/18, nonempty scoped suites, zero skipped/cancelled tests, and every listed pass artifact. Inspect logs rather than trusting a process status alone. The scanner also parses all eight JS sources and asserts the exact node size and removed allowance. Full sync verification includes DB-schema and profile parity. If only a campaign guard refuses admission, retain the command and wait for the coordinator; do not bypass it. Any code/gate failure returns to design review.
5. Inspect the base-to-working-tree diff. Only `auth-db-insert.func` may differ in either flow; the two copies must match. The allowance diff deletes exactly its stale node entry. Existing credential-isolation tests remain intact except the two refusal-message pins and explanatory comment. Existing bootstrap rehearsal retains empty, second, disabled-admin and count checks and adds a non-admin-row control. No fixture counterexample is removed to obtain green.
6. Commit runtime, maintenance sources, existing-test edits, allowance deletion and the CI invocation as `fix: require zero users for public bootstrap (#519)`. Commit ADR and runbook as `docs: define trusted scoped account recovery (#519)`. The plan remains in this branch. Record exact SHAs. Use `git diff 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD --stat` and `git diff --check 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD`; a bare post-commit diff is insufficient evidence.
7. Hand the final SHA, reviewed plan, logs, diff and pending limitations to a fresh independent Sol verifier. Any repair invalidates affected verification/review. The parent handles the fresh Opus review and, after required review, any draft PR publication/linking. This executor does not push, create a PR or perform operational smoke work.

The gate script pins all relevant git-relative verifier bases to the reviewed base. Its output records exact commands, working directory, status, expected counts/signals and log paths. An executor must add its actual candidate/plan commit SHAs and environment overrides to the campaign report. No schema migration replay, GUI build or GUI edits are required; the UI already renders registration refusal messages, and no translation surface changes.

## Exact files and edit tools

Each marked block is the complete contents of its named file. The `/tmp/` tools are execution aids and are not committed. The eight JS sources, the runbook and the exact existing-file edits belong to the later implementation, after independent plan review.

<!-- file: scripts/lib/bootstrap-auth-harness.js -->
````javascript
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ROOT = process.cwd();
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const { executeFunction } = require(path.join(ROOT, 'scripts/lib/scoped-access-harness'));
const bcrypt = require(path.join(NR, 'node_modules/bcryptjs'));
const installation = require(path.join(NR, 'osi-installation-helper'));
const scope = require(path.join(NR, 'osi-scope-helper'));
const profiles = ['bcm2712', 'bcm2709'];
const flowFile = profile => path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
const backfill = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0045__scoped_access_backfill.sql'), 'utf8');
const expectedFields = ['id','user_uuid','username','auth_mode','role','disabled_at','sync_version'];
const expected = row => Object.fromEntries(expectedFields.map(field => [field, row[field]]));
function rawFacade(native) {
  return {
    all(sql, params, cb) { try { cb(null, native.prepare(sql).all(...params)); } catch (error) { cb(error); } },
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try { const out = native.prepare(sql).run(...(params || [])); cb.call({ changes: Number(out.changes) }, null); }
      catch (error) { cb(error); }
    }
  };
}
function fixture(profile = 'bcm2712', { backfillPending = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-519-'));
  const dbPath = path.join(dir, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  if (!backfillPending) db.exec(backfill); // Models empty-install ordering; never replay after signup.
  const installationUuid = crypto.randomUUID();
  const gateway = '0016C001F1000001';
  db.prepare('INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run(installationUuid,gateway,'2026-01-01','2026-01-01');
  const flows = JSON.parse(fs.readFileSync(flowFile(profile), 'utf8'));
  const control = { hold: false, pending: [], callbacks: [], fail: false, missingChanges: false, opened: 0, closed: 0 };
  const nativeHandles = [];
  const helperPath = path.join(NR, 'osi-db-helper/index.js');
  class Driver {
    constructor(_name, mode, cb) {
      if (typeof mode === 'function') cb = mode;
      this.native = new DatabaseSync(dbPath);
      nativeHandles.push(this.native);
      control.opened++;
      setImmediate(() => cb && cb(null));
    }
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      setImmediate(() => {
        try { cb(null, this.native.prepare(sql).all(...(params || []))); }
        catch (error) { cb(error); }
      });
    }
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const insert = /^INSERT INTO users/.test(sql);
      const execute = () => setImmediate(() => {
        if (insert && control.fail) return cb(new Error('injected SQLITE_BUSY'));
        try {
          const result = this.native.prepare(sql).run(...(params || []));
          if (insert) control.callbacks.push(Number(result.changes));
          cb.call(insert && control.missingChanges ? {} : { changes: Number(result.changes) }, null);
        } catch (error) { cb(error); }
      });
      if (insert && control.hold) control.pending.push(execute);
      else execute();
    }
    close(cb) { this.native.close(); control.closed++; setImmediate(() => cb && cb(null)); }
  }
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    if (name === 'sqlite3' && parent && parent.filename === helperPath) return { Database: Driver, OPEN_READONLY: 1 };
    return original.call(this, name, parent, isMain);
  };
  let helper;
  try { delete require.cache[require.resolve(helperPath)]; helper = require(helperPath); }
  finally { Module._load = original; }
  const flowState = {};
  const secret = crypto.randomBytes(32).toString('hex');
  const env = on => ({ AUTH_TOKEN_SECRET: secret, DEVICE_EUI: gateway, LINK_GATEWAY_DEVICE_EUI: gateway, OSI_SCOPED_ACCESS: on ? '1' : '0' });
  const node = id => { const n = flows.find(n => n.id === id); assert.ok(n, id); return n; };
  async function invoke(id, msg, on, overrides = {}) {
    const out = await executeFunction(node(id), {
      msg, db, flowState, env: env(on), osiLibModules: { installation, scope },
      libOverrides: { osiDb: helper, ...overrides }
    });
    Object.assign(flowState, out.flowState);
    return out.result;
  }
  const users = () => db.prepare('SELECT * FROM users ORDER BY id').all().map(row => ({ ...row }));
  const seed = (name, role = 'researcher', disabled = null, linked = false) => {
    const password = crypto.randomBytes(12).toString('hex');
    const hash = bcrypt.hashSync(password, 4);
    const link = linked === true ? { version:2, alias:name + '-cloud' } : linked;
    const version = link ? link.version : 0;
    const verifier = link ? bcrypt.hashSync(installation.verifierSubject(password,version,installationUuid,gateway),4) : null;
    db.prepare('INSERT INTO users(username,password_hash,created_at,user_uuid,role,disabled_at,auth_mode,server_username,server_offline_verifier,server_offline_verifier_version,server_password_hash,cloud_user_id,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,last_auth_sync_at,last_auth_sync_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(name, link ? 'unused-local' : hash, '2026-01-01', crypto.randomUUID(), role, disabled,
        link ? 'server' : 'local', link ? link.alias : null, verifier, version, null,
        link ? 101 : null, link ? 'https://cloud.example.invalid' : null,
        link ? 'synthetic-sync-token-' + crypto.randomUUID() : null, link ? 9999999999999 : null,
        link ? '2026-01-01' : null, link ? '2026-01-01' : null, link ? 'ok' : null);
    return { row: users().at(-1), password };
  };
  async function prepare(name, password, on) {
    let msg = { req: { headers: {}, method: 'POST', path: '/auth/register' }, payload: { username: name, password } };
    for (const id of ['auth-register-func', 'auth-db-query', 'auth-process-result']) {
      const [next, refusal] = await invoke(id, msg, on);
      if (refusal) return { refusal };
      assert.ok(next, id); msg = next;
    }
    return { msg };
  }
  async function finish(prepared, on, overrides) {
    if (prepared.refusal) return prepared.refusal;
    const [next, refusal] = await invoke('auth-db-insert', prepared.msg, on, overrides);
    if (refusal) return refusal;
    assert.ok(next);
    return invoke('auth-insert-complete', next, on);
  }
  async function dispatch(kind, name, password, on) {
    let entry = node(`auth-${kind}-http`);
    assert.equal(entry.method, 'post'); assert.equal(entry.url, `/auth/${kind}`);
    let id = entry.wires[0][0];
    let msg = { req: { headers: {}, method: 'POST', path: entry.url }, payload: { username: name, password } };
    for (let hop = 0; hop < 10; hop++) {
      const current = node(id);
      if (current.type === 'http response') return msg;
      assert.equal(current.type, 'function');
      const result = await invoke(id, msg, on);
      let port = 0;
      if (Array.isArray(result)) {
        const active = result.map((value,index) => value ? index : -1).filter(index => index >= 0);
        assert.equal(active.length, 1); port = active[0]; msg = result[port];
      } else msg = result;
      assert.ok(msg); assert.equal(current.wires[port].length, 1);
      id = current.wires[port][0];
    }
    assert.fail('auth route exceeded hop limit');
  }
  async function register(name, password, on) { return dispatch('register', name, password, on); }
  async function login(name, password, on = true) { return dispatch('login', name, password, on); }
  async function account(token, method = 'GET', suffix = '', body = {}) {
    const parts = suffix.split('/');
    return invoke('scoped-admin-account-router', { req: {
      headers: token ? { authorization: `Bearer ${token}` } : {}, method,
      path: '/api/users' + suffix, params: { uuid: parts[1] }, body
    } }, true);
  }
  async function cleanup() {
    assert.equal(control.pending.length, 0, 'held driver write was not released');
    // osi-db-helper facade.close is deliberately a no-op; close its test backing handles.
    for (const native of nativeHandles) native.close();
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  return { db, dir, dbPath, node, control, users, seed, invoke, prepare, finish, register, login, account, cleanup, raw: rawFacade(db) };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('expected queue boundary was not reached');
}
module.exports = { fixture, rawFacade, profiles, flowFile, backfill, expected, until, bcrypt };

function populateResources(f, owner) {
  f.db.prepare('INSERT INTO irrigation_zones(name,user_id,zone_uuid) VALUES(?,?,?)').run('retained-zone',owner.id,'retained-zone');
  f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('A840410000000001','retained-device','DRAGINO_LSN50',owner.id,'2026-01-01','2026-01-01');
  f.db.prepare('INSERT INTO device_data(deveui,recorded_at,ambient_temperature) VALUES(?,?,?)').run('A840410000000001','2026-01-01',17);
  f.db.prepare('INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES(?,?,?,?)').run('retained-zone-grant',owner.user_uuid,'retained-zone','2026-01-01');
  f.db.prepare('INSERT INTO journal_plots(plot_uuid,plot_code,name,owner_user_uuid,zone_uuid) VALUES(?,?,?,?,?)').run('retained-plot','P1','retained plot',owner.user_uuid,'retained-zone');
  f.db.prepare('INSERT INTO user_plot_assignments(assignment_uuid,user_uuid,plot_uuid,created_at) VALUES(?,?,?,?)').run('retained-plot-grant',owner.user_uuid,'retained-plot','2026-01-01');
}
function snapshot(f) {
  const names = ['users','irrigation_zones','devices','device_data','user_zone_assignments','journal_plots','user_plot_assignments','scoped_access_emit','sync_outbox','installation_identity','sqlite_sequence'];
  return Object.fromEntries(names.map(name => [name, JSON.parse(JSON.stringify(f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()))]));
}
module.exports.populateResources = populateResources;
module.exports.snapshot = snapshot;
````

<!-- file: scripts/test-auth-bootstrap-policy.js -->
````javascript
#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fixture, profiles, flowFile, backfill, expected, until, bcrypt } = require('./lib/bootstrap-auth-harness');
const recover = (...args) => require('./lib/account-recovery-transaction').recover(...args);
const password = () => crypto.randomBytes(12).toString('hex');
function closed(response, status = 403) {
  assert.equal(response.statusCode, status);
  assert.ok(!response.payload.token);
  assert.ok(!response.payload.success);
}
async function using(profile, fn) { const f = fixture(profile); try { await fn(f); } finally { await f.cleanup(); } }

test('maintained profiles and auth wiring match', () => {
  assert.equal(fs.readFileSync(flowFile(profiles[0]), 'utf8'), fs.readFileSync(flowFile(profiles[1]), 'utf8'));
  const flows = JSON.parse(fs.readFileSync(flowFile(profiles[0]), 'utf8'));
  const nodes = new Map(flows.map(n => [n.id, n]));
  for (const [id, target] of [
    ['auth-register-http','auth-register-func'], ['auth-register-func','auth-db-query'],
    ['auth-db-query','auth-process-result'], ['auth-process-result','auth-db-insert'],
    ['auth-db-insert','auth-insert-complete'], ['auth-insert-complete','auth-response']
  ]) assert.ok(nodes.get(id).wires[0].includes(target), `${id} -> ${target}`);
  assert.deepEqual(nodes.get('auth-db-insert').wires, [['auth-insert-complete'], ['auth-response']]);
  assert.equal(nodes.get('auth-register-http').url, '/auth/register');
  assert.equal(nodes.get('auth-register-http').method, 'post');
});
for (const profile of profiles) {
  test(`${profile}: #519 empty migration, flag-off owner, flag-on peer refused, operator continuation`, () => using(profile, async f => {
    const ownerPassword = password();
    assert.equal((await f.register('owner', ownerPassword, false)).statusCode, 201);
    const before = f.users();
    assert.equal(before[0].role, 'researcher');
    closed(await f.register('peer', password(), true));
    assert.deepEqual(f.users(), before);
    closed(await f.login('peer', password()), 401);
    const ownerLogin = await f.login('owner', ownerPassword);
    assert.equal((await f.account(ownerLogin.payload.token)).statusCode, 403);
    await recover(f.raw, { action: 'promote', expected: expected(before[0]) });
    assert.equal(f.users()[0].role, 'admin');
    assert.equal((await f.login('owner', ownerPassword)).statusCode, 200);
    assert.equal((await f.account(ownerLogin.payload.token)).statusCode, 200);
    closed(await f.register('later-peer', password(), true));
  }));
  for (const on of [false, true]) {
    test(`${profile}: empty bootstrap, scoped=${on}`, () => using(profile, async f => {
      const credential = password();
      assert.equal((await f.register('first', credential, on)).statusCode, 201);
      assert.equal(f.users().length, 1);
      assert.equal(f.users()[0].role, on ? 'admin' : 'researcher');
      assert.equal((await f.login('first', credential, on)).statusCode, 200);
      closed(await f.register('second', password(), on));
      assert.equal(f.users().length, 1);
    }));
    for (const state of ['researcher','viewer','disabled-researcher','disabled-admin','admin','multiple','linked','missing-uuid']) {
      test(`${profile}: every account closes bootstrap: ${state}, scoped=${on}`, () => using(profile, async f => {
        const role = state.includes('admin') ? 'admin' : state === 'viewer' ? 'viewer' : 'researcher';
        f.seed('existing', role, state.startsWith('disabled') ? '2026-01-01' : null, state === 'linked');
        if (state === 'multiple') f.seed('another', 'viewer');
        if (state === 'missing-uuid') f.db.exec('UPDATE users SET user_uuid=NULL');
        const before = f.users();
        closed(await f.register('new-public-user', password(), on));
        assert.deepEqual(f.users(), before);
      }));
    }
    for (const sameName of [false, true]) {
      test(`${profile}: queued concurrent credential race, scoped=${on}, sameName=${sameName}`, () => using(profile, async f => {
        const firstPassword = password(), secondPassword = password();
        // Both requests pass username lookup before either INSERT is admitted.
        const first = await f.prepare('racer', firstPassword, on);
        const second = await f.prepare(sameName ? 'racer' : 'other', secondPassword, on);
        assert.ok(first.msg && second.msg);
        assert.equal(first.msg.userInsert.username, 'racer');
        assert.equal(second.msg.userInsert.username, sameName ? 'racer' : 'other');
        assert.ok(bcrypt.compareSync(firstPassword, first.msg.userInsert.passwordHash));
        assert.ok(!bcrypt.compareSync(secondPassword, first.msg.userInsert.passwordHash));
        f.control.hold = true;
        const a = f.finish(first, on);
        await until(() => f.control.pending.length === 1);
        const b = f.finish(second, on);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.control.pending.length, 1, 'real facade must serialize driver writes');
        f.control.pending.shift()();
        await until(() => f.control.pending.length === 1);
        f.control.pending.shift()();
        const [winner, loser] = await Promise.all([a,b]);
        assert.equal(winner.statusCode, 201); closed(loser);
        assert.deepEqual(f.control.callbacks, [1,0]);
        assert.equal(f.users().length, 1);
        assert.equal(f.users()[0].username, 'racer');
        assert.equal((await f.login('racer', firstPassword, on)).statusCode, 200);
        closed(await f.login(sameName ? 'racer' : 'other', secondPassword, on), 401);
      }));
    }
    test(`${profile}: trusted insert between lookup and write, scoped=${on}`, () => using(profile, async f => {
      const request = await f.prepare('public', password(), on);
      f.seed('trusted', 'viewer');
      const before = f.users();
      closed(await f.finish(request, on));
      assert.deepEqual(f.users(), before);
    }));
    test(`${profile}: DB failure does not bootstrap, scoped=${on}`, () => using(profile, async f => {
      const request = await f.prepare('public', password(), on);
      f.control.fail = true;
      closed(await f.finish(request, on), 500);
      assert.equal(f.users().length, 0);
      f.control.fail = false;
      f.db.exec('DROP TABLE users');
      closed(await f.register('public-without-schema', password(), on), 500);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='users'").get().n, 0);
    }));
    test(`${profile}: unknown row-change metadata never claims success, scoped=${on}`, () => using(profile, async f => {
      f.seed('existing');
      const request = await f.prepare('public', password(), on);
      const before = f.users(); f.control.missingChanges = true;
      closed(await f.finish(request, on));
      assert.deepEqual(f.users(), before);
    }));
  }
  test(`${profile}: unavailable insert helper fails without success`, () => using(profile, async f => {
    const request = await f.prepare('public', password(), true);
    await assert.rejects(f.finish(request, true, { osiDb: undefined }));
    assert.equal(f.users().length, 0);
  }));
  test(`${profile}: one-time backfill before/after account creation, disabled and linked cases`, async () => {
    const cases = [
      { rows: [['owner','researcher',null,false]], roles: ['admin'] },
      { rows: [['disabled','researcher','2026-01-01',false],['linked','viewer',null,true]], roles: ['researcher','admin'] },
      { rows: [['disabled-admin','admin','2026-01-01',false],['enabled','researcher',null,false]], roles: ['admin','researcher'] },
      { rows: [['disabled','researcher','2026-01-01',false]], roles: ['researcher'] },
      { rows: [['existing-admin','admin',null,false],['researcher','researcher',null,false]], roles: ['admin','researcher'] }
    ];
    for (const scenario of cases) {
      // All schema is present (0044-equivalent); 0045 has NOT run in this fixture.
      const f = fixture(profile, { backfillPending: true });
      try {
        for (const args of scenario.rows) f.seed(...args);
        f.db.exec(backfill); // Exactly once, after the legacy accounts exist.
        assert.deepEqual(f.users().map(row => row.role), scenario.roles);
        const before = f.users();
        closed(await f.register('peer', password(), true));
        assert.deepEqual(f.users(), before);
      } finally { await f.cleanup(); }
    }
  });
  for (const emit of [0,1]) {
    test(`${profile}: operator transactions preserve accounts, history, grants and emit semantics, emit=${emit}`, () => using(profile, async f => {
      const selected = f.seed('selected', 'viewer', null, true);
      const other = f.seed('other');
      f.db.prepare('INSERT INTO irrigation_zones(name,user_id,zone_uuid) VALUES(?,?,?)').run('fixture-zone', selected.row.id, 'fixture-zone');
      f.db.prepare('INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES(?,?,?,?)').run('fixture-grant', other.row.user_uuid, 'fixture-zone', '2026-01-01');
      f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('A840410000000001','fixture-device','DRAGINO_LSN50',selected.row.id,'2026-01-01','2026-01-01');
      f.db.prepare('INSERT INTO device_data(deveui,recorded_at,ambient_temperature) VALUES(?,?,?)')
        .run('A840410000000001','2026-01-01',17);
      const resources = () => JSON.stringify(['irrigation_zones','devices','device_data','user_zone_assignments','journal_plots','user_plot_assignments'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all()));
      f.db.prepare('INSERT INTO journal_plots(plot_uuid,plot_code,name,owner_user_uuid,zone_uuid) VALUES(?,?,?,?,?)').run('fixture-plot','P1','fixture plot',selected.row.user_uuid,'fixture-zone');
      f.db.prepare('INSERT INTO user_plot_assignments(assignment_uuid,user_uuid,plot_uuid,created_at) VALUES(?,?,?,?)').run('fixture-plot-grant',other.row.user_uuid,'fixture-plot','2026-01-01');
      const beforeResources = resources();
      f.db.prepare('UPDATE scoped_access_emit SET enabled=? WHERE id=1').run(emit);
      f.db.exec('DELETE FROM sync_outbox');
      const before = f.users();
      const base = expected(selected.row);
      const wrong = { id: 999, user_uuid: crypto.randomUUID(), username: 'wrong-name', auth_mode: 'local', role: 'researcher', disabled_at: '2026-01-01', sync_version: 99 };
      for (const key of Object.keys(wrong)) {
        const bad = { ...base, [key]: wrong[key] };
        await assert.rejects(recover(f.raw, { action: 'promote', expected: bad }));
        assert.deepEqual(f.users(), before);
        assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_outbox').get().n, 0);
      }
      await recover(f.raw, { action: 'promote', expected: expected(selected.row) });
      const promoted = f.users()[0];
      for (const key of Object.keys(selected.row).filter(k => !['role','updated_at','sync_version'].includes(k))) assert.equal(promoted[key], selected.row[key]);
      assert.equal(promoted.sync_version, selected.row.sync_version + 1);
      const events = f.db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='USER'").all();
      assert.equal(events.length, emit);
      if (emit) {
        const payload = JSON.parse(events[0].payload_json);
        assert.equal(payload.role, 'admin'); assert.equal(payload.disabled_at, null);
        assert.equal(payload.sync_version, promoted.sync_version);
        assert.equal(events[0].sync_version, promoted.sync_version);
        assert.equal(events[0].aggregate_key, promoted.user_uuid);
      }
      assert.equal((await f.account((await f.login('selected', selected.password)).payload.token)).statusCode, 200);
      const recoveryPassword = password();
      await recover(f.raw, { action: 'create', username: 'recovery-operator' }, bcrypt.hashSync(recoveryPassword, 4));
      assert.deepEqual(f.users().slice(0,2), [promoted, other.row]);
      assert.equal(resources(), beforeResources);
      assert.equal(f.db.prepare('SELECT enabled FROM scoped_access_emit WHERE id=1').get().enabled, emit);
      const recoveryToken = (await f.login('recovery-operator', recoveryPassword)).payload.token;
      assert.equal((await f.account(recoveryToken)).statusCode, 200);
      const allEvents = f.db.prepare("SELECT sync_version,payload_json FROM sync_outbox WHERE aggregate_type='USER' ORDER BY rowid").all();
      assert.equal(allEvents.length, 2 * emit);
      if (emit) { assert.equal(allEvents[1].sync_version,1); assert.equal(JSON.parse(allEvents[1].payload_json).role,'admin'); }
      closed(await f.register('public-after-recovery', password(), true));
      const afterRecovery = f.users();
      await assert.rejects(recover(f.raw, { action: 'create', username: 'recovery-operator' }, bcrypt.hashSync(password(),4)));
      assert.deepEqual(f.users(), afterRecovery);
      assert.equal((await f.account(recoveryToken,'PUT','/' + promoted.user_uuid + '/disabled',{ disabled:true })).statusCode,200);
      const disabled = f.users()[0];
      await recover(f.raw, { action: 'restore', expected: expected(disabled) });
      assert.equal(f.users()[0].disabled_at, null);
      await recover(f.raw, { action: 'undo-backfill', expected: expected(f.users()[0]), originalRole: 'viewer' });
      assert.equal(f.users()[0].role, 'viewer');
      assert.equal(resources(), beforeResources);
    }));
  }
}
````


<!-- file: scripts/test-account-recovery.js -->
````javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { fixture, profiles, expected, backfill, rawFacade, bcrypt, populateResources, snapshot } = require('./lib/bootstrap-auth-harness');
const recover = (...args) => require('./lib/account-recovery-transaction').recover(...args);
const password = () => crypto.randomBytes(15).toString('hex');
async function adminLogin(f,name,credential) {
  const login = await f.login(name,credential);
  assert.equal(login.statusCode,200);
  assert.equal((await f.account(login.payload.token)).statusCode,200);
}
async function publicClosed(f) {
  const before = f.users();
  const out = await f.register('new-public-name',password(),true);
  assert.equal(out.statusCode,403); assert.ok(!out.payload.token && !out.payload.success);
  assert.deepEqual(f.users(),before);
}
for (const profile of profiles) {
  for (const disabled of [false,true]) for (const version of [1,2]) {
    test(`${profile}: R1 aliases and quote-bearing bound names, disabled=${disabled}, verifier=${version}`, async () => {
      const f = fixture(profile);
      try {
        const alias = "linked'alias";
        const linked = f.seed('linked-row','researcher',disabled ? '2026-01-01' : null,{ alias,version });
        populateResources(f,linked.row);
        f.db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
        const before = snapshot(f);
        assert.equal((await f.login(alias,linked.password,!disabled)).statusCode,200);
        const newPassword = password(), hash = bcrypt.hashSync(newPassword,4);
        // Alias goes first: the pre-R1 tool incorrectly commits this insertion.
        for (const name of [alias,linked.row.username]) {
          await assert.rejects(recover(f.raw,{action:'create',username:name},hash),/login name is reserved/);
          assert.deepEqual(snapshot(f),before);
        }
        const recoveryName = "recovery'operator";
        await recover(f.raw,{action:'create',username:recoveryName},hash);
        const after = snapshot(f);
        assert.deepEqual(after.users.slice(0,before.users.length),before.users);
        for (const key of Object.keys(before).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],before[key]);
        assert.equal((await f.login(alias,linked.password,!disabled)).statusCode,200);
        assert.equal((await f.login(alias,newPassword,!disabled)).statusCode,401);
        if (disabled) assert.equal((await f.login(alias,linked.password,true)).statusCode,403);
        await adminLogin(f,recoveryName,newPassword);
        assert.equal(after.sync_outbox.length,before.sync_outbox.length+1);
        assert.equal(JSON.parse(after.sync_outbox.at(-1).payload_json).username,recoveryName);
        await publicClosed(f);
      } finally { await f.cleanup(); }
    });
  }
  for (const action of ['promote','create']) for (const emit of [0,1]) {
    test(`${profile}: R2 post-write ${action} rollback and reacquisition, emit=${emit}`, async () => {
      const f = fixture(profile);
      try {
        const selected = f.seed('selected','viewer');
        populateResources(f,selected.row);
        f.db.prepare('UPDATE scoped_access_emit SET enabled=? WHERE id=1').run(emit);
        const before = snapshot(f), credential=password(), hash=bcrypt.hashSync(credential,4);
        const spec = action==='promote' ? {action,expected:expected(selected.row)} : {action,username:'recovery'};
        let writes=0, injected=false;
        const faulty = {
          run(sql,params,cb) {
            f.raw.run(sql,params,function(error) {
              if (!error && /^(UPDATE users SET|INSERT INTO users)/.test(sql)) writes++;
              cb.call(this,error);
            });
          },
          all(sql,params,cb) {
            if (writes && /^SELECT \* FROM users WHERE/.test(sql)) {
              const written=snapshot(f);
              assert.equal(written.users.length,before.users.length+(action==='create' ? 1 : 0));
              if (action==='promote') assert.equal(written.users[0].sync_version,selected.row.sync_version+1);
              assert.equal(written.sync_outbox.length,before.sync_outbox.length+emit);
              injected=true; cb(new Error('injected post-write readback failure')); return;
            }
            f.raw.all(sql,params,cb);
          }
        };
        await assert.rejects(recover(faulty,spec,hash),/post-write readback failure/);
        assert.equal(writes,1); assert.equal(injected,true);
        assert.deepEqual(snapshot(f),before,'rollback must include timestamps, versions, triggers and sequence');
        await recover(f.raw,spec,hash); // Must acquire a new BEGIN IMMEDIATE after rollback.
        await adminLogin(f,action==='promote' ? selected.row.username : 'recovery',action==='promote' ? selected.password : credential);
        await publicClosed(f);
      } finally { await f.cleanup(); }
    });
  }
  test(`${profile}: R2 two connections contend before selection and release after refusal`, async () => {
    const f = fixture(profile);
    const competitor = new DatabaseSync(f.dbPath);
    try {
      competitor.exec('PRAGMA busy_timeout=0'); f.db.exec('PRAGMA busy_timeout=0');
      const selected=f.seed('selected','viewer'); populateResources(f,selected.row);
      const before=snapshot(f);
      let release, entered;
      const gate=new Promise(resolve => { release=resolve; });
      const begun=new Promise(resolve => { entered=resolve; });
      const held={
        run: f.raw.run,
        all(sql,params,cb) {
          if (sql==='SELECT * FROM users ORDER BY id') { entered(); gate.then(() => f.raw.all(sql,params,cb)); }
          else f.raw.all(sql,params,cb);
        }
      };
      const repair=recover(held,{action:'promote',expected:expected(selected.row)});
      await begun; // BEGIN IMMEDIATE succeeded, before selection is returned.
      let locked;
      try {
        assert.throws(() => competitor.prepare('UPDATE users SET sync_version=sync_version+1 WHERE id=?').run(selected.row.id),/locked|busy/i);
        assert.deepEqual(snapshot(f),before);
      } catch (error) { locked=error; } finally { release(); }
      await repair; if (locked) throw locked;
      const promoted=f.users()[0];
      competitor.exec('BEGIN IMMEDIATE');
      try {
        const after=snapshot(f);
        await assert.rejects(recover(f.raw,{action:'create',username:'contending-recovery'},bcrypt.hashSync(password(),4)),/locked|busy/i);
        assert.deepEqual(snapshot(f),after);
      } finally { competitor.exec('ROLLBACK'); }
      await recover(f.raw,{action:'create',username:'after-lock'},bcrypt.hashSync(password(),4));
      assert.equal(f.users().length,2);
      assert.equal(f.users()[0].sync_version,promoted.sync_version);
    } finally { competitor.close(); await f.cleanup(); }
  });
  for (const state of ['only-disabled-admin','all-disabled-nonadmins','unsuitable-no-admin']) {
    test(`${profile}: R2 actual no-usable-admin recovery: ${state}`, async () => {
      const f=fixture(profile);
      try {
        const selected=f.seed('original',state==='only-disabled-admin' ? 'admin' : 'viewer',state==='unsuitable-no-admin' ? null : '2026-01-01',{alias:'original-linked',version:2});
        if (state==='all-disabled-nonadmins') f.seed('another','researcher','2026-01-01');
        if (state==='unsuitable-no-admin') f.db.prepare('UPDATE users SET server_offline_verifier=? WHERE id=?').run('unusable-synthetic-verifier',selected.row.id);
        populateResources(f,selected.row);
        const before=snapshot(f);
        assert.equal(f.users().filter(row => row.role==='admin' && row.disabled_at===null).length,0);
        await publicClosed(f);
        const credential=password();
        if (state==='only-disabled-admin') {
          await recover(f.raw,{action:'restore',expected:expected(selected.row)});
          await adminLogin(f,'original-linked',selected.password);
          const row=f.users()[0];
          assert.deepEqual(row,{...selected.row,disabled_at:null,updated_at:row.updated_at,sync_version:selected.row.sync_version+1});
        } else {
          await recover(f.raw,{action:'create',username:'named-recovery'},bcrypt.hashSync(credential,4));
          assert.deepEqual(f.users().slice(0,before.users.length),before.users);
          await adminLogin(f,'named-recovery',credential);
        }
        const after=snapshot(f);
        for (const key of Object.keys(before).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],before[key]);
        await publicClosed(f);
      } finally { await f.cleanup(); }
    });
  }
  test(`${profile}: R2 actual 0045 promotion and selected correction with last-admin refusal`, async () => {
    const f=fixture(profile,{backfillPending:true});
    try {
      const unintended=f.seed('lowest','viewer',null,{alias:'lowest-cloud',version:1});
      const intended=f.seed('intended','researcher'); populateResources(f,unintended.row);
      const resources=snapshot(f);
      f.db.exec(backfill); // Once in this separate pending-backfill fixture.
      const promoted=f.users()[0]; assert.equal(promoted.role,'admin');
      const before=snapshot(f);
      const spec={action:'undo-backfill',expected:expected(promoted),originalRole:unintended.row.role};
      await assert.rejects(recover(f.raw,spec),/another enabled admin/);
      assert.deepEqual(snapshot(f),before);
      await recover(f.raw,{action:'promote',expected:expected(intended.row)});
      await recover(f.raw,spec);
      assert.equal(f.users()[0].role,'viewer');
      assert.equal(f.users()[0].sync_version,promoted.sync_version+1);
      assert.equal((await f.login('lowest-cloud',unintended.password)).statusCode,200);
      await adminLogin(f,'intended',intended.password);
      const after=snapshot(f);
      for (const key of Object.keys(resources).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],resources[key]);
      await publicClosed(f);
    } finally { await f.cleanup(); }
  });
}
````

<!-- file: scripts/test-account-recovery-cli.js -->
````javascript
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const { spawnSync }=require('node:child_process');
const { fixture,expected,bcrypt,populateResources,snapshot }=require('./lib/bootstrap-auth-harness');
const ROOT=process.cwd();
const FAIL='Account recovery refused or failed. Keep containment; inspect private state before retrying.';
const resultFields=['id','user_uuid','username','auth_mode','role','disabled_at','sync_version'];
async function using(fn) {
  const f=fixture();
  try {
    const selected=f.seed('selected','viewer',null,{alias:'selected-alias',version:2});
    populateResources(f,selected.row);
    f.db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
    const dir=path.join(f.dir,'cli','scripts');
    fs.mkdirSync(path.join(dir,'lib'),{recursive:true});
    for (const name of ['account-recovery.js','lib/account-recovery-transaction.js']) {
      const source=fs.readFileSync(path.join(ROOT,'scripts',name));
      fs.writeFileSync(path.join(dir,name),source);
      assert.ok(source.equals(fs.readFileSync(path.join(dir,name))));
    }
    for (const name of ['sqlite3','bcryptjs']) fs.mkdirSync(path.join(dir,'node_modules',name),{recursive:true});
    fs.copyFileSync(path.join(ROOT,'scripts/fixtures/account-recovery/sqlite3.cjs'),path.join(dir,'node_modules/sqlite3/index.js'));
    const bcryptPath=path.join(ROOT,'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/bcryptjs');
    fs.writeFileSync(path.join(dir,'node_modules/bcryptjs/index.js'),'module.exports=require('+JSON.stringify(bcryptPath)+');\n');
    const specPath=path.join(dir,'spec.json'), inputPath=path.join(dir,'password'), tracePath=path.join(dir,'driver-trace.jsonl');
    const privatePassword='synthetic-private-'+crypto.randomBytes(12).toString('hex');
    const marker='synthetic-driver-private-'+crypto.randomBytes(8).toString('hex');
    const specification={action:'promote',expected:expected(selected.row)};
    let passwordHashes=[];
    function call({spec=specification,rawSpec,mode=0o600,input='',control={},dbPath=f.dbPath,specFile=specPath}={}) {
      fs.writeFileSync(specPath,rawSpec===undefined ? JSON.stringify(spec) : rawSpec,{mode:0o600});
      fs.chmodSync(specPath,mode);
      fs.writeFileSync(path.join(dir,'driver-control.json'),JSON.stringify({privateMarker:marker,...control}));
      fs.writeFileSync(tracePath,'');
      fs.writeFileSync(inputPath,input,{mode:0o600});
      const descriptor=fs.openSync(inputPath,'r');
      let out;
      try {
        out=spawnSync(process.execPath,['--no-warnings','--require',path.join(ROOT,'scripts/fixtures/account-recovery/resolve.cjs'),path.join(dir,'account-recovery.js'),dbPath,specFile],{
          cwd:path.dirname(dir),env:{...process.env,NODE_OPTIONS:''},stdio:[descriptor,'pipe','pipe'],encoding:'utf8',timeout:10000,maxBuffer:1024*1024
        });
      } finally { fs.closeSync(descriptor); fs.rmSync(inputPath,{force:true}); }
      assert.ifError(out.error); assert.equal(out.signal,null);
      const output=out.stdout+out.stderr;
      const secrets=[privatePassword,marker,...passwordHashes,...f.users().flatMap(row => [row.password_hash,row.server_password_hash,row.server_offline_verifier,row.server_sync_token])].filter(Boolean);
      for (const value of secrets) assert.equal(output.includes(value),false,'CLI leaked fixture credential data');
      assert.doesNotMatch(output,/password_hash|server_password_hash|server_offline_verifier|server_sync_token|cloud_user_id|server_username|server_url|server_linked_at/);
      if (input.trim()) assert.equal(output.includes(input.trim()),false);
      assert.doesNotMatch(output,/\$2[aby]\$/);
      const trace=fs.readFileSync(tracePath,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      return {...out,trace};
    }
    function failure(out) { assert.equal(out.status,1); assert.equal(out.stdout,''); assert.equal(out.stderr.trim(),FAIL); }
    function success(out) {
      assert.equal(out.status,0); assert.equal(out.stderr,'');
      const result=JSON.parse(out.stdout);
      assert.deepEqual(Object.keys(result),resultFields);
      assert.deepEqual(result,Object.fromEntries(resultFields.map(field => [field,f.users().find(row => row.id===result.id)[field]])));
      assert.equal(out.trace.filter(row => row.event==='open').length,1);
      assert.equal(out.trace.find(row => row.event==='open').mode,2);
      assert.equal(out.trace.filter(row => row.event==='close').length,1);
      assert.equal(out.trace.find(row => row.event==='close').foreignKeys,1);
      assert.ok(out.trace.some(row => row.event==='run' && row.sql==='BEGIN IMMEDIATE'));
      return result;
    }
    passwordHashes.push(bcrypt.hashSync(privatePassword,4));
    await fn({f,selected,dir,specPath,privatePassword,call,failure,success,specification});
  } finally { await f.cleanup(); }
}
test('R3 missing DB refuses without DB or sidecars or driver resolution',() => using(async c => {
  const missing=path.join(c.f.dir,'missing.db');
  c.failure(c.call({dbPath:missing}));
  for (const suffix of ['','-wal','-shm','-journal']) assert.equal(fs.existsSync(missing+suffix),false);
  assert.deepEqual(c.call({dbPath:missing}).trace,[]);
}));
test('R3 spec permissions must be exactly 0600',() => using(async c => {
  const before=snapshot(c.f);
  for (const mode of [0o644,0o666,0o400]) { const out=c.call({mode}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before); }
}));
test('R3 malformed JSON refuses before driver open',() => using(async c => {
  const before=snapshot(c.f),out=c.call({rawSpec:'{broken'}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
}));
test('R3 stale spec closes raw connection and a second valid operation succeeds',() => using(async c => {
  const before=snapshot(c.f);
  const out=c.call({spec:{action:'promote',expected:{...expected(c.selected.row),sync_version:999}}});
  c.failure(out); assert.equal(out.trace.filter(row => row.event==='close').length,1); assert.deepEqual(snapshot(c.f),before);
  c.success(c.call());
}));
for (const [label,input] of [['missing',''],['short','short'],['multiline','valid-first-line\nsecond-line']]) {
  test(`R3 ${label} password refuses without driver open`,() => using(async c => {
    const before=snapshot(c.f),out=c.call({spec:{action:'create',username:'recovery'},input});
    c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
  }));
}
test('R3 successful promotion uses exact CLI, raw driver resolution and limited projection',() => using(async c => {
  const before=snapshot(c.f),result=c.success(c.call());
  assert.equal(result.role,'admin'); assert.equal(result.sync_version,c.selected.row.sync_version+1);
  const after=snapshot(c.f);
  for (const key of Object.keys(before).filter(k => !['users','sync_outbox'].includes(k))) assert.deepEqual(after[key],before[key]);
  for (const key of Object.keys(c.selected.row).filter(k => !['role','updated_at','sync_version'].includes(k))) assert.equal(after.users[0][key],c.selected.row[key]);
  const login=await c.f.login('selected-alias',c.selected.password);
  assert.equal(login.statusCode,200); assert.equal((await c.f.account(login.payload.token)).statusCode,200);
}));
test('R3 successful creation with quote-bearing name preserves original linked login',() => using(async c => {
  const before=snapshot(c.f);
  const name="new'operator",result=c.success(c.call({spec:{action:'create',username:name},input:c.privatePassword+'\n'}));
  assert.equal(result.username,name); assert.equal(result.role,'admin');
  const after=snapshot(c.f); assert.deepEqual(after.users.slice(0,1),before.users);
  for (const key of Object.keys(before).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],before[key]);
  assert.equal((await c.f.login('selected-alias',c.selected.password)).statusCode,200);
  const login=await c.f.login(name,c.privatePassword);
  assert.equal(login.statusCode,200); assert.equal((await c.f.account(login.payload.token)).statusCode,200);
}));
for (const controlName of ['sqliteMissing','bcryptMissing','openFailure','pragmaFailure']) {
  test(`R3 ${controlName} is private, cleaned up and recoverable`,() => using(async c => {
    const before=snapshot(c.f);
    const create=controlName==='bcryptMissing';
    const options=create ? {spec:{action:'create',username:'recovery'},input:c.privatePassword+'\n'} : {};
    const out=c.call({...options,control:{[controlName]:true}});
    c.failure(out); assert.deepEqual(snapshot(c.f),before);
    if (['openFailure','pragmaFailure'].includes(controlName)) assert.equal(out.trace.filter(row => row.event==='close').length,1);
    c.success(c.call(options));
  }));
}
test('R3 close failure with committed mutation reports no success and requires readback',() => using(async c => {
  c.failure(c.call({control:{closeFailure:true}}));
  assert.equal(c.f.users()[0].role,'admin');
  c.failure(c.call()); // Original identity version is stale; never blindly retry.
  c.success(c.call({spec:{action:'create',username:'after-close'},input:c.privatePassword+'\n'}));
  assert.equal(c.f.users().length,2);
}));
test('R3 invalid action refuses before driver access',() => using(async c => {
  const before=snapshot(c.f),out=c.call({spec:{action:'unknown'}}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
}));
test('R3 symlink spec refuses without opening a driver',() => using(async c => {
  const link=path.join(c.dir,'spec-link.json'); fs.symlinkSync(c.specPath,link);
  const before=snapshot(c.f),out=c.call({specFile:link}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
}));
````

<!-- file: scripts/fixtures/account-recovery/sqlite3.cjs -->
````javascript
'use strict';
// Test-only raw callback adapter. Never uses osi-db-helper or a shared queue.
const fs=require('node:fs');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const root=path.resolve(__dirname,'../..');
const control=JSON.parse(fs.readFileSync(path.join(root,'driver-control.json'),'utf8'));
const trace=entry => fs.appendFileSync(path.join(root,'driver-trace.jsonl'),JSON.stringify(entry)+'\n');
class Database {
  constructor(filename,mode,cb) {
    trace({event:'open',mode});
    let error;
    try {
      if (mode!==2 || !fs.statSync(filename).isFile()) throw new Error('invalid open contract');
      if (control.openFailure) throw new Error(control.privateMarker);
      this.native=new DatabaseSync(filename); // Existing file, raw private connection.
    } catch (failure) { error=failure; }
    setImmediate(() => cb(error || null));
  }
  all(sql,params,cb) {
    setImmediate(() => {
      try { cb(null,this.native.prepare(sql).all(...params)); } catch (error) { cb(error); }
    });
  }
  run(sql,params,cb) {
    if (typeof params==='function') { cb=params; params=[]; }
    setImmediate(() => {
      trace({event:'run',sql}); // SQL contains placeholders; parameter values are never recorded.
      try {
        if (control.pragmaFailure && sql==='PRAGMA foreign_keys=ON') throw new Error(control.privateMarker);
        const out=this.native.prepare(sql).run(...(params || []));
        cb.call({changes:Number(out.changes)},null);
      } catch (error) { cb(error); }
    });
  }
  close(cb) {
    let error;
    try {
      const foreignKeys=this.native ? this.native.prepare('PRAGMA foreign_keys').get().foreign_keys : null;
      if (this.native) this.native.close();
      trace({event:'close',foreignKeys});
      if (control.closeFailure) throw new Error(control.privateMarker);
    } catch (failure) { error=failure; }
    setImmediate(() => cb(error || null));
  }
}
module.exports={Database,OPEN_READWRITE:2};
````

<!-- file: scripts/fixtures/account-recovery/resolve.cjs -->
````javascript
'use strict';
// Subprocess-only resolver: never inspects host runtime module directories.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const cli=path.resolve(process.argv[1]);
const dir=path.dirname(cli);
const control=JSON.parse(fs.readFileSync(path.join(dir,'driver-control.json'),'utf8'));
const original=Module._resolveFilename;
Module._resolveFilename=function(name,parent,isMain,options) {
  if (parent && parent.filename===cli && ['sqlite3','bcryptjs'].includes(name)) {
    assert.deepEqual(options.paths,[dir,'/srv/node-red','/usr/share/node-red']);
    fs.appendFileSync(path.join(dir,'driver-trace.jsonl'),JSON.stringify({event:'resolve',name})+'\n');
    if ((name==='sqlite3' && control.sqliteMissing) || (name==='bcryptjs' && control.bcryptMissing)) throw new Error(control.privateMarker);
    return original.call(this,name,parent,isMain,{paths:[dir]});
  }
  return original.call(this,name,parent,isMain,options);
};
````

<!-- file: scripts/lib/account-recovery-transaction.js -->
````javascript
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Raw sqlite3 handle, exclusively owned by the maintenance process.
// Caller supplies the reviewed identity snapshot, never a public request.
async function recover(db, spec, passwordHash) {
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows.map(row => ({ ...row })))));
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function(error) {
      if (error) reject(error);
      else resolve(this && this.changes);
    }));
  const one = async (sql, params) => {
    assert.equal(await run(sql, params), 1, 'expected exactly one changed account');
  };
  const fields = ['id', 'user_uuid', 'username', 'auth_mode', 'role', 'disabled_at', 'sync_version'];
  const exact = 'id=? AND user_uuid=? AND username=? AND auth_mode=? AND role=? AND disabled_at IS ? AND sync_version=?';
  const now = new Date().toISOString();
  await run('BEGIN IMMEDIATE');
  try {
    const before = await all('SELECT * FROM users ORDER BY id');
    let afterRow;
    if (spec.action === 'create') {
      assert.equal(typeof spec.username, 'string');
      assert.ok(spec.username.trim() && spec.username === spec.username.trim());
      assert.match(passwordHash || '', /^\$2[aby]\$/);
      const reserved = await all('SELECT id FROM users WHERE username=? OR server_username=? LIMIT 1', [spec.username, spec.username]);
      assert.equal(reserved.length, 0, 'login name is reserved by an existing account');
      const role = spec.role === undefined ? 'admin' : spec.role;
      assert.ok(['admin','researcher','viewer'].includes(role));
      const uuid = crypto.randomUUID();
      await one('INSERT INTO users (username,password_hash,created_at,updated_at,user_uuid,auth_mode,role,disabled_at,edge_originated,sync_version) VALUES(?,?,?,?,?,\'local\',?,NULL,1,1)',
        [spec.username, passwordHash, now, now, uuid, role]);
      [afterRow] = await all('SELECT * FROM users WHERE user_uuid=?', [uuid]);
      assert.ok(afterRow && afterRow.role === role && afterRow.disabled_at === null);
      assert.equal(afterRow.password_hash, passwordHash);
      assert.equal(afterRow.auth_mode, 'local');
      assert.equal(afterRow.sync_version, 1);
      assert.equal(afterRow.edge_originated, 1);
    } else {
      assert.ok(['promote', 'restore', 'undo-backfill'].includes(spec.action), 'unknown action');
      const expected = spec.expected;
      assert.ok(expected && fields.every(field => Object.hasOwn(expected, field)), 'incomplete identity snapshot');
      assert.ok(typeof expected.username === 'string' && expected.username.trim());
      assert.ok(['local','server'].includes(expected.auth_mode));
      assert.ok(Number.isSafeInteger(expected.id) && expected.id > 0);
      assert.ok(typeof expected.user_uuid === 'string' && expected.user_uuid.trim());
      assert.ok(Number.isSafeInteger(expected.sync_version) && expected.sync_version > 0);
      const selected = before.find(row => row.id === expected.id);
      assert.ok(selected, 'selected account missing');
      for (const field of fields) assert.equal(selected[field], expected[field], `stale identity field ${field}`);
      let role = selected.role;
      let disabled = selected.disabled_at;
      if (spec.action === 'promote') {
        assert.equal(disabled, null, 'disabled accounts require investigation');
        assert.ok(['researcher', 'viewer'].includes(role));
        role = 'admin';
      } else if (spec.action === 'restore') {
        assert.equal(role, 'admin');
        assert.ok(typeof disabled === 'string' && disabled.length > 0);
        disabled = null;
      } else {
        // Only an independently reviewed, migration-created promotion.
        assert.equal(role, 'admin');
        assert.ok(['researcher', 'viewer'].includes(spec.originalRole));
        assert.ok(before.some(row => row.id !== selected.id && row.role === 'admin' && row.disabled_at === null), 'verify another enabled admin first');
        role = spec.originalRole;
      }
      await one('UPDATE users SET role=?,disabled_at=?,updated_at=?,sync_version=sync_version+1 WHERE ' + exact,
        [role, disabled, now, ...fields.map(field => expected[field])]);
      [afterRow] = await all('SELECT * FROM users WHERE id=?', [selected.id]);
      assert.deepEqual(afterRow, { ...selected, role, disabled_at: disabled, updated_at: now, sync_version: selected.sync_version + 1 });
    }
    const after = await all('SELECT * FROM users ORDER BY id');
    assert.deepEqual(after.filter(row => row.id !== afterRow.id), before.filter(row => row.id !== afterRow.id), 'unselected account changed');
    assert.equal(after.length, before.length + (spec.action === 'create' ? 1 : 0));
    await run('COMMIT');
    return Object.fromEntries(fields.map(field => [field, afterRow[field]]));
  } catch (error) {
    try { await run('ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
}
module.exports = { recover };
````

<!-- file: scripts/account-recovery.js -->
````javascript
#!/usr/bin/env node
'use strict';
// Explicit operator maintenance source; never installed or called on boot.
const fs = require('node:fs');
const { recover } = require('./lib/account-recovery-transaction');
function runtimeModule(name) {
  return require(require.resolve(name,{paths:[__dirname,'/srv/node-red','/usr/share/node-red']}));
}
async function main() {
  if (process.argv.length!==4) throw new Error('expected existing DB and private spec paths');
  const [dbPath,specPath]=process.argv.slice(2);
  if (!fs.lstatSync(dbPath).isFile()) throw new Error('database must already exist as a regular file');
  const stat=fs.lstatSync(specPath);
  if (!stat.isFile() || (stat.mode & 0o777)!==0o600 || (process.getuid && stat.uid!==process.getuid())) throw new Error('spec must be an owned regular mode-0600 file');
  const spec=JSON.parse(fs.readFileSync(specPath,'utf8'));
  if (!spec || !['create','promote','restore','undo-backfill'].includes(spec.action)) throw new Error('invalid spec action');
  let hash;
  if (spec.action==='create') {
    if (process.stdin.isTTY) throw new Error('password requires a protected descriptor');
    const password=fs.readFileSync(0,'utf8').replace(/\r?\n$/,'');
    if (password.length<6 || /[\r\n]/.test(password)) throw new Error('password must be one line of at least six characters');
    hash=runtimeModule('bcryptjs').hashSync(password,10);
  }
  const sqlite=runtimeModule('sqlite3');
  if (typeof sqlite.Database!=='function' || sqlite.OPEN_READWRITE!==2) throw new Error('raw sqlite3 driver required');
  let db, result;
  try {
    await new Promise((resolve,reject) => {
      db=new sqlite.Database(dbPath,sqlite.OPEN_READWRITE,error => error ? reject(error) : resolve());
    });
    await new Promise((resolve,reject) => db.run('PRAGMA busy_timeout=5000',error => error ? reject(error) : resolve()));
    await new Promise((resolve,reject) => db.run('PRAGMA foreign_keys=ON',error => error ? reject(error) : resolve()));
    result=await recover(db,spec,hash);
  } finally {
    if (db) await new Promise((resolve,reject) => db.close(error => error ? reject(error) : resolve()));
  }
  // Print only after close succeeds. Ambiguous failure requires private readback.
  console.log(JSON.stringify(result));
}
if (require.main===module) main().catch(() => {
  console.error('Account recovery refused or failed. Keep containment; inspect private state before retrying.');
  process.exitCode=1;
});
````

<!-- file: /tmp/issue-519-plan/auth-db-insert.js.txt -->
````javascript
return (async () => {
  const userInsert = msg.userInsert || {};
  const username = String(userInsert.username || '').trim();
  const passwordHash = String(userInsert.passwordHash || '').trim();
  const createdAt = String(userInsert.createdAt || '').trim();
  if (!username || !passwordHash || !createdAt) {
    msg.statusCode = 500;
    msg.payload = { message: 'User registration payload is incomplete' };
    return [null, msg];
  }

  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  const db = new osiDb.Database('/data/db/farming.db');
  const run = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRunDone(error) {
      if (error) { reject(error); return; }
      resolve(this && typeof this.changes === 'number' ? this.changes : null);
    });
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));

  try {
    if (scopedOn) {
      // Both modes require zero users. Disabled and linked accounts count.
      // Only this INSERT's changes proves success, including same-name races.
      const changes = await run(
        "INSERT INTO users (username, password_hash, created_at, role) " +
        "SELECT ?, ?, ?, 'admin' " +
        "WHERE NOT EXISTS (SELECT 1 FROM users)",
        [username, passwordHash, createdAt]
      );
      if (!changes) {
        msg.statusCode = 403;
        msg.payload = { message: 'Public registration is closed. Ask an administrator to create your account, or contact the gateway operator for account recovery.' };
        return [null, msg];
      }
      return [msg, null];
    }
    // Flag-off bootstrap preserves the default researcher role.
    const created = await run(
      'INSERT INTO users (username, password_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)',
      [username, passwordHash, createdAt]
    );
    if (!created) {
      msg.statusCode = 403;
      msg.payload = { message: 'Registration is closed: this gateway already has an account. Sign in with an existing account.' };
      return [null, msg];
    }
    return [msg, null];
  } catch (error) {
    msg.statusCode = 500;
    msg.payload = { message: 'Unable to create local user', detail: String(error.message || error) };
    return [null, msg];
  } finally {
    try { await close(); } catch (e) { node.warn('auth-db-insert close failed: ' + (e && e.message ? e.message : e)); }
  }
})();
````

<!-- file: /tmp/issue-519-plan/apply-flow.cjs -->
````javascript
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const paths = ['bcm2712','bcm2709'].map(profile => `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
const originals = paths.map(file => fs.readFileSync(file,'utf8'));
for (const raw of originals) assert.equal(JSON.stringify(JSON.parse(raw),null,2)+'\n', raw, 'roundtrip drift');
assert.equal(originals[0], originals[1], 'profile drift');
const flows = JSON.parse(originals[0]);
const node = flows.find(n => n.id === 'auth-db-insert');
assert.ok(node && node.func.includes("WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')"));
assert.equal(node.func.length,2812,'base node changed: stop for plan review');
const replacement = fs.readFileSync('/tmp/issue-519-plan/auth-db-insert.js.txt','utf8').replace(/\n$/,'');
assert.equal(replacement.length,2428);
node.func = replacement;
const beforeTotal = JSON.parse(originals[0]).reduce((sum,n) => sum+(n.type==='function' ? n.func.length : 0),0);
const afterTotal = flows.reduce((sum,n) => sum+(n.type==='function' ? n.func.length : 0),0);
assert.equal(beforeTotal,1633361); assert.equal(afterTotal,1632977);
const serialized = JSON.stringify(flows,null,2)+'\n';
for (const file of paths) fs.writeFileSync(file,serialized);
const allowancePath = 'scripts/verify-flows-size-ratchet-allowances.json';
const allowance = JSON.parse(fs.readFileSync(allowancePath,'utf8'));
assert.equal(allowance.node_allowances['auth-db-insert'].delta,531);
delete allowance.node_allowances['auth-db-insert'];
// No total allowance, baseline or other node entry changes.
fs.writeFileSync(allowancePath,JSON.stringify(allowance,null,2)+'\n');
console.log('Both profiles: auth-db-insert 2812 -> 2428; total 1633361 -> 1632977; consumed +531 node allowance removed.');
````

<!-- file: /tmp/issue-519-plan/update-existing.cjs -->
````javascript
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
function edit(file, old, replacement, count = 1) {
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(old).length - 1, count, file + ': source drift');
  fs.writeFileSync(file, source.split(old).join(replacement));
}
const oldMessage = 'Public registration is closed. Ask an admin to create your account.';
const newMessage = 'Public registration is closed. Ask an administrator to create your account, or contact the gateway operator for account recovery.';
edit('scripts/test-auth-credential-isolation.js', oldMessage, newMessage, 2);
edit('scripts/test-auth-credential-isolation.js',
  'flag off, it is open while the users table is empty; flag on keeps its admin rule.',
  'both modes require zero users; scoped bootstrap retains the explicit admin role.');
const rehearsal = 'scripts/rehearse-scoped-access-migration.test.js';
const source = fs.readFileSync(rehearsal, 'utf8');
const start = source.indexOf("test('conditional bootstrap insert creates exactly one admin'");
assert.ok(start > 0 && source.slice(start).trimEnd().endsWith('});'));
fs.writeFileSync(rehearsal, source.slice(0,start) + `test('conditional zero-user bootstrap creates one admin and refuses every existing account', () => {
  const db = freshDb();
  const insert = db.prepare("INSERT INTO users (username,password_hash,created_at,role) SELECT ?,?,?,'admin' WHERE NOT EXISTS (SELECT 1 FROM users)");
  assert.equal(insert.run('first','h','2026-01-01').changes, 1);
  assert.equal(insert.run('second','h','2026-01-01').changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n, 1);
  db.exec("UPDATE users SET disabled_at='2026-01-02',sync_version=sync_version+1 WHERE role='admin'");
  assert.equal(insert.run('third','h','2026-01-01').changes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  db.close();
  const existing = freshDb();
  existing.prepare('INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)').run('researcher','h','2026-01-01');
  const closedInsert = existing.prepare("INSERT INTO users (username,password_hash,created_at,role) SELECT ?,?,?,'admin' WHERE NOT EXISTS (SELECT 1 FROM users)");
  assert.equal(closedInsert.run('public','h','2026-01-01').changes, 0);
  assert.equal(existing.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  assert.equal(existing.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n, 0);
  existing.close();
});
`);
edit('.github/workflows/migrations.yml',
  '      - run: node --test scripts/rehearse-scoped-access-migration.test.js',
  '      - run: node --test scripts/rehearse-scoped-access-migration.test.js\n' +
  '      - name: Zero-user bootstrap, guarded recovery and CLI contract\n' +
  '        run: node --test scripts/test-auth-bootstrap-policy.js scripts/test-account-recovery.js scripts/test-account-recovery-cli.js');
const adr = 'docs/adr/2026-07-19-scoped-multiuser-access-model.md';
edit(adr,
  'Bootstrap is a registration-time rule: the first registration on a scoped hub with zero admins becomes admin in one transaction, after which public registration closes and account creation is admin-only. Deploy-time backfill covers only the in-place upgrade path.',
  'Public bootstrap requires zero users in both modes, enforced by one conditional INSERT. Scoped bootstrap retains its explicit admin role; flag-off bootstrap retains the default researcher role. Every account counts, including disabled and linked users. Existing no-admin installations remain closed until a trusted operator selects and prepares an administrator using the account-recovery runbook. No flag flip, startup hook or new migration promotes an account. Historical one-time backfill 0045 remains unchanged and requires supervised account review when pending.');
edit(adr,
  'Grants are edge-admin-originated in v1.',
  'The edge applies account/grant mutations authoritatively. The shipped protected pending-command path also supports scoped-user/grant commands; its existence is not an emergency recovery entitlement.');
edit(adr,
  '- Scoped mode is a one-way door for a hub once accounts and grants accumulate; migrating a live hub in or out is an operator runbook step, not an automatic transition.',
  '- Scoped mode is a one-way door for a hub once accounts and grants accumulate; migrating a live hub in or out is an operator runbook step, not an automatic transition. See [local account recovery](../operations/account-recovery-runbook.md) for selected-account promotion, named local recovery administrators and containment across automatic restarts. An empty table is first-run eligibility, not ownership proof; commissioning requires a trusted network. Privileged deletion of every account or restoration of an empty database can reopen eligibility and is prohibited recovery.\n' +
  '- A pending 0045 backfill still selects the lowest enabled id when no admin row exists. Supervised enablement must verify that identity or correct only the proven migration-created promotion under containment. Preventing all unattended implicit promotions needs a separate migration/deploy design. Password reset and re-enablement do not revoke issued sessions; linked-password reset is not supplied by the local password-hash endpoint.');
edit(adr,
  'cloud-side grant administration becomes a requirement (adds the command path); ',
  'cloud-side grant policy needs a new authority model beyond the shipped protected command path; ');
console.log('Updated credential messages, copied bootstrap rehearsal, CI and ADR.');
````

<!-- file: /tmp/issue-519-plan/scan.cjs -->
````javascript
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { scanFunctionNodes } = require(process.cwd() + '/scripts/flows-bare-require-scan');
assert.equal(scanFunctionNodes([{ type:'function', id:'negative-control', func:"require('not-a-builtin')" }]).length,1);
const raws = ['bcm2712','bcm2709'].map(profile => fs.readFileSync(`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`,'utf8'));
assert.equal(raws[0],raws[1]);
for (const raw of raws) {
  const flows = JSON.parse(raw);
  assert.ok(flows.length > 0);
  assert.equal(JSON.stringify(flows,null,2)+'\n',raw);
  assert.equal(scanFunctionNodes(flows).length,0);
}
if (process.argv[2] === 'candidate') {
  const files = ['scripts/lib/bootstrap-auth-harness.js','scripts/test-auth-bootstrap-policy.js',
    'scripts/lib/account-recovery-transaction.js','scripts/account-recovery.js',
    'scripts/test-account-recovery.js','scripts/test-account-recovery-cli.js',
    'scripts/fixtures/account-recovery/sqlite3.cjs','scripts/fixtures/account-recovery/resolve.cjs'];
  for (const file of files) new vm.Script(fs.readFileSync(file,'utf8'),{ filename:file });
  assert.equal(JSON.parse(raws[0]).find(n => n.id === 'auth-db-insert').func.length,2428);
  const allowances = JSON.parse(fs.readFileSync('scripts/verify-flows-size-ratchet-allowances.json','utf8'));
  assert.equal(Object.hasOwn(allowances.node_allowances,'auth-db-insert'),false);
  console.log('syntax: OK (8 files)');
}
console.log('bare-require and roundtrip: OK (2 profiles; negative control rejected)');
````

<!-- file: /tmp/issue-519-plan/gates.py -->
````python
#!/usr/bin/env python3
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys

phase = sys.argv[1]
assert phase in ('base', 'candidate')
root = Path.cwd()
head = subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
plan_hash = hashlib.sha256(Path('docs/superpowers/plans/2026-10-25-issue-519-bootstrap.md').read_bytes()).hexdigest()
base = '63c7a70f8f3b373f162b33b0669b0df89b3763fa'
wrapper = '/home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py'
evidence = Path('/tmp/issue-519-evidence') / phase
evidence.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, OSI_FLOWS_SIZE_BASE_REF=base, OSI_DDL_BASE_REF=base,
           OSI_MIGRATIONS_BASE_REF=base, OSI_IDENTITY_BASE_REF=base)
commands = [
    ('auth-existing', ['node','--test','scripts/test-auth-credential-isolation.js','scripts/rehearse-scoped-access-migration.test.js'], [], 18),
    ('scoped-writes', ['node','--test','scripts/test-scoped-access-writes.js'], [], None),
    ('scoped-reads', ['node','--test','scripts/test-scoped-access-reads.js'], [], None),
    ('scoped-command', ['node','--test','scripts/test-scoped-access-command-path.js'], [], None),
    ('scoped-static', ['node','scripts/verify-scoped-access.js'], ['OK'], 0),
    ('auth-hermetic', ['node','scripts/verify-auth-flag-off-hermetic.js'], ['verify-auth-flag-off-hermetic: OK'], 0),
    ('parse', ['node','scripts/verify-flows-fn-parse.js'], ['verify-flows-fn-parse: OK'], 0),
    ('wiring', ['node','scripts/test-flows-wiring.js'], ['PASS: STREGA wiring'], 0),
    ('arity', ['node','scripts/verify-flows-output-arity.js'], ['verify-flows-output-arity: OK'], 0),
    ('silent-catch', ['node','scripts/verify-no-new-silent-catch.js'], ['verify-no-new-silent-catch: OK'], 0),
    ('bare-require', ['node','/tmp/issue-519-plan/scan.cjs',phase], ['bare-require and roundtrip: OK'], 0),
    ('size', ['node','scripts/verify-flows-size-ratchet.js'], ['verify-flows-size-ratchet: OK'], 0),
    ('sync', ['node','scripts/verify-sync-flow.js'], ['Sync flow verification passed','All parity checks passed.'], 0),
]
if phase == 'candidate':
    commands.insert(1, ('bootstrap', ['node','--test','scripts/test-auth-bootstrap-policy.js'], [], 67))
    commands.insert(2, ('recovery', ['node','--test','scripts/test-account-recovery.js'], [], 26))
    commands.insert(3, ('recovery-cli', ['node','--test','scripts/test-account-recovery-cli.js'], [], 16))
    commands.append(('writing', ['node','.claude/skills/anti-slop-writing/slop-check.js',
        'docs/operations/account-recovery-runbook.md','docs/adr/2026-07-19-scoped-multiuser-access-model.md',
        'docs/superpowers/plans/2026-10-25-issue-519-bootstrap.md'], ['slop-check: PASS'], 0))
    commands.append(('doc-hygiene', ['node','scripts/verify-doc-hygiene.js'], ['verify-doc-hygiene: OK'], 0))
records = []
for name, args, signals, expected in commands:
    log = evidence / (name + '.log')
    with log.open('w') as output:
        completed = subprocess.run(['python3',wrapper,*args], cwd=root, env=env,
                                   stdout=output, stderr=subprocess.STDOUT)
    text = log.read_text()
    record = dict(command=args, cwd=str(root), base=base, head=head, plan_sha256=plan_hash, exit=completed.returncode, log=str(log))
    records.append(record)
    (evidence / 'commands.json').write_text(json.dumps(records, indent=2) + '\n')
    assert completed.returncode == 0, f'{name}: exit {completed.returncode}; stop and read {log}'
    for signal in signals:
        assert signal in text, f'{name}: missing execution evidence {signal!r}'
    if expected != 0:
        count = re.search(r'^# tests (\d+)$', text, re.M)
        assert count and int(count[1]) > 0, f'{name}: no tests executed'
        if expected is not None:
            assert int(count[1]) == expected, f'{name}: wrong test count'
        assert '# fail 0' in text and '# cancelled 0' in text and '# skipped 0' in text
        record['tests'] = int(count[1])
    print(f'{name}: PASS ({log})', flush=True)
(evidence / 'commands.json').write_text(json.dumps(records, indent=2) + '\n')
print('issue-519 ' + phase + ' gates complete', flush=True)
````

<!-- file: docs/operations/account-recovery-runbook.md -->
````markdown
# Local accounts, scoped enablement and recovery

Public registration creates an account only while `users` is empty. With scoped access on, that first account is an admin; with it off, the default role is researcher. Every existing account closes public registration, including disabled or linked accounts and rows with incomplete identity metadata. A missing admin never reopens it.

First setup requires a trusted commissioning network. Emptiness does not prove ownership. Never delete accounts, empty the table, restore an empty database or replace `/data/db/farming.db` to recover access.

## Use an available administrator

If only the browser session was lost, sign in again as the existing enabled administrator. With scoped access enabled, use Users administration or its authenticated API to create further accounts, promote a verified account, or restore an individually verified account whose disable reason has been resolved. These routes preserve the last enabled administrator.

`POST /api/users/:uuid/password-reset` is suitable only for a local account. It updates `password_hash`; linked authentication reads separate server verifier/hash fields. A 200 response for a linked account does not establish a working new linked credential; the endpoint defect is tracked in [#521](https://github.com/Open-Smart-Irrigation/osi-os/issues/521). Keep the linked account's auth mode and verifier intact. Recover that credential through the established identity-specific cloud process under separate authority; gateway administration can use a named local recovery admin. Relinking and identity changes are outside this procedure.

## Session compromise

Password reset, Node-RED restart and disable/reset/re-enable do not revoke an issued bearer token. In scoped mode disabling blocks the account's freshly checked admin route, but re-enabling permits the same unexpired token again. Tokens normally expire seven days after issuance. Flag-off endpoints and cached guards have different enforcement; this is not proof that disabling revokes every token consumer.

For suspected compromise keep the affected account disabled, retain network containment, and recover administration with a different verified account. Do not re-enable it as a revocation step. Session revocation is tracked in [#520](https://github.com/Open-Smart-Irrigation/osi-os/issues/520) and requires a separate change across token consumers. This procedure does not prescribe signing-key rotation.

## Prepare an existing gateway for scoped access

This is a trusted operator maintenance procedure, not an application bootstrap bypass. It causes telemetry and scheduling downtime. Run it only in a separately authorized maintenance window after rehearsing on a disposable copy and qualifying the deployed sqlite3 driver on an isolated test gateway.

1. The gateway owner or delegated operator selects the intended administrator through operational records and a trusted communication channel. Record the reason, account identity and credential custodian privately. Neither the lowest id, a matching cloud name, a researcher token nor the first login proves authority. If the identity cannot be established, retain the closed state.
2. Restrict untrusted access to the entire product listener, every proxy and alternate network path before any flag change, upgrade or privilege repair. The restriction must survive service restarts, payload rollback and supervisor activity. Stop Node-RED and account for identityd/bootstrap restart requests. Account for pending cloud scoped-user commands; the flag does not pause their application. Do not depend on a cloud recovery bypass.
3. Take and verify the WAL-consistent database and runtime/configuration backups required by the [live-operations skill](../../.claude/skills/osi-live-ops-runbook/SKILL.md). Use a private timestamped directory under `/data/db/backups/`. Do not copy live WAL/SHM files separately. Verify backup integrity and retain the active flow, settings, credential file and GUI contents privately. No backup is authorization to replace a provisioned database.
4. Inspect migration status and all admin rows. If 0045 is already applied, never rerun it. If it is pending, preserve the pre-upgrade account identities, roles and versions privately before the existing migration chain runs. Historical 0045 promotes the lowest enabled id only if no admin row exists, including linked identities; a disabled admin blocks it, and all-disabled non-admins leave no admin. This is a historical data backfill, not verified ownership. Leave its SQL/checksum unchanged.
5. Finish a required upgrade under containment. Deployment may start the paired payload automatically after migrations; failure or rollback may restart a retained payload. Do not depend on a pause between migration and service start. Stop the service again, inspect the actually active payload and post-upgrade accounts, then apply only the selected repair below. If an unintended admin was created by 0045, establish the intended enabled admin first and undo only that proven migration-created promotion using its recorded original role. Never demote pre-existing legitimate admins. If this cannot be verified, defer scoped enablement.

The procedure prevents public takeover during supervised enablement. It does not guarantee that an unattended upgrade never performs 0045's historical promotion. A stronger guarantee needs a separate migration/deployment design. Previously created attacker accounts require incident review; this fix does not remove them.

## Guarded operator repair

Use the reviewed `scripts/account-recovery.js` and adjacent `scripts/lib/account-recovery-transaction.js` from the fixed revision. They are maintenance source files, not a boot hook, public endpoint or automatically installed service. Stage both files together privately on the authorized gateway. The tool requires an existing regular database file and an operator-owned regular mode-0600 spec; symlinks are refused. A missing database is refused before loading a driver, so the tool cannot create that database or its sidecars. It resolves raw `sqlite3` and `bcryptjs` from the script directory, then `/srv/node-red` and `/usr/share/node-red`. It uses a private raw connection with `OPEN_READWRITE`, never the shared queued facade. It adds no dependency or configuration flag.

Inspect only non-secret selection fields while the service is stopped:

```sh
sqlite3 -readonly /data/db/farming.db 'SELECT id,user_uuid,username,server_username,auth_mode,role,disabled_at,sync_version FROM users ORDER BY id;'
sqlite3 -readonly /data/db/farming.db 'SELECT version,name,status FROM schema_migrations ORDER BY version;'
```

Create a mode-0600 JSON specification in the private maintenance directory. Copy the selected row's exact values, preserving JSON null for an enabled account. The shape below is an example for a synthetic account; the operator must use the independently verified row and record, rather than infer values:

```json
{
  "action": "promote",
  "expected": {
    "id": 1,
    "user_uuid": "123e4567-e89b-42d3-a456-426614174000",
    "username": "verified-operator",
    "auth_mode": "local",
    "role": "researcher",
    "disabled_at": null,
    "sync_version": 1
  }
}
```

`promote` accepts an enabled researcher/viewer with usable, trusted credentials and sessions. It changes only role, timestamp and version. Existing tokens for that identity gain the new role too. Missing UUIDs or nonpositive/unknown versions require separate identity repair; the tool refuses them.

`restore` uses the same complete expected identity with `role` admin and the exact existing `disabled_at` string. Use it only after resolving the reason that one account was disabled and verifying credential/session safety. It clears that disabled timestamp, updates the mutation timestamp and increments the version. It never restores all disabled accounts.

`undo-backfill` uses the current complete expected identity and an additional `originalRole` of researcher or viewer from the pre-upgrade record. Use it only for a proven, unintended 0045 promotion. It refuses unless another enabled admin exists. This is a deliberately selected account mutation, never broad demotion SQL.

Run the chosen specification from the directory holding the two reviewed scripts:

```sh
node scripts/account-recovery.js /data/db/farming.db /root/osi-account-maintenance/spec.json </dev/null
```

The raw sqlite3 transaction uses `BEGIN IMMEDIATE`, bound identity/version predicates, exactly-one-row assertions and full readback. Any mismatch rolls back. It preserves other accounts, credentials, cloud associations, ownership and grants. Timestamp/version changes use normal USER triggers: with `scoped_access_emit.enabled=1` the role/enabled-state event carries the incremented version; with the shipped gate off the mutation stays local. Do not change the emit gate during recovery or claim every repair automatically syncs. Password-hash-only updates are not covered by the role trigger's column list.

### Create a named local recovery administrator

Choose this path when no usable admin credential remains or restoration cannot establish safe sessions. Keep public registration closed. Select a new login name and a designated credential custodian. The name must be unused in both `username` and `server_username`, including disabled accounts; the tool checks both inside its write transaction. A linked alias is reserved even when its row has a different local username. Quote-bearing names are bound as data; never interpolate them into SQL. The spec is `{"action":"create","username":"recovery-operator"}` with a locally chosen, individually managed name. The tool generates a new UUID and inserts a local enabled admin with `edge_originated=1`, `sync_version=1` and a fresh bcrypt credential. It preserves every existing account.

Create a private password file using a terminal with echo disabled. Do not put the password in arguments, shell history, logs or reports:

```sh
umask 077
mkdir -p /root/osi-account-maintenance
saved_tty=$(stty -g) || exit 1
trap 'stty "$saved_tty"' EXIT HUP INT TERM
stty -echo
IFS= read -r recovery_password
stty "$saved_tty"
trap - EXIT HUP INT TERM
printf '%s\n' "$recovery_password" > /root/osi-account-maintenance/password
unset recovery_password
node scripts/account-recovery.js /data/db/farming.db /root/osi-account-maintenance/spec.json < /root/osi-account-maintenance/password
recovery_status=$?
rm -f /root/osi-account-maintenance/password
[ "$recovery_status" -eq 0 ] || exit "$recovery_status"
```

On success the CLI exits 0 and prints only id, user_uuid, username, auth_mode, role, disabled_at and sync_version as one JSON object after closing the connection. It prints no password, hash, linked alias or cloud fields. On refusal/failure it exits 1, prints no success object and emits a fixed generic error. A close failure can follow a committed transaction, so a failure status never licenses a blind retry. Retain the specification and non-secret result privately. On failure or interrupted output, inspect committed state before retrying; never blindly repeat promotion/version increments or create another recovery account. Keep the new admin as an explicitly managed account, or disable it through the authenticated API after verifying another enabled administrator. Do not delete it or transfer resource ownership to it. Record the credential custodian and account disposition.

## Resume and verify under containment

For scoped operation use the existing durable setting, then start the fixed payload under containment:

```sh
uci set osi-server.cloud.scoped_access_enabled=1
uci commit osi-server
/etc/init.d/node-red start
```

Verify the running process has effective `OSI_SCOPED_ACCESS=1` using a targeted environment-key inspection that does not print other keys. Verify the active `auth-db-insert` has `WHERE NOT EXISTS (SELECT 1 FROM users)` in both branches. Using the product UI or a private API client, sign in with the selected credential and confirm `GET /api/users` succeeds. Make a valid unauthenticated registration attempt with a new synthetic username: require 403, no token/success and unchanged account count. Confirm selected role/enabled state, original account preservation, resource ownership, history and normal telemetry/scheduling service before removing containment. Keep failures contained; switching scoped access off is not a rollback for an established multi-user hub.

With scoped access off, public registration still permits only the first account and Users administration is unavailable. Use the same guarded insertion and private-password steps above with a specification such as `{"action":"create","username":"additional-local","role":"researcher"}` to add another local researcher while retaining flag-off operation. Its login sees only its owned zones and devices; this does not recover another account or confer ownership. The former interpolated SQL/hash-shell recipe is retired. Do not use a recovery admin as an ownership-transfer shortcut.
````
