#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const replication = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication'
));

function facade(database) {
  const db = {
    get(sql, params = []) { return Promise.resolve(database.prepare(sql).get(...params)); },
    all(sql, params = []) { return Promise.resolve(database.prepare(sql).all(...params)); },
    run(sql, params = []) { return Promise.resolve(database.prepare(sql).run(...params)); },
  };
  db.transaction = async function transaction(callback) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(db);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-v2-media-'));
  const database = new DatabaseSync(':memory:');
  database.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, database, db: facade(database) };
}

function insertMedia(database, fields) {
  const now = '2026-08-08T10:11:12.123Z';
  database.prepare(
    'INSERT INTO journal_media_files(' +
      'media_uuid,workspace_uuid,parent_mutation_uuid,parent_revision_uuid,local_path,sha256,size_bytes,' +
      'received_bytes,replica_status,cloud_replica_status,cloud_verified_sha256,pinned,conflict_bound,' +
      'last_accessed_at,created_at,updated_at' +
    ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    fields.media_uuid, '20000000-0000-4000-8000-000000000001',
    fields.parent_mutation_uuid || null, fields.parent_revision_uuid || null,
    fields.local_path, fields.sha256, fields.size_bytes, fields.received_bytes,
    fields.replica_status, fields.cloud_replica_status || null,
    fields.cloud_verified_sha256 || null, fields.pinned ? 1 : 0,
    fields.conflict_bound ? 1 : 0, fields.last_accessed_at || now, now, now
  );
}

test('partial download remains hidden and requires full SHA-256 before atomic publish', async (t) => {
  const { directory, database, db } = fixture(t);
  const complete = Buffer.from('complete-photo');
  const expected = crypto.createHash('sha256').update(complete).digest('hex');
  const partial = path.join(directory, '.download.part');
  const finalPath = path.join(directory, 'photo.bin');
  fs.writeFileSync(partial, complete.subarray(0, 4));
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000001', local_path: finalPath,
    sha256: expected, size_bytes: complete.length, received_bytes: 4, replica_status: 'downloading',
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000001',
  });

  assert.equal(fs.existsSync(finalPath), false);
  await assert.rejects(
    () => replication.publishDownloadedMedia(db, fs, {
      media_uuid: 'd0000000-0000-4000-8000-000000000001', partial_path: partial,
    }),
    /received bytes|size/i
  );
  fs.writeFileSync(partial, Buffer.alloc(complete.length, 0x78));
  database.prepare('UPDATE journal_media_files SET received_bytes=? WHERE media_uuid=?')
    .run(complete.length, 'd0000000-0000-4000-8000-000000000001');
  await assert.rejects(
    () => replication.publishDownloadedMedia(db, fs, {
      media_uuid: 'd0000000-0000-4000-8000-000000000001', partial_path: partial,
    }),
    /sha-256/i
  );
  assert.equal(fs.existsSync(finalPath), false);

  fs.writeFileSync(partial, complete);
  await replication.publishDownloadedMedia(db, fs, {
    media_uuid: 'd0000000-0000-4000-8000-000000000001', partial_path: partial,
  });
  assert.deepEqual(fs.readFileSync(finalPath), complete);
  assert.equal(database.prepare('SELECT replica_status FROM journal_media_files').get().replica_status,
    'verified');
});

test('verified media publish recovers after rename succeeds but database update rolls back', async (t) => {
  const { directory, database, db } = fixture(t);
  const complete = Buffer.from('recoverable-photo');
  const expected = crypto.createHash('sha256').update(complete).digest('hex');
  const partial = path.join(directory, '.recover.part');
  const finalPath = path.join(directory, 'recover.jpg');
  fs.writeFileSync(partial, complete);
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000055', local_path: finalPath,
    sha256: expected, size_bytes: complete.length, received_bytes: complete.length,
    replica_status: 'downloading',
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000055',
  });
  const failingDb = Object.assign({}, db, {
    transaction(callback) {
      return db.transaction(function(tx) {
        const failingTx = Object.assign({}, tx, {
          run(sql, params) {
            if (sql.includes("SET replica_status='verified'")) {
              return Promise.reject(new Error('injected publish update failure'));
            }
            return tx.run(sql, params);
          },
        });
        return callback(failingTx);
      });
    },
  });

  await assert.rejects(
    () => replication.publishDownloadedMedia(failingDb, fs, {
      media_uuid: 'd0000000-0000-4000-8000-000000000055', partial_path: partial,
    }),
    /injected publish update failure/
  );
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(database.prepare('SELECT replica_status FROM journal_media_files').get().replica_status,
    'downloading');

  await replication.publishDownloadedMedia(db, fs, {
    media_uuid: 'd0000000-0000-4000-8000-000000000055', partial_path: partial,
  });
  assert.equal(database.prepare('SELECT replica_status FROM journal_media_files').get().replica_status,
    'verified');
});

test('cache eviction only removes unpinned verified-cloud bytes with no pending or conflict parent', async (t) => {
  const { directory, database, db } = fixture(t);
  const rows = [
    ['eligible', 'verified', 'verified', false, false, null],
    ['unverified', 'verified', 'uploading', false, false, null],
    ['pending', 'local_only', 'verified', false, false, '10000000-0000-4000-8000-000000000001'],
    ['conflict', 'verified', 'verified', false, true, null],
    ['pinned', 'verified', 'verified', true, false, null],
  ];
  for (let index = 0; index < rows.length; index += 1) {
    const [name, local, cloud, pinned, conflicted, parentMutation] = rows[index];
    const localPath = path.join(directory, name + '.jpg');
    const content = Buffer.from(name.padEnd(16, '!'));
    fs.writeFileSync(localPath, content);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    insertMedia(database, {
      media_uuid: `d0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      local_path: localPath, sha256: digest, size_bytes: content.length,
      received_bytes: content.length, replica_status: local,
      cloud_replica_status: cloud, cloud_verified_sha256: cloud === 'verified' ? digest : null,
      pinned, conflict_bound: conflicted, parent_mutation_uuid: parentMutation,
      parent_revision_uuid: parentMutation ? null : 'b0000000-0000-4000-8000-000000000001',
    });
  }

  const result = await replication.enforcePhotoCache(db, fs, { max_bytes: 1, min_free_bytes: 0 });
  assert.deepEqual(result.evicted_media_uuids, ['d0000000-0000-4000-8000-000000000001']);
  assert.equal(fs.existsSync(path.join(directory, 'eligible.jpg')), false);
  for (const name of ['unverified', 'pending', 'conflict', 'pinned']) {
    assert.equal(fs.existsSync(path.join(directory, name + '.jpg')), true, name + ' retained');
  }
  assert.equal(database.prepare(
    "SELECT replica_status FROM journal_media_files WHERE media_uuid='d0000000-0000-4000-8000-000000000001'"
  ).get().replica_status, 'evicted_verified');
});

test('cache eviction rechecks the parent outcome inside its transaction', async (t) => {
  const { directory, database, db } = fixture(t);
  const mutationUuid = '10000000-0000-4000-8000-000000000099';
  const localPath = path.join(directory, 'racing-parent.jpg');
  const content = Buffer.from('racing-parent');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(localPath, content);
  database.prepare(
    'INSERT INTO journal_edge_mutations(' +
      'mutation_uuid,workspace_uuid,operation,resource_uuid,base_version,payload_json,payload_sha256,' +
      'status,result_revision_uuid,recorded_at,created_at,updated_at,completed_at' +
    ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    mutationUuid, '20000000-0000-4000-8000-000000000001', 'ENTRY_CREATE',
    '30000000-0000-4000-8000-000000000001', 0, '{}', 'a'.repeat(64), 'applied',
    'b0000000-0000-4000-8000-000000000099', '2026-08-08T10:11:12.123Z',
    '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z'
  );
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000099', local_path: localPath,
    sha256: digest, size_bytes: content.length, received_bytes: content.length,
    replica_status: 'verified', cloud_replica_status: 'verified',
    cloud_verified_sha256: digest, parent_mutation_uuid: mutationUuid,
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000099',
  });

  let raced = false;
  const racingDb = Object.assign({}, db, {
    async transaction(callback) {
      if (!raced) {
        raced = true;
        database.prepare("UPDATE journal_edge_mutations SET status='conflict' WHERE mutation_uuid=?")
          .run(mutationUuid);
      }
      return db.transaction(callback);
    },
  });
  const result = await replication.enforcePhotoCache(
    racingDb, fs, { max_bytes: 0, min_free_bytes: 0 }
  );
  assert.deepEqual(result.evicted_media_uuids, []);
  assert.equal(fs.existsSync(localPath), true);
});

test('cache eviction keeps local bytes when its durable status update rolls back', async (t) => {
  const { directory, database, db } = fixture(t);
  const localPath = path.join(directory, 'rollback.jpg');
  const content = Buffer.from('rollback-photo');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(localPath, content);
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000077', local_path: localPath,
    sha256: digest, size_bytes: content.length, received_bytes: content.length,
    replica_status: 'verified', cloud_replica_status: 'verified',
    cloud_verified_sha256: digest,
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000077',
  });
  const failingDb = Object.assign({}, db, {
    transaction(callback) {
      return db.transaction(function(tx) {
        const failingTx = Object.assign({}, tx, {
          run(sql, params) {
            if (sql.includes("SET replica_status='evicted_verified'")) {
              return Promise.reject(new Error('injected durable update failure'));
            }
            return tx.run(sql, params);
          },
        });
        return callback(failingTx);
      });
    },
  });

  await assert.rejects(
    () => replication.enforcePhotoCache(failingDb, fs, { max_bytes: 0, min_free_bytes: 0 }),
    /injected durable update failure/
  );
  assert.equal(fs.existsSync(localPath), true);
  assert.equal(database.prepare('SELECT replica_status FROM journal_media_files').get().replica_status,
    'verified');
});

test('cache eviction retries leftover bytes after a post-commit unlink failure', async (t) => {
  const { directory, database, db } = fixture(t);
  const localPath = path.join(directory, 'unlink-retry.jpg');
  const content = Buffer.from('unlink-retry-photo');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(localPath, content);
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000066', local_path: localPath,
    sha256: digest, size_bytes: content.length, received_bytes: content.length,
    replica_status: 'verified', cloud_replica_status: 'verified',
    cloud_verified_sha256: digest,
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000066',
  });
  const failingFs = Object.create(fs);
  failingFs.unlinkSync = function unlinkSync() {
    throw new Error('injected unlink failure');
  };

  await assert.rejects(
    () => replication.enforcePhotoCache(db, failingFs, { max_bytes: 0, min_free_bytes: 0 }),
    /injected unlink failure/
  );
  assert.equal(fs.existsSync(localPath), true);
  assert.equal(database.prepare('SELECT replica_status FROM journal_media_files').get().replica_status,
    'evicted_verified');

  database.prepare('UPDATE journal_media_files SET pinned=1').run();
  await replication.enforcePhotoCache(db, fs, { max_bytes: 0, min_free_bytes: 0 });
  assert.equal(fs.existsSync(localPath), true);
  database.prepare('UPDATE journal_media_files SET pinned=0').run();
  await replication.enforcePhotoCache(db, fs, { max_bytes: 0, min_free_bytes: 0 });
  assert.equal(fs.existsSync(localPath), false);
});

test('missing stale rows do not hide real bytes from cache accounting', async (t) => {
  const { directory, database, db } = fixture(t);
  const missingContent = Buffer.from('missing-photo');
  const missingDigest = crypto.createHash('sha256').update(missingContent).digest('hex');
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000040',
    local_path: path.join(directory, 'missing.jpg'), sha256: missingDigest,
    size_bytes: 1000, received_bytes: 1000, replica_status: 'verified',
    cloud_replica_status: 'verified', cloud_verified_sha256: missingDigest,
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000040',
    last_accessed_at: '2026-08-08T09:00:00.000Z',
  });
  const realPath = path.join(directory, 'real.jpg');
  const realContent = Buffer.from('real-photo');
  const realDigest = crypto.createHash('sha256').update(realContent).digest('hex');
  fs.writeFileSync(realPath, realContent);
  insertMedia(database, {
    media_uuid: 'd0000000-0000-4000-8000-000000000041', local_path: realPath,
    sha256: realDigest, size_bytes: realContent.length, received_bytes: realContent.length,
    replica_status: 'verified', cloud_replica_status: 'verified',
    cloud_verified_sha256: realDigest,
    parent_revision_uuid: 'b0000000-0000-4000-8000-000000000041',
    last_accessed_at: '2026-08-08T10:00:00.000Z',
  });

  await replication.enforcePhotoCache(db, fs, {
    max_bytes: 0, min_free_bytes: 0, cache_root: directory,
  });
  assert.equal(fs.existsSync(realPath), false);
});
