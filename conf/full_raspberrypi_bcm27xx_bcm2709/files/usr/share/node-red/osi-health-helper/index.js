'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const childProcess = require('node:child_process');

function allNullHealth() {
  return {
    schema_sig: null,
    sync_linked: null,
    sync_pending: null,
    sync_oldest_age_s: null,
    sync_rejected: null,
    sync_dirty_pending: null,
    disk_free_pct: null
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

async function gatherWork(db, diskPath, timeoutMs) {
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
      : Number(rawOldest || 0);
  } catch (_) {}

  try {
    health.disk_free_pct = await diskFreePct(diskPath, timeoutMs);
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
      .then(() => gatherWork(db, diskPath, timeoutMs))
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
  compareByCodepoint
};
