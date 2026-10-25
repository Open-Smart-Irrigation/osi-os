# Issue 469: align SDI-12 commissioning with the shipped ChirpStack client

This plan repairs recipe apply, rollback and queued-deployment polling by changing commissioning callers to the helper's existing API. It is a design deliverable awaiting fresh independent plan review. Do not implement it until the coordinator accepts that review and assigns execution.

## Base, evidence and scope

Runtime base: `63c7a70f8f3b373f162b33b0669b0df89b3763fa`. The design branch `t3/sdi12-helper-alignment-plan` began clean at `c37207b30b002fb79da8ae57253d78c04613b6a5`, zero commits ahead and 103 behind that base. It was advanced with `git merge --ff-only` to the requested SHA; no other checkout was changed. Local `origin/main` also resolved to the runtime base. This design did not fetch or claim a fresh remote-head comparison.

Read the current [issue and acceptance criteria](https://github.com/Open-Smart-Irrigation/osi-os/issues/469) and [campaign comment](https://github.com/Open-Smart-Irrigation/osi-os/issues/469#issuecomment-6404022198), refreshed on October 26. The issue remains open, P1. Campaign references are `COORDINATION.md`, `PLAN.md`, `reports/issue-469-finder.md` and `reports/issue-469-coordinator-evidence.md` under `/home/phil/projects/osi-release-campaign-2026-10-25`.

At the base, commissioning calls `listDeviceQueue` three times and `enqueueDeviceDownlink` twice. The real helper exposes `getDeviceQueue` and `enqueueDownlink`. The flow action nodes pass that helper directly. Queue retrieval already exists, so adding another retrieval implementation or duplicate public aliases has no demonstrated need.

The finder reports that temporary in-memory adapters enabled 12 fake-gRPC enqueues each for apply and rollback, and a queued poll stamped `queue_drained_at`. Its report supplies no saved reproduction-script path. The designer requested that artifact; the separate design probe in the campaign evidence directory is independent evidence, not a claim to have read the missing script. Fresh plan review must inspect the finder script if supplied, or explicitly accept this evidence limitation before execution.

The designer's wrapped `reports/issue-469-design-evidence/baseline.cjs` extracts only fixture definitions from the existing commissioning tests, then uses unmodified commissioning and the real helper over fake device RPC methods. All three operations throw internal `502 chirpstack_unknown` with zero RPC calls. Apply settles to `not_applied`; rollback restores its `observed_once` snapshot; poll retains `queued`. The existing focused suite passes 105 tests and profile parity passes on the same base. Those passes miss the composition defect.

The HTTP action wrappers currently turn the internal 502 into HTTP 500 with bounded text. Preserve that behavior. Real gRPC errors carry numeric `error.code` plus `grpcStatus`; commissioning currently recognizes string names only, so the real-transport error fixtures below also expect `chirpstack_unknown`. Changing that mapping is separate work.

## File ownership

The executor claims exactly these product/test files, subject to coordinator confirmation that no other task owns them:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.js`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-commissioning/index.js`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js`
- `scripts/test-sdi12-recipe-flow.js`

This plan also remains in the execution branch. Record execution evidence in the campaign report directory. The coordinator owns ledger updates; this design does not mutate the ledger.

No helper implementation/test change, shared test-harness change, package/lockfile change, schema/seed change, GUI change, server companion, or `flows.json` edit is required. PR #473 already supplied client cleanup; PR #503 already supplied current commissioning behavior. Both are in the runtime base. If a failing regression requires a flow edit, stop for a reviewed scope amendment with exact node ownership, script-only editing and the flow gate set from `osi-flows-json-editing`; do not expand this plan during execution.

## Invariants

Keep the frame loop sequential. Each compiler frame must reach the protobuf bytes field as its original Buffer, with uppercase device EUI, `fPort=2`, `confirmed=true`, and no queue-item expiry. Preserve returned queue IDs in order and every current state transition, compensation path and queue ownership rule. Never flush an unrelated command.

RPC calls retain the helper's finite deadline: default 20,000 ms, existing environment override capped at 120,000 ms. `commissioning_deadline_at` remains exactly 12 hours after `queued_at`; it is an observation/reconciliation window, not an RPC budget or `expiresAt`. Draining recipe IDs leaves status `queued` until observations qualify compatibility. An unrelated queue item must not prevent recording the recipe drain.

Keep `client.close()` in each action/poll `finally`. The tests retain the actual close implementation and observe closure of all five service clients on successful and failed operations. Close the constructor's device channel before replacing its transport in the fixture.

## Execution preflight

Read `AGENTS.md`, `docs/engineering-playbook.md` and the common-pitfalls, flows-json-editing, verification-commands, agronomy-sensors-reference and anti-slop-writing skills. The campaign's restrictions apply: no installs, push, PR/GitHub writes, live/production access or children during this assignment. Hardware acceptance stays pending.

All commands below run from the assigned isolated checkout. Resolve binaries before admission with the shell builtin `command -v python3 git node`. Every test, probe, checker and extraction uses the wrapper. Wait for the lock; a hold or fault is a stop/report result. Never delete admission/registration files or run a command outside the wrapper to evade a refusal.

```bash
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py git status --short --branch
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py git rev-parse HEAD
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py git rev-list --left-right --count HEAD...63c7a70f8f3b373f162b33b0669b0df89b3763fa
```

Expected: clean assigned branch, with the reviewed plan as the only additional commit(s) above the runtime base. Verify the explicit base-to-head diff contains only that plan before starting. Record base, plan SHA, checkout, environment overrides and command exit statuses in `reports/issue-469-execution.md`. Any different runtime base needs a drift assessment and fresh plan review. Refresh the issue/comments and existing PR overlap through read-only GitHub tools before execution; do not adopt a competing implementation silently.

Run the base gates in the gate section before editing. The existing focused command must report 105 passing tests; any unrelated red base gate stops that surface for coordinator disposition. Missing dependencies are a prerequisite failure, not authorization to install.

## Step 1: add regressions while keeping the runtime broken

First append this contract test to the canonical commissioning `index.test.js`. It uses the existing `makeClient()` fixture and a real helper. Leave the legacy fixture names unchanged for this red run.

```js
test('commissioning fixture uses the shipped helper contract', () => {
  const real = require('../osi-chirpstack-helper').createClient({
    apiUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-key',
  });
  try {
    const fixture = makeClient();
    for (const name of ['getDeviceQueue', 'enqueueDownlink', 'flushDeviceQueue']) {
      assert.equal(typeof real[name], 'function', `real helper: ${name}`);
      assert.equal(typeof fixture[name], 'function', `fixture: ${name}`);
    }
    for (const name of ['listDeviceQueue', 'enqueueDeviceDownlink']) {
      assert.equal(typeof real[name], 'undefined');
      assert.equal(typeof fixture[name], 'undefined');
    }
  } finally {
    assert.deepEqual(real.close(), []);
  }
});
```

In `scripts/test-sdi12-recipe-flow.js`, add `facadeDb` to the existing destructured import from `./lib/flow-node-harness`. Append the following code. These tests use both shipped profile modules and nodes. The only production-method substitutions are the explicit missing-method negative controls; successful and RPC-failure cases retain the real helper methods and real commissioning functions. No server or socket is opened by this fixture.

```js
const RECIPE_EUI = 'A840410000000043';
const RECIPE_SERVICES = [
  'deviceClient', 'applicationClient', 'tenantClient', 'deviceProfileClient', 'gatewayClient',
];

function recipeModules(profile) {
  const directory = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
  const helperPath = path.join(directory, 'node-red/osi-chirpstack-helper/index.js');
  const localRequire = require('node:module').createRequire(helperPath);
  return {
    flowPath: path.join(directory, 'flows.json'),
    commissioning: require(path.join(directory, 'node-red/osi-sdi12-commissioning')),
    helper: require(helperPath),
    pb: localRequire('@chirpstack/chirpstack-api/api/device_pb'),
  };
}

function recipeTransport(modules, scenario) {
  const client = modules.helper.createClient({
    apiUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-key',
  });
  const rpc = [];
  const frames = [];
  const accepted = [];
  const closed = [];
  let queueIds = scenario === 'nonempty' ? ['unrelated'] : [];
  let creations = 0;
  client.deviceClient.close();
  for (const name of RECIPE_SERVICES.slice(1)) {
    const close = client[name].close.bind(client[name]);
    client[name].close = () => { closed.push(name); return close(); };
  }
  function record(method, request, options) {
    rpc.push({
      method, eui: method === 'getQueue' ? request.getDevEui() : request.getQueueItem().getDevEui(),
      budget: options.deadline.getTime() - Date.now(),
    });
  }
  function unavailable(callback) {
    callback(Object.assign(new Error('private transport detail'), { code: 14 }));
  }
  client.deviceClient = {
    close() { closed.push('deviceClient'); },
    flushQueue() { throw new Error('recipe must never flush the device queue'); },
    getQueue(request, metadata, options, callback) {
      record('getQueue', request, options);
      if (scenario === 'get_error' || scenario === 'rpc_error') return unavailable(callback);
      const response = new modules.pb.GetDeviceQueueItemsResponse();
      response.setResultList(queueIds.map((id) => {
        const item = new modules.pb.DeviceQueueItem();
        item.setId(id);
        item.setFPort(2);
        item.setData(Buffer.from([0, 255, 65]));
        item.setConfirmed(true);
        return item;
      }));
      callback(null, response);
    },
    enqueue(request, metadata, options, callback) {
      record('enqueue', request, options);
      const item = request.getQueueItem();
      frames.push({
        eui: item.getDevEui(), port: item.getFPort(), confirmed: item.getConfirmed(),
        buffer: Buffer.isBuffer(item.getData()), bytes: Buffer.from(item.getData_asU8()),
        expires: item.hasExpiresAt(),
      });
      if (scenario === 'enqueue_zero' || (scenario === 'enqueue_partial' && frames.length === 4)) {
        return unavailable(callback);
      }
      const response = new modules.pb.EnqueueDeviceQueueItemResponse();
      const id = scenario === 'missing_id' ? '' : `recipe-${frames.length}`;
      response.setId(id);
      if (id) accepted.push(id);
      callback(null, response);
    },
  };
  if (scenario === 'missing_queue_method') client.getDeviceQueue = undefined;
  if (scenario === 'missing_enqueue_method') client.enqueueDownlink = undefined;
  return {
    client, rpc, frames, accepted, closed,
    setQueue(ids) { queueIds = ids; },
    factory: { createProvisioningClientFromEnv() { creations += 1; return client; } },
    assertClosed() {
      assert.equal(creations, 1);
      assert.deepEqual(closed.slice().sort(), RECIPE_SERVICES.slice().sort());
    },
  };
}

function recipeRow(db) {
  return { ...db.prepare('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?').get(RECIPE_EUI) };
}

function recipeDevice(db) {
  return { ...db.prepare('SELECT * FROM devices WHERE deveui = ?').get(RECIPE_EUI) };
}

async function seedRealRecipe(db, commissioning, rollback) {
  insertDevice(db, { deveui: RECIPE_EUI });
  const layout = {
    version: 1, address: '0',
    sensors: [
      { channel: 2, response_position: 2, depth_cm: 30, type: 'ENVIROSCAN' },
      { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
    ],
  };
  const save = (value) => commissioning.saveSentekLayout(facadeDb(db), {
    deveui: RECIPE_EUI, profileId: 'SENTEK_ENVIROSCAN', layout: value,
    depths: { vwc_1: 10, soil_vic_1: 10, vwc_2: 30 },
  });
  await save(layout);
  const target = JSON.parse(recipeRow(db).desired_recipe_json);
  if (rollback) {
    db.prepare('UPDATE sdi12_recipe_deployments SET compatible_recipe_json = desired_recipe_json, ' +
      'compatible_layout_json = ?, compatible_at = ? WHERE deveui = ?')
      .run(recipeDevice(db).sdi12_channel_layout_json, new Date().toISOString(), RECIPE_EUI);
    await save({ ...layout, address: 'C' });
  }
  assert.equal(target.frames.length, 12);
  return target;
}

function assertRecipeRpc(transport, target) {
  const configured = Number(process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS);
  const expected = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 120000) : 20000;
  for (const call of transport.rpc) {
    assert.equal(call.eui, RECIPE_EUI);
    assert.ok(Number.isFinite(call.budget) && call.budget > 0);
    assert.ok(call.budget <= expected && call.budget >= expected - 1000);
  }
  for (const [index, frame] of transport.frames.entries()) {
    assert.equal(frame.eui, RECIPE_EUI);
    assert.equal(frame.port, 2);
    assert.equal(frame.confirmed, true);
    assert.equal(frame.buffer, true);
    assert.equal(frame.expires, false);
    assert.deepEqual(frame.bytes, Buffer.from(target.frames[index].base64, 'base64'));
  }
}

for (const profile of ['bcm2712', 'bcm2709']) {
  for (const operation of ['apply', 'rollback']) {
    for (const scenario of [
      'success', 'nonempty', 'get_error', 'enqueue_zero', 'enqueue_partial', 'missing_id',
      'missing_queue_method', 'missing_enqueue_method',
    ]) {
      test(`real composition ${profile} ${operation} ${scenario}`, async () => {
        const modules = recipeModules(profile);
        const db = seedTestDb();
        const transport = recipeTransport(modules, scenario);
        try {
          const target = await seedRealRecipe(db, modules.commissioning, operation === 'rollback');
          const before = recipeRow(db);
          const deviceBefore = recipeDevice(db);
          const execution = await executeFunction(loadNode(`sdi12-recipe-${operation}-action-fn`, modules.flowPath), {
            msg: { deviceRow: { deveui: RECIPE_EUI.toLowerCase() }, req: { body: {} } }, db,
            osiLibModules: { 'sdi12-commissioning': modules.commissioning, chirpstack: transport.factory },
          });
          const success = scenario === 'success';
          const expectedStatus = success ? 202 : scenario === 'nonempty' ? 409 : 500;
          assert.equal(execution.result.statusCode, expectedStatus);
          assert.deepEqual(execution.errors, []);
          assert.deepEqual(execution.warnings, []);
          transport.assertClosed();
          assertRecipeRpc(transport, target);
          const expectedRpc = scenario === 'missing_queue_method' ? [] : ['getQueue'];
          const attempts = success ? 12 : scenario === 'enqueue_partial' ? 4 :
            ['enqueue_zero', 'missing_id'].includes(scenario) ? 1 : 0;
          assert.deepEqual(transport.rpc.map((call) => call.method), expectedRpc.concat(Array(attempts).fill('enqueue')));
          const row = recipeRow(db);
          if (success) {
            assert.equal(row.status, 'queued');
            assert.equal(row.desired_version, before.desired_version + (operation === 'rollback' ? 1 : 0));
            assert.deepEqual(JSON.parse(row.queue_item_ids_json), transport.accepted);
            assert.equal(transport.accepted.length, 12);
            assert.equal(row.queue_drained_at, null);
            assert.equal(row.last_error_code, null);
            assert.equal(Date.parse(row.commissioning_deadline_at) - Date.parse(row.queued_at), 12 * 3600000);
            assert.deepEqual(execution.result.payload, modules.commissioning.projectDeployment(row));
            assert.equal(recipeDevice(db).sdi12_channel_layout_json, operation === 'rollback' ? before.compatible_layout_json : deviceBefore.sdi12_channel_layout_json);
            assert.equal(recipeDevice(db).sync_version, deviceBefore.sync_version + (operation === 'rollback' ? 1 : 0));
          } else {
            assert.deepEqual(execution.result.payload, {
              message: 'SDI-12 recipe deployment failed',
              code: scenario === 'nonempty' ? 'device_queue_not_empty' : 'chirpstack_unknown',
            });
            assert.equal(JSON.stringify(execution.result.payload).includes('private transport detail'), false);
            assert.deepEqual(recipeDevice(db), deviceBefore);
            if (operation === 'rollback' && scenario !== 'enqueue_partial') {
              assert.deepEqual(row, before);
            } else {
              const partial = scenario === 'enqueue_partial';
              assert.equal(row.status, partial ? 'degraded' : 'not_applied');
              assert.equal(row.last_error_code, scenario === 'nonempty' ? 'device_queue_not_empty' : 'chirpstack_unknown');
              assert.deepEqual(row.queue_item_ids_json && JSON.parse(row.queue_item_ids_json), partial ? transport.accepted : null);
              assert.equal(transport.accepted.length, partial ? 3 : 0);
              assert.equal(row.queue_drained_at, null);
              if (partial) assert.equal(Date.parse(row.commissioning_deadline_at) - Date.parse(row.queued_at), 12 * 3600000);
              else assert.equal(row.commissioning_deadline_at, null);
            }
          }
        } finally {
          transport.client.close();
          db.close();
        }
      });
    }
  }
  for (const scenario of ['retained', 'unrelated', 'empty', 'rpc_error', 'deadline']) {
    test(`real composition ${profile} queued poll ${scenario}`, async () => {
      const modules = recipeModules(profile);
      const db = seedTestDb();
      const transport = recipeTransport(modules, scenario);
      try {
        const target = await seedRealRecipe(db, modules.commissioning, false);
        const now = new Date().toISOString();
        const deadline = new Date(Date.parse(now) + 12 * 3600000).toISOString();
        db.prepare('UPDATE sdi12_recipe_deployments SET status = ?, queue_item_ids_json = ?, ' +
          'queued_at = ?, commissioning_deadline_at = ? WHERE deveui = ?')
          .run('queued', '["recipe-1","recipe-2"]', now, deadline, RECIPE_EUI);
        const before = recipeRow(db);
        transport.setQueue(['retained', 'deadline'].includes(scenario) ? ['recipe-2', 'unrelated'] : scenario === 'unrelated' ? ['unrelated'] : []);
        if (scenario === 'deadline') {
          await modules.commissioning.pollDeployments(facadeDb(db), transport.client, { now: deadline });
          transport.client.close();
          assert.deepEqual(transport.closed.slice().sort(), RECIPE_SERVICES.slice().sort());
        } else {
          const execution = await executeFunction(loadNode('sdi12-recipe-poll-fn', modules.flowPath), {
            msg: {}, db,
            osiLibModules: { 'sdi12-commissioning': modules.commissioning, chirpstack: transport.factory },
          });
          assert.equal(execution.result, null);
          assert.deepEqual(execution.errors, []);
          assert.deepEqual(execution.warnings, scenario === 'rpc_error' ? ['SDI12 recipe poll failed code=chirpstack_unknown'] : []);
          transport.assertClosed();
        }
        assertRecipeRpc(transport, target);
        assert.deepEqual(transport.rpc.map((call) => call.method), ['getQueue']);
        assert.deepEqual(transport.frames, []);
        const row = recipeRow(db);
        assert.equal(row.queue_item_ids_json, before.queue_item_ids_json);
        assert.equal(row.commissioning_deadline_at, deadline);
        assert.equal(row.desired_version, before.desired_version);
        assert.equal(row.compatible_recipe_json, before.compatible_recipe_json);
        if (['retained', 'rpc_error'].includes(scenario)) assert.deepEqual(row, before);
        else if (scenario === 'deadline') {
          assert.equal(row.status, 'degraded');
          assert.equal(row.last_error_code, 'queue_delivery_timeout');
          assert.equal(row.queue_drained_at, null);
        } else {
          assert.equal(row.status, 'queued');
          assert.ok(Number.isFinite(Date.parse(row.queue_drained_at)));
          assert.ok(Date.parse(row.queue_drained_at) >= Date.parse(now));
          assert.equal(row.last_error_code, null);
          assert.equal(row.observed_count, 0);
        }
      } finally {
        transport.client.close();
        db.close();
      }
    });
  }
}
```

Mirror the canonical commissioning test file to bcm2709 using the wrapper around `python3` and `shutil.copyfile`, or the repository editor. Run the focused tests below. On the broken runtime, the new fixture-contract test fails at `fixture: getDeviceQueue`. Real apply/rollback success tests return 500 instead of 202 before RPC. Real queued-poll success tests warn `chirpstack_unknown` before RPC; the direct exact-deadline poll throws the same bounded error. Tests must fail for those contract reasons, with valid seeds and imports. A syntax/import/fixture failure is a plan defect: stop and report it.

Negative controls explicitly remove each new method from the real instance. They must keep returning bounded 500 after the repair, with zero RPCs for missing queue lookup and only `getQueue` for missing enqueue. The permanent tests cannot pass by restoring legacy adapters in their normal fixture.

The designer extracted these exact additions into campaign-only runners without changing any tracked test or runtime file. Baseline results were commissioning 32 tests, 31 pass, one contract failure; flow 76 tests, 38 pass, 38 fail, no cancellations/skips. For each profile, every apply/rollback case except `missing_queue_method` failed (14 failures), and all five queued-poll cases failed. This is 19 failures per profile. The four `missing_queue_method` controls passed; the existing flow cases also passed. Logs are `reports/issue-469-design-evidence/commissioning-planned-red.tap` and `flow-planned-red.tap`. No candidate runtime was tested in this design stage.

## Step 2: align callers and their unit fixtures

In the canonical commissioning `index.js`, make exactly these replacements, with occurrence-count assertions before writing:

```python
from pathlib import Path
p = Path('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.js')
source = p.read_text()
assert source.count('client.listDeviceQueue(') == 3
assert source.count('client.enqueueDeviceDownlink(') == 2
source = source.replace('client.listDeviceQueue(', 'client.getDeviceQueue(')
source = source.replace('client.enqueueDeviceDownlink(', 'client.enqueueDownlink(')
p.write_text(source)
```

Run that edit via `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py python3` with the block on stdin. In the canonical commissioning test file, replace `listDeviceQueue` with `getDeviceQueue` and `enqueueDeviceDownlink` with `enqueueDownlink` only in the original pre-existing source preceding the appended contract test. This updates fixture definitions, option hooks and error-step labels while retaining the contract test's assertions that the old names are absent. Do not alter any assertion about persisted state, trigger/outbox effects, observations, compensation or concurrent claims.

Use this complete fixture/mirror edit through the same wrapped Python invocation:

```python
from pathlib import Path
from shutil import copyfile
canonical = Path('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning')
mirror = Path('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-commissioning')
p = canonical / 'index.test.js'
marker = "test('commissioning fixture uses the shipped helper contract'"
original, separator, contract = p.read_text().partition(marker)
assert separator and original.count('listDeviceQueue') > 0 and original.count('enqueueDeviceDownlink') > 0
original = original.replace('listDeviceQueue', 'getDeviceQueue').replace('enqueueDeviceDownlink', 'enqueueDownlink')
p.write_text(original + separator + contract)
for name in ['index.js', 'index.test.js']:
    copyfile(canonical / name, mirror / name)
    assert (canonical / name).read_bytes() == (mirror / name).read_bytes()
```

Copy canonical `index.js` and `index.test.js` byte-for-byte to their bcm2709 paths. Run the focused command again. Expected: 148 tests pass, zero failures, including the 42 new composition cases across both profiles and the new fixture-contract test. If the count or behavior differs, inspect and report the divergence before committing.

The runtime diff must contain only three queue-call renames and two enqueue-call renames in each profile. Inspect the explicit base diff, including both test copies. Never add aliases to `osi-chirpstack-helper` to satisfy these tests.

## Step 3: gates and commit

Use these commands on base before editing and on the candidate after Step 2. They run sequentially through the campaign wrapper; capture each command's actual status and full output file. The canonical helper suite covers its existing expiry, deadline configuration and five-client-close behavior; the new flow cases cover composition, so no helper-test edit is needed.

```bash
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js scripts/test-sdi12-recipe-flow.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node --test conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node scripts/verify-profile-parity.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node scripts/verify-sync-flow.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node scripts/verify-no-new-silent-catch.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-26-issue-469-sdi12-helper-alignment.md
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py node scripts/verify-doc-hygiene.js
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py git diff --check
```

Expected: Node tests exit 0; profile parity ends `All parity checks passed.`; sync verification prints `Sync flow verification passed` and chained parity success; silent-catch exits 0; prose checker prints `slop-check: PASS (no tier-1 findings)`; documentation hygiene exits 0; diff check has no output. Inspect tier-2 prose warnings individually. Documentation hygiene without the private term list covers built-in identifier rules only; record that limit.

No GUI build, migration replay, decoder gate or live check is justified by these method-name changes. Flow content remains unchanged, so the full set of mutation-specific flow gates is conditional on an approved amendment. Both profile paths are exercised by the new tests and their test files are mirrored; `verify-profile-parity` also covers the payload tree.

After green gates, stage exactly the five claimed files and the reviewed plan if it is not already committed. Commit once as `fix: align SDI-12 commissioning with ChirpStack helper`. Capture candidate SHA with wrapped `git rev-parse HEAD`. Run wrapped `git diff --check 63c7a70f8f3b373f162b33b0669b0df89b3763fa HEAD`, `git diff --stat 63c7a70f8f3b373f162b33b0669b0df89b3763fa HEAD`, `git diff 63c7a70f8f3b373f162b33b0669b0df89b3763fa HEAD --` with the five file paths, and `git status --short --branch`. A post-commit empty working-tree diff does not prove the committed patch.

Record the red regression output, final gate logs, expected assertions, exact base/head, file claims, private-term-list availability and hardware limit in the execution report. Do not push or create a PR from the executor assignment.

## Review and acceptance handoff

A fresh independent Sol reviewer must challenge this plan against the base, seeds, helper/protobuf APIs and scope before implementation. The author cannot approve it. Review must resolve the unavailable finder-script artifact and inspect the proposed regression code for false passes, including empty-queue mocks, missing-ID responses and callback errors.

After execution, a fresh Sol verifier reruns the named gates at the exact candidate SHA, checks every base-to-head hunk, and proves the normal real-helper cases go red when the two call-name repairs are reverted in an isolated verification copy. It must also see the missing-method controls return bounded failures and both profile cases exercise the intended modules. Restore no files in another task's checkout. Any repair invalidates affected reviews and needs fresh verification.

Then obtain independent Claude Opus review at that same SHA, after Sol verification, through the coordinator. Campaign selection is `claudeAgent`, `claude-opus-5-5`, `effort=high`, `fastMode=false`; recheck live capability and subscription availability. The recorded quota hold forbids repeated failed dispatches or paid fallback. Keep the candidate pending until review capacity returns. This plan author spawns no children.

Offline acceptance proves caller/helper composition, request bytes and state handling through fake RPC callbacks. It does not prove grpc-js wire transport, a deployed ChirpStack service, radio reception, sensor firmware execution or field incidence. Apply and rollback on a test gateway with an SDI-12 node remain an explicit outstanding issue acceptance item. No live gateway operation is authorized by this plan or campaign. The coordinator must retain that limit in any later draft PR and disposition of issue #469.
