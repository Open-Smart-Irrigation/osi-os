# Issue 183 PR 527: exact reconciliation from main

This is a prospective follow-up specification for the externally merged PR #527 at historical head `6f61dd2a25142b67006d793bf80e4f8494316ce0`. Its parent merge `326dfd39` incorporated the then-fetched main `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f`; the PR then added `9eb2a2ed` and `6f61dd2a`. The T3 linked-PR registry reported the PR merged externally at 22:31Z, with 12 required checks passing on that historical head and no Opus approval inferred. Fresh main is the squash commit `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5`. Do not replay the PR commits. This plan remains subject to fresh independent exact-SHA review before any implementation. No product edit, test, build, push, CI run, deploy or live operation occurred in this amendment.

## Binding and observed conflict

| Ref or artifact | Full binding and finding |
|---|---|
| Historical fetched `origin/main` and PR base | `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f` |
| Fetched `refs/pull/527/head` | `6f61dd2a25142b67006d793bf80e4f8494316ce0`, open draft at the earlier read; externally merged by 22:31Z |
| PR merge base with main | `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f` |
| Fresh fetched `origin/main` | `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5`, squash commit `fix: secure credential env-file publication and deploy repair (#527)` with direct parent `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f` |
| Fresh source-tree binding | Both `6f61dd2a25142b67006d793bf80e4f8494316ce0` and `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5` resolve to tree `0d443936c4057f632a043925297e8ab28d0b70a7`; full `git diff --name-status` is empty. The historical PR head is **not** an ancestor of main because of the squash. |
| Last independently root-qualified old candidate | `f7d37a14d45f0163e8bb3ab191562d8863919a1b`; Linux run `40281824266` approves G1/B3 there only |
| Fixed B3 source | `63c7a70f8f3b373f162b33b0669b0df89b3763fa`, SHA-256 `5f521479463c2ebc2aaf17e4a6ee5ec0a0235a93a6146914f6da626b8c92074d` |

I fetched the refs in the isolated planning worktree, then reset that clean branch from stale `c37207b30b002fb79da8ae57253d78c04613b6a5` to the fetched main SHA. A separate disposable worktree at `f7d37a14` ran `git merge --no-commit --no-ff origin/main`. Git reported one content conflict, in `scripts/test-chirpstack-bootstrap-clover.js` at `makeWorld`: the #183 side added `fsEvents`, while main added `stdoutLogs`, `stderrLogs`, CLI output/error and options fields. The bootstrap copies and workflow auto-merged. I read the conflict, aborted the merge and removed the disposable worktree. The PR's `326dfd39` resolution retains both sides' fields; it does not implement the later R1–R4 parser and direct-child decisions. There is no unresolved merge in this planning checkout or in the fetched PR tree.

The fresh main tree retains byte-identical bootstrap copies (Git blob `1529ff06975b32407b71e2afc483aa628f4f422a`), byte-identical helper source copies (`402aa9312e4cd78ec023b317e1677e1a652d51bd`) and helper tests (`3edb733b0d94c85c2333edcf02908030c177c289`). Those are source observations, not executed parity gates. The main helper's fixed gRPC metadata error and its tests survive the squash. `deploy.sh` still has early, post-Gen2 and final secure calls and six explicit canonical `ENV_FILE` bindings. The workflow retains full-history checkout, the reference-tree step, sync verifier, Clover suite, G1, literal-base B3 extraction, direct `PIPESTATUS[0]`, ordered B3 assertions, `.tap`/`.status` artifacts and the new G1 TAP artifact. It lacks a named direct helper-metadata test step.

The fresh main anchor blobs are unchanged from historical `6f61dd2a`: Clover test `6f1f947bbdf3c13453c6b645631fa8b2328caa82` (`makeWorld` line 58, `makeChildProcess` line 235, insertion after the stderr test at line 454); env-file root test `10d02a3cf21baf37d9b92e6313ae494532c36447` (`publisherPreloadSource` line 251, T7 line 831); bootstrap parser `1529ff06975b32407b71e2afc483aa628f4f422a` (`createApiKeyViaCLI` line 275); helper test `3edb733b0d94c85c2333edcf02908030c177c289` (the `JSON.stringify(caught)` oracle at line 854); workflow `5cf09d07e7724fa9005d6a2729aa045e1b19fc40` (Clover step line 201, G1/B3 block lines 205–243). `deploy.sh` is `09ce70c7a322df9fe8b764ec4162cbd8cbd0b8f4`, with six canonical bindings at lines 1881, 2549, 2557, 2576, 2599 and 2623. Source/anchor drift at this fetch is zero; no test gate ran.

At historical PR head `6f61dd2a`, the merged `createApiKeyViaCLI` calls `.toString()` inside the `execSync` catch, reads `error.status` repeatedly, and calls `.match` without a primitive-string guard. Its Clover fake calls `Buffer.from(cliApiKeyOutput)` before returning. T7 still uses a synchronous deploy-fragment runner with a pre-created API key; its status-1 warning does not prove a direct CLI child exit. These are the historical repair targets to recheck against fresh main. The added `9eb2a2ed` link-count/staging diagnostics and `6f61dd2a` G1 artifact retention remain in scope for preservation and fresh review, not rollback.

## Invariants and stop points

The #183 publisher must still narrow an existing regular env file to root:root `0600` by descriptor before reading its bytes or reaching key/API work. Keep the private `0600` atomic staging, create-only collision and unsafe-entry refusal, raw Buffer backup, lossless UTF-8 guard for text mutation, and safe credential status 74 through late cleanup failures. Usage failures remain 2; CLI and other unrelated failures remain 1. Do not treat metadata narrowing as env-content publication. A completed API/UCI side effect cannot turn a later credential filesystem failure into status 1.

Keep the six deploy bindings, early/post-Gen2/final checks, private `.pre-gen2` create-only backup, status-1 warning versus fatal 74/2 behavior, and migration/payload/restart stop points. Retain the consumer path, line format and UCI-over-env precedence. Do not touch `flows.json`, schema, Node-RED service identity, key/profile lifecycle, #181 or the full #522 qualification. An older ROM bootstrap may still be selected on an existing device; this change does not replace that ROM copy on deploy.

Before implementation, fetch current main again in a new clean isolated worktree. Verify that this plan's bound squash commit `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5` remains in main's ancestry and compare the current source to both that commit and historical `6f61dd2a`. Record any new full base SHA, tree diff and anchor drift, then obtain independent approval of that binding. Stop on source drift that changes the planned edit or oracle. If the prospective focused tests pass unchanged, inspect the oracle before editing product code. If a current-base gate is red, stop that surface and report it for separate baseline repair. If the wrapper refuses a command because of admission, lock or registration, record the refusal and defer that check; do not retry in a busy loop, clear registration or modify host policy.

## Exact editor sequence after independent plan review

Use a new clean isolated implementation worktree at a freshly fetched main commit after the binding review above. Verify its `HEAD`, clean status and ancestry to squash commit `8ec3ec3cc65b532a4ad980efa390bf8111bb82c5`; compare its tree with historical PR head `6f61dd2a`. Do not use the project root checkout or the historical candidate worktree. Preserve `326dfd39`, `9eb2a2ed` and `6f61dd2a` as historical evidence without replaying them into the squash history. The following editor sequence is bound to the identical fresh-main source tree; rebind file anchors and gate base refs again if main advances before execution. Run only one wrapped command at a time under the active campaign priority and serialization policy.

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

The configured output must reach product conversion unchanged. The historical fake default output is a primitive string, so existing success cases still exercise `.toString()`. Set both `CHIRPSTACK_API_KEY` and `CS_API_KEY` to `''` in every CLI-reach case. Add one shared assertion for a failed CLI case: exit 1, exactly one recorded command with `{ stdio: ['ignore', 'pipe', 'pipe'] }`, no client key, no env-content write, no `uci set`/`commit`, and each synthetic marker absent from **each** captured stream. The exact command is `chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered`; it contains no shell `2>&1`.

Add table cases for own data-property status `1` and `255` (fixed `command error, exit status N`); own `0`, `-1`, `256`, fractional, string, `null`, absent and inherited status (fixed `command error` without status); an own getter whose return changes or throws (zero getter calls); and a Proxy whose `getOwnPropertyDescriptor` trap throws (fixed generic command error). The status matrix must trace `['threw']`, never a fake return. Put distinct synthetic markers in `message`, `stdout`, `stderr`, `cmd`, `stack` and `output`; none may appear on either stream. Assert the final status is 1, not 74 or 2. Avoid printing the hostile object in an assertion message.

Add three uncoerced fake-return cases, each tracing `['returned']`: `toString()` throws; `toString()` returns a nonstring object; and `toString()` returns an object with a forged `match()` that would yield a capture whose `trim()` returns a forged token object. In the last case, count `match()` calls and require zero. Every case must yield only `CLI create-api-key failed (invalid output)`, exit 1 and the shared no-effect/no-marker assertions. Do not add ordinary string `match()` or `trim()` throw cases: the required primitive guard makes those unreachable under normal intrinsics.

For first-match selection, use the literal output `token:SYNTHETIC_BAD\tKEY_183\ntoken:good-key\n`. The test setup must first assert `output.match(/^token:\s*(.+)$/m)[1] === 'SYNTHETIC_BAD\tKEY_183'`; the product then rejects it with fixed invalid-output text and no effect, despite the later valid line. A separate `token:first-key\ntoken:second-key\n` case must pass `first-key` to `createClient`. Do not use a bare `token:` as the negative case: `\s*` can consume a newline. Keep main's ANSI, tab, non-ASCII, pre-created-key and successful-client cases.

The following is the complete focused addition. Insert it after the current `CLI key creation captures the child stderr instead of inheriting it` test. It replaces the preceding prose as the test oracle; keep the existing #530 tests. In every added CLI case, the two key variables are explicitly empty. `world.fsEvents` may record harmless preflight metadata, while the helper refuses a content write or publication.

```js
const CLI_COMMAND_183 = 'chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered';
const CLI_OPTIONS_183 = { stdio: ['ignore', 'pipe', 'pipe'] };
const CLI_ENV_183 = { CHIRPSTACK_API_KEY: '', CS_API_KEY: '' };
const COMMAND_ERROR_183 = 'CLI create-api-key failed (command error)';
const INVALID_OUTPUT_183 = 'CLI create-api-key failed (invalid output)';
const ERROR_MARKERS_183 = [
  'SYNTHETIC_MESSAGE_183', 'SYNTHETIC_STDOUT_183', 'SYNTHETIC_STDERR_183',
  'SYNTHETIC_CMD_183', 'SYNTHETIC_STACK_183', 'SYNTHETIC_OUTPUT_183'
];

function assertCliInvocation183(world, outcome) {
  assert.equal(world.cliApiKeyCalls, 1, 'one CLI attempt');
  assert.deepEqual(world.cliExecOptions, [{ command: CLI_COMMAND_183, options: CLI_OPTIONS_183 }]);
  assert.deepEqual(world.cliApiKeyOutcomes, [outcome], 'fake provenance is explicit');
}

function assertCliFailure183(world, expected, outcome, markers = []) {
  assertCliInvocation183(world, outcome);
  assert.equal(world.exitCode, 1, 'generic CLI exit, distinct from 74 and 2');
  assert.deepEqual(world.clientApiKeys, [], 'no client after failed CLI');
  assert.deepEqual(world.writes, [], 'no ChirpStack API mutation after failed CLI');
  assert.equal(world.files.has(ENV_FILE), false, 'no env content appeared');
  assert.equal(world.fsEvents.some(event => ['write', 'rename', 'link'].includes(event[0])), false,
    'no env content write or publication');
  assert.equal(world.uciCommands.some(command => /^(?:set|commit)(?:\s|$)/.test(command)), false,
    'no UCI mutation');
  assert.deepEqual(world.stderrLogs.flatMap(line => line.split('\n').map(part => part.trim()).filter(Boolean)),
    [`Bootstrap failed: ${expected}`]);
  for (const [stream, lines] of [['stdout', world.stdoutLogs], ['stderr', world.stderrLogs]]) {
    const output = lines.join('\n');
    for (const marker of markers) {
      assert.equal(output.includes(marker), false, `${marker} absent from ${stream}`);
    }
  }
}

function hostileCliError183() {
  const error = new Error(ERROR_MARKERS_183[0]);
  error.stdout = Buffer.from(ERROR_MARKERS_183[1]);
  error.stderr = Buffer.from(ERROR_MARKERS_183[2]);
  error.cmd = ERROR_MARKERS_183[3];
  error.stack = ERROR_MARKERS_183[4];
  error.output = [ERROR_MARKERS_183[5]];
  return error;
}

for (const [label, value, expected] of [
  ['own 1', 1, 'CLI create-api-key failed (command error, exit status 1)'],
  ['own 255', 255, 'CLI create-api-key failed (command error, exit status 255)'],
  ['own zero', 0, COMMAND_ERROR_183],
  ['own negative', -1, COMMAND_ERROR_183],
  ['own 256', 256, COMMAND_ERROR_183],
  ['own fraction', 1.5, COMMAND_ERROR_183],
  ['own numeric string', '23', COMMAND_ERROR_183],
  ['own null', null, COMMAND_ERROR_183]
]) {
  test(`CLI command failure with ${label} status uses only fixed diagnostics`, async () => {
    const error = hostileCliError183();
    Object.defineProperty(error, 'status', { value, configurable: true });
    const world = await runBootstrap(makeWorld({ cliApiKeyError: error }), { env: CLI_ENV_183 });
    assertCliFailure183(world, expected, 'threw', ERROR_MARKERS_183);
  });
}

test('CLI command failure with absent status omits exit metadata', async () => {
  const world = await runBootstrap(makeWorld({ cliApiKeyError: hostileCliError183() }), { env: CLI_ENV_183 });
  assertCliFailure183(world, COMMAND_ERROR_183, 'threw', ERROR_MARKERS_183);
});

test('CLI command failure ignores inherited status', async () => {
  const error = hostileCliError183();
  Object.setPrototypeOf(error, Object.create(Error.prototype, { status: { value: 23, enumerable: true } }));
  const world = await runBootstrap(makeWorld({ cliApiKeyError: error }), { env: CLI_ENV_183 });
  assertCliFailure183(world, COMMAND_ERROR_183, 'threw', ERROR_MARKERS_183);
});

for (const [label, getter] of [
  ['changing', count => count === 1 ? 1 : 255],
  ['throwing', () => { throw new Error('SYNTHETIC_STATUS_GETTER_183'); }]
]) {
  test(`CLI command failure never invokes an own ${label} status getter`, async () => {
    let calls = 0;
    const error = hostileCliError183();
    Object.defineProperty(error, 'status', { get() { calls += 1; return getter(calls); } });
    const world = await runBootstrap(makeWorld({ cliApiKeyError: error }), { env: CLI_ENV_183 });
    assertCliFailure183(world, COMMAND_ERROR_183, 'threw', [...ERROR_MARKERS_183, 'SYNTHETIC_STATUS_GETTER_183']);
    assert.equal(calls, 0, 'status getter was not invoked');
  });
}

test('CLI command failure contains a throwing descriptor trap', async () => {
  let descriptorCalls = 0;
  const error = new Proxy(hostileCliError183(), {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'status') {
        descriptorCalls += 1;
        throw new Error('SYNTHETIC_DESCRIPTOR_TRAP_183');
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
  const world = await runBootstrap(makeWorld({ cliApiKeyError: error }), { env: CLI_ENV_183 });
  assertCliFailure183(world, COMMAND_ERROR_183, 'threw', [...ERROR_MARKERS_183, 'SYNTHETIC_DESCRIPTOR_TRAP_183']);
  assert.equal(descriptorCalls, 1, 'one guarded descriptor lookup');
});

test('CLI return conversion throw is invalid output, not a command error', async () => {
  const marker = 'SYNTHETIC_CONVERSION_THROW_183';
  const output = { toString() { throw new Error(marker); } };
  const world = await runBootstrap(makeWorld({ cliApiKeyOutput: output }), { env: CLI_ENV_183 });
  assertCliFailure183(world, INVALID_OUTPUT_183, 'returned', [marker]);
});

test('CLI return conversion to a nonstring is invalid output', async () => {
  const marker = 'SYNTHETIC_NONSTRING_RETURN_183';
  const output = { toString() { return { marker }; } };
  const world = await runBootstrap(makeWorld({ cliApiKeyOutput: output }), { env: CLI_ENV_183 });
  assertCliFailure183(world, INVALID_OUTPUT_183, 'returned', [marker]);
});

test('CLI nonstring return cannot forge a successful match or client key', async () => {
  const marker = 'SYNTHETIC_FORGED_TOKEN_183';
  let matchCalls = 0;
  const forged = {
    match() {
      matchCalls += 1;
      return [null, { trim() { return { toString() { return marker; } }; } }];
    }
  };
  const output = { toString() { return forged; } };
  const world = await runBootstrap(makeWorld({ cliApiKeyOutput: output }), { env: CLI_ENV_183 });
  assertCliFailure183(world, INVALID_OUTPUT_183, 'returned', [marker]);
  assert.equal(matchCalls, 0, 'parser rejects the nonstring before match');
});

test('CLI rejects the first regex capture with an internal tab despite a valid later line', async () => {
  const marker = 'SYNTHETIC_BAD\tKEY_183';
  const output = `token:${marker}\ntoken:good-key\n`;
  assert.equal(output.match(/^token:\s*(.+)$/m)[1], marker, 'fixture binds the first capture');
  const world = await runBootstrap(makeWorld({ cliApiKeyOutput: output }), { env: CLI_ENV_183 });
  assertCliFailure183(world, INVALID_OUTPUT_183, 'returned', [marker, 'good-key']);
});

test('CLI selects the first of two valid regex matches', async () => {
  const output = 'token:first-key\ntoken:second-key\n';
  assert.equal(output.match(/^token:\s*(.+)$/m)[1], 'first-key');
  const world = await runBootstrap(makeWorld({ cliApiKeyOutput: output }), { env: CLI_ENV_183 });
  assertCliInvocation183(world, 'returned');
  assert.equal(world.exitCode, 0);
  assert.deepEqual(world.clientApiKeys, ['first-key']);
  assert.equal(parseEnv(world.files.get(ENV_FILE)).CHIRPSTACK_API_KEY, 'first-key');
  for (const lines of [world.stdoutLogs, world.stderrLogs]) {
    assert.equal(lines.join('\n').includes('second-key'), false, 'later token never appears on a stream');
  }
});
```

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

Keep the existing `publisherPreloadSource` fault branches and guarded product-FS Proxy. Immediately after its `productFs` array entry and before `const fakeCp`, add these literal source-string entries to the returned array. In the existing `Module._load` entry, change only `if(request==='fs')return productFs` to `if(request==='fs')return tracedFs`. The trace wrapper runs only in this direct case; its delegate remains the existing confinement Proxy. It records successful canonical descriptor narrowing/read and every product content write or rename/link publication in this direct case, including staged paths.

```js
"const traceCli=process.env.ISSUE183_CLI_THROW==='1';",
"const tracedFs=new Proxy(productFs,{get(target,key){",
" const value=target[key]; if(!traceCli||typeof value!=='function')return value;",
" return (...args)=>{",
"  const result=value(...args);",
"  if(key==='fchmodSync'&&resolvedFsPath(args[0],nativeFs)===TARGET){",
"   const st=nativeFs.fstatSync(args[0]);note('preflight-chmod',{uid:st.uid,gid:st.gid,mode:st.mode&0o7777});",
"  }",
"  if(key==='readFileSync'&&typeof args[0]==='number'&&resolvedFsPath(args[0],nativeFs)===TARGET){",
"   note('preflight-read',{bytesHex:Buffer.from(result).toString('hex')});",
"  }",
"  if(key==='writeFileSync'||key==='writeSync')note('env-content-write',{path:resolvedFsPath(args[0],nativeFs)});",
"  if(key==='renameSync'||key==='linkSync')note('env-content-publish',{path:resolvedFsPath(args[1],nativeFs)});",
"  return result;",
" };",
"}});",
```

Change the T7 declaration to `test('T7 deploy routing', async t => {`. Keep the existing fragment matrix. Immediately before T7's closing `});` (the next test is T8), insert the following shell-only warning case and the direct-child call. The shell case's exit 0 is intentionally distinct from the direct child's exit 1.

```js
const gen2Warning = fixture();
try {
  const run = runFragments(gen2Warning, sensors + 'CHIRPSTACK_API_KEY=' + API_KEY + '\n', { gen2Status: 1 });
  assert.equal(run.result.status, 0, 'deploy continues after a Gen2 API status 1 warning');
  assert.match(run.result.stdout || '', /WARN: Gen2 profile provisioning failed; valves will register on the Gen1 profile/);
  assert.equal(fs.existsSync(run.migration), true, 'shell continuation reaches the marker');
} finally { clean(gen2Warning); }
await assertDirectRootCliFailure183(t);
```

Define this entire helper immediately before the T7 declaration. It uses the real root process and real fixture metadata. The explicit environment does not inherit either host API-key variable. It contains every `ISSUE183_*`, codec, settings and flows binding needed by the copied full source and preload. It reads the completed trace only after an observed `close` with direct exit 1. If the bounded TERM/KILL path never gets `close`, it records `UNREAPED.txt`, reports the PID and fixture path, destroys both piped streams, unrefs the child, retains the fixture, and credits no trace or exit result. The assertion then fails without leaving the harness held by those handles; a late close cannot change `closeObserved` or earn trace credit. The same retention applies to a spawn error, signal, timeout, output bound or wrong exit. The helper never removes a still-open child's fixture.

```js
async function assertDirectRootCliFailure183(t) {
  assert.equal(process.geteuid(), 0, 'T7 requires actual root');
  const fx = fixture();
  let closeObserved = false;
  let exitOne = false;
  let timedOut = false;
  let spawnError = null;
  let outputTooLarge = false;
  try {
    const initial = Buffer.from('OPERATOR=keep\n');
    const sourceCopy = path.join(fx.dir, 'candidate-chirpstack-bootstrap.js');
    const preload = path.join(fx.dir, 'publisher-preload.cjs');
    const trace = path.join(fx.dir, 'direct-cli-events.jsonl');
    const codecs = path.join(fx.dir, 'codecs');
    fs.mkdirSync(codecs, { mode: 0o700 });
    for (const name of ['strega.js', 'strega-gen2.js', 'lsn50.js', 's2120.js',
      'lorain.js', 'uc512.js', 'sdi12.js']) {
      fs.writeFileSync(path.join(codecs, name), 'module.exports = {};\n', { mode: 0o600 });
    }
    fs.copyFileSync(SOURCE, sourceCopy);
    fs.writeFileSync(fx.settingsJs, "'use strict';\n", { mode: 0o600 });
    fs.writeFileSync(fx.flowsJson, '[]\n', { mode: 0o600 });
    fs.writeFileSync(fx.envFile, initial, { mode: 0o644 });
    fs.chownSync(fx.envFile, 0, 0);
    fs.chmodSync(fx.envFile, 0o644);
    const before = fs.statSync(fx.envFile);
    assert.equal(before.uid, 0); assert.equal(before.gid, 0);
    assert.equal(before.mode & 0o7777, 0o644); assert.equal(before.nlink, 1);
    assert.deepEqual(fs.readFileSync(fx.envFile), initial);
    assert.doesNotMatch(initial.toString('utf8'), /^CHIRPSTACK_API_KEY=|^CS_API_KEY=/m);
    assert.equal(fs.existsSync(trace), false);
    fs.writeFileSync(preload, publisherPreloadSource(
      { ...fx, sourceFile: sourceCopy }, '', 'full', trace
    ), { mode: 0o600 });
    const childEnv = {
      PATH: '/usr/bin:/bin', ENV_FILE: fx.envFile,
      CHIRPSTACK_API_KEY: '', CS_API_KEY: '',
      NODE_OPTIONS: '--require ' + preload,
      ISSUE183_CLI_THROW: '1', ISSUE183_FIXTURE: fx.dir,
      ISSUE183_SOURCE: sourceCopy, ISSUE183_TRACE: trace,
      ISSUE183_OPERATION: 'full', ISSUE183_FAULT: '',
      ISSUE183_UCI_STATE: '{}', ISSUE183_SOIL_API_FAILURE: '',
      ISSUE183_VIRTUAL_ROOT: '', OSI_BOOTSTRAP_PATCH_SETTINGS: '0',
      SETTINGS_JS: fx.settingsJs, FLOWS_JSON: fx.flowsJson,
      TEKTELIC_CODEC_PATH: TEKTELIC_CODEC,
      STREGA_CODEC_PATH: path.join(codecs, 'strega.js'),
      STREGA_GEN2_CODEC_PATH: path.join(codecs, 'strega-gen2.js'),
      LSN50_CODEC_PATH: path.join(codecs, 'lsn50.js'),
      S2120_CODEC_PATH: path.join(codecs, 's2120.js'),
      LORAIN_CODEC_PATH: path.join(codecs, 'lorain.js'),
      UC512_CODEC_PATH: path.join(codecs, 'uc512.js'),
      SDI12_CODEC_PATH: path.join(codecs, 'sdi12.js')
    };
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = cp.spawn(process.execPath, [sourceCopy], {
      env: childEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    const closed = new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    for (const [stream, set] of [
      [child.stdout, value => { stdout = value; }],
      [child.stderr, value => { stderr = value; }]
    ]) {
      stream.on('data', chunk => {
        const prior = stream === child.stdout ? stdout : stderr;
        const next = Buffer.concat([prior, chunk]);
        if (next.length > 2 * 1024 * 1024) {
          outputTooLarge = true;
          child.kill('SIGTERM');
        } else set(next);
      });
    }
    const awaitClose = async ms => {
      let timer;
      try {
        return await Promise.race([
          closed,
          new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })
        ]);
      } finally { clearTimeout(timer); }
    };
    let outcome = await awaitClose(5000);
    if (!outcome) {
      timedOut = true;
      child.kill('SIGTERM');
      outcome = await awaitClose(1000);
      if (!outcome) {
        child.kill('SIGKILL');
        outcome = await awaitClose(2000);
      }
    }
    if (!outcome) {
      fs.writeFileSync(path.join(fx.dir, 'UNREAPED.txt'),
        'direct CLI child had no close after TERM/KILL; pid=' + String(child.pid) + '\n');
      t.diagnostic('UNREAPED direct CLI child pid=' + String(child.pid) + '; fixture=' + fx.dir);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      assert.fail('direct CLI child did not close; fixture and trace retained without credit');
    }
    closeObserved = true;
    assert.equal(timedOut, false, 'no deadline signal was needed');
    assert.equal(spawnError, null, 'direct CLI child spawned');
    assert.equal(outputTooLarge, false, 'child output stayed within 2 MiB per stream');
    assert.equal(outcome.signal, null, 'child ended without a signal');
    assert.equal(outcome.code, 1, 'direct full-bootstrap child exits 1');
    exitOne = true;

    const after = fs.statSync(fx.envFile);
    assert.equal(after.uid, 0); assert.equal(after.gid, 0);
    assert.equal(after.mode & 0o7777, 0o600); assert.equal(after.nlink, 1);
    assert.deepEqual(fs.readFileSync(fx.envFile), initial, 'preflight changed metadata, not bytes');
    assert.equal(fs.existsSync(fx.backup), false, 'failure did not publish a backup');
    const stdoutText = stdout.toString('utf8');
    const stderrText = stderr.toString('utf8');
    assert.deepEqual(stderrText.split('\n').map(line => line.trim()).filter(Boolean),
      ['Bootstrap failed: CLI create-api-key failed (command error, exit status 23)']);
    for (const marker of [
      'SYNTHETIC_CLI_MESSAGE_183', 'SYNTHETIC_CLI_STDOUT_183',
      'SYNTHETIC_CLI_STDERR_183', 'SYNTHETIC_CLI_CMD_183',
      'SYNTHETIC_CLI_OUTPUT_183'
    ]) {
      assert.equal(stdoutText.includes(marker), false, marker + ' absent from child stdout');
      assert.equal(stderrText.includes(marker), false, marker + ' absent from child stderr');
    }

    const lines = fs.readFileSync(trace, 'utf8').trimEnd().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one completed process-exit trace');
    const events = JSON.parse(lines[0]);
    assert.ok(Array.isArray(events), 'trace is an event array');
    const kind = event => Array.isArray(event) ? event[0] : event.kind;
    const positions = name => events.flatMap((event, index) => kind(event) === name ? [index] : []);
    const chmod = positions('preflight-chmod');
    const reads = positions('preflight-read');
    const api = positions('api-key');
    const thrown = positions('api-key-throw');
    assert.equal(chmod.length, 1, 'one successful canonical mode narrowing');
    assert.ok(reads.length >= 1, 'canonical descriptor bytes were read');
    assert.equal(api.length, 1, 'one CLI command');
    assert.equal(thrown.length, 1, 'one CLI throw');
    assert.ok(chmod[0] < reads[0] && reads[0] < api[0], 'narrow, read, then CLI');
    assert.equal(thrown[0], api[0] + 1, 'the fake threw at that CLI call');
    assert.deepEqual(events[chmod[0]], { kind: 'preflight-chmod', uid: 0, gid: 0, mode: 0o600 });
    for (const index of reads) {
      assert.ok(index < api[0], 'every canonical read precedes CLI failure');
      assert.deepEqual(events[index], { kind: 'preflight-read', bytesHex: initial.toString('hex') });
    }
    assert.deepEqual(events[api[0]], [
      'api-key', 'chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered',
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ]);
    for (const event of events) {
      assert.equal(['client', 'env-content-write', 'env-content-publish', 'uci-write'].includes(kind(event)),
        false, 'no client, env content or UCI mutation anywhere in this failed run');
    }
    assert.deepEqual(events[events.length - 1], {
      kind: 'fault-summary', fault: '', operation: 'full', faultFired: false, published: false
    });
  } finally {
    if (closeObserved && exitOne && !timedOut && !spawnError && !outputTooLarge) {
      clean(fx);
    } else {
      t.diagnostic('retained direct CLI fixture for failed or unreaped child: ' + fx.dir);
    }
  }
}
```

The helper is local to the root T7 suite; it does not alter `cli()` or the outer `sudo -n` re-entry. The existing guarded product-FS Proxy still confines every product access. The new child covers one CLI failure path, while the ten-case #522 full-source qualification remains separate. Root T7 may be unavailable locally because `sudo -n` is unavailable; mark that gate pending without a skip or virtual-owner substitute.

In the future implementation run the focused Clover suite through the wrapper after Commit 1 and record its direct nonzero exit with failures on status getter and malformed-return cases. A local `sudo -n` refusal is pending root evidence, not RED or a virtual-owner substitute. Do not commit a root success claim.

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

`C=/home/phil/projects/osi-release-campaign-2026-10-25`. All local executable checks, including syntax, prose and diff checks, run as `python3 "$C/run-heavy.py" COMMAND ARGS`, one at a time. Check `command -v node`, `command -v sh` and required files before dispatch. Use an explicit output file and capture `$?` into a sibling `.status` immediately after each wrapper call. Do not pipe the wrapper into `tee` without preserving its direct status. Record wrapper refusal as refusal, not test RED. Leave all gates **UNRUN** until the implementation stage; this plan-stage task authorizes no executable gate.

1. Baseline at fresh `origin/main`: `python3 "$C/run-heavy.py" node --test scripts/test-chirpstack-bootstrap-clover.js scripts/test-deploy-gateway-setup.js scripts/deploy-fetch-list.test.js scripts/deploy-payload-lifecycle.test.js scripts/test-deploy-atomic-payload-wiring.js`; then `python3 "$C/run-heavy.py" node scripts/verify-profile-parity.js`; `python3 "$C/run-heavy.py" node scripts/verify-communication-contract.js`; `python3 "$C/run-heavy.py" node scripts/verify-test-inventory.js`. Run from a clean isolated main checkout, not the immutable campaign base. A red base gate stops its surface. Record baseline output and direct status before candidate testing.
2. Prospective RED at the newly bound follow-up candidate after Commit 1: `python3 "$C/run-heavy.py" node --test scripts/test-chirpstack-bootstrap-clover.js`. Require failures attributable to direct status access/nonstring output and no unrelated fixture error. The root T7 case is pending until root CI; a local sudo refusal cannot be credited as expected RED.
3. Integrated focused GREEN after Commit 2: `python3 "$C/run-heavy.py" node --test scripts/test-chirpstack-bootstrap-clover.js scripts/test-deploy-gateway-setup.js scripts/deploy-fetch-list.test.js scripts/deploy-payload-lifecycle.test.js scripts/test-deploy-atomic-payload-wiring.js`; `python3 "$C/run-heavy.py" node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js` after Commit 3. Require zero failed/skipped/TODO/cancelled cases on the named suites. A fake root/one-turn Clover pass is focused evidence only.
4. Source gates after final source commit: `python3 "$C/run-heavy.py" node --check scripts/chirpstack-bootstrap.js`; `python3 "$C/run-heavy.py" node --check scripts/test-chirpstack-bootstrap-clover.js`; `python3 "$C/run-heavy.py" node --check scripts/test-chirpstack-env-file.js`; `python3 "$C/run-heavy.py" sh -n deploy.sh`; `python3 "$C/run-heavy.py" node scripts/verify-profile-parity.js`; `python3 "$C/run-heavy.py" node scripts/verify-communication-contract.js`; `python3 "$C/run-heavy.py" node scripts/verify-test-inventory.js`; `python3 "$C/run-heavy.py" node scripts/verify-sync-flow.js`. Require the parity verifier's final `All parity checks passed.` line. Separately compare canonical bootstrap bytes against both runtime copies and helper source/test bytes across profiles through a wrapped checker; no source change may be hidden by a green workflow.
5. Boundary/doc gates, only after the fresh main SHA is independently bound as `ACCEPTED_MAIN_SHA`: `python3 "$C/run-heavy.py" env OSI_DDL_BASE_REF="$ACCEPTED_MAIN_SHA" node scripts/verify-no-stray-ddl.js`; `python3 "$C/run-heavy.py" node scripts/verify-doc-hygiene.js`; `python3 "$C/run-heavy.py" node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-26-issue-183-pr527-exact-reconciliation.md docs/superpowers/reports/2026-10-26-issue-183-pr527-reconciliation-execution.md`; `python3 "$C/run-heavy.py" git diff --check "$ACCEPTED_MAIN_SHA..HEAD"`. The DDL override and diff base must be the newly reviewed main SHA, not historical `30fce8a79b6daa7ea4b02c4d0e5598c42dacc68f` or the old B3 source. These commands are specified but unavailable for execution until the fresh SHA is recorded and approved. Record doc-hygiene built-in-only coverage if no private name list is configured.
6. Fresh root CI at a future integrated follow-up candidate SHA, after separate authorization for that future PR: G1 must preserve all eleven exact T0–T10 passing inner TAP records and direct inner/outer exit 0, with no skips/TODO/cancellations. T7 must contain the distinct completed direct-root CLI child exit 1 and assertions above. B3 must still extract literal `63c7a70f...` source with digest `5f521479...`, show exactly the A1/A2 `0644` versus `0600` failures, inner exit 1, outer exit 0, and retain `.tap` plus `.status`; G1's `.tap` must also be retained. A parser, sudo, source, assertion or upload failure is CI RED. The old run `40281824266` cannot qualify this SHA.

An independent Sol verifier must inspect the complete new base-to-head diff, replay affected local gates under the wrapper and compare the result with this plan. A fresh Opus review must then bind to the same integrated SHA. The plan's R4 source acceptance is not an integrated-tree review. Native OpenWrt, physical interruption and deployed fleet modes remain separate. PR #527 is externally merged; do not edit or push its branch, publish a review on it, watch it, or use its passing checks as follow-up qualification. Any follow-up PR and issue #183 disposition need their own authorization and current-state review. Key/profile lifecycle and full #522 disclosure/caller qualification still need their own disposition.
