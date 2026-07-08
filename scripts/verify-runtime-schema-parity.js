#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const SEED = path.join(repo, 'database/seed-blank.sql');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(repo, p));
const MIGRATION_OWNED_TRIGGERS = new Set([
  // 0005__field_work_requests.sql is delivered by seed DBs and deploy.sh's
  // additive migration repair. Do not add it to the frozen sync-init-fn boot DDL.
  'trg_improvement_requests_outbox_ai',
]);

function q(db, sql) {
  const out = execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}
function checkTypes(sql) {
  const m = /CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(sql || '');
  return new Set(((m && m[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
}
function triggerNames(text) {
  return new Set([...text.matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]));
}

// Canonical schema from the seed: the devices CHECK type-set and the full trigger set.
const canonDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-')), 'canon.db');
execFileSync('sqlite3', ['-bail', canonDb], { input: fs.readFileSync(SEED, 'utf8'), encoding: 'utf8' });
const canonDevices = checkTypes((q(canonDb, "SELECT sql FROM sqlite_master WHERE name='devices'")[0] || {}).sql);
const canonTriggers = new Set(q(canonDb, "SELECT name FROM sqlite_master WHERE type='trigger'").map((r) => r.name));
const runtimeCanonTriggers = new Set([...canonTriggers].filter((name) => !MIGRATION_OWNED_TRIGGERS.has(name)));

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

const problems = [];
for (const triggerName of MIGRATION_OWNED_TRIGGERS) {
  if (!canonTriggers.has(triggerName)) {
    problems.push(`migration-owned trigger ${triggerName} is not present in the canonical seed`);
  }
}
for (const flowPath of FLOWS) {
  const rel = path.relative(repo, flowPath);
  const raw = fs.readFileSync(flowPath, 'utf8');
  const node = JSON.parse(raw).find((n) => n.id === 'sync-init-fn');
  if (!node) throw new Error(`${rel}: sync-init-fn node not found`);

  // (a) devices_new CHECK — the regression site (specific to sync-init-fn's rebuild).
  const dm = /devices_new\s*\(id[\s\S]*?CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(node.func || '');
  const devTypes = new Set(((dm && dm[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
  if (!setEq(devTypes, canonDevices)) {
    problems.push(`${rel}: sync-init-fn devices_new CHECK != canonical seed. missing=[${diff(canonDevices, devTypes)}] extra=[${diff(devTypes, canonDevices)}]`);
  }

  // (b) triggers — created across MULTIPLE flow nodes, so compare the WHOLE flow text.
  const flowTriggers = triggerNames(raw);
  if (!setEq(flowTriggers, runtimeCanonTriggers)) {
    problems.push(`${rel}: runtime flow trigger set != canonical runtime trigger set. missing=[${diff(runtimeCanonTriggers, flowTriggers)}] extra=[${diff(flowTriggers, runtimeCanonTriggers)}]`);
  }
}

if (problems.length) {
  console.error('verify-runtime-schema-parity: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`verify-runtime-schema-parity: OK (${FLOWS.length} flows: devices CHECK + runtime trigger parity)`);
process.exit(0);
