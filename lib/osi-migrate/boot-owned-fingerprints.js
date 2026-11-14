'use strict';

// #636, item 3 (g). A deploy cut part way through its migrations leaves the
// old payload active on a partly migrated database. At its next start the old
// payload's boot node (sync-init-fn) drops and recreates its own triggers with
// its own bodies. If a pending migration had already given one of those
// objects a new body AND that body was stamped into schema_object_fingerprints,
// the retry's drift preflight refuses (runner.js applyPending): the stamp
// expects the new body, the old boot wrote the old one, and the reference at
// the applied head has the new one. Anywhere else the retry completes.
//
// So the deploy records, before migrate-cli runs, the fingerprint of every new
// body that a pending migration gives an object the old boot node recreates.
// The boot holds a partly migrated gateway only when one of those fingerprints
// is already stamped (deploy-payload-swap.js, bootSchemaDecision).
//
// The set of recreated objects is read from the installed old payload's own
// sync-init-fn (its DROP ... IF EXISTS statements), never typed by hand: it is
// that code, and no list in this release, that runs after the cut.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { NORMALIZER_VERSION, normalizeSqlV3 } = require('./fingerprints');

const BOOT_NODE_ID = 'sync-init-fn';

// fingerprints.js computeFingerprints: hash({ tag, body }) for a trigger,
// hash({ tag, ddl }) for an index, over the normalized sqlite_master SQL.
function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function fingerprintOf(type, sql) {
  const tag = { normalizer: NORMALIZER_VERSION };
  const text = normalizeSqlV3(sql);
  return type === 'trigger' ? hash({ tag, body: text }) : hash({ tag, ddl: text });
}

// "<type> <name>" for every trigger, index or view the boot node drops and
// recreates. Throws when the flows have no boot node.
function bootRecreatedObjects(flows) {
  const node = Array.isArray(flows) ? flows.find((n) => n && n.id === BOOT_NODE_ID) : null;
  if (!node || typeof node.func !== 'string') throw new Error(`boot-owned objects: no ${BOOT_NODE_ID} in the installed flows`);
  const objects = new Set();
  for (const m of node.func.matchAll(/DROP\s+(TRIGGER|INDEX|VIEW)\s+IF\s+EXISTS\s+"?([A-Za-z0-9_]+)"?/gi)) {
    objects.add(`${m[1].toLowerCase()} ${m[2]}`);
  }
  return objects;
}

// The CREATE TRIGGER and CREATE INDEX statements of a migration, each as the
// text SQLite stores in sqlite_master (from CREATE to its last END, or to the
// statement's end, without the semicolon). Comments and string literals are
// skipped while counting; a trigger body nests CASE ... END inside BEGIN ... END.
function createStatements(sql) {
  const out = [];
  const src = String(sql);
  const re = /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(TRIGGER|(?:UNIQUE\s+)?INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
  let m;
  while ((m = re.exec(src))) {
    const type = /TRIGGER/i.test(m[1]) ? 'trigger' : 'index';
    let i = m.index + m[0].length;
    let depth = 0;
    let sawBegin = false;
    let end = -1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const close = src.indexOf(ch, i + 1);
        i = close === -1 ? src.length : close + 1;
        continue;
      }
      if (ch === '-' && src[i + 1] === '-') {
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? src.length : nl;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2);
        i = close === -1 ? src.length : close + 2;
        continue;
      }
      if (type === 'index' && ch === ';') { end = i; break; }
      if (type === 'trigger' && /[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(src[i - 1] || '')) {
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))[0];
        const upper = word.toUpperCase();
        if (upper === 'BEGIN' || upper === 'CASE') { depth += 1; if (upper === 'BEGIN') sawBegin = true; }
        if (upper === 'END') {
          depth -= 1;
          if (sawBegin && depth === 0) { end = i + word.length; break; }
        }
        i += word.length;
        continue;
      }
      i += 1;
    }
    if (end === -1) throw new Error(`boot-owned objects: could not find the end of CREATE ${type} ${m[2]}`);
    out.push({ type, name: m[2], sql: src.slice(m.index, end) });
    re.lastIndex = end;
  }
  return out;
}

// The record's list: for each pending migration (version above appliedHead)
// that creates an object the old boot node recreates, the fingerprint of that
// new body, unless it equals the object's current (pre-migration) fingerprint.
// <current>: Map "<type> <name>" -> stored fingerprint.
function pendingBootOwnedFingerprints({ flows, migrations, appliedHead, current }) {
  const recreated = bootRecreatedObjects(flows);
  const out = [];
  for (const migration of migrations) {
    if (!(migration.version > appliedHead)) continue;
    for (const stmt of createStatements(migration.sql)) {
      const key = `${stmt.type} ${stmt.name}`;
      if (!recreated.has(key)) continue;
      const fingerprint = fingerprintOf(stmt.type, stmt.sql);
      if (current && current.get(key) === fingerprint) continue;
      out.push({ type: stmt.type, name: stmt.name, version: migration.version, fingerprint });
    }
  }
  return out;
}

// CLI for deploy.sh: <flows.json> <migrations dir> <db>; prints the JSON list.
// The database is read through the sqlite3 CLI (read-only queries).
if (require.main === module) {
  const { execFileSync } = require('node:child_process');
  const { loadMigrationCorpus } = require('./migrations-loader');
  const [flowsPath, migrationsDir, dbPath] = process.argv.slice(2);
  const query = (sql) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8' }) || '[]');
  const head = Number((query("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations WHERE status='applied'")[0] || {}).v || 0);
  const current = new Map(query('SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints')
    .map((r) => [`${r.object_type} ${r.object_name}`, r.fingerprint]));
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const corpus = loadMigrationCorpus(migrationsDir);
  process.stdout.write(JSON.stringify(pendingBootOwnedFingerprints({ flows, migrations: corpus.migrations, appliedHead: head, current })));
}

module.exports = { bootRecreatedObjects, createStatements, fingerprintOf, pendingBootOwnedFingerprints };
