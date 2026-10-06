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
  cacheFileFor,
  findFailures,
  isDenialRecord,
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
// resolves the caller like the shipped guards do, then runs `decision` (by
// default the shipped order: role, write role, device); the worker writes to
// the device row. Each bypass test swaps one piece.
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

// The order the shipped write guards decide in: the caller's role, whether
// that role may write, then the addressed object.
const ROLE_CHECKS = `
const actorScope = await scope.assertFreshRole(db, actor.user_uuid, actor.role, { scopedMode: true });
if (!scope.canMutate(actorScope.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
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
      func: options.guardFunc || guardBody(options.decision === undefined ? ROLE_CHECKS + DECIDE : options.decision),
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

test('a synthetic guard that checks role, write role and device before the write passes', async () => {
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

// ---------------------------------------------------------------------------
// Several decisions in sequence: each one must be made and honoured, and a
// write must be preceded by a write-role decision and a decision on the object
// it addresses (#389 fix round 1).

test('a device check removed from behind the role checks fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-seq-no-object-http', { decision: ROLE_CHECKS });
  assert.match(
    await failuresFor(flows, ['probe-seq-no-object-http']),
    /probe-seq-no-object-http.*makes no scope decision on the device it addresses before it writes/
  );
});

test('a device check on another device fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-seq-other-object-http', {
    decision: ROLE_CHECKS + `
await scope.assertFreshDeviceAccess(db, actor.user_uuid, '00000000000000FF', { scopedMode: true });
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-seq-other-object-http']),
    /probe-seq-other-object-http.*makes no scope decision on the device it addresses before it writes/
  );
});

test('a swallowed device check behind the role checks fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-seq-swallowed-http', {
    decision: ROLE_CHECKS + `
try {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
} catch (ignored) {}
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-seq-swallowed-http']),
    /probe-seq-swallowed-http.*goes on after its scope decision said no.*UPDATE devices/
  );
});

test('a device check placed after the write, behind the role checks, fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-seq-late-http', {
    decision: ROLE_CHECKS + `
await db.run('UPDATE devices SET name = ? WHERE deveui = ?', ['early', deveui]);
` + DECIDE,
  });
  const text = await failuresFor(flows, ['probe-seq-late-http']);
  assert.match(text, /probe-seq-late-http.*writes before its scope decision 3 \(assertFreshDeviceAccess\) said no.*UPDATE devices/);
  assert.match(text, /probe-seq-late-http.*makes no scope decision on the device it addresses before it writes/);
});

test('a write-role check removed from the sequence fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-seq-no-mutate-http', {
    decision: `
await scope.assertFreshRole(db, actor.user_uuid, actor.role, { scopedMode: true });
` + DECIDE,
  });
  assert.match(
    await failuresFor(flows, ['probe-seq-no-mutate-http']),
    /probe-seq-no-mutate-http.*makes no write-role decision before it writes/
  );
});

test('a write-role check whose answer is ignored fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-seq-ignored-mutate-http', {
    decision: `
const actorScope = await scope.assertFreshRole(db, actor.user_uuid, actor.role, { scopedMode: true });
scope.canMutate(actorScope.role);
` + DECIDE,
  });
  assert.match(
    await failuresFor(flows, ['probe-seq-ignored-mutate-http']),
    /probe-seq-ignored-mutate-http.*goes on after its scope decision said no/
  );
});

test('a decision skipped when a query field is set fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-skip-query-http', {
    decision: ROLE_CHECKS + `
if (!msg.req.query.all) {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
}
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-skip-query-http']),
    /probe-skip-query-http.*skips or ignores its scope decision when the request sets a field/
  );
});

test('a decision skipped when a body flag is set fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-skip-body-http', {
    decision: ROLE_CHECKS + `
if (msg.payload.force !== true) {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
}
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-skip-body-http']),
    /probe-skip-body-http.*skips or ignores its scope decision when the request sets a field/
  );
});

test('rows of a refused request returned in its answer fail', async () => {
  const flows = addRoute(loadFlows(), 'probe-leaky-denial-http', {
    method: 'get',
    guardFunc: `
return (async () => {
${RESOLVE_CALLER}
const rows = await db.all('SELECT * FROM devices');
try {
  await scope.assertEnabledAccount(db, actor.user_uuid, { scopedMode: true });
} catch (error) {
  msg.statusCode = 403;
  msg.payload = { message: 'denied', rows };
  return [null, msg];
}
return [msg, null];
})();
`,
    workerFunc: 'msg.statusCode = 200; msg.payload = {}; return msg;',
  });
  assert.match(
    await failuresFor(flows, ['probe-leaky-denial-http']),
    /probe-leaky-denial-http.*answers 403 with fixture data/
  );
});

test('a read after the denial fails even on a resolution table', async () => {
  const flows = addRoute(loadFlows(), 'probe-read-after-denial-http', {
    method: 'get',
    guardFunc: `
return (async () => {
${RESOLVE_CALLER}
try {
  await scope.assertEnabledAccount(db, actor.user_uuid, { scopedMode: true });
} catch (error) {
  await db.all('SELECT name FROM devices');
  msg.statusCode = 403;
  msg.payload = { message: 'denied' };
  return [null, msg];
}
return [msg, null];
})();
`,
    workerFunc: 'msg.statusCode = 200; msg.payload = {}; return msg;',
  });
  assert.match(
    await failuresFor(flows, ['probe-read-after-denial-http']),
    /probe-read-after-denial-http.*goes on after its scope decision said no.*SELECT name FROM devices/
  );
});

test('the per-device filter of network observations is exercised', async () => {
  const flows = loadFlows();
  const handler = flows.find((node) => node.id === 'network-api-handler');
  const pass = 'scope:scopeHelper,';
  assert.ok(handler.func.includes(pass), 'handler hands the helper to the module');
  // Ignore the per-device answer: a denied device is treated as visible.
  handler.func = handler.func.replace(
    pass,
    'scope:scopeHelper && Object.assign({}, scopeHelper, { assertFreshDeviceAccess: async function() { ' +
      'try { return await scopeHelper.assertFreshDeviceAccess.apply(null, arguments); } ' +
      "catch (ignored) { return { role: 'researcher' }; } } }),"
  );
  assert.match(
    await failuresFor(flows, ['network-api-http-0']),
    /network-api-http-0.*goes on after its scope decision said no.*radio_uplinks/
  );
});

test('a CORS preflight route that reads data fails', async () => {
  const flows = loadFlows();
  const preflight = flows.find((node) => node.id === 'device-options-http');
  preflight.wires = [['probe-preflight-reader']];
  flows.push({
    id: 'probe-preflight-reader',
    type: 'function',
    libs: OSI_LIB,
    outputs: 1,
    func: `
return (async () => {
  const db = new (osiLib.require('osi-db-helper').value.Database)('/data/db/farming.db');
  msg.payload = await db.all('SELECT * FROM device_data');
  return msg;
})();
`,
    wires: [['device-options-response']],
  });
  assert.match(
    await failuresFor(flows, ['device-options-http']),
    /device-options-http.*is listed as a CORS preflight, yet it goes on.*device_data/
  );
});

test('an OPTIONS route that is not listed is probed like any other entry', async () => {
  const flows = loadFlows();
  flows.push(
    { id: 'probe-options-http', type: 'http in', method: 'options', url: '/api/probe-options', wires: [['probe-options-fn']] },
    { id: 'probe-options-fn', type: 'function', func: 'return msg;', wires: [[]] }
  );
  assert.match(
    await failuresFor(flows, ['probe-options-http']),
    /probe-options-http.*has no scope call/
  );
});

test('a node type the ratchet does not know fails closed', async () => {
  const flows = loadFlows();
  flows.push({ id: 'probe-websocket-in', type: 'websocket in', wires: [[]] });
  assert.match(
    await failuresFor(flows, []),
    /node type websocket in \(probe-websocket-in\) is neither an entry the ratchet probes nor a type it knows/
  );
});

test('an unawaited first decision is not hidden by a later write-role check', async () => {
  const flows = addRoute(loadFlows(), 'probe-masked-first-http', {
    decision: `
scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
if (!scope.canMutate(actor.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-masked-first-http']),
    /probe-masked-first-http.*goes on after its scope decision said no/
  );
});

// ---------------------------------------------------------------------------
// Outcome rule, reachable writes and admin routes (#389 fix round 2).

const WRITE_TARGET_FROM_BODY = `
return (async () => {
  const db = new (osiLib.require('osi-db-helper').value.Database)('/data/db/farming.db');
  const target = (msg.payload && msg.payload.target) || msg.req.params.deveui;
  await db.run('UPDATE devices SET name = ? WHERE deveui = ?', ['renamed', target]);
  msg.statusCode = 200;
  msg.payload = { ok: true };
  return msg;
})();
`;

test('a write on a device named in the body, after a check on the URL device, fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-body-target-http', { workerFunc: WRITE_TARGET_FROM_BODY });
  assert.match(
    await failuresFor(flows, ['probe-body-target-http']),
    /probe-body-target-http.*changes a row outside the caller's scope.*devices row/
  );
});

test('a bulk write across zones fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-bulk-http', {
    workerFunc: `
return (async () => {
  const db = new (osiLib.require('osi-db-helper').value.Database)('/data/db/farming.db');
  await db.run('UPDATE irrigation_schedules SET enabled = 0');
  msg.statusCode = 200;
  msg.payload = { ok: true };
  return msg;
})();
`,
  });
  assert.match(
    await failuresFor(flows, ['probe-bulk-http']),
    /probe-bulk-http.*changes a row outside the caller's scope.*irrigation_schedules/
  );
});

test('a device assignment that may take a device from another zone fails', async () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'scoped-device-assign-router');
  assert.ok(router.func.includes(' AND irrigation_zone_id IS NULL'));
  router.func = router.func.replace(' AND irrigation_zone_id IS NULL', '');
  assert.match(
    await failuresFor(flows, ['assign-device-http']),
    /assign-device-http.*changes a row outside the caller's scope \(URL .*devices row/
  );
});

test('a weather station zone set that skips the per-zone check fails', async () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'scoped-weather-zone-assign-router');
  const check = '    await scope.assertFreshZoneAccess(db, actor.user_uuid, zoneUuid, { scopedMode: true });\n';
  assert.ok(router.func.includes(check));
  router.func = router.func.replace(check, '');
  assert.match(
    await failuresFor(flows, ['s2120-zones-put-http']),
    /s2120-zones-put-http.*changes a row outside the caller's scope \(body .*weather_station_zones row added/
  );
});

test('a weather station zone set that removes an assignment outside the caller\'s scope fails', async () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'scoped-weather-zone-assign-router');
  const scoped = /  await run\(\n    'DELETE FROM weather_station_zones WHERE deveui = \? AND zone_id IN [^]*?\n  \);\n/;
  assert.match(router.func, scoped, 'the router removes only assignments to the caller\'s zones');
  router.func = router.func.replace(scoped, "  await run('DELETE FROM weather_station_zones WHERE deveui = ?', [deveui]);\n");
  assert.match(
    await failuresFor(flows, ['s2120-zones-put-http']),
    /s2120-zones-put-http.*changes a row outside the caller's scope \(the fixture request\): weather_station_zones row removed/
  );
});

const ADMIN_CHECK = /await scope\.assertFreshRole\(\s*db,\s*actor\.user_uuid,\s*'admin',\s*\{ scopedMode: true \}\s*\);/;

test('an admin route without a URL parameter needs an admin decision', async () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'scoped-admin-account-router');
  assert.match(router.func, ADMIN_CHECK);
  router.func = router.func.replace(ADMIN_CHECK,
    "const downgraded = await scope.assertFreshRole(db, actor.user_uuid, actor.role, { scopedMode: true }); " +
    "if (!scope.canMutate(downgraded.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });");
  const text = await failuresFor(flows, ['admin-zone-grant-http', 'admin-users-create-http']);
  assert.match(text, /admin-zone-grant-http.*makes no admin decision before it writes/);
  assert.match(text, /admin-users-create-http.*makes no admin decision before it writes/);
});

test('a swallowed admin decision fails once the write is reachable', async () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'scoped-admin-account-router');
  router.func = router.func.replace(ADMIN_CHECK,
    "try { await scope.assertFreshRole(db, actor.user_uuid, 'admin', { scopedMode: true }); } catch (ignored) {}");
  assert.match(
    await failuresFor(flows, ['admin-users-role-http']),
    /admin-users-role-http.*goes on after its scope decision said no.*UPDATE users/
  );
});

test('a swallowed outbox-recovery admin decision fails', async () => {
  const flows = loadFlows();
  const guard = flows.find((node) => node.id === 'sync-outbox-recover-admin-guard');
  const call = /const scope = await scopeLoad\.value\.authorizeAdminRead\(\{[\s\S]*?\}\);/;
  assert.match(guard.func, call);
  guard.func = guard.func.replace(call,
    'let scope = null; try { scope = await scopeLoad.value.authorizeAdminRead({ Database: osiDb.Database, ' +
    "authorization, configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'), " +
    "fs: global.get('fs'), warn: (message) => node.warn(message) }); } catch (ignored) {}");
  assert.match(
    await failuresFor(flows, ['sync-outbox-recover-http']),
    /sync-outbox-recover-http.*goes on after its scope decision said no: sync-outbox-recover-fn: read SELECT event_uuid/
  );
});

test('a write route whose write is never reached fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-unreached-http', {
    workerFunc: "msg.statusCode = 400; msg.payload = { message: 'always invalid' }; return msg;",
  });
  assert.match(
    await failuresFor(flows, ['probe-unreached-http']),
    /probe-unreached-http.*never reaches its write with every decision allowed/
  );
});

test('a decision skipped for a header or an `in` test fails', async () => {
  const flows = addRoute(loadFlows(), 'probe-skip-header-http', {
    decision: ROLE_CHECKS + `
if (!msg.req.headers['x-probe-internal']) {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
}
`,
  });
  addRoute(flows, 'probe-skip-in-http', {
    decision: ROLE_CHECKS + `
if (!('force' in msg.payload)) {
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
}
`,
  });
  const text = await failuresFor(flows, ['probe-skip-header-http', 'probe-skip-in-http']);
  assert.match(text, /probe-skip-header-http.*skips or ignores its scope decision when the request sets a field/);
  assert.match(text, /probe-skip-in-http.*skips or ignores its scope decision when the request sets a field/);
});

test('a denial record admits only the rejection write', () => {
  const base = { node: 'write-strega-expectation', tables: ['applied_commands'] };
  assert.equal(isDenialRecord({ ...base, write: false, detail: '[]' }), true);
  assert.equal(isDenialRecord({ ...base, write: true, detail: '["x","scope_denied"]' }), true);
  assert.equal(isDenialRecord({ ...base, write: true, detail: '["x","SUCCESS"]' }), false);
  assert.equal(isDenialRecord({ ...base, tables: ['applied_commands', 'devices'], write: false }), false);
});

test('mutated flows and subsets never use the cached verdict', () => {
  assert.equal(cacheFileFor(PROFILES, { load: () => [] }), null);
  assert.equal(cacheFileFor(PROFILES, { only: new Set(['x']) }), null);
  const saved = process.env.OSI_SCOPED_ACCESS_RATCHET_CACHE;
  process.env.OSI_SCOPED_ACCESS_RATCHET_CACHE = '0';
  try {
    assert.equal(cacheFileFor(PROFILES, {}), null);
  } finally {
    if (saved === undefined) delete process.env.OSI_SCOPED_ACCESS_RATCHET_CACHE;
    else process.env.OSI_SCOPED_ACCESS_RATCHET_CACHE = saved;
  }
});

// ---------------------------------------------------------------------------
// Body fields the fixture sets are also pointed at foreign objects
// (#389 re-review 2). Each test removes the check on the body-named object.

// Hands the journal module a helper whose zone and plot decisions always say
// yes: the module's own zone or plot check is gone.
function journalWithoutObjectChecks(flows) {
  const router = flows.find((node) => node.id === 'journal-api-router-fn');
  const pass = 'scope: scopeLoad.value,';
  assert.ok(router.func.includes(pass), 'journal router hands the helper to the module');
  router.func = router.func.replace(pass,
    'scope: scopeLoad.value && Object.assign({}, scopeLoad.value, { ' +
    'assertFreshZoneAccess: async function() { return { role: \'researcher\' }; }, ' +
    'assertFreshPlotAccess: async function() { return { role: \'researcher\' }; } }),');
  return flows;
}

test('a device claim into a zone named in the body is checked against foreign zones', async () => {
  const flows = loadFlows();
  const router = flows.find((node) => node.id === 'scoped-device-claim-router');
  const check = /\n\s*await scope\.assertFreshZoneAccess\(\s*db,\s*actor\.user_uuid,\s*targetZoneUuid,\s*\{ scopedMode: true \}\s*\);/;
  assert.match(router.func, check);
  router.func = router.func.replace(check, '');
  assert.match(
    await failuresFor(flows, ['post-devices-http']),
    /post-devices-http.*changes a row outside the caller's scope \(body .*devices row added/
  );
});

test('a plot created or moved into a zone named in the body is checked against foreign zones', async () => {
  const flows = journalWithoutObjectChecks(loadFlows());
  const text = await failuresFor(flows, ['journal-plots-post-http', 'journal-plot-put-http']);
  assert.match(text, /journal-plots-post-http.*changes a row outside the caller's scope \(body .*journal_plots row added/);
  assert.match(text, /journal-plot-put-http.*changes a row outside the caller's scope \(body .*journal_plots row added/);
});

test('plot-group members named in the body stay refused without the plot check (#418 owner rule)', async () => {
  const flows = journalWithoutObjectChecks(loadFlows());
  const text = await failuresFor(flows, ['journal-plot-groups-post-http', 'journal-plot-group-put-http']);
  // Two defences now stand in front of a group on a foreign plot: the plot
  // check and, behind it, the group ownership rule (#418: the acting owner a
  // member check resolves must be the caller). With the plot check removed
  // the POST is still refused, so no foreign row appears.
  assert.doesNotMatch(text, /journal-plot-groups-post-http.*changes a row outside/);
  // The PUT gets the same foreign body: the member check makes the plot's
  // owner the acting owner, so the ownership rule refuses it as well.
  assert.doesNotMatch(text, /journal-plot-group-put-http.*changes a row outside/);
});

// A module root identical to the shipped one except for osi-journal/api.js,
// which `patch` rewrites. Every other module is a symlink to the original.
function journalModulesRootWith(patch) {
  const original = path.join(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scoped-access-modules-'));
  for (const name of fs.readdirSync(original)) {
    if (name === 'osi-journal') continue;
    fs.symlinkSync(path.join(original, name), path.join(root, name));
  }
  fs.cpSync(path.join(original, 'osi-journal'), path.join(root, 'osi-journal'), { recursive: true });
  const api = path.join(root, 'osi-journal', 'api.js');
  fs.writeFileSync(api, patch(fs.readFileSync(api, 'utf8')));
  return root;
}

test('the grantee plot-group run catches a missing group ownership rule (#418) on its own', async (t) => {
  const rule = 'if (caller.scoped && principal.owner_user_uuid !== caller.author_principal_uuid) {';
  const modulesRoot = journalModulesRootWith((source) => {
    assert.ok(source.includes(rule), 'the shipped api.js carries the #418 rule');
    return source.replace(rule, 'if (false) {');
  });
  t.after(() => fs.rmSync(modulesRoot, { recursive: true, force: true }));
  const failures = await findFailures(loadFlows(), 'mutation', ALLOWLIST, {
    only: new Set(['journal-plot-groups-post-http']),
    modulesRoot,
  });
  assert.match(failures.join('\n'), /journal-plot-groups-post-http.*lets a grantee create a plot group on another user's plot \(#418\)/);
});

// Gateway-wide writes held to an admin decision with scoped access on: entry,
// its admin guard, and the handler the guard hands an allowed request to.
const ADMIN_GATEWAY_WRITES = [
  ['al-link-in', 'account-link-admin-write-guard', 'al-link-validate'],
  ['al-unlink-in', 'account-unlink-admin-write-guard', 'al-unlink-func'],
  ['sync-force-http', 'sync-force-admin-write-guard', 'sync-force-build'],
  ['history-rollups-run-http', 'history-rollups-admin-write-guard', 'history-rollup-tick-fn'],
];

test('account link, unlink, force sync and rollup run are probed, not exempt', () => {
  for (const [entry] of ADMIN_GATEWAY_WRITES) {
    assert.ok(!ALLOWLIST.has(entry), `${entry} must not be on an exemption list`);
    assert.ok(!INLINE_ACCOUNT_CHECKS.has(entry), `${entry} must not be on the inline check list`);
  }
});

test('an admin-only gateway write wired around its admin guard fails', async () => {
  const flows = loadFlows();
  const byId = new Map(flows.map((node) => [node.id, node]));
  for (const [entry, guard, handler] of ADMIN_GATEWAY_WRITES) {
    assert.deepEqual(byId.get(entry).wires, [[guard]], `${entry} is wired to its guard`);
    byId.get(entry).wires = [[handler]];
  }
  const text = await failuresFor(flows, ADMIN_GATEWAY_WRITES.map(([entry]) => entry));
  for (const [entry] of ADMIN_GATEWAY_WRITES) {
    assert.match(text, new RegExp(`\\(${entry}\\) has no scope call`));
  }
});

test('an admin-only gateway write whose guard checks only the write role fails', async () => {
  const flows = loadFlows();
  const byId = new Map(flows.map((node) => [node.id, node]));
  for (const [, guard] of ADMIN_GATEWAY_WRITES) {
    assert.match(byId.get(guard).func, /scopeLoad\.value\.authorizeAdminRead\(/);
    byId.get(guard).func = guardBody(ROLE_CHECKS);
  }
  const text = await failuresFor(flows, ADMIN_GATEWAY_WRITES.map(([entry]) => entry));
  for (const [entry] of ADMIN_GATEWAY_WRITES) {
    assert.match(text, new RegExp(`\\(${entry}\\) makes no admin decision before it writes`));
  }
});

test('a swallowed admin decision on a gateway write fails', async () => {
  const flows = loadFlows();
  const guard = flows.find((node) => node.id === 'history-rollups-admin-write-guard');
  const call = /await scopeLoad\.value\.authorizeAdminRead\(\{[\s\S]*?\}\);/;
  assert.match(guard.func, call);
  guard.func = guard.func.replace(call, (found) => `try { ${found} } catch (ignored) { node.warn('ignored'); }`);
  assert.match(
    await failuresFor(flows, ['history-rollups-run-http']),
    /history-rollups-run-http.*goes on after its scope decision said no/
  );
});
