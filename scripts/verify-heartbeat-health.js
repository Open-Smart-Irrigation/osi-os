#!/usr/bin/env node
// Guards the heartbeat flow split: Build Heartbeat must stay synchronous and
// dependency-free, while Gather Edge Health owns helper-backed DB access.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_ID = '062a0f9bf66d9789';
const GATHER_ID = '2a4f142e3e9b6d80';
const INJECT_ID = '310dfe7cfe34a448';

const REQUIRED_HEALTH_KEYS = [
  'schema_sig',
  'sync_linked',
  'sync_pending',
  'sync_oldest_age_s',
  'sync_rejected',
  'sync_dirty_pending',
  'disk_free_pct',
];

const REQUIRED_GATHER_LIBS = [
  { var: 'osiHealth', module: 'osi-health-helper' },
  { var: 'osiDb', module: 'osi-db-helper' },
];

const PROFILES = [
  {
    name: 'bcm2712',
    flowsPath: path.join(
      REPO_ROOT,
      'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
    ),
  },
  {
    name: 'bcm2709',
    flowsPath: path.join(
      REPO_ROOT,
      'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
    ),
  },
];

const failures = [];

function fail(profile, msg) {
  failures.push(`${profile}: ${msg}`);
}

function assert(profile, condition, msg) {
  if (!condition) fail(profile, msg);
}

function compilePlain(profile, label, func) {
  try {
    new Function(func);
  } catch (err) {
    fail(profile, `${label} does not compile as a plain function: ${err.message}`);
  }
}

function compileAsyncBody(profile, label, func) {
  try {
    new Function(`return (async function(){\n${func}\n});`);
  } catch (err) {
    fail(profile, `${label} does not compile as an async function body: ${err.message}`);
  }
}

function parseFlow(profile) {
  try {
    const raw = fs.readFileSync(profile.flowsPath, 'utf8');
    const flows = JSON.parse(raw);
    return {
      raw,
      flows,
      byId: Object.fromEntries(flows.filter((node) => node.id).map((node) => [node.id, node])),
    };
  } catch (err) {
    fail(profile.name, `failed to parse ${profile.flowsPath}: ${err.message}`);
    return null;
  }
}

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

function sameStringArray(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function assertHealthKeys(profile, label, health) {
  assert(profile, health && typeof health === 'object', `Build Heartbeat ${label} payload.health is missing`);
  if (!health || typeof health !== 'object') return false;
  assert(
    profile,
    sameStringArray(sortedKeys(health), REQUIRED_HEALTH_KEYS),
    `Build Heartbeat ${label} payload.health keys differ: ${JSON.stringify(sortedKeys(health))}`
  );
  return true;
}

function assertHealthMatches(profile, label, health, expected) {
  if (!assertHealthKeys(profile, label, health)) return;
  for (const key of REQUIRED_HEALTH_KEYS) {
    assert(
      profile,
      health[key] === expected[key],
      `Build Heartbeat ${label} health ${key} expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(health[key])}`
    );
  }
}

function assertAllNullHealth(profile, label, health) {
  if (!assertHealthKeys(profile, label, health)) return;
  for (const key of REQUIRED_HEALTH_KEYS) {
    assert(profile, health[key] === null, `Build Heartbeat ${label} health ${key} is not null`);
  }
}

function fakeEnv() {
  const values = {
    DEVICE_EUI: 'ABCDEF1234567890',
    DEVICE_TYPE: 'GATEWAY',
    FIRMWARE_VERSION: 'test-fw',
  };
  return {
    get(name) {
      return values[name];
    },
  };
}

function fakeFs() {
  return {
    readFileSync() {
      throw new Error('not available in verifier');
    },
    readdirSync() {
      throw new Error('not available in verifier');
    },
    accessSync() {
      throw new Error('not available in verifier');
    },
  };
}

function fakeOs() {
  return {
    totalmem() {
      return 100;
    },
    freemem() {
      return 25;
    },
    loadavg() {
      return [0.12, 0.34, 0.56];
    },
  };
}

function runBuildHeartbeat(profile, buildNode, edgeHealth) {
  const global = {
    get(name) {
      if (name === 'edge_health') return edgeHealth;
      if (name === 'fs') return fakeFs();
      if (name === 'os') return fakeOs();
      return undefined;
    },
  };
  const msg = {};
  const fn = new Function('env', 'global', 'msg', buildNode.func);
  const result = fn(fakeEnv(), global, msg);
  const outbound = result || msg;
  return {
    msg: outbound,
    payload: JSON.parse(outbound.payload),
  };
}

function assertHasOwn(profile, label, obj, key) {
  assert(
    profile,
    Object.prototype.hasOwnProperty.call(obj, key),
    `Build Heartbeat ${label} payload missing ${key}`
  );
}

function assertNormalHeartbeatMessage(profile, label, result) {
  const outbound = result && result.msg;
  const payload = result && result.payload;
  assert(profile, outbound && outbound.topic === 'devices/ABCDEF1234567890/heartbeat', `Build Heartbeat ${label} msg.topic changed`);
  assert(profile, outbound && outbound.qos === 1, `Build Heartbeat ${label} msg.qos changed`);
  assert(profile, payload && typeof payload === 'object', `Build Heartbeat ${label} payload is not an object`);
  if (!payload || typeof payload !== 'object') return;

  const requiredPayloadKeys = [
    'deviceEui',
    'deviceType',
    'firmwareVersion',
    'timestamp',
    'ip',
    'cpu_temp_c',
    'mem_percent',
    'load_1',
    'load_5',
    'load_15',
    'fan_available',
    'fan_value',
    'health',
  ];
  for (const key of requiredPayloadKeys) {
    assertHasOwn(profile, label, payload, key);
  }
  assert(profile, payload.deviceEui === 'ABCDEF1234567890', `Build Heartbeat ${label} deviceEui changed`);
  assert(profile, payload.deviceType === 'GATEWAY', `Build Heartbeat ${label} deviceType changed`);
  assert(profile, payload.firmwareVersion === 'test-fw', `Build Heartbeat ${label} firmwareVersion changed`);
  assert(profile, typeof payload.timestamp === 'string' && !Number.isNaN(Date.parse(payload.timestamp)), `Build Heartbeat ${label} timestamp is invalid`);
  assert(profile, payload.ip === null, `Build Heartbeat ${label} ip should remain null in verifier`);
  assert(profile, payload.mem_percent === 75, `Build Heartbeat ${label} mem_percent changed`);
  assert(profile, payload.load_1 === 0.12, `Build Heartbeat ${label} load_1 changed`);
  assert(profile, payload.load_5 === 0.34, `Build Heartbeat ${label} load_5 changed`);
  assert(profile, payload.load_15 === 0.56, `Build Heartbeat ${label} load_15 changed`);
  assert(profile, Object.prototype.hasOwnProperty.call(payload, 'cpu_temp_c'), `Build Heartbeat ${label} cpu_temp_c missing`);
  assert(profile, Object.prototype.hasOwnProperty.call(payload, 'fan_available'), `Build Heartbeat ${label} fan_available missing`);
  assert(profile, Object.prototype.hasOwnProperty.call(payload, 'fan_value'), `Build Heartbeat ${label} fan_value missing`);
}

function assertHealthPayload(profile, buildNode) {
  const freshHealth = {
    at: Date.now(),
    schema_sig: 'sig',
    sync_linked: true,
    sync_pending: 3,
    sync_oldest_age_s: 42,
    sync_rejected: 1,
    sync_dirty_pending: 2,
    disk_free_pct: 87,
    ignored_extra_key: 'must not leak',
  };

  try {
    const freshResult = runBuildHeartbeat(profile, buildNode, freshHealth);
    assertNormalHeartbeatMessage(profile, 'fresh', freshResult);
    assertHealthMatches(profile, 'fresh', freshResult.payload && freshResult.payload.health, freshHealth);

    const emptyFreshResult = runBuildHeartbeat(profile, buildNode, { at: Date.now() });
    assertAllNullHealth(profile, 'fresh empty', emptyFreshResult.payload && emptyFreshResult.payload.health);

    const partialResult = runBuildHeartbeat(profile, buildNode, {
      at: Date.now(),
      sync_linked: false,
      sync_pending: 0,
      disk_free_pct: 0,
    });
    assertHealthMatches(profile, 'fresh partial', partialResult.payload && partialResult.payload.health, {
      schema_sig: null,
      sync_linked: false,
      sync_pending: 0,
      sync_oldest_age_s: null,
      sync_rejected: null,
      sync_dirty_pending: null,
      disk_free_pct: 0,
    });

    const stringResult = runBuildHeartbeat(profile, buildNode, 'malformed-health');
    assertAllNullHealth(profile, 'primitive string', stringResult.payload && stringResult.payload.health);

    const numberResult = runBuildHeartbeat(profile, buildNode, 12345);
    assertAllNullHealth(profile, 'primitive number', numberResult.payload && numberResult.payload.health);

    const invalidAtResult = runBuildHeartbeat(profile, buildNode, {
      ...freshHealth,
      at: 'not-a-timestamp',
    });
    assertAllNullHealth(profile, 'invalid at', invalidAtResult.payload && invalidAtResult.payload.health);

    const staleResult = runBuildHeartbeat(profile, buildNode, {
      ...freshHealth,
      at: Date.now() - 181000,
    });
    assertAllNullHealth(profile, 'stale', staleResult.payload && staleResult.payload.health);

    const invalidValuesResult = runBuildHeartbeat(profile, buildNode, {
      at: Date.now(),
      schema_sig: function invalidHealthFunction() {},
      sync_linked: Symbol('invalid-health-symbol'),
      sync_pending: BigInt(1),
      sync_oldest_age_s: { invalid: true },
      sync_rejected: ['invalid'],
      sync_dirty_pending: NaN,
      disk_free_pct: Infinity,
    });
    assertAllNullHealth(profile, 'fresh invalid values', invalidValuesResult.payload && invalidValuesResult.payload.health);

    const negativeInfinityResult = runBuildHeartbeat(profile, buildNode, {
      ...freshHealth,
      disk_free_pct: -Infinity,
    });
    assert(
      profile,
      negativeInfinityResult.payload && negativeInfinityResult.payload.health && negativeInfinityResult.payload.health.disk_free_pct === null,
      'Build Heartbeat fresh negative infinity health disk_free_pct is not null'
    );
  } catch (err) {
    fail(profile, `Build Heartbeat payload execution failed: ${err.message}`);
  }
}

function assertBuildNode(profile, buildNode) {
  assert(profile, buildNode, `Build Heartbeat node ${BUILD_ID} is missing`);
  if (!buildNode) return;

  assert(profile, buildNode.type === 'function', 'Build Heartbeat is not a function node');
  assert(profile, buildNode.name === 'Build Heartbeat', 'Build Heartbeat name changed');
  assert(
    profile,
    JSON.stringify(buildNode.libs) === JSON.stringify([]),
    `Build Heartbeat.libs must be []; got ${JSON.stringify(buildNode.libs)}`
  );
  assert(profile, typeof buildNode.func === 'string', 'Build Heartbeat.func is missing');
  if (typeof buildNode.func !== 'string') return;

  assert(
    profile,
    (buildNode.func.match(/global\.get\(['"]edge_health['"]\)/g) || []).length === 1,
    "Build Heartbeat must read health once via global.get('edge_health')"
  );
  assert(profile, !buildNode.func.includes('require'), 'Build Heartbeat must not contain require');
  assert(profile, !buildNode.func.includes('await'), 'Build Heartbeat must not contain await');
  assert(profile, /\bmsg\.topic\s*=/.test(buildNode.func), 'Build Heartbeat must assign msg.topic');
  assert(profile, /\bmsg\.payload\s*=/.test(buildNode.func), 'Build Heartbeat must assign msg.payload');
  compilePlain(profile, 'Build Heartbeat', buildNode.func);
  assertHealthPayload(profile, buildNode);
}

function hasRequiredGatherLibs(libs) {
  if (!Array.isArray(libs)) return false;
  return REQUIRED_GATHER_LIBS.every((required) => (
    libs.some((lib) => lib && lib.var === required.var && lib.module === required.module)
  ));
}

function assertGatherNode(profile, gatherNode) {
  assert(profile, gatherNode, `Gather Edge Health node ${GATHER_ID} is missing`);
  if (!gatherNode) return;

  assert(profile, gatherNode.type === 'function', 'Gather Edge Health is not a function node');
  assert(profile, gatherNode.name === 'Gather Edge Health', 'Gather Edge Health name changed');
  assert(
    profile,
    hasRequiredGatherLibs(gatherNode.libs),
    `Gather Edge Health.libs missing required helper libs; got ${JSON.stringify(gatherNode.libs)}`
  );
  assert(profile, typeof gatherNode.func === 'string', 'Gather Edge Health.func is missing');
  if (typeof gatherNode.func !== 'string') return;

  assert(profile, gatherNode.func.includes("global.set('edge_health'"), "Gather Edge Health must set global edge_health");
  assert(
    profile,
    gatherNode.func.includes("new osiDb.Database('/data/db/farming.db')"),
    'Gather Edge Health must open /data/db/farming.db via osiDb.Database'
  );
  assert(profile, gatherNode.func.includes('.close('), 'Gather Edge Health must close the DB handle');
  assert(profile, /\bfinally\s*{[\s\S]*_db\.close\s*\(\s*\(\s*\)\s*=>\s*{}\s*\)/.test(gatherNode.func), 'Gather Edge Health must close _db in a finally block');
  compileAsyncBody(profile, 'Gather Edge Health', gatherNode.func);
}

function assertInjectWiring(profile, injectNode) {
  assert(profile, injectNode, `heartbeat inject node ${INJECT_ID} is missing`);
  if (!injectNode) return;

  assert(profile, injectNode.type === 'inject', 'heartbeat tick is not an inject node');
  assert(profile, injectNode.name === 'Every 60s', 'heartbeat inject name changed');
  assert(profile, injectNode.repeat === '60', `heartbeat inject repeat must be "60"; got ${JSON.stringify(injectNode.repeat)}`);
  const firstOutput = Array.isArray(injectNode.wires) && Array.isArray(injectNode.wires[0])
    ? injectNode.wires[0]
    : [];
  assert(profile, firstOutput.includes(BUILD_ID), `heartbeat inject does not wire to Build Heartbeat ${BUILD_ID}`);
  assert(profile, firstOutput.includes(GATHER_ID), `heartbeat inject does not wire to Gather Edge Health ${GATHER_ID}`);
}

const parsedProfiles = PROFILES.map((profile) => ({ profile, parsed: parseFlow(profile) }));

for (const { profile, parsed } of parsedProfiles) {
  if (!parsed) continue;
  assertBuildNode(profile.name, parsed.byId[BUILD_ID]);
  assertGatherNode(profile.name, parsed.byId[GATHER_ID]);
  assertInjectWiring(profile.name, parsed.byId[INJECT_ID]);
}

const [canonical, mirror] = parsedProfiles;
if (canonical && canonical.parsed && mirror && mirror.parsed) {
  assert('profiles', canonical.parsed.raw === mirror.parsed.raw, 'flows.json differs byte-for-byte between bcm2712 and bcm2709');
  const canonicalBuild = canonical.parsed.byId[BUILD_ID];
  const mirrorBuild = mirror.parsed.byId[BUILD_ID];
  const canonicalGather = canonical.parsed.byId[GATHER_ID];
  const mirrorGather = mirror.parsed.byId[GATHER_ID];
  if (canonicalBuild && mirrorBuild) {
    assert('profiles', canonicalBuild.func === mirrorBuild.func, 'Build Heartbeat function bodies differ between bcm2712 and bcm2709');
  }
  if (canonicalGather && mirrorGather) {
    assert('profiles', canonicalGather.func === mirrorGather.func, 'Gather Edge Health function bodies differ between bcm2712 and bcm2709');
    assert(
      'profiles',
      JSON.stringify(canonicalGather.libs) === JSON.stringify(mirrorGather.libs),
      'Gather Edge Health libs differ between bcm2712 and bcm2709'
    );
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} heartbeat health flow guard failure(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('OK: heartbeat health flow guard passed for bcm2712 and bcm2709');
