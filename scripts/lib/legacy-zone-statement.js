'use strict';

// Legacy cloud zone commands (UPSERT_ZONE, UPSERT_ZONE_CONFIG, UPSERT_ZONE_LOCATION,
// DELETE_ZONE) are applied by osi-zone-commands' applyLegacyZoneCommand, which
// writes with legacyZoneStatement, its copy of the zone branches of "Build UPDATE
// SQL" (flows.json node 4f4a765f36cee6f3). The node's own branches are no longer
// reached (E3).
//
// buildLegacyZoneStatement runs one command through both copies and asserts they
// agree, at one fixed instant: the same statement and the same warnings. It returns
// the live copy's statement, so the suites that execute it test the code that
// runs on the gateway, and every case they hold is also a drift check between
// the two copies.

const assert = require('node:assert/strict');
const path = require('node:path');
const { executeFunction, loadNode, profilePaths } = require('./scoped-access-harness');

const BUILD_UPDATE_SQL = '4f4a765f36cee6f3';

// Runs fn with `new Date()` and Date.now() fixed at `at` (ms), so both builders,
// and the zone-local "today" of the stage rule, read one instant.
async function withFixedClock(at, fn) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(at);
      else super(...args);
    }
    static now() { return at; }
  }
  global.Date = FixedDate;
  try {
    return await fn();
  } finally {
    global.Date = RealDate;
  }
}

async function buildLegacyZoneStatement(payload, { env = {}, profile = 'bcm2712', at = Date.now() } = {}) {
  const { flowsPath, nodeRedModules } = profilePaths(profile);
  const zoneCommands = require(path.join(nodeRedModules, 'osi-zone-commands'));
  return withFixedClock(at, async () => {
    const nodeRun = await executeFunction(loadNode(BUILD_UPDATE_SQL, flowsPath), {
      msg: { payload },
      env,
      nodeRedModules,
    });
    assert.equal(typeof nodeRun.result.topic, 'string', 'the node must build a statement');
    const warnings = [];
    const statement = zoneCommands.legacyZoneStatement(payload, {
      now: new Date().toISOString(),
      gateway: String(env.DEVICE_EUI || 'UNKNOWN').toUpperCase(),
      warn: (message) => warnings.push(String(message)),
    });
    assert.equal(typeof statement, 'string', 'osi-zone-commands must build a statement');
    assert.equal(statement, nodeRun.result.topic, 'osi-zone-commands and Build UPDATE SQL build the same statement');
    assert.deepEqual(warnings, nodeRun.warnings, 'osi-zone-commands and Build UPDATE SQL warn alike');
    return { statement, warnings, nodeRun };
  });
}

module.exports = { buildLegacyZoneStatement, withFixedClock };
