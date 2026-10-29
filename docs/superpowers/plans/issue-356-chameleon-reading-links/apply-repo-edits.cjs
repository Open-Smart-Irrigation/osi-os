#!/usr/bin/env node
// Issue #356 one-shot repository editor (plan r4). Run from the repo root of
// the implementation checkout, through the campaign heavy wrapper, one phase
// per invocation:
//   node <packet-dir>/apply-repo-edits.cjs <packet-dir> schema <V>
//   node <packet-dir>/apply-repo-edits.cjs <packet-dir> persistence
//   node <packet-dir>/apply-repo-edits.cjs <packet-dir> verifiers <B>
//   node <packet-dir>/apply-repo-edits.cjs <packet-dir> ratchets <B>
//   node <packet-dir>/apply-repo-edits.cjs <packet-dir> identity-pins <B>
//   node <packet-dir>/apply-repo-edits.cjs <packet-dir> docs-ci
// <V> is the migration version the committed plan binds; <B> is the full SHA
// of the execution base. Every edit is anchored: the editor refuses when an
// anchor is missing or repeated, when the edit is already present, when an
// edited file differs from its <B> version beforehand, or when a JSON file does
// not round-trip, and writes nothing in that case.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = process.cwd();
const PACKET_DIR = path.resolve(process.argv[2] || '');
const PHASE = process.argv[3] || '';
const ARG = process.argv[4] || '';

// The committed plan binds this version (parent allocation on base f6682ef6).
const BOUND_VERSION = '0078';
const MIGRATION_RESOURCE = { file: 'chameleon-reading-links.sql', sha256: 'fd3aa7872f9bdda436a386d0a040543b76bf393c459b73f1c9c158fa706743fa' };
const SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const QUERY_ID = 'd0b2b1c1a937e16d';
// Exact per-node growth from apply-flow-edits.cjs (base f6682ef6 bodies).
const NODE_DELTAS = {
  d0b2b1c1a937e16d: 2171,
  'chameleon-readings-insert-fn': 2011,
  '460e0bfd95f89e67': 172,
  d20948dd9120a3d2: 994,
};
const NODE_REASONS = {
  d0b2b1c1a937e16d: 'Issue #356 durable Chameleon diagnostic link: the legacy threshold scheduler query admits a Chameleon row only through chameleon_reading_links, applies the linked diagnostic row and channel faults, and bounds each channel by source (0..300 kPa Chameleon, 0..1,000,000 kPa otherwise).',
  'chameleon-readings-insert-fn': 'Issue #356 durable Chameleon diagnostic link: Insert Chameleon Reading writes the diagnostic with INSERT ... RETURNING id and its chameleon_reading_links row in one scoped db.transaction, and reports a refused link or a failed transaction visibly.',
  '460e0bfd95f89e67': 'Issue #356 durable Chameleon diagnostic link: LSN50 Normalize + Write exposes its own device_data id as d.deviceDataId for the link.',
  d20948dd9120a3d2: 'Issue #356 durable Chameleon diagnostic link: calibration-local-backfill runs in one scoped db.transaction, fills a linked row only from its own linked diagnostic, keeps the device/time fill for unlinked pre-link rows without linking them, and updates device_data by id.',
};
const SILENT_CATCHES_REMOVED = 3;
const IDENTITY_PATH = 'scripts/verify-live-gateway-identity.js';
const ALLOWANCES_PATH = 'scripts/verify-flows-size-ratchet-allowances.json';
const CATCH_PATH = 'scripts/fixtures/silent-catch-baseline.json';
const PROVENANCE_MARK = ' Issue #356 durable Chameleon diagnostic link: ';

function fail(message) { console.error('apply-repo-edits ' + PHASE + ': ' + message); process.exit(2); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function rel(p) { return path.join(ROOT, p); }
function read(p) { return fs.readFileSync(rel(p), 'utf8'); }
function count(haystack, needle) { return haystack.split(needle).length - 1; }
function requireSha(ref) { if (!/^[0-9a-f]{40}$/.test(ref)) fail('base must be a full 40-character commit SHA'); }
function atBase(ref, p) {
  return execFileSync('git', ['-C', ROOT, 'show', ref + ':' + p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
// An edited file must still be its base version, so the anchors bind to <B>.
function readUnchangedSinceBase(ref, p) {
  const text = read(p);
  if (text !== atBase(ref, p)) fail(p + ' differs from its ' + ref.slice(0, 9) + ' version before this phase');
  return text;
}

// Pending writes are applied only after every check of the phase passed.
const pending = [];
function stage(p, text) { pending.push({ p, text }); }
function commit() {
  for (const { p, text } of pending) fs.writeFileSync(rel(p), text);
  for (const { p } of pending) console.log('apply-repo-edits ' + PHASE + ': wrote ' + p + ' sha256 ' + sha256(fs.readFileSync(rel(p))));
  console.log('apply-repo-edits ' + PHASE + ': OK');
}

function insertAfter(text, anchor, insertion, label) {
  const n = count(text, anchor);
  if (n !== 1) fail(label + ': anchor found ' + n + ' times');
  return text.replace(anchor, () => anchor + insertion);
}
function insertBefore(text, anchor, insertion, label) {
  const n = count(text, anchor);
  if (n !== 1) fail(label + ': anchor found ' + n + ' times');
  return text.replace(anchor, () => insertion + anchor);
}
function replaceOnce(text, from, to, label) {
  const n = count(text, from);
  if (n !== 1) fail(label + ': anchor found ' + n + ' times');
  return text.replace(from, () => to);
}
function readJsonGuarded(p) {
  const raw = read(p);
  const parsed = JSON.parse(raw);
  if (JSON.stringify(parsed, null, 2) + '\n' !== raw) fail(p + ' does not round-trip as two-space JSON with one trailing newline');
  return parsed;
}
function jsonText(value) { return JSON.stringify(value, null, 2) + '\n'; }
function jsLiteral(s) {
  if (s.includes('\\') || (s.includes("'") && s.includes('"'))) fail('cannot quote ' + s);
  return s.includes("'") ? '"' + s + '"' : "'" + s + "'";
}
function functionBodies(flows) {
  const bodies = new Map();
  for (const n of flows) if (n && n.type === 'function' && typeof n.func === 'string') bodies.set(n.id, n.func);
  return bodies;
}

function phaseSchema(version) {
  if (version !== BOUND_VERSION) fail('the committed plan binds migration version ' + BOUND_VERSION + ', not ' + JSON.stringify(version));
  const dir = 'database/migrations/ordered';
  const names = fs.readdirSync(rel(dir)).filter((n) => /^\d{4}__.+\.sql$/.test(n));
  const highest = Math.max(...names.map((n) => Number(n.slice(0, 4))));
  if (Number(version) !== highest + 1) fail('version ' + version + ' is not the next contiguous version after ' + highest);
  if (names.some((n) => n.startsWith(version + '__'))) fail('version ' + version + ' is already used');
  if (names.some((n) => n.includes('chameleon_reading_links'))) fail('a chameleon_reading_links migration already exists');

  const raw = fs.readFileSync(path.join(PACKET_DIR, MIGRATION_RESOURCE.file));
  if (sha256(raw) !== MIGRATION_RESOURCE.sha256) fail(MIGRATION_RESOURCE.file + ' differs from its pinned SHA-256');
  const source = raw.toString('utf8');
  if (count(source, 'NNNN') !== 1 || source.split('\n')[1].indexOf('-- NNNN: ') !== 0) fail('migration placeholder is not exactly line 2');
  const migration = source.replace('-- NNNN: ', '-- ' + version + ': ');
  const migrationName = version + '__chameleon_reading_links.sql';
  stage(dir + '/' + migrationName, migration);

  const manifestPath = dir + '/CHECKSUMS.json';
  const manifest = readJsonGuarded(manifestPath);
  if (Object.prototype.hasOwnProperty.call(manifest, migrationName)) fail(migrationName + ' is already in CHECKSUMS.json');
  manifest[migrationName] = sha256(Buffer.from(migration, 'utf8'));
  stage(manifestPath, jsonText(manifest));

  const seedPath = 'database/seed-blank.sql';
  const seed = read(seedPath);
  if (seed.includes('chameleon_reading_links')) fail(seedPath + ' already defines chameleon_reading_links');
  if (!seed.endsWith('\n')) fail(seedPath + ' must end with a newline');
  // Same body as the migration, without its risk header (precedent: 0074, 0077).
  stage(seedPath, seed + '\n' + migration.split('\n').slice(1).join('\n'));

  const parityPath = 'scripts/verify-runtime-schema-parity.js';
  const parity = read(parityPath);
  if (parity.includes('chameleon_reading_links')) fail(parityPath + ' already names chameleon_reading_links');
  stage(parityPath, insertAfter(parity, 'const MIGRATION_OWNED_TRIGGERS = new Map([\n',
    '  // ' + migrationName + ' (issue #356) guards the durable Chameleon diagnostic\n' +
    '  // link. These are integrity guards, not sync emitters: seed DB and\n' +
    '  // deploy-time migration runner delivery, never the frozen sync-init-fn boot DDL.\n' +
    "  ['trg_chameleon_reading_links_identity_bi', '" + migrationName + "'],\n" +
    "  ['trg_chameleon_reading_links_immutable_bu', '" + migrationName + "'],\n",
    parityPath));

  const consistencyPath = 'scripts/verify-db-schema-consistency.js';
  let consistency = read(consistencyPath);
  if (consistency.includes('chameleon_reading_links')) fail(consistencyPath + ' already names chameleon_reading_links');
  consistency = insertAfter(consistency, 'const schemaContract = {\n',
    '  chameleon_reading_links: ["chameleon_reading_id", "device_data_id", "linked_at"],\n', 'schemaContract');
  consistency = insertAfter(consistency, 'const requiredIndexes = {\n',
    "  chameleon_reading_links: ['ux_chameleon_reading_links_device_data'],\n", 'requiredIndexes');
  consistency = insertAfter(consistency, 'const requiredIndexSqlFragments = {\n',
    '  ux_chameleon_reading_links_device_data: [\n' +
    "    'unique index',\n" +
    "    'on chameleon_reading_links(device_data_id)',\n" +
    '  ],\n', 'requiredIndexSqlFragments');
  // normalizeSql() lowercases the stored SQL and collapses whitespace, so these
  // fragments are lowercase and single-spaced.
  consistency = insertAfter(consistency, 'const requiredTriggerSqlFragments = {\n',
    '  trg_chameleon_reading_links_identity_bi: [\n' +
    "    'before insert on chameleon_reading_links',\n" +
    "    'join device_data dd on dd.deveui = cr.deveui',\n" +
    "    'where cr.id = new.chameleon_reading_id and dd.id = new.device_data_id',\n" +
    '    "select raise(abort, \'chameleon reading link must join rows of one device\')",\n' +
    '  ],\n' +
    '  trg_chameleon_reading_links_immutable_bu: [\n' +
    "    'before update on chameleon_reading_links',\n" +
    '    "select raise(abort, \'chameleon reading link is immutable\')",\n' +
    '  ],\n', 'requiredTriggerSqlFragments');
  stage(consistencyPath, consistency);
  commit();
}

function phasePersistence() {
  const p = 'scripts/verify-lsn50-chameleon-persistence.js';
  let text = read(p);
  if (text.includes('chameleon_reading_links')) fail(p + ' already names chameleon_reading_links');
  text = replaceOnce(text, '  let closeCount = 0;\n', '  let closeCount = 0;\n  let transactions = 0;\n', 'closeCount');
  text = replaceOnce(text,
    '    run(sql, params, callback) {\n' +
    '      writes.push({ dbPath: this.dbPath, sql, params });\n' +
    '      callback(null);\n' +
    '    }\n',
    '    run(sql, params, callback) {\n' +
    '      writes.push({ dbPath: this.dbPath, sql, params });\n' +
    '      callback(null);\n' +
    '    }\n' +
    '\n' +
    '    // Mirrors osi-db-helper: one queued BEGIN IMMEDIATE ... COMMIT whose scope\n' +
    '    // returns promises; INSERT ... RETURNING id answers with the write count.\n' +
    '    transaction(executor) {\n' +
    '      transactions += 1;\n' +
    '      const scope = {\n' +
    '        get: (sql, params) => { writes.push({ dbPath: this.dbPath, sql, params }); return Promise.resolve({ id: writes.length }); },\n' +
    '        run: (sql, params) => { writes.push({ dbPath: this.dbPath, sql, params }); return Promise.resolve(); },\n' +
    '      };\n' +
    '      return Promise.resolve().then(() => executor(scope));\n' +
    '    }\n',
    'FakeDatabase.run');
  text = replaceOnce(text,
    '  return { result, writes, statuses, errors, closeCount };\n',
    '  return { result, writes, statuses, errors, closeCount, transactions };\n', 'runFunctionNode return');
  text = insertAfter(text,
    "assertIncludes(chameleonInsert, 'return msg;', 'insert function passes through downstream flow');\n",
    "assertIncludes(chameleonInsert, 'INSERT INTO chameleon_reading_links', 'insert links its diagnostic to the uplink device_data row');\n" +
    "assertIncludes(chameleonInsert, 'await db.transaction(', 'insert writes the diagnostic and its link in one scoped transaction');\n",
    'static assertions');
  text = replaceOnce(text,
    "  console.log('LSN50 Chameleon persistence checks passed');\n",
    "  assert.strictEqual(normal.transactions, 1, 'normal write uses one scoped transaction');\n" +
    '\n' +
    '  // Issue #356: a message carrying its device_data id links the diagnostic.\n' +
    '  const linkedMsg = JSON.parse(JSON.stringify(normalMsg));\n' +
    '  linkedMsg.formattedData.deviceDataId = 77;\n' +
    "  const linked = await runFunctionNode('chameleon-readings-insert-fn', linkedMsg);\n" +
    "  assert.strictEqual(linked.result, linkedMsg, 'linked chameleon payload passes downstream');\n" +
    "  assert.strictEqual(linked.transactions, 1, 'diagnostic and link share one transaction');\n" +
    "  assert.strictEqual(linked.writes.length, 2, 'linked payload writes the diagnostic and its link');\n" +
    "  assert(linked.writes[0].sql.endsWith(' RETURNING id'), 'diagnostic insert returns its row id');\n" +
    "  assert(linked.writes[1].sql.includes('INSERT INTO chameleon_reading_links'), 'second write is the link');\n" +
    "  assert.strictEqual(linked.writes[1].params.length, 2, 'link has two parameters');\n" +
    "  assert.strictEqual(linked.writes[1].params[0], 1, 'link uses the returned diagnostic id');\n" +
    "  assert.strictEqual(linked.writes[1].params[1], 77, 'link uses this uplink device_data id');\n" +
    "  assert.strictEqual(linked.closeCount, 1, 'linked write closes the database handle');\n" +
    '\n' +
    "  console.log('LSN50 Chameleon persistence checks passed');\n",
    'pass line');
  stage(p, text);
  commit();
}

// Static guards that pin the scheduler query text. The rewritten query keeps
// the device predicate and the WATERMARK interlock; the channel 3 alias and
// CASE count are replaced by the raw3 selection, its eligibility and the
// eligible-channel denominator. Each needle is checked against the edited body
// before anything is written.
const QUERY_INCLUDES = [
  ['if (metric === "SWT_WM3" || metric === "SWT_3") rowValue = "v3";', 'scheduler can evaluate Chameleon SWT channel 3'],
  ['dd.swt_3 AS raw3', 'scheduler reads canonical SWT channel 3, which has no legacy alias'],
  ["CASE WHEN row_ok = 1 AND ch3_ok = 1 AND typeof(raw3) IN ('integer','real') AND raw3 BETWEEN 0 AND max_kpa THEN raw3 END AS v3", 'scheduler keeps SWT channel 3 only for an eligible row and channel, as a number inside its source domain'],
  ["ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1", 'scheduler includes Chameleon-enabled LSN50 devices'],
  ['* 1.0 / ((v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL))', 'scheduler SWT average counts Chameleon channel 3 only when eligible'],
  ["CASE WHEN ds.type_id = 'DRAGINO_LSN50' THEN 300 ELSE 1000000 END AS max_kpa", 'scheduler bounds Chameleon at 300 kPa and KIWI, CLOVER and SDI-12 at 1,000,000 kPa'],
  ['LEFT JOIN chameleon_reading_links crl', 'scheduler joins the durable Chameleon diagnostic link'],
  ['ON crl.device_data_id = dd.id', 'scheduler links a diagnostic by device_data row id'],
  ['ON cr.id = crl.chameleon_reading_id AND cr.deveui = dd.deveui', 'scheduler reads only the linked diagnostic of the same device'],
  ['WHEN cr.id IS NOT NULL AND cr.i2c_missing IS NOT 1 AND cr.timeout IS NOT 1 AND cr.data_invalid IS NOT 1 THEN 1', 'scheduler counts a Chameleon row only with a clean linked diagnostic'],
  ['AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)', 'scheduler keeps the WATERMARK interlock'],
];
const QUERY_EXCLUDES = [
  ['cr.recorded_at = dd.recorded_at', 'timestamp association of a Chameleon diagnostic'],
];
const NEW_INTERLOCK_LINE = '          AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)';

function phaseVerifiers(baseRef) {
  requireSha(baseRef);
  const bodies = SURFACES.map((s) => functionBodies(JSON.parse(read(s))).get(QUERY_ID));
  if (bodies[0] !== bodies[1]) fail('profiles carry different ' + QUERY_ID + ' bodies');
  const query = bodies[0] || '';
  if (!query.includes('chameleon_reading_links')) fail(QUERY_ID + ' is not the issue #356 body; run apply-flow-edits.cjs first');
  for (const [needle] of QUERY_INCLUDES) if (!query.includes(needle)) fail(QUERY_ID + ' lacks guard needle ' + needle);
  for (const [needle] of QUERY_EXCLUDES) if (query.includes(needle)) fail(QUERY_ID + ' carries excluded needle ' + needle);
  if (query.split('\n').filter((l) => l === NEW_INTERLOCK_LINE).length !== 1) fail(QUERY_ID + ' does not carry the interlock line exactly once');

  const syncPath = 'scripts/verify-sync-flow.js';
  const sync = readUnchangedSinceBase(baseRef, syncPath);
  if (sync.includes('chameleon_reading_links')) fail(syncPath + ' already names chameleon_reading_links');
  const guardLines = '// Issue #356: the legacy threshold scheduler query reads each channel raw, keeps it\n' +
    "// only for an eligible row and channel inside its source's domain, and associates a\n" +
    '// Chameleon diagnostic only through chameleon_reading_links. These pin its shape;\n' +
    '// scripts/test-unified-soil-tension-scheduler.js carries the behaviour.\n' +
    QUERY_INCLUDES.map(([needle, why]) => "expectIncludesById('" + QUERY_ID + "', " + jsLiteral(needle) + ', ' + jsLiteral(why) + ');\n').join('') +
    QUERY_EXCLUDES.map(([needle, why]) => "expectExcludesById('" + QUERY_ID + "', " + jsLiteral(needle) + ', ' + jsLiteral(why) + ');\n').join('');
  stage(syncPath, replaceOnce(sync,
    "expectIncludesById('d0b2b1c1a937e16d', 'COALESCE(dd.swt_3, NULL)', 'scheduler can evaluate Chameleon SWT channel 3');\n" +
    "expectIncludesById('d0b2b1c1a937e16d', \"ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1\", 'scheduler includes Chameleon-enabled LSN50 devices');\n" +
    "expectIncludesById('d0b2b1c1a937e16d', 'CASE WHEN dd.swt_3 IS NULL THEN 0 ELSE 1 END', 'scheduler SWT average counts Chameleon channel 3 only when present');\n",
    guardLines, syncPath));

  // Only the one #356-affected assertion; the helper-export mismatch earlier
  // in this file is a separate baseline problem and is not repaired here.
  const swtPath = 'scripts/verify-lsn50-chameleon-swt.js';
  const swt = readUnchangedSinceBase(baseRef, swtPath);
  stage(swtPath, replaceOnce(swt,
    "  assertIncludes(funcOf('d0b2b1c1a937e16d'), 'COALESCE(dd.swt_3, NULL)', 'SWT_AVG expression handles SWT3');\n",
    "  assertIncludes(funcOf('d0b2b1c1a937e16d'), '* 1.0 / ((v1 IS NOT NULL) + (v2 IS NOT NULL) + (v3 IS NOT NULL))', 'SWT_AVG expression handles SWT3');\n",
    swtPath));

  const wmPath = 'scripts/test-watermark-ingest-flow.js';
  let wm = readUnchangedSinceBase(baseRef, wmPath);
  if (wm.includes('chameleon_reading_links')) fail(wmPath + ' already names chameleon_reading_links');
  wm = replaceOnce(wm,
    "const INTERLOCK_LINE = '    AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)';\n",
    '// Issue #356 nests the SWT query; the interlock sits in its innermost WHERE.\n' +
    "const INTERLOCK_LINE = '" + NEW_INTERLOCK_LINE + "';\n",
    'INTERLOCK_LINE');
  wm = insertBefore(wm,
    '// seed-blank.sql + one zone holding the DRAGINO_LSN50 with chameleon_enabled = 1,\n',
    '// Issue #356: the legacy threshold scheduler counts a Chameleon-enabled LSN50\n' +
    '// row only through its chameleon_reading_links row. Each scheduler fixture row\n' +
    '// gets a clean diagnostic linked by id, so the WATERMARK interlock alone keeps a\n' +
    '// WATERMARK row out and the Chameleon row still counts.\n' +
    'function linkCleanDiagnostic(native, deviceDataId) {\n' +
    "  const row = native.prepare('SELECT deveui, recorded_at FROM device_data WHERE id = ?').get(deviceDataId);\n" +
    '  const readingId = Number(native.prepare(\n' +
    "    'INSERT INTO chameleon_readings (deveui, recorded_at, i2c_missing, timeout, data_invalid, ch1_open, ch2_open, ch3_open) VALUES (?, ?, 0, 0, 0, 0, 0, 0)'\n" +
    '  ).run(row.deveui, row.recorded_at).lastInsertRowid);\n' +
    "  native.prepare('INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id) VALUES (?, ?)').run(readingId, deviceDataId);\n" +
    '}\n' +
    '\n',
    'schedulerDb comment');
  wm = insertAfter(wm,
    '  const rowB = Number(insertDd.run(DEVEUI, at(20), 30).lastInsertRowid);\n',
    '  linkCleanDiagnostic(native, rowA);\n' +
    '  linkCleanDiagnostic(native, rowB);\n',
    'schedulerDb rows');
  wm = insertAfter(wm,
    '    const clipped = Number(insertDd.run(DEVEUI, at(10), 11.2).lastInsertRowid);\n',
    '    linkCleanDiagnostic(native, rejected);\n' +
    '    linkCleanDiagnostic(native, clipped);\n',
    'case (f2) rows');
  wm = replaceOnce(wm,
    "  name: '(g) scheduler query: the interlock line is the only change vs ' + BASE_REF + ' for every metric, DENDRO included',\n",
    "  name: '(g) scheduler query: one interlock line per SWT metric, none for DENDRO, and no drift vs ' + BASE_REF + ' beyond the issue #356 SWT rewrite',\n",
    'case (g) name');
  wm = insertBefore(wm,
    '      // Filter both sides so the case still holds once BASE_REF carries the interlock itself.\n',
    '      // Issue #356 rewrote the SWT topic (durable Chameleon link, per-source\n' +
    '      // domains); scripts/test-unified-soil-tension-scheduler.js carries that\n' +
    '      // behaviour. Against a BASE_REF from before the rewrite only DENDRO is\n' +
    '      // compared; once BASE_REF carries the link, every metric is frozen again.\n' +
    "      if (headTopic.includes('chameleon_reading_links') && !baseTopic.includes('chameleon_reading_links')) {\n" +
    "        assert.notEqual(metric, 'DENDRO', metric + ': the DENDRO topic never carries the link');\n" +
    '        continue;\n' +
    '      }\n',
    'case (g) drift');
  stage(wmPath, wm);
  commit();
}

// Measures both profiles at HEAD and at <B>. Every function node except the
// four owned ones must keep its <B> body byte for byte; the four must grow by
// exactly NODE_DELTAS.
function measure(baseRef) {
  const { totalChars } = require(rel('scripts/flows-size-scan.js'));
  const { countSilentCatchesInFlow } = require(rel('scripts/verify-no-new-silent-catch.js'));
  const expectedTotal = Object.values(NODE_DELTAS).reduce((a, b) => a + b, 0);
  const measured = [];
  for (const surface of SURFACES) {
    const head = JSON.parse(read(surface));
    const base = JSON.parse(atBase(baseRef, surface));
    const hb = functionBodies(head);
    const bb = functionBodies(base);
    if (hb.size !== bb.size) fail(surface + ': function node set changed');
    for (const [id, baseFunc] of bb) {
      const headFunc = hb.get(id);
      if (typeof headFunc !== 'string') fail(surface + ': function node ' + id + ' disappeared');
      if (Object.prototype.hasOwnProperty.call(NODE_DELTAS, id)) {
        if (headFunc.length - baseFunc.length !== NODE_DELTAS[id]) fail(surface + ': node ' + id + ' grew by ' + (headFunc.length - baseFunc.length) + ', expected ' + NODE_DELTAS[id]);
      } else if (headFunc !== baseFunc) {
        fail(surface + ': untouched function node ' + id + ' differs from ' + baseRef.slice(0, 9));
      }
    }
    const th = totalChars(head);
    const tb = totalChars(base);
    if (th - tb !== expectedTotal) fail(surface + ': total grew by ' + (th - tb) + ', expected ' + expectedTotal);
    measured.push({ surface, th, tb, baseBodies: bb, headBodies: hb,
      liveCatches: countSilentCatchesInFlow(head).silentCatchCount, baseCatches: countSilentCatchesInFlow(base).silentCatchCount });
  }
  if (measured[0].th !== measured[1].th || measured[0].tb !== measured[1].tb) fail('profiles measure differently');
  if (measured[0].liveCatches !== measured[1].liveCatches || measured[0].baseCatches !== measured[1].baseCatches) fail('profiles count empty catches differently');
  if (measured[0].liveCatches !== measured[0].baseCatches - SILENT_CATCHES_REMOVED) fail('live empty-catch count ' + measured[0].liveCatches + ' is not base ' + measured[0].baseCatches + ' - ' + SILENT_CATCHES_REMOVED);
  const baselineDoc = JSON.parse(read('scripts/verify-flows-size-ratchet-baseline.json'));
  const committedBaseline = baselineDoc.files[SURFACES[0]].total;
  if (baselineDoc.files[SURFACES[1]].total !== committedBaseline) fail('committed baseline differs between profiles');
  const { th, tb } = measured[0];
  // The total delta is set to exactly what the committed-baseline gate needs;
  // this plan's numbers assume that is also enough for the base-ref gate.
  if (th - committedBaseline < expectedTotal) fail('HEAD - committed baseline ' + (th - committedBaseline) + ' is below the base-ref growth ' + expectedTotal + '; re-plan');
  return { measured, th, tb, expectedTotal, committedBaseline, newDelta: th - committedBaseline, shortBase: baseRef.slice(0, 9) };
}

function phaseRatchets(baseRef) {
  requireSha(baseRef);
  const m = measure(baseRef);
  const allowances = JSON.parse(readUnchangedSinceBase(baseRef, ALLOWANCES_PATH));
  readJsonGuarded(ALLOWANCES_PATH);
  for (const id of Object.keys(NODE_DELTAS)) {
    const baseChars = m.measured[0].baseBodies.get(id).length;
    const headChars = m.measured[0].headBodies.get(id).length;
    const prior = allowances.node_allowances[id];
    const supersedes = prior
      ? ' Supersedes the prior +' + prior.delta + ' entry, consumed: ' + m.shortBase + ' already measures this node at ' + baseChars + ', so carrying it forward would be unearned headroom.'
      : '';
    allowances.node_allowances[id] = {
      delta: headChars - baseChars,
      reason: NODE_REASONS[id] + ' Measured with verify-flows-size-ratchet nodeSizes over both byte-identical maintained profiles: ' +
        m.shortBase + ' ' + baseChars + ' -> HEAD ' + headChars + ' = +' + (headChars - baseChars) + '.' + supersedes,
    };
  }
  // The smallest total delta that passes both the base-ref gate and the
  // committed-baseline gate: no earlier headroom is carried forward.
  const oldDelta = allowances.total_allowance.delta;
  allowances.total_allowance.delta = m.newDelta;
  allowances.total_allowance.provenance += PROVENANCE_MARK +
    Object.entries(NODE_DELTAS).map(([id, d]) => id + ' +' + d).join(', ') +
    ', measured with verify-flows-size-ratchet totalChars, each byte-identical maintained profile: ' +
    m.shortBase + ' ' + m.tb + ' -> HEAD ' + m.th + ' = +' + (m.th - m.tb) + '. The committed baseline ' + m.committedBaseline +
    ' plus the delta must cover ' + m.th + ' - ' + m.committedBaseline + ' = ' + m.newDelta +
    ' and the base-ref gate needs at least +' + m.expectedTotal + ', so the delta is set to exactly ' + m.newDelta +
    ' (from ' + oldDelta + '); no earlier headroom is carried, and the baseline file is unchanged.';
  stage(ALLOWANCES_PATH, jsonText(allowances));

  readUnchangedSinceBase(baseRef, CATCH_PATH);
  const catches = readJsonGuarded(CATCH_PATH);
  for (const x of m.measured) {
    const profile = Object.keys(catches.profiles).find((k) => catches.profiles[k].path === x.surface);
    if (!profile) fail(CATCH_PATH + ' has no profile for ' + x.surface);
    if (catches.profiles[profile].silentCatchCount !== x.baseCatches) fail(profile + ': committed count ' + catches.profiles[profile].silentCatchCount + ' differs from base count ' + x.baseCatches);
    catches.profiles[profile].silentCatchCount = x.liveCatches;
  }
  catches.generatedFrom += PROVENANCE_MARK + 'Insert Chameleon Reading converts its close() catch and calibration-local-backfill its ROLLBACK and close() catches to visible node.warn, taking both profiles ' +
    m.measured[0].baseCatches + ' -> ' + m.measured[0].liveCatches + '.';
  stage(CATCH_PATH, jsonText(catches));
  commit();
}

// The chained identity verifier pins the empty-catch baseline and the size
// total delta by strict equality. This phase moves both pins to the values the
// ratchets phase wrote, after re-measuring them, and refuses on any drift.
function phaseIdentityPins(baseRef) {
  requireSha(baseRef);
  const m = measure(baseRef);
  const baseAllowances = JSON.parse(atBase(baseRef, ALLOWANCES_PATH));
  const baseCatchDoc = JSON.parse(atBase(baseRef, CATCH_PATH));
  const allowances = readJsonGuarded(ALLOWANCES_PATH);
  const catches = readJsonGuarded(CATCH_PATH);
  const oldDelta = baseAllowances.total_allowance.delta;
  const baseCatches = m.measured[0].baseCatches;
  const liveCatches = m.measured[0].liveCatches;
  for (const k of Object.keys(baseCatchDoc.profiles)) {
    if (baseCatchDoc.profiles[k].silentCatchCount !== baseCatches) fail(CATCH_PATH + ' at base records ' + baseCatchDoc.profiles[k].silentCatchCount + ' for ' + k + ', measured ' + baseCatches);
    if (catches.profiles[k].silentCatchCount !== liveCatches) fail(CATCH_PATH + ' records ' + catches.profiles[k].silentCatchCount + ' for ' + k + '; run the ratchets phase first');
  }
  if (allowances.total_allowance.delta !== m.newDelta || !String(allowances.total_allowance.provenance).includes(PROVENANCE_MARK)) fail(ALLOWANCES_PATH + ' total delta is not the measured ' + m.newDelta + '; run the ratchets phase first');

  let identity = readUnchangedSinceBase(baseRef, IDENTITY_PATH);
  identity = replaceOnce(identity,
    '  expectCondition(silentCatchBaseline.profiles?.bcm2712?.silentCatchCount === ' + baseCatches + ' && silentCatchBaseline.profiles?.bcm2709?.silentCatchCount === ' + baseCatches + ',\n' +
    "    'silent-catch baseline records " + baseCatches + " for both maintained profiles',\n" +
    "    'silent-catch baseline must be " + baseCatches + " for both maintained profiles');\n",
    "  // " + liveCatches + ": issue #356 durable Chameleon diagnostic link -- Insert Chameleon Reading's\n" +
    "  // close() catch and calibration-local-backfill's ROLLBACK and close() catches become\n" +
    '  // visible node.warn while both nodes move to one scoped db.transaction: ' + baseCatches + ' -> ' + liveCatches + '.\n' +
    '  expectCondition(silentCatchBaseline.profiles?.bcm2712?.silentCatchCount === ' + liveCatches + ' && silentCatchBaseline.profiles?.bcm2709?.silentCatchCount === ' + liveCatches + ',\n' +
    "    'silent-catch baseline records " + liveCatches + " for both maintained profiles',\n" +
    "    'silent-catch baseline must be " + liveCatches + " for both maintained profiles');\n",
    IDENTITY_PATH + ' catch pin');
  const nodes = Object.entries(NODE_DELTAS).map(([id, d]) => id + ' +' + d);
  identity = replaceOnce(identity,
    '  expectCondition(sizeAllowances.total_allowance?.delta === ' + oldDelta + ',\n' +
    "    'size total allowance: exact cumulative delta " + oldDelta + "',\n" +
    "    'size total allowance: expected exact cumulative delta " + oldDelta + "');\n",
    '  // ' + m.newDelta + ': issue #356 durable Chameleon diagnostic link (' + nodes.slice(0, 2).join(', ') + ',\n' +
    '  // ' + nodes.slice(2).join(', ') + '), measured on ' + m.shortBase + ': ' + m.tb + ' -> HEAD ' + m.th + ' = +' + (m.th - m.tb) + '.\n' +
    '  // The committed baseline ' + m.committedBaseline + ' plus the delta must cover ' + m.th + ', so the delta is set\n' +
    '  // to exactly ' + m.th + ' - ' + m.committedBaseline + ' = ' + m.newDelta + ', not ' + oldDelta + ' + ' + (m.th - m.tb) + ': headroom left unused at ' + m.shortBase + '\n' +
    '  // is not carried forward. The baseline doc is unchanged.\n' +
    '  expectCondition(sizeAllowances.total_allowance?.delta === ' + m.newDelta + ',\n' +
    "    'size total allowance: exact delta " + m.newDelta + "',\n" +
    "    'size total allowance: expected exact delta " + m.newDelta + "');\n",
    IDENTITY_PATH + ' total pin');
  stage(IDENTITY_PATH, identity);
  commit();
}

function phaseDocsCi() {
  const docPath = 'docs/operations/unified-soil-tension.md';
  const doc = read(docPath);
  if (doc.includes('chameleon_reading_links')) fail(docPath + ' already names chameleon_reading_links');
  stage(docPath, insertAfter(doc,
    'Sampling frequency therefore still affects temporal weighting.\n\n',
    'The legacy threshold scheduler counts a Chameleon-enabled LSN50 observation only through its `chameleon_reading_links` row. Ingest writes that row from the row ids of the same uplink, in the same transaction as the diagnostic. Rows stored before the link existed stay out of the legacy scheduler, even when a diagnostic shares their device and timestamp; calibration backfill still fills their history values by row id but never links them. The linked diagnostic removes the whole row on an I2C, timeout or data-invalid flag, and one channel on its open flag. Each channel must be a finite number inside its source\'s range: 0 through 300 kPa for Chameleon, the converter\'s output range, and 0 through 1,000,000 kPa for KIWI, CLOVER and SDI-12. The Water card keeps the shared display domain, so a stored Chameleon value above 300 kPa can appear on the card while the scheduler ignores it. With no eligible value in the last hour the scheduler logs `no_data_last_hour` and sends no command. Conditional irrigation (`osi-irrigation-policy`) does not use the link yet: it checks a Chameleon source against its latest diagnostic. Its production qualification stays off, and per-sample linking is a tracked prerequisite for qualifying it.\n\n',
    docPath));

  const workflowPath = '.github/workflows/verify-sync-flow.yml';
  let workflow = read(workflowPath);
  if (workflow.includes('test-chameleon-reading-link')) fail(workflowPath + ' already runs the link tests');
  workflow = replaceOnce(workflow,
    '      # the unified soil-tension scheduler.\n',
    '      # the unified soil-tension scheduler and the durable Chameleon diagnostic link.\n', 'workflow comment');
  workflow = replaceOnce(workflow,
    '          scripts/test-unified-soil-tension-scheduler.js\n',
    '          scripts/test-unified-soil-tension-scheduler.js\n' +
    '          scripts/test-chameleon-reading-links-schema.js scripts/test-chameleon-reading-link-ingest.js\n',
    'workflow step');
  stage(workflowPath, workflow);
  commit();
}

if (PHASE === 'schema') phaseSchema(ARG);
else if (PHASE === 'persistence') phasePersistence();
else if (PHASE === 'verifiers') phaseVerifiers(ARG);
else if (PHASE === 'ratchets') phaseRatchets(ARG);
else if (PHASE === 'identity-pins') phaseIdentityPins(ARG);
else if (PHASE === 'docs-ci') phaseDocsCi();
else fail('unknown phase; use schema <V>, persistence, verifiers <B>, ratchets <B>, identity-pins <B> or docs-ci');
