#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts', 'repair-tensiomark-history.js');
const normalizer = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/tensiomark-live');
const EUI = 'A840410000000101';
const RAW = '1+18.090+1.7300\r\n';
const RAW_SQL = "CAST(X'312B31382E3039302B312E373330300D0A' AS TEXT)";
const PAYLOAD = Buffer.concat([Buffer.from([0x0e, 0x16, 0x01]), Buffer.from(RAW, 'latin1')]).toString('base64');
const LAYOUT = {
  version: 1, kind: 'tensiomark', source_unit: 'pF', field_order: 'temperature_pf', qualification: 'bench_observed',
  sensors: [{ address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' }]
};
const CONFIG = JSON.stringify(LAYOUT);
const CONFIG_HASH = crypto.createHash('sha256').update(CONFIG).digest('hex');
const FULL_KPA = Math.pow(10, 1.73 - 1);
const LEGACY = JSON.stringify({ channels: { swt_1: 5.37, soil_temp_1: 18.09 }, disposition: 'accepted' });

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}
function sqlite(db, text, json = false) {
  const args = json ? ['-bail', '-readonly', '-json', db, text] : ['-bail', db];
  return execFileSync('sqlite3', args, { input: json ? undefined : text, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
function rows(db, query) {
  const output = sqlite(db, query, true).trim();
  return output ? JSON.parse(output) : [];
}
function one(db, query) { return rows(db, query)[0]; }
function makeDb(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tensiomark-repair-'));
  const db = path.join(dir, 'farming.db');
  sqlite(db, fs.readFileSync(path.join(root, 'database', 'seed-blank.sql'), 'utf8'));
  const observationCount = options.duplicates ? 2 : 1;
  const setup = [
    "INSERT INTO users(id,username,password_hash,created_at) VALUES(1,'fixture','x','2026-10-16T00:00:00Z');",
    `INSERT INTO devices(id,deveui,name,type_id,user_id,created_at,updated_at,gateway_device_eui) VALUES(1,${sql(EUI)},'Tensiomark','DRAGINO_SDI12',1,'2026-10-16T00:00:00Z','2026-10-16T00:00:00Z','0016C001F1000001');`,
    `INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,server_url,updated_at) VALUES('cloud',${options.unlinked ? 0 : 1},'0016C001F1000001','https://cloud.invalid','2026-10-16T00:00:00Z');`,
    `INSERT INTO device_data(id,deveui,recorded_at,swt_1,soil_temp_1,bat_v) VALUES(101,${sql(EUI)},'2026-10-16T12:00:00.000Z',${sql(options.swt ?? 5.37)},18.09,3.606);`,
  ];
  for (let i = 0; i < observationCount; i += 1) setup.push(
    `INSERT INTO tensiomark_observations(id,device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json) VALUES(${i + 1},101,${sql(EUI)},'2026-10-16T12:00:00.000Z','2026-10-16T12:00:01.000Z',${RAW_SQL},${sql(PAYLOAD)},${sql(CONFIG_HASH)},${sql(CONFIG)},'accepted',${sql(LEGACY)});`
  );
  if (options.rejected) setup.push(
    `INSERT INTO tensiomark_observations(id,device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json) VALUES(2,NULL,${sql(EUI)},'2026-10-16T13:00:00.000Z','2026-10-16T13:00:01.000Z','bad',NULL,${sql(CONFIG_HASH)},${sql(CONFIG)},'rejected_framing','{"disposition":"rejected_framing"}');`
  );
  // The linked gateway's outbox trigger queued the canonical append; mark it
  // delivered unless the case needs it pending.
  if (!options.pendingAppend) setup.push("UPDATE sync_outbox SET delivered_at='2026-10-16T12:00:02.000Z' WHERE delivered_at IS NULL;");
  sqlite(db, setup.join('\n'));
  return { dir, db };
}
function invoke(db, args = [], env = {}, cliPath = cli) {
  const result = spawnSync(process.execPath, [cliPath, '--db', db, '--deveui', EUI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const summary = lines.length ? JSON.parse(lines.at(-1)) : null;
  return { ...result, summary };
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function runtimeNormalizer(dir, activeSource) {
  const active = path.join(dir, 'active.js');
  const image = path.join(dir, 'image.js');
  fs.writeFileSync(active, activeSource);
  fs.writeFileSync(image, "module.exports={source:'stale-image'};");
  const candidates = new Map([
    ['/srv/node-red/osi-sdi12-normalize/tensiomark-live', active],
    ['/usr/share/node-red/osi-sdi12-normalize/tensiomark-live', image],
  ]);
  const target = filename => candidates.get(String(filename).replace(/\.js$/, ''));
  const sandbox = {
    __dirname: path.join(dir, 'scripts'),
    require: name => name === 'node:fs'
      ? { ...fs, existsSync: filename => target(filename) ? fs.existsSync(target(filename)) : fs.existsSync(filename) }
      : require(target(name) || name),
    process: { env: {}, argv: ['node', 'repair', '--help'], stderr: { write() {} } },
    module: { exports: {} },
  };
  vm.runInNewContext(fs.readFileSync(cli, 'utf8') + '\nmodule.exports = normalizer;', sandbox);
  return sandbox.module.exports;
}

test('repair loads the active Pi helper before inactive image copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tensiomark-helper-'));
  try { assert.equal(runtimeNormalizer(dir, "module.exports={source:'active'};")().source, 'active'); }
  finally { cleanup(dir); }
});

test('a broken active helper dependency is surfaced without stale-image fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tensiomark-helper-'));
  try {
    assert.throws(runtimeNormalizer(dir, "require('./missing-matric-helper');"), /missing-matric-helper/);
  } finally { cleanup(dir); }
});

for (const [name, replacement] of [
  ['missing', 'undefined'], ['empty', '{}'], ['numeric', '{swt_1:1.73}'], ['altered spelling', "{swt_1:'+1.73'}"],
]) test(`repair refuses ${name} native pF provenance from an incompatible helper`, () => {
  const { dir, db } = makeDb();
  try {
    const copiedCli = path.join(dir, 'scripts', 'repair.js');
    const helper = path.join(dir, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/tensiomark-live.js');
    fs.mkdirSync(path.dirname(copiedCli), { recursive: true });
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.copyFileSync(cli, copiedCli);
    const realHelper = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/tensiomark-live.js');
    fs.writeFileSync(helper, `const real=require(${JSON.stringify(realHelper)});
      module.exports={...real,normalizeTensiomarkUplink(...args){const result=real.normalizeTensiomarkUplink(...args);result.nativePf=${replacement};return result;}};`);
    const result = invoke(db, ['--apply', '--backup-dir', path.join(dir, 'backups')], {}, copiedCli);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.applied, 0);
    assert.equal(result.summary.reasons.native_pf_unavailable, 1);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
    assert.equal(one(db, 'SELECT normalized_json FROM tensiomark_observations WHERE id=1').normalized_json, LEGACY);
  } finally { cleanup(dir); }
});

function raceSqlite(dir, db, mutation) {
  const wrapper = path.join(dir, 'sqlite-race.js');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const input=fs.readFileSync(0,'utf8');
if(input.includes('BEGIN IMMEDIATE;')) execFileSync('sqlite3',['-bail',process.env.REPAIR_RACE_DB],{input:process.env.REPAIR_RACE_SQL});
try { process.stdout.write(execFileSync('sqlite3',process.argv.slice(2),{input,encoding:'utf8'})); }
catch(error) { process.stderr.write(String(error.stderr||error.message)); process.exitCode=error.status||1; }
`, { mode: 0o700 });
  return { SQLITE3: wrapper, REPAIR_RACE_DB: db, REPAIR_RACE_SQL: mutation };
}

for (const [name, mutation] of [
  ['rejected disposition', "UPDATE tensiomark_observations SET disposition='rejected_values' WHERE id=1;"],
  ['new accepted duplicate', `INSERT INTO tensiomark_observations(device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json)
    SELECT device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,configuration_hash,configuration_json,disposition,normalized_json FROM tensiomark_observations WHERE id=1;`],
]) test(`apply refuses a ${name} that appears after its verified backup`, () => {
  const { dir, db } = makeDb();
  try {
    const backups = path.join(dir, 'backups');
    const result = invoke(db, ['--apply', '--backup-dir', backups], raceSqlite(dir, db, mutation));
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(fs.readdirSync(backups).length, 1);
    if (name === 'rejected disposition') {
      assert.equal(one(db, 'SELECT disposition FROM tensiomark_observations WHERE id=1').disposition, 'rejected_values');
    } else {
      assert.equal(one(db, 'SELECT count(*) AS n FROM tensiomark_observations').n, 2);
    }
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
    assert.equal(one(db, 'SELECT normalized_json FROM tensiomark_observations WHERE id=1').normalized_json, LEGACY);
  } finally { cleanup(dir); }
});

test('missing canonical zero temperature is a mismatch, not a numeric zero', () => {
  const { dir, db } = makeDb();
  try {
    const raw = '1+0.000+1.7300\r\n';
    const payload = Buffer.concat([Buffer.from([0x0e, 0x16, 0x01]), Buffer.from(raw, 'latin1')]).toString('base64');
    sqlite(db, `UPDATE device_data SET soil_temp_1=NULL WHERE id=101;
      UPDATE tensiomark_observations SET raw_response=CAST(X'${Buffer.from(raw).toString('hex')}' AS TEXT),payload_base64=${sql(payload)} WHERE id=1;`);
    const result = invoke(db);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.repairable, 0);
    assert.equal(result.summary.reasons.canonical_value_mismatch, 1);
  } finally { cleanup(dir); }
});

test('dry run reports one exact-double repair without changing storage', () => {
  const { dir, db } = makeDb();
  try {
    const before = one(db, 'SELECT swt_1,normalized_json FROM device_data d JOIN tensiomark_observations o ON o.device_data_id=d.id');
    const result = invoke(db);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.applied, 0);
    assert.equal(result.summary.repairable, 1);
    assert.equal(result.summary.reasons.repairable, 1);
    assert.deepEqual(one(db, 'SELECT swt_1,normalized_json FROM device_data d JOIN tensiomark_observations o ON o.device_data_id=d.id'), before);
  } finally { cleanup(dir); }
});

test('apply takes an integrity-checked backup, preserves provenance, and is idempotent', () => {
  const { dir, db } = makeDb();
  const backupDir = path.join(dir, 'backups');
  try {
    const beforeOutbox = one(db, 'SELECT COUNT(*) AS n FROM sync_outbox').n;
    const first = invoke(db, ['--apply', '--backup-dir', backupDir]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.summary.applied, 1);
    assert.equal(first.summary.backupVerified, true);
    assert.equal(fs.readdirSync(backupDir).length, 1);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, FULL_KPA);
    assert.equal(one(db, 'SELECT COUNT(*) AS n FROM sync_outbox').n, beforeOutbox);
    const evidence = one(db, 'SELECT raw_response,configuration_hash,configuration_json FROM tensiomark_observations WHERE id=1');
    assert.equal(Buffer.from(evidence.raw_response, 'latin1').toString('hex'), Buffer.from(RAW, 'latin1').toString('hex'));
    assert.equal(evidence.configuration_hash, CONFIG_HASH);
    assert.equal(evidence.configuration_json, CONFIG);
    const repaired = JSON.parse(one(db, 'SELECT normalized_json FROM tensiomark_observations WHERE id=1').normalized_json);
    assert.equal(repaired.normalization_version, 2);
    assert.equal(repaired.conversion, 'matric-potential-hpa-v1');
    assert.deepEqual(repaired.native_pf, { swt_1: '+1.7300' });
    assert.equal(repaired.previous_normalized_json, LEGACY);
    const second = invoke(db, ['--apply', '--backup-dir', backupDir]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.summary.applied, 0);
    assert.equal(second.summary.reasons.already_correct, 1);
    assert.equal(fs.readdirSync(backupDir).length, 1);
  } finally { cleanup(dir); }
});

test('rejected, ambiguous, and divergent observations are refused without mutation', () => {
  const rejected = makeDb({ rejected: true });
  try {
    const result = invoke(rejected.db);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.reasons.rejected_disposition, 1);
  } finally { cleanup(rejected.dir); }
  const ambiguous = makeDb({ duplicates: true });
  try {
    const result = invoke(ambiguous.db, ['--apply', '--backup-dir', path.join(ambiguous.dir, 'backups')]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.reasons.ambiguous_duplicate_observation, 2);
    assert.equal(one(ambiguous.db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
  } finally { cleanup(ambiguous.dir); }
  const mismatch = makeDb({ swt: 99 });
  try {
    const result = invoke(mismatch.db, ['--apply', '--backup-dir', path.join(mismatch.dir, 'backups')]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.reasons.canonical_value_mismatch, 1);
    assert.equal(one(mismatch.db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 99);
  } finally { cleanup(mismatch.dir); }
});

test('a transaction failure rolls back earlier repair updates', () => {
  const { dir, db } = makeDb();
  const backupDir = path.join(dir, 'backups');
  try {
    sqlite(db, "CREATE TRIGGER test_abort_repair AFTER UPDATE OF normalized_json ON tensiomark_observations BEGIN SELECT no_such_function(); END;");
    const result = invoke(db, ['--apply', '--backup-dir', backupDir]);
    assert.notEqual(result.status, 0);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
    assert.equal(one(db, 'SELECT normalized_json FROM tensiomark_observations WHERE id=1').normalized_json, LEGACY);
  } finally { cleanup(dir); }
});

test('apply refuses an unlinked gateway before taking a backup', () => {
  const { dir, db } = makeDb({ unlinked: true });
  const backupDir = path.join(dir, 'backups');
  try {
    const dry = invoke(db);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.summary.linked, false);
    assert.equal(dry.summary.repairable, 1);
    const result = invoke(db, ['--apply', '--backup-dir', backupDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cloud-linked/);
    assert.equal(fs.existsSync(backupDir), false);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
  } finally { cleanup(dir); }
});

test('apply refuses while the candidate canonical append is undelivered', () => {
  const { dir, db } = makeDb({ pendingAppend: true });
  const backupDir = path.join(dir, 'backups');
  try {
    assert.equal(one(db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE op='DEVICE_DATA_APPENDED' AND delivered_at IS NULL").n, 1);
    const dry = invoke(db);
    assert.equal(dry.summary.pendingAppend, true);
    const result = invoke(db, ['--apply', '--backup-dir', backupDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEVICE_DATA_APPENDED/);
    assert.equal(fs.existsSync(backupDir), false);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
    assert.equal(one(db, 'SELECT normalized_json FROM tensiomark_observations WHERE id=1').normalized_json, LEGACY);
  } finally { cleanup(dir); }
});

for (const [name, mutation] of [
  ['an unlinked gateway', "UPDATE sync_link_state SET linked=0;"],
  ['a pending canonical append', "UPDATE sync_outbox SET delivered_at=NULL WHERE op='DEVICE_DATA_APPENDED';"],
]) test(`apply re-checks ${name} inside the write transaction`, () => {
  const { dir, db } = makeDb();
  try {
    const result = invoke(db, ['--apply', '--backup-dir', path.join(dir, 'backups')], raceSqlite(dir, db, mutation));
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, 5.37);
    assert.equal(one(db, 'SELECT normalized_json FROM tensiomark_observations WHERE id=1').normalized_json, LEGACY);
  } finally { cleanup(dir); }
});

// A gateway sqlite3 that prints REALs with 15 significant digits in -json
// output must still repair and then recognise its own repair.
function shortRealSqlite(dir) {
  const wrapper = path.join(dir, 'sqlite-short.js');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const input=fs.readFileSync(0,'utf8');
try {
  let out=execFileSync('sqlite3',process.argv.slice(2),{input,encoding:'utf8'});
  if(process.argv.includes('-json') && out.trim()) out=JSON.stringify(JSON.parse(out).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='number'&&!Number.isInteger(v)?Number(v.toPrecision(15)):v]))))+'\\n';
  process.stdout.write(out);
} catch(error) { process.stderr.write(String(error.stderr||error.message)); process.exitCode=error.status||1; }
`, { mode: 0o700 });
  return { SQLITE3: wrapper };
}

test('canonical comparison does not depend on the sqlite3 CLI REAL print precision', () => {
  const { dir, db } = makeDb();
  const backupDir = path.join(dir, 'backups');
  try {
    assert.notEqual(String(Number(FULL_KPA.toPrecision(15))), String(FULL_KPA), 'fixture must need 17 digits');
    const env = shortRealSqlite(dir);
    const first = invoke(db, ['--apply', '--backup-dir', backupDir], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.summary.applied, 1);
    assert.equal(one(db, 'SELECT swt_1 FROM device_data WHERE id=101').swt_1, FULL_KPA);
    const second = invoke(db, ['--apply', '--backup-dir', backupDir], env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.summary.reasons.already_correct, 1);
  } finally { cleanup(dir); }
});

test('a stored full value off by rounding noise counts as already correct', () => {
  const { dir, db } = makeDb();
  try {
    const first = invoke(db, ['--apply', '--backup-dir', path.join(dir, 'backups')]);
    assert.equal(first.summary.applied, 1);
    sqlite(db, `UPDATE device_data SET swt_1=${FULL_KPA * (1 + 4e-16)} WHERE id=101;`);
    const second = invoke(db);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.summary.reasons.already_correct, 1);
  } finally { cleanup(dir); }
});
