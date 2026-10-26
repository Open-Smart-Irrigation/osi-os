# Issue 183 PR 527: exact reconciliation from main

This plan repairs the already integrated draft PR #527 at `6f61dd2a25142b67006d793bf80e4f8494316ce0`. Its parent merge `326dfd39` incorporated fetched main `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f`; the PR then added `9eb2a2ed` and `6f61dd2a`. Do not replay or discard those commits. Implement in a clean isolated checkout of the PR head only after a fresh independent review of this plan and a new ref check. This planning branch contains this document alone. No product edit, test, build, push, CI run, deploy or live operation occurred in this round.

## Binding and observed conflict

| Ref or artifact | Full binding and finding |
|---|---|
| Fetched `origin/main` and PR base | `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f` |
| Fetched `refs/pull/527/head` | `6f61dd2a25142b67006d793bf80e4f8494316ce0`, open draft at the read |
| PR merge base with main | `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f` |
| Last independently root-qualified old candidate | `f7d37a14d45f0163e8bb3ab191562d8863919a1b`; Linux run `40281824266` approves G1/B3 there only |
| Fixed B3 source | `63c7a70f8f3b373f162b33b0669b0df89b3763fa`, SHA-256 `5f521479463c2ebc2aaf17e4a6ee5ec0a0235a93a6146914f6da626b8c92074d` |

I fetched the refs in the isolated planning worktree, then reset that clean branch from stale `c37207b30b002fb79da8ae57253d78c04613b6a5` to the fetched main SHA. A separate disposable worktree at `f7d37a14` ran `git merge --no-commit --no-ff origin/main`. Git reported one content conflict, in `scripts/test-chirpstack-bootstrap-clover.js` at `makeWorld`: the #183 side added `fsEvents`, while main added `stdoutLogs`, `stderrLogs`, CLI output/error and options fields. The bootstrap copies and workflow auto-merged. I read the conflict, aborted the merge and removed the disposable worktree. The PR's `326dfd39` resolution retains both sides' fields; it does not implement the later R1–R4 parser and direct-child decisions. There is no unresolved merge in this planning checkout or in the fetched PR tree.

The current PR retains byte-identical bootstrap copies (Git blob `1529ff06975b32407b71e2afc483aa628f4f422a`), byte-identical helper source copies (`402aa9312e4cd78ec023b317e1677e1a652d51bd`) and helper tests (`3edb733b0d94c85c2333edcf02908030c177c289`). Those are source observations, not executed parity gates. The main helper's fixed gRPC metadata error and its tests survive the merge. `deploy.sh` still has early, post-Gen2 and final secure calls and six explicit canonical `ENV_FILE` bindings. The workflow retains full-history checkout, the reference-tree step, sync verifier, Clover suite, G1, literal-base B3 extraction, direct `PIPESTATUS[0]`, ordered B3 assertions, `.tap`/`.status` artifacts and the new G1 TAP artifact. It lacks a named direct helper-metadata test step.

The merged `createApiKeyViaCLI` currently calls `.toString()` inside the `execSync` catch, reads `error.status` repeatedly, and calls `.match` without a primitive-string guard. Its Clover fake calls `Buffer.from(cliApiKeyOutput)` before returning. T7 still uses a synchronous deploy-fragment runner with a pre-created API key; its status-1 warning does not prove a direct CLI child exit. These are the remaining repair targets. The added `9eb2a2ed` link-count/staging diagnostics and `6f61dd2a` G1 artifact retention remain in scope for preservation and fresh review, not rollback.

## Invariants and stop points

The #183 publisher must still narrow an existing regular env file to root:root `0600` by descriptor before reading its bytes or reaching key/API work. Keep the private `0600` atomic staging, create-only collision and unsafe-entry refusal, raw Buffer backup, lossless UTF-8 guard for text mutation, and safe credential status 74 through late cleanup failures. Usage failures remain 2; CLI and other unrelated failures remain 1. Do not treat metadata narrowing as env-content publication. A completed API/UCI side effect cannot turn a later credential filesystem failure into status 1.

Keep the six deploy bindings, early/post-Gen2/final checks, private `.pre-gen2` create-only backup, status-1 warning versus fatal 74/2 behavior, and migration/payload/restart stop points. Retain the consumer path, line format and UCI-over-env precedence. Do not touch `flows.json`, schema, Node-RED service identity, key/profile lifecycle, #181 or the full #522 qualification. An older ROM bootstrap may still be selected on an existing device; this change does not replace that ROM copy on deploy.

If a new fetch changes main or PR head, stop and regenerate the SHA binding, historical-conflict map and affected-code review before implementation. If the prospective focused tests pass unchanged, inspect the oracle before editing product code. If a current-base gate is red, stop that surface and report it for separate baseline repair. If the wrapper refuses a command because of admission, lock or registration, record the refusal and defer that check; do not retry in a busy loop, clear registration or modify host policy.

## Exact editor sequence after independent plan review

Use a new clean isolated implementation worktree at the freshly fetched PR head. Verify its `HEAD`, clean status and `merge-base` against both fresh refs. Do not use the project root checkout or the historical candidate worktree. Preserve `326dfd39`, `9eb2a2ed` and `6f61dd2a` in history. Make these commits in order; run only one wrapped command at a time and let #397's executable verifier finish before starting any build or test.

### Commit 1: failing focused and root oracles

Edit only `scripts/test-chirpstack-bootstrap-clover.js` and `scripts/test-chirpstack-env-file.js`, with message `test: pin issue 183 merged CLI and root-child behavior`.

In `makeWorld`, retain every current field, including `fsEvents`, both output arrays and link-publication fixtures. Add `cliApiKeyOutcomes: []`. Replace the CLI branch of `makeChildProcess` with this branch; leave UCI handling intact:

```js
if (/create-api-key/.test(command)) {
  world.cliApiKeyCalls += 1;
  world.cliExecOptions.push({ command, options });
  if (world.cliApiKeyError) {
    world.cliApiKeyOutcomes.push('threw');
    throw world.cliApiKeyError;
  }
  world.cliApiKeyOutcomes.push('returned');
  return world.cliApiKeyOutput;
}
```

The configured output must reach product conversion unchanged. Current default output is a primitive string, so existing success cases still exercise `.toString()`. Set both `CHIRPSTACK_API_KEY` and `CS_API_KEY` to `''` in every CLI-reach case. Add one shared assertion for a failed CLI case: exit 1, exactly one recorded command with `{ stdio: ['ignore', 'pipe', 'pipe'] }`, no client key, no env-content write, no `uci set`/`commit`, and each synthetic marker absent from **each** captured stream. The exact command is `chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered`; it contains no shell `2>&1`.

Add table cases for own data-property status `1` and `255` (fixed `command error, exit status N`); own `0`, `-1`, `256`, fractional, string, `null`, absent and inherited status (fixed `command error` without status); an own getter whose return changes or throws (zero getter calls); and a Proxy whose `getOwnPropertyDescriptor` trap throws (fixed generic command error). The status matrix must trace `['threw']`, never a fake return. Put distinct synthetic markers in `message`, `stdout`, `stderr`, `cmd`, `stack` and `output`; none may appear on either stream. Assert the final status is 1, not 74 or 2. Avoid printing the hostile object in an assertion message.

Add three uncoerced fake-return cases, each tracing `['returned']`: `toString()` throws; `toString()` returns a nonstring object; and `toString()` returns an object with a forged `match()` that would yield a capture whose `trim()` returns a forged token object. In the last case, count `match()` calls and require zero. Every case must yield only `CLI create-api-key failed (invalid output)`, exit 1 and the shared no-effect/no-marker assertions. Do not add ordinary string `match()` or `trim()` throw cases: the required primitive guard makes those unreachable under normal intrinsics.

For first-match selection, use the literal output `token:SYNTHETIC_BAD\tKEY_183\ntoken:good-key\n`. The test setup must first assert `output.match(/^token:\s*(.+)$/m)[1] === 'SYNTHETIC_BAD\tKEY_183'`; the product then rejects it with fixed invalid-output text and no effect, despite the later valid line. A separate `token:first-key\ntoken:second-key\n` case must pass `first-key` to `createClient`. Do not use a bare `token:` as the negative case: `\s*` can consume a newline. Keep main's ANSI, tab, non-ASCII, pre-created-key and successful-client cases.

In T7, change `test('T7 deploy routing', () => {` to an async callback. Keep every existing deploy-fragment assertion and its `runFragments` helper. Change the CLI branch in `childProcess(events, options)` to accept its `execSync` options and the opt-in fault below. Ordinary calls retain their successful token return. Its trace is written by the existing preload's process-exit hook. Do not turn a deploy shell warning into a child-exit assertion.

```js
execSync(command, execOptions) {
  if (/create-api-key/.test(command)) {
    events.push(['api-key', command, execOptions]);
    if (process.env.ISSUE183_CLI_THROW === '1') {
      events.push(['api-key-throw']);
      const error = new Error('SYNTHETIC_CLI_MESSAGE_183');
      error.status = 23;
      error.stdout = Buffer.from('token:SYNTHETIC_CLI_STDOUT_183\n');
      error.stderr = Buffer.from('SYNTHETIC_CLI_STDERR_183');
      error.cmd = 'SYNTHETIC_CLI_CMD_183';
      error.output = ['SYNTHETIC_CLI_OUTPUT_183'];
      throw error;
    }
    return Buffer.from('id: synthetic\ntoken: ' + API_KEY + '\n');
  }
  throw new Error('unexpected synthetic execSync');
},
```

In `publisherPreloadSource`'s product-FS Proxy, record `note('preflight-chmod')` immediately after the successful `fchmodSync` of the canonical target and `note('preflight-read')` immediately after the canonical descriptor `readFileSync`; leave existing fault branches and FS confinement intact. This instrumentation is specific to the direct case's event-order oracle. Record `note('env-content-publish')` after a successful rename/link to the canonical target and keep existing UCI-write and client events. A post-CLI event filter then has positive event types to reject, rather than relying on an empty generic trace.

After the existing T7 fragment matrix, add a separate direct full-bootstrap case using `cp.spawn(process.execPath, [sourceCopy], ...)` under actual root. Set up a fresh fixture with an existing root-owned `0644` canonical file containing `OPERATOR=keep\n` and no key; copy `SOURCE` into that fixture; install `publisherPreloadSource` with its `SOURCE_PATH` equal to the copied source. Pass `ENV_FILE` for that canonical path, `CHIRPSTACK_API_KEY=''`, `CS_API_KEY=''`, `ISSUE183_CLI_THROW='1'`, `NODE_OPTIONS='--require ' + preload`, `ISSUE183_TRACE`, fixture codec/settings/flows paths and the same UCI fixture inputs as `runFragments`. Use `stdio: ['ignore', 'pipe', 'pipe']`. Assert `process.geteuid() === 0` in T7 before this case, and actual `statSync` uid/gid 0/0, mode `0644`, link count 1 and exact bytes before spawn.

Attach `error` and `close` listeners immediately after `spawn`. Capture stdout/stderr separately with a bounded byte count. The close wait has this exact structure; install the stream listeners in the same synchronous block before the first `await`:

```js
let spawnError = null;
let outputTooLarge = false;
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
const child = cp.spawn(process.execPath, [sourceCopy], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const closed = new Promise(resolve => {
  child.once('error', error => { spawnError = error; });
  child.once('close', (code, signal) => resolve({ code, signal }));
});
for (const [stream, set] of [[child.stdout, value => { stdout = value; }], [child.stderr, value => { stderr = value; }]]) {
  stream.on('data', chunk => {
    const prior = stream === child.stdout ? stdout : stderr;
    const next = Buffer.concat([prior, chunk]);
    if (next.length > 2 * 1024 * 1024) { outputTooLarge = true; child.kill('SIGTERM'); }
    else set(next);
  });
}
const awaitClose = async ms => {
  let timer;
  try {
    return await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { clearTimeout(timer); }
};
let outcome = await awaitClose(5000);
let timedOut = false;
if (!outcome) {
  timedOut = true;
  child.kill('SIGTERM');
  outcome = await awaitClose(1000);
  if (!outcome) { child.kill('SIGKILL'); outcome = await awaitClose(2000); }
}
assert.ok(outcome, 'direct CLI child closed and was reaped');
assert.equal(timedOut, false, 'direct CLI child met the deadline');
assert.equal(spawnError, null, 'direct CLI child spawned');
assert.equal(outputTooLarge, false, 'direct CLI child output remained bounded');
assert.equal(outcome.signal, null, 'direct CLI child was not signalled');
assert.equal(outcome.code, 1, 'direct CLI failure exits 1');
```

After completed close, assert canonical bytes unchanged and root:root `0600` link count 1. Read the completed trace; require one exact command/options record and one throw record, both `preflight-chmod` and `preflight-read` before the CLI event, and zero client, `env-content-publish` or UCI-write events after it. Check the fixed `command error, exit status 23` on stderr and each hostile marker absent from stdout and stderr. The separate `runFragments` status-1 branch continues to assert warning/continuation (shell exit 0). Retain T7's status-74 and usage-2 abort cases and the exact T0–T10 G1 TAP names. Wrap the new fixture in `try/finally`; remove it only after the child closes or the terminate/escalate path has run. A still-open child is an explicit test failure, not a successful cleanup claim.

The direct child's close/reap helper must be local to T7; it must not alter `cli()` or the outer `sudo -n` re-entry. The fixture's existing guarded product-FS proxy is the confinement boundary. Do not create a new service or touch real `/srv/node-red` files. The new direct case qualifies one CLI failure path; it does not turn T7 into the separate ten-case #522 full-source suite.

Run the prospective focused Clover test through the wrapper and record its direct nonzero exit with failures on status getter and malformed-return cases. Root T7 may be unavailable locally because `sudo -n` is unavailable; mark it pending, without a skip or virtual-owner substitution. Do not commit a root success claim.

### Commit 2: narrow bootstrap parser and command error

Edit `scripts/chirpstack-bootstrap.js` as the canonical source, then copy its complete bytes to both `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js` and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js`. Message: `fix: contain CLI key errors after credential preflight`. Preserve all #183 publisher code and `9eb2a2ed` diagnostics. Immediately before `createApiKeyViaCLI`, add:

```js
function cliExitStatus(error) {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'status');
  } catch (_) {
    return null;
  }
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  const value = descriptor.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 255 ? value : null;
}
```

Replace only `createApiKeyViaCLI` with this complete body:

```js
async function createApiKeyViaCLI() {
  console.log('  + Creating API key via CLI (chirpstack create-api-key) ...');
  let result;
  try {
    result = execSync('chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered', {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const status = cliExitStatus(error);
    const suffix = status === null ? '' : `, exit status ${status}`;
    throw new Error(`CLI create-api-key failed (command error${suffix})`);
  }

  let token;
  try {
    const out = result.toString();
    if (typeof out !== 'string') throw new Error('invalid CLI output type');
    const match = out.match(/^token:\s*(.+)$/m);
    const selected = match ? match[1] : '';
    token = selected.trim();
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
      throw new Error('invalid CLI token');
    }
  } catch (_) {
    throw new Error('CLI create-api-key failed (invalid output)');
  }
  console.log('  ✓ API key created via CLI');
  return token;
}
```

The execution catch covers `execSync` alone. Own descriptor lookup is guarded, its primitive value is read once, and no getter, thrown child's field, parser exception or raw output enters a diagnostic. The second catch converts all conversion/parser failures to one fixed message. Keep `run`'s credential-74 branch before usage-2 before generic-1; the generic branch may print this fixed CLI error. Do not add `cause`, raw fields, a fallback output line, or a different regex. The first matching `token:` line wins; an invalid first capture fails.

Run the focused Clover suite again through the wrapper and require exit 0 with the new cases. If it does not fail for the stated reason before this commit or pass after it, stop rather than adapting the oracle to the product. Mirror byte equality and JavaScript syntax are separate gates below.

### Commit 3: direct helper evidence and workflow

Edit both profile `osi-chirpstack-helper/index.test.js` files identically. In the malformed pre-created-key assertion, replace the `JSON.stringify(caught)` claim that says “any own property” with this descriptor check. Keep the existing exact fixed `message`, undefined `cause`, marker-free `stack`, and printable-key authorization success assertions. This claims only direct own data properties, including non-enumerable ones; nested values require their own oracle. Mirror the same test bytes to bcm2709. Do not change either helper `index.js` unless an actual test failure proves a product gap.

```js
for (const key of Reflect.ownKeys(caught)) {
  const descriptor = Object.getOwnPropertyDescriptor(caught, key);
  assert.ok(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value'), 'error has no own accessor');
  const value = descriptor.value;
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    assert.ok(!String(value).includes(marker), 'marker absent from direct own error data');
  }
}
```

In `.github/workflows/verify-sync-flow.yml`, insert immediately after the `Kiwi and Clover device profiles, Clover ingest` step:

```yaml
      - name: ChirpStack helper metadata safety
        run: >-
          node --test
          conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
          conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
```

Keep the full-history checkout, reference-tree step, sync verifier, Clover step, G1 `pipefail`/TAP artifact, B3 literal old-base extraction, `PIPESTATUS[0]`, both failure-name and snapshot assertions, status write after assertions, and always-upload condition. Do not alter B3's source SHA. Message: `test: run both ChirpStack helper metadata suites in CI`.

### Commit 4: evidence and review handoff

After the final candidate gates, add a concise execution report under `docs/superpowers/reports/` with the actual fresh main/head SHA, exact changed-path list, commands, cwd, environment/base override, output path, direct exit and limits. Message: `docs: record issue 183 reconciliation evidence`. Do not replace `docs/superpowers/plans/2026-10-25-issue-183-credential-env-mode-safety.md` or rewrite historical test claims. Record the base RED and integrated GREEN separately. A new product or harness commit after verification invalidates affected evidence.

## Gate order and exact commands

`C=/home/phil/projects/osi-release-campaign-2026-10-25`. All local executable checks, including syntax, prose and diff checks, run as `python3 "$C/run-heavy.py" COMMAND ARGS`, one at a time. Check `command -v node`, `command -v sh` and required files before dispatch. Use an explicit output file and capture `$?` into a sibling `.status` immediately after each wrapper call. Do not pipe the wrapper into `tee` without preserving its direct status. Record wrapper refusal as refusal, not test RED. Leave all gates **UNRUN** until the implementation stage; #397 currently owns executable priority.

1. Baseline at fresh `origin/main`: `python3 "$C/run-heavy.py" node --test scripts/test-chirpstack-bootstrap-clover.js scripts/test-deploy-gateway-setup.js scripts/deploy-fetch-list.test.js scripts/deploy-payload-lifecycle.test.js scripts/test-deploy-atomic-payload-wiring.js`; then `python3 "$C/run-heavy.py" node scripts/verify-profile-parity.js`; `python3 "$C/run-heavy.py" node scripts/verify-communication-contract.js`; `python3 "$C/run-heavy.py" node scripts/verify-test-inventory.js`. Run from a clean isolated main checkout, not the immutable campaign base. A red base gate stops its surface. Record baseline output and direct status before candidate testing.
2. Prospective RED at fresh PR head after Commit 1: `python3 "$C/run-heavy.py" node --test scripts/test-chirpstack-bootstrap-clover.js`. Require failures attributable to direct status access/nonstring output and no unrelated fixture error. The root T7 case is pending until root CI; a local sudo refusal cannot be credited as expected RED.
3. Integrated focused GREEN after Commit 2: `python3 "$C/run-heavy.py" node --test scripts/test-chirpstack-bootstrap-clover.js scripts/test-deploy-gateway-setup.js scripts/deploy-fetch-list.test.js scripts/deploy-payload-lifecycle.test.js scripts/test-deploy-atomic-payload-wiring.js`; `python3 "$C/run-heavy.py" node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js` after Commit 3. Require zero failed/skipped/TODO/cancelled cases on the named suites. A fake root/one-turn Clover pass is focused evidence only.
4. Source gates after final source commit: `python3 "$C/run-heavy.py" node --check scripts/chirpstack-bootstrap.js`; `python3 "$C/run-heavy.py" node --check scripts/test-chirpstack-bootstrap-clover.js`; `python3 "$C/run-heavy.py" node --check scripts/test-chirpstack-env-file.js`; `python3 "$C/run-heavy.py" sh -n deploy.sh`; `python3 "$C/run-heavy.py" node scripts/verify-profile-parity.js`; `python3 "$C/run-heavy.py" node scripts/verify-communication-contract.js`; `python3 "$C/run-heavy.py" node scripts/verify-test-inventory.js`; `python3 "$C/run-heavy.py" node scripts/verify-sync-flow.js`. Require the parity verifier's final `All parity checks passed.` line. Separately compare canonical bootstrap bytes against both runtime copies and helper source/test bytes across profiles through a wrapped checker; no source change may be hidden by a green workflow.
5. Boundary/doc gates: `python3 "$C/run-heavy.py" env OSI_DDL_BASE_REF=30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f node scripts/verify-no-stray-ddl.js`; `python3 "$C/run-heavy.py" node scripts/verify-doc-hygiene.js`; `python3 "$C/run-heavy.py" node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-26-issue-183-pr527-exact-reconciliation.md docs/superpowers/reports/2026-10-26-issue-183-pr527-reconciliation-execution.md`; `python3 "$C/run-heavy.py" git diff --check 30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f..HEAD`. The DDL override is the reviewed current-main base, not the old B3 source. Record doc-hygiene built-in-only coverage if no private name list is configured.
6. Fresh root CI at the integrated candidate SHA, after separate authorization to update the PR: G1 must preserve all eleven exact T0–T10 passing inner TAP records and direct inner/outer exit 0, with no skips/TODO/cancellations. T7 must contain the distinct completed direct-root CLI child exit 1 and assertions above. B3 must still extract literal `63c7a70f...` source with digest `5f521479...`, show exactly the A1/A2 `0644` versus `0600` failures, inner exit 1, outer exit 0, and retain `.tap` plus `.status`; G1's `.tap` must also be retained. A parser, sudo, source, assertion or upload failure is CI RED. The old run `40281824266` cannot qualify this SHA.

An independent Sol verifier must inspect the complete new base-to-head diff, replay affected local gates under the wrapper and compare the result with this plan. A fresh Opus review must then bind to the same integrated SHA. The plan's R4 source acceptance is not an integrated-tree review. Native OpenWrt, physical interruption and deployed fleet modes remain separate. Keep PR #527 draft and issue #183 open; key/profile lifecycle and full #522 disclosure/caller qualification still need their own disposition.
