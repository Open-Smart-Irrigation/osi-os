const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');

const flowProfiles = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

const recordErrorTab = '93b1537a596e0e6d';
const recordErrorLinkInId = 'record-error-link-in';

// Catch nodes that are on the same tab as record-error-fn: wired directly.
const directCatchNodes = {
  'record-error-catch-cloud-sync': recordErrorTab,
};

// record-error-catch-auth additionally wires to auth-catch-http500 (Wave 3
// scoped-access port, shared-resolver commit): auth-tab's uncaught-error catch
// now fans out to both the shared error-recording link-out AND a same-tab
// responder that turns an unhandled auth-tab exception into a real HTTP 500
// instead of leaving the request hanging. Same-tab, so it doesn't violate the
// cross-tab-wire ban checked further below -- just an extra wire this specific
// catch node carries that its siblings don't.
const extraSameTabTargets = {
  'record-error-catch-auth': 'auth-catch-http500',
};

// Catch nodes on a different tab than record-error-fn: must route through a
// same-tab `link out` -> shared `link in` -> record-error-fn, never a direct
// cross-tab wire (Node-RED's editor silently drops cross-tab drawn wires).
const crossTabCatchNodes = {
  'record-error-catch-auth': 'auth-tab',
  'record-error-catch-device-api': 'device-api-tab',
  'record-error-catch-scheduler': 'c2b43a6c6e7d2c11',
  'record-error-catch-kiwi': '49e87447205bb849',
  'record-error-catch-strega': '8a18de184886c8a8',
  'record-error-catch-field-testing': 'a3f03829ad106e10',
  'record-error-catch-download': '7d4f3e45f4b0d111',
  'record-error-catch-lsn50': 'lsn50-tab',
  'record-error-catch-system-admin': 'sys-admin-tab',
  'record-error-catch-account-link': 'account-link-tab',
  'record-error-catch-dendro-analytics': 'dendro-analytics-tab',
  'record-error-catch-s2120': 's2120-tab',
  'record-error-catch-history-api': 'history-api-tab',
  'record-error-catch-lorain': 'lorain-tab',
};

const expectedCatchNodes = { ...directCatchNodes, ...crossTabCatchNodes };

function readFlow(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function nodeRedRoot(relativePath) {
  return path.join(repoRoot, path.dirname(relativePath), 'node-red');
}

// Resolves names through the profile's real osi-lib registry, so a missing
// NAME_TO_PATH entry fails here the way it would fail on a gateway.
function profileOsiLib(relativePath) {
  const root = nodeRedRoot(relativePath);
  const { NAME_TO_PATH } = require(path.join(root, 'osi-lib'));
  return {
    require(name) {
      const rel = NAME_TO_PATH[name];
      if (!rel) return { ok: false, error: 'unknown osi-lib module: ' + name };
      return { ok: true, value: require(path.join(root, rel)) };
    },
  };
}

// The health_state Gather Edge Health would report for these error_counts.
async function healthStateFor(relativePath, counts) {
  const { gatherEdgeHealth } = require(path.join(nodeRedRoot(relativePath), 'osi-health-helper'));
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-error-'));
  try {
    const c = counts || {};
    const health = await gatherEdgeHealth(
      { async all() { return []; }, async get() { return undefined; } },
      {
        timeoutMs: 2000,
        diskPath: os.tmpdir(),
        crashFilePath: path.join(crashDir, 'crash-count'),
        // Same expression as the Gather Edge Health node.
        errorCount: Number.isFinite(c.total) ? c.total : null,
      },
    );
    return health.health_state;
  } finally {
    fs.rmSync(crashDir, { recursive: true, force: true });
  }
}

function tagged401(code, message, sourceId = 'get-devices-auth') {
  return {
    _osiAuthFailure: { format: 1, code, sourceId },
    error: {
      message,
      source: { id: sourceId, type: 'function', name: 'Decode Token & Get Username', count: 1 },
    },
  };
}

for (const relativePath of flowProfiles) {
  test(`${relativePath} has shared error recording wired from DB/sync/decode catch nodes`, () => {
    const flow = readFlow(relativePath);
    const byId = new Map(flow.map((node) => [node.id, node]));
    const recordErrorNodes = flow.filter((node) => node.type === 'function' && node.name === 'Record Error');

    assert.strictEqual(recordErrorNodes.length, 1, 'expected exactly one Record Error function node');
    const recordError = recordErrorNodes[0];
    assert.strictEqual(recordError.id, 'record-error-fn');
    assert.strictEqual(recordError.z, recordErrorTab);
    assert.deepStrictEqual(recordError.libs, [{ var: 'osiLib', module: 'osi-lib' }]);
    assert.match(recordError.func, /global\.get\('error_counts'\)/);
    assert.match(recordError.func, /global\.set\('error_counts', result\.counts\)/);
    assert.match(recordError.func, /osiLib\.require\('health-helper'\)/);
    assert.match(recordError.func, /flow\.set\('record_error_warned', result\.warned\)/);
    assert.match(recordError.func, /flow\.get\('record_error_warned'\)/);
    assert.match(recordError.func, /node\.warn/);

    for (const [catchId, tabId] of Object.entries(expectedCatchNodes)) {
      const catchNode = byId.get(catchId);
      assert(catchNode, `${catchId} missing`);
      assert.strictEqual(catchNode.type, 'catch');
      assert.strictEqual(catchNode.z, tabId);
      assert.strictEqual(catchNode.scope, null);
    }

    // Direct-wire catch nodes (same tab as record-error-fn) wire straight to it.
    for (const catchId of Object.keys(directCatchNodes)) {
      const catchNode = byId.get(catchId);
      assert.deepStrictEqual(catchNode.wires, [['record-error-fn']]);
    }

    // Cross-tab catch nodes must NOT wire directly to record-error-fn. Each
    // wires to a same-tab `link out` node whose `links` includes the shared
    // `link in` node, which in turn wires to record-error-fn.
    const linkInNode = byId.get(recordErrorLinkInId);
    assert(linkInNode, `${recordErrorLinkInId} missing`);
    assert.strictEqual(linkInNode.type, 'link in');
    assert.strictEqual(linkInNode.z, recordErrorTab);
    assert.deepStrictEqual(linkInNode.wires, [['record-error-fn']]);

    const linkOutIdsFeedingLinkIn = new Set(linkInNode.links);

    for (const [catchId, tabId] of Object.entries(crossTabCatchNodes)) {
      const catchNode = byId.get(catchId);
      assert.strictEqual(catchNode.wires.length, 1, `${catchId} should have exactly one wire group`);
      const targets = catchNode.wires[0];
      const extraTargetId = extraSameTabTargets[catchId];
      const expectedTargetCount = extraTargetId ? 2 : 1;
      assert.strictEqual(targets.length, expectedTargetCount, `${catchId} should wire to exactly ${expectedTargetCount} node(s)`);
      if (extraTargetId) {
        assert(targets.includes(extraTargetId), `${catchId} should wire to ${extraTargetId}`);
        const extraNode = byId.get(extraTargetId);
        assert(extraNode, `${catchId} target ${extraTargetId} missing`);
        assert.strictEqual(extraNode.z, tabId, `${catchId}'s extra target ${extraTargetId} must be on the same tab (${tabId})`);
      }
      const [targetId] = targets.filter((id) => id !== extraTargetId);
      assert.notStrictEqual(targetId, 'record-error-fn', `${catchId} must not wire directly to record-error-fn (cross-tab)`);

      const linkOutNode = byId.get(targetId);
      assert(linkOutNode, `${catchId} target ${targetId} missing`);
      assert.strictEqual(linkOutNode.type, 'link out', `${catchId} must wire to a link out node`);
      assert.strictEqual(linkOutNode.z, tabId, `${catchId}'s link out must be on the same tab (${tabId})`);
      assert.strictEqual(linkOutNode.mode, 'link');
      assert.deepStrictEqual(linkOutNode.wires, []);
      assert(
        linkOutNode.links.includes(recordErrorLinkInId),
        `${catchId}'s link out must link to ${recordErrorLinkInId}`,
      );
      assert(
        linkOutIdsFeedingLinkIn.has(linkOutNode.id),
        `${recordErrorLinkInId}.links must include ${linkOutNode.id}`,
      );
    }

    // Programmatic id -> tab (z) map: assert zero cross-tab drawn wires from
    // ANY catch node in the flow (not just the ones this PR touches).
    const idToTab = new Map(flow.map((node) => [node.id, node.z]));
    const catchNodesInFlow = flow.filter((node) => node.type === 'catch');
    for (const catchNode of catchNodesInFlow) {
      const targets = (catchNode.wires || []).flat();
      for (const targetId of targets) {
        const targetTab = idToTab.get(targetId);
        assert.strictEqual(
          targetTab,
          catchNode.z,
          `catch node ${catchNode.id} (tab ${catchNode.z}) has a cross-tab drawn wire to ${targetId} (tab ${targetTab})`,
        );
      }
    }
  });
}

// --- Fix 3: actually execute record-error-fn's body, not just string-match it. ---

/**
 * Build a minimal Node-RED-like sandbox and run `func` (a Node-RED function
 * node's source, which runs with implicit `msg`, `node`, `flow`, `global` in
 * scope and no wrapping function/return statement of its own -- Node-RED
 * wraps it in `new Function('msg','node',...,'flow','global', func)`).
 */
function runFunctionNodeBody(func, { msg, nodeWarnCalls, flowStore, globalStore, osiLib }) {
  const node = {
    warn(...args) {
      nodeWarnCalls.push(args.length === 1 ? args[0] : args);
    },
  };
  const flowApi = {
    get: (key) => flowStore.get(key),
    set: (key, value) => flowStore.set(key, value),
  };
  const globalApi = {
    get: (key) => globalStore.get(key),
    set: (key, value) => globalStore.set(key, value),
  };

  const fn = new vm.Script(`(function(msg, node, flow, global, osiLib) {\n${func}\n})`);
  const context = vm.createContext({});
  const compiled = fn.runInContext(context);
  return compiled(msg, node, flowApi, globalApi, osiLib);
}

for (const relativePath of flowProfiles) {
  test(`${relativePath} record-error-fn actually records and rate-limits when executed`, () => {
    const flow = readFlow(relativePath);
    const recordError = flow.find((node) => node.id === 'record-error-fn');
    assert(recordError, 'record-error-fn missing');

    const flowStore = new Map();
    const globalStore = new Map();
    const nodeWarnCalls = [];

    const fakeMsg = {
      error: { message: 'boom: sensor timed out', source: { name: 'test-source' } },
    };

    // First error: should record and warn.
    runFunctionNodeBody(recordError.func, { msg: fakeMsg, nodeWarnCalls, flowStore, globalStore, osiLib: profileOsiLib(relativePath) });

    const countsAfterFirst = globalStore.get('error_counts');
    assert(countsAfterFirst, 'error_counts should be set in global after first error');
    assert.strictEqual(countsAfterFirst.total, 1);
    assert(countsAfterFirst.last, 'error_counts.last should be set');
    assert.strictEqual(countsAfterFirst.last.src, 'test-source');
    assert.match(countsAfterFirst.last.message, /boom: sensor timed out/);
    assert.strictEqual(nodeWarnCalls.length, 1, 'first occurrence should warn once');

    // Second identical error within the rate-limit window: should still
    // increment the total, but must NOT warn again.
    runFunctionNodeBody(recordError.func, { msg: fakeMsg, nodeWarnCalls, flowStore, globalStore, osiLib: profileOsiLib(relativePath) });

    const countsAfterSecond = globalStore.get('error_counts');
    assert.strictEqual(countsAfterSecond.total, 2, 'total should keep incrementing even when rate-limited');
    assert.strictEqual(
      nodeWarnCalls.length,
      1,
      'identical error within the rate-limit window must not warn a second time',
    );
  });
}

function freshRun(relativePath) {
  const recordError = readFlow(relativePath).find((n) => n.id === 'record-error-fn');
  assert(recordError, 'record-error-fn missing');
  const nodeWarnCalls = [];
  const flowStore = new Map();
  const globalStore = new Map();
  const osiLib = profileOsiLib(relativePath);
  return {
    nodeWarnCalls,
    globalStore,
    run(msg, lib = osiLib) {
      return runFunctionNodeBody(recordError.func, { msg, nodeWarnCalls, flowStore, globalStore, osiLib: lib });
    },
  };
}

for (const relativePath of flowProfiles) {
  test(`${relativePath} one tagged 401 from Decode Token leaves error_counts.total unset and health healthy (#462)`, async () => {
    const ctx = freshRun(relativePath);
    ctx.run(tagged401('MISSING_BEARER', 'Error: Unauthorized'));
    const counts = ctx.globalStore.get('error_counts');
    assert.strictEqual(counts.total, undefined);
    assert.strictEqual(counts.last, undefined);
    assert.deepStrictEqual(ctx.nodeWarnCalls, ['Decode Token & Get Username: Error: Unauthorized']);
    assert.strictEqual(await healthStateFor(relativePath, counts), 'healthy');
  });

  test(`${relativePath} repeated tagged 401s never count and warn once per message per minute`, async () => {
    const ctx = freshRun(relativePath);
    for (let i = 0; i < 2; i += 1) {
      ctx.run(tagged401('MISSING_BEARER', 'Error: Unauthorized'));
      ctx.run(tagged401('INVALID_TOKEN', 'Error: Invalid token'));
      ctx.run(tagged401('TOKEN_EXPIRED', 'Error: Token expired'));
    }
    const counts = ctx.globalStore.get('error_counts');
    assert.strictEqual(counts.total, undefined);
    assert.strictEqual(ctx.nodeWarnCalls.length, 3);
    assert.strictEqual(await healthStateFor(relativePath, counts), 'healthy');
  });

  test(`${relativePath} an untagged Error: Unauthorized still counts and degrades health`, async () => {
    const ctx = freshRun(relativePath);
    ctx.run({ error: { message: 'Error: Unauthorized', source: { id: 'cloud-sync-node', type: 'function', name: 'Cloud Sync' } } });
    const counts = ctx.globalStore.get('error_counts');
    assert.strictEqual(counts.total, 1);
    assert.strictEqual(counts.last.src, 'Cloud Sync');
    assert.strictEqual(counts.last.message, 'Error: Unauthorized');
    assert.strictEqual(await healthStateFor(relativePath, counts), 'degraded');
  });

  test(`${relativePath} a tag not bound to the throwing node, with extra keys or an unknown code still counts`, async () => {
    const ctx = freshRun(relativePath);
    const unbound = tagged401('MISSING_BEARER', 'Error: Unauthorized');
    unbound.error.source.id = 'other-node';
    ctx.run(unbound);
    ctx.run({
      ...tagged401('INVALID_TOKEN', 'Error: Invalid token'),
      _osiAuthFailure: { format: 1, code: 'INVALID_TOKEN', sourceId: 'get-devices-auth', statusCode: 401 },
    });
    ctx.run(tagged401('FORBIDDEN', 'Error: Forbidden'));
    const counts = ctx.globalStore.get('error_counts');
    assert.strictEqual(counts.total, 3);
    assert.strictEqual(await healthStateFor(relativePath, counts), 'degraded');
  });

  test(`${relativePath} an ordinary error after a tagged 401 is still counted`, async () => {
    const ctx = freshRun(relativePath);
    ctx.run(tagged401('TOKEN_EXPIRED', 'Error: Token expired'));
    ctx.run({ error: { message: 'SQLITE_BUSY: database is locked', source: { name: 'Persist Gateway Health' } } });
    const counts = ctx.globalStore.get('error_counts');
    assert.strictEqual(counts.total, 1);
    assert.strictEqual(counts.last.message, 'SQLITE_BUSY: database is locked');
    assert.strictEqual(await healthStateFor(relativePath, counts), 'degraded');
  });

  test(`${relativePath} Record Error still counts every error when the health helper cannot load`, () => {
    const ctx = freshRun(relativePath);
    ctx.run(
      tagged401('MISSING_BEARER', 'Error: Unauthorized'),
      { require: () => ({ ok: false, error: 'Cannot find module' }) },
    );
    const counts = ctx.globalStore.get('error_counts');
    assert.strictEqual(counts.total, 1);
    assert.strictEqual(counts.last.message, 'health helper unavailable');
    assert.strictEqual(ctx.nodeWarnCalls.length, 1);
    assert.match(
      ctx.nodeWarnCalls[0],
      /^Record Error: health helper unavailable \(Cannot find module\): Error: Unauthorized$/,
    );
  });
}
