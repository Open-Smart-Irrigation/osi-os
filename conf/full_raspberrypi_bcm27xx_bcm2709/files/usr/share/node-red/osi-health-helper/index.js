'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const childProcess = require('node:child_process');

// Crash-loop escalation (refactor-program item 1.A4).
//
// procd respawns Node-RED indefinitely (`respawn 3600 5 -1`), so a crash-looping
// gateway still emits heartbeats between crashes and looks alive. This tracks a
// persistent local counter of "did Node-RED just (re)start soon after its last
// start" across process restarts, so the counter survives the very crashes it is
// counting. State lives in a plain JSON file (BusyBox ash has no better option).
const DEFAULT_CRASH_FILE_PATH = '/data/node-red-crash-count';
const CRASH_WINDOW_SECONDS = 300;
const CRASH_LOOP_THRESHOLD = 3;

function allNullHealth() {
  return {
    schema_sig: null,
    sync_linked: null,
    sync_pending: null,
    sync_oldest_age_s: null,
    sync_rejected: null,
    sync_dirty_pending: null,
    disk_free_pct: null,
    crash_count: null,
    crash_looping: null,
    health_state: null,
    rtc_present: null,
    clock_source: null
  };
}

function crashFilePath(options) {
  return (options && options.crashFilePath) || DEFAULT_CRASH_FILE_PATH;
}

function crashWindowMs(options) {
  const seconds = Number(options && options.crashWindowSeconds);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : CRASH_WINDOW_SECONDS) * 1000;
}

function crashLoopThreshold(options) {
  const value = Number(options && options.crashLoopThreshold);
  return Number.isFinite(value) && value > 0 ? value : CRASH_LOOP_THRESHOLD;
}

// Reads the crash-count file. Never throws: a missing file, unreadable file, or
// corrupt JSON payload is treated identically to "no crash history yet" so a
// damaged file cannot itself brick health reporting or startup registration.
function readCrashFile(options) {
  const filePath = crashFilePath(options);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const count = Number(parsed && parsed.count);
    const lastCrashAt = Number(parsed && parsed.lastCrashAt);
    const startedAt = Number(parsed && parsed.startedAt);
    return {
      count: Number.isFinite(count) && count >= 0 ? count : 0,
      lastCrashAt: Number.isFinite(lastCrashAt) ? lastCrashAt : null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null
    };
  } catch (_) {
    return { count: 0, lastCrashAt: null, startedAt: null };
  }
}

function writeCrashFile(options, state) {
  const target = crashFilePath(options);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, target);
}

// Read-only view of the current crash state; safe to call on every health
// gather (does not mutate the file or count this call as a startup).
function readCrashState(options) {
  const state = readCrashFile(options);
  const overThreshold = state.count >= crashLoopThreshold(options);
  const stableMs = state.startedAt !== null ? Date.now() - state.startedAt : 0;
  const looping = overThreshold && stableMs >= 0 && stableMs < crashWindowMs(options);
  return {
    crash_count: state.count,
    crash_looping: looping
  };
}

// Call once per Node-RED process startup. If the previous recorded start
// happened within CRASH_WINDOW_SECONDS, this start is treated as another
// crash-loop respawn and the counter increments; otherwise the counter resets
// to 0 (a fresh, healthy start). Always writes the file back with the new
// state so the next startup has something to compare against.
function registerStartup(options) {
  const existing = readCrashFile(options);
  const now = Date.now();
  const delta = now - existing.lastCrashAt;
  const withinWindow = existing.lastCrashAt !== null && delta >= 0 && delta < crashWindowMs(options);
  const count = withinWindow ? existing.count + 1 : 0;

  try {
    writeCrashFile(options, { count, lastCrashAt: now, startedAt: now });
  } catch (_) {}

  return {
    crash_count: count,
    crash_looping: count >= crashLoopThreshold(options)
  };
}

function quoteIdentifier(identifier) {
  return '"' + String(identifier).replace(/"/g, '""') + '"';
}

async function queryAll(db, sql) {
  if (!db || typeof db.all !== 'function') throw new Error('database facade missing all()');
  return await db.all(sql);
}

async function queryGet(db, sql) {
  if (db && typeof db.get === 'function') return await db.get(sql);
  const rows = await queryAll(db, sql);
  return rows && rows[0];
}

function toCount(row) {
  return Number(row && row.c != null ? row.c : 0);
}

function compareByCodepoint(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

async function structuralSignature(db) {
  const tables = await queryAll(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const projectedTables = [];

  for (const table of tables) {
    const tableName = table.name;
    const columns = (await queryAll(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`))
      .sort((left, right) => Number(left.cid) - Number(right.cid))
      .map((column) => ({
        name: column.name,
        type: column.type,
        notnull: Number(column.notnull),
        dflt_value: column.dflt_value == null ? null : String(column.dflt_value),
        pk: Number(column.pk)
      }));

    const indexRows = (await queryAll(db, `PRAGMA index_list(${quoteIdentifier(tableName)})`))
      .slice()
      .sort((left, right) => compareByCodepoint(left.name, right.name));
    const indexes = [];
    for (const index of indexRows) {
      const indexName = index.name;
      const indexColumns = (await queryAll(db, `PRAGMA index_info(${quoteIdentifier(indexName)})`))
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => ({
          seqno: Number(column.seqno),
          name: column.name
        }));
      indexes.push({
        name: indexName,
        unique: Number(index.unique),
        partial: Number(index.partial || 0),
        columns: indexColumns
      });
    }

    projectedTables.push({ name: tableName, columns, indexes });
  }

  const triggers = (await queryAll(
    db,
    "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
  )).map((trigger) => ({
    name: trigger.name
  }));

  const input = JSON.stringify({ version: 1, tables: projectedTables, triggers });
  return crypto.createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex').slice(0, 16);
}

function roundedFreePct(available, total) {
  const free = Number(available);
  const blocks = Number(total);
  if (!Number.isFinite(free) || !Number.isFinite(blocks) || blocks <= 0) {
    throw new Error('invalid disk free values');
  }
  return Math.max(0, Math.min(100, Math.round((free / blocks) * 100)));
}

function boundedTimeoutMs(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 4000;
}

function dfDiskFreePct(diskPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'df',
      ['-kP', diskPath],
      { encoding: 'utf8', timeout: boundedTimeoutMs(timeoutMs), maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
          if (lines.length < 2) throw new Error('df output missing data row');
          const columns = lines[1].trim().split(/\s+/);
          const total = Number(columns[1]);
          const available = Number(columns[3]);
          resolve(roundedFreePct(available, total));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

async function diskFreePct(diskPath, timeoutMs) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(diskPath);
      return roundedFreePct(stats.bavail, stats.blocks);
    }
  } catch (_) {}

  return await dfDiskFreePct(diskPath, timeoutMs);
}

function rtcHealth({ rtcSysfsPath = '/sys/class/rtc/rtc0', hwclockRunner } = {}) {
  try {
    if (rtcSysfsPath && fs.existsSync(rtcSysfsPath)) {
      return { rtc_present: true, clock_source: 'rtc' };
    }
    if (typeof hwclockRunner === 'function') {
      try { hwclockRunner(); return { rtc_present: true, clock_source: 'rtc' }; }
      catch (_) { return { rtc_present: false, clock_source: null }; }
    }
    if (rtcSysfsPath) return { rtc_present: false, clock_source: null };
    return { rtc_present: null, clock_source: null };
  } catch (_) {
    return { rtc_present: null, clock_source: null };
  }
}

async function gatherWork(db, diskPath, timeoutMs, options) {
  const health = allNullHealth();

  try {
    health.schema_sig = await structuralSignature(db);
  } catch (_) {}

  try {
    const row = await queryGet(db, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'");
    health.sync_linked = !!(row && row.linked);
  } catch (_) {}

  try {
    health.sync_pending = toCount(await queryGet(
      db,
      'SELECT COUNT(*) c FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL'
    ));
  } catch (_) {}

  try {
    health.sync_rejected = toCount(await queryGet(
      db,
      'SELECT COUNT(*) c FROM sync_outbox WHERE rejected_at IS NOT NULL'
    ));
  } catch (_) {}

  try {
    health.sync_dirty_pending = toCount(await queryGet(
      db,
      "SELECT COUNT(*) c FROM sync_history_dirty_keys WHERE status='pending'"
    ));
  } catch (_) {}

  try {
    const row = await queryGet(
      db,
      "SELECT COUNT(*) c, CAST((julianday('now') - julianday(MIN(occurred_at))) * 86400 AS INTEGER) s " +
        'FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL'
    );
    const pending = toCount(row);
    const rawOldest = row ? row.s : 0;
    health.sync_oldest_age_s = pending > 0 && (rawOldest === null || rawOldest === undefined)
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, Number(rawOldest || 0));
  } catch (_) {}

  try {
    health.disk_free_pct = await diskFreePct(diskPath, timeoutMs);
  } catch (_) {}

  try {
    const crashState = readCrashState(options);
    health.crash_count = crashState.crash_count;
    health.crash_looping = crashState.crash_looping;
  } catch (_) {}

  try {
    const rtc = rtcHealth({});
    health.rtc_present = rtc.rtc_present;
    health.clock_source = rtc.clock_source;
  } catch (_) {}

  try {
    const errorCount = Number(options && options.errorCount);
    const hasErrors = Number.isFinite(errorCount) && errorCount > 0;
    const syncRejected = Number(health.sync_rejected);
    const hasRejected = Number.isFinite(syncRejected) && syncRejected > 0;
    health.health_state = health.crash_looping
      ? 'crash_looping'
      : (hasErrors || hasRejected ? 'degraded' : 'healthy');
  } catch (_) {}

  return health;
}

function gatherEdgeHealth(db, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 4000;
  const diskPath = options.diskPath || '/data';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(allNullHealth()), timeoutMs);

    Promise.resolve()
      .then(() => gatherWork(db, diskPath, timeoutMs, options))
      .then(
        (health) => {
          clearTimeout(timer);
          finish(health);
        },
        () => {
          clearTimeout(timer);
          finish(allNullHealth());
        }
      );
  });
}

module.exports = {
  structuralSignature,
  gatherEdgeHealth,
  compareByCodepoint,
  registerStartup,
  readCrashState,
  rtcHealth
};
