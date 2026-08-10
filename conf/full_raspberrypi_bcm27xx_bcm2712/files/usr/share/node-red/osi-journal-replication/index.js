'use strict';

const crypto = require('node:crypto');
const canonicalizer = require('./canonicalization');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(['applied', 'already-applied', 'conflict']);

function error(code, message) {
  const value = new Error(message);
  value.code = code;
  return value;
}

function assertUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw error('invalid_uuid', field + ' must be a canonical UUID');
  }
}

function assertSha256(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw error('invalid_sha256', field + ' must be a lowercase SHA-256');
  }
}

function assertGatewayEui(value, field) {
  if (typeof value !== 'string' || !/^[0-9A-F]{16}$/.test(value) ||
      value === '0101010101010101') {
    throw error('invalid_gateway_eui', field + ' must be an uppercase EUI64');
  }
}

function assertPositiveSafeInteger(value, field) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw error('invalid_config', field + ' must be a positive safe integer');
  }
  return numeric;
}

function assertExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some(function(key, index) {
    return key !== wanted[index];
  })) {
    throw error('invalid_outcome', field + ' has an unexpected result-union shape');
  }
}

function parameters(params) {
  return Array.isArray(params) ? params : [];
}

async function get(db, sql, params) {
  if (db && typeof db.prepare === 'function') {
    return db.prepare(sql).get(...parameters(params));
  }
  if (!db || typeof db.get !== 'function') throw new TypeError('Database does not provide get()');
  return db.get(sql, parameters(params));
}

async function all(db, sql, params) {
  if (db && typeof db.prepare === 'function') {
    return db.prepare(sql).all(...parameters(params));
  }
  if (!db || typeof db.all !== 'function') throw new TypeError('Database does not provide all()');
  return db.all(sql, parameters(params));
}

async function run(db, sql, params) {
  if (db && typeof db.prepare === 'function') {
    return db.prepare(sql).run(...parameters(params));
  }
  if (!db || typeof db.run !== 'function') throw new TypeError('Database does not provide run()');
  return db.run(sql, parameters(params));
}

async function transaction(db, callback) {
  if (db && typeof db.transaction === 'function') return db.transaction(callback);
  if (!db || typeof db.exec !== 'function') throw new TypeError('Database does not provide transaction()');
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result = await callback(db);
    await db.exec('COMMIT');
    return result;
  } catch (cause) {
    await db.exec('ROLLBACK');
    throw cause;
  }
}

function now() {
  return new Date().toISOString();
}

function resolveMediaRoot(fsApi, configuredRoot) {
  const pathApi = require('node:path');
  if (!fsApi || typeof configuredRoot !== 'string' || !configuredRoot ||
      !pathApi.isAbsolute(configuredRoot)) {
    throw error('invalid_media_root', 'Journal media root must be an absolute configured directory');
  }
  const normalized = pathApi.resolve(configuredRoot);
  if (normalized !== configuredRoot) {
    throw error('invalid_media_root', 'Journal media root must be the canonical configured directory');
  }
  let facts;
  try { facts = fsApi.lstatSync(configuredRoot); } catch (cause) {
    throw error('invalid_media_root', 'Journal media root configured directory is unavailable');
  }
  if (facts.isSymbolicLink()) {
    throw error('invalid_media_root', 'Journal media root must not be a symlink');
  }
  if (!facts.isDirectory()) {
    throw error('invalid_media_root', 'Journal media root must be a directory');
  }
  const canonical = fsApi.realpathSync(configuredRoot);
  if (canonical !== configuredRoot) {
    throw error('invalid_media_root', 'Journal media root must be the canonical configured directory');
  }
  return canonical;
}

function mediaPaths(fsApi, configuredRoot, mediaUuid) {
  assertUuid(mediaUuid, 'media_uuid');
  const root = resolveMediaRoot(fsApi, configuredRoot);
  const pathApi = require('node:path');
  return {
    final_path: pathApi.join(root, mediaUuid + '.bin'),
    partial_path: pathApi.join(root, mediaUuid + '.part'),
  };
}

function rejectSymlink(fsApi, filePath) {
  if (!fsApi.existsSync(filePath)) return;
  if (fsApi.lstatSync(filePath).isSymbolicLink()) {
    throw error('invalid_media_path', 'Journal media path must not be a symlink');
  }
}

function resourceIdentity(mutation) {
  const resource = mutation.resource;
  switch (mutation.operation) {
    case 'ENTRY_CREATE':
    case 'ENTRY_CORRECT':
    case 'ENTRY_VOID':
      return resource.entry_uuid;
    case 'PRODUCT_UPSERT':
      return resource.product_uuid;
    case 'CUSTOM_VOCAB_UPSERT':
      return resource.custom_field_uuid;
    case 'PLOT_SNAPSHOT':
      return resource.plot_uuid;
    case 'CUTOVER_BARRIER_RECEIPT':
      return resource.barrier_uuid;
    default:
      throw error('invalid_operation', 'Unsupported Journal V2 mutation operation');
  }
}

function baseVersion(mutation) {
  if (mutation.operation === 'PLOT_SNAPSHOT') return mutation.resource.projection_version - 1;
  if (mutation.operation === 'CUTOVER_BARRIER_RECEIPT') return 0;
  return mutation.resource.base_version;
}

async function enqueueMutation(db, mutation) {
  canonicalizer.validateMutation(mutation);
  const existing = await get(
    db,
    'SELECT payload_sha256,status,outcome_json FROM journal_edge_mutations WHERE mutation_uuid=?',
    [mutation.mutation_uuid]
  );
  if (existing) {
    if (existing.payload_sha256 !== mutation.payload_sha256) {
      throw error('idempotency_conflict', 'Mutation UUID replay has a different payload');
    }
    return {
      mutation_uuid: mutation.mutation_uuid,
      status: existing.status,
      replayed: true,
      outcome: existing.outcome_json ? JSON.parse(existing.outcome_json) : null,
    };
  }
  const createdAt = now();
  try {
    await run(
      db,
      'INSERT INTO journal_edge_mutations(' +
        'mutation_uuid,workspace_uuid,operation,resource_uuid,base_version,payload_json,payload_sha256,' +
        'status,recorded_at,created_at,updated_at' +
      ') VALUES(?,?,?,?,?,?,?,\'pending\',?,?,?)',
      [
        mutation.mutation_uuid,
        mutation.workspace_uuid,
        mutation.operation,
        resourceIdentity(mutation),
        baseVersion(mutation),
        JSON.stringify(mutation),
        mutation.payload_sha256,
        mutation.recorded_at,
        createdAt,
        createdAt,
      ]
    );
  } catch (cause) {
    const raced = await get(
      db,
      'SELECT payload_sha256,status,outcome_json FROM journal_edge_mutations WHERE mutation_uuid=?',
      [mutation.mutation_uuid]
    );
    if (!raced || raced.payload_sha256 !== mutation.payload_sha256) throw cause;
    return {
      mutation_uuid: mutation.mutation_uuid,
      status: raced.status,
      replayed: true,
      outcome: raced.outcome_json ? JSON.parse(raced.outcome_json) : null,
    };
  }
  return { mutation_uuid: mutation.mutation_uuid, status: 'pending', replayed: false };
}

async function nextMutations(db, limit) {
  const bounded = Number(limit);
  if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > 100) {
    throw error('invalid_limit', 'Mutation batch limit must be an integer from 1 through 100');
  }
  const rows = await all(
    db,
    "SELECT payload_json FROM journal_edge_mutations WHERE status='pending' " +
      'AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,mutation_uuid LIMIT ?',
    [now(), bounded]
  );
  return rows.map(function(row) { return JSON.parse(row.payload_json); });
}

function validateOutcome(mutation, outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw error('invalid_outcome', 'Mutation outcome must be an object');
  }
  if (outcome.mutation_uuid !== mutation.mutation_uuid || !TERMINAL.has(outcome.outcome)) {
    throw error('invalid_outcome', 'Mutation outcome does not match the queued mutation');
  }
  const entryOperation = mutation.operation.startsWith('ENTRY_');
  if (entryOperation) {
    assertExactKeys(outcome, [
      'kind', 'mutation_uuid', 'outcome', 'head', 'revision_uuid', 'conflict_uuid',
    ], 'Entry mutation result');
    if (outcome.kind !== 'ENTRY_MUTATION_RESULT') {
      throw error('invalid_outcome', 'Entry mutation requires an entry result');
    }
    assertUuid(outcome.revision_uuid, 'revision_uuid');
    if (!outcome.head || typeof outcome.head !== 'object' || Array.isArray(outcome.head)) {
      throw error('invalid_outcome', 'Entry mutation result has an invalid head');
    }
    assertExactKeys(outcome.head, ['entry_uuid', 'version'], 'Entry mutation result head');
    if (!outcome.head || outcome.head.entry_uuid !== mutation.resource.entry_uuid ||
        !Number.isSafeInteger(outcome.head.version) || outcome.head.version < 1) {
      throw error('invalid_outcome', 'Entry mutation result has an invalid head');
    }
    if (outcome.outcome === 'conflict') assertUuid(outcome.conflict_uuid, 'conflict_uuid');
    if (outcome.outcome !== 'conflict' && outcome.conflict_uuid !== null) {
      throw error('invalid_outcome', 'Non-conflict entry result must not name a conflict');
    }
  } else if (['PRODUCT_UPSERT', 'CUSTOM_VOCAB_UPSERT'].includes(mutation.operation)) {
    assertExactKeys(outcome, [
      'kind', 'mutation_uuid', 'outcome', 'resource_uuid',
    ], 'Reference mutation result');
    if (outcome.kind !== 'REFERENCE_MUTATION_RESULT' ||
        outcome.resource_uuid !== resourceIdentity(mutation)) {
      throw error('invalid_outcome', 'Reference mutation result has the wrong resource');
    }
  } else if (mutation.operation === 'PLOT_SNAPSHOT') {
    assertExactKeys(outcome, [
      'kind', 'mutation_uuid', 'outcome', 'projection_version',
    ], 'Plot mutation result');
    if (outcome.kind !== 'PLOT_SNAPSHOT_RESULT' ||
        outcome.projection_version !== mutation.resource.projection_version) {
      throw error('invalid_outcome', 'Plot mutation result has the wrong projection version');
    }
  } else {
    assertExactKeys(outcome, [
      'kind', 'mutation_uuid', 'outcome', 'barrier_uuid',
    ], 'Barrier receipt result');
    if (outcome.kind !== 'CUTOVER_BARRIER_RECEIPT_RESULT' ||
        outcome.barrier_uuid !== mutation.resource.barrier_uuid) {
      throw error('invalid_outcome', 'Barrier receipt result has the wrong barrier');
    }
  }
}

async function recordOutcome(db, mutationUuid, outcome) {
  assertUuid(mutationUuid, 'mutationUuid');
  return transaction(db, async function(tx) {
    const row = await get(tx, 'SELECT * FROM journal_edge_mutations WHERE mutation_uuid=?', [mutationUuid]);
    if (!row) throw error('not_found', 'Journal mutation was not found');
    const mutation = JSON.parse(row.payload_json);
    validateOutcome(mutation, outcome);
    const encoded = canonicalizer.canonicalize(outcome);
    if (TERMINAL.has(row.status)) {
      if (canonicalizer.canonicalize(JSON.parse(row.outcome_json)) !== encoded) {
        throw error('idempotency_conflict', 'Mutation outcome replay does not match the persisted outcome');
      }
      return { mutation_uuid: mutationUuid, status: row.status, replayed: true };
    }
    const completedAt = now();
    await run(
      tx,
      'UPDATE journal_edge_mutations SET status=?,outcome_json=?,result_revision_uuid=?,' +
        'conflict_uuid=?,updated_at=?,completed_at=?,last_error=NULL WHERE mutation_uuid=?',
      [
        outcome.outcome,
        encoded,
        outcome.kind === 'ENTRY_MUTATION_RESULT' ? outcome.revision_uuid : null,
        outcome.kind === 'ENTRY_MUTATION_RESULT' ? outcome.conflict_uuid : null,
        completedAt,
        completedAt,
        mutationUuid,
      ]
    );
    return { mutation_uuid: mutationUuid, status: outcome.outcome, replayed: false };
  });
}

async function bindPendingAttachments(db, parentMutationUuid, entryResult) {
  assertUuid(parentMutationUuid, 'parentMutationUuid');
  return transaction(db, async function(tx) {
    const mutation = await get(
      tx,
      'SELECT workspace_uuid,operation,status,outcome_json,result_revision_uuid,conflict_uuid ' +
        'FROM journal_edge_mutations WHERE mutation_uuid=?',
      [parentMutationUuid]
    );
    if (!mutation || !mutation.operation.startsWith('ENTRY_') || !TERMINAL.has(mutation.status) ||
        !mutation.outcome_json) {
      throw error('parent_outcome_unavailable', 'Parent entry mutation has no persisted terminal outcome');
    }
    const persisted = JSON.parse(mutation.outcome_json);
    if (canonicalizer.canonicalize(persisted) !== canonicalizer.canonicalize(entryResult) ||
        mutation.result_revision_uuid !== entryResult.revision_uuid) {
      throw error('parent_outcome_mismatch', 'Attachment binding must use the persisted parent result');
    }
    const rows = await all(
      tx,
      'SELECT media_uuid,parent_revision_uuid FROM journal_media_files WHERE parent_mutation_uuid=?',
      [parentMutationUuid]
    );
    for (const row of rows) {
      if (row.parent_revision_uuid && row.parent_revision_uuid !== entryResult.revision_uuid) {
        throw error('parent_outcome_mismatch', 'Attachment is already bound to a different revision');
      }
    }
    await run(
      tx,
      'UPDATE journal_media_files SET parent_revision_uuid=?,conflict_bound=?,updated_at=? ' +
        'WHERE parent_mutation_uuid=? AND parent_revision_uuid IS NULL',
      [entryResult.revision_uuid, entryResult.outcome === 'conflict' ? 1 : 0, now(), parentMutationUuid]
    );
    return {
      parent_mutation_uuid: parentMutationUuid,
      parent_revision_uuid: entryResult.revision_uuid,
      bound_count: rows.filter(function(row) { return row.parent_revision_uuid === null; }).length,
    };
  });
}

async function replaceEntryHead(tx, envelope) {
  const payload = envelope.payload;
  const entry = payload.entry;
  await run(
    tx,
    'INSERT INTO journal_v2_entry_heads(' +
      'workspace_uuid,entry_uuid,revision_uuid,sync_version,payload_json,payload_sha256,recorded_at' +
    ') VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_uuid,entry_uuid) DO UPDATE SET ' +
      'revision_uuid=excluded.revision_uuid,sync_version=excluded.sync_version,' +
      'payload_json=excluded.payload_json,payload_sha256=excluded.payload_sha256,' +
      'recorded_at=excluded.recorded_at',
    [
      envelope.workspace_uuid, payload.entry_head_uuid, payload.entry_revision_uuid,
      entry.sync_version, JSON.stringify(entry), canonicalizer.sha256(entry), envelope.recorded_at,
    ]
  );
  await run(
    tx,
    'DELETE FROM journal_v2_entry_values WHERE workspace_uuid=? AND entry_uuid=?',
    [envelope.workspace_uuid, payload.entry_head_uuid]
  );
  for (const value of entry.values) {
    await run(
      tx,
      'INSERT INTO journal_v2_entry_values(' +
        'workspace_uuid,entry_uuid,attribute_code,group_index,value_json' +
      ') VALUES(?,?,?,?,?)',
      [
        envelope.workspace_uuid, payload.entry_head_uuid, value.attribute_code,
        value.group_index, JSON.stringify(value),
      ]
    );
  }
}

async function replaceConflict(tx, envelope) {
  const payload = envelope.payload;
  await run(
    tx,
    'INSERT INTO journal_v2_entry_conflicts(' +
      'workspace_uuid,conflict_uuid,entry_uuid,current_revision_uuid,candidate_revision_uuid,' +
      'base_version,current_version,disposition,reason,payload_json,recorded_at' +
    ') VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_uuid,conflict_uuid) DO UPDATE SET ' +
      'disposition=excluded.disposition,reason=excluded.reason,payload_json=excluded.payload_json,' +
      'recorded_at=excluded.recorded_at',
    [
      envelope.workspace_uuid, payload.conflict_uuid, payload.entry_head_uuid,
      payload.current_revision_uuid, payload.candidate_revision_uuid, payload.base_version,
      payload.current_version, payload.disposition, payload.reason, JSON.stringify(payload),
      envelope.recorded_at,
    ]
  );
}

async function replaceReference(tx, envelope) {
  const payload = envelope.payload;
  const type = payload.product ? 'product' : 'custom_vocab';
  const value = payload.product || payload.custom_vocab;
  const resourceUuid = type === 'product' ? value.product_uuid : value.custom_field_uuid;
  await run(
    tx,
    'INSERT INTO journal_v2_reference_data(' +
      'workspace_uuid,resource_type,resource_uuid,sync_version,payload_json,recorded_at' +
    ') VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_uuid,resource_type,resource_uuid) DO UPDATE SET ' +
      'sync_version=excluded.sync_version,payload_json=excluded.payload_json,recorded_at=excluded.recorded_at',
    [envelope.workspace_uuid, type, resourceUuid, value.sync_version, JSON.stringify(value), envelope.recorded_at]
  );
}

async function replacePlot(tx, envelope) {
  const payload = envelope.payload;
  await run(
    tx,
    'INSERT INTO journal_v2_plot_snapshots(' +
      'workspace_uuid,plot_uuid,snapshot_uuid,gateway_device_eui,projection_version,payload_json,recorded_at' +
    ') VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_uuid,plot_uuid) DO UPDATE SET ' +
      'snapshot_uuid=excluded.snapshot_uuid,gateway_device_eui=excluded.gateway_device_eui,' +
      'projection_version=excluded.projection_version,payload_json=excluded.payload_json,' +
      'recorded_at=excluded.recorded_at',
    [
      envelope.workspace_uuid, payload.plot.plot_uuid, payload.snapshot_uuid,
      payload.gateway_device_eui, payload.projection_version, JSON.stringify(payload.plot),
      envelope.recorded_at,
    ]
  );
}

async function replaceCropCycle(tx, envelope) {
  const payload = envelope.payload;
  await run(
    tx,
    'INSERT INTO journal_v2_crop_cycles(' +
      'workspace_uuid,cycle_uuid,sync_version,payload_json,recorded_at' +
    ') VALUES(?,?,?,?,?) ON CONFLICT(workspace_uuid,cycle_uuid) DO UPDATE SET ' +
      'sync_version=excluded.sync_version,payload_json=excluded.payload_json,recorded_at=excluded.recorded_at',
    [envelope.workspace_uuid, payload.cycle_uuid, payload.sync_version, JSON.stringify(payload), envelope.recorded_at]
  );
  await run(
    tx,
    'DELETE FROM journal_v2_crop_cycle_plots WHERE workspace_uuid=? AND cycle_uuid=?',
    [envelope.workspace_uuid, payload.cycle_uuid]
  );
  for (const plot of payload.plots) {
    await run(
      tx,
      'INSERT INTO journal_v2_crop_cycle_plots(' +
        'workspace_uuid,cycle_uuid,plot_uuid,payload_json' +
      ') VALUES(?,?,?,?)',
      [envelope.workspace_uuid, payload.cycle_uuid, plot.plot_uuid, JSON.stringify(plot)]
    );
  }
}

async function replaceAttachment(tx, envelope) {
  const payload = envelope.payload;
  await run(
    tx,
    'INSERT INTO journal_attachment_replicas(' +
      'attachment_uuid,workspace_uuid,entry_uuid,entry_revision_uuid,parent_mutation_uuid,source,' +
      'content_role,parent_disposition,original_filename,mime,size_bytes,sha256,sync_version,' +
      'descriptor_state,replica_status,cloud_registration_state,received_bytes,pinned,captured_at,' +
      'created_at,updated_at,deleted_at' +
    ') VALUES(?,?,?,?,?,\'cloud\',?,?,?,?,?,?,?,?,\'download_queued\',\'registered\',0,0,?,?,?,?) ' +
    'ON CONFLICT(attachment_uuid) DO UPDATE SET ' +
      'workspace_uuid=excluded.workspace_uuid,entry_uuid=excluded.entry_uuid,' +
      'entry_revision_uuid=excluded.entry_revision_uuid,content_role=excluded.content_role,' +
      'parent_disposition=excluded.parent_disposition,original_filename=excluded.original_filename,' +
      'mime=excluded.mime,size_bytes=excluded.size_bytes,sha256=excluded.sha256,' +
      'sync_version=excluded.sync_version,descriptor_state=excluded.descriptor_state,' +
      'captured_at=excluded.captured_at,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at',
    [
      payload.attachment_uuid, envelope.workspace_uuid, payload.entry_uuid,
      payload.entry_revision_uuid, null, payload.content_role, payload.parent_disposition,
      payload.original_filename, payload.mime, payload.size_bytes, payload.sha256,
      payload.sync_version, payload.state, payload.captured_at, payload.created_at,
      envelope.recorded_at, payload.deleted_at,
    ]
  );
}

async function replaceAuthority(tx, envelope) {
  const payload = envelope.payload;
  const current = await get(
    tx,
    'SELECT state FROM journal_authority_state WHERE workspace_uuid=?',
    [envelope.workspace_uuid]
  );
  if (current && current.state !== payload.from_state) {
    throw error('authority_transition_mismatch', 'Authority envelope does not continue the persisted state');
  }
  if (!current && payload.from_state !== null) {
    throw error('authority_transition_mismatch', 'Initial authority envelope must have a null from_state');
  }
  await run(
    tx,
    'INSERT INTO journal_authority_state(' +
      'workspace_uuid,gateway_device_eui,authority_state,state,transition_uuid,barrier_uuid,reason,updated_at' +
    ') VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_uuid) DO UPDATE SET ' +
      'gateway_device_eui=excluded.gateway_device_eui,authority_state=excluded.authority_state,' +
      'state=excluded.state,transition_uuid=excluded.transition_uuid,barrier_uuid=excluded.barrier_uuid,' +
      'reason=excluded.reason,updated_at=excluded.updated_at',
    [
      envelope.workspace_uuid, payload.gateway_device_eui,
      payload.target_state === 'ACTIVATED' ? 'cloud_primary' : 'legacy', payload.target_state,
      payload.transition_uuid, payload.barrier_uuid, payload.reason, envelope.recorded_at,
    ]
  );
}

async function project(tx, envelope) {
  switch (envelope.kind) {
    case 'ENTRY_HEAD': return replaceEntryHead(tx, envelope);
    case 'ENTRY_CONFLICT': return replaceConflict(tx, envelope);
    case 'REFERENCE_DATA': return replaceReference(tx, envelope);
    case 'PLOT_SNAPSHOT': return replacePlot(tx, envelope);
    case 'CROP_CYCLE_PROJECTION': return replaceCropCycle(tx, envelope);
    case 'ATTACHMENT_DESCRIPTOR': return replaceAttachment(tx, envelope);
    case 'AUTHORITY_STATE': return replaceAuthority(tx, envelope);
    default: throw error('invalid_replication_kind', 'Unsupported Journal V2 replication kind');
  }
}

async function applyEnvelope(db, envelope) {
  canonicalizer.validateReplication(envelope);
  return transaction(db, async function(tx) {
    const applied = await get(
      tx,
      'SELECT kind,payload_sha256 FROM journal_replication_applied ' +
        'WHERE workspace_uuid=? AND sequence=?',
      [envelope.workspace_uuid, envelope.sequence]
    );
    if (applied) {
      if (applied.kind !== envelope.kind || applied.payload_sha256 !== envelope.payload_sha256) {
        throw error('replication_replay_mismatch', 'Applied sequence replay has different content');
      }
      return { sequence: envelope.sequence, replayed: true };
    }
    const cursor = await get(
      tx,
      'SELECT sequence FROM journal_replication_cursor WHERE workspace_uuid=?',
      [envelope.workspace_uuid]
    );
    const current = BigInt(cursor ? cursor.sequence : '0');
    if (BigInt(envelope.sequence) !== current + 1n) {
      throw error('noncontiguous_replication', 'Journal replication envelope is noncontiguous');
    }
    await project(tx, envelope);
    const appliedAt = now();
    await run(
      tx,
      'INSERT INTO journal_replication_applied(' +
        'workspace_uuid,sequence,kind,payload_sha256,recorded_at,applied_at' +
      ') VALUES(?,?,?,?,?,?)',
      [
        envelope.workspace_uuid, envelope.sequence, envelope.kind,
        envelope.payload_sha256, envelope.recorded_at, appliedAt,
      ]
    );
    await run(
      tx,
      'INSERT INTO journal_replication_cursor(workspace_uuid,sequence,payload_sha256,updated_at) ' +
        'VALUES(?,?,?,?) ON CONFLICT(workspace_uuid) DO UPDATE SET ' +
        'sequence=excluded.sequence,payload_sha256=excluded.payload_sha256,updated_at=excluded.updated_at',
      [envelope.workspace_uuid, envelope.sequence, envelope.payload_sha256, appliedAt]
    );
    return { sequence: envelope.sequence, replayed: false };
  });
}

function fileSha256(fsApi, filePath) {
  const digest = crypto.createHash('sha256');
  const descriptor = fsApi.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytes;
    do {
      bytes = fsApi.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes > 0) digest.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fsApi.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function fsyncPath(fsApi, filePath, directory) {
  if (typeof fsApi.fsyncSync !== 'function') return;
  const descriptor = fsApi.openSync(filePath, directory ? 'r' : 'r');
  try { fsApi.fsyncSync(descriptor); } finally { fsApi.closeSync(descriptor); }
}

async function publishDownloadedMedia(db, fsApi, input) {
  assertUuid(input && input.media_uuid, 'media_uuid');
  const generated = mediaPaths(fsApi, input && input.media_root, input.media_uuid);
  return transaction(db, async function(tx) {
    const row = await get(tx, 'SELECT * FROM journal_media_files WHERE media_uuid=?', [input.media_uuid]);
    if (!row) throw error('not_found', 'Journal media row was not found');
    if (row.local_path !== generated.final_path ||
        (row.partial_path !== null && row.partial_path !== generated.partial_path)) {
      throw error('invalid_media_path', 'Journal media path provenance is outside the configured media root');
    }
    rejectSymlink(fsApi, generated.partial_path);
    rejectSymlink(fsApi, generated.final_path);
    const recoveringPublishedFile = !fsApi.existsSync(generated.partial_path) &&
      fsApi.existsSync(generated.final_path);
    const verifiedPath = recoveringPublishedFile ? generated.final_path : generated.partial_path;
    if (!fsApi.existsSync(verifiedPath)) {
      throw error('incomplete_download', 'Neither partial nor published media bytes are available');
    }
    const stat = fsApi.statSync(verifiedPath);
    if (!stat.isFile() || stat.size !== row.size_bytes || row.received_bytes !== row.size_bytes) {
      throw error('incomplete_download', 'Received bytes do not match the declared media size');
    }
    const digest = fileSha256(fsApi, verifiedPath);
    if (digest !== row.sha256) throw error('hash_mismatch', 'Downloaded media SHA-256 mismatch');
    fsyncPath(fsApi, verifiedPath, false);
    if (!recoveringPublishedFile) fsApi.renameSync(generated.partial_path, generated.final_path);
    fsyncPath(fsApi, resolveMediaRoot(fsApi, input.media_root), true);
    await run(
      tx,
      'UPDATE journal_media_files SET replica_status=\'verified\',received_bytes=size_bytes,' +
        'partial_path=NULL,last_error=NULL,updated_at=? WHERE media_uuid=?',
      [now(), input.media_uuid]
    );
    return { media_uuid: input.media_uuid, sha256: digest, path: row.local_path };
  });
}

function normalizeServerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(raw); } catch (cause) {
    throw error('invalid_config', 'Journal cloud server URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw error('invalid_config', 'Journal cloud server URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function validateWorkerConfig(config, fsApi) {
  const value = config || {};
  assertGatewayEui(value.gateway_device_eui, 'gateway_device_eui');
  assertSha256(value.schema_fingerprint, 'schema_fingerprint');
  if (typeof value.sync_token !== 'string' || !value.sync_token.trim()) {
    throw error('invalid_config', 'Journal sync token is required');
  }
  if (typeof value.release_id !== 'string' || !value.release_id.trim() ||
      value.release_id.length > 120) {
    throw error('invalid_config', 'Journal release_id must contain 1 to 120 characters');
  }
  return {
    gateway_device_eui: value.gateway_device_eui,
    server_url: normalizeServerUrl(value.server_url),
    sync_token: value.sync_token.trim(),
    release_id: value.release_id.trim(),
    schema_fingerprint: value.schema_fingerprint,
    photo_cache_bytes: assertPositiveSafeInteger(value.photo_cache_bytes, 'photo_cache_bytes'),
    min_free_bytes: assertPositiveSafeInteger(value.min_free_bytes, 'min_free_bytes'),
    media_root: resolveMediaRoot(fsApi, value.media_root),
  };
}

function transient(message) {
  const value = error('transient_cloud_failure', message);
  value.retryable = true;
  return value;
}

async function cloudRequest(httpApi, request, acceptedStatuses) {
  let response;
  try { response = await httpApi.requestJsonIpv4(request); } catch (cause) {
    const failure = transient('Journal cloud request failed: ' + String(cause && cause.message || cause));
    failure.cause = cause;
    throw failure;
  }
  if (!response || !acceptedStatuses.includes(Number(response.statusCode))) {
    const status = Number(response && response.statusCode || 0);
    if (status === 0 || status === 429 || status >= 500) {
      throw transient('Journal cloud request returned HTTP ' + status);
    }
    throw error('cloud_protocol_failure', 'Journal cloud request returned HTTP ' + status);
  }
  return response.payload;
}

function gatewayEndpoint(config, suffix) {
  return config.server_url + '/api/v2/journal/gateways/' +
    encodeURIComponent(config.gateway_device_eui) + suffix;
}

function authHeaders(config) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.sync_token,
  };
}

async function persistCapability(db, config, capability) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability) ||
      capability.gateway_eui !== config.gateway_device_eui ||
      capability.release_id !== config.release_id ||
      typeof capability.schema_accepted !== 'boolean' ||
      typeof capability.edge_producer_ready !== 'boolean' ||
      typeof capability.cloud_issuer_enabled !== 'boolean' ||
      typeof capability.prepare_ready !== 'boolean') {
    throw error('invalid_capability', 'Journal cloud capability response is malformed');
  }
  assertSha256(capability.schema_fingerprint, 'capability.schema_fingerprint');
  const accepted = capability.schema_accepted && capability.edge_producer_ready &&
    capability.schema_fingerprint === config.schema_fingerprint;
  await run(
    db,
    'INSERT INTO journal_gateway_v2_capability(' +
      'gateway_device_eui,offered_fingerprint,accepted_fingerprint,capability_state,updated_at' +
    ') VALUES(?,?,?,?,?) ON CONFLICT(gateway_device_eui) DO UPDATE SET ' +
      'offered_fingerprint=excluded.offered_fingerprint,' +
      'accepted_fingerprint=excluded.accepted_fingerprint,' +
      'capability_state=excluded.capability_state,updated_at=excluded.updated_at',
    [
      config.gateway_device_eui, config.schema_fingerprint,
      accepted ? config.schema_fingerprint : null, accepted ? 'accepted' : 'rejected', now(),
    ]
  );
  return Object.assign({}, capability, { locally_accepted: accepted });
}

async function oneCursor(db) {
  const rows = await all(
    db,
    'SELECT workspace_uuid,sequence FROM journal_replication_cursor ORDER BY workspace_uuid LIMIT 2',
    []
  );
  if (rows.length > 1) {
    throw error('ambiguous_workspace', 'Journal V2 worker has more than one local workspace cursor');
  }
  return rows.length === 1 ? rows[0] : null;
}

async function acknowledgeCursor(httpApi, config, sequence) {
  const ack = await cloudRequest(httpApi, {
    method: 'POST',
    url: gatewayEndpoint(config, '/replication/ack'),
    headers: authHeaders(config),
    payload: { committed_sequence: sequence },
    timeoutMs: 30000,
  }, [200]);
  if (!ack || ack.committed_sequence !== sequence) {
    throw error('invalid_replication_ack', 'Journal replication ACK response is malformed');
  }
}

function replicationDisabledByRuntime() {
  return String(process.env.JOURNAL_REPLICATION_DISABLE || '') === '1';
}

async function runReplicationTick(db, httpApi, fsApi, inputConfig) {
  // node-red.init sets JOURNAL_REPLICATION_DISABLE=1 whenever it could not
  // validate/create the configured journal media root (e.g. a leftover
  // symlink, a read-only or full parent). That failure must never stop
  // Node-RED from starting, so the init keeps starting the service and
  // instead disables this worker at the source. Honor that here, before
  // validateWorkerConfig() touches media_root or the byte limits, so this
  // quietly skips the tick every time instead of throwing every tick.
  if (replicationDisabledByRuntime()) {
    return {
      capability_state: 'disabled',
      sent_mutations: 0,
      applied_envelopes: 0,
      committed_sequence: null,
      photo_transfers: 0,
      evicted_media: 0,
    };
  }
  const config = validateWorkerConfig(inputConfig, fsApi);
  const capabilityPayload = await cloudRequest(httpApi, {
    method: 'POST',
    url: gatewayEndpoint(config, '/capabilities'),
    headers: authHeaders(config),
    payload: {
      release_id: config.release_id,
      schema_fingerprint: config.schema_fingerprint,
      schema_accepted: true,
      edge_producer_ready: true,
      advertised_at: now(),
    },
    timeoutMs: 30000,
  }, [200]);
  const capability = await persistCapability(db, config, capabilityPayload);

  let sentMutations = 0;
  let envelopes = [];
  let committedSequence = null;
  let appliedEnvelopes = 0;
  if (capability.locally_accepted) {
    const queued = await nextMutations(db, 10);
    for (const mutation of queued) {
      if (mutation.operation === 'CUTOVER_BARRIER_RECEIPT' &&
          (!capability.prepare_ready || !capability.cloud_issuer_enabled)) break;
      const outcome = await cloudRequest(httpApi, {
        method: 'POST',
        url: gatewayEndpoint(config, '/mutations'),
        headers: authHeaders(config),
        payload: mutation,
        timeoutMs: 30000,
      }, [200, 201, 409]);
      await recordOutcome(db, mutation.mutation_uuid, outcome);
      if (mutation.operation.startsWith('ENTRY_')) {
        await bindPendingAttachments(db, mutation.mutation_uuid, outcome);
      }
      sentMutations += 1;
    }

    const cursor = await oneCursor(db);
    if (cursor) await acknowledgeCursor(httpApi, config, cursor.sequence);
    const after = cursor ? cursor.sequence : '0';
    envelopes = await cloudRequest(httpApi, {
      method: 'GET',
      url: gatewayEndpoint(config, '/replication?after=' + encodeURIComponent(after) + '&limit=100'),
      headers: authHeaders(config),
      timeoutMs: 30000,
    }, [200]);
    if (!Array.isArray(envelopes)) {
      throw error('invalid_replication_page', 'Journal replication page must be an array');
    }
    for (const envelope of envelopes) {
      canonicalizer.validateReplication(envelope);
      if (envelope.kind === 'AUTHORITY_STATE' && !capability.cloud_issuer_enabled) break;
      await applyEnvelope(db, envelope);
      committedSequence = envelope.sequence;
      appliedEnvelopes += 1;
    }
    if (committedSequence !== null) {
      await acknowledgeCursor(httpApi, config, committedSequence);
    }
  }

  const cache = await enforcePhotoCache(db, fsApi, {
    max_bytes: config.photo_cache_bytes,
    min_free_bytes: config.min_free_bytes,
    cache_root: config.media_root,
  });
  return {
    capability_state: capability.locally_accepted ? 'accepted' : 'rejected',
    sent_mutations: sentMutations,
    applied_envelopes: appliedEnvelopes,
    committed_sequence: committedSequence,
    photo_transfers: 0,
    evicted_media: cache.evicted_media_uuids.length,
  };
}

function freeBytes(fsApi, filePath) {
  if (!fsApi || typeof fsApi.statfsSync !== 'function') {
    const failure = error('media_statfs_failed', 'Journal media free-space facts are unavailable');
    failure.retryable = true;
    throw failure;
  }
  let facts;
  try { facts = fsApi.statfsSync(filePath); } catch (cause) {
    const failure = error(
      'media_statfs_failed',
      'Journal media free-space check failed: ' + String(cause && cause.message || cause)
    );
    failure.retryable = true;
    throw failure;
  }
  const available = Number(facts.bavail) * Number(facts.bsize);
  if (!Number.isFinite(available) || available < 0) {
    const failure = error('media_statfs_failed', 'Journal media free-space facts are invalid');
    failure.retryable = true;
    throw failure;
  }
  return available;
}

function existingFileBytes(fsApi, filePath) {
  if (!filePath || !fsApi.existsSync(filePath)) return 0;
  const facts = fsApi.statSync(filePath);
  if (!facts.isFile() || !Number.isSafeInteger(facts.size) || facts.size < 0) {
    throw error('invalid_media_path', 'Journal media path must be a regular file with a safe size');
  }
  return facts.size;
}

function cacheEligible(row, parent, replicaStatus) {
  return row && Number(row.pinned) === 0 && Number(row.conflict_bound) === 0 &&
    row.parent_revision_uuid && row.replica_status === replicaStatus &&
    row.cloud_replica_status === 'verified' && row.cloud_verified_sha256 === row.sha256 &&
    (!row.parent_mutation_uuid ||
      (parent && ['applied', 'already-applied'].includes(parent.status)));
}

async function enforcePhotoCache(db, fsApi, policy) {
  const maxBytes = Number(policy && policy.max_bytes);
  const minFreeBytes = Number(policy && policy.min_free_bytes || 0);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) {
    throw error('invalid_cache_policy', 'Photo cache byte limits must be nonnegative safe integers');
  }
  const rows = await all(
    db,
    'SELECT m.* FROM journal_media_files AS m LEFT JOIN journal_edge_mutations AS q ' +
      'ON q.mutation_uuid=m.parent_mutation_uuid ORDER BY m.last_accessed_at,m.media_uuid',
    []
  );
  const cacheRoot = resolveMediaRoot(fsApi, policy && policy.cache_root);
  for (const row of rows) {
    const generated = mediaPaths(fsApi, cacheRoot, row.media_uuid);
    if (row.local_path !== generated.final_path ||
        (row.partial_path !== null && row.partial_path !== generated.partial_path)) {
      throw error('invalid_media_path', 'Journal media path provenance is outside the configured media root');
    }
    rejectSymlink(fsApi, row.local_path);
    if (row.partial_path) rejectSymlink(fsApi, row.partial_path);
  }
  const retainedByMedia = new Map();
  let totalBytes = 0;
  for (const row of rows) {
    const paths = Array.from(new Set([row.local_path, row.partial_path].filter(Boolean)));
    const retained = paths.reduce(function(sum, filePath) {
      return sum + existingFileBytes(fsApi, filePath);
    }, 0);
    retainedByMedia.set(row.media_uuid, retained);
    totalBytes += retained;
  }
  const evicted = [];
  let free = freeBytes(fsApi, cacheRoot);
  for (const row of rows) {
    if (row.replica_status === 'evicted_verified') {
      const current = await get(db, 'SELECT * FROM journal_media_files WHERE media_uuid=?', [row.media_uuid]);
      const currentParent = current && current.parent_mutation_uuid
        ? await get(db, 'SELECT status FROM journal_edge_mutations WHERE mutation_uuid=?',
          [current.parent_mutation_uuid])
        : null;
      if (cacheEligible(current, currentParent, 'evicted_verified') &&
          fsApi.existsSync(current.local_path)) {
        const removedBytes = existingFileBytes(fsApi, current.local_path);
        fsApi.unlinkSync(current.local_path);
        totalBytes -= removedBytes;
        retainedByMedia.set(
          current.media_uuid,
          Math.max(0, Number(retainedByMedia.get(current.media_uuid) || 0) - removedBytes)
        );
        free = freeBytes(fsApi, cacheRoot);
      }
      continue;
    }
    if (totalBytes <= maxBytes && free >= minFreeBytes) break;
    const parent = row.parent_mutation_uuid
      ? await get(db, 'SELECT status FROM journal_edge_mutations WHERE mutation_uuid=?', [row.parent_mutation_uuid])
      : null;
    const eligible = cacheEligible(row, parent, 'verified');
    if (!eligible) continue;
    let markedEvicted = false;
    await transaction(db, async function(tx) {
      const current = await get(tx, 'SELECT * FROM journal_media_files WHERE media_uuid=?', [row.media_uuid]);
      const currentParent = current && current.parent_mutation_uuid
        ? await get(tx, 'SELECT status FROM journal_edge_mutations WHERE mutation_uuid=?',
          [current.parent_mutation_uuid])
        : null;
      if (!cacheEligible(current, currentParent, 'verified')) return;
      await run(
        tx,
        "UPDATE journal_media_files SET replica_status='evicted_verified',received_bytes=0," +
          'updated_at=? WHERE media_uuid=?',
        [now(), current.media_uuid]
      );
      markedEvicted = true;
    });
    if (markedEvicted) {
      const removedBytes = existingFileBytes(fsApi, row.local_path);
      if (removedBytes > 0) {
        fsApi.unlinkSync(row.local_path);
        totalBytes -= removedBytes;
        retainedByMedia.set(
          row.media_uuid,
          Math.max(0, Number(retainedByMedia.get(row.media_uuid) || 0) - removedBytes)
        );
        evicted.push(row.media_uuid);
        free = freeBytes(fsApi, cacheRoot);
      }
    }
  }
  return { evicted_media_uuids: evicted, retained_bytes: Math.max(0, totalBytes) };
}

module.exports = {
  applyEnvelope,
  bindPendingAttachments,
  enforcePhotoCache,
  enqueueMutation,
  mediaPaths,
  nextMutations,
  publishDownloadedMedia,
  recordOutcome,
  resolveMediaRoot,
  runReplicationTick,
};
