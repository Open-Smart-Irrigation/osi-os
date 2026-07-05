'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const {
  gatherEdgeHealth,
  structuralSignature
} = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper');

const PUBLIC_HEALTH_KEYS = [
  'schema_sig',
  'sync_linked',
  'sync_pending',
  'sync_oldest_age_s',
  'sync_rejected',
  'sync_dirty_pending',
  'disk_free_pct'
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
