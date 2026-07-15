#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const journal = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const ENTRY_COUNT = 10_000;
const VALUE_COUNT = 150_000;
const VALUES_PER_ENTRY = VALUE_COUNT / ENTRY_COUNT;
const LIST_LIMIT_MS = 100;
const RSS_LIMIT_BYTES = 64 * 1024 * 1024;
const WIDE_EXPORT_MAX_WRITE_BYTES = 64 * 1024;
const ADVERSARIAL_ENTRY_COUNT = 50;
const ADVERSARIAL_VALUES_PER_ENTRY = 128;
const OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLOT_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ZONE_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GATEWAY_EUI = '0016C001F1000001';
const OCCURRED_FIRST = '2026-01-01T00:00:00.000Z';
const OCCURRED_LAST = new Date(Date.parse(OCCURRED_FIRST) + (ENTRY_COUNT - 1) * 60_000).toISOString();

function entryUuid(index) {
  return '10000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
}

function principal() {
  return {
    user_id: 1,
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: OWNER_UUID,
    author_label: 'fixture-user',
    gateway_device_eui: GATEWAY_EUI,
    origin: 'edge-ui',
  };
}

function seedFixture(db) {
  db.exec(SEED);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=OFF; BEGIN IMMEDIATE;');
  try {
    db.prepare(
      'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES (?,?,?,?,?)'
    ).run(1, 'fixture-user', 'unused', OCCURRED_FIRST, OWNER_UUID);
    db.prepare(
      'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) ' +
        'VALUES (?,?,?,?,?,?)'
    ).run(1, 'Performance Field', 1, 'UTC', ZONE_UUID, GATEWAY_EUI);
    db.prepare(
      'INSERT INTO journal_plots(' +
        'plot_uuid,plot_code,name,zone_uuid,area_m2,active,sync_version,gateway_device_eui,' +
        'created_at,updated_at,owner_user_uuid' +
      ') VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      PLOT_UUID,
      'PERF-01',
      'Performance Field',
      ZONE_UUID,
      10_000,
      1,
      1,
      GATEWAY_EUI,
      OCCURRED_FIRST,
      OCCURRED_FIRST,
      OWNER_UUID
    );
    db.prepare(
      'INSERT INTO journal_plot_settings(' +
        'plot_uuid,layout_code,updated_at,updated_by_principal_uuid,sync_version' +
      ') VALUES (?,?,?,?,?)'
    ).run(PLOT_UUID, 'open_field', OCCURRED_FIRST, OWNER_UUID, 1);

    const insertEntry = db.prepare(
      'INSERT INTO journal_entries(' +
        'entry_uuid,owner_user_uuid,user_id,author_principal_uuid,author_label,' +
        'plot_uuid,zone_id,zone_uuid,activity_code,template_code,template_version,' +
        'layout_code,layout_version,catalog_version,occurred_start,occurred_timezone,' +
        'occurred_utc_offset_minutes,recorded_at,origin,status,sync_version,' +
        'gateway_device_eui,created_at,updated_at' +
      ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const insertValue = db.prepare(
      'INSERT INTO journal_entry_values(' +
        'entry_uuid,attribute_code,group_index,value_status,value_num,unit_code,' +
        'entered_value_num,entered_unit_code' +
      ') VALUES (?,?,?,?,?,?,?,?)'
    );
    const insertPerfAttribute = db.prepare(
      'INSERT INTO journal_vocab(' +
        'code,kind,value_type,labels_json,scope,active,sort_order,sync_version,created_at' +
      ') VALUES (?,?,?,?,?,?,?,?,?)'
    );
    for (let valueIndex = 0; valueIndex < VALUES_PER_ENTRY; valueIndex += 1) {
      insertPerfAttribute.run(
        'attr.perf_' + String(valueIndex).padStart(2, '0'),
        'attribute',
        'number',
        JSON.stringify({ en: 'Performance value ' + valueIndex }),
        'core',
        1,
        valueIndex,
        1,
        OCCURRED_FIRST
      );
    }

    const firstMs = Date.parse(OCCURRED_FIRST);
    for (let entryIndex = 0; entryIndex < ENTRY_COUNT; entryIndex += 1) {
      const uuid = entryUuid(entryIndex);
      const occurredAt = new Date(firstMs + entryIndex * 60_000).toISOString();
      const recordedAt = new Date(firstMs + entryIndex * 60_000 + 30_000).toISOString();
      insertEntry.run(
        uuid,
        OWNER_UUID,
        1,
        OWNER_UUID,
        'fixture-user',
        PLOT_UUID,
        1,
        ZONE_UUID,
        'irrigation',
        'farmer_quick',
        1,
        'open_field',
        1,
        1,
        occurredAt,
        'UTC',
        0,
        recordedAt,
        'edge-ui',
        'final',
        1,
        GATEWAY_EUI,
        recordedAt,
        recordedAt
      );
      for (let valueIndex = 0; valueIndex < VALUES_PER_ENTRY; valueIndex += 1) {
        const value = entryIndex + valueIndex / 100;
        insertValue.run(
          uuid,
          'attr.perf_' + String(valueIndex).padStart(2, '0'),
          0,
          'observed',
          value,
          'unit.mm_water',
          value,
          'unit.mm_water'
        );
      }
    }
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw error;
  } finally {
    db.exec('PRAGMA synchronous=NORMAL;');
  }
}

function fixtureCounts(db) {
  const perEntry = db.prepare(
    'SELECT MIN(value_count) AS minimum,MAX(value_count) AS maximum FROM (' +
      'SELECT entry_uuid,COUNT(*) AS value_count FROM journal_entry_values GROUP BY entry_uuid' +
    ')'
  ).get();
  return {
    entries: Number(db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count),
    finalEntries: Number(
      db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE status='final'").get().count
    ),
    values: Number(db.prepare('SELECT COUNT(*) AS count FROM journal_entry_values').get().count),
    observedNumericValues: Number(
      db.prepare(
        "SELECT COUNT(*) AS count FROM journal_entry_values WHERE value_status='observed' " +
          'AND value_num IS NOT NULL AND value_text IS NULL'
      ).get().count
    ),
    minimumValuesPerEntry: Number(perEntry.minimum),
    maximumValuesPerEntry: Number(perEntry.maximum),
  };
}

function explain(db, sql, params) {
  return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(function(row) {
    return String(row.detail);
  });
}

function planUsesSearch(plan, indexName) {
  const escaped = indexName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('\\bSEARCH\\s+\\S+\\s+USING\\s+(?:COVERING\\s+)?INDEX\\s+' + escaped + '\\b');
  return plan.some(function(detail) { return pattern.test(detail); });
}

function collectPlans(db) {
  const common = [OWNER_UUID, 1, GATEWAY_EUI];
  return {
    zone_time: {
      index: 'idx_journal_entries_zone_time',
      detail: explain(
        db,
        "SELECT e.* FROM journal_entries AS e WHERE e.owner_user_uuid=? AND e.user_id=? " +
          "AND e.gateway_device_eui=? AND e.deleted_at IS NULL AND e.status='final' " +
          'AND e.zone_id=? AND e.occurred_start BETWEEN ? AND ? ' +
          'ORDER BY e.occurred_start DESC,e.entry_uuid ASC LIMIT 50',
        common.concat([1, OCCURRED_FIRST, OCCURRED_LAST])
      ),
    },
    duplicate_guard: {
      index: 'idx_journal_entries_plot_duplicate',
      detail: explain(
        db,
        'SELECT entry_uuid,occurred_start,activity_code,plot_uuid FROM journal_entries ' +
          "WHERE plot_uuid=? AND activity_code=? AND status='final' AND deleted_at IS NULL " +
          'AND (? IS NULL OR entry_uuid<>?) AND occurred_start BETWEEN ? AND ? ' +
          'ORDER BY ABS(julianday(occurred_start)-julianday(?)),entry_uuid LIMIT 1',
        [PLOT_UUID, 'irrigation', null, null, OCCURRED_FIRST, OCCURRED_LAST, OCCURRED_LAST]
      ),
    },
    sticky_layout: {
      index: 'idx_journal_entries_plot_sticky',
      detail: explain(
        db,
        'SELECT layout_code,layout_version FROM journal_entries ' +
          "WHERE author_principal_uuid=? AND plot_uuid=? AND status='final' AND deleted_at IS NULL " +
          'ORDER BY recorded_at DESC,entry_uuid ASC LIMIT 1',
        [OWNER_UUID, PLOT_UUID]
      ),
    },
    gateway_time: {
      index: 'idx_journal_entries_gateway_time',
      detail: explain(
        db,
        "SELECT e.* FROM journal_entries AS e WHERE e.owner_user_uuid=? AND e.user_id=? " +
          "AND e.gateway_device_eui=? AND e.deleted_at IS NULL AND e.status='final' " +
          'AND e.occurred_start BETWEEN ? AND ? ' +
          'ORDER BY e.occurred_start DESC,e.entry_uuid ASC LIMIT 50',
        common.concat([OCCURRED_FIRST, OCCURRED_LAST])
      ),
    },
    plot_time: {
      // Mirrors buildEntryWhere()'s clause order for GET /entries?plot_uuid=X
      // with the default status='final' and no activity/author/zone filter.
      index: 'idx_journal_entries_plot_time',
      detail: explain(
        db,
        "SELECT e.* FROM journal_entries AS e WHERE e.owner_user_uuid=? AND e.user_id=? " +
          "AND e.gateway_device_eui=? AND e.deleted_at IS NULL AND e.status='final' " +
          'AND e.plot_uuid=? ' +
          'ORDER BY e.occurred_start DESC,e.entry_uuid ASC LIMIT 50',
        common.concat([PLOT_UUID])
      ),
    },
  };
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

async function measureKeysetPage(db) {
  const filters = {
    zone_uuid: ZONE_UUID,
    status: 'final',
    occurred_from: OCCURRED_FIRST,
    occurred_to: OCCURRED_LAST,
    limit: 50,
  };
  const firstPage = await journal.listEntries(db, filters, principal());
  assert.equal(firstPage.entries.length, 50, 'warm first page must contain 50 entries');
  assert.ok(firstPage.next_cursor, 'warm first page must produce a keyset cursor');
  const pagedFilters = Object.assign({}, filters, { cursor: firstPage.next_cursor });

  // Warm the exact second-page query before timing it, then assert the slowest
  // of five runs so one fast sample cannot hide a regression.
  const warmPage = await journal.listEntries(db, pagedFilters, principal());
  assert.equal(warmPage.entries.length, 50, 'warm keyset page must contain 50 entries');

  const durations = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const start = process.hrtime.bigint();
    const page = await journal.listEntries(db, pagedFilters, principal());
    durations.push(elapsedMs(start));
    assert.equal(page.entries.length, 50, 'measured keyset page must contain 50 entries');
  }
  return {
    rows: 50,
    durations,
    maxDurationMs: Math.max(...durations),
  };
}

class CountingCsvSink {
  constructor(baselineRss) {
    this.baselineRss = baselineRss;
    this.maxRss = baselineRss;
    this.bytes = 0;
    this.records = 0;
    this.writes = 0;
    this.maxWriteBytes = 0;
    this.writeBytes = [];
    this.recordsPerWrite = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.pendingCarriageReturnWriteIndex = null;
  }

  sampleRss() {
    this.maxRss = Math.max(this.maxRss, process.memoryUsage().rss);
  }

  write(chunk) {
    this.sampleRss();
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(text, 'utf8');
    const writeIndex = this.recordsPerWrite.length;
    this.recordsPerWrite.push(0);
    this.bytes += bytes;
    this.writes += 1;
    this.maxWriteBytes = Math.max(this.maxWriteBytes, bytes);
    this.writeBytes.push(bytes);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (this.pendingCarriageReturnWriteIndex != null && code === 10) {
        this.records += 1;
        this.recordsPerWrite[this.pendingCarriageReturnWriteIndex] += 1;
      }
      this.pendingCarriageReturnWriteIndex = code === 13 ? writeIndex : null;
    }
    this.sampleRss();
    return true;
  }

  end() {
    this.writableEnded = true;
    this.sampleRss();
  }

  get rssGrowthBytes() {
    return Math.max(0, this.maxRss - this.baselineRss);
  }
}

function assertCsvStreamShape(metrics) {
  assert.ok(Array.isArray(metrics.recordsPerWrite), 'CSV sink must record CRLF counts per write');
  assert.equal(metrics.recordsPerWrite[0], 1, 'CSV header write must contain exactly 1 record');
  const dataWrites = metrics.recordsPerWrite.slice(1).map(function(count, index) {
    return { count, writeNumber: index + 2 };
  }).filter(function(write) {
    return write.count > 0;
  });
  for (const write of dataWrites) {
    assert.ok(
      write.count >= 1 && write.count <= 50,
      'CSV data write ' + write.writeNumber +
        ' contains ' + write.count + ' records; expected 1..50'
    );
  }
  const minimumDataWrites = Math.ceil(ENTRY_COUNT / 50);
  assert.ok(
    dataWrites.length >= minimumDataWrites,
    'CSV used ' + dataWrites.length +
      ' record-bearing data writes; expected at least ' + minimumDataWrites
  );
  const countedRecords = metrics.recordsPerWrite.reduce(function(total, count) {
    return total + count;
  }, 0);
  assert.equal(countedRecords, metrics.records, 'per-write CRLF counts must equal total records');
  return {
    dataWriteCount: dataWrites.length,
    maxRecordsPerDataWrite: Math.max(...dataWrites.map(function(write) { return write.count; })),
  };
}

function assertBoundedCsvWrites(metrics, label) {
  assert.ok(Array.isArray(metrics.writeBytes), label + ' must record bytes per sink write');
  assert.ok(
    metrics.writeBytes.every(function(bytes) { return bytes <= WIDE_EXPORT_MAX_WRITE_BYTES; }),
    label + ' wrote a ' + metrics.maxWriteBytes + '-byte chunk; maximum is 65536 bytes'
  );
}

function verifyStreamShapeNegativeControl() {
  const splitCrLf = new CountingCsvSink(process.memoryUsage().rss);
  splitCrLf.write('header\r');
  splitCrLf.write('\ndata\r');
  splitCrLf.write('\n');
  assert.equal(splitCrLf.records, 2, 'split CRLF sequences must count once each');
  assert.deepEqual(
    splitCrLf.recordsPerWrite,
    [1, 1, 0],
    'a split CRLF must be attributed to the write where its carriage return began'
  );
  const buffered = {
    records: ENTRY_COUNT + 1,
    recordsPerWrite: [1, ENTRY_COUNT],
  };
  assert.throws(
    function() { assertCsvStreamShape(buffered); },
    function(error) {
      return error && /CSV data write 2 contains 10000 records; expected 1\.\.50/.test(error.message);
    },
    'stream-shape validator must reject a header followed by one buffered data write'
  );
  console.log('stream-shape negative control: rejected header + one 10000-row buffered write');
}

async function measureCsv(db) {
  // The list measurement above warms module and page-cache initialization. The
  // export itself is not pre-run: RSS growth covers its first full 10k-row scan.
  await new Promise(function(resolve) { setImmediate(resolve); });
  const baselineRss = process.memoryUsage().rss;
  const sink = new CountingCsvSink(baselineRss);
  const monitor = setInterval(function() { sink.sampleRss(); }, 5);
  monitor.unref();
  const start = process.hrtime.bigint();
  let result;
  try {
    result = await journal.exportWideCsv(db, { status: 'final' }, principal(), sink);
  } finally {
    clearInterval(monitor);
    sink.sampleRss();
  }
  return {
    result,
    records: sink.records,
    recordsPerWrite: sink.recordsPerWrite.slice(),
    bytes: sink.bytes,
    writes: sink.writes,
    maxWriteBytes: sink.maxWriteBytes,
    writeBytes: sink.writeBytes.slice(),
    ended: sink.writableEnded,
    durationMs: elapsedMs(start),
    rssGrowthBytes: sink.rssGrowthBytes,
  };
}

function adversarialCustomUuid(index) {
  return '73000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
}

function seedAdversarialWideFixture(db) {
  const insertVocab = db.prepare(
    'INSERT INTO journal_vocab(' +
      'code,kind,value_type,labels_json,scope,owner_user_uuid,gateway_device_eui,' +
      'custom_field_uuid,active,sort_order,sync_version,created_at' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insertEntry = db.prepare(
    'INSERT INTO journal_entries(' +
      'entry_uuid,owner_user_uuid,user_id,author_principal_uuid,author_label,' +
      'plot_uuid,zone_id,zone_uuid,activity_code,template_code,template_version,' +
      'layout_code,layout_version,catalog_version,occurred_start,occurred_timezone,' +
      'occurred_utc_offset_minutes,recorded_at,origin,status,sync_version,' +
      'gateway_device_eui,created_at,updated_at' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insertValue = db.prepare(
    'INSERT INTO journal_entry_values(' +
      'entry_uuid,attribute_code,group_index,value_status,value_text' +
    ') VALUES (?,?,?,?,?)'
  );
  db.exec('PRAGMA synchronous=OFF; BEGIN IMMEDIATE;');
  try {
    let cellIndex = 0;
    for (let entryIndex = 0; entryIndex < ADVERSARIAL_ENTRY_COUNT; entryIndex += 1) {
      const entryUuidValue = '74000000-0000-4000-8000-' +
        entryIndex.toString(16).padStart(12, '0');
      const occurredAt = new Date(Date.parse(OCCURRED_LAST) + (entryIndex + 1) * 60_000).toISOString();
      insertEntry.run(
        entryUuidValue,
        OWNER_UUID,
        1,
        OWNER_UUID,
        'fixture-user',
        PLOT_UUID,
        1,
        ZONE_UUID,
        'general_observation',
        'farmer_quick',
        1,
        'open_field',
        1,
        1,
        occurredAt,
        'UTC',
        0,
        occurredAt,
        'edge-ui',
        'final',
        1,
        GATEWAY_EUI,
        occurredAt,
        occurredAt
      );
      for (let valueIndex = 0; valueIndex < ADVERSARIAL_VALUES_PER_ENTRY; valueIndex += 1) {
        const customUuid = adversarialCustomUuid(cellIndex + 1);
        const code = 'custom.' + customUuid;
        insertVocab.run(
          code,
          'attribute',
          'text',
          JSON.stringify({ en: 'Adversarial field ' + cellIndex }),
          'custom',
          OWNER_UUID,
          GATEWAY_EUI,
          customUuid,
          1,
          cellIndex,
          1,
          occurredAt
        );
        insertValue.run(entryUuidValue, code, valueIndex % 32, 'observed', 'x');
        cellIndex += 1;
      }
    }
    db.exec('COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw error;
  } finally {
    db.exec('PRAGMA synchronous=NORMAL;');
  }
}

async function measureAdversarialWideCsv(db) {
  const sink = new CountingCsvSink(process.memoryUsage().rss);
  let result;
  let error = null;
  const start = process.hrtime.bigint();
  try {
    result = await journal.exportWideCsv(
      db,
      { status: 'final', activity_code: 'general_observation' },
      principal(),
      sink
    );
  } catch (caught) {
    error = caught;
  }
  return {
    result,
    errorCode: error && error.code,
    errorStatus: error && error.statusCode,
    fallbackExport: error && error.details && error.details.fallback_export,
    writes: sink.writes,
    bytes: sink.bytes,
    maxWriteBytes: sink.maxWriteBytes,
    writeBytes: sink.writeBytes.slice(),
    ended: sink.writableEnded,
    durationMs: elapsedMs(start),
  };
}

async function main() {
  verifyStreamShapeNegativeControl();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-perf-'));
  const dbPath = path.join(tempRoot, 'fixture.db');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    seedFixture(db);

    const counts = fixtureCounts(db);
    assert.deepEqual(counts, {
      entries: ENTRY_COUNT,
      finalEntries: ENTRY_COUNT,
      values: VALUE_COUNT,
      observedNumericValues: VALUE_COUNT,
      minimumValuesPerEntry: VALUES_PER_ENTRY,
      maximumValuesPerEntry: VALUES_PER_ENTRY,
    });
    console.log('fixture: entries=' + counts.entries + ' values=' + counts.values);

    const plans = collectPlans(db);
    const failures = [];
    for (const [name, plan] of Object.entries(plans)) {
      console.log('plan ' + name + ': ' + plan.detail.join(' | '));
      if (!planUsesSearch(plan.detail, plan.index)) {
        failures.push(name + ' did not SEARCH USING INDEX ' + plan.index);
      }
    }

    const list = await measureKeysetPage(db);
    console.log(
      'listEntries: rows=' + list.rows +
      ' max_ms=' + list.maxDurationMs.toFixed(3) +
      ' samples_ms=' + list.durations.map(function(value) { return value.toFixed(3); }).join(',')
    );
    if (!(list.maxDurationMs < LIST_LIMIT_MS)) {
      failures.push('keyset list max ' + list.maxDurationMs.toFixed(3) + ' ms exceeded ' + LIST_LIMIT_MS + ' ms');
    }

    const csv = await measureCsv(db);
    let streamShape;
    try {
      streamShape = assertCsvStreamShape(csv);
      assertBoundedCsvWrites(csv, 'normal wide CSV');
    } catch (error) {
      failures.push(error && error.message ? error.message : String(error));
    }
    const rssGrowthMiB = csv.rssGrowthBytes / (1024 * 1024);
    console.log(
      'exportWideCsv: records=' + csv.records +
      ' bytes=' + csv.bytes +
      ' writes=' + csv.writes +
      ' max_write_bytes=' + csv.maxWriteBytes +
      ' data_writes=' + (streamShape ? streamShape.dataWriteCount : 'invalid') +
      ' max_records_per_data_write=' + (streamShape ? streamShape.maxRecordsPerDataWrite : 'invalid') +
      ' duration_ms=' + csv.durationMs.toFixed(3) +
      ' rss_growth_mib=' + rssGrowthMiB.toFixed(3)
    );
    if (csv.result !== null) failures.push('streamed CSV returned a collected result');
    if (!csv.ended) failures.push('streamed CSV did not end the sink');
    if (csv.records !== ENTRY_COUNT + 1) {
      failures.push('streamed CSV wrote ' + csv.records + ' records; expected ' + (ENTRY_COUNT + 1));
    }
    if (csv.rssGrowthBytes > RSS_LIMIT_BYTES) {
      failures.push('streamed CSV RSS growth ' + rssGrowthMiB.toFixed(3) + ' MiB exceeded 64 MiB');
    }

    seedAdversarialWideFixture(db);
    const adversarial = await measureAdversarialWideCsv(db);
    console.log(
      'exportWideCsv adversarial: entries=' + ADVERSARIAL_ENTRY_COUNT +
      ' values_per_entry=' + ADVERSARIAL_VALUES_PER_ENTRY +
      ' error=' + (adversarial.errorCode || 'none') +
      ' writes=' + adversarial.writes +
      ' bytes=' + adversarial.bytes +
      ' max_write_bytes=' + adversarial.maxWriteBytes +
      ' duration_ms=' + adversarial.durationMs.toFixed(3)
    );
    if (adversarial.errorCode !== 'wide_export_too_wide' || adversarial.errorStatus !== 413) {
      failures.push(
        '50x128 disjoint-cell export returned ' + (adversarial.errorCode || 'success') +
          '; expected 413 wide_export_too_wide'
      );
    }
    if (adversarial.fallbackExport !== '/api/journal/export.package') {
      failures.push('wide-export rejection did not direct clients to /api/journal/export.package');
    }
    if (adversarial.writes !== 0 || adversarial.bytes !== 0) {
      failures.push(
        '50x128 disjoint-cell export wrote ' + adversarial.bytes + ' bytes in ' +
          adversarial.writes + ' writes before rejection'
      );
    }
    try {
      assertBoundedCsvWrites(adversarial, 'adversarial wide CSV');
    } catch (error) {
      failures.push(error && error.message ? error.message : String(error));
    }

    if (failures.length) {
      throw new Error('journal performance fixture failed:\n- ' + failures.join('\n- '));
    }
    console.log('test-journal-perf-fixture: PASS');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
