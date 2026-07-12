'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const HEALTH_HELPER_MODULE =
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper';
const HEALTH_HELPER_FILE = require.resolve(HEALTH_HELPER_MODULE);

function requireHealthHelperFresh() {
  delete require.cache[HEALTH_HELPER_FILE];
  return require(HEALTH_HELPER_MODULE);
}

const {
  gatherEdgeHealth,
  structuralSignature,
  compareByCodepoint
} = requireHealthHelperFresh();

const PUBLIC_HEALTH_KEYS = [
  'schema_sig',
  'sync_linked',
  'sync_pending',
  'sync_oldest_age_s',
  'sync_rejected',
  'sync_dirty_pending',
  'disk_free_pct',
  'crash_count',
  'crash_looping',
  'health_state',
  'rtc_present',
  'clock_source'
];

const ALL_NULL_HEALTH = Object.fromEntries(PUBLIC_HEALTH_KEYS.map((key) => [key, null]));

function assertPublicHealthShape(health) {
  assert.deepStrictEqual(Object.keys(health).sort(), PUBLIC_HEALTH_KEYS.slice().sort());
}

function assertDiskFreePct(value) {
  assert(Number.isInteger(value));
  assert(value >= 0);
  assert(value <= 100);
}

function makeFacadeShim() {
  const db = new DatabaseSync(':memory:');
  const call = (kind) => (sql, cb) => {
    try {
      let result;
      if (kind === 'run' || kind === 'exec') {
        db.exec(sql);
        result = undefined;
      } else if (kind === 'get') {
        result = db.prepare(sql).get();
      } else {
        result = db.prepare(sql).all();
      }
      if (typeof cb === 'function') {
        process.nextTick(() => cb(null, result));
        return undefined;
      }
      return Promise.resolve(result);
    } catch (error) {
      if (typeof cb === 'function') {
        process.nextTick(() => cb(error));
        return undefined;
      }
      return Promise.reject(error);
    }
  };
  const scope = { run: call('run'), all: call('all'), get: call('get'), exec: call('exec') };
  return Object.assign({}, scope, {
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await executor(scope);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch (_) {}
        throw error;
      }
    },
    close() {
      try {
        db.close();
      } catch (_) {}
    }
  });
}

function modernSchema(db) {
  return db.exec(`
    CREATE TABLE devices (
      deveui TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type_id TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX idx_devices_type_id ON devices(type_id);
    CREATE TABLE sync_link_state (
      peer_node TEXT PRIMARY KEY,
      linked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sync_outbox (
      event_uuid TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      delivered_at TEXT,
      rejected_at TEXT
    );
    CREATE INDEX idx_sync_outbox_pending
      ON sync_outbox(occurred_at)
      WHERE delivered_at IS NULL AND rejected_at IS NULL;
    CREATE TABLE sync_history_dirty_keys (
      peer_node TEXT,
      table_name TEXT,
      row_key TEXT,
      changed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY(peer_node, table_name, row_key)
    );
    CREATE TRIGGER trg_devices_updated_at
    AFTER UPDATE ON devices
    BEGIN
      UPDATE devices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE deveui = NEW.deveui;
    END;
    INSERT INTO devices(deveui, name, type_id, updated_at)
    VALUES ('0016C001F1000001', 'gateway', 'KIWI_SENSOR', '2026-07-05T00:00:00Z');
    INSERT INTO sync_link_state(peer_node, linked) VALUES ('cloud', 1);
  `);
}

function assertSyncFieldsNull(health) {
  assert.strictEqual(health.sync_linked, null);
  assert.strictEqual(health.sync_pending, null);
  assert.strictEqual(health.sync_oldest_age_s, null);
  assert.strictEqual(health.sync_rejected, null);
  assert.strictEqual(health.sync_dirty_pending, null);
}

test('modern schema reports schema, sync, and disk health', async () => {
  const db = makeFacadeShim();
  try {
    await modernSchema(db);
    await db.exec(`
      INSERT INTO sync_outbox(event_uuid, occurred_at, delivered_at, rejected_at)
      VALUES ('delivered', '2026-07-05T00:00:00Z', '2026-07-05T00:00:01Z', NULL);
    `);

    const health = await gatherEdgeHealth(db, { timeoutMs: 1000, diskPath: os.tmpdir() });

    assertPublicHealthShape(health);
    assert.match(health.schema_sig, /^[0-9a-f]{16}$/);
    assert.strictEqual(health.sync_linked, true);
    assert.strictEqual(health.sync_pending, 0);
    assert.strictEqual(health.sync_oldest_age_s, 0);
    assert.strictEqual(health.sync_rejected, 0);
    assert.strictEqual(health.sync_dirty_pending, 0);
    assertDiskFreePct(health.disk_free_pct);
  } finally {
    db.close();
  }
});

test('Uganda-shape schema resolves with null sync fields but keeps schema and disk metrics', async () => {
  const db = makeFacadeShim();
  try {
    await db.exec(`
      CREATE TABLE devices (
        deveui TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type_id TEXT NOT NULL
      );
      INSERT INTO devices(deveui, name, type_id)
      VALUES ('0016C001F1000001', 'legacy', 'KIWI_SENSOR');
    `);

    const health = await gatherEdgeHealth(db, { timeoutMs: 1000, diskPath: os.tmpdir() });

    assertPublicHealthShape(health);
    assert.match(health.schema_sig, /^[0-9a-f]{16}$/);
    assertDiskFreePct(health.disk_free_pct);
    assertSyncFieldsNull(health);
  } finally {
    db.close();
  }
});

test('sync_outbox missing rejected_at column degrades sync_pending to null', async () => {
  const db = makeFacadeShim();
  try {
    await db.exec(`
      CREATE TABLE devices (
        deveui TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type_id TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE sync_link_state (
        peer_node TEXT PRIMARY KEY,
        linked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sync_outbox (
        event_uuid TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        delivered_at TEXT
      );
      INSERT INTO devices(deveui, name, type_id, updated_at)
      VALUES ('0016C001F1000001', 'gateway', 'KIWI_SENSOR', '2026-07-05T00:00:00Z');
      INSERT INTO sync_link_state(peer_node, linked) VALUES ('cloud', 1);
    `);

    const health = await gatherEdgeHealth(db, { timeoutMs: 1000, diskPath: os.tmpdir() });

    assertPublicHealthShape(health);
    assert.strictEqual(health.sync_pending, null);
  } finally {
    db.close();
  }
});

test('sync backlog counters count pending, rejected, and dirty pending rows independently', async () => {
  const db = makeFacadeShim();
  try {
    await modernSchema(db);
    await db.exec(`
      INSERT INTO sync_outbox(event_uuid, occurred_at, delivered_at, rejected_at)
      VALUES
        ('delivered', '2026-07-05T00:00:00Z', '2026-07-05T00:00:01Z', NULL),
        ('pending-1', '2026-07-05T00:01:00Z', NULL, NULL),
        ('pending-2', '2026-07-05T00:02:00Z', NULL, NULL),
        ('rejected', '2026-07-05T00:03:00Z', NULL, '2026-07-05T00:03:01Z');
      INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, changed_at, status)
      VALUES
        ('cloud', 'device_data', 'pending-key', '2026-07-05T00:04:00Z', 'pending'),
        ('cloud', 'device_data', 'done-key', '2026-07-05T00:05:00Z', 'done');
    `);

    const health = await gatherEdgeHealth(db, { timeoutMs: 1000, diskPath: os.tmpdir() });

    assertPublicHealthShape(health);
    assert.strictEqual(health.sync_pending, 2);
    assert.strictEqual(health.sync_rejected, 1);
    assert.strictEqual(health.sync_dirty_pending, 1);
    assert(Number.isInteger(health.sync_oldest_age_s));
  } finally {
    db.close();
  }
});

test('structural schema signature is stable and changes after an added column', async () => {
  const db = makeFacadeShim();
  try {
    await modernSchema(db);

    const first = await structuralSignature(db);
    const second = await structuralSignature(db);
    await db.exec('ALTER TABLE devices ADD COLUMN firmware_version TEXT;');
    const afterAddColumn = await structuralSignature(db);

    assert.match(first, /^[0-9a-f]{16}$/);
    assert.strictEqual(second, first);
    assert.notStrictEqual(afterAddColumn, first);
  } finally {
    db.close();
  }
});

test('structural schema signature ignores trigger SQL formatting when trigger names match', async () => {
  const compact = makeFacadeShim();
  const formatted = makeFacadeShim();
  try {
    await compact.exec(`
      CREATE TABLE devices (
        deveui TEXT PRIMARY KEY,
        updated_at TEXT
      );
      CREATE TABLE trigger_audit (
        device_deveui TEXT NOT NULL
      );
      CREATE TRIGGER trg_devices_audit AFTER UPDATE ON devices BEGIN INSERT INTO trigger_audit(device_deveui) VALUES (NEW.deveui); END;
    `);
    await formatted.exec(`
      CREATE TABLE devices (
        deveui TEXT PRIMARY KEY,
        updated_at TEXT
      );
      CREATE TABLE trigger_audit (
        device_deveui TEXT NOT NULL
      );
      CREATE TRIGGER trg_devices_audit
      AFTER UPDATE ON devices
      BEGIN
        INSERT INTO trigger_audit(device_deveui)
        VALUES (NEW.deveui);
      END;
    `);

    const compactSignature = await structuralSignature(compact);
    const formattedSignature = await structuralSignature(formatted);

    assert.strictEqual(formattedSignature, compactSignature);
  } finally {
    compact.close();
    formatted.close();
  }
});

test('structural schema signature changes when trigger name changes', async () => {
  const first = makeFacadeShim();
  const renamed = makeFacadeShim();
  try {
    const schema = (triggerName) => `
      CREATE TABLE devices (
        deveui TEXT PRIMARY KEY,
        updated_at TEXT
      );
      CREATE TABLE trigger_audit (
        device_deveui TEXT NOT NULL
      );
      CREATE TRIGGER ${triggerName}
      AFTER UPDATE ON devices
      BEGIN
        INSERT INTO trigger_audit(device_deveui)
        VALUES (NEW.deveui);
      END;
    `;
    await first.exec(schema('trg_devices_audit'));
    await renamed.exec(schema('trg_devices_audit_renamed'));

    const firstSignature = await structuralSignature(first);
    const renamedSignature = await structuralSignature(renamed);

    assert.notStrictEqual(renamedSignature, firstSignature);
  } finally {
    first.close();
    renamed.close();
  }
});

test('index-name sort is codepoint-ordered, not locale-ordered', () => {
  // 'B' (0x42) precedes 'a' (0x61) by codepoint; every common locale sorts
  // them the other way (case-insensitive: a before B). This pins the sort to
  // codepoint order so the structural signature is identical across ICU builds.
  assert.deepStrictEqual(['a', 'B'].slice().sort(compareByCodepoint), ['B', 'a']);
  assert.deepStrictEqual(['idx_b', 'idx_A', 'idx_a'].slice().sort(compareByCodepoint), ['idx_A', 'idx_a', 'idx_b']);
});

test('hung database returns all-null health within timeout', async () => {
  const pending = new Promise(() => {});
  const hungDb = {
    all() { return pending; },
    get() { return pending; },
    run() { return pending; },
    exec() { return pending; }
  };

  const start = Date.now();
  const health = await gatherEdgeHealth(hungDb, { timeoutMs: 50, diskPath: os.tmpdir() });
  const elapsedMs = Date.now() - start;

  assert.deepStrictEqual(health, ALL_NULL_HEALTH);
  assert(elapsedMs < 500);
});

test('disk df fallback is async, bounded, and cannot outlive gather timeout', async (t) => {
  const diskPath = os.tmpdir();
  const originalStatfsSync = fs.statfsSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  let execFileCall = null;

  fs.statfsSync = () => {
    throw new Error('statfs unavailable');
  };
  childProcess.execFile = (...args) => {
    execFileCall = args;
    return { kill() {} };
  };
  childProcess.execFileSync = () => {
    throw new Error('execFileSync fallback must not be used');
  };

  t.after(() => {
    fs.statfsSync = originalStatfsSync;
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[HEALTH_HELPER_FILE];
  });

  const db = makeFacadeShim();
  try {
    await modernSchema(db);
    const { gatherEdgeHealth: gatherWithPatchedDependencies } = requireHealthHelperFresh();

    const start = Date.now();
    const health = await gatherWithPatchedDependencies(db, { timeoutMs: 50, diskPath });
    const elapsedMs = Date.now() - start;

    assert.deepStrictEqual(health, ALL_NULL_HEALTH);
    assert(elapsedMs < 500);
    assert(execFileCall, 'df fallback should use async execFile');
    assert.strictEqual(execFileCall[0], 'df');
    assert.deepStrictEqual(execFileCall[1], ['-kP', diskPath]);
    assert.strictEqual(typeof execFileCall[2].timeout, 'number');
    assert(execFileCall[2].timeout > 0);
    assert.strictEqual(typeof execFileCall[2].maxBuffer, 'number');
    assert(execFileCall[2].maxBuffer > 0);
  } finally {
    db.close();
  }
});

test('disk df fallback source does not use synchronous child process collection', () => {
  const source = fs.readFileSync(HEALTH_HELPER_FILE, 'utf8');

  assert.doesNotMatch(source, /\bexecFileSync\b/);
});

const { rtcHealth } = requireHealthHelperFresh();

test('rtcHealth reports present when since_epoch is readable and positive', () => {
  const dir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'rtc-'));
  const node = require('node:path').join(dir, 'rtc0');
  fs.mkdirSync(node);
  fs.writeFileSync(require('node:path').join(node, 'since_epoch'), '1700000000\n');
  const r = rtcHealth({ rtcSysfsPath: node });
  assert.strictEqual(r.rtc_present, true);
  assert.strictEqual(r.clock_source, 'rtc');
});

test('rtcHealth reports absent for an empty rtc0 directory (no since_epoch)', () => {
  const dir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'rtc-empty-'));
  const node = require('node:path').join(dir, 'rtc0');
  fs.mkdirSync(node);
  const r = rtcHealth({ rtcSysfsPath: node });
  assert.strictEqual(r.rtc_present, false);
  assert.strictEqual(r.clock_source, null);
});

test('rtcHealth reports absent when the sysfs rtc node does not exist', () => {
  const r = rtcHealth({ rtcSysfsPath: '/nonexistent/rtc0', hwclockRunner: () => { throw new Error('no hwclock'); } });
  assert.strictEqual(r.rtc_present, false);
});

test('rtcHealth is fail-soft: null path yields rtc_present null, never throws', () => {
  let r;
  assert.doesNotThrow(() => {
    r = rtcHealth({ rtcSysfsPath: null });
  });
  assert.strictEqual(r.rtc_present, null);
});

test('rtcHealth: injected hwclock probe succeeds => present', () => {
  const r = rtcHealth({ rtcSysfsPath: '/nonexistent/rtc0', hwclockRunner: () => 'ok' });
  assert.strictEqual(r.rtc_present, true);
});

test('gatherEdgeHealth includes rtc_present in its output shape', async () => {
  const db = makeFacadeShim();
  const health = await gatherEdgeHealth(db, { timeoutMs: 2000, diskPath: os.tmpdir() });
  assert.ok(Object.prototype.hasOwnProperty.call(health, 'rtc_present'));
});
