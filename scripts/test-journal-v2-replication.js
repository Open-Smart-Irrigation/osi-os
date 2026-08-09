#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication'
);
const replication = require(MODULE);
const canonicalizer = require(path.join(MODULE, 'canonicalization'));
const golden = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'), 'utf8'
));

function facade(database) {
  const db = {
    get(sql, params = []) { return Promise.resolve(database.prepare(sql).get(...params)); },
    all(sql, params = []) { return Promise.resolve(database.prepare(sql).all(...params)); },
    run(sql, params = []) { return Promise.resolve(database.prepare(sql).run(...params)); },
    exec(sql) { database.exec(sql); return Promise.resolve(); },
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

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  return { database, db: facade(database) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutation(operation) {
  return clone(golden.mutation_vectors.find((vector) => vector.input.operation === operation).input);
}

function envelope(kind) {
  return clone(golden.replication_vectors.find((vector) => vector.input.kind === kind).input);
}

function rehashEnvelope(value) {
  value.payload_sha256 = canonicalizer.hashReplication(value);
  return value;
}

function insertRegisteringEdgeAttachment(database, candidate, revisionUuid, overrides = {}) {
  return database.prepare(
    'INSERT INTO journal_attachment_replicas(' +
      'attachment_uuid,workspace_uuid,entry_uuid,entry_revision_uuid,parent_mutation_uuid,source,' +
      'content_role,parent_disposition,mime,size_bytes,sha256,sync_version,descriptor_state,' +
      'replica_status,cloud_registration_state,created_at,updated_at' +
    ') VALUES(?,?,?,?,?,\'edge\',\'original\',\'canonical\',\'image/jpeg\',1,?,1,\'active\',' +
      '\'local_only\',\'registering\',?,?)'
  ).run(
    overrides.attachment_uuid || 'd0000000-0000-4000-8000-000000000088',
    overrides.workspace_uuid || candidate.workspace_uuid,
    overrides.entry_uuid || candidate.resource.entry_uuid, revisionUuid, candidate.mutation_uuid,
    'a'.repeat(64),
    '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z'
  );
}

test('durably enqueues one immutable mutation and replays the same UUID', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  const candidate = mutation('ENTRY_CREATE');

  const first = await replication.enqueueMutation(db, candidate);
  const replay = await replication.enqueueMutation(db, clone(candidate));

  assert.equal(first.mutation_uuid, candidate.mutation_uuid);
  assert.equal(replay.replayed, true);
  assert.equal((await replication.nextMutations(db, 10)).length, 1);
  const row = database.prepare(
    'SELECT status,payload_sha256,payload_json FROM journal_edge_mutations WHERE mutation_uuid=?'
  ).get(candidate.mutation_uuid);
  assert.equal(row.status, 'pending');
  assert.equal(row.payload_sha256, candidate.payload_sha256);
  assert.deepEqual(JSON.parse(row.payload_json), candidate);

  const changed = clone(candidate);
  changed.candidate.entry.note = 'different retry';
  changed.payload_sha256 = canonicalizer.hashMutation(changed);
  await assert.rejects(() => replication.enqueueMutation(db, changed), /mutation UUID.*different payload/i);
});

test('accepts every V2 mutation union including entry create, correct, and void', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  for (const vector of golden.mutation_vectors) {
    await replication.enqueueMutation(db, clone(vector.input));
  }
  const queued = await replication.nextMutations(db, golden.mutation_vectors.length);
  assert.deepEqual(
    new Set(queued.map(function(item) { return item.operation; })),
    new Set([
      'ENTRY_CREATE', 'ENTRY_CORRECT', 'ENTRY_VOID', 'PRODUCT_UPSERT',
      'CUSTOM_VOCAB_UPSERT', 'PLOT_SNAPSHOT', 'CUTOVER_BARRIER_RECEIPT',
    ])
  );
});

test('rejects open mutation resource and candidate union shapes', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  for (const vector of golden.mutation_vectors) {
    const open = clone(vector.input);
    open.candidate.unexpected = true;
    const hashInput = clone(open);
    delete hashInput.payload_sha256;
    open.payload_sha256 = canonicalizer.sha256(hashInput);
    await assert.rejects(() => replication.enqueueMutation(db, open), /unexpected|shape/i);
  }
});

test('applies contiguous envelopes atomically and rejects gaps or hash mismatch', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  const head = envelope('ENTRY_HEAD');
  await replication.applyEnvelope(db, head);

  assert.equal(database.prepare(
    'SELECT sequence FROM journal_replication_cursor WHERE workspace_uuid=?'
  ).get(head.workspace_uuid).sequence, '1');
  assert.equal(database.prepare(
    'SELECT revision_uuid FROM journal_v2_entry_heads WHERE workspace_uuid=? AND entry_uuid=?'
  ).get(head.workspace_uuid, head.payload.entry_head_uuid).revision_uuid,
  head.payload.entry_revision_uuid);

  const gap = envelope('PLOT_SNAPSHOT');
  await assert.rejects(() => replication.applyEnvelope(db, gap), /noncontiguous/i);
  assert.equal(database.prepare(
    'SELECT sequence FROM journal_replication_cursor WHERE workspace_uuid=?'
  ).get(head.workspace_uuid).sequence, '1');

  const badHash = envelope('ENTRY_CONFLICT');
  badHash.payload.candidate_entry.note = 'tampered';
  await assert.rejects(() => replication.applyEnvelope(db, badHash), /payload_sha256 mismatch/i);
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM journal_replication_applied'
  ).get().count, 1);
});

test('rolls back projection rows when cursor persistence fails', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  const failingDb = Object.assign({}, db, {
    transaction(callback) {
      return db.transaction(function(tx) {
        const failingTx = Object.assign({}, tx, {
          run(sql, params) {
            if (sql.includes('INSERT INTO journal_replication_cursor')) {
              return Promise.reject(new Error('injected cursor failure'));
            }
            return tx.run(sql, params);
          },
        });
        return callback(failingTx);
      });
    },
  });

  await assert.rejects(
    () => replication.applyEnvelope(failingDb, envelope('ENTRY_HEAD')),
    /injected cursor failure/
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_v2_entry_heads').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_replication_applied').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_replication_cursor').get().count, 0);
});

test('retains a conflict without advancing the canonical head or erasing a proposal overlay', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  const pending = mutation('ENTRY_CORRECT');
  await replication.enqueueMutation(db, pending);
  await replication.applyEnvelope(db, envelope('ENTRY_HEAD'));
  await replication.applyEnvelope(db, envelope('ENTRY_CONFLICT'));

  const head = database.prepare('SELECT revision_uuid FROM journal_v2_entry_heads').get();
  assert.equal(head.revision_uuid, envelope('ENTRY_HEAD').payload.entry_revision_uuid);
  const conflict = database.prepare(
    'SELECT disposition,candidate_revision_uuid FROM journal_v2_entry_conflicts'
  ).get();
  assert.equal(conflict.disposition, 'needs-review');
  assert.equal(conflict.candidate_revision_uuid, envelope('ENTRY_CONFLICT').payload.candidate_revision_uuid);
  assert.equal(database.prepare(
    "SELECT status FROM journal_edge_mutations WHERE mutation_uuid=?"
  ).get(pending.mutation_uuid).status, 'pending');
});

test('projects replacement entry values, references, plots, crop cycles, attachments, and authority', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  for (const vector of golden.replication_vectors) {
    await replication.applyEnvelope(db, clone(vector.input));
  }

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_v2_entry_values').get().count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_v2_reference_data').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_v2_plot_snapshots').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_v2_crop_cycles').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_attachment_replicas').get().count, 1);
  assert.equal(database.prepare('SELECT state FROM journal_authority_state').get().state,
    envelope('AUTHORITY_STATE').payload.target_state);
});

test('rejects open replication payloads, ambiguous references, and malformed attachment identities', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  for (const vector of golden.replication_vectors) {
    const open = clone(vector.input);
    open.payload.unexpected = true;
    open.payload_sha256 = canonicalizer.sha256(open.payload);
    await assert.rejects(() => replication.applyEnvelope(db, open), /unexpected|shape|union member/i);
  }

  const ambiguous = envelope('REFERENCE_DATA');
  ambiguous.payload.custom_vocab = mutation('CUSTOM_VOCAB_UPSERT').candidate.custom_vocab;
  ambiguous.payload_sha256 = canonicalizer.sha256(ambiguous.payload);
  await assert.rejects(() => replication.applyEnvelope(db, ambiguous), /reference.*exactly|shape/i);

  const malformedAttachment = envelope('ATTACHMENT_DESCRIPTOR');
  malformedAttachment.payload.attachment_uuid = 'not-a-uuid';
  malformedAttachment.payload.entry_revision_uuid = 'also-not-a-uuid';
  malformedAttachment.payload_sha256 = canonicalizer.sha256(malformedAttachment.payload);
  await assert.rejects(() => replication.applyEnvelope(db, malformedAttachment), /canonical UUID/i);
});

test('records applied, replay, and conflict outcomes and binds only the returned revision', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  for (const outcome of ['applied', 'already-applied', 'conflict']) {
    const candidate = mutation('ENTRY_CREATE');
    candidate.mutation_uuid = {
      applied: '10000000-0000-4000-8000-000000000011',
      'already-applied': '10000000-0000-4000-8000-000000000012',
      conflict: '10000000-0000-4000-8000-000000000013',
    }[outcome];
    candidate.payload_sha256 = canonicalizer.hashMutation(candidate);
    await replication.enqueueMutation(db, candidate);
    database.prepare(
      'INSERT INTO journal_media_files(' +
        'media_uuid,workspace_uuid,parent_mutation_uuid,parent_revision_uuid,local_path,sha256,size_bytes,' +
        'received_bytes,replica_status,pinned,last_accessed_at,created_at,updated_at' +
      ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      candidate.mutation_uuid, candidate.workspace_uuid, candidate.mutation_uuid, null,
      '/tmp/' + candidate.mutation_uuid, 'a'.repeat(64), 1, 1, 'local_only', 0,
      '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z',
      '2026-08-08T10:11:12.123Z'
    );
    const revisionUuid = {
      applied: 'b0000000-0000-4000-8000-000000000011',
      'already-applied': 'b0000000-0000-4000-8000-000000000012',
      conflict: 'b0000000-0000-4000-8000-000000000013',
    }[outcome];
    const result = {
      kind: 'ENTRY_MUTATION_RESULT',
      mutation_uuid: candidate.mutation_uuid,
      outcome,
      head: { entry_uuid: candidate.resource.entry_uuid, version: 1 },
      revision_uuid: revisionUuid,
      conflict_uuid: outcome === 'conflict' ? 'c0000000-0000-4000-8000-000000000013' : null,
    };
    await replication.recordOutcome(db, candidate.mutation_uuid, result);
    const replay = await replication.recordOutcome(db, candidate.mutation_uuid, {
      outcome: result.outcome,
      kind: result.kind,
      conflict_uuid: result.conflict_uuid,
      revision_uuid: result.revision_uuid,
      head: { version: result.head.version, entry_uuid: result.head.entry_uuid },
      mutation_uuid: result.mutation_uuid,
    });
    assert.equal(replay.replayed, true);
    await replication.bindPendingAttachments(db, candidate.mutation_uuid, result);
    assert.equal(database.prepare(
      'SELECT parent_revision_uuid FROM journal_media_files WHERE media_uuid=?'
    ).get(candidate.mutation_uuid).parent_revision_uuid, revisionUuid);
  }
});

test('rejects result-union shape drift and a plot result for the wrong projection version', async (t) => {
  const { database, db } = fixture();
  t.after(() => database.close());
  const entry = mutation('ENTRY_CREATE');
  await replication.enqueueMutation(db, entry);
  const entryResult = clone(golden.result_vectors.find(function(vector) {
    return vector.input.kind === 'ENTRY_MUTATION_RESULT';
  }).input);
  entryResult.unexpected = true;
  await assert.rejects(
    () => replication.recordOutcome(db, entry.mutation_uuid, entryResult),
    /unexpected|shape/i
  );

  const plot = mutation('PLOT_SNAPSHOT');
  await replication.enqueueMutation(db, plot);
  const plotResult = clone(golden.result_vectors.find(function(vector) {
    return vector.input.kind === 'PLOT_SNAPSHOT_RESULT';
  }).input);
  plotResult.projection_version += 1;
  await assert.rejects(
    () => replication.recordOutcome(db, plot.mutation_uuid, plotResult),
    /projection version/i
  );
  assert.equal(database.prepare(
    'SELECT status FROM journal_edge_mutations WHERE mutation_uuid=?'
  ).get(plot.mutation_uuid).status, 'pending');
});

test('queued mutations and attachment result bindings survive process restarts', async (t) => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'osi-journal-v2-restart-'));
  const dbPath = path.join(directory, 'farming.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidate = mutation('ENTRY_CREATE');
  candidate.mutation_uuid = '10000000-0000-4000-8000-000000000088';
  candidate.payload_sha256 = canonicalizer.hashMutation(candidate);

  let database = new DatabaseSync(dbPath);
  database.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  await replication.enqueueMutation(facade(database), candidate);
  database.prepare(
    'INSERT INTO journal_media_files(' +
      'media_uuid,workspace_uuid,parent_mutation_uuid,local_path,sha256,size_bytes,received_bytes,' +
      'replica_status,pinned,last_accessed_at,created_at,updated_at' +
    ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'd0000000-0000-4000-8000-000000000088', candidate.workspace_uuid,
    candidate.mutation_uuid, '/tmp/restart-photo', 'a'.repeat(64), 1, 1, 'local_only', 0,
    '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z'
  );
  assert.throws(
    () => insertRegisteringEdgeAttachment(
      database, candidate, 'b0000000-0000-4000-8000-000000000088'
    ),
    /parent outcome is not bound/i
  );
  database.close();

  const result = {
    kind: 'ENTRY_MUTATION_RESULT', mutation_uuid: candidate.mutation_uuid, outcome: 'applied',
    head: { entry_uuid: candidate.resource.entry_uuid, version: 1 },
    revision_uuid: 'b0000000-0000-4000-8000-000000000088', conflict_uuid: null,
  };
  database = new DatabaseSync(dbPath);
  await replication.recordOutcome(facade(database), candidate.mutation_uuid, result);
  database.close();

  database = new DatabaseSync(dbPath);
  await replication.bindPendingAttachments(facade(database), candidate.mutation_uuid, result);
  assert.throws(
    () => insertRegisteringEdgeAttachment(database, candidate, result.revision_uuid, {
      entry_uuid: '30000000-0000-4000-8000-000000000099',
    }),
    /parent outcome is not bound/i
  );
  assert.throws(
    () => database.prepare(
      'INSERT INTO journal_attachment_replicas(' +
        'attachment_uuid,workspace_uuid,entry_uuid,entry_revision_uuid,parent_mutation_uuid,source,' +
        'content_role,parent_disposition,mime,size_bytes,sha256,sync_version,descriptor_state,' +
        'replica_status,cloud_registration_state,created_at,updated_at' +
      ') VALUES(?,?,?,?,?,\'edge\',\'original\',\'conflict\',\'image/jpeg\',1,?,1,\'active\',' +
        '\'local_only\',\'registering\',?,?)'
    ).run(
      'd0000000-0000-4000-8000-000000000088', candidate.workspace_uuid,
      candidate.resource.entry_uuid, result.revision_uuid, candidate.mutation_uuid, 'a'.repeat(64),
      '2026-08-08T10:11:12.123Z', '2026-08-08T10:11:12.123Z'
    ),
    /parent outcome is not bound/i
  );
  insertRegisteringEdgeAttachment(database, candidate, result.revision_uuid);
  assert.throws(
    () => database.prepare(
      'UPDATE journal_attachment_replicas SET entry_uuid=? WHERE attachment_uuid=?'
    ).run(
      '30000000-0000-4000-8000-000000000099',
      'd0000000-0000-4000-8000-000000000088'
    ),
    /parent outcome is not bound/i
  );
  assert.throws(
    () => database.prepare(
      'UPDATE journal_attachment_replicas SET source=\'cloud\',entry_uuid=? WHERE attachment_uuid=?'
    ).run(
      '30000000-0000-4000-8000-000000000099',
      'd0000000-0000-4000-8000-000000000088'
    ),
    /source is immutable|binding is immutable|parent outcome is not bound/i
  );
  database.close();

  database = new DatabaseSync(dbPath);
  const persisted = database.prepare(
    'SELECT q.status,m.parent_revision_uuid,a.entry_revision_uuid FROM journal_edge_mutations q ' +
      'JOIN journal_media_files m ON m.parent_mutation_uuid=q.mutation_uuid ' +
      'JOIN journal_attachment_replicas a ON a.parent_mutation_uuid=q.mutation_uuid ' +
      'WHERE q.mutation_uuid=?'
  ).get(candidate.mutation_uuid);
  assert.equal(persisted.status, 'applied');
  assert.equal(persisted.parent_revision_uuid, result.revision_uuid);
  assert.equal(persisted.entry_revision_uuid, result.revision_uuid);
  database.close();
});

test('registered edge attachment bindings cannot retarget to another valid outcome', async (t) => {
  const { database } = fixture();
  t.after(() => database.close());
  const now = '2026-08-08T10:11:12.123Z';
  function terminalMutation(values) {
    database.prepare(
      'INSERT INTO journal_edge_mutations(' +
        'mutation_uuid,workspace_uuid,operation,resource_uuid,base_version,payload_json,' +
        'payload_sha256,status,outcome_json,result_revision_uuid,conflict_uuid,recorded_at,' +
        'created_at,updated_at,completed_at' +
      ') VALUES(?,?,\'ENTRY_CREATE\',?,0,?,?,?,\'{}\',?,?,?,?,?,?)'
    ).run(
      values.mutation_uuid, values.workspace_uuid, values.entry_uuid, '{}', 'a'.repeat(64),
      values.status, values.revision_uuid,
      values.status === 'conflict' ? values.conflict_uuid : null,
      now, now, now, now
    );
  }
  const canonicalA = {
    mutation_uuid: '10000000-0000-4000-8000-000000000091',
    workspace_uuid: '20000000-0000-4000-8000-000000000091',
    entry_uuid: '30000000-0000-4000-8000-000000000091',
    revision_uuid: 'b0000000-0000-4000-8000-000000000091',
    status: 'applied',
  };
  const canonicalB = {
    mutation_uuid: '10000000-0000-4000-8000-000000000092',
    workspace_uuid: '20000000-0000-4000-8000-000000000092',
    entry_uuid: '30000000-0000-4000-8000-000000000092',
    revision_uuid: 'b0000000-0000-4000-8000-000000000092',
    status: 'already-applied',
  };
  terminalMutation(canonicalA);
  terminalMutation(canonicalB);
  database.prepare(
    'INSERT INTO journal_attachment_replicas(' +
      'attachment_uuid,workspace_uuid,entry_uuid,entry_revision_uuid,parent_mutation_uuid,source,' +
      'content_role,parent_disposition,mime,size_bytes,sha256,sync_version,descriptor_state,' +
      'replica_status,cloud_registration_state,created_at,updated_at' +
    ') VALUES(?,?,?,?,?,\'edge\',\'original\',\'canonical\',\'image/jpeg\',1,?,1,\'active\',' +
      '\'local_only\',\'registered\',?,?)'
  ).run(
    'd0000000-0000-4000-8000-000000000091', canonicalA.workspace_uuid,
    canonicalA.entry_uuid, canonicalA.revision_uuid, canonicalA.mutation_uuid,
    'a'.repeat(64), now, now
  );

  assert.throws(
    () => database.prepare(
      'UPDATE journal_attachment_replicas SET workspace_uuid=?,entry_uuid=?,' +
        'entry_revision_uuid=?,parent_mutation_uuid=? WHERE attachment_uuid=?'
    ).run(
      canonicalB.workspace_uuid, canonicalB.entry_uuid, canonicalB.revision_uuid,
      canonicalB.mutation_uuid, 'd0000000-0000-4000-8000-000000000091'
    ),
    /binding is immutable/i
  );
  assert.throws(
    () => database.prepare(
      "UPDATE journal_attachment_replicas SET cloud_registration_state='not_registered' " +
        'WHERE attachment_uuid=?'
    ).run('d0000000-0000-4000-8000-000000000091'),
    /binding is immutable/i
  );

  const conflictA = {
    mutation_uuid: '10000000-0000-4000-8000-000000000093',
    workspace_uuid: '20000000-0000-4000-8000-000000000093',
    entry_uuid: '30000000-0000-4000-8000-000000000093',
    revision_uuid: 'b0000000-0000-4000-8000-000000000093',
    conflict_uuid: 'c0000000-0000-4000-8000-000000000093',
    status: 'conflict',
  };
  const conflictB = {
    mutation_uuid: '10000000-0000-4000-8000-000000000094',
    workspace_uuid: conflictA.workspace_uuid,
    entry_uuid: conflictA.entry_uuid,
    revision_uuid: 'b0000000-0000-4000-8000-000000000094',
    conflict_uuid: 'c0000000-0000-4000-8000-000000000094',
    status: 'conflict',
  };
  terminalMutation(conflictA);
  terminalMutation(conflictB);
  database.prepare(
    'INSERT INTO journal_attachment_replicas(' +
      'attachment_uuid,workspace_uuid,entry_uuid,entry_revision_uuid,parent_mutation_uuid,source,' +
      'content_role,parent_disposition,mime,size_bytes,sha256,sync_version,descriptor_state,' +
      'replica_status,cloud_registration_state,created_at,updated_at' +
    ') VALUES(?,?,?,?,?,\'edge\',\'original\',\'conflict\',\'image/jpeg\',1,?,1,\'active\',' +
      '\'local_only\',\'registered\',?,?)'
  ).run(
    'd0000000-0000-4000-8000-000000000093', conflictA.workspace_uuid,
    conflictA.entry_uuid, conflictA.revision_uuid, conflictA.mutation_uuid,
    'a'.repeat(64), now, now
  );
  assert.throws(
    () => database.prepare(
      'UPDATE journal_attachment_replicas SET entry_revision_uuid=?,parent_mutation_uuid=? ' +
        'WHERE attachment_uuid=?'
    ).run(
      conflictB.revision_uuid, conflictB.mutation_uuid,
      'd0000000-0000-4000-8000-000000000093'
    ),
    /binding is immutable/i
  );
});
