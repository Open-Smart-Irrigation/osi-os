'use strict';
// NEW-15: farm database start-up state in osi-db-helper/startup.js. Every case
// builds its own state with injected files, process runner and clock; none
// touches /data or the process-wide state.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const HELPER = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper');
const { createStartupState, classify, CHECK_TIMEOUT_MS } = require(path.join(HELPER, 'startup.js'));

const mapsLine = (inode, file = '/firmware/sqlite3/build/Release/node_sqlite3.node') =>
  `7f0000000000-7f0000001000 r-xp 00000000 b3:02 ${inode}                 ${file}`;

function fixture({ addons = [], stat = () => ({}), result = { status: 0, stdout: 'ok\ncore_tables=3\n', stderr: '' }, clock = [0, 12] } = {}) {
  const logs = [], calls = [];
  let maps = addons;
  let tick = 0;
  const state = createStartupState({
    files: {
      readFileSync: (file) => { assert.equal(file, '/proc/self/maps'); return ['00400000-00401000 r-xp 00000000 08:01 1 /usr/bin/node', ...maps].join('\n'); },
      statSync: (file) => stat(file),
    },
    spawnSync: (...args) => { calls.push(args); return typeof result === 'function' ? result() : result; },
    monotonicNow: () => clock[Math.min(tick++, clock.length - 1)],
    log: (message) => logs.push(message),
  });
  return { state, logs, calls, setAddons: (value) => { maps = value; } };
}

test('a healthy file is checked once, read-only, with quick_check and the core tables', () => {
  const f = fixture();
  const health = f.state.check();
  f.state.check();
  f.state.beforeOpen('node_red');
  assert.equal(f.calls.length, 1);
  const [cmd, args, options] = f.calls[0];
  assert.equal(cmd, 'sqlite3');
  assert.deepEqual(args.slice(0, 2), ['-readonly', '/data/db/farming.db']);
  assert.match(args[2], /^PRAGMA quick_check\(1\);/);
  assert.match(args[2], /'users','devices','irrigation_zones'/);
  assert.equal(options.timeout, CHECK_TIMEOUT_MS);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(health.status, 'healthy');
  assert.equal(health.health_state, null);
  assert.equal(health.check_ms, 12);
  assert.deepEqual(f.logs, []);
});

test('no SQLite addon loaded yet (settings.js time) is not a conflict', () => {
  const f = fixture({ addons: [] });
  f.state.check();
  f.state.recordDriver('node_red');
  assert.equal(f.state.getHealth().native_addons, 0);
  f.setAddons([mapsLine(11467)]);
  assert.doesNotThrow(() => f.state.beforeOpen('node_red'));
  const health = f.state.getHealth();
  assert.equal(health.native_addons, 1);
  assert.equal(health.module_conflict, false);
  assert.equal(health.health_state, null);
});

test('several mappings of one addon file count once', () => {
  const f = fixture({ addons: [mapsLine(11467), mapsLine(11467).replace('r-xp', 'r--p'), mapsLine(11467).replace('r-xp', 'rw-p')] });
  f.state.check();
  f.state.recordDriver('node_red');
  assert.doesNotThrow(() => f.state.beforeOpen('node_red'));
  assert.equal(f.state.getHealth().native_addons, 1);
});

test('two native addons refuse every farm connection, loudly, and latch', () => {
  const f = fixture({ addons: [mapsLine(11467), mapsLine(3773, '/srv/node-red/node_modules/sqlite3/build/Release/node_sqlite3.node')] });
  f.state.check();
  f.state.recordDriver('node_red');
  assert.throws(() => f.state.beforeOpen('node_red'), { code: 'OSI_SQLITE_REFUSED', message: /sqlite_module_conflict/ });
  f.setAddons([mapsLine(11467)]);
  assert.throws(() => f.state.beforeOpen('node_red'), { code: 'OSI_SQLITE_REFUSED' });
  const health = f.state.getHealth();
  assert.equal(health.module_conflict, true);
  assert.equal(health.health_state, 'sqlite_module_conflict');
  assert.equal(f.logs.filter((l) => /found 2 native SQLite addons/.test(l)).length, 1);
});

test('a second addon loaded later is seen at the next open and at the next health read', () => {
  const f = fixture({ addons: [mapsLine(11467)] });
  f.state.check();
  f.state.recordDriver('node_red');
  f.state.beforeOpen('node_red');
  f.setAddons([mapsLine(11467), mapsLine(3773, '/other/node_sqlite3.node (deleted)')]);
  assert.equal(f.state.getHealth().health_state, 'sqlite_module_conflict');
  assert.throws(() => f.state.beforeOpen('node_red'), { code: 'OSI_SQLITE_REFUSED' });
});

test('a driver failure refuses and reports without a module path', () => {
  const f = fixture();
  f.state.driverFailed(new Error("Cannot find module 'sqlite3'\nRequire stack:\n- /usr/lib/node/node-red/node_modules/x.js"));
  assert.throws(() => f.state.beforeOpen('node_red'), { code: 'OSI_SQLITE_REFUSED', message: /sqlite_driver_unavailable/ });
  const health = f.state.getHealth();
  assert.equal(health.health_state, 'sqlite_driver_unavailable');
  assert.equal(health.driver_error, "Cannot find module 'sqlite3'");
  assert.equal(f.logs.length, 1);
});

test('standalone processes neither run the start-up check nor count addons', () => {
  const f = fixture({ addons: [mapsLine(1), mapsLine(2, '/b/node_sqlite3.node')] });
  f.state.recordDriver('standalone');
  assert.doesNotThrow(() => f.state.beforeOpen('standalone'));
  assert.equal(f.calls.length, 0);
});

test('every unhealthy result is reported, none of them as healthy, and nothing is changed', () => {
  const cases = [
    // A file damaged by the overlapping round, verbatim from the two gateway builds:
    // our images' sqlite3 3.46.1 and the stock base's opkg sqlite3 3.53.1.
    [{ status: 11, stdout: '', stderr: 'Error: stepping, database disk image is malformed (11)\n' }, 'damaged', 'database_damaged'],
    [{ status: 1, stdout: '', stderr: 'Error in 3rd command line argument: database disk image is malformed\n' }, 'damaged', 'database_damaged'],
    [{ status: 1, stdout: 'Error in 3rd command line argument: database disk image is malformed\n', stderr: '' }, 'damaged', 'database_damaged'],
    [{ status: 1, stdout: '', stderr: 'Error: no such table: sqlite_master\n' }, 'not_checked', 'database_not_checked'],
    [{ status: 0, stdout: '*** in database main ***\nPage 4: btreeInitPage() returns error code 11\ncore_tables=3\n', stderr: '' }, 'damaged', 'database_damaged'],
    [{ status: 26, stdout: '', stderr: 'Error: file is not a database (26)\n' }, 'damaged', 'database_damaged'],
    [{ status: 0, stdout: 'ok\ncore_tables=0\n', stderr: '' }, 'missing_core_tables', 'database_missing_core_tables'],
    [{ status: 1, stdout: '', stderr: 'Error: unable to open database "/data/db/farming.db": unable to open database file\n' }, 'unreadable', 'database_unreadable'],
    [{ status: null, error: Object.assign(new Error('spawnSync sqlite3 ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }, 'not_checked_timeout', 'database_not_checked'],
    [{ status: null, error: Object.assign(new Error('spawnSync sqlite3 ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }, 'not_checked', 'database_not_checked'],
    [{ status: 5, stdout: '', stderr: 'Error: database is locked (5)\n' }, 'not_checked', 'database_not_checked'],
    [{ status: 0, stdout: '', stderr: '' }, 'not_checked', 'database_not_checked'],
  ];
  for (const [result, status, healthState] of cases) {
    const f = fixture({ result });
    const health = f.state.check();
    assert.equal(health.status, status, JSON.stringify(result));
    assert.equal(health.health_state, healthState, JSON.stringify(result));
    assert.match(f.logs.join('\n'), /reported only, no file was moved or repaired/);
    if (['damaged', 'missing_core_tables', 'unreadable'].includes(status)) assert.match(f.logs.join('\n'), /see docs\/operations\/damaged-farm-database\.md/);
    else assert.doesNotMatch(f.logs.join('\n'), /damaged-farm-database/);
    // Detection only: the helper still opens a damaged or unexamined file.
    assert.doesNotThrow(() => f.state.beforeOpen('node_red'));
  }
});

test('a missing file is not checked and says so; an unstattable one is unreadable', () => {
  const missing = fixture({ stat: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.equal(missing.state.check().health_state, 'database_missing');
  assert.equal(missing.calls.length, 0);
  const denied = fixture({ stat: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } });
  assert.equal(denied.state.check().health_state, 'database_unreadable');
});

test('the duration comes from the monotonic clock, not the wall clock', () => {
  const realNow = Date.now;
  Date.now = () => { throw new Error('wall clock read'); };
  try {
    const f = fixture({ clock: [1000.25, 1030.75] });
    assert.equal(f.state.check().check_ms, 31);
  } finally {
    Date.now = realNow;
  }
});

test('the bound keeps a restarted gateway inside deploy.sh\'s 30 s health wait', () => {
  assert.ok(CHECK_TIMEOUT_MS > 0 && CHECK_TIMEOUT_MS <= 10000);
  assert.equal(classify({ status: 0, stdout: 'ok\ncore_tables=3\n', stderr: '' }).status, 'healthy');
});

test('both helper copies share one process-wide state', () => {
  const key = Symbol.for('osi.farming-sqlite.startup');
  const first = require(path.join(HELPER, 'startup.js'));
  assert.equal(globalThis[key], first);
  assert.equal(typeof first.getHealth, 'function');
});

// Gather Edge Health (osi-health-helper.refreshGlobal) and the first heartbeat.
const HEALTH = path.resolve(HELPER, '../osi-health-helper/index.js');
function contextGlobal() {
  const values = new Map();
  return { values, get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}

test('a refusing start-up fault reaches edge_health synchronously, without a connection', () => {
  const { refreshGlobal } = require(HEALTH);
  const global = contextGlobal();
  let opened = 0;
  const osiDb = {
    startupHealth: () => ({ health_state: 'sqlite_module_conflict', module_conflict: true, driver_error: null }),
    Database: function Database() { opened++; },
  };
  const pending = refreshGlobal({ global, osiDb });
  // Before any await: the heartbeat built from the same tick reads this.
  const health = global.get('edge_health');
  assert.equal(health.health_state, 'sqlite_module_conflict');
  // Build Heartbeat replaces health_state when crash_count is null.
  assert.notEqual(health.crash_count, null);
  assert.ok(Number.isFinite(health.at));
  assert.equal(opened, 0);
  return pending;
});

test('a damaged file is published at once and kept after the regular gather', async () => {
  const { refreshGlobal } = require(HEALTH);
  const global = contextGlobal();
  let closed = 0;
  const osiDb = {
    startupHealth: () => ({ health_state: 'database_damaged', module_conflict: false, driver_error: null }),
    Database: function Database() {
      this.all = (sql, cb) => cb(new Error('SQLITE_CORRUPT: database disk image is malformed'));
      this.get = (sql, cb) => cb(new Error('SQLITE_CORRUPT: database disk image is malformed'));
      this.close = (cb) => { closed++; cb(); };
    },
  };
  const pending = refreshGlobal({ global, osiDb, options: { timeoutMs: 200, diskPath: __dirname } });
  assert.equal(global.get('edge_health').health_state, 'database_damaged');
  await pending;
  assert.equal(global.get('edge_health').health_state, 'database_damaged');
  assert.equal(closed, 1);
});

test('"not checked" never hides crash_looping or degraded; a fault replaces them', async () => {
  const { refreshGlobal } = require(HEALTH);
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-crash-'));
  const crashFilePath = path.join(dir, 'crash');
  fs.writeFileSync(crashFilePath, JSON.stringify({ count: 5, startedAt: Date.now() }));
  try {
    for (const [state, expected] of [['database_not_checked', 'crash_looping'], ['database_damaged', 'database_damaged']]) {
      const global = contextGlobal();
      const osiDb = { startupHealth: () => ({ health_state: state, module_conflict: false, driver_error: null }),
        Database: function Database() { this.all = (s, cb) => cb(new Error('x')); this.get = (s, cb) => cb(new Error('x')); this.close = (cb) => cb(); } };
      const pending = refreshGlobal({ global, osiDb, options: { crashFilePath, timeoutMs: 200, diskPath: __dirname } });
      assert.equal(global.get('edge_health').health_state, expected, state);
      await pending;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an open handle is refused once a second addon appears, re-read at most once a second', () => {
  let now = 0, maps = [mapsLine(11467)];
  const state = createStartupState({
    files: { readFileSync: () => maps.join('\n'), statSync: () => ({}) },
    spawnSync: () => ({ status: 0, stdout: 'ok\ncore_tables=3\n', stderr: '' }),
    monotonicNow: () => now, log: () => {},
  });
  state.check();
  state.recordDriver('node_red');
  state.beforeOpen('node_red');
  maps = [mapsLine(11467), mapsLine(3773, '/srv/node-red/node_modules/sqlite3/build/Release/node_sqlite3.node')];
  now = 500;
  assert.doesNotThrow(() => state.guard('node_red'), 'within a second the map is not read again');
  now = 1000;
  assert.throws(() => state.guard('node_red'), { code: 'OSI_SQLITE_REFUSED', message: /sqlite_module_conflict/ });
  now = 1100;
  assert.throws(() => state.guard('node_red'), { code: 'OSI_SQLITE_REFUSED' }, 'the refusal stays latched');
});

test('"not checked" keeps the gathered figures and a degraded state on every tick', async () => {
  const { refreshGlobal } = require(HEALTH);
  const global = contextGlobal();
  global.set('error_counts', { total: 3 });
  const rows = (sql) => /sqlite_master/.test(sql) ? [{ type: 'table', name: 'devices', sql: 'CREATE TABLE devices(x)' }] : [{ n: 2 }];
  const osiDb = {
    startupHealth: () => ({ health_state: 'database_not_checked', module_conflict: false, driver_error: null }),
    Database: function Database() { this.all = (sql, cb) => cb(null, rows(sql)); this.get = (sql, cb) => cb(null, rows(sql)[0]); this.close = (cb) => cb(); },
  };
  const options = { timeoutMs: 500, diskPath: __dirname, crashFilePath: path.join(__dirname, 'no-such-crash-file') };
  await refreshGlobal({ global, osiDb, options });
  const gathered = global.get('edge_health');
  assert.equal(gathered.health_state, 'degraded', 'degraded is not hidden by not checked');
  assert.notEqual(gathered.disk_free_pct, null);
  // The next tick publishes before its gather: the figures stay, so does degraded.
  const pending = refreshGlobal({ global, osiDb, options });
  const published = global.get('edge_health');
  assert.equal(published.health_state, 'degraded');
  assert.equal(published.disk_free_pct, gathered.disk_free_pct);
  assert.equal(published.rtc_present, gathered.rtc_present);
  await pending;
});

test('a database state survives a gather that times out (Build Heartbeat refills a null crash_count)', async () => {
  const { refreshGlobal } = require(HEALTH);
  const global = contextGlobal();
  const osiDb = { startupHealth: () => ({ health_state: 'database_damaged', module_conflict: false, driver_error: null }),
    Database: function Database() { this.all = () => {}; this.get = () => {}; this.close = (cb) => cb(); } };
  await refreshGlobal({ global, osiDb, options: { timeoutMs: 100, diskPath: __dirname, crashFilePath: path.join(__dirname, 'no-such-crash-file') } });
  const health = global.get('edge_health');
  assert.equal(health.health_state, 'database_damaged');
  assert.notEqual(health.crash_count, null);
});
