'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ALLOWLIST,
  INLINE_ACCOUNT_CHECKS,
  PHASE_C_PENDING,
  PROFILES,
  findFailures,
  verifyProfiles,
} = require('./verify-scoped-access');

const ROOT = path.resolve(__dirname, '..');
const PROFILE =
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const MIRROR =
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json';

function loadFlows(profile = PROFILE) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, profile), 'utf8'));
}

// Probing every route takes seconds; a mutation test only needs the entries
// it changed, so it names them. The full-tree test below probes everything.
function failuresFor(flows, ids, allowlist = ALLOWLIST) {
  return findFailures(flows, 'mutation', allowlist, { only: new Set(ids) })
    .then((failures) => failures.join('\n'));
}

// A synthetic guarded route: http in -> guard -> worker -> response. The guard
// resolves the caller like the shipped guards do, then runs `decision`; the
// worker writes to the device row. Each bypass test swaps one piece.
const RESOLVE_CALLER = `
const scope = osiLib.require('scope').value;
const db = new (osiLib.require('osi-db-helper').value.Database)('/data/db/farming.db');
const auth = scope.verifyBearer(msg.req.headers.authorization, { configuredSecret: env.get('AUTH_TOKEN_SECRET') });
const actor = await db.get('SELECT user_uuid, role FROM users WHERE id = ? AND username = ?', [auth.userId, auth.username]);
const deveui = msg.req.params.deveui;
`;

const DECIDE = `
await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
`;

const WRITE_DEVICE = `
return (async () => {
  const db = new (osiLib.require('osi-db-helper').value.Database)('/data/db/farming.db');
  await db.run('UPDATE devices SET name = ? WHERE deveui = ?', ['renamed', msg.req.params.deveui]);
  msg.statusCode = 200;
  msg.payload = { ok: true };
  return msg;
})();
`;

function guardBody(decision) {
  return `
return (async () => {
${RESOLVE_CALLER}
try {
${decision}
} catch (error) {
  msg.statusCode = Number(error.statusCode || 500);
  msg.payload = { message: 'denied' };
  return [null, msg];
}
return [msg, null];
})();
`;
}

const OSI_LIB = [{ var: 'osiLib', module: 'osi-lib' }];

function addRoute(flows, id, options = {}) {
  const method = options.method || 'put';
  const entryTargets = options.entryTargets || [`${id}-guard`];
  flows.push(
    {
      id,
      type: 'http in',
      method,
      url: `/api/devices/:deveui/${id}`,
      wires: [entryTargets],
    },
    {
      id: `${id}-guard`,
      type: 'function',
      func: options.guardFunc || guardBody(options.decision === undefined ? DECIDE : options.decision),
      libs: OSI_LIB,
      outputs: 2,
      wires: [[`${id}-worker`], [`${id}-response`]],
    },
    {
      id: `${id}-worker`,
      type: 'function',
      func: options.workerFunc || WRITE_DEVICE,
      libs: OSI_LIB,
      outputs: 1,
      wires: [[`${id}-response`]],
    },
    {
      id: `${id}-response`,
      type: 'http response',
      wires: [],
    }
  );
  return flows;
}

test('maintained profiles satisfy the scoped-access ratchet', async () => {
  assert.deepEqual(await verifyProfiles(), []);
});

test('new unguarded HTTP endpoint fails the ratchet', async () => {
  const flows = loadFlows();
  flows.push({
    id: 'ratchet-negative-http',
    type: 'http in',
    method: 'get',
    url: '/api/ratchet-negative',
    wires: [['ratchet-negative-fn']],
  });
  flows.push({
    id: 'ratchet-negative-fn',
    type: 'function',
    func: 'return msg;',
    wires: [[]],
  });

  assert.match(
    await failuresFor(flows, ['ratchet-negative-http']),
    /ratchet-negative-http.*has no scope call/
  );
});

test('removing the scope call from a guarded chain fails the ratchet', async () => {
  const flows = loadFlows();
  const route = flows.find((node) => node.id === 'sync-state-http');
  assert.ok(route, 'sync-state-http fixture exists');

  const byId = new Map(flows.map((node) => [node.id, node]));
  const guardId = route.wires.flat()[0];
  const guard = byId.get(guardId);
  assert.ok(guard, 'sync state guard exists');
  guard.func = guard.func.replace("osiLib.require('scope')", 'undefined');

  assert.match(
    await failuresFor(flows, ['sync-state-http']),
    /sync-state-http.*has no scope call/
  );
});

test('public endpoint exemption is exact and remove-one controlled', async () => {
  const flows = loadFlows();
  const withoutLogin = new Set(ALLOWLIST);
  withoutLogin.delete('auth-login-http');

  assert.match(
    await failuresFor(flows, ['auth-login-http'], withoutLogin),
    /auth-login-http.*has no scope call/
  );
});

test('temporary Phase C debt is exact and remove-one controlled', async () => {
  // sys-reboot-in used to be the fixture here. It now makes its own admin
  // decision (scope.assertAuthenticatedRole) before the reboot is scheduled,
  // so it left the debt list; the stale-entry test below keeps it out.
  // valve-list-get-http is debt with no scope decision anywhere on its path.
  const flows = loadFlows();
  assert.ok(PHASE_C_PENDING.has('valve-list-get-http'));
  assert.ok(!PHASE_C_PENDING.has('sys-reboot-in'));
  const withoutValveList = new Set(ALLOWLIST);
  withoutValveList.delete('valve-list-get-http');

  assert.match(
    await failuresFor(flows, ['valve-list-get-http'], withoutValveList),
    /valve-list-get-http.*has no scope call/
  );
});

test('umbrella verifier and workflow pin the scoped-access command and its tests', () => {
  const umbrella = fs.readFileSync(path.join(ROOT, 'scripts/verify-sync-flow.js'), 'utf8');
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/verify-sync-flow.yml'),
    'utf8'
  );
  assert.match(umbrella, /verify-scoped-access\.js/);
  assert.match(workflow, /name: Scoped-access endpoint ratchet[\s\S]*node scripts\/verify-scoped-access\.js/);
  assert.match(workflow, /node --test scripts\/verify-scoped-access\.test\.js/);
});

// ---------------------------------------------------------------------------
// Bypasses: each one removes, hides or misplaces the decision of a guard that
// is otherwise shaped like the shipped ones.

test('a synthetic guard that decides before the write passes', async () => {
  const flows = addRoute(loadFlows(), 'probe-good-http');
  assert.equal(await failuresFor(flows, ['probe-good-http']), '');
});

test('a scope call whose denial is swallowed fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-swallowed-http', {
    decision: `
try {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
} catch (ignored) {}
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-swallowed-http']),
    /probe-swallowed-http.*goes on after its scope decision said no.*UPDATE devices/
  );
});

test('a scope call that is not awaited fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-unawaited-http', {
    decision: `
scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-unawaited-http']),
    /probe-unawaited-http.*goes on after its scope decision said no/
  );
});

test('a boolean decision whose result is ignored fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-ignored-http', {
    decision: `
const allowed = await scope.isAdmin(db, actor.user_uuid, { scopedMode: true });
void allowed;
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-ignored-http']),
    /probe-ignored-http.*goes on after its scope decision said no/
  );
});

test('a scope call in a branch the route does not take fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-branch-http', {
    method: 'put',
    decision: `
if (msg.req.method === 'POST') {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
}
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-branch-http']),
    /probe-branch-http.*has no scope call/
  );
});

test('a second wire from the entry around the guard fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-forked-http', {
    entryTargets: ['probe-forked-http-guard', 'probe-forked-http-worker'],
  });
  assert.match(
    await failuresFor(flows, ['probe-forked-http']),
    /probe-forked-http.*reads or writes data before its scope decision.*probe-forked-http-worker/
  );
});

test('a scope call placed after the write fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-late-write-http', {
    decision: `
await db.run('UPDATE devices SET name = ? WHERE deveui = ?', ['early', deveui]);
await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-late-write-http']),
    /probe-late-write-http.*reads or writes data before its scope decision.*UPDATE devices/
  );
});

test('a scope call placed after a read of sensor data fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-late-read-http', {
    decision: `
msg.rows = await db.all('SELECT * FROM device_data WHERE deveui = ?', [deveui]);
await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-late-read-http']),
    /probe-late-read-http.*reads or writes data before its scope decision.*device_data/
  );
});

test('a guard that exists but is not wired into the path fails the ratchet', async () => {
  const flows = addRoute(loadFlows(), 'probe-unwired-http', {
    entryTargets: ['probe-unwired-http-worker'],
  });
  assert.match(
    await failuresFor(flows, ['probe-unwired-http']),
    /probe-unwired-http.*has no scope call/
  );
});

test('a chain the probe cannot simulate fails closed and names the entry', async () => {
  const flows = loadFlows();
  flows.push(
    {
      id: 'probe-opaque-http',
      type: 'http in',
      method: 'get',
      url: '/api/probe-opaque',
      wires: [['probe-opaque-change']],
    },
    {
      id: 'probe-opaque-change',
      type: 'change',
      rules: [],
      wires: [[]],
    }
  );
  assert.match(
    await failuresFor(flows, ['probe-opaque-http']),
    /probe-opaque-http.*cannot be analysed.*change node/
  );
});

test('a guard that uses something the probe does not provide fails closed', async () => {
  const flows = addRoute(loadFlows(), 'probe-unknown-global-http', {
    guardFunc: `
return (async () => {
  await notProvidedAnywhere.check(msg.req.params.deveui);
  return [msg, null];
})();
`,
  });
  const text = await failuresFor(flows, ['probe-unknown-global-http']);
  assert.match(text, /probe-unknown-global-http.*cannot be analysed.*notProvidedAnywhere/);
  assert.match(text, /probe-unknown-global-http.*has no scope call/);
});

test('an unguarded route in the mirror profile alone fails and names that profile', async () => {
  const load = (profile) => {
    const flows = loadFlows(profile);
    if (profile === MIRROR) addRoute(flows, 'probe-mirror-http', { entryTargets: ['probe-mirror-http-worker'] });
    return flows;
  };
  const failures = await verifyProfiles(PROFILES, { load, only: new Set(['probe-mirror-http']) });
  const text = failures.join('\n');
  assert.match(text, /bcm2709.*probe-mirror-http.*has no scope call/);
  assert.doesNotMatch(text, /bcm2712.*probe-mirror-http/);
});

test('an allowlisted route that now makes its own decision is reported as stale', async () => {
  const flows = loadFlows();
  const withStale = new Set(ALLOWLIST);
  withStale.add('sync-state-http');
  assert.match(
    await failuresFor(flows, ['sync-state-http'], withStale),
    /sync-state-http.*is allowlisted but makes its scope decision/
  );
});

test('an allowlist entry that names no route fails', async () => {
  const flows = loadFlows();
  const withUnknown = new Set(ALLOWLIST);
  withUnknown.add('no-such-route-http');
  assert.match(
    await failuresFor(flows, [], withUnknown),
    /no-such-route-http.*matches no http in node/
  );
});

test('an inline account check that stops refusing a disabled account fails', async () => {
  assert.ok(INLINE_ACCOUNT_CHECKS.has('history-zone-cards-http'));
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'history-api-router-fn');
  const check = "if (!user || user.disabled_at) HR.httpError(403, 'forbidden');";
  assert.ok(router.func.includes(check), 'history router keeps its inline account check');
  router.func = router.func.replace(check, '');
  assert.match(
    await failuresFor(flows, ['history-zone-cards-http']),
    /history-zone-cards-http.*does not refuse a disabled account/
  );
});
