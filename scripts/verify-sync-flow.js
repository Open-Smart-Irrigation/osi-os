#!/usr/bin/env node

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const flowPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'flows.json');
const nodeRedRoot = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red');
const deployScriptPath = path.resolve(__dirname, '..', 'deploy.sh');
const nodeRedInitPath = path.resolve(__dirname, '..', 'feeds', 'chirpstack-openwrt-feed', 'apps', 'node-red', 'files', 'node-red.init');
const osiServerDefaultsPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'uci-defaults', '96_osi_server_config');
const sx1301GatewayDefaultPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'uci-defaults', '99_set_sx1301_gateway_id');
const gatewayIdentityHelperPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'libexec', 'osi-gateway-identity.sh');
const chirpstackBootstrapPath = path.resolve(__dirname, 'chirpstack-bootstrap.js');
const stregaCodecPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'codecs', 'strega_gen1_decoder.js');
const lsn50CodecPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'codecs', 'dragino_lsn50_decoder.js');
const seedDatabasePaths = [
  path.resolve(__dirname, '..', 'conf', 'base_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'db', 'farming.db'),
  path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2708', 'files', 'usr', 'share', 'db', 'farming.db'),
  path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2709', 'files', 'usr', 'share', 'db', 'farming.db'),
  path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'db', 'farming.db'),
  path.resolve(__dirname, '..', 'database', 'farming.db'),
  path.resolve(__dirname, '..', 'web', 'react-gui', 'farming.db')
];
const seedDendroHistoryDatabasePaths = [
  path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'db', 'farming.db'),
  path.resolve(__dirname, '..', 'database', 'farming.db')
];
const batPctDatabasePaths = seedDatabasePaths;
const reactGuiApiPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'services', 'api.ts');
const farmingTypesPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'types', 'farming.ts');
const dendroMonitorPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DendrometerMonitor.tsx');
const dendroDrawerPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'dendrometer', 'DendrometerMonitor.tsx');
const draginoTempCardPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DraginoTempCard.tsx');
const draginoSettingsModalPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DraginoSettingsModal.tsx');
const draginoDendroCalibrationPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DraginoDendroCalibrationSection.tsx');
const draginoChameleonSwtSectionPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'DraginoChameleonSwtSection.tsx');
const senseCapWeatherCardPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'SenseCapWeatherCard.tsx');
const windMonitorPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'WindMonitor.tsx');
const windUtilsPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'utils', 'wind.ts');
const onlineTabPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'environment', 'OnlineTab.tsx');
const weatherTabPath = path.resolve(__dirname, '..', 'web', 'react-gui', 'src', 'components', 'farming', 'environment', 'WeatherTab.tsx');
const helperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-chirpstack-helper'),
  path.join(nodeRedRoot, 'osi-chirpstack-helper')
];
const dbHelperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-db-helper'),
  path.join(nodeRedRoot, 'osi-db-helper')
];
const dendroHelperCandidates = [
  path.join(nodeRedRoot, 'node_modules', 'osi-dendro-helper'),
  path.join(nodeRedRoot, 'osi-dendro-helper')
];
const packageJsonPath = path.join(nodeRedRoot, 'package.json');
execFileSync(process.execPath, [path.resolve(__dirname, 'verify-communication-contract.js')], { stdio: 'inherit' });
const deployScript = fs.readFileSync(deployScriptPath, 'utf8');
const nodeRedInitScript = fs.readFileSync(nodeRedInitPath, 'utf8');
const osiServerDefaultsScript = fs.readFileSync(osiServerDefaultsPath, 'utf8');
const sx1301GatewayDefaultScript = fs.readFileSync(sx1301GatewayDefaultPath, 'utf8');
const gatewayIdentityHelperScript = fs.readFileSync(gatewayIdentityHelperPath, 'utf8');
const chirpstackBootstrapScript = fs.readFileSync(chirpstackBootstrapPath, 'utf8');
const stregaCodecSource = fs.existsSync(stregaCodecPath) ? fs.readFileSync(stregaCodecPath, 'utf8') : '';
const lsn50CodecSource = fs.existsSync(lsn50CodecPath) ? fs.readFileSync(lsn50CodecPath, 'utf8') : '';
const reactGuiApiSource = fs.readFileSync(reactGuiApiPath, 'utf8');
const farmingTypesSource = fs.readFileSync(farmingTypesPath, 'utf8');
const dendroMonitorSource = fs.readFileSync(dendroMonitorPath, 'utf8');
const dendroDrawerSource = fs.readFileSync(dendroDrawerPath, 'utf8');
const draginoTempCardSource = fs.readFileSync(draginoTempCardPath, 'utf8');
const draginoSettingsModalSource = fs.readFileSync(draginoSettingsModalPath, 'utf8');
const draginoDendroCalibrationSource = fs.readFileSync(draginoDendroCalibrationPath, 'utf8');
const draginoChameleonSwtSectionSource = fs.existsSync(draginoChameleonSwtSectionPath)
  ? fs.readFileSync(draginoChameleonSwtSectionPath, 'utf8')
  : '';
const draginoSettingsSource = `${draginoSettingsModalSource}\n${draginoDendroCalibrationSource}\n${draginoChameleonSwtSectionSource}`;
const senseCapWeatherCardSource = fs.readFileSync(senseCapWeatherCardPath, 'utf8');
const windMonitorSource = fs.readFileSync(windMonitorPath, 'utf8');
const windUtilsSource = fs.readFileSync(windUtilsPath, 'utf8');
const onlineTabSource = fs.readFileSync(onlineTabPath, 'utf8');
const weatherTabSource = fs.readFileSync(weatherTabPath, 'utf8');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const pendingChecks = [];

const sharedStregaIngressNode = flows.find((node) => node.id === 'e73a11a2a36aab22');
if (!sharedStregaIngressNode) {
  fail('missing shared STREGA ingest node e73a11a2a36aab22');
} else {
  if (sharedStregaIngressNode.name !== 'Local Device Uplinks') {
    fail(`shared STREGA ingest node renamed unexpectedly: ${JSON.stringify(sharedStregaIngressNode.name)}`);
  } else {
    console.log('OK shared STREGA ingest node renamed to Local Device Uplinks');
  }

  if (sharedStregaIngressNode.topic !== 'application/+/device/+/event/up') {
    fail(`shared STREGA ingest node topic narrowed unexpectedly: ${JSON.stringify(sharedStregaIngressNode.topic)}`);
  } else {
    console.log('OK shared STREGA ingest topic remains application/+/device/+/event/up');
  }
}

if (
  chirpstackBootstrapScript.includes("node.id === 'e73a11a2a36aab22'") &&
  chirpstackBootstrapScript.includes("application/${sensorsAppId}/device/#")
) {
  fail('chirpstack-bootstrap.js still rewrites the shared STREGA ingest node to the sensors-only topic');
} else {
  console.log('OK chirpstack-bootstrap.js preserves the shared STREGA ingest topic');
}

const requiredHttpRoutes = [
  '/api/account-link',
  '/api/account-link/status',
  '/api/sync/state',
  '/api/sync/force',
  '/api/devices/:deveui/lsn50/mode',
  '/api/devices/:deveui/lsn50/interval',
  '/api/devices/:deveui/lsn50/interrupt-mode',
  '/api/devices/:deveui/lsn50/5v-warmup',
  '/api/devices/:deveui/kiwi/interval',
  '/api/devices/:deveui/kiwi/temperature-humidity/enable',
  '/api/devices/:deveui/soil-moisture-depths',
  '/api/devices/:deveui/strega/interval',
  '/api/devices/:deveui/strega/model',
  '/api/devices/:deveui/strega/timed-action',
  '/api/devices/:deveui/strega/magnet',
  '/api/devices/:deveui/strega/partial-opening',
  '/api/devices/:deveui/strega/flushing',
  '/api/devices/:deveui/chameleon',
  '/api/devices/:deveui/chameleon-config',
  '/api/devices/:deveui/dendro-config',
  '/api/devices/:deveui/dendro-baseline/reset',
  '/api/devices/:deveui/zone-assignments',
  '/api/gateway/location',
  '/api/gateways/:gatewayEui/location',
  '/api/irrigation-zones/:zone_id/environment-summary'
];

const requiredFunctionNodes = [
  'Validate & decode token',
  'Build server auth request',
  'Handle server auth response',
  'Finalize linked account state',
  'Persist MQTT Broker Config',
  'Rollback MQTT Broker Config',
  'Schedule Link Restart',
  'Clear link flow state',
  'Clear MQTT Broker Config',
  'Decode token & build UPDATE',
  'Clear linked account state',
  'Restore MQTT Broker Config',
  'Schedule Unlink Restart',
  'Set Download Headers',
  'Daily Dendrometer Analytics',
  'Sync Init Schema + Triggers',
  'Build Cloud Bootstrap',
  'Mark Bootstrap Synced',
  'Build Edge Event Batch',
  'Mark Synced Events Delivered',
  'Build Pending Command Pull',
  'Build Sync State',
  'Replay Pending Commands',
  'Build Sync Token Refresh',
  'Store Refreshed Sync Token',
  'Run Force Sync',
  'Auth + Parse LSN50 Mode',
  'Auth + Parse LSN50 Interval',
  'Authorize + Fanout LSN50 Mode',
  'Authorize + Fanout LSN50 Interval',
  'Format LSN50 Mode Response',
  'Format LSN50 Interval Response',
  'Auth + Parse LSN50 Interrupt',
  'Auth + Parse LSN50 5V Warmup',
  'Authorize + Fanout LSN50 Advanced',
  'Format LSN50 Advanced Response',
  'Auth + Parse Kiwi Interval',
  'Authorize + Fanout Kiwi Interval',
  'Format Kiwi Interval Response',
  'Auth + Parse Kiwi Temp/Humidity',
  'Authorize + Fanout Kiwi Temp/Humidity',
  'Format Kiwi Temp/Humidity Response',
  'Auth + Save Soil Moisture Depths',
  'Auth + Parse STREGA Interval',
  'Authorize + Fanout STREGA Interval',
  'Format STREGA Interval Response',
  'Auth + Parse STREGA Model',
  'Auth + Parse STREGA Timed Action',
  'Auth + Parse STREGA Magnet',
  'Auth + Parse STREGA Partial Opening',
  'Auth + Parse STREGA Flushing',
  'Authorize + Fanout STREGA Advanced',
  'Format STREGA Advanced Response',
  'Auth + Set Chameleon Enabled',
  'Auth + Save Chameleon Config',
  'Auth + Parse Dendro Config',
  'Format Dendro Config Response',
  'Return Device API HTTP 500',
  'CS Register (cloud cmd)',
  'Build Special Command ACK',
  'Build LSN50 mode downlink',
  'Process STREGA',
  'Persist STREGA Uplink',
  'Process S2120',
  'Aggregate Zone Rain',
  'Insert Chameleon Reading',
  'Get Zone Assignments',
  'Auth + Set Zone Assignments',
  'Auth + Query Gateway Location',
  'Format Gateway Location Response',
  'Get Zone Environment Summary'
];

const directDbOpenCount = flows.filter((node) =>
  typeof node.func === 'string' && node.func.includes("new sqlite3.Database('/data/db/farming.db')")
).length;
if (directDbOpenCount > 0) {
  fail(`found ${directDbOpenCount} direct sqlite database opens in flows.json`);
} else {
  console.log('OK no direct sqlite database opens remain in flows.json');
}

const helperAliasIssues = flows.filter((node) => {
  const libs = Array.isArray(node.libs) ? node.libs : [];
  const helperVars = libs
    .filter((item) => item && item.module === 'osi-db-helper')
    .map((item) => item.var);
  if (!helperVars.length) return false;
  return !helperVars.includes('osiDb') || helperVars.includes('sqlite3');
});
if (helperAliasIssues.length > 0) {
  fail(`found ${helperAliasIssues.length} osi-db-helper nodes without the osiDb alias`);
} else {
  console.log('OK osi-db-helper nodes consistently use the osiDb alias');
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function findNodeByName(name) {
  return flows.find((node) => node.name === name);
}

function findNodeById(id) {
  return flows.find((node) => node.id === id);
}

function expectIncludes(nodeName, needle, description) {
  const node = findNodeByName(nodeName);
  if (!node) {
    fail(`missing function node ${nodeName}`);
    return;
  }
  const func = String(node.func || '');
  if (!func.includes(needle)) {
    fail(`${nodeName} missing ${description}`);
  } else {
    console.log(`OK ${nodeName} ${description}`);
  }
}

function expectExcludes(nodeName, needle, description) {
  const node = findNodeByName(nodeName);
  if (!node) {
    fail(`missing function node ${nodeName}`);
    return;
  }
  const func = String(node.func || '');
  if (func.includes(needle)) {
    fail(`${nodeName} still contains ${description}`);
  } else {
    console.log(`OK ${nodeName} removed ${description}`);
  }
}

function expectIncludesById(nodeId, needle, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  if (!String(node.func || '').includes(needle)) {
    fail(`${nodeId} missing ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
  }
}

function expectExcludesById(nodeId, needle, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  if (String(node.func || '').includes(needle)) {
    fail(`${nodeId} still contains ${description}`);
  } else {
    console.log(`OK ${nodeId} removed ${description}`);
  }
}

function expectMissingNodeById(nodeId, description) {
  if (findNodeById(nodeId)) {
    fail(`${nodeId} still exists: ${description}`);
  } else {
    console.log(`OK ${nodeId} removed ${description}`);
  }
}

function expectLibById(nodeId, varName, moduleName, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  const libs = Array.isArray(node.libs) ? node.libs : [];
  const found = libs.some((item) => item && item.var === varName && item.module === moduleName);
  if (!found) {
    fail(`${nodeId} missing ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
  }
}

function expectWireById(nodeId, targetId, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  const wires = Array.isArray(node.wires) ? node.wires.flat() : [];
  if (!wires.includes(targetId)) {
    fail(`${nodeId} missing ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
  }
}

function expectFileIncludes(fileLabel, content, needle, description) {
  if (!content.includes(needle)) {
    fail(`${fileLabel} missing ${description}`);
  } else {
    console.log(`OK ${fileLabel} ${description}`);
  }
}

function expectFileExcludes(fileLabel, content, needle, description) {
  if (content.includes(needle)) {
    fail(`${fileLabel} still contains ${description}`);
  } else {
    console.log(`OK ${fileLabel} removed ${description}`);
  }
}

function expectCondition(condition, successMessage, failureMessage) {
  if (!condition) {
    fail(failureMessage || successMessage);
  } else {
    console.log(`OK ${successMessage}`);
  }
}

function expectEqual(actual, expected, description) {
  if (actual !== expected) {
    fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK ${description}`);
  }
}

function expectApprox(actual, expected, epsilon, description) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
    fail(`${description}: expected ${expected} +/- ${epsilon}, got ${actual}`);
  } else {
    console.log(`OK ${description}`);
  }
}

function expectIncludesForEach(nodeNames, needle, description) {
  for (const nodeName of nodeNames) {
    expectIncludes(nodeName, needle, description);
  }
}

function expectExcludesForEach(nodeNames, needle, description) {
  for (const nodeName of nodeNames) {
    expectExcludes(nodeName, needle, description);
  }
}

function readTableColumns(dbPath, tableName) {
  const output = execFileSync('sqlite3', [dbPath, `pragma table_info(${tableName});`], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|');
      return parts[1];
    })
    .filter(Boolean);
}

function readTableIndexes(dbPath, tableName) {
  const output = execFileSync('sqlite3', [dbPath, `pragma index_list(${tableName});`], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|');
      return parts[1];
    })
    .filter(Boolean);
}

function createMockOsiDb(queryHandler) {
  return {
    Database: class MockDatabase {
      all(sql, params, callback) {
        const cb = typeof params === 'function' ? params : callback;
        Promise.resolve()
          .then(() => queryHandler(String(sql)))
          .then((rows) => cb(null, rows || []))
          .catch((error) => cb(error));
      }

      run(_sql, params, callback) {
        const cb = typeof params === 'function' ? params : callback;
        if (cb) cb(null);
      }

      close(callback) {
        if (callback) callback();
      }
    },
  };
}

function loadCommonJsFromSource(source, filename, injectedModules = {}) {
  const moduleInstance = { exports: {} };
  const dirname = path.dirname(filename);
  const helperRequire = createRequire(filename);
  const localRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return helperRequire(request);
  };
  const sandbox = vm.createContext({
    Buffer,
    console,
    Date,
    Promise,
    clearImmediate,
    clearTimeout,
    process,
    setImmediate,
    setTimeout,
  });
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`;
  const script = new vm.Script(wrapped, { filename });
  const factory = script.runInContext(sandbox);
  factory(moduleInstance.exports, localRequire, moduleInstance, filename, dirname);
  return moduleInstance.exports;
}

function createFakeSqlite3ForTransactionVerification(failureLabel = '__fake-sqlite-run-failure__') {
  const stateByFilename = new Map();

  function getState(filename) {
    if (!stateByFilename.has(filename)) {
      stateByFilename.set(filename, {
        journalMode: 'wal',
        synchronous: 1,
        committedTxLog: [],
        pendingTransaction: null,
        history: [],
      });
    }
    return stateByFilename.get(filename);
  }

  function normalizeSql(sql) {
    return String(sql || '')
      .trim()
      .replace(/;+\s*$/, '')
      .replace(/\s+/g, ' ');
  }

  function normalizeArgs(sql, params, callback) {
    if (typeof params === 'function') {
      return { sql, params: undefined, callback: params };
    }
    return { sql, params, callback };
  }

  function respond(callback, context, error, rows, statement) {
    if (typeof callback !== 'function') return;
    process.nextTick(() => callback.call(context, error, rows, statement));
  }

  class FakeDatabase {
    constructor(filename, callback) {
      this.filename = filename;
      this.state = getState(filename);
      process.nextTick(() => {
        if (typeof callback === 'function') {
          callback.call(this, null);
        }
      });
    }

    execute(sql, params) {
      const normalized = normalizeSql(sql);
      const state = this.state;

      if (/^PRAGMA journal_mode\s*=\s*WAL$/i.test(normalized)) {
        state.journalMode = 'wal';
        return [];
      }
      if (/^PRAGMA synchronous\s*=\s*NORMAL$/i.test(normalized)) {
        state.synchronous = 1;
        return [];
      }
      if (/^PRAGMA foreign_keys\s*=\s*ON$/i.test(normalized)) {
        return [];
      }
      if (/^PRAGMA busy_timeout\s*=\s*5000$/i.test(normalized)) {
        return [];
      }
      if (/^PRAGMA wal_autocheckpoint\s*=\s*1000$/i.test(normalized)) {
        return [];
      }
      if (/^PRAGMA journal_mode$/i.test(normalized)) {
        return [{ journal_mode: state.journalMode }];
      }
      if (/^PRAGMA synchronous$/i.test(normalized)) {
        return [{ synchronous: state.synchronous }];
      }
      if (/^PRAGMA quick_check$/i.test(normalized)) {
        return [{ quick_check: 'ok' }];
      }
      if (/^BEGIN(?: IMMEDIATE)?$/i.test(normalized)) {
        if (state.pendingTransaction) {
          throw new Error('transaction already active');
        }
        state.pendingTransaction = [];
        state.history.push('BEGIN');
        return [];
      }
      if (/^COMMIT$/i.test(normalized)) {
        if (!state.pendingTransaction) {
          throw new Error('commit without active transaction');
        }
        state.committedTxLog.push(...state.pendingTransaction);
        state.pendingTransaction = null;
        state.history.push('COMMIT');
        return [];
      }
      if (/^ROLLBACK$/i.test(normalized)) {
        if (!state.pendingTransaction) {
          throw new Error('rollback without active transaction');
        }
        state.pendingTransaction = null;
        state.history.push('ROLLBACK');
        return [];
      }
      if (/^INSERT INTO tx_log\s*\(\s*label\s*\) VALUES \(\s*\?\s*\)$/i.test(normalized)) {
        const label = params && params.length ? String(params[0]) : '';
        if (label === failureLabel) {
          throw new Error('forced fake sqlite3 run failure');
        }
        const row = { label };
        if (state.pendingTransaction) {
          state.pendingTransaction.push(row);
        } else {
          state.committedTxLog.push(row);
        }
        state.history.push(`INSERT:${label}`);
        return [];
      }
      if (/^SELECT label FROM tx_log(?: ORDER BY rowid)?$/i.test(normalized)) {
        return state.committedTxLog
          .concat(state.pendingTransaction || [])
          .map((row) => ({ label: row.label }));
      }

      throw new Error(`unexpected SQL in fake sqlite3: ${sql}`);
    }

    all(...args) {
      const { sql, params, callback } = normalizeArgs(...args);
      try {
        const rows = this.execute(sql, params);
        respond(callback, this, null, rows, { sql, changes: 0, lastID: undefined });
      } catch (error) {
        respond(callback, this, error);
      }
    }

    run(...args) {
      const { sql, params, callback } = normalizeArgs(...args);
      try {
        this.execute(sql, params);
        respond(callback, this, null, undefined, { sql, changes: 1, lastID: undefined });
      } catch (error) {
        respond(callback, this, error);
      }
    }

    exec(sql, callback) {
      const statements = String(sql || '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      try {
        for (const statement of statements) {
          this.execute(statement, undefined);
        }
        respond(callback, this, null, undefined, { sql, changes: 0, lastID: undefined });
      } catch (error) {
        respond(callback, this, error);
      }
    }

    close(callback) {
      respond(callback, this, null);
    }
  }

  return {
    Database: FakeDatabase,
    OPEN_READONLY: 1,
    OPEN_READWRITE: 2,
    OPEN_CREATE: 4,
    verbose() {
      return this;
    },
  };
}

async function verifyDbHelperTransactionBehavior(dbHelperSource, dbHelperIndexPath) {
  const transactionFailureLabel = '__fake-sqlite-run-failure__';
  const fakeSqlite3 = createFakeSqlite3ForTransactionVerification(transactionFailureLabel);
  const helper = loadCommonJsFromSource(dbHelperSource, dbHelperIndexPath, { sqlite3: fakeSqlite3 });
  const database = new helper.Database('/tmp/osi-db-helper-transaction-test.sqlite');

  const readLabels = async () => {
    const result = await database.all('SELECT label FROM tx_log ORDER BY rowid');
    const rows = Array.isArray(result) ? result : Array.isArray(result && result.rows) ? result.rows : [];
    return rows.map((row) => row.label);
  };

  await database.transaction(async (tx) => {
    await tx.run('INSERT INTO tx_log (label) VALUES (?)', ['commit-inner-write']);
  });
  const afterCommit = await readLabels();
  expectCondition(
    afterCommit.includes('commit-inner-write'),
    'DB helper transaction commits inner queued writes',
    'DB helper transaction did not commit the inner queued write'
  );

  const failingTransaction = database.transaction(async (tx) => {
    await tx.run('INSERT INTO tx_log (label) VALUES (?)', ['rollback-inner-write']);
    await tx.run('INSERT INTO tx_log (label) VALUES (?)', [transactionFailureLabel]);
  });
  const queuedRecoveryWrite = database.run('INSERT INTO tx_log (label) VALUES (?)', ['post-rollback-queued-write']);
  const rollbackError = await failingTransaction.catch((error) => error);
  expectCondition(
    rollbackError instanceof Error && String(rollbackError.message || '').includes('forced fake sqlite3 run failure'),
    'DB helper transaction surfaces a real fake DB operation failure',
    'DB helper transaction did not surface the fake DB operation failure'
  );
  await queuedRecoveryWrite;
  const afterRollback = await readLabels();
  expectCondition(
    !afterRollback.includes('rollback-inner-write'),
    'DB helper transaction rolls back writes after a fake DB operation failure',
    'DB helper transaction left rolled-back writes visible'
  );
  expectCondition(
    afterRollback.includes('post-rollback-queued-write'),
    'DB helper queue accepts a write queued before the failed transaction settled',
    'DB helper queue did not accept the queued follow-up write after rollback'
  );
  expectCondition(
    afterRollback.includes('commit-inner-write') && !afterRollback.includes(transactionFailureLabel),
    'DB helper preserves committed rows and excludes the failed write after queue recovery',
    'DB helper transaction state leaked across the queue recovery check'
  );
}

async function executeFunctionNodeById(nodeId, msg, options = {}) {
  const node = findNodeById(nodeId);
  if (!node) {
    throw new Error(`missing node ${nodeId}`);
  }
  const flowState = new Map(Object.entries(options.flowState || {}));
  const fn = new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`).runInNewContext(Object.assign({
    Buffer,
    console,
    require,
    process,
    setTimeout,
    clearTimeout,
  }, options.scope || {}));
  const flowApi = {
    get(key) {
      return flowState.get(key);
    },
    set(key, value) {
      if (value === undefined) flowState.delete(key);
      else flowState.set(key, value);
    },
  };
  const envValues = options.env || {};
  const envApi = {
    get(key) {
      return envValues[key];
    },
  };
  const noopStore = {
    get() {
      return undefined;
    },
    set() {},
  };
  const nodeApi = Object.assign(
    {
      error() {},
      warn() {},
      status() {},
    },
    options.node || {}
  );
  return fn(msg, nodeApi, flowApi, envApi, options.context || noopStore, options.global || noopStore, () => undefined, () => {});
}

for (const route of requiredHttpRoutes) {
  const node = flows.find((candidate) => candidate.type === 'http in' && candidate.url === route);
  if (!node) {
    fail(`missing HTTP route ${route}`);
  } else {
    console.log(`OK route ${route}`);
  }
}

for (const name of requiredFunctionNodes) {
  const node = findNodeByName(name);
  if (!node) {
    fail(`missing function node ${name}`);
    continue;
  }
  try {
    new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`);
    console.log(`OK compile ${name}`);
  } catch (error) {
    fail(`function node ${name} does not compile: ${error.message}`);
  }
}

const bootstrapInject = flows.find((node) => node.id === 'sync-bootstrap-inject');
if (!bootstrapInject) {
  fail('missing sync-bootstrap-inject node');
} else if (bootstrapInject.repeat !== '21600') {
  fail(`unexpected sync bootstrap repeat interval: ${bootstrapInject.repeat}`);
} else {
  console.log('OK bootstrap repeat 21600');
}

const refreshInject = flows.find((node) => node.id === 'sync-refresh-inject');
if (!refreshInject) {
  fail('missing sync-refresh-inject node');
} else if (refreshInject.repeat !== '3600') {
  fail(`unexpected sync refresh repeat interval: ${refreshInject.repeat}`);
} else {
  console.log('OK refresh repeat 3600');
}

const bootstrapNode = findNodeByName('Build Cloud Bootstrap');
if (bootstrapNode) {
  for (const key of ['sensorData', 'dendroReadings', 'dendroDaily', 'zoneRecommendations', 'zoneEnvironments', 'gatewayLocations', 'irrigationEvents']) {
    if (!bootstrapNode.func.includes(`${key}:`) && !bootstrapNode.func.includes(`${key},`) && !bootstrapNode.func.includes(`const ${key} =`)) {
      fail(`bootstrap payload missing ${key}`);
    } else {
      console.log(`OK bootstrap includes ${key}`);
    }
  }
}

expectIncludes('Validate & decode token', 'const auth = verifyBearer', 'uses decoded local auth');
expectIncludes('Validate & decode token', 'function allowPrivateTargets()', 'supports a private-target maintenance override');
expectIncludes('Validate & decode token', 'ALLOW_PRIVATE_SERVER_URLS', 'accepts the runtime private-target override flag');
expectIncludes('Validate & decode token', 'ALLOW_INSECURE_SERVER_URL', 'accepts the legacy runtime private-target override flag');
expectIncludes('Validate & decode token', 'allow_private_target', 'accepts the persisted UCI private-target override flag');
expectIncludes('Validate & decode token', "normalizeGatewayDeviceEui(env.get('DEVICE_EUI'))", 'uses the canonical runtime gateway identity');
expectIncludes('Validate & decode token', "env.get('DEVICE_EUI_CONFIDENCE')", 'reads runtime gateway identity confidence');
expectIncludes('Validate & decode token', "flow.set('al_gateway_device_eui_source'", 'stores resolved gateway identity metadata in link flow state');
expectIncludes('Validate & decode token', "flow.set('al_gateway_device_eui_confidence'", 'stores resolved gateway identity confidence in link flow state');
expectIncludes('Validate & decode token', 'Gateway identity is not ready yet. Wait for ChirpStack gateway detection before linking.', 'blocks account linking while gateway identity remains provisional');
expectExcludes('Validate & decode token', "gateway/([0-9A-Fa-f]{16})/event/", 'ad hoc ChirpStack log gateway probing');
expectExcludes('Validate & decode token', "chirpstack-concentratord.@sx1302[0].gateway_id", 'ad hoc concentratord gateway probing');
expectExcludes('Validate & decode token', "uci -q get osi-server.cloud.device_eui 2>/dev/null || true", 'ad hoc UCI gateway probing');
expectExcludes('Validate & decode token', "/sys/class/net/eth0/address", 'ad hoc MAC-derived gateway probing');
expectIncludes('Handle server auth response', 'statusCode >= 400 && statusCode < 500', 'maps remote auth failures away from 401');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('sync token')", 'requires sync token on successful link');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('offline verifier')", 'requires offline verifier on successful link');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('MQTT password')", 'requires MQTT password on successful link');
expectIncludes('Handle server auth response', "requiredFieldErrors.push('MQTT broker URL')", 'requires MQTT broker URL on successful link');
expectIncludes('Handle server auth response', 'const mqttPassword = String(data.mqttPassword || data.mqtt_password || \'\').trim();', 'accepts MQTT credentials from local-sync');
expectIncludes('Handle server auth response', "flow.set('al_mqtt_password', mqttPassword);", 'stores MQTT password from local-sync');
expectIncludes('Handle server auth response', "flow.set('al_mqtt_broker_url', mqttBrokerUrl);", 'stores MQTT broker URL from local-sync');
expectIncludes('Handle server auth response', 'function extractHostFromAbsoluteUrl(value)', 'uses a runtime-compatible MQTT URL parser');
expectIncludes('Handle server auth response', "const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));", 'falls back to regex host extraction when URL is unavailable');
expectExcludes('Handle server auth response', 'new URL(mqttBrokerUrl);', 'a direct MQTT broker URL constructor check that can fail on older runtimes');
expectExcludes('Handle server auth response', 'UPDATE users SET server_username', 'direct linked-account DB mutation');
expectIncludes('Build server auth request', 'deviceEuis,', 'sends local device claims in the authenticated local-sync request');
expectIncludes('Build server auth request', "new osiDb.Database('/data/db/farming.db')", 'loads local device claims before cloud linking');
expectIncludes('Build server auth request', 'Gateway identity is not configured yet', 'fails locally when no canonical gateway EUI is available');
expectIncludes('Build server auth request', 'Gateway identity is not ready yet. Wait for ChirpStack gateway detection before linking.', 'fails linking while gateway identity remains provisional');
expectIncludes('Build server auth request', 'localUserUuid', 'sends the local user UUID for linked-auth targeting');
expectIncludes('Build server auth request', 'localUsernameSnapshot', 'sends the local username snapshot for linked-auth targeting');
expectIncludes('Build server auth request', 'edgeBuildVersion', 'sends the edge build version during local-sync');
expectIncludes('Build server auth request', 'syncCapabilities', 'advertises linked-auth sync capabilities during local-sync');
expectIncludes('Build server auth request', 'linked_auth_sync_v1', 'advertises the linked-auth sync capability');
expectIncludes('Build server auth request', 'force_edge_sync_v1', 'advertises the force-edge-sync capability');
expectIncludes('Handle server auth response', "const claimed = Array.isArray(data.claimed)", 'accepts claimed device results directly from local-sync');
expectIncludes('Handle server auth response', 'offlineVerifierVersion', 'requires and stores the offline verifier version from local-sync');
expectIncludes('Decode token & build query', 'server_offline_verifier_version', 'loads linked-auth verifier metadata for account-link status');
expectIncludes('Format status response', 'linkedAuthPackageValid', 'reports linked-auth package validity in account-link status');
expectIncludes('Format status response', 'linkedAuthRepairRequired', 'reports linked-auth repair requirements in account-link status');
expectIncludes('Format status response', "linkedAuthRepairRequired ? 'repair_required'", 'downgrades stale linked-auth state in account-link status');
expectIncludes('Build Sync State', 'lastMirroredEventAt', 'returns the last mirrored sync event timestamp');
expectIncludes('Build Sync State', 'dbHealth: {', 'returns a DB health block in sync state');
expectIncludes('Build Sync State', "journalMode: helperHealth.journalMode || null", 'returns SQLite journal mode in sync state');
expectIncludes('Build Sync State', "quickCheck: quickCheck.status", 'returns quick-check status in sync state');
expectIncludes('Build Sync State', "lastError: helperHealth.lastError || null", 'returns helper DB errors in sync state');
expectIncludes('Build Sync State', 'linkedAuthPackageValid', 'reports linked-auth package validity in sync state');
expectIncludes('Build Sync State', 'linkedAuthRepairRequired', 'reports linked-auth repair requirements in sync state');
expectIncludes('Build Sync State', 'migrationCandidateSources', 'reports gateway migration candidate sources in sync state');
expectIncludes('Build Sync State', 'rejectedMigrationCandidates', 'reports rejected gateway migration candidates in sync state');
expectIncludes('Finalize linked account state', 'UPDATE users SET server_username = ?', 'commits linked-account DB state only after MQTT persistence');
expectIncludes('Finalize linked account state', "auth_mode = ?", 'finalizes linked auth mode explicitly');
expectIncludes('Finalize linked account state', 'server_offline_verifier_version = ?', 'persists the synced offline verifier version locally');
expectIncludes('Finalize linked account state', 'last_auth_sync_status = ?', 'marks linked auth as up to date after local-sync finalization');
expectIncludes('Finalize linked account state', 'return [null, msg];', 'can stop before reporting link success');
expectIncludes('Set Download Headers', 'Database download is disabled', 'keeps database download disabled');
expectIncludes('Lookup Auth User', 'ORDER BY CASE WHEN username = ?', 'prefers local username matches');
expectIncludes('Process Result', 'Multiple accounts match this username', 'rejects ambiguous linked logins');
expectIncludes('Process Result', 'osi_auth_token_secret', 'uses a persisted local auth secret');
expectIncludes('Process Result', "env.get('LINK_GATEWAY_DEVICE_EUI')", 'uses the linked gateway identity captured at account-link time');
expectIncludes('Process Result', 'decodeGatewayDeviceEuiFromSyncToken', 'falls back to the gateway encoded into the sync token');
expectIncludes('Process Result', "env.get('DEVICE_EUI')", 'uses canonical runtime gateway identity only as a last resort');
expectExcludes('Process Result', "gateway/([0-9A-Fa-f]{16})/event/", 'ad hoc ChirpStack log gateway probing during linked login');
expectExcludes('Process Result', "chirpstack-concentratord.@sx1302[0].gateway_id", 'ad hoc concentratord gateway probing during linked login');
expectExcludes('Process Result', "uci -q get osi-server.cloud.device_eui 2>/dev/null || true", 'ad hoc UCI gateway probing during linked login');
expectExcludes('Process Result', "/sys/class/net/eth0/address", 'ad hoc MAC-derived gateway probing during linked login');
expectIncludes('Route Command', "var valveTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();", 'normalizes valve commands from either deviceEui or devEui');
expectIncludes('Route Command', 'device: { devEui: valveTargetEui }', 'routes normalized valve commands to the STREGA actuator path');
expectIncludes('Route Command', "commandType === 'SYNC_LINKED_AUTH'", 'routes linked-auth sync commands through the special command handler');
expectIncludes('Route Command', "commandType === 'FORCE_EDGE_SYNC'", 'routes force-edge-sync commands through the special command handler');
expectIncludes('CS Register Device', 'chirpstack.createProvisioningClientFromEnv(env)', 'uses shared ChirpStack provisioning helper');
expectIncludes('CS Register Device', 'ensureDeviceProvisioned', 'provisions devices through gRPC helper');
expectExcludes('CS Register Device', '/api/devices', 'legacy ChirpStack REST device endpoint');
expectIncludes('CS Register (cloud cmd)', 'chirpstack.createProvisioningClientFromEnv(env)', 'uses shared ChirpStack provisioning helper');
expectIncludes('CS Register (cloud cmd)', 'ensureDeviceProvisioned', 'provisions cloud-triggered devices through gRPC helper');
expectExcludes('CS Register (cloud cmd)', '/api/devices', 'legacy ChirpStack REST device endpoint');
expectIncludes('CS Register (cloud cmd)', "commandType === 'SYNC_LINKED_AUTH'", 'handles linked-auth sync commands');
expectIncludes('CS Register (cloud cmd)', "commandType === 'FORCE_EDGE_SYNC'", 'handles force-edge-sync commands');
expectIncludes('CS Register (cloud cmd)', 'localUserUuid', 'targets linked-auth sync by local user UUID first');
expectIncludes('CS Register (cloud cmd)', 'STALE_IGNORED', 'acknowledges stale linked-auth versions without downgrading local auth');
expectIncludes('CS Register (cloud cmd)', 'ALREADY_APPLIED', 'treats duplicate linked-auth commands as idempotent');
expectIncludes('CS Register (cloud cmd)', 'server_offline_verifier_version', 'stores the linked-auth verifier version locally');
expectIncludes('CS Register (cloud cmd)', 'last_auth_sync_status', 'tracks linked-auth apply status locally');
expectIncludes('CS Register (cloud cmd)', 'forceSyncQueued', 'reports queued force-sync requests in the special-command ACK state');
expectIncludes('Build Special Command ACK', 'msg.specialAck', 'formats special command acknowledgments from structured state');
expectIncludes('Build Special Command ACK', 'authSyncOutcome', 'includes linked-auth apply outcomes in the ACK payload');
expectIncludes('Build Special Command ACK', 'forceSyncQueued', 'includes force-sync queue state in the ACK payload');
expectIncludes('Sync Init Schema + Triggers', 'AFTER INSERT ON dendrometer_daily', 'emits dendro daily outbox rows from dendrometer_daily');
expectIncludes('Sync Init Schema + Triggers', 'AFTER UPDATE ON dendrometer_daily', 'updates dendro daily outbox rows from dendrometer_daily');
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(server_username, username)', 'emits linked cloud usernames in device outbox events');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN strega_model TEXT', 'adds the STREGA model metadata column');
expectIncludes('Sync Init Schema + Triggers', "'current_state', NEW.current_state", 'mirrors STREGA current state changes into device outbox events');
expectIncludes('Sync Init Schema + Triggers', "'target_state', NEW.target_state", 'mirrors STREGA target state changes into device outbox events');
expectIncludes('Sync Init Schema + Triggers', "'strega_model', NEW.strega_model", 'mirrors STREGA model changes into device outbox events');
expectIncludes('Sync Init Schema + Triggers', 'CREATE TABLE IF NOT EXISTS gateway_locations', 'creates the gateway GPS mirror table');
expectIncludes('Sync Init Schema + Triggers', 'trg_gateway_locations_outbox_ai', 'creates the gateway GPS insert trigger');
expectIncludes('Sync Init Schema + Triggers', 'GATEWAY_LOCATION_UPSERTED', 'emits gateway GPS sync events');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN area_m2 REAL', 'adds shared zone area config');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN irrigation_efficiency_pct REAL', 'adds shared irrigation efficiency config');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE irrigation_zones ADD COLUMN prediction_card_enabled INTEGER DEFAULT 0', 'adds the synced prediction-card flag to zones');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN server_offline_verifier_version INTEGER DEFAULT 0', 'adds the linked-auth verifier version column to users');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN last_auth_sync_at TEXT', 'adds the linked-auth last-sync timestamp column to users');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN last_auth_sync_status TEXT', 'adds the linked-auth status column to users');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE users ADD COLUMN last_auth_sync_error TEXT', 'adds the linked-auth error column to users');
expectIncludes('Sync Init Schema + Triggers', "UPDATE users SET last_auth_sync_status = 'up_to_date'", 'backfills linked server users with an up-to-date auth status');
expectIncludes('Sync Init Schema + Triggers', "UPDATE users SET last_auth_sync_status = 'repair_required'", 'marks invalid linked-auth packages for repair during sync init');
expectIncludes('Sync Init Schema + Triggers', "const gatewaySql = /^[0-9A-F]{16}$/.test(gateway)", 'uses a canonical gateway-or-NULL SQL fallback during sync init');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN rain_mm_per_10min REAL', 'adds normalized rain telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN flow_liters_per_10min REAL', 'adds normalized flow telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN bat_pct REAL', 'adds STREGA battery percentage storage');
expectIncludes('Sync Init Schema + Triggers', "'area_m2', NEW.area_m2", 'mirrors zone area changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', "'irrigation_efficiency_pct', NEW.irrigation_efficiency_pct", 'mirrors irrigation efficiency changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', "'prediction_card_enabled', COALESCE(NEW.prediction_card_enabled, 0)", 'mirrors prediction-card changes into zone sync events');
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(NEW.prediction_card_enabled,0) <> COALESCE(OLD.prediction_card_enabled,0)', 'queues outbox events when the prediction-card flag changes');
expectIncludes('Sync Init Schema + Triggers', "'rain_mm_per_10min', NEW.rain_mm_per_10min", 'mirrors normalized rain telemetry into device-data sync events');
expectIncludes('Sync Init Schema + Triggers', "'flow_liters_per_10min', NEW.flow_liters_per_10min", 'mirrors normalized flow telemetry into device-data sync events');
expectIncludes('Sync Init Schema + Triggers', 'SELECT name FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data names into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT type_id FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data types into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT irrigation_zone_id FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data zone bindings into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL', 'ignores deleted devices when mirroring device-data gateway bindings into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring zone environment rows into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring zone environment gateway bindings into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring irrigation events into the outbox');
expectIncludes('Sync Init Schema + Triggers', 'SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL', 'ignores deleted zones when mirroring irrigation event gateway bindings into the outbox');
expectExcludes('Sync Init Schema + Triggers', '" + gateway + "', 'malformed literal gateway fallback SQL in sync triggers');
expectExcludes('Sync Init Schema + Triggers', '\'" + gatewaySql + "\'', 'double-quoted gatewaySql fallback fragments in sync init SQL');
const migrationPreflightNodes = ['Build Cloud Bootstrap', 'Build Edge Event Batch', 'Build Pending Command Pull', 'Run Force Sync'];
expectIncludesForEach(migrationPreflightNodes, 'const structuralGatewayDeviceEuis = normalizeGatewayList(', 'derives gateway migration candidates only from structural lineage');
expectIncludesForEach(migrationPreflightNodes, 'gatewayMigrationCandidateSources', 'stores gateway migration candidate source diagnostics');
expectIncludesForEach(migrationPreflightNodes, 'gatewayMigrationRejectedCandidates', 'stores rejected gateway migration candidates');
expectExcludesForEach(migrationPreflightNodes, "\"SELECT gateway_device_eui FROM sync_outbox WHERE delivered_at IS NULL AND gateway_device_eui IS NOT NULL AND gateway_device_eui <> ''\"", 'pending outbox rows as gateway migration candidates');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in bootstrap zone snapshots');
expectIncludes('Build Cloud Bootstrap', 'd.strega_model', 'includes STREGA model metadata in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'd.current_state', 'includes STREGA current state in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', 'd.target_state', 'includes STREGA target state in bootstrap device snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.adc_ch1v,'", 'includes dendrometer reference voltage in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.dendro_ratio,'", 'includes dendrometer ratio in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.dendro_mode_used,'", 'includes the selected dendrometer path in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.dendro_stem_change_um,'", 'includes baseline-relative stem change in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'iz.area_m2', 'includes zone area in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'iz.irrigation_efficiency_pct', 'includes zone irrigation efficiency in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled', 'includes the prediction-card flag in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', "'  dd.rain_mm_per_10min,'", 'includes normalized rain telemetry in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', "'  dd.flow_liters_per_10min,'", 'includes normalized flow telemetry in bootstrap sensor data');
expectIncludes('Build Cloud Bootstrap', 'AS event_uuid', 'synthesizes stable irrigation event UUIDs for bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'gatewayLocations,', 'includes gateway GPS state in bootstrap payloads');
expectIncludes('Build Cloud Bootstrap', 'previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis', 'includes previous gateway identities during bootstrap migration');
expectIncludes('Build Cloud Bootstrap', 'edgeBuildVersion,', 'includes the edge build version in bootstrap gateway metadata');
expectIncludes('Build Cloud Bootstrap', 'syncCapabilities', 'includes sync capabilities in bootstrap gateway metadata');
expectIncludes('Build Cloud Bootstrap', 'runGatewayMigrationPreflight', 'runs local gateway migration preflight before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'gatewayMigrationPaused: true', 'pauses normal sync while a gateway migration repair bootstrap is pending');
expectIncludes('Build Cloud Bootstrap', 'UPDATE irrigation_zones SET gateway_device_eui = ?', 'rewrites active zone gateway bindings during local migration');
expectIncludes('Build Cloud Bootstrap', 'UPDATE devices SET gateway_device_eui = ?', 'rewrites active device gateway bindings during local migration');
expectIncludes('Build Cloud Bootstrap', 'UPDATE sync_outbox SET gateway_device_eui = ?, aggregate_key = ?, payload_json = ?', 'rewrites undelivered sync outbox rows during local migration');
expectIncludes('Build Cloud Bootstrap', 'rejectedCandidates', 'surfaces rejected migration candidates in bootstrap migration state');
expectIncludes('Mark Bootstrap Synced', "gatewayMigration.migrated", 'recognizes successful cloud-side gateway migration responses');
expectIncludes('Mark Bootstrap Synced', 'gatewayMigrationPendingBootstrap = false', 'resumes normal sync after repair bootstrap succeeds');
expectIncludes('Build Edge Event Batch', 'gatewayMigrationPaused', 'suppresses event delivery while gateway migration is paused');
expectIncludes('Build Pending Command Pull', 'gatewayMigrationPaused', 'suppresses pending-command polling while gateway migration is paused');
expectIncludes('Build Sync State', 'gatewayIdentity = {', 'returns gateway identity diagnostics in sync state');
expectIncludes('Build Sync State', 'migrationPending', 'reports pending gateway migration state in sync state');
expectIncludes('Build Sync State', 'lastMigrationResult', 'reports last gateway migration result in sync state');
expectIncludes('Build Cloud Bootstrap', 'const sensorDataRows = await q([', 'loads bootstrap sensor history before reordering it');
expectIncludes('Build Cloud Bootstrap', 'const sensorData = sensorDataRows.slice().reverse();', 'replays bootstrap sensor history oldest-to-newest');
expectIncludes('Build Cloud Bootstrap', 'const dendroReadingsRows = await q([', 'loads bootstrap dendro history before reordering it');
expectIncludes('Build Cloud Bootstrap', 'const dendroReadings = dendroReadingsRows.slice().reverse();', 'replays bootstrap dendro history oldest-to-newest');
expectIncludes('Build Cloud Bootstrap', 'function normalizeIsoTimestamp(value)', 'normalizes malformed edge timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'deleted_at: normalizeIsoTimestamp(z.deleted_at)', 'normalizes zone tombstone timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0)', 'exports the prediction-card flag in bootstrap payloads');
expectIncludes('Build Cloud Bootstrap', 'devices: devices.map(sanitizeSyncRow)', 'normalizes device tombstone timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'schedules: schedules.map(sanitizeSyncRow)', 'normalizes schedule timestamps before bootstrap sync');
expectIncludes('Build Cloud Bootstrap', 'LEFT JOIN devices d ON d.deveui = dd.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting bootstrap sensor history');
expectIncludes('Build Cloud Bootstrap', 'LEFT JOIN devices d ON d.deveui = dr.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting bootstrap dendro history');
expectIncludes('Build Cloud Bootstrap', 'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL', 'ignores deleted zones when exporting bootstrap history');
expectIncludes('Mark Bootstrap Synced', "(msg.payload || {}).detail || 'Bootstrap sync failed'", 'preserves server ProblemDetail details for bootstrap errors');
expectWireById('al-link-handle-auth', 'al-link-store-mqtt', 'persists MQTT credentials after successful account linking');
expectWireById('al-link-store-mqtt', 'al-link-finalize', 'finalizes linked-account state only after MQTT config persistence');
expectWireById('al-link-finalize', 'al-link-success', 'formats a success response only after linked-account finalization');
expectWireById('al-link-finalize', 'al-link-rollback-mqtt', 'rolls back MQTT credentials when linked-account finalization fails');
expectWireById('al-link-success', 'al-link-restart-node-red', 'schedules restart only after link success is fully prepared');
expectWireById('al-link-restart-node-red', 'al-link-bootstrap-link-out', 'triggers an immediate bootstrap only after scheduling the link restart');
expectWireById('al-link-restart-node-red', 'al-link-clear-state', 'clears transient link state only after successful link restart scheduling');
expectMissingNodeById('al-link-build-claim', 'the legacy claim-bulk account-link request path');
expectMissingNodeById('al-link-server-claim', 'the legacy claim-bulk account-link HTTP request path');
expectMissingNodeById('al-link-handle-claim', 'the legacy claim-bulk response handler');
expectMissingNodeById('al-link-db-update', 'the legacy pre-MQTT link finalization query');
expectWireById('sync-bootstrap-account-link-in', 'sync-bootstrap-build', 'routes post-link bootstrap triggers into the bootstrap builder');
expectWireById('al-unlink-func', 'al-unlink-clear-mqtt', 'clears MQTT credentials only after unlink auth succeeds');
expectWireById('al-unlink-clear-mqtt', 'al-unlink-db', 'clears linked account state only after MQTT credentials are removed');
expectWireById('al-unlink-db', 'al-unlink-restore-mqtt', 'restores MQTT credentials when unlink database cleanup fails');
expectWireById('al-unlink-format', 'al-unlink-restart-node-red', 'schedules restart only after unlink state is cleared successfully');
expectWireById('al-unlink-restart-node-red', 'al-link-clear-state', 'clears transient link state only after successful unlink restart scheduling');
expectIncludes('Persist MQTT Broker Config', "set osi-server.cloud.mqtt_password=", 'writes the MQTT password into UCI after linking');
expectIncludes('Persist MQTT Broker Config', "set osi-server.cloud.link_gateway_device_eui=", 'persists the linked gateway identity into UCI after linking');
expectIncludes('Persist MQTT Broker Config', 'Linked account response is missing MQTT credentials', 'fails linking when MQTT credentials are incomplete');
expectIncludes('Persist MQTT Broker Config', 'msg._mqttConfigBackup = {', 'backs up prior MQTT config before persisting linked credentials');
expectIncludes('Persist MQTT Broker Config', "const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));", 'falls back to regex host extraction when URL is unavailable');
expectExcludes('Persist MQTT Broker Config', '/etc/init.d/node-red restart', 'Node-RED restart while link persistence is still in flight');
expectWireById('al-link-handle-auth', 'al-link-clear-state', 'clears transient link state when server auth fails');
expectWireById('al-link-store-mqtt', 'al-link-clear-state', 'clears transient link state when MQTT persistence fails');
expectIncludes('Clear MQTT Broker Config', "set osi-server.cloud.mqtt_password=' + shellQuote('')", 'clears the MQTT password from UCI after unlinking');
expectIncludes('Clear MQTT Broker Config', "set osi-server.cloud.link_gateway_device_eui=' + shellQuote('')", 'clears the linked gateway identity from UCI after unlinking');
expectIncludes('Clear MQTT Broker Config', 'msg._mqttConfigBackup = {', 'backs up prior MQTT config before unlink cleanup');
expectExcludes('Clear MQTT Broker Config', '/etc/init.d/node-red restart', 'Node-RED restart while unlink cleanup is still in flight');
expectIncludes('Rollback MQTT Broker Config', 'rolled back MQTT credentials', 'restores prior MQTT config when link finalization fails');
expectIncludes('Restore MQTT Broker Config', 'restored MQTT credentials', 'restores prior MQTT config when unlink finalization fails');
expectIncludes('Schedule Link Restart', '/etc/init.d/node-red restart', 'schedules a Node-RED restart only after successful link completion');
expectIncludes('Schedule Unlink Restart', '/etc/init.d/node-red restart', 'schedules a Node-RED restart only after successful unlink completion');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS claimed_by_username', 'uses linked cloud usernames in force-sync device snapshots');
expectIncludes('Run Force Sync', 'COALESCE(u.server_username, u.username) AS username', 'uses linked cloud usernames in force-sync zone snapshots');
expectIncludes('Run Force Sync', 'd.strega_model', 'includes STREGA model metadata in force-sync device snapshots');
expectIncludes('Run Force Sync', 'd.current_state', 'includes STREGA current state in force-sync device snapshots');
expectIncludes('Run Force Sync', 'd.target_state', 'includes STREGA target state in force-sync device snapshots');
expectIncludes('Run Force Sync', "'  dd.lsn50_mode_code,'", 'includes observed LSN50 mode in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.adc_ch1v,'", 'includes dendrometer reference voltage in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.dendro_ratio,'", 'includes dendrometer ratio in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.dendro_mode_used,'", 'includes the selected dendrometer path in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.dendro_stem_change_um,'", 'includes baseline-relative stem change in force-sync sensor data');
expectIncludes('Run Force Sync', 'iz.area_m2', 'includes zone area in force-sync snapshots');
expectIncludes('Run Force Sync', 'iz.irrigation_efficiency_pct', 'includes zone irrigation efficiency in force-sync snapshots');
expectIncludes('Run Force Sync', 'COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled', 'includes the prediction-card flag in force-sync snapshots');
expectIncludes('Run Force Sync', "'  dd.rain_mm_per_10min,'", 'includes normalized rain telemetry in force-sync sensor data');
expectIncludes('Run Force Sync', "'  dd.flow_liters_per_10min,'", 'includes normalized flow telemetry in force-sync sensor data');
expectIncludes('Run Force Sync', 'AS event_uuid', 'synthesizes stable irrigation event UUIDs for forced bootstrap snapshots');
expectIncludes('Run Force Sync', 'gatewayLocations,', 'includes gateway GPS state in forced sync payloads');
expectIncludes('Run Force Sync', 'edgeBuildVersion,', 'includes the edge build version in forced bootstrap gateway metadata');
expectIncludes('Run Force Sync', 'syncCapabilities', 'includes sync capabilities in forced bootstrap gateway metadata');
expectIncludes('Run Force Sync', 'const sensorDataRows = await q([', 'loads force-sync sensor history before reordering it');
expectIncludes('Run Force Sync', 'const sensorData = sensorDataRows.slice().reverse();', 'replays force-sync sensor history oldest-to-newest');
expectIncludes('Run Force Sync', 'const dendroReadingsRows = await q([', 'loads force-sync dendro history before reordering it');
expectIncludes('Run Force Sync', 'const dendroReadings = dendroReadingsRows.slice().reverse();', 'replays force-sync dendro history oldest-to-newest');
expectIncludes('Run Force Sync', 'function normalizeIsoTimestamp(value)', 'normalizes malformed edge timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'deleted_at: normalizeIsoTimestamp(z.deleted_at)', 'normalizes zone tombstone timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0)', 'exports the prediction-card flag in forced bootstrap payloads');
expectIncludes('Run Force Sync', 'devices: devices.map(sanitizeSyncRow)', 'normalizes device tombstone timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'schedules: schedules.map(sanitizeSyncRow)', 'normalizes schedule timestamps before forced bootstrap sync');
expectIncludes('Run Force Sync', 'LEFT JOIN devices d ON d.deveui = dd.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting force-sync sensor history');
expectIncludes('Run Force Sync', 'LEFT JOIN devices d ON d.deveui = dr.deveui AND d.deleted_at IS NULL', 'ignores deleted devices when exporting force-sync dendro history');
expectIncludes('Run Force Sync', 'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL', 'ignores deleted zones when exporting force-sync history');
expectIncludes('Run Force Sync', "(bootstrapRes.payload || {}).detail || 'Bootstrap sync failed'", 'preserves server ProblemDetail details in force-sync bootstrap errors');
expectIncludes('Run Force Sync', "pendingCommands: { attempted: false, succeeded: true, fetchedCount: 0, queuedCount: 0, appliesAfterResponse: false, applyPhase: 'NO_PENDING_COMMANDS'", 'initializes pending-command apply semantics in force-sync summary');
expectIncludes('Run Force Sync', 'summary.pendingCommands.appliesAfterResponse = queueablePendingCommands.length > 0;', 'marks force-sync pending commands as applying after the HTTP response');
expectIncludes('Run Force Sync', "summary.pendingCommands.applyPhase = queueablePendingCommands.length > 0 ? 'QUEUED_LOCAL_APPLY' : 'NO_PENDING_COMMANDS';", 'reports force-sync pending-command apply phase explicitly');
expectIncludes('Run Force Sync', 'msg._forceSyncInternal', 'supports internally queued force-sync sweeps from cloud commands');
expectIncludes('Run Force Sync', 'queueablePendingCommands', 'filters pending commands before queueing them locally');
expectIncludes('Run Force Sync', "commandType || '').trim().toUpperCase() !== 'FORCE_EDGE_SYNC'", 'prevents force-edge-sync commands from recursing through pending-command replay');
expectIncludes('Run Force Sync', 'rejectedCandidates', 'surfaces rejected migration candidates in force-sync migration state');
expectIncludes('Daily Dendrometer Analytics', 'const recoveryThreshold=(calibration.thresholds.mild||CALIBRATIONS.default.thresholds.mild)*(phenoMod>0?phenoMod:1.0);', 'uses calibration-aware recovery threshold');
expectIncludes('Daily Dendrometer Analytics', 't.twd_night_um<recoveryThreshold', 'uses absolute night TWD in recovery verification');
expectIncludes('Daily Dendrometer Analytics', "date>=date('${ANALYTICS_DATE}','-3 days')", 'uses the exact previous-three-day recovery window');
expectIncludes('Daily Dendrometer Analytics', "stressAdjustment='vpd_downgrade';", 'downgrades stress on high-VPD good-recovery days');
expectIncludes('Daily Dendrometer Analytics', "stressAdjustment='vpd_upgrade';", 'upgrades stress on low-VPD poor-recovery days');
expectIncludes('Daily Dendrometer Analytics', 'sdVpdR2Current=computeR2(', 'computes rolling SD-VPD correlation');
expectIncludes('Daily Dendrometer Analytics', 'sdVpdDecoupled=sdVpdR2Current!=null&&sdVpdR2Current<0.5*bl.sd_vpd_r2_baseline;', 'flags SD-VPD decoupling against the baseline');
expectIncludes('Daily Dendrometer Analytics', 't.baseline_complete===1', 'requires completed baselines for recovery verification pass checks');
expectIncludes('Daily Dendrometer Analytics', 't.mds_norm>0.7', 'requires strong MDS recovery before ending verification');
expectIncludes('Daily Dendrometer Analytics', 'vpd_override_summary:vpdOverrideSummary', 'stores VPD override diagnostics in recommendation_json');
expectIncludes('Daily Dendrometer Analytics', 'sd_vpd_summary:sdVpdSummary', 'stores SD-VPD diagnostics in recommendation_json');
expectIncludes('Get Zone Recommendations', 'zdr.recommendation_json', 'returns recommendation_json from the zone recommendation query');
expectIncludes('Get Zone Recommendations', 'recommendation_json:r.recommendation_json ?? null', 'exposes recommendation_json in the local recommendations API');
expectIncludes('Daily Dendrometer Analytics', "env.get('OPENAGRI_WEATHER_RADIUS_KM')", 'supports configurable OpenAgri history search radius for edge analytics');
expectIncludes('Get Zone Environment Summary', 'CREATE TABLE IF NOT EXISTS zone_weather_cache', 'creates a local weather cache table for environment summaries');
expectIncludes('Get Zone Environment Summary', "env.get('OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES')", 'supports configurable current-weather cache TTL');
expectIncludes('Get Zone Environment Summary', "env.get('OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES')", 'supports configurable forecast cache TTL');
expectIncludes('Get Zone Environment Summary', "const lib = urlString.startsWith('https:') ? httpsLib : httpLib;", 'uses imported HTTP clients inside the Node-RED function runtime');
expectIncludes('Get Zone Environment Summary', "preferredSource: usingLocal ? 'local'", 'prioritizes local sensor climate over online weather for agronomic metrics');
expectIncludes('Get Zone Environment Summary', 'LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui', 'falls back to mirrored gateway coordinates when a zone has no explicit location');
expectIncludes('Get Zone Environment Summary', 'SELECT date,rainfall_mm,flow_liters,rain_source,computed_at FROM zone_daily_environment', 'uses daily zone environment totals for water summary');
expectIncludes('Get Zone Environment Summary', 'const water = await buildWaterEnvironment', 'builds a dedicated water summary block');
expectIncludes('Get Zone Environment Summary', 'areaM2: toFiniteNumber(zone && zone.area_m2)', 'exposes zone area in water summary');
expectIncludes('Get Zone Environment Summary', 'sensorHealth: buildSensorHealth(deviceRows, local)', 'reports water sensor health and warnings');
expectIncludes('Build Telemetry', 'lsn50_mode_code: observedModeCode', 'publishes observed LSN50 mode in edge telemetry');
expectIncludes('Build Telemetry', 'convertHzToKPa(numberOrNull(obj.watermark1_frequency))', 'converts Kiwi watermark frequency telemetry to kPa for cloud mirroring');
expectIncludes('Build Telemetry', "var isLsn50 = profileKind === 'DRAGINO_LSN50';", 'gates LSN50-only telemetry fields by profile');
expectIncludes('Build Telemetry', 'var observedModeCode = isLsn50 && rawLsn50 && rawLsn50.modeCode != null ? rawLsn50.modeCode : null;', 'avoids assigning LSN50 mode codes to Kiwi telemetry');
expectIncludes('Build Telemetry', "profileKind === 'STREGA_VALVE'", 'skips valve uplinks in sensor telemetry mirroring');
expectIncludes('Build Telemetry', 'normalizeStregaEnvironment', 'applies sentinel-aware STREGA environmental normalization in cloud telemetry');
expectIncludes('Build Telemetry', 'if (!profileKind && swtWm1 === null && swtWm2 === null', 'skips unknown no-data uplinks instead of defaulting them to Kiwi');
expectIncludes('Build Telemetry', 'loadLsn50Config', 'loads local dendrometer config before telemetry conversion');
expectIncludes('Build Telemetry', 'var rawLsn50 = isLsn50 && data.data ? dendro.decodeRawAdcPayload(data.data) : null;', 'reuses shared raw LSN50 ADC decoding in telemetry mirroring');
expectIncludes('Build Telemetry', 'var derived = dendro.buildDendroDerivedMetrics({', 'reuses shared dendrometer path selection in telemetry mirroring');
expectIncludes('Build Telemetry', 'dendro.computeDendroDeltaMm({', 'reuses shared dendrometer delta handling in telemetry mirroring');
expectIncludes('Build Telemetry', 'dendro_stem_change_um: stemChangeUm,', 'publishes baseline-relative stem change in live MQTT telemetry');
expectExcludes('Build Telemetry', "if (profileKind === 'STREGA_VALVE') return null;", 'dropping STREGA telemetry from cloud MQTT mirroring');
expectIncludes('Build Telemetry', 'gatewayDeviceEui: piEui', 'includes the gateway transport identity in cloud telemetry payloads');
expectIncludesById('81c98fb07344a787', "env.get('CHIRPSTACK_PROFILE_KIWI')", 'uses env-backed Kiwi profile routing');
expectIncludesById('81c98fb07344a787', "env.get('CHIRPSTACK_PROFILE_CLOVER')", 'uses env-backed Clover profile routing');
expectIncludesById('strega-process-fn', "getProfileKind(data.deviceInfo || {})", 'derives STREGA profile routing on the dedicated edge path');
expectIncludesById('strega-process-fn', 'decodeStregaFallback', 'falls back to the managed STREGA codec when ChirpStack has no decoded object');
expectIncludesById('strega-process-fn', 'normalizeBatteryPercent', 'normalizes Gen1 STREGA battery values for local storage');
expectIncludesById('strega-process-fn', 'normalizeStregaEnvironment', 'drops the FFFF/FFFF sentinel environmental pair in local storage');
expectIncludesById('strega-process-fn', 'normalizeStateFromValveBit', 'maps the Gen1 STREGA valve bit into local OPEN/CLOSED state');
expectIncludes('Decode LSN50', 'const rawDecoded = data.data ? dendro.decodeRawAdcPayload(data.data) : null;', 'uses the shared raw LSN50 ADC decoder');
expectIncludes('Decode LSN50', 'adcCh1V = dendro.toFiniteNumber(obj.ADC_CH1V);', 'reads ADC_CH1V from decoded MOD3 payloads');
expectIncludes('Decode LSN50', 'adcCh4V = dendro.toFiniteNumber(obj.ADC_CH4V);', 'reads ADC_CH4V when present without using it for dendrometer conversion');
expectIncludes('Decode LSN50', 'const observedModeCode = rawDecoded && rawDecoded.modeCode != null ? rawDecoded.modeCode : null;', 'decodes observed LSN50 mode from shared raw uplink parsing');
expectIncludes('Decode LSN50', "env.get('CHIRPSTACK_PROFILE_LSN50')", 'filters uplinks to the env-backed LSN50 profile');
expectIncludes('Decode LSN50', 'chameleonPayloadVersion', 'normalizes Chameleon payload version from decoder output');
expectIncludes('Decode LSN50', 'chameleonR1OhmComp', 'normalizes Chameleon compensated resistance fields');
expectIncludes('Decode LSN50', 'rawPayloadB64: msg._rawPayload', 'keeps the raw LoRaWAN payload base64 for Chameleon replay');
expectIncludes('Apply Config', 'd.modeCodeToStore = d.observedModeCode != null ? d.observedModeCode : effectiveMode;', 'stores observed or configured LSN50 mode on ingest');
expectIncludes('Apply Config', 'chameleon.buildChameleonSwtMetrics', 'derives Chameleon SWT metrics without bypassing dendrometer logic');
expectIncludes('Apply Config', 'd.swt1Kpa = swt.swt1Kpa;', 'stores derived SWT1 in formattedData');
expectIncludes('Apply Config', 'if (!dendroEnabled)', 'keeps dendrometer enablement as the persistence gate after Chameleon derivation');
expectExcludes('Apply Config', '} else if (d.isChameleon === true) {', 'the old dedicated Chameleon bypass branch');
expectIncludes('Apply Config', 'Chameleon flags 0x', 'surfaces Chameleon status in node status text');
expectIncludes('Apply Config', 'loadPreviousMod9Sample', 'loads the last persisted MOD9 sample before computing deltas');
expectIncludes('Apply Config', 'd.counterIntervalSeconds = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : null;', 'computes elapsed seconds between MOD9 uplinks');
expectIncludes('Apply Config', "if (currentCount < previousCount) return { deltaCount: null, status: 'counter_reset' };", 'treats counter decreases as resets instead of inflating deltas');
expectIncludes('Apply Config', "const duplicateState = futureRecordedAt === d.timestamp ? 'duplicate_timestamp' : 'out_of_order';", 'guards MOD9 deltas against duplicate and out-of-order uplinks');
expectIncludes('Apply Config', 'd.rainMmPerHour = d.counterIntervalSeconds', 'derives a rain rate from the elapsed interval');
expectIncludes('Apply Config', 'd.flowLitersPerMin = d.counterIntervalSeconds', 'derives a flow rate from the elapsed interval');
expectIncludes('Apply Config', 'd.rainMmPer10Min = d.counterIntervalSeconds', 'derives normalized rain per 10 minutes');
expectIncludes('Apply Config', 'd.flowLitersPer10Min = d.counterIntervalSeconds', 'derives normalized flow per 10 minutes');
expectIncludes('Apply Config', 'loadTodayCounterTotals', 'derives running daily rain and flow totals from persisted counters');
expectIncludes('Apply Config', 'const derived = dendro.buildDendroDerivedMetrics({', 'uses the shared dual-path dendrometer conversion helper');
expectIncludes('Apply Config', 'd.dendroModeUsed = derived.dendroModeUsed;', 'stores which dendrometer conversion path was applied');
expectIncludes('Apply Config', 'd.dendroRatio = derived.dendroRatio;', 'stores the derived dendrometer ratio');
expectIncludes('Apply Config', 'd.dendroCalibrationMissing = derived.calibrationMissing;', 'tracks missing ratio calibration without emitting NaN values');
expectIncludes('Apply Config', 'const delta = dendro.computeDendroDeltaMm({', 'resets dendrometer deltas when path or calibration changes');
expectIncludes('Apply Config', 'const stemChange = dendro.computeDendroStemChangeUm({', 'derives a baseline-relative stem change signal for the basic card and monitor');
expectIncludes('Apply Config', 'd.dendroStemChangeUm = stemChange.stemChangeUm;', 'stores the baseline-relative stem change alongside mechanical position');
expectIncludes('Apply Config', 'dendro_baseline_pending = 0,', 'clears the pending-baseline flag when a new valid stem-change baseline is persisted');
expectIncludes('Insert Chameleon Reading', 'INSERT INTO chameleon_readings', 'persists decoded Chameleon readings locally');
expectIncludes('Insert Chameleon Reading', 'if (!d || d.isChameleon !== true) return msg;', 'passes non-Chameleon LSN50 payloads downstream');
expectExcludes('Build Dendrometer Readings INSERT', 'd.isChameleon === true', 'the old Chameleon dendrometer insert skip');
expectLibById('lsn50-decode-fn', 'dendro', 'osi-dendro-helper', 'imports osi-dendro-helper in Decode LSN50');
expectLibById('lsn50-apply-config', 'dendro', 'osi-dendro-helper', 'imports osi-dendro-helper in Apply Config');
expectLibById('lsn50-apply-config', 'chameleon', 'osi-chameleon-helper', 'imports osi-chameleon-helper in Apply Config');
expectLibById('chameleon-readings-insert-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper in Insert Chameleon Reading');
expectWireById('lsn50-zone-agg-fn', 'chameleon-readings-insert-fn', 'routes LSN50 flow through Chameleon insert');
expectWireById('chameleon-readings-insert-fn', 'dendro-readings-insert-fn', 'passes Chameleon insert output to dendrometer insert');
expectLibById('8809bb5239dfb3d4', 'dendro', 'osi-dendro-helper', 'imports osi-dendro-helper in Build Telemetry');
expectIncludesById('strega-sql-fn', 'await db.transaction(async (tx) => {', 'serializes STREGA persistence through one helper-scoped transaction');
expectIncludesById('strega-sql-fn', 'await tx.run(', 'issues parameterized statements inside the transaction scope');
expectIncludesById('strega-sql-fn', 'INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, bat_pct) VALUES (?, ?, ?, ?, ?)', 'persists STREGA telemetry into device_data with parameters');
expectIncludesById('strega-sql-fn', "UPDATE devices SET current_state = ?, updated_at = ?, sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui = ? AND COALESCE(UPPER(current_state), '') <> ?", 'conditionally updates the canonical local STREGA valve state on uplink');
expectIncludesById('strega-sql-fn', 'ambient_temperature, relative_humidity, bat_pct', 'stores decoded STREGA telemetry in local device_data columns');
expectIncludesById('strega-sql-fn', 'current_state: observedState', 'returns the observed local STREGA valve state');
expectExcludesById('strega-sql-fn', 'BEGIN IMMEDIATE;', 'the old manual transaction opener inside the function node');
expectExcludesById('strega-sql-fn', 'COMMIT;', 'the old manual transaction committer inside the function node');
expectExcludesById('strega-sql-fn', 'ROLLBACK;', 'the old manual rollback branch inside the function node');
expectLibById('strega-sql-fn', 'osiDb', 'osi-db-helper', 'opens the local STREGA database directly');
expectExcludesById('strega-sql-fn', "await run('BEGIN IMMEDIATE')", 'the old multi-await transaction entrypoint');
expectExcludesById('strega-sql-fn', "await run('COMMIT')", 'the old multi-await commit call');
expectExcludesById('strega-sql-fn', "await run('ROLLBACK')", 'the old multi-await rollback call');
expectExcludesById('strega-sql-fn', "msg.topic = insertSql + '; ' + updateSql + ';'", 'the old multi-statement sqlite topic builder');
expectExcludesById('strega-sql-fn', 'target_state', 'passive STREGA uplinks from touching target_state');
expectIncludesById('lsn50-sql-fn', 'lsn50_mode_code, lsn50_mode_label, lsn50_mode_observed_at', 'persists observed LSN50 mode into device_data');
expectIncludesById('lsn50-sql-fn', 'rain_mm_per_hour, rain_mm_per_10min, rain_mm_today, rain_delta_status', 'persists interval-aware rain metadata into device_data');
expectIncludesById('lsn50-sql-fn', 'flow_liters_per_min, flow_liters_per_10min, flow_liters_today, flow_delta_status', 'persists interval-aware flow metadata into device_data');
expectIncludesById('lsn50-sql-fn', 'rain_mm_per_10min, rain_mm_today', 'persists normalized and daily rain telemetry into device_data');
expectIncludesById('lsn50-sql-fn', 'flow_liters_per_10min, flow_liters_today', 'persists normalized and daily flow telemetry into device_data');
expectIncludesById('lsn50-sql-fn', 'counter_interval_seconds', 'persists elapsed counter interval into device_data');
expectIncludesById('lsn50-sql-fn', 'adc_ch0v, adc_ch1v, swt_1, swt_2, swt_3,', 'persists dendrometer ADC channels and derived Chameleon SWT into device_data');
expectIncludesById('lsn50-sql-fn', 'dendro_ratio, dendro_mode_used, dendro_position_raw_mm, dendro_position_mm, dendro_valid, dendro_delta_mm,', 'persists dual-path dendrometer raw and compatibility positions into device_data');
expectIncludesById('lsn50-sql-fn', 'dendro_stem_change_um,', 'persists baseline-relative stem change into device_data');
expectIncludesById('lsn50-sql-fn', 'dendro_saturated, dendro_saturation_side,', 'persists dendrometer saturation metadata into device_data');
expectIncludesById('lsn50-zone-agg-fn', "localDateIso(d.timestamp || computedAt", 'bins MOD9 zone totals by uplink timestamp instead of processing time');
expectIncludesById('lsn50-zone-agg-fn', "d.rainDeltaStatus === 'ok'", 'only aggregates valid rain deltas into zone totals');
expectIncludesById('lsn50-zone-agg-fn', "d.flowDeltaStatus === 'ok'", 'only aggregates valid flow deltas into zone totals');
expectIncludesById('format-devices', 'dd.lsn50_mode_code', 'returns observed LSN50 mode in GET /api/devices');
expectIncludesById('format-devices', 'dd.adc_ch1v', 'returns dendrometer CH1 voltage in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_ratio', 'returns dendrometer ratio in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_mode_used', 'returns the active dendrometer conversion path in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_position_raw_mm', 'returns raw dendrometer position in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_stem_change_um', 'returns baseline-relative stem change in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_saturated', 'returns dendrometer saturation state in GET /api/devices');
expectIncludesById('format-devices', 'dd.dendro_saturation_side', 'returns dendrometer saturation side in GET /api/devices');
expectIncludesById('format-devices', 'dd.swt_1', 'returns Chameleon SWT channel 1 in GET /api/devices');
expectIncludesById('format-devices', 'dd.swt_2', 'returns Chameleon SWT channel 2 in GET /api/devices');
expectIncludesById('format-devices', 'dd.swt_3', 'returns Chameleon SWT channel 3 in GET /api/devices');
expectIncludesById('format-devices', 'ch.id AS chameleon_reading_id', 'returns latest Chameleon reading row id in GET /api/devices');
expectIncludesById('format-devices', 'ch.payload_b64 AS chameleon_payload_b64', 'returns latest Chameleon raw payload in GET /api/devices');
expectIncludesById('format-devices', 'ch.payload_version AS chameleon_payload_version', 'returns latest Chameleon payload version in GET /api/devices');
expectIncludesById('format-devices', 'ch.status_flags AS chameleon_status_flags', 'returns latest Chameleon status flags in GET /api/devices');
expectIncludesById('format-devices', 'ch.temp_c AS chameleon_temp_c', 'returns latest Chameleon board temperature in GET /api/devices');
expectIncludesById('format-devices', 'ch.i2c_missing AS chameleon_i2c_missing', 'returns latest Chameleon I2C-missing flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.timeout AS chameleon_timeout', 'returns latest Chameleon timeout flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.temp_fault AS chameleon_temp_fault', 'returns latest Chameleon temp-fault flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.id_fault AS chameleon_id_fault', 'returns latest Chameleon ID-fault flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.ch1_open AS chameleon_ch1_open', 'returns latest Chameleon channel-open flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.ch2_open AS chameleon_ch2_open', 'returns latest Chameleon channel 2 open flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.ch3_open AS chameleon_ch3_open', 'returns latest Chameleon channel 3 open flag in GET /api/devices');
expectIncludesById('format-devices', 'ch.r1_ohm_comp AS chameleon_r1_ohm_comp', 'returns latest Chameleon compensated resistance in GET /api/devices');
expectIncludesById('format-devices', 'ch.r2_ohm_comp AS chameleon_r2_ohm_comp', 'returns latest Chameleon channel 2 compensated resistance in GET /api/devices');
expectIncludesById('format-devices', 'ch.r3_ohm_comp AS chameleon_r3_ohm_comp', 'returns latest Chameleon channel 3 compensated resistance in GET /api/devices');
expectIncludesById('format-devices', 'ch.r1_ohm_raw AS chameleon_r1_ohm_raw', 'returns latest Chameleon raw resistance in GET /api/devices');
expectIncludesById('format-devices', 'ch.r2_ohm_raw AS chameleon_r2_ohm_raw', 'returns latest Chameleon channel 2 raw resistance in GET /api/devices');
expectIncludesById('format-devices', 'ch.r3_ohm_raw AS chameleon_r3_ohm_raw', 'returns latest Chameleon channel 3 raw resistance in GET /api/devices');
expectIncludesById('format-devices', 'ch.array_id AS chameleon_array_id', 'returns latest Chameleon array id in GET /api/devices');
expectIncludesById('format-devices', 'LEFT JOIN (', 'joins latest Chameleon readings in GET /api/devices');
expectIncludesById('format-devices', '/^[0-9A-F]{16}$/.test(deveui)', 'filters GET /api/devices latest-data lookup to canonical uppercase DevEUIs');
expectIncludesById('format-devices', 'if (!validDevEuis.length)', 'avoids invalid SQL when no canonical DevEUIs are available');
expectIncludesById('format-devices', "msg.topic = 'SELECT NULL AS deveui WHERE 0';", 'uses a no-row latest-data query for empty device lookups');
expectIncludesById('format-devices', "if (!msg.payload || msg.payload.length === 0) {\n  msg.statusCode = 200;\n  msg.payload = [];\n  msg.topic = 'SELECT NULL AS deveui WHERE 0';\n  return msg;\n}", 'sets a sqlite topic before returning an empty device list');
expectIncludesById('format-devices', "if (!validDevEuis.length) {\n  msg.statusCode = 200;\n  msg.payload = [];\n  msg.topic = 'SELECT NULL AS deveui WHERE 0';\n  return msg;\n}", 'sets a sqlite topic before returning an all-invalid DevEUI list');
expectIncludesById('format-devices', 'newer.recorded_at > cr.recorded_at', 'selects the latest Chameleon reading by timestamp');
expectIncludesById('format-devices', 'newer.recorded_at = cr.recorded_at AND newer.id > cr.id', 'breaks same-timestamp Chameleon ties by row id');
expectIncludesById('format-devices', 'dd.rain_mm_per_hour', 'returns interval-aware rain rate in GET /api/devices');
expectIncludesById('format-devices', 'dd.flow_liters_per_min', 'returns interval-aware flow rate in GET /api/devices');
expectIncludesById('format-devices', 'dd.rain_mm_per_10min', 'returns normalized rain telemetry in GET /api/devices');
expectIncludesById('format-devices', 'dd.flow_liters_per_10min', 'returns normalized flow telemetry in GET /api/devices');
expectIncludesById('format-devices', 'dd.counter_interval_seconds', 'returns elapsed counter interval in GET /api/devices');
expectIncludesById('format-devices', 'dd.barometric_pressure_hpa', 'returns S2120 pressure in GET /api/devices');
expectIncludesById('format-devices', 'dd.wind_speed_mps', 'returns S2120 wind speed in GET /api/devices');
expectIncludesById('format-devices', 'dd.wind_direction_deg', 'returns S2120 wind direction in GET /api/devices');
expectIncludesById('format-devices', 'dd.wind_gust_mps', 'returns S2120 wind gust in GET /api/devices');
expectIncludesById('format-devices', 'dd.uv_index', 'returns S2120 UV in GET /api/devices');
expectIncludesById('format-devices', 'dd.rain_gauge_cumulative_mm', 'returns S2120 cumulative rain in GET /api/devices');
expectIncludesById('format-devices', 'dd.bat_pct', 'returns S2120 battery in GET /api/devices');
expectIncludesById('merge-device-data', 'device_mode: d.device_mode ?? 1', 'returns configured LSN50 mode in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_force_legacy: d.dendro_force_legacy ?? 0', 'returns the explicit legacy dendrometer override in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_stroke_mm: d.dendro_stroke_mm ?? null', 'returns dendrometer stroke calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_ratio_at_retracted: d.dendro_ratio_at_retracted ?? null', 'returns dendrometer retracted-ratio calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_ratio_at_extended: d.dendro_ratio_at_extended ?? null', 'returns dendrometer extended-ratio calibration in GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_baseline_pending: d.dendro_baseline_pending ?? 0', 'returns the pending-baseline flag in GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_enabled: d.chameleon_enabled ?? 0', 'returns Chameleon enabled config in GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_swt1_depth_cm: d.chameleon_swt1_depth_cm ?? null', 'returns Chameleon SWT depth config in GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_swt1_a: d.chameleon_swt1_a ?? null', 'returns Chameleon SWT coefficient config in GET /api/devices');
expectIncludesById('merge-device-data', 'adc_ch1v: latest.adc_ch1v', 'merges dendrometer CH1 voltage into GET /api/devices');
expectIncludesById('merge-device-data', 'swt_1: latest.swt_1', 'merges Chameleon SWT channel 1 into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_reading_id: d.chameleon_reading_id', 'maps latest Chameleon reading row id from SQL results');
expectIncludesById('merge-device-data', 'chameleon_payload_b64: d.chameleon_payload_b64', 'maps latest Chameleon raw payload from SQL results');
expectIncludesById('merge-device-data', 'chameleon_reading_id: latest.chameleon_reading_id', 'merges latest Chameleon reading row id into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_payload_b64: latest.chameleon_payload_b64', 'merges latest Chameleon raw payload into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_payload_version: latest.chameleon_payload_version', 'merges latest Chameleon payload version into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_status_flags: latest.chameleon_status_flags', 'merges latest Chameleon status flags into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_temp_c: latest.chameleon_temp_c', 'merges latest Chameleon board temperature into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_i2c_missing: latest.chameleon_i2c_missing', 'merges latest Chameleon I2C-missing flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_timeout: latest.chameleon_timeout', 'merges latest Chameleon timeout flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_temp_fault: latest.chameleon_temp_fault', 'merges latest Chameleon temp-fault flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_id_fault: latest.chameleon_id_fault', 'merges latest Chameleon ID-fault flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_ch1_open: latest.chameleon_ch1_open', 'merges latest Chameleon channel-open flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_ch2_open: latest.chameleon_ch2_open', 'merges latest Chameleon channel 2 open flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_ch3_open: latest.chameleon_ch3_open', 'merges latest Chameleon channel 3 open flag into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_r1_ohm_comp: latest.chameleon_r1_ohm_comp', 'merges latest Chameleon channel 1 resistance into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_r2_ohm_comp: latest.chameleon_r2_ohm_comp', 'merges latest Chameleon channel 2 resistance into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_r1_ohm_raw: latest.chameleon_r1_ohm_raw', 'merges latest Chameleon raw resistance into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_r2_ohm_raw: latest.chameleon_r2_ohm_raw', 'merges latest Chameleon channel 2 raw resistance into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_r3_ohm_raw: latest.chameleon_r3_ohm_raw', 'merges latest Chameleon channel 3 raw resistance into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_array_id: latest.chameleon_array_id', 'merges latest Chameleon array id into GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_r3_ohm_comp: latest.chameleon_r3_ohm_comp', 'merges latest Chameleon channel 3 resistance into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_ratio: latest.dendro_ratio', 'merges dendrometer ratio into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_mode_used: latest.dendro_mode_used', 'merges dendrometer path metadata into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_position_raw_mm: latest.dendro_position_raw_mm', 'merges raw dendrometer position into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_stem_change_um: latest.dendro_stem_change_um', 'merges baseline-relative stem change into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_saturated: latest.dendro_saturated', 'merges dendrometer saturation into GET /api/devices');
expectIncludesById('merge-device-data', 'dendro_saturation_side: latest.dendro_saturation_side', 'merges dendrometer saturation-side metadata into GET /api/devices');
expectIncludesById('merge-device-data', 'strega_model: d.strega_model || null', 'returns stored STREGA model metadata in GET /api/devices');
expectIncludesById('merge-device-data', 'rain_mm_per_hour: latest.rain_mm_per_hour', 'merges interval-aware rain rate into GET /api/devices');
expectIncludesById('merge-device-data', 'flow_liters_per_min: latest.flow_liters_per_min', 'merges interval-aware flow rate into GET /api/devices');
expectIncludesById('merge-device-data', 'rain_mm_per_10min: latest.rain_mm_per_10min', 'merges normalized rain telemetry into GET /api/devices');
expectIncludesById('merge-device-data', 'flow_liters_per_10min: latest.flow_liters_per_10min', 'merges normalized flow telemetry into GET /api/devices');
expectIncludesById('merge-device-data', 'counter_interval_seconds: latest.counter_interval_seconds', 'merges elapsed counter interval into GET /api/devices');
expectIncludesById('merge-device-data', 'barometric_pressure_hpa: latest.barometric_pressure_hpa', 'merges S2120 pressure into GET /api/devices');
expectIncludesById('merge-device-data', 'wind_speed_mps: latest.wind_speed_mps', 'merges S2120 wind speed into GET /api/devices');
expectIncludesById('merge-device-data', 'wind_direction_deg: latest.wind_direction_deg', 'merges S2120 wind direction into GET /api/devices');
expectIncludesById('merge-device-data', 'wind_gust_mps: latest.wind_gust_mps', 'merges S2120 wind gust into GET /api/devices');
expectIncludesById('merge-device-data', 'uv_index: latest.uv_index', 'merges S2120 UV into GET /api/devices');
expectIncludesById('merge-device-data', 'rain_gauge_cumulative_mm: latest.rain_gauge_cumulative_mm', 'merges S2120 cumulative rain into GET /api/devices');
expectIncludesById('merge-device-data', 'bat_pct: latest.bat_pct', 'merges S2120 battery into GET /api/devices');
expectIncludesById('s2120-process-fn', 'data.object?.messages', 'accepts live decoded S2120 message shape');
expectIncludesById('s2120-process-fn', 'data.object?.data?.messages', 'accepts nested decoded S2120 message shape');
expectIncludesById('s2120-process-fn', "normalizePressureHpa(measurements['4101'])", 'uses current S2120 pressure ID');
expectIncludesById('s2120-process-fn', "measurements['4113']", 'uses the Seeed cumulative-rain measurement ID');
expectIncludesById('s2120-process-fn', "measurements['4213'] ?? measurements['4191']", 'uses current and legacy S2120 wind-gust IDs');
expectIncludesById('s2120-process-fn', "measurements['4103'] ?? measurements.bat_pct", 'uses the decoded S2120 battery-percent field');
expectIncludesById('s2120-process-fn', 'duplicate_timestamp', 'skips duplicate S2120 rain-counter uplinks');
expectIncludesById('s2120-process-fn', 'out_of_order', 'skips out-of-order S2120 rain-counter uplinks');
expectIncludesById('s2120-process-fn', 'counter_reset', 'detects S2120 rain-counter resets');
expectIncludesById('s2120-process-fn', 'invalid_interval', 'skips S2120 rain deltas when the interval is invalid');
expectIncludesById('s2120-process-fn', 'rainMmPer10Min', 'computes normalized S2120 rain telemetry per 10 minutes');
expectIncludesById('s2120-process-fn', 'counterIntervalSeconds', 'stores the elapsed S2120 counter interval in seconds');
expectIncludesById('s2120-rain-agg-fn', 'SELECT wsz.zone_id', 'prefers explicit S2120 weather station zone assignments');
expectIncludesById('s2120-rain-agg-fn', 'if (!zones.length)', 'falls back when S2120 weather station zone assignments are absent');
expectIncludesById('s2120-rain-agg-fn', 'd.irrigation_zone_id AS zone_id', 'uses legacy S2120 irrigation zone fallback');
expectIncludesById('s2120-rain-agg-fn', 'const rainToday = sn(d.rainMmToday != null ? d.rainMmToday : d.rainMmDelta)', 'seeds S2120 zone totals from device daily rain');
expectIncludesById('s2120-rain-agg-fn', 'MAX(COALESCE(rainfall_mm,0)+${rainDelta}, ${rainToday})', 'keeps S2120 zone totals caught up with device daily rain');
expectLibById('s2120-process-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('s2120-rain-agg-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('merge-device-data', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb for S2120 enrichment');
expectLibById('s2120-zones-get-fn', 'crypto', 'crypto', 'imports crypto for auth verification');
expectLibById('s2120-zones-get-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('s2120-zones-put-auth-fn', 'crypto', 'crypto', 'imports crypto for auth verification');
expectLibById('s2120-zones-put-auth-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper as osiDb');
expectLibById('put-soil-depth-fn', 'crypto', 'crypto', 'imports crypto for soil-depth auth verification');
expectLibById('put-soil-depth-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper for soil-depth persistence');
expectIncludesById('sensor-history-fn', 'rain_mm_per_hour', 'allows rate-based rain history queries');
expectIncludesById('sensor-history-fn', 'flow_liters_per_min', 'allows rate-based flow history queries');
expectIncludesById('sensor-history-fn', 'rain_mm_per_10min', 'allows normalized rain history queries');
expectIncludesById('sensor-history-fn', 'flow_liters_per_10min', 'allows normalized flow history queries');
expectIncludesById('sensor-history-fn', 'counter_interval_seconds', 'allows interval-length history queries');
expectIncludesById('sensor-history-fn', 'wind_speed_mps', 'allows S2120 wind-speed history queries');
expectIncludesById('sensor-history-fn', 'wind_direction_deg', 'allows S2120 wind-direction history queries');
expectIncludesById('sensor-history-fn', 'wind_gust_mps', 'allows S2120 wind-gust history queries');
expectIncludesById('sensor-history-fn', 'uv_index', 'allows S2120 UV history queries');
expectIncludesById('sensor-history-fn', 'barometric_pressure_hpa', 'allows S2120 pressure history queries');
expectIncludesById('sensor-history-fn', 'rain_gauge_cumulative_mm', 'allows S2120 cumulative-rain history queries');
expectIncludesById('sensor-history-fn', 'bat_pct', 'allows S2120 battery-percent history queries');
expectIncludesById('sensor-history-fn', "'swt_3'", 'allows Chameleon SWT history queries');
expectLibById('put-chameleon-enabled-auth-fn', 'crypto', 'crypto', 'imports crypto for Chameleon enabled auth verification');
expectLibById('put-chameleon-enabled-auth-fn', 'osiDb', 'osi-db-helper', 'uses osi-db-helper for Chameleon enabled persistence');
expectIncludesById('put-chameleon-enabled-auth-fn', 'function parseChameleonEnabled(value)', 'validates Chameleon enabled payload without broad coercion');
expectIncludesById('put-chameleon-enabled-auth-fn', "const enabled = parseChameleonEnabled(body.enabled);", 'rejects missing or invalid Chameleon enabled values');
expectIncludesById('put-chameleon-enabled-auth-fn', "enabled must be a boolean, 1, 0, 'true', 'false', '1', or '0'", 'returns a 400 for invalid Chameleon enabled values');
expectIncludesById('put-chameleon-enabled-auth-fn', "type_id = 'DRAGINO_LSN50'", 'limits Chameleon enabled updates to LSN50 devices');
expectExcludesById('put-chameleon-enabled-auth-fn', 'sync_version = COALESCE(sync_version, 0) + 1', 'keeps Chameleon enabled as local-only edge config until a server sync contract exists');
expectLibById('put-chameleon-config-auth-fn', 'crypto', 'crypto', 'imports crypto for Chameleon config auth verification');
expectLibById('put-chameleon-config-auth-fn', 'osiDb', 'osi-db-helper', 'uses osi-db-helper for Chameleon config persistence');
expectIncludesById('put-chameleon-config-auth-fn', 'const body = parseBody(msg.payload);', 'parses Chameleon config payload before opening the database');
expectIncludesById('put-chameleon-config-auth-fn', 'Math.round(parsed * 1000000) / 1000000', 'rounds Chameleon config numbers to six decimals');
expectIncludesById('put-chameleon-config-auth-fn', 'No Chameleon config fields supplied', 'rejects empty Chameleon config patches');
expectExcludesById('put-chameleon-config-auth-fn', 'sync_version = COALESCE(sync_version, 0) + 1', 'keeps Chameleon calibration fields as local-only edge config until a server sync contract exists');
expectIncludesById('d0b2b1c1a937e16d', 'COALESCE(dd.swt_3, NULL)', 'scheduler can evaluate Chameleon SWT channel 3');
expectIncludesById('d0b2b1c1a937e16d', "ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1", 'scheduler includes Chameleon-enabled LSN50 devices');
expectIncludesById('d0b2b1c1a937e16d', 'CASE WHEN dd.swt_3 IS NULL THEN 0 ELSE 1 END', 'scheduler SWT average counts Chameleon channel 3 only when present');
expectIncludesById('dendro-history-fn', 'dd.adc_ch1v', 'returns dendrometer CH1 history points');
expectIncludesById('dendro-history-fn', 'dd.dendro_ratio', 'returns dendrometer ratio history points');
expectIncludesById('dendro-history-fn', 'dd.dendro_mode_used', 'returns dendrometer path history points');
expectIncludesById('dendro-history-fn', 'dd.dendro_stem_change_um', 'returns baseline-relative stem change history points');
expectExcludesById('dendro-history-fn', 'AND dd.dendro_position_mm IS NOT NULL', 'the calibrated-only dendrometer history filter');
expectIncludesById('dendro-history-fn', '(dd.dendro_position_mm IS NOT NULL OR dd.adc_ch0v IS NOT NULL OR dd.adc_ch1v IS NOT NULL OR dd.dendro_ratio IS NOT NULL)', 'returns raw-only dendrometer history rows from device_data');
expectIncludesById('dendro-history-format', 'adc_ch1v: r.adc_ch1v', 'formats dendrometer CH1 history for the GUI');
expectIncludesById('dendro-history-format', 'dendro_ratio: r.dendro_ratio', 'formats dendrometer ratio history for the GUI');
expectIncludesById('dendro-history-format', 'dendro_mode_used: r.dendro_mode_used', 'formats dendrometer path history for the GUI');
expectIncludesById('dendro-history-format', 'stem_change_um: r.dendro_stem_change_um', 'formats baseline-relative stem change history for the GUI');
expectIncludesById('dendro-raw-fn', 'COALESCE(dr.adc_ch0v, dr.adc_v) AS adc_ch0v', 'keeps raw dendrometer CH0 history backward compatible');
expectIncludesById('dendro-raw-fn', 'dr.adc_ch1v', 'returns raw dendrometer CH1 readings');
expectIncludesById('dendro-raw-fn', 'dr.dendro_ratio', 'returns raw dendrometer ratios');
expectIncludesById('dendro-raw-fn', 'dr.dendro_mode_used', 'returns raw dendrometer path metadata');
expectIncludesById('dendro-raw-fn', 'UNION ALL', 'merges calibrated and raw-only dendrometer readings');
expectIncludesById('dendro-raw-fn', 'FROM device_data dd', 'reads raw-only dendrometer history from device_data');
expectIncludesById('dendro-raw-fn', 'NULL AS position_um', 'keeps raw-only dendrometer readings uncalibrated');
expectIncludesById('dendro-raw-fn', 'COALESCE(dd.dendro_valid, 1) AS is_valid', 'defaults raw-only dendrometer validity when device_data omits it');
expectIncludesById('dendro-raw-fn', 'dd.dendro_position_mm IS NULL', 'limits synthetic raw dendrometer rows to uncalibrated samples');
expectIncludesById('dendro-readings-insert-fn', 'adc_v,adc_ch0v,adc_ch1v,dendro_ratio,dendro_mode_used', 'stores raw dendrometer debug fields in dendrometer_readings');
expectLibById('put-dendro-config-auth-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper for dendrometer config persistence');
expectIncludesById('put-dendro-config-auth-fn', 'deleted_at IS NULL', 'ignores deleted devices when saving dendrometer config');
expectIncludesById('put-dendro-config-auth-fn', "return respond(404, { message: 'Device not found' });", 'returns 404 for missing dendrometer-config devices');
expectIncludesById('put-dendro-config-auth-fn', 'dendro_baseline_pending = 1', 'marks the dendrometer baseline as pending when calibration changes');
const deviceApiCatch = findNodeById('device-api-catch');
expectCondition(
  Boolean(deviceApiCatch),
  'device-api catch node exists',
  'missing device-api catch node to avoid hanging HTTP responses'
);
if (deviceApiCatch) {
  expectEqual(deviceApiCatch.type, 'catch', 'device-api catch node type');
  expectEqual(deviceApiCatch.z, 'device-api-tab', 'device-api catch node tab');
  expectEqual(deviceApiCatch.scope, null, 'device-api catch node catches the whole tab');
}
expectWireById('device-api-catch', 'device-api-http500', 'routes uncaught device-api errors into the HTTP 500 formatter');
expectIncludesById('device-api-http500', 'msg.statusCode = 500;', 'sets HTTP 500 for uncaught device-api failures');
expectIncludesById('device-api-http500', "error: 'device-api failed'", 'formats uncaught device-api failures with the generic error code');
expectWireById('device-api-http500', 'device-response', 'returns uncaught device-api failures through the shared response node');
expectIncludes('Format Dendro Config Response', 'dendro_force_legacy: row.dendro_force_legacy ?? null', 'returns canonical dendrometer config fields');
expectIncludes('Format Dendro Config Response', 'dendro_invert_direction: row.dendro_invert_direction ?? null', 'keeps legacy dendrometer inversion config for compatibility');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_position_mm = NULL', 'clears the stored dendrometer baseline position');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_mode_used = NULL', 'clears the stored dendrometer baseline mode');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_calibration_signature = NULL', 'clears the stored dendrometer baseline calibration signature');
expectIncludesById('post-dendro-baseline-reset-auth-fn', 'dendro_baseline_pending = 1', 'marks the dendrometer baseline as pending after a manual reset');
expectFileIncludes('api.ts', reactGuiApiSource, 'resetDendroBaseline: async (deveui: string): Promise<void> => {', 'adds a shared client helper for dendrometer baseline resets');
expectFileIncludes('api.ts', reactGuiApiSource, "await api.post(`/api/devices/${deveui}/dendro-baseline/reset`);", 'targets the local dendrometer baseline reset endpoint from the shared client helper');
expectFileIncludes('api.ts', reactGuiApiSource, 'export interface ChameleonConfigPayload', 'types Chameleon SWT calibration API payloads');
expectFileIncludes('api.ts', reactGuiApiSource, 'setChameleonEnabled: async (deveui: string, enabled: boolean): Promise<void> => {', 'adds a shared client helper for Chameleon enablement');
expectFileIncludes('api.ts', reactGuiApiSource, "await api.put(`/api/devices/${deveui}/chameleon`, { enabled });", 'targets the local Chameleon enablement endpoint from the shared client helper');
expectFileIncludes('api.ts', reactGuiApiSource, 'setChameleonConfig: async (deveui: string, payload: ChameleonConfigPayload): Promise<void> => {', 'adds a shared client helper for Chameleon SWT calibration config');
expectFileIncludes('api.ts', reactGuiApiSource, "await api.put(`/api/devices/${deveui}/chameleon-config`, payload);", 'targets the local Chameleon calibration endpoint from the shared client helper');
expectFileIncludes('api.ts', reactGuiApiSource, 'position_mm: number | null;', 'types dendrometer history position as nullable');
expectFileIncludes('api.ts', reactGuiApiSource, 'stem_change_um: toNullableNumber(row?.stem_change_um ?? row?.dendro_stem_change_um)', 'normalizes baseline-relative stem change for dendrometer history');
expectFileExcludes('api.ts', reactGuiApiSource, 'Number(row?.position_mm ?? row?.dendro_position_mm ?? 0)', 'coercing missing dendrometer history position to zero');
expectFileExcludes('api.ts', reactGuiApiSource, 'Number(row?.position_um ?? 0)', 'coercing missing raw dendrometer position to zero');
expectFileIncludes('farming.ts', farmingTypesSource, 'id: number | null;', 'allows synthetic raw dendrometer rows without numeric ids');
expectFileIncludes('farming.ts', farmingTypesSource, 'position_um: number | null;', 'allows raw-only dendrometer rows to omit calibrated position');
expectFileIncludes('farming.ts', farmingTypesSource, 'dendro_stem_change_um?: number | null;', 'types the latest stem-change signal on device payloads');
expectFileIncludes('farming.ts', farmingTypesSource, 'dendro_baseline_pending?: number | null;', 'types the device-level baseline-pending flag');
expectFileIncludes('farming.ts', farmingTypesSource, 'swt_3?: number | null;', 'types Chameleon SWT channel 3 on latest device payloads');
expectFileIncludes('farming.ts', farmingTypesSource, 'chameleon_payload_b64?: string | null;', 'types Chameleon raw payload on latest device payloads');
expectFileIncludes('farming.ts', farmingTypesSource, 'chameleon_enabled?: number;', 'types device-level Chameleon enablement flag');
expectFileIncludes('api.ts', reactGuiApiSource, 'stem_change_um: number | null;', 'types the dendrometer history stem-change signal');

for (const field of [
  'swt_1',
  'swt_2',
  'swt_3',
  'chameleon_reading_id',
  'chameleon_payload_b64',
  'chameleon_payload_version',
  'chameleon_status_flags',
  'chameleon_i2c_missing',
  'chameleon_timeout',
  'chameleon_temp_fault',
  'chameleon_id_fault',
  'chameleon_ch1_open',
  'chameleon_ch2_open',
  'chameleon_ch3_open',
  'chameleon_temp_c',
  'chameleon_r1_ohm_comp',
  'chameleon_r2_ohm_comp',
  'chameleon_r3_ohm_comp',
  'chameleon_r1_ohm_raw',
  'chameleon_r2_ohm_raw',
  'chameleon_r3_ohm_raw',
  'chameleon_array_id',
]) {
  expectFileIncludes('farming.ts', farmingTypesSource, `${field}?:`, `types latest_data.${field}`);
}

for (const field of [
  'chameleon_enabled',
  'chameleon_swt1_depth_cm',
  'chameleon_swt2_depth_cm',
  'chameleon_swt3_depth_cm',
  'chameleon_swt1_a',
  'chameleon_swt1_b',
  'chameleon_swt1_c',
  'chameleon_swt2_a',
  'chameleon_swt2_b',
  'chameleon_swt2_c',
  'chameleon_swt3_a',
  'chameleon_swt3_b',
  'chameleon_swt3_c',
]) {
  expectFileIncludes('farming.ts', farmingTypesSource, `${field}?:`, `types top-level Device.${field}`);
}

for (const field of [
  'chameleonSwt1DepthCm',
  'chameleonSwt2DepthCm',
  'chameleonSwt3DepthCm',
  'chameleonSwt1A',
  'chameleonSwt1B',
  'chameleonSwt1C',
  'chameleonSwt2A',
  'chameleonSwt2B',
  'chameleonSwt2C',
  'chameleonSwt3A',
  'chameleonSwt3B',
  'chameleonSwt3C',
]) {
  expectFileIncludes('api.ts', reactGuiApiSource, `${field}?:`, `types ChameleonConfigPayload.${field}`);
}
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Stem change over time', 'labels the basic monitor around the comparable stem-change signal');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Mechanical layer', 'renders mechanical engineering values beneath the stem-change graph');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Current position', 'shows absolute mechanical position below the graph instead of as the headline graph metric');
expectFileIncludes('DendrometerMonitor.tsx', dendroMonitorSource, 'Awaiting baseline. Mechanical position is available in this window', 'keeps the basic monitor informative when comparable stem change is not ready yet');
expectFileIncludes('farming/dendrometer/DendrometerMonitor.tsx', dendroDrawerSource, 'Raw samples are available', 'explains raw-only dendrometer rows in the 24h drawer');
expectFileIncludes('farming/dendrometer/DendrometerMonitor.tsx', dendroDrawerSource, 'const showRatioDebug = isRatioDendroMode(point.dendro_mode_used_raw);', 'shows CH1 and ratio debug values only for ratio-mode 24h readings');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Stem change', 'shows stem change as the only primary dendrometer signal on the device card');
expectFileExcludes('DraginoTempCard.tsx', draginoTempCardSource, 'DENDROMETER POSITION', 'removes the old absolute-position headline from the device card');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'dendro_stem_change_um', 'renders the baseline-relative stem change signal on the device card');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'dendro_baseline_pending === 1', 'suppresses stale stem-change values when the device is awaiting a new baseline');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Awaiting baseline', 'keeps the dendrometer card visible while the next valid uplink establishes a new baseline');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, 'Current ratio', 'shows ratio in the dendrometer calibration section instead of on the device card');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'Dendrometer calibration', 'adds dendrometer calibration controls to the LSN50 advanced settings');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "import { DraginoChameleonSwtSection } from './DraginoChameleonSwtSection';", 'imports the Chameleon SWT calibration section');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "key: 'chameleon_enabled'", 'adds Chameleon SWT to the LSN50 sensor toggle list');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "label: 'Chameleon SWT'", 'labels the Chameleon SWT sensor toggle');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'lsn50API.setChameleonEnabled', 'wires the Chameleon SWT toggle to the local API');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'function requiredModeForSensor', 'uses a per-sensor LSN50 mode gate');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "return 'MOD3';", 'requires MOD3 for Chameleon SWT enablement');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "return 'MOD9';", 'requires MOD9 for rain and flow counters');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'Chameleon SWT requires MOD3', 'surfaces a clear MOD3 guard message for Chameleon enablement');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'enabledSensorsIncompatibleWithMode', 'warns before switching away from modes required by enabled sensors');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'allows dendrometer in MOD1 or MOD3', 'documents the non-exclusive dendrometer and Chameleon MOD3 mode path');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "option.key === 'temp_enabled'", 'keeps the MOD1 temperature warning path separate from strict mode gates');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, "return mode !== 'MOD1';", 'warns before switching temperature-enabled LSN50 devices away from MOD1');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'title="Chameleon SWT"', 'renders a dedicated Chameleon SWT settings section');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, '<DraginoChameleonSwtSection', 'renders the Chameleon SWT calibration component in the settings modal');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, 'Retracted ratio (0 mm)', 'uses canonical retracted-ratio calibration wording in the advanced settings');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, 'Extended ratio (full stroke)', 'uses canonical extended-ratio calibration wording in the advanced settings');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, 'Capture current ratio', 'allows capturing the live ratio into calibration endpoints');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, "await lsn50API.setDendroConfig(device.deveui", 'saves dendrometer calibration through the dedicated local API');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, 'Reset stem baseline', 'adds a manual baseline reset action for legacy dendrometers');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, "await lsn50API.resetDendroBaseline(device.deveui)", 'wires the manual baseline reset action to the local API');
expectFileIncludes('DraginoDendroCalibrationSection.tsx', draginoDendroCalibrationSource, 'Force legacy mode', 'exposes the legacy dendrometer override in the advanced settings');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'Save Chameleon calibration', 'adds a save action for Chameleon SWT calibration');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'Restore workbook defaults', 'allows locally restoring workbook coefficients before save');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'await lsn50API.setChameleonConfig(device.deveui, payload)', 'saves Chameleon SWT calibration through the dedicated local API');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, '10.71', 'uses the SWT1 workbook fallback coefficient a');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, '10.40', 'uses the SWT2 workbook fallback coefficient a');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, '10.33', 'uses the SWT3 workbook fallback coefficient a');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'chameleonSwt1DepthCm', 'sends the SWT1 depth using the camelCase config payload');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'chameleonSwt2B', 'sends representative SWT2 coefficient payload fields');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'chameleonSwt3C', 'sends representative SWT3 coefficient payload fields');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'Math.round(parsed * 100) / 100', 'rounds depth values to two decimals before save');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'Math.round(parsed * 1000000) / 1000000', 'rounds coefficient values to six decimals before save');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'device.latest_data?.swt_1', 'shows live SWT channel 1 values when present');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'device.latest_data?.chameleon_r1_ohm_comp', 'shows live compensated resistance when present');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, "if (value == null || (typeof value === 'string' && value.trim() === '')) return null;", 'treats nullish and blank live Chameleon telemetry as absent before numeric formatting');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'a: formatNumericInput(device[channel.coefficientKeys.a])', 'keeps absent saved coefficient a values blank instead of rehydrating workbook defaults');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'placeholder={String(channel.defaults[field])}', 'shows Chameleon workbook defaults as coefficient placeholders');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSwtSectionSource, 'a: String(channel.defaults.a)', 'keeps Restore workbook defaults as an explicit value-fill action');
expectFileExcludes('Dragino settings components', draginoSettingsSource, 'Invert direction', 'removes the ratio inversion toggle from the advanced settings');
expectFileIncludes('SenseCapWeatherCard.tsx', senseCapWeatherCardSource, 'WindMonitor', 'opens a dedicated wind monitor from the S2120 card');
expectFileIncludes('SenseCapWeatherCard.tsx', senseCapWeatherCardSource, 'rain_mm_per_10min', 'shows normalized rain history options on the S2120 card');
expectFileIncludes('SenseCapWeatherCard.tsx', senseCapWeatherCardSource, 'formatCounterStatus', 'renders human-readable rain-counter state on the S2120 card');
expectFileIncludes('SenseCapWeatherCard.tsx', senseCapWeatherCardSource, 'formatWindDirection', 'uses shared wind-direction formatting on the S2120 card');
expectFileIncludes('WindMonitor.tsx', windMonitorSource, "sensorAPI.getHistory(deveui, 'wind_speed_mps', hours)", 'loads wind-speed history in the dedicated S2120 wind monitor');
expectFileIncludes('WindMonitor.tsx', windMonitorSource, "sensorAPI.getHistory(deveui, 'wind_gust_mps', hours)", 'loads wind-gust history in the dedicated S2120 wind monitor');
expectFileIncludes('WindMonitor.tsx', windMonitorSource, "sensorAPI.getHistory(deveui, 'wind_direction_deg', hours)", 'loads wind-direction history in the dedicated S2120 wind monitor');
expectFileIncludes('wind.ts', windUtilsSource, 'export function formatWindDirection', 'ships shared wind-direction formatting helpers');
expectFileIncludes('OnlineTab.tsx', onlineTabSource, 'toCompassDirection', 'reuses shared wind-direction helpers in the online environment tab');
expectFileIncludes('WeatherTab.tsx', weatherTabSource, 'toCompassDirection', 'reuses shared wind-direction helpers in the weather forecast tab');
expectExcludesById('merge-device-data', 'd.updated_at', 'updated_at fallback for last_seen in GET /api/devices');
expectIncludes('Auth + Query Gateway Location', 'gateway_locations', 'queries gateway GPS state from the local mirror table');
expectIncludes('Format Gateway Location Response', "status: row.status || 'no_fix'", 'returns a no-fix fallback for linked gateways');
expectIncludes('Route Command', "commandType === 'SET_LSN50_MODE'", 'routes SET_LSN50_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERVAL'", 'routes SET_LSN50_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'routes SET_LSN50_INTERRUPT_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_LSN50_5V_WARMUP'", 'routes SET_LSN50_5V_WARMUP gateway commands');
expectIncludes('Route Command', "commandType === 'SET_KIWI_INTERVAL'", 'routes SET_KIWI_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'ENABLE_KIWI_TEMP_HUMIDITY'", 'routes ENABLE_KIWI_TEMP_HUMIDITY gateway commands');
expectIncludes('Route Command', "'UPSERT_DEVICE_SOIL_DEPTHS'", 'routes synced Kiwi soil depth commands through the shared update path');
expectIncludes('Route Command', "commandType === 'SET_STREGA_INTERVAL'", 'routes SET_STREGA_INTERVAL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_MODEL'", 'routes SET_STREGA_MODEL gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_TIMED_ACTION'", 'routes SET_STREGA_TIMED_ACTION gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_MAGNET_MODE'", 'routes SET_STREGA_MAGNET_MODE gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_PARTIAL_OPENING'", 'routes SET_STREGA_PARTIAL_OPENING gateway commands');
expectIncludes('Route Command', "commandType === 'SET_STREGA_FLUSHING'", 'routes SET_STREGA_FLUSHING gateway commands');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_MODE') {", 'updates the local configured LSN50 mode for synced commands');
expectIncludes('Build UPDATE SQL', 'area_m2=excluded.area_m2', 'upserts shared zone area from sync commands');
expectIncludes('Build UPDATE SQL', 'prediction_card_enabled=excluded.prediction_card_enabled', 'upserts the prediction-card flag from sync commands');
expectIncludes('Build UPDATE SQL', "sets.push('area_m2 = '", 'applies zone area updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "sets.push('irrigation_efficiency_pct = '", 'applies irrigation efficiency updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "sets.push('prediction_card_enabled = ' + b(predictionCardEnabled, false));", 'applies prediction-card updates from control-plane sync');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERVAL') {", 'accepts synced LSN50 interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_INTERRUPT_MODE') {", 'accepts synced LSN50 interrupt mode commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_LSN50_5V_WARMUP') {", 'accepts synced LSN50 5V warm-up commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_KIWI_INTERVAL') {", 'accepts synced Kiwi interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'ENABLE_KIWI_TEMP_HUMIDITY') {", 'accepts synced Kiwi temperature and humidity enable commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'UPSERT_DEVICE_SOIL_DEPTHS') {", 'accepts synced Kiwi soil depth updates on the gateway');
expectIncludes('Build UPDATE SQL', "soil_moisture_probe_depths_json", 'updates mirrored Kiwi soil depth metadata on the gateway');
expectIncludes('Sync Init Schema + Triggers', 'trg_sync_devices_outbox_au', 'creates the device outbox trigger for mirrored device changes');
expectIncludes('Sync Init Schema + Triggers', "COALESCE(NEW.soil_moisture_probe_depths_json,'') <> COALESCE(OLD.soil_moisture_probe_depths_json,'')", 'queues device outbox events when Kiwi soil depth JSON changes locally');
expectIncludes('Sync Init Schema + Triggers', "COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0)", 'queues device outbox events when Kiwi soil depth readiness changes locally');
expectIncludes('Sync Init Schema + Triggers', "'soil_moisture_probe_depths_json', json(COALESCE(NEW.soil_moisture_probe_depths_json, '{}'))", 'mirrors Kiwi soil depth JSON in device outbox payloads');
expectIncludes('Sync Init Schema + Triggers', "'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured, 0)", 'mirrors Kiwi soil depth readiness in device outbox payloads');
expectIncludes('Auth + Save Soil Moisture Depths', 'soil_moisture_probe_depths_json = ', 'stores Kiwi soil depth JSON through the local edge endpoint');
expectIncludes('Auth + Save Soil Moisture Depths', 'soil_moisture_probe_depths_configured = 1', 'marks Kiwi soil depths as configured through the local edge endpoint');
expectExcludes('Auth + Save Soil Moisture Depths', "node.error('Failed to save soil moisture depths: ' + e.message, msg);", 'soil-depth error forwarding into the tab-wide HTTP catch path');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_INTERVAL') {", 'accepts synced STREGA interval commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_MODEL') {", 'accepts synced STREGA model updates on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_TIMED_ACTION') {", 'accepts synced STREGA timed actions on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_MAGNET_MODE') {", 'accepts synced STREGA magnet mode commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_PARTIAL_OPENING') {", 'accepts synced STREGA partial opening commands on the gateway');
expectIncludes('Build UPDATE SQL', "if (commandType === 'SET_STREGA_FLUSHING') {", 'accepts synced STREGA flushing commands on the gateway');
expectIncludes('Build Schedule ACK', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'skips duplicate generic ACKs for direct LSN50 interrupt-mode downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_LSN50_5V_WARMUP'", 'skips duplicate generic ACKs for direct LSN50 5V warm-up downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_TIMED_ACTION'", 'skips duplicate generic ACKs for direct STREGA timed downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_MAGNET_MODE'", 'skips duplicate generic ACKs for direct STREGA magnet downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_PARTIAL_OPENING'", 'skips duplicate generic ACKs for direct STREGA partial-opening downlinks');
expectIncludes('Build Schedule ACK', "commandType === 'SET_STREGA_FLUSHING'", 'skips duplicate generic ACKs for direct STREGA flushing downlinks');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN lsn50_mode_code INTEGER', 'adds LSN50 mode columns to device_data');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_force_legacy INTEGER DEFAULT 0', 'adds the device-level legacy dendrometer override');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_stroke_mm REAL', 'adds the device-level dendrometer stroke calibration');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_ratio_zero REAL', 'adds the device-level dendrometer ratio zero calibration');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_ratio_span REAL', 'adds the device-level dendrometer ratio span calibration');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_ratio_at_retracted REAL', 'adds the canonical retracted-ratio dendrometer calibration column');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_ratio_at_extended REAL', 'adds the canonical extended-ratio dendrometer calibration column');
expectIncludes('Sync Init Schema + Triggers', 'dendro_stroke_mm REAL, dendro_ratio_at_retracted REAL, dendro_ratio_at_extended REAL, dendro_ratio_zero REAL, dendro_ratio_span REAL', 'preserves canonical dendrometer ratio columns when rebuilding the devices table');
expectIncludes('Sync Init Schema + Triggers', 'dendro_stroke_mm,COALESCE(dendro_ratio_at_retracted,dendro_ratio_zero),COALESCE(dendro_ratio_at_extended,dendro_ratio_span),dendro_ratio_zero,dendro_ratio_span', 'copies canonical dendrometer ratios through the devices table rebuild');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_position_mm REAL', 'adds a persisted edge baseline for comparable stem-change signals');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_mode_used TEXT', 'tracks which conversion path the stem-change baseline was captured with');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_calibration_signature TEXT', 'tracks calibration changes that should reset the stem-change baseline');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_baseline_pending INTEGER DEFAULT 0', 'adds a persisted pending-baseline flag on devices');
expectIncludes('Sync Init Schema + Triggers', 'COALESCE(dendro_baseline_pending,0)', 'preserves the pending-baseline flag when rebuilding the devices table');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN dendro_invert_direction INTEGER DEFAULT 0', 'adds the device-level dendrometer inversion flag');
expectIncludes('Sync Init Schema + Triggers', 'UPDATE devices SET dendro_ratio_at_retracted = CASE', 'backfills canonical retracted-ratio calibration from legacy dendrometer fields');
expectIncludes('Sync Init Schema + Triggers', 'UPDATE devices SET dendro_ratio_at_extended = CASE', 'backfills canonical extended-ratio calibration from legacy dendrometer fields');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN adc_ch1v REAL', 'adds CH1 dendrometer telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN dendro_ratio REAL', 'adds ratio dendrometer telemetry storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN dendro_mode_used TEXT', 'adds dendrometer path storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN dendro_stem_change_um REAL', 'adds baseline-relative stem-change storage to device_data');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN bat_pct REAL', 'adds STREGA battery percentage storage');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN adc_ch0v REAL', 'adds backward-compatible CH0 storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN adc_ch1v REAL', 'adds CH1 storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN dendro_ratio REAL', 'adds ratio storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE dendrometer_readings ADD COLUMN dendro_mode_used TEXT', 'adds path metadata storage to dendrometer_readings');
expectIncludes('Sync Init Schema + Triggers', "'lsn50_mode_code', NEW.lsn50_mode_code", 'mirrors observed LSN50 mode in device_data outbox events');
expectIncludes('Auth + Parse LSN50 Mode', "Mode must be one of MOD1..MOD9", 'validates supported LSN50 modes on the local API');
expectIncludes('Auth + Parse LSN50 Interval', "Minutes must be a whole number between 1 and ", 'validates LSN50 uplink interval minutes on the local API');
expectIncludes('Auth + Parse LSN50 Interrupt', "Interrupt mode must be between 0 and 3", 'validates LSN50 interrupt-mode values on the local API');
expectIncludes('Auth + Parse LSN50 5V Warmup', "Warm-up milliseconds must be between 0 and 65535", 'validates LSN50 5V warm-up values on the local API');
expectIncludes('Auth + Parse Kiwi Interval', "Minutes must be a whole number between 1 and 1440", 'validates Kiwi uplink interval minutes on the local API');
expectIncludes('Auth + Parse Kiwi Temp/Humidity', "A20001A30001", 'builds the Kiwi ambient temperature and humidity enable payload');
expectExcludes('Auth + Parse Kiwi Temp/Humidity', 'const intervalSeconds = 15 * 60;', 'default Kiwi temp/humidity 15-minute fallback');
expectExcludes('Auth + Parse Kiwi Temp/Humidity', 'minutes: 15,', 'implicit Kiwi temp/humidity interval default');
expectIncludes('Auth + Parse STREGA Interval', "Minutes must be a whole number between 1 and 255", 'validates STREGA uplink interval minutes on the local API');
expectIncludes('Auth + Parse STREGA Interval', "Opened minutes must be a whole number between 1 and 255", 'validates opened-box STREGA interval minutes on the local API');
expectIncludes('Auth + Parse STREGA Model', "Model must be STANDARD or MOTORIZED", 'validates STREGA model selection on the local API');
expectIncludes('Auth + Parse STREGA Timed Action', 'Timed action requires OPEN or CLOSE, seconds/minutes/hours, and an amount between 1 and 255', 'validates STREGA timed actions on the local API');
expectIncludes('Auth + Parse STREGA Magnet', 'enabled is required', 'validates STREGA magnet mode changes on the local API');
expectIncludes('Auth + Parse STREGA Partial Opening', 'Partial opening requires OPEN or CLOSE and a percentage between 1 and 100', 'validates STREGA partial opening on the local API');
expectIncludes('Auth + Parse STREGA Flushing', 'Flushing requires OPEN or CLOSE and a percentage between 1 and 100', 'validates STREGA flushing on the local API');
expectIncludes('Auth + Parse Dendro Config', 'const forceLegacy = parseNullableFlag', 'parses the explicit legacy dendrometer override');
expectIncludes('Auth + Parse Dendro Config', 'const strokeMm = parseNullableNumber', 'parses dendrometer stroke calibration');
expectIncludes('Auth + Parse Dendro Config', 'const ratioAtRetracted = parseNullableNumber', 'parses dendrometer retracted-ratio calibration');
expectIncludes('Auth + Parse Dendro Config', 'const ratioAtExtended = parseNullableNumber', 'parses dendrometer extended-ratio calibration');
expectIncludes('Auth + Parse Dendro Config', "readBody(body, 'dendro_ratio_at_retracted', 'dendroRatioAtRetracted')", 'accepts canonical retracted-ratio config fields');
expectIncludes('Auth + Parse Dendro Config', "readBody(body, 'dendro_ratio_at_extended', 'dendroRatioAtExtended')", 'accepts canonical extended-ratio config fields');
expectIncludes('Auth + Parse Dendro Config', "readBody(body, 'dendro_ratio_zero', 'dendroRatioZero')", 'keeps compatibility with legacy ratio-zero config fields');
expectIncludes('Auth + Parse Dendro Config', "readBody(body, 'dendro_ratio_span', 'dendroRatioSpan')", 'keeps compatibility with legacy ratio-span config fields');
expectIncludes('Auth + Parse Dendro Config', 'No dendrometer config fields supplied', 'rejects empty dendrometer config updates');
expectIncludes('Authorize + Fanout LSN50 Mode', "commandType: 'SET_LSN50_MODE'", 'fans out validated local LSN50 mode changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Interval', "commandType: 'SET_LSN50_INTERVAL'", 'fans out validated local LSN50 interval changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Advanced', "commandType: 'SET_LSN50_INTERRUPT_MODE'", 'fans out validated local LSN50 interrupt-mode changes into the shared command path');
expectIncludes('Authorize + Fanout LSN50 Advanced', "commandType: 'SET_LSN50_5V_WARMUP'", 'fans out validated local LSN50 5V warm-up changes into the shared command path');
expectIncludes('Authorize + Fanout Kiwi Interval', "commandType: 'SET_KIWI_INTERVAL'", 'fans out validated local Kiwi interval changes into the shared command path');
expectIncludes('Authorize + Fanout Kiwi Temp/Humidity', "commandType: 'ENABLE_KIWI_TEMP_HUMIDITY'", 'fans out validated local Kiwi ambient sensor enable changes into the shared command path');
expectIncludes('Authorize + Fanout STREGA Interval', "action: 'SET_INTERVAL'", 'fans out validated local STREGA interval changes into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Interval', 'tamper_disabled:', 'fans out validated STREGA tamper flags into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_TIMED_ACTION'", 'fans out validated local STREGA timed actions into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_MAGNET_MODE'", 'fans out validated local STREGA magnet commands into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_PARTIAL_OPENING'", 'fans out validated local STREGA partial opening into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', "commandType: 'SET_STREGA_FLUSHING'", 'fans out validated local STREGA flushing into the shared actuator path');
expectIncludes('Authorize + Fanout STREGA Advanced', 'Partial opening is only supported for motorized Strega valves', 'gates motorized-only STREGA partial opening locally');
expectIncludes('Authorize + Fanout STREGA Advanced', 'Flushing is only supported for motorized Strega valves', 'gates motorized-only STREGA flushing locally');
expectExcludes('Authorize + Fanout LSN50 Mode', 'updated_at =', 'local LSN50 mode last-seen mutation');
expectExcludes('Authorize + Fanout LSN50 Interval', 'updated_at =', 'local LSN50 interval last-seen mutation');
expectExcludes('Authorize + Fanout Kiwi Interval', 'updated_at =', 'local Kiwi interval last-seen mutation');
expectExcludes('Authorize + Fanout Kiwi Temp/Humidity', 'updated_at =', 'local Kiwi temp/humidity last-seen mutation');
expectExcludes('Authorize + Fanout STREGA Interval', 'updated_at =', 'local STREGA interval last-seen mutation');
expectIncludes('Format LSN50 Mode Response', "confirmation: 'waiting_for_next_uplink'", 'returns explicit confirmation-waiting state from the local API');
expectIncludes('Format LSN50 Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local LSN50 interval API');
expectIncludes('Format LSN50 Advanced Response', "confirmation: 'downlink_queued'", 'returns queued state from the local LSN50 advanced APIs');
expectIncludes('Format Kiwi Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local Kiwi interval API');
expectIncludes('Format Kiwi Temp/Humidity Response', "confirmation: 'downlink_queued'", 'returns queued state from the local Kiwi ambient enable API');
expectIncludes('Format STREGA Interval Response', "confirmation: 'downlink_queued'", 'returns queued state from the local STREGA interval API');
expectIncludes('Format STREGA Interval Response', 'tamper_disabled:', 'returns tamper status from the local STREGA interval API');
expectIncludes('Format STREGA Advanced Response', "confirmation: 'stored_locally'", 'returns immediate confirmation from the local STREGA model API');
expectIncludes('Format STREGA Advanced Response', "confirmation: 'downlink_queued'", 'returns queued state from the local STREGA downlink APIs');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_INTERVAL'", 'builds Dragino interval downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_INTERRUPT_MODE'", 'builds Dragino interrupt-mode downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_LSN50_5V_WARMUP'", 'builds Dragino 5V warm-up downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'SET_KIWI_INTERVAL'", 'builds Kiwi interval downlinks');
expectIncludes('Build LSN50 mode downlink', "commandType === 'ENABLE_KIWI_TEMP_HUMIDITY'", 'builds Kiwi ambient temperature and humidity enable downlinks');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x01, (intervalSeconds >> 16) & 0xFF, (intervalSeconds >> 8) & 0xFF, intervalSeconds & 0xFF];', 'encodes Dragino TDC interval bytes');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x06, 0x00, 0x00, interruptMode & 0xFF];', 'encodes Dragino interrupt-mode bytes');
expectIncludes('Build LSN50 mode downlink', 'rawBytes = [0x07, (milliseconds >> 8) & 0xFF, milliseconds & 0xFF];', 'encodes Dragino 5V warm-up bytes');
expectIncludes('Build LSN50 mode downlink', "rawBytes = [0xA0, (intervalSeconds >> 24) & 0xFF, (intervalSeconds >> 16) & 0xFF, (intervalSeconds >> 8) & 0xFF, intervalSeconds & 0xFF];", 'encodes Kiwi interval register writes');
expectIncludes('Build LSN50 mode downlink', "0xA2, 0x00, 0x01, 0xA3, 0x00, 0x01", 'encodes Kiwi ambient temperature and humidity enable bytes');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_INTERVAL': {", 'supports STREGA interval downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', 'rawBytes = [tamperDisabled ? 0x01 : 0x00, closedIntervalMinutes & 0xFF, 0x00, openIntervalMinutes & 0xFF];', 'encodes STREGA interval bytes with tamper control on FPort 11');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'TIMED_ACTION': {", 'supports STREGA timed-action downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_MAGNET_MODE': {", 'supports STREGA magnet-mode downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_PARTIAL_OPENING': {", 'supports STREGA partial-opening downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', "case 'SET_FLUSHING': {", 'supports STREGA flushing downlinks');
expectIncludes('Build STREGA downlink + emit log ctx', 'deviceEui: devEui', 'includes the actual STREGA valve DevEUI in direct command ACK payloads');
expectIncludes('Build STREGA downlink + emit log ctx', 'gatewayDeviceEui: gatewayDeviceEui', 'includes the gateway transport identity in direct STREGA command ACK payloads');
expectIncludes('Build Status + ACK', 'deviceEui: deviceEui', 'includes the actual STREGA valve DevEUI in cloud status payloads');
expectIncludes('Build Status + ACK', 'gatewayDeviceEui: gatewayDeviceEui', 'includes the gateway transport identity in cloud status payloads');
expectIncludes('Build Status + ACK', "ctx.commandType || 'VALVE_COMMAND'", 'defaults manual STREGA valve ACK payloads to the cloud command type');
pendingChecks.push((async () => {
  // Fixed fixture values mirror the live command-193 failure; the test has no hardware dependency.
  const gatewayEui = '0016C001F151B1D6';
  const valveEui = '70B3D57708000334';
  const fixture = {
    commandId: 193,
    commandType: 'VALVE_COMMAND',
    action: 'CLOSE',
    deviceEui: valveEui,
    devEui: valveEui,
    gatewayDeviceEui: gatewayEui,
    eventUuid: '2a90ee59-6473-4b84-a74e-4d79bcfb7a27',
    aggregateType: 'DEVICE',
    aggregateKey: valveEui,
    appliedSyncVersion: 44,
  };
  const expectedContext = {
    commandId: fixture.commandId,
    eventUuid: fixture.eventUuid,
    aggregateType: fixture.aggregateType,
    aggregateKey: fixture.aggregateKey,
    appliedSyncVersion: fixture.appliedSyncVersion,
    commandType: fixture.commandType,
  };

  const routeResult = await executeFunctionNodeById('934bf2bc19a8ce22', { payload: fixture });
  const valveMsg = Array.isArray(routeResult) ? routeResult[0] : null;
  const routeData = valveMsg && valveMsg.payload && valveMsg.payload.data;
  if (!routeData) {
    fail('VALVE_COMMAND route did not produce an actuator_command payload');
    return;
  }
  for (const [key, value] of Object.entries(expectedContext)) {
    if (routeData[key] !== value) {
      fail(`VALVE_COMMAND route dropped ACK context field ${key}`);
    }
  }

  const stregaResult = await executeFunctionNodeById('cdbaa3891d40d7a1', valveMsg, {
    env: {
      CHIRPSTACK_APP_ACTUATORS: 'actuators-app',
      DEVICE_EUI: gatewayEui,
    },
  });
  const logMsg = Array.isArray(stregaResult) ? stregaResult[1] : null;
  const logCtx = logMsg && logMsg._log_ctx;
  if (!logCtx) {
    fail('STREGA downlink did not emit log context for VALVE_COMMAND');
    return;
  }
  for (const [key, value] of Object.entries(expectedContext)) {
    if (logCtx[key] !== value) {
      fail(`STREGA log context dropped ACK context field ${key}`);
    }
  }

  const statusResult = await executeFunctionNodeById('c8628cffe45f64f7', logMsg, {
    env: {
      DEVICE_EUI: gatewayEui,
    },
    flowState: {
      lastCommandId: fixture.commandId,
    },
  });
  const ackMsg = Array.isArray(statusResult) ? statusResult[1] : null;
  const ackPayload = ackMsg && typeof ackMsg.payload === 'string' ? JSON.parse(ackMsg.payload) : null;
  if (!ackPayload) {
    fail('Build Status + ACK did not emit a command_ack payload for VALVE_COMMAND');
    return;
  }
  for (const [key, value] of Object.entries(expectedContext)) {
    if (ackPayload[key] !== value) {
      fail(`VALVE_COMMAND command_ack dropped ACK context field ${key}`);
    }
  }
  if (ackPayload.deviceEui !== valveEui) {
    fail('VALVE_COMMAND command_ack did not preserve the valve deviceEui');
  }
  if (ackPayload.gatewayDeviceEui !== gatewayEui) {
    fail('VALVE_COMMAND command_ack did not preserve the gatewayDeviceEui');
  }
})().catch((error) => {
  fail(`failed to execute VALVE_COMMAND ACK context fixture: ${error.message}`);
}));
expectFileIncludes('node-red.init', nodeRedInitScript, '. /usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper');
expectFileIncludes('node-red.init', nodeRedInitScript, 'gateway_identity_resolve', 'resolves the canonical gateway identity through the shared helper');
expectFileIncludes('node-red.init', nodeRedInitScript, 'gateway_identity_repair_concentratord_config || true', 'self-heals active concentratord gateway-id state during startup');
expectFileIncludes('node-red.init', nodeRedInitScript, 'gateway_identity_persist', 'persists canonical gateway identity metadata during startup');
expectFileIncludes('node-red.init', nodeRedInitScript, 'normalize_runtime_eui()', 'defines a startup helper to canonicalize gateway identities before exporting them');
expectFileIncludes('node-red.init', nodeRedInitScript, 'device_eui="$(normalize_runtime_eui "$device_eui")"', 'normalizes the runtime gateway identity to uppercase before using it for MQTT credentials');
expectFileIncludes('node-red.init', nodeRedInitScript, 'link_gateway_device_eui="$(normalize_runtime_eui "$link_gateway_device_eui")"', 'normalizes the linked gateway identity to uppercase before exporting it');
expectFileIncludes('node-red.init', nodeRedInitScript, 'DEVICE_EUI="$device_eui"', 'exports the derived gateway EUI into the Node-RED runtime environment');
expectFileIncludes('node-red.init', nodeRedInitScript, 'DEVICE_EUI_CONFIDENCE="$device_eui_confidence"', 'exports gateway identity confidence into the Node-RED runtime environment');
expectFileIncludes('node-red.init', nodeRedInitScript, 'LINK_GATEWAY_DEVICE_EUI="$link_gateway_device_eui"', 'exports the linked gateway identity into the Node-RED runtime environment');
expectFileIncludes('node-red.init', nodeRedInitScript, 'ALLOW_PRIVATE_SERVER_URLS="$allow_private_server_urls"', 'exports the private-target override into the Node-RED runtime environment');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, '. /usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper for first-boot seeding');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'gateway_identity_resolve', 'resolves the canonical gateway identity during UCI seeding');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'gateway_identity_persist', 'persists canonical gateway identity during UCI seeding');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.device_eui_source=$DEVICE_EUI_SOURCE', 'stores the identity source in UCI');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.device_eui_confidence=$DEVICE_EUI_CONFIDENCE', 'stores the identity confidence in UCI');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.link_gateway_device_eui=', 'initializes linked gateway identity metadata in UCI');
expectFileIncludes('96_osi_server_config', osiServerDefaultsScript, 'set osi-server.cloud.allow_private_target=0', 'defaults the private-target override to disabled');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, '/usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper during one-shot bootstrap detection');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "readGatewayIdentityViaHelper", 'reads gateway identity via the shared helper during one-shot bootstrap detection');
expectFileExcludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'envVars.DEVICE_EUI = gatewayEui', 'persisting a stale gateway identity into .chirpstack.env when Node-RED already injects the canonical runtime value');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'const protectedKeys = new Set([', 'protects runtime gateway identity keys from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI'", 'protects DEVICE_EUI from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI_SOURCE'", 'protects DEVICE_EUI_SOURCE from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI_CONFIDENCE'", 'protects DEVICE_EUI_CONFIDENCE from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'DEVICE_EUI_LAST_VERIFIED_AT'", 'protects DEVICE_EUI_LAST_VERIFIED_AT from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "'LINK_GATEWAY_DEVICE_EUI'", 'protects LINK_GATEWAY_DEVICE_EUI from env-file overrides');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "if (protectedKeys.has(key) && String(process.env[key] || '').trim()) return;", 'keeps init-provided identity env values when the env file is stale');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'LSN50_CODEC_PATH', 'allows overriding the LSN50 decoder path during bootstrap');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'STREGA_CODEC_PATH', 'allows overriding the STREGA decoder path during bootstrap');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, 'CFG.stregaCodecPath', 'tracks the shipped STREGA decoder path in bootstrap config');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "readCodecScript(CFG.stregaCodecPath, 'STREGA')", 'loads the shipped STREGA decoder during bootstrap');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "getOrCreateProfileWithCodec(client, tenantId, CFG.profileStregaName", 'creates or repairs the OSI STREGA profile with a payload codec');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "CFG.lsn50CodecPath", 'tracks the shipped LSN50 decoder path in bootstrap config');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "readCodecScript(CFG.lsn50CodecPath, 'LSN50')", 'loads the shipped LSN50 decoder during bootstrap');
expectFileIncludes('chirpstack-bootstrap.js', chirpstackBootstrapScript, "getOrCreateProfileWithCodec(client, tenantId, CFG.profileLsn50Name", 'creates or repairs the OSI LSN50 profile with a payload codec');
expectFileIncludes('deploy.sh', deployScript, 'run_communication_preflight()', 'runs communication validation before deploy artifacts are copied');
expectFileIncludes('deploy.sh', deployScript, 'scripts/verify-communication-contract.js', 'uses the focused communication contract verifier during deploy preflight');
expectFileIncludes('deploy.sh', deployScript, 'scripts/diagnose-pi-communication.sh', 'fetches the required communication diagnostic during deploy preflight');
expectFileIncludes('deploy.sh', deployScript, 'Communication preflight', 'prints a clear deploy preflight section');
expectFileIncludes('deploy.sh', deployScript, '"feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init"', 'deploys the Node-RED init script to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh"', 'deploys the shared gateway identity helper to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/package.json"', 'deploys the osi-dendro-helper package manifest to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js"', 'deploys the osi-dendro-helper runtime helper to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen1_decoder.js"', 'deploys the shipped STREGA ChirpStack decoder to live devices');
expectFileIncludes('deploy.sh', deployScript, '"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js"', 'deploys the shipped LSN50 ChirpStack decoder to live devices');
expectFileIncludes('deploy.sh', deployScript, 'chmod 755 /etc/init.d/node-red', 'keeps the deployed Node-RED init script executable');
expectFileIncludes('deploy.sh', deployScript, 'ALTER TABLE devices ADD COLUMN dendro_ratio_at_retracted REAL', 'repairs the live DB with the canonical dendrometer retracted-ratio column during deploy');
expectFileIncludes('deploy.sh', deployScript, 'ALTER TABLE devices ADD COLUMN dendro_ratio_at_extended REAL', 'repairs the live DB with the canonical dendrometer extended-ratio column during deploy');
expectFileIncludes('deploy.sh', deployScript, 'UPDATE devices SET dendro_ratio_at_retracted = CASE', 'backfills the canonical dendrometer retracted-ratio column during deploy');
expectFileIncludes('deploy.sh', deployScript, 'UPDATE devices SET dendro_ratio_at_extended = CASE', 'backfills the canonical dendrometer extended-ratio column during deploy');
expectFileIncludes('deploy.sh', deployScript, '/etc/init.d/osi-gateway-gps stop || true', 'stops the retired gateway GPS sidecar during deploy');
expectFileIncludes('deploy.sh', deployScript, '/etc/init.d/osi-gateway-gps disable || true', 'disables the retired gateway GPS sidecar during deploy');
expectFileIncludes('deploy.sh', deployScript, 'rm -f /etc/init.d/osi-gateway-gps /usr/bin/osi-gateway-gps.js', 'removes the retired gateway GPS sidecar files during deploy');
for (const seedDatabasePath of seedDatabasePaths) {
  const relativeSeedPath = path.relative(path.resolve(__dirname, '..'), seedDatabasePath);
  const columns = new Set(readTableColumns(seedDatabasePath, 'devices'));
  expectCondition(
    columns.has('dendro_ratio_at_retracted'),
    `${relativeSeedPath} includes dendro_ratio_at_retracted in the bundled devices schema`,
    `${relativeSeedPath} is missing dendro_ratio_at_retracted in the bundled devices schema`
  );
  expectCondition(
    columns.has('dendro_ratio_at_extended'),
    `${relativeSeedPath} includes dendro_ratio_at_extended in the bundled devices schema`,
    `${relativeSeedPath} is missing dendro_ratio_at_extended in the bundled devices schema`
  );
  expectCondition(
    columns.has('dendro_force_legacy'),
    `${relativeSeedPath} includes dendro_force_legacy in the bundled devices schema`,
    `${relativeSeedPath} is missing dendro_force_legacy in the bundled devices schema`
  );
  expectCondition(
    columns.has('dendro_baseline_pending'),
    `${relativeSeedPath} includes dendro_baseline_pending in the bundled devices schema`,
    `${relativeSeedPath} is missing dendro_baseline_pending in the bundled devices schema`
  );
  expectCondition(
    columns.has('device_mode'),
    `${relativeSeedPath} includes device_mode in the bundled devices schema`,
    `${relativeSeedPath} is missing device_mode in the bundled devices schema`
  );
  const deviceDataColumns = new Set(readTableColumns(seedDatabasePath, 'device_data'));
  expectCondition(
    deviceDataColumns.has('adc_ch1v'),
    `${relativeSeedPath} includes adc_ch1v in the bundled device_data schema`,
    `${relativeSeedPath} is missing adc_ch1v in the bundled device_data schema`
  );
  expectCondition(
    deviceDataColumns.has('dendro_ratio'),
    `${relativeSeedPath} includes dendro_ratio in the bundled device_data schema`,
    `${relativeSeedPath} is missing dendro_ratio in the bundled device_data schema`
  );
  expectCondition(
    deviceDataColumns.has('dendro_mode_used'),
    `${relativeSeedPath} includes dendro_mode_used in the bundled device_data schema`,
    `${relativeSeedPath} is missing dendro_mode_used in the bundled device_data schema`
  );
  expectCondition(
    deviceDataColumns.has('dendro_stem_change_um'),
    `${relativeSeedPath} includes dendro_stem_change_um in the bundled device_data schema`,
    `${relativeSeedPath} is missing dendro_stem_change_um in the bundled device_data schema`
  );
  expectCondition(
    deviceDataColumns.has('dendro_position_raw_mm'),
    `${relativeSeedPath} includes dendro_position_raw_mm in the bundled device_data schema`,
    `${relativeSeedPath} is missing dendro_position_raw_mm in the bundled device_data schema`
  );
  expectCondition(
    deviceDataColumns.has('dendro_saturated'),
    `${relativeSeedPath} includes dendro_saturated in the bundled device_data schema`,
    `${relativeSeedPath} is missing dendro_saturated in the bundled device_data schema`
  );
  expectCondition(
    deviceDataColumns.has('dendro_saturation_side'),
    `${relativeSeedPath} includes dendro_saturation_side in the bundled device_data schema`,
    `${relativeSeedPath} is missing dendro_saturation_side in the bundled device_data schema`
  );
}
for (const seedDatabasePath of batPctDatabasePaths) {
  const relativeSeedPath = path.relative(path.resolve(__dirname, '..'), seedDatabasePath);
  const deviceDataColumns = new Set(readTableColumns(seedDatabasePath, 'device_data'));
  expectCondition(
    deviceDataColumns.has('bat_pct'),
    `${relativeSeedPath} includes bat_pct in the bundled device_data schema`,
    `${relativeSeedPath} is missing bat_pct in the bundled device_data schema`
  );
}
for (const seedDatabasePath of seedDendroHistoryDatabasePaths) {
  const relativeSeedPath = path.relative(path.resolve(__dirname, '..'), seedDatabasePath);
  const dendroReadingColumns = new Set(readTableColumns(seedDatabasePath, 'dendrometer_readings'));
  expectCondition(
    dendroReadingColumns.has('adc_ch0v'),
    `${relativeSeedPath} includes adc_ch0v in the bundled dendrometer_readings schema`,
    `${relativeSeedPath} is missing adc_ch0v in the bundled dendrometer_readings schema`
  );
  expectCondition(
    dendroReadingColumns.has('adc_ch1v'),
    `${relativeSeedPath} includes adc_ch1v in the bundled dendrometer_readings schema`,
    `${relativeSeedPath} is missing adc_ch1v in the bundled dendrometer_readings schema`
  );
  expectCondition(
    dendroReadingColumns.has('dendro_ratio'),
    `${relativeSeedPath} includes dendro_ratio in the bundled dendrometer_readings schema`,
    `${relativeSeedPath} is missing dendro_ratio in the bundled dendrometer_readings schema`
  );
  expectCondition(
    dendroReadingColumns.has('dendro_mode_used'),
    `${relativeSeedPath} includes dendro_mode_used in the bundled dendrometer_readings schema`,
    `${relativeSeedPath} is missing dendro_mode_used in the bundled dendrometer_readings schema`
  );
}
for (const seedDatabasePath of seedDatabasePaths) {
  const relativeSeedPath = path.relative(path.resolve(__dirname, '..'), seedDatabasePath);
  const chameleonColumns = new Set(readTableColumns(seedDatabasePath, 'chameleon_readings'));
  const deviceColumns = new Set(readTableColumns(seedDatabasePath, 'devices'));
  const deviceDataColumns = new Set(readTableColumns(seedDatabasePath, 'device_data'));
  const chameleonIndexes = new Set(readTableIndexes(seedDatabasePath, 'chameleon_readings'));
  expectCondition(
    deviceColumns.has('chameleon_enabled'),
    `${relativeSeedPath} includes chameleon_enabled in the bundled devices schema`,
    `${relativeSeedPath} is missing chameleon_enabled in the bundled devices schema`
  );
  expectCondition(
    deviceColumns.has('chameleon_swt1_depth_cm'),
    `${relativeSeedPath} includes chameleon_swt1_depth_cm in the bundled devices schema`,
    `${relativeSeedPath} is missing chameleon_swt1_depth_cm in the bundled devices schema`
  );
  expectCondition(
    deviceColumns.has('chameleon_swt3_c'),
    `${relativeSeedPath} includes chameleon_swt3_c in the bundled devices schema`,
    `${relativeSeedPath} is missing chameleon_swt3_c in the bundled devices schema`
  );
  expectCondition(
    deviceDataColumns.has('swt_1'),
    `${relativeSeedPath} includes swt_1 in the bundled device_data schema`,
    `${relativeSeedPath} is missing swt_1 in the bundled device_data schema`
  );
  expectCondition(
    chameleonColumns.has('payload_b64'),
    `${relativeSeedPath} includes payload_b64 in the bundled chameleon_readings schema`,
    `${relativeSeedPath} is missing payload_b64 in the bundled chameleon_readings schema`
  );
  expectCondition(
    chameleonColumns.has('r1_ohm_comp'),
    `${relativeSeedPath} includes r1_ohm_comp in the bundled chameleon_readings schema`,
    `${relativeSeedPath} is missing r1_ohm_comp in the bundled chameleon_readings schema`
  );
  expectCondition(
    chameleonColumns.has('f_cnt'),
    `${relativeSeedPath} includes f_cnt in the bundled chameleon_readings schema`,
    `${relativeSeedPath} is missing f_cnt in the bundled chameleon_readings schema`
  );
  expectCondition(
    chameleonIndexes.has('idx_chameleon_readings_deveui_time'),
    `${relativeSeedPath} includes idx_chameleon_readings_deveui_time`,
    `${relativeSeedPath} is missing idx_chameleon_readings_deveui_time`
  );
  expectCondition(
    chameleonIndexes.has('idx_chameleon_readings_array_id'),
    `${relativeSeedPath} includes idx_chameleon_readings_array_id`,
    `${relativeSeedPath} is missing idx_chameleon_readings_array_id`
  );
}
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_resolve()', 'defines the shared canonical gateway resolver');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_active_chipset()', 'derives the active concentratord chipset before probing static gateway identifiers');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'uci -q get chirpstack-concentratord.@global[0].chipset', 'reads the active concentratord chipset from UCI');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_active_concentratord_uci', 'limits static UCI gateway-id probing to the active chipset');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_active_concentratord_toml', 'limits TOML gateway-id probing to the active chipset');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_repair_concentratord_config()', 'defines startup self-healing for active concentratord gateway-id state');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="authoritative"', 'marks live ChirpStack-derived gateway identities as authoritative');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="persisted"', 'marks previously verified gateway identities as persisted');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="provisional"', 'marks MAC-derived gateway identities as provisional');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, "tr 'abcdef' 'ABCDEF'", 'uses an explicit hex-only uppercase conversion that works on BusyBox');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, '/bin/sh -c', 'runs gateway detection in a non-login shell so banner output cannot poison detection');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'sh /usr/bin/gateway-id.sh', 'prefers runtime concentratord gateway identity when available');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_matches_local_mac_fallback', 'downgrades MAC-derived concentratord IDs away from authoritative confidence');
expectFileIncludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'for iface in eth0 br-lan wlan0; do', 'falls back across known interfaces for provisional MAC-derived identity');
expectFileExcludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_command "concentratord-uci-sx1302"', 'hard-coded sx1302 fallback outside active-chipset-aware resolution');
expectFileExcludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_command "concentratord-uci-sx1301"', 'hard-coded sx1301 fallback outside active-chipset-aware resolution');
expectFileExcludes('osi-gateway-identity.sh', gatewayIdentityHelperScript, 'gateway_identity_try_command "concentratord-toml"', 'blank-chipset TOML fallback outside active-chipset-aware resolution');
expectFileIncludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, '/usr/libexec/osi-gateway-identity.sh', 'uses the shared gateway identity helper for first-boot concentratord seeding');
expectFileIncludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, 'gateway_identity_active_lora_section', 'seeds only the active LoRa concentratord section');
expectFileIncludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, 'resolve_fallback_gateway_id()', 'keeps a single MAC-derived fallback path for first-boot concentratord seeding');
expectFileExcludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, "SECTION='chirpstack-concentratord.@sx1302[0]'", 'hard-coded sx1302 seeding outside active-chipset-aware logic');
expectFileExcludes('99_set_sx1301_gateway_id', sx1301GatewayDefaultScript, "SECTION='chirpstack-concentratord.@sx1301[0]'", 'hard-coded sx1301 seeding outside active-chipset-aware logic');

const authNodes = flows.filter((node) => typeof node.func === 'string' && node.func.includes('function getAuthSecret()'));
for (const insecureNeedle of ['osi-os-default-auth-secret', "env.get('CHIRPSTACK_API_KEY')"]) {
  const offendingNode = authNodes.find((node) => node.func.includes(insecureNeedle));
  if (offendingNode) {
    fail(`${offendingNode.name || offendingNode.id} still contains insecure auth secret fallback: ${insecureNeedle}`);
  } else {
    console.log(`OK removed insecure auth fallback ${insecureNeedle}`);
  }
}

if (!fs.existsSync(packageJsonPath)) {
  fail(`missing Node-RED package manifest at ${packageJsonPath}`);
} else {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  for (const dependency of ['@chirpstack/chirpstack-api', '@grpc/grpc-js', '@rakwireless/field-tester-server', 'bcryptjs', 'node-red-node-sqlite', 'osi-chirpstack-helper', 'osi-db-helper', 'osi-dendro-helper', 'sqlite3']) {
    if (!packageJson.dependencies || !packageJson.dependencies[dependency]) {
      fail(`package.json missing dependency ${dependency}`);
    } else {
      console.log(`OK package.json includes ${dependency}`);
    }
  }
}

const rawDbNodes = flows.filter(
  (node) => typeof node.func === 'string' && node.func.includes("new sqlite3.Database('/data/db/farming.db')")
);
for (const node of rawDbNodes) {
  const sqliteLib = (node.libs || []).find((entry) => entry && entry.var === 'sqlite3');
  if (!sqliteLib) {
    fail(`${node.name || node.id} missing sqlite3 helper import`);
  } else if (sqliteLib.module !== 'osi-db-helper') {
    fail(`${node.name || node.id} should import osi-db-helper instead of ${sqliteLib.module}`);
  } else {
    console.log(`OK ${node.name || node.id} uses osi-db-helper`);
  }
}

const helperPath = helperCandidates.find((candidate) => fs.existsSync(candidate));
if (!helperPath) {
  fail(`missing ChirpStack helper module at one of: ${helperCandidates.join(', ')}`);
} else {
  try {
    const helper = require(helperPath);
    for (const exportName of ['createClient', 'createProvisioningClientFromEnv', 'normalizeApiUrl']) {
      if (typeof helper[exportName] !== 'function') {
        fail(`helper missing export ${exportName}`);
      } else {
        console.log(`OK helper exports ${exportName}`);
      }
    }
  } catch (error) {
    const helperIndexPath = path.join(helperPath, 'index.js');
    const helperSource = fs.existsSync(helperIndexPath) ? fs.readFileSync(helperIndexPath, 'utf8') : '';
    expectFileIncludes('osi-chirpstack-helper/index.js', helperSource, 'async getDeviceProfile(', 'adds profile reads so bootstrap can inspect existing ChirpStack codecs');
    expectFileIncludes('osi-chirpstack-helper/index.js', helperSource, 'async updateDeviceProfile(', 'adds profile updates so bootstrap can repair codec-less ChirpStack profiles');
    if (error.code === 'MODULE_NOT_FOUND' && helperSource) {
      console.log(`OK helper source present despite missing local runtime deps: ${error.message}`);
      for (const exportName of ['createClient', 'createProvisioningClientFromEnv', 'normalizeApiUrl']) {
        if (!helperSource.includes(`${exportName}`)) {
          fail(`helper source missing export ${exportName}`);
        } else {
          console.log(`OK helper source includes ${exportName}`);
        }
      }
    } else {
      fail(`failed to load ChirpStack helper: ${error.message}`);
    }
  }
}

expectFileIncludes('strega_gen1_decoder.js', stregaCodecSource, 'function decodeUplink(input)', 'ships the STREGA ChirpStack decoder entry point');
expectFileIncludes('strega_gen1_decoder.js', stregaCodecSource, 'function Decode(fPort, bytes)', 'ships the vendor Gen1 STREGA decoder implementation');
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'function decodeUplink(input)', 'ships the LSN50 ChirpStack decoder entry point');
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'decode.Work_mode="3ADC+IIC";', 'ships the working MOD3 decoder path from the live LSN50 profile');
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'decode.ADC_CH1V= (bytes[2]<<8 | bytes[3])/1000;', 'ships the working LSN50 CH1 decoder logic');

const dbHelperPath = dbHelperCandidates.find((candidate) => fs.existsSync(candidate));
if (!dbHelperPath) {
  fail(`missing DB helper module at one of: ${dbHelperCandidates.join(', ')}`);
} else {
  const dbHelperIndexPath = path.join(dbHelperPath, 'index.js');
  const dbHelperSource = fs.existsSync(dbHelperIndexPath) ? fs.readFileSync(dbHelperIndexPath, 'utf8') : '';
  expectFileIncludes('osi-db-helper/index.js', dbHelperSource, 'transaction(executor)', 'exposes the helper-scoped transaction primitive');
  pendingChecks.push(
    verifyDbHelperTransactionBehavior(dbHelperSource, dbHelperIndexPath).catch((error) => {
      fail(`failed to verify DB helper transaction behavior: ${error.message}`);
    })
  );
  try {
    const helper = require(dbHelperPath);
    for (const exportName of ['Database', 'getHealth', 'quickCheck']) {
      if (typeof helper[exportName] !== 'function') {
        fail(`DB helper missing export ${exportName}`);
      } else {
        console.log(`OK DB helper exports ${exportName}`);
      }
    }
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && dbHelperSource) {
      console.log(`OK DB helper source present despite missing local runtime deps: ${error.message}`);
      for (const exportName of ['Database', 'getHealth', 'quickCheck']) {
        if (!dbHelperSource.includes(exportName)) {
          fail(`DB helper source missing export ${exportName}`);
        } else {
          console.log(`OK DB helper source includes ${exportName}`);
        }
      }
    } else {
      fail(`failed to load DB helper: ${error.message}`);
    }
  }
}

const dbHelperIndexPath = dbHelperPath ? path.join(dbHelperPath, 'index.js') : null;
if (dbHelperIndexPath && fs.existsSync(dbHelperIndexPath)) {
  const dbHelperSource = fs.readFileSync(dbHelperIndexPath, 'utf8');
  expectFileIncludes('osi-db-helper/index.js', dbHelperSource, 'transaction(', 'exposes the queued helper transaction primitive');
}

const dendroHelperPath = dendroHelperCandidates.find((candidate) => fs.existsSync(candidate));
if (!dendroHelperPath) {
  fail(`missing dendro helper module at one of: ${dendroHelperCandidates.join(', ')}`);
} else {
  let dendroHelper = null;
  try {
    dendroHelper = require(dendroHelperPath);
    for (const exportName of ['decodeRawAdcPayload', 'detectDendroModeUsed', 'calculateDendroRatio', 'calculateRatioDendroPositionMm', 'calculateRatioDendroPositionRawMm', 'buildDendroDerivedMetrics', 'computeDendroDeltaMm', 'computeDendroStemChangeUm']) {
      if (typeof dendroHelper[exportName] !== 'function') {
        fail(`dendro helper missing export ${exportName}`);
      } else {
        console.log(`OK dendro helper exports ${exportName}`);
      }
    }
  } catch (error) {
    const helperIndexPath = path.join(dendroHelperPath, 'index.js');
    const helperSource = fs.existsSync(helperIndexPath) ? fs.readFileSync(helperIndexPath, 'utf8') : '';
    if (error.code === 'MODULE_NOT_FOUND' && helperSource) {
      console.log(`OK dendro helper source present despite missing local runtime deps: ${error.message}`);
      for (const exportName of ['decodeRawAdcPayload', 'detectDendroModeUsed', 'calculateDendroRatio', 'calculateRatioDendroPositionMm', 'calculateRatioDendroPositionRawMm', 'buildDendroDerivedMetrics', 'computeDendroDeltaMm', 'computeDendroStemChangeUm']) {
        if (!helperSource.includes(exportName)) {
          fail(`dendro helper source missing export ${exportName}`);
        } else {
          console.log(`OK dendro helper source includes ${exportName}`);
        }
      }
    } else {
      fail(`failed to load dendro helper: ${error.message}`);
    }
  }

  if (dendroHelper) {
    const mod3Fixture = Buffer.from([0x0B, 0xB8, 0x00, 0xFA, 0x04, 0xB0, 0x08, 0x09, 0xC4, 0x03, 0x84]).toString('base64');
    const decoded = dendroHelper.decodeRawAdcPayload(mod3Fixture);
    expectApprox(decoded && decoded.adcCh0V, 1.2, 0.001, 'dendro helper decodes ADC_CH0V from raw MOD3 payloads');
    expectApprox(decoded && decoded.adcCh1V, 2.5, 0.001, 'dendro helper decodes ADC_CH1V from raw MOD3 payloads');
    expectApprox(decoded && decoded.adcCh4V, 0.9, 0.001, 'dendro helper decodes ADC_CH4V from raw MOD3 payloads');
    expectEqual(decoded && decoded.modeCode, 3, 'dendro helper decodes MOD3 mode from raw payloads');

    const legacyFixture = Buffer.from([0x0B, 0xB8, 0x00, 0xFA, 0x08, 0x77, 0x00, 0xFF, 0xFF, 0x03, 0x84]).toString('base64');
    const legacyDecoded = dendroHelper.decodeRawAdcPayload(legacyFixture);
    expectApprox(legacyDecoded && legacyDecoded.adcCh0V, 2.167, 0.001, 'dendro helper still decodes ADC_CH0V from legacy raw payloads');
    expectEqual(legacyDecoded && legacyDecoded.adcCh1V, null, 'dendro helper ignores raw CH1 fallback data outside MOD3');
    expectEqual(legacyDecoded && legacyDecoded.adcCh4V, null, 'dendro helper ignores raw CH4 fallback data outside MOD3');
    expectEqual(legacyDecoded && legacyDecoded.modeCode, 1, 'dendro helper preserves the observed legacy mode from raw payloads');

    const legacyMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 2,
      adcCh0V: 1.2,
      adcCh1V: null,
    });
    expectEqual(legacyMetrics.dendroModeUsed, 'legacy_single_adc', 'legacy dendrometer path remains active outside MOD3');
    expectEqual(legacyMetrics.dendroRatio, null, 'legacy dendrometer path does not expose a ratio');
    expectApprox(legacyMetrics.positionRawMm, 12, 0.001, 'legacy dendrometer path preserves raw single-ADC conversion');
    expectApprox(legacyMetrics.positionMm, 12, 0.001, 'legacy dendrometer path preserves single-ADC conversion');
    expectEqual(legacyMetrics.dendroSaturated, 0, 'legacy dendrometer path is not flagged as saturated');
    expectEqual(legacyMetrics.dendroSaturationSide, null, 'legacy dendrometer path has no saturation side');

    const ratioMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 1.2,
      adcCh1V: 2.4,
      strokeMm: 40,
      ratioAtRetracted: 0.2,
      ratioAtExtended: 0.8,
    });
    expectEqual(ratioMetrics.dendroModeUsed, 'ratio_mod3', 'MOD3 dendrometer path switches to ratio mode when CH0 and CH1 are valid');
    expectApprox(ratioMetrics.dendroRatio, 0.5, 0.000001, 'ratio dendrometer path exposes the raw ratio');
    expectApprox(ratioMetrics.positionRawMm, 20, 0.001, 'ratio dendrometer path converts raw calibrated displacement');
    expectApprox(ratioMetrics.positionMm, 20, 0.001, 'ratio dendrometer path converts calibrated displacement');
    expectEqual(ratioMetrics.dendroSaturated, 0, 'in-range ratio dendrometer samples are not flagged as saturated');
    expectEqual(ratioMetrics.dendroSaturationSide, null, 'in-range ratio dendrometer samples have no saturation side');

    const invalidReferenceMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 1.2,
      adcCh1V: 0.01,
      strokeMm: 40,
      ratioAtRetracted: 0.2,
      ratioAtExtended: 0.8,
    });
    expectEqual(invalidReferenceMetrics.dendroModeUsed, 'legacy_single_adc', 'near-zero CH1 falls back to the legacy dendrometer path');
    expectEqual(invalidReferenceMetrics.dendroRatio, null, 'near-zero CH1 does not leak a ratio through the legacy fallback');
    expectApprox(invalidReferenceMetrics.positionMm, 12, 0.001, 'near-zero CH1 preserves legacy dendrometer comparability');

    const belowRangeMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 0.19,
      adcCh1V: 1,
      strokeMm: 40,
      ratioAtRetracted: 0.2,
      ratioAtExtended: 0.8,
    });
    expectApprox(belowRangeMetrics.positionRawMm, -0.667, 0.001, 'below-range ratio samples preserve negative raw displacement');
    expectApprox(belowRangeMetrics.positionMm, 0, 0.001, 'below-range ratio samples keep a clamped compatibility position');
    expectEqual(belowRangeMetrics.dendroSaturated, 1, 'below-range ratio samples are flagged as saturated');
    expectEqual(belowRangeMetrics.dendroSaturationSide, 'low', 'below-range ratio samples report low-side saturation');

    const aboveRangeMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 0.85,
      adcCh1V: 1,
      strokeMm: 40,
      ratioAtRetracted: 0.2,
      ratioAtExtended: 0.8,
    });
    expectApprox(aboveRangeMetrics.positionRawMm, 43.333, 0.001, 'above-range ratio samples preserve over-stroke raw displacement');
    expectApprox(aboveRangeMetrics.positionMm, 40, 0.001, 'above-range ratio samples keep a clamped compatibility position');
    expectEqual(aboveRangeMetrics.dendroSaturated, 1, 'above-range ratio samples are flagged as saturated');
    expectEqual(aboveRangeMetrics.dendroSaturationSide, 'high', 'above-range ratio samples report high-side saturation');

    const missingCalibrationMetrics = dendroHelper.buildDendroDerivedMetrics({
      effectiveMode: 3,
      adcCh0V: 1.2,
      adcCh1V: 2.4,
    });
    expectEqual(missingCalibrationMetrics.dendroModeUsed, 'ratio_mod3', 'ratio mode still activates without calibration values');
    expectApprox(missingCalibrationMetrics.dendroRatio, 0.5, 0.000001, 'ratio mode still exposes raw ratios when calibration is missing');
    expectEqual(missingCalibrationMetrics.positionRawMm, null, 'ratio mode does not synthesize raw displacement when calibration is missing');
    expectEqual(missingCalibrationMetrics.positionMm, null, 'ratio mode does not synthesize calibrated displacement when calibration is missing');
    expectEqual(missingCalibrationMetrics.calibrationMissing, true, 'ratio mode flags missing calibration cleanly');

    const pathResetDelta = dendroHelper.computeDendroDeltaMm({
      positionMm: 20,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '40|0.2|0.8',
      previousState: {
        positionMm: 19,
        modeUsed: 'legacy_single_adc',
        calibrationSignature: 'null|null|null',
      },
    });
    expectEqual(pathResetDelta.deltaMm, null, 'dendrometer delta resets when the conversion path changes');

    const calibrationResetDelta = dendroHelper.computeDendroDeltaMm({
      positionMm: 20,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '50|0.2|0.8',
      previousState: {
        positionMm: 19,
        modeUsed: 'ratio_mod3',
        calibrationSignature: '40|0.2|0.8',
      },
    });
    expectEqual(calibrationResetDelta.deltaMm, null, 'dendrometer delta resets when calibration changes');

    const initialStemChange = dendroHelper.computeDendroStemChangeUm({
      positionMm: 20,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '40|0.2|0.8',
      baselineState: null,
    });
    expectEqual(initialStemChange.stemChangeUm, 0, 'the first valid calibrated dendrometer reading establishes a zero stem-change baseline');
    expectApprox(initialStemChange.nextBaseline.positionMm, 20, 0.001, 'the first valid calibrated dendrometer reading becomes the persisted baseline position');

    const laterStemChange = dendroHelper.computeDendroStemChangeUm({
      positionMm: 20.125,
      modeUsed: 'ratio_mod3',
      calibrationSignature: '40|0.2|0.8',
      baselineState: initialStemChange.nextBaseline,
    });
    expectEqual(laterStemChange.stemChangeUm, 125, 'stem change is reported in micrometers relative to the device baseline');

    const resetStemChange = dendroHelper.computeDendroStemChangeUm({
      positionMm: 19.5,
      modeUsed: 'legacy_single_adc',
      calibrationSignature: 'null|null|null',
      baselineState: initialStemChange.nextBaseline,
    });
    expectEqual(resetStemChange.stemChangeUm, 0, 'stem change resets to zero when the conversion path changes');

    pendingChecks.push(executeFunctionNodeById('dendro-readings-insert-fn', {
      formattedData: {
        devEui: 'ABC123',
        detectedMode: 2,
        dendroValid: 1,
        positionMm: 1.234,
        deltaMm: null,
        adcV: 1.111,
        adcCh1V: null,
        dendroRatio: null,
        dendroModeUsed: 'legacy_single_adc',
        batV: 3.65,
        timestamp: '2026-04-17T12:00:00.000Z',
      },
    }).then((sqlMsg) => {
      const sql = String((sqlMsg && (sqlMsg.topic || sqlMsg.payload)) || '');
      expectCondition(
        sql.includes('adc_v,adc_ch0v,adc_ch1v,dendro_ratio,dendro_mode_used'),
        'legacy dendrometer SQL keeps adc_v while adding CH0/CH1/ratio debug columns',
        'legacy dendrometer SQL is missing backward-compatible raw debug columns'
      );
      expectCondition(
        sql.includes("1.111,1.111,NULL,NULL,'legacy_single_adc'"),
        'legacy dendrometer SQL preserves adc_v and adc_ch0v semantics for historical rows',
        'legacy dendrometer SQL no longer preserves adc_v and adc_ch0v semantics'
      );
    }).catch((error) => {
      fail(`failed to execute dendro-readings-insert-fn fixture: ${error.message}`);
    }));

    pendingChecks.push(executeFunctionNodeById('dendro-readings-insert-fn', {
      formattedData: {
        devEui: 'ABC123',
        detectedMode: 3,
        dendroValid: 1,
        positionMm: 12.5,
        deltaMm: 0.125,
        adcV: 1.2,
        adcCh1V: 2.4,
        dendroRatio: 0.5,
        dendroModeUsed: 'ratio_mod3',
        batV: 3.7,
        timestamp: '2026-04-17T12:05:00.000Z',
      },
    }).then((sqlMsg) => {
      const sql = String((sqlMsg && (sqlMsg.topic || sqlMsg.payload)) || '');
      expectCondition(
        sql.includes("1.2,1.2,2.4,0.5,'ratio_mod3'"),
        'MOD3 dendrometer SQL persists CH1, ratio, and ratio-mode metadata',
        'MOD3 dendrometer SQL is missing the ratio-mode persistence columns or values'
      );
    }).catch((error) => {
      fail(`failed to execute MOD3 dendro-readings-insert-fn fixture: ${error.message}`);
    }));

    function buildS2120Fixture(options = {}) {
      const timestamp = options.timestamp || '2026-04-21T10:00:00.000Z';
      return {
        payload: {
          deviceInfo: { devEui: 'ABC123' },
          time: timestamp,
          object: {
            messages: [[
              { measurementId: 4097, measurementValue: 18.2 },
              { measurementId: 4098, measurementValue: 66.1 },
              { measurementId: 4099, measurementValue: 1234 },
              { measurementId: 4101, measurementValue: 100870 },
              { measurementId: 4103, measurementValue: options.batteryPct ?? 84 },
              { measurementId: 4104, measurementValue: 182.4 },
              { measurementId: 4105, measurementValue: 3.2 },
              { measurementId: 4113, measurementValue: options.rainGaugeCumulativeMm ?? 12.4 },
              { measurementId: 4190, measurementValue: 2.7 },
              { measurementId: 4213, measurementValue: options.windGustMps ?? 7.6 },
            ]],
          },
        },
      };
    }

    function createS2120QueryHandler(options = {}) {
      return (sql) => {
        if (sql.includes('SELECT type_id FROM devices')) {
          return [{ type_id: options.deviceType || 'SENSECAP_S2120' }];
        }
        if (sql.includes('SELECT recorded_at, rain_gauge_cumulative_mm')) {
          return options.previousSample ? [options.previousSample] : [];
        }
        if (sql.includes('SELECT recorded_at') && sql.includes('recorded_at >=') && sql.includes('rain_gauge_cumulative_mm IS NOT NULL')) {
          return options.duplicateOrFuture ? [options.duplicateOrFuture] : [];
        }
        if (sql.includes('SELECT COALESCE(SUM(rain_mm_delta), 0) AS rain_mm_today')) {
          return [{ rain_mm_today: options.todayTotal ?? 0 }];
        }
        return [];
      };
    }

    pendingChecks.push((async () => {
      const processedMsg = await executeFunctionNodeById(
        'strega-process-fn',
        {
          payload: {
            deviceInfo: {
              devEui: '70B3D57708000334',
              deviceProfileName: 'STREGA',
              deviceProfileId: 'strega-profile',
            },
            object: {
              Battery: 100,
              Valve: '0',
              Temperature: 125,
              Hygrometry: 100,
            },
            fPort: 4,
            time: '2026-04-22T00:00:00.000Z',
          },
        },
        {
          scope: {
            osiDb: createMockOsiDb((sql) => {
              if (sql.includes('SELECT type_id FROM devices')) {
                return [{ type_id: 'STREGA_VALVE' }];
              }
              return [];
            }),
          },
        }
      );
      const formatted = processedMsg.formattedData || {};
      expectEqual(formatted.batteryRaw, 100, 'STREGA process fixture preserves the raw battery value');
      expectEqual(formatted.batPct, 100, 'STREGA process fixture preserves the normalized battery percent');
      expectEqual(formatted.ambientTemperature, null, 'STREGA process fixture drops the sentinel ambient temperature');
      expectEqual(formatted.relativeHumidity, null, 'STREGA process fixture drops the sentinel relative humidity');
      expectEqual(formatted.currentState, 'CLOSED', 'STREGA process fixture preserves the valve state');
    })().catch((error) => {
      fail(`failed to execute STREGA process fixture: ${error.message}`);
    }));

    pendingChecks.push((async () => {
      const telemetryMsg = await executeFunctionNodeById(
        '8809bb5239dfb3d4',
        {
          payload: {
            deviceInfo: {
              devEui: '70B3D57708000334',
              deviceProfileName: 'STREGA',
              deviceProfileId: 'strega-profile',
            },
            object: {
              Battery: 100,
              Valve: '0',
              Temperature: 125,
              Hygrometry: 100,
            },
            time: '2026-04-22T00:00:00.000Z',
          },
        },
        {
          env: {
            DEVICE_EUI: '70B3D57708000334',
            CHIRPSTACK_PROFILE_STREGA: 'strega-profile',
          },
        }
      );
      const payload = JSON.parse(String(telemetryMsg && telemetryMsg.payload ? telemetryMsg.payload : '{}'));
      expectEqual(payload.battery_raw, 100, 'STREGA telemetry fixture preserves the raw battery value');
      expectEqual(payload.bat_pct, 100, 'STREGA telemetry fixture preserves the normalized battery percent');
      expectEqual(payload.ambient_temperature, null, 'STREGA telemetry fixture drops the sentinel ambient temperature');
      expectEqual(payload.relative_humidity, null, 'STREGA telemetry fixture drops the sentinel relative humidity');
      expectEqual(payload.current_state, 'CLOSED', 'STREGA telemetry fixture preserves the valve state');
    })().catch((error) => {
      fail(`failed to execute STREGA telemetry fixture: ${error.message}`);
    }));

    pendingChecks.push((async () => {
      const [processedMsg, rainOut] = await executeFunctionNodeById(
        's2120-process-fn',
        buildS2120Fixture(),
        {
          scope: {
            osiDb: createMockOsiDb(createS2120QueryHandler()),
          },
        }
      );
      const formatted = processedMsg.formattedData || {};
      expectEqual(formatted.rainGaugeCumulativeMm, 12.4, 'S2120 fixture maps measurement 4113 to cumulative rain');
      expectEqual(formatted.windGustMps, 7.6, 'S2120 fixture maps measurement 4213 to wind gust');
      expectEqual(formatted.batPct, 84, 'S2120 fixture maps measurement 4103 to battery percent');
      expectApprox(formatted.barometricPressureHpa, 1008.7, 0.000001, 'S2120 fixture normalizes pressure to hPa');
      expectEqual(formatted.rainDeltaStatus, 'first_sample', 'S2120 fixture marks the first rain sample without fabricating a delta');
      expectEqual(formatted.rainMmPer10Min, null, 'S2120 first-sample fixture leaves the normalized rain rate empty');
      expectEqual(rainOut, null, 'S2120 first-sample fixture does not emit a zone-rain update');
    })().catch((error) => {
      fail(`failed to execute first-sample S2120 fixture: ${error.message}`);
    }));

    pendingChecks.push((async () => {
      const [processedMsg, rainOut] = await executeFunctionNodeById(
        's2120-process-fn',
        buildS2120Fixture({ timestamp: '2026-04-21T10:00:00.000Z', rainGaugeCumulativeMm: 11.4 }),
        {
          scope: {
            osiDb: createMockOsiDb(createS2120QueryHandler({
              previousSample: {
                recorded_at: '2026-04-21T09:50:00.000Z',
                rain_gauge_cumulative_mm: 10.0,
              },
              todayTotal: 1.2,
            })),
          },
        }
      );
      const formatted = processedMsg.formattedData || {};
      expectEqual(formatted.rainDeltaStatus, 'ok', 'S2120 fixture marks increasing cumulative rain as valid');
      expectApprox(formatted.rainMmDelta, 1.4, 0.000001, 'S2120 fixture computes rain deltas from cumulative rain');
      expectApprox(formatted.rainMmPerHour, 8.4, 0.000001, 'S2120 fixture computes hourly rain rate from elapsed time');
      expectApprox(formatted.rainMmPer10Min, 1.4, 0.000001, 'S2120 fixture computes normalized rain per 10 minutes');
      expectApprox(formatted.rainMmToday, 2.6, 0.000001, 'S2120 fixture accumulates local-day rain totals');
      expectEqual(formatted.counterIntervalSeconds, 600, 'S2120 fixture stores the elapsed rain-counter interval in seconds');
      expectCondition(!!rainOut, 'S2120 fixture emits valid rain deltas to the zone aggregation path', 'S2120 fixture did not emit a valid rain delta to the zone aggregation path');
    })().catch((error) => {
      fail(`failed to execute valid-delta S2120 fixture: ${error.message}`);
    }));

    pendingChecks.push((async () => {
      const [processedMsg, rainOut] = await executeFunctionNodeById(
        's2120-process-fn',
        buildS2120Fixture({ timestamp: '2026-04-21T10:00:00.000Z', rainGaugeCumulativeMm: 11.4 }),
        {
          scope: {
            osiDb: createMockOsiDb(createS2120QueryHandler({
              previousSample: {
                recorded_at: '2026-04-21T09:50:00.000Z',
                rain_gauge_cumulative_mm: 10.0,
              },
              duplicateOrFuture: {
                recorded_at: '2026-04-21T10:00:00.000Z',
              },
              todayTotal: 1.2,
            })),
          },
        }
      );
      const formatted = processedMsg.formattedData || {};
      expectEqual(formatted.rainDeltaStatus, 'duplicate_timestamp', 'S2120 fixture skips duplicate timestamps');
      expectEqual(formatted.rainMmDelta, null, 'S2120 duplicate fixture does not emit a duplicate rain delta');
      expectEqual(rainOut, null, 'S2120 duplicate fixture does not emit a zone-rain update');
    })().catch((error) => {
      fail(`failed to execute duplicate-timestamp S2120 fixture: ${error.message}`);
    }));

    pendingChecks.push(executeFunctionNodeById('s2120-sql-fn', {
      formattedData: {
        devEui: 'ABC123',
        timestamp: '2026-04-21T10:00:00.000Z',
        ambientTemperature: 18.2,
        relativeHumidity: 66.1,
        lightLux: 1234,
        barometricPressureHpa: 1008.7,
        windSpeedMps: 3.2,
        windDirectionDeg: 182.4,
        windGustMps: 7.6,
        uvIndex: 2.7,
        rainGaugeCumulativeMm: 11.4,
        rainMmDelta: 1.4,
        rainMmPerHour: 8.4,
        rainMmPer10Min: 1.4,
        rainMmToday: 2.6,
        counterIntervalSeconds: 600,
        rainDeltaStatus: 'ok',
        batPct: 84,
      },
    }).then((sqlMsg) => {
      const sql = String((sqlMsg && (sqlMsg.topic || sqlMsg.payload)) || '');
      expectCondition(
        sql.includes('rain_mm_per_10min') && sql.includes('counter_interval_seconds'),
        'S2120 SQL insert persists normalized rain telemetry and interval length',
        'S2120 SQL insert is missing normalized rain telemetry or interval length'
      );
      expectCondition(
        sql.includes('8.4') && sql.includes('600') && sql.includes("'ok'"),
        'S2120 SQL insert includes the computed rain-rate values and status',
        'S2120 SQL insert is missing computed rain-rate values or status'
      );
    }).catch((error) => {
      fail(`failed to execute S2120 SQL fixture: ${error.message}`);
    }));
  }
}

Promise.all(pendingChecks).finally(() => {
  if (!process.exitCode) {
    console.log('Sync flow verification passed');
  }
});
