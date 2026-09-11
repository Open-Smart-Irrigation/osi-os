'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const osiDb = require('osi-db-helper');

const DEFAULT_BUDGET = 512 * 1024 * 1024;
const DEFAULT_FREE_FLOOR = 32 * 1024 * 1024;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shared = new Map();
const now = () => new Date().toISOString();
function fileExists(file, fsApi) { return fsApi.existsSync(file); }
function spaceInfo(file, fsApi) {
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) { try { bytes += fsApi.statSync(file + suffix).size; } catch (error) { if (!suffix || error.code !== 'ENOENT') throw new Error(`filesystem size inspection failed: ${error.message}`); } }
  if (typeof fsApi.statfsSync !== 'function') throw new Error('filesystem free-space inspection unavailable');
  let free;
  try { const s = fsApi.statfsSync(path.dirname(file)); free = Number(s.bavail) * Number(s.bsize); if (!Number.isFinite(free)) throw new Error('invalid filesystem free-space result'); } catch (error) { throw new Error(`filesystem free-space inspection failed: ${error.message}`); }
  return { bytes, free };
}
function createRadioStore(options = {}) {
  const installation = String(options.installationUuid || '').trim().toLowerCase();
  const gateway = String(options.gatewayEui || '').trim().toUpperCase();
  if (!UUID4.test(installation)) throw new Error('installation UUID required');
  if (!/^[0-9A-F]{16}$/.test(gateway)) throw new Error('gateway EUI required');
  const farming = options.farmingDb;
  if (!farming) throw new Error('farming DB marker connection required');
  const dbPath = options.dbPath || '/data/db/radio.db', fsApi = options.fs || fs;
  // osi-db-helper opens/creates its file in the constructor. Capture the
  // pre-open fact so a missing store can be initialized, while an existing
  // unmarked file remains fail-closed.
  let closed = false;
  let db, closePromise;
  let pendingCaptures = 0;
  let ready;
  async function initialize() {
    if (closed) throw new Error('radio store is closed');
    if (ready) return ready;
    ready = (async () => {
      const installationRow = await farming.get('SELECT installation_uuid, recovery_state FROM installation_identity WHERE singleton_id=1');
      if (installationRow && (installationRow.installation_uuid !== installation || installationRow.recovery_state !== 'ACTIVE')) throw new Error('installation recovery required');
      if (!installationRow) throw new Error('active installation identity missing');
      let marker = await farming.get('SELECT radio_store_uuid, installation_uuid, state FROM radio_store_identity WHERE singleton_id=1');
      const exists = fileExists(dbPath, fsApi);
      if (!exists && ['-wal','-shm','-journal'].some(suffix => fileExists(dbPath + suffix, fsApi))) throw new Error('orphaned radio sidecars; recovery required');
      if (marker && (marker.installation_uuid !== installation || marker.state !== 'ACTIVE')) throw new Error('radio store recovery required');
      if (exists && !marker) throw new Error('radio store identity marker missing; recovery required');
      if (!exists && marker) throw new Error('radio store file missing; recovery required');
      if (options.enabled === false) throw Object.assign(new Error('radio capture disabled'), { code: 'RADIO_CAPTURE_DISABLED' });
      if (!exists && !marker) {
        const uuid = crypto.randomUUID();
        await farming.transaction(async tx => { await tx.run("INSERT INTO radio_store_identity(singleton_id,radio_store_uuid,installation_uuid,state,created_at,updated_at) VALUES(1,?,?, 'CREATING',?,?)", [uuid, installation, now(), now()]); });
        marker = { radio_store_uuid: uuid, installation_uuid: installation, state: 'CREATING' };
      }
      db = osiDb.open(dbPath, options.dbFactory ? { dbFactory: options.dbFactory } : undefined);
      if (exists) {
        const stored = await db.get('SELECT radio_store_uuid,installation_uuid,state FROM radio_store_identity WHERE singleton_id=1');
        if (!stored || stored.radio_store_uuid !== marker.radio_store_uuid || stored.installation_uuid !== installation || stored.state !== 'ACTIVE') throw new Error('radio store identity mismatch');
        const ledger = await db.all('SELECT version FROM radio_store_schema_ledger ORDER BY version');
        const shipped = fsApi.readdirSync(path.join(__dirname,'migrations')).filter(name => /^\d{4}__.*\.sql$/.test(name)).map(name => Number(name.slice(0,4))).sort((a,b)=>a-b);
        if (!ledger.length || ledger.some((row,index) => row.version !== shipped[index])) throw new Error('radio schema ledger missing, noncontiguous, or newer than runtime');
      }
      await db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
      await db.transaction(async tx => {
        const files = fsApi.readdirSync(path.join(__dirname, 'migrations')).filter(name => /^\d{4}__.*\.sql$/.test(name)).sort();
        for (const name of files) { const raw = fsApi.readFileSync(path.join(__dirname, 'migrations', name)); const checksum = crypto.createHash('sha256').update(raw).digest('hex'); const version = Number(name.slice(0, 4)); const ledgerExists = await tx.get("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='radio_store_schema_ledger'"); const applied = ledgerExists ? await tx.get('SELECT checksum FROM radio_store_schema_ledger WHERE version=?', [version]) : null; if (applied && applied.checksum !== checksum) throw new Error(`radio schema checksum mismatch: ${name}`); if (!applied) { await tx.exec(raw.toString('utf8')); await tx.run('INSERT INTO radio_store_schema_ledger(version,name,checksum,applied_at) VALUES(?,?,?,?)', [version, name, checksum, now()]); } }
        await tx.run("INSERT OR IGNORE INTO radio_store_identity(singleton_id,radio_store_uuid,installation_uuid,state,created_at,updated_at) VALUES(1,?,?, 'ACTIVE',?,?)", [marker.radio_store_uuid, installation, now(), now()]);
      });
      const radioMarker = await db.get('SELECT radio_store_uuid, installation_uuid, state FROM radio_store_identity WHERE singleton_id=1');
      if (!radioMarker || radioMarker.radio_store_uuid !== marker.radio_store_uuid || radioMarker.installation_uuid !== installation || radioMarker.state !== 'ACTIVE') throw new Error('radio store identity mismatch');
      if (marker.state === 'CREATING') await farming.transaction(async tx => { await tx.run("UPDATE radio_store_identity SET state='ACTIVE',updated_at=? WHERE singleton_id=1 AND radio_store_uuid=?", [now(), marker.radio_store_uuid]); });
    })().catch(async error => {
      if (db) { const closing = db; db = null; try { await closing.close(); } catch (closeError) { error.closeError = closeError; error.message += '; close failed: ' + closeError.message; } }
      ready = null; throw error;
    });
    return ready;
  }
  function budget() { const info = spaceInfo(dbPath, fsApi), max = options.budgetBytes == null ? DEFAULT_BUDGET : options.budgetBytes, floor = options.freeSpaceFloorBytes == null ? DEFAULT_FREE_FLOOR : options.freeSpaceFloorBytes; return info.bytes >= max || info.free < floor ? info : null; }
  async function capture(row) {
    const maxPending = options.maxPendingCaptures == null ? 256 : options.maxPendingCaptures;
    if (pendingCaptures >= maxPending) { const error = new Error('radio capture queue full'); error.code = 'RADIO_CAPTURE_QUEUE_FULL'; throw error; }
    pendingCaptures += 1;
    try {
    await initialize();
    let paused; try { paused = budget(); } catch (error) { error.code = 'RADIO_STORAGE_BUDGET_INSPECTION'; throw error; }
    if (paused) { const error = new Error('radio capture paused: storage budget'); error.code = 'RADIO_STORAGE_BUDGET'; throw error; }
    return await db.transaction(async tx => {
      const existing = await tx.get('SELECT * FROM radio_uplinks WHERE installation_uuid=? AND deduplication_id=?', [installation, row.deduplication_id]);
      if (existing) {
        if (existing.deveui !== row.deveui || existing.recorded_at !== row.recorded_at) throw new Error('deduplication id conflicts with device or timestamp');
        const before = JSON.parse(existing.metadata_json), incoming = JSON.parse(row.metadata_json), merged = new Map();
        for (const r of [...(before.receivers || []), ...(incoming.receivers || [])]) { const key = r.gateway_id + '|' + (r.uplink_id_num == null ? 'null' : r.uplink_id_num); if (merged.has(key) && JSON.stringify(merged.get(key)) !== JSON.stringify(r)) throw new Error('conflicting receiver metadata'); merged.set(key, r); }
        const receivers = [...merged.values()].sort((a, b) => a.gateway_id.localeCompare(b.gateway_id) || (a.uplink_id_num == null ? -1 : b.uplink_id_num == null ? 1 : a.uplink_id_num - b.uplink_id_num));
        if (receivers.length > 64 || Buffer.byteLength(JSON.stringify(Object.assign({}, before, { receivers }))) > 64 * 1024) throw new Error('merged radio metadata exceeds limit');
        if (receivers.length === (before.receivers || []).length) return existing.id;
        const metadata = Object.assign({}, before, { receivers }), generation = existing.dirty_generation + 1, changed = now(), key = `RADIO_UPLINK|${gateway}|${existing.id}`;
        await tx.run('UPDATE radio_uplinks SET metadata_json=?, dirty_generation=? WHERE id=?', [JSON.stringify(metadata), generation, existing.id]);
        await tx.run("INSERT INTO radio_history_dirty(history_key,generation,source_row_id,changed_at,status) VALUES(?,?,?,?,'pending') ON CONFLICT(history_key) DO UPDATE SET generation=excluded.generation,source_row_id=excluded.source_row_id,changed_at=excluded.changed_at,status='pending'", [key, generation, existing.id, changed]);
        return existing.id;
      }
      await tx.run('INSERT INTO radio_uplinks(installation_uuid,deveui,recorded_at,deduplication_id,metadata_json,dirty_generation) VALUES(?,?,?,?,?,1)', [installation, row.deveui, row.recorded_at, row.deduplication_id, row.metadata_json]);
      const id = (await tx.get('SELECT last_insert_rowid() AS id')).id, key = `RADIO_UPLINK|${gateway}|${id}`;
      await tx.run("INSERT INTO radio_history_dirty(history_key,generation,source_row_id,changed_at,status) VALUES(?,?,?,?,'pending')", [key, 1, id, now()]);
      return id;
    });
    } finally { pendingCaptures -= 1; }
  }
  return { capture, all: async (sql, params) => { await initialize(); return db.all(sql, params); }, async bridgeDirty(target) {
    await initialize(); const rows = await db.all("SELECT * FROM radio_history_dirty WHERE status='pending' ORDER BY changed_at, history_key LIMIT 100");
    for (const dirty of rows) {
      await target.transaction(async tx => {
        await tx.run("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,source_row_id,changed_at,status) VALUES('cloud','radio_uplinks',?,?,?,?,'pending') ON CONFLICT(peer_node,table_name,row_key) DO UPDATE SET change_kind=excluded.change_kind,source_row_id=excluded.source_row_id,changed_at=excluded.changed_at,status='pending'", [dirty.history_key, dirty.change_kind, dirty.source_row_id, dirty.changed_at]);
        await tx.run("INSERT INTO radio_history_bridge(history_key,generation,status,transferred_at) VALUES(?,?, 'transferred',?) ON CONFLICT(history_key) DO UPDATE SET generation=CASE WHEN excluded.generation > radio_history_bridge.generation THEN excluded.generation ELSE radio_history_bridge.generation END,status='transferred',transferred_at=excluded.transferred_at", [dirty.history_key, dirty.generation, now()]);
      });
      await db.run("UPDATE radio_history_dirty SET status='transferred' WHERE history_key=? AND generation=?", [dirty.history_key, dirty.generation]);
    }
    return rows.length;
  }, async status() { await initialize(); const info = await db.get('SELECT COUNT(*) AS rows, COALESCE(SUM(length(metadata_json)),0) AS bytes FROM radio_uplinks'); return Object.assign(info, { paused: Boolean(budget()), enabled: options.enabled !== false }); }, close: () => { closed = true; if (closePromise) return closePromise; if (!db) return Promise.resolve(); const closing = db; closePromise = closing.close().then(() => { db = null; }); return closePromise; } };
}
function getSharedStore(options = {}) { const key = `${options.dbPath || '/data/db/radio.db'}|${String(options.installationUuid).toLowerCase()}|${String(options.gatewayEui).toUpperCase()}`; if (!shared.has(key)) shared.set(key, createRadioStore(options)); return shared.get(key); }
module.exports = { createRadioStore, getSharedStore };
