'use strict';
// Exact handoff, prepared without writing either reserved flows.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const legacy = require('./fixtures/x3-zone-env/legacy-nodes.json');
const METHODS = { 'zone-env-fn': 'environmentSummary', 'strega-today-liters-fn': 'todayLiters', 'get-actuations-query': 'queryActuations', 'get-actuations-response': 'formatActuations' };
function body(id) {
  if (id === 'strega-today-liters-fn') {
    const source = legacy.find(n => n.id === id).func;
    const start = source.indexOf("  const db = new osiDb.Database('/data/db/farming.db');");
    const tail = source.indexOf('})().catch((error) =>');
    return source.slice(0, start) + `  const loaded = osiLib.require('zone-env');
  if (!loaded.ok) {
    node.error('strega-today-liters-fn: zone-env module unavailable: ' + loaded.error, msg);
    msg.statusCode = 503;
    msg.payload = { message: 'Internal error' };
    return msg;
  }
  return loaded.value.todayLiters(msg, { auth, deveui, scopedOn, todayIso, osiDb, osiLib, env, node, Date });
` + source.slice(tail) + '\n';
  }

  if (id === 'zone-env-fn') return `return (async () => {
const db = new osiDb.Database('/data/db/farming.db');
const loaded = osiLib.require('zone-env');
if (!loaded.ok) {
  msg.statusCode = 503;
  msg.payload = { error: 'module_unavailable', module: 'zone-env', message: loaded.error };
  node.error('Zone Env Summary: assembly module unavailable: ' + loaded.error, msg);
  await new Promise(resolve => db.close(() => resolve()));
  return msg;
}
return await loaded.value.environmentSummary(msg, { db, ZE: loaded.value, osiLib, crypto, httpLib, httpsLib, env, node, global, Date });
})();\n`;
  const parameters = id === 'strega-today-liters-fn' ? 'osiDb, osiLib, crypto, env, node, global, Date' : id === 'get-actuations-query' ? 'osiDb, osiLib, env, node, Date' : 'Date';
  const early = id === 'get-actuations-query' ? `if (!msg.payload || msg.payload.length === 0) {\n  msg.statusCode = 401;\n  msg.payload = { message: 'User not found' };\n  return [null, msg];\n}\n` : '';
  return `${early}const loaded = osiLib.require('zone-env');
if (!loaded.ok) {
  node.error('${id}: zone-env module unavailable: ' + loaded.error, msg);
  msg.statusCode = 503;
  msg.payload = { message: 'Internal error' };
  return ${id === 'get-actuations-query' ? '[null, msg]' : 'msg'};
}
return loaded.value.${METHODS[id]}(msg, { ${parameters} });\n`;
}
function adaptNode(node) {
  assert.ok(METHODS[node.id], 'not an X3 node');
  const original = legacy.find(n => n.id === node.id);
  // Do not silently overwrite intervening X1/X2 or package changes. The
  // dispatcher must re-characterise and regenerate the handoff on conflict.
  assert.ok(node.func === original.func || node.func === body(node.id), `${node.id}: source changed since characterization`);
  const next = { ...node, func: body(node.id) };
  if (!(node.libs || []).some(lib => lib.var === 'osiLib')) next.libs = [...(node.libs || []), { var: 'osiLib', module: 'osi-lib' }];
  return next;
}
function applyTo(flows) { return flows.map(n => METHODS[n.id] ? adaptNode(n) : n); }
const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const FLOW_PATHS = ['bcm2712', 'bcm2709'].map(p => `conf/full_raspberrypi_bcm27xx_${p}/files/usr/share/flows.json`);
const BASELINES = ['scripts/fixtures/silent-catch-baseline.json', 'scripts/verify-no-stray-ddl-baseline.json'];
const HANDOFF_FILES = [...FLOW_PATHS, ...BASELINES];
function renderHandoff(requested) {
  assert.ok(requested && path.isAbsolute(requested), 'pass an absolute scratch directory');
  const normalized = path.resolve(requested);
  assert.ok(normalized !== ROOT && !normalized.startsWith(ROOT + path.sep), 'scratch must be outside this checkout');
  fs.mkdirSync(normalized, { recursive: true });
  const scratch = fs.realpathSync(normalized);
  assert.ok(scratch !== ROOT && !scratch.startsWith(ROOT + path.sep), 'scratch symlink must be outside this checkout');
  for (const relative of FLOW_PATHS) {
    const original = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const flows = JSON.parse(original);
    assert.equal(JSON.stringify(flows, null, 2) + '\n', original, relative + ' roundtrip');
    const target = path.join(scratch, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(applyTo(flows), null, 2) + '\n');
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINES[0])));
  const { countSilentCatchesInFlow } = require('./verify-no-new-silent-catch');
  for (const entry of Object.values(baseline.profiles)) entry.silentCatchCount = countSilentCatchesInFlow(JSON.parse(fs.readFileSync(path.join(scratch, entry.path)))).silentCatchCount;
  baseline.generatedFrom += '; X3 moves six catches into visible module diagnostics; recount on the candidate, land this baseline only with its flows swap.';
  const silentPath = path.join(scratch, BASELINES[0]);
  fs.mkdirSync(path.dirname(silentPath), { recursive: true });
  fs.writeFileSync(silentPath, JSON.stringify(baseline, null, 2) + '\n');
  const env = { ...process.env, X3_REPO_ROOT: ROOT, X3_RENDER_ROOT: scratch,
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'lib/x3-flows-read-overlay.cjs') };
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/verify-no-stray-ddl.js', '--write-baseline', '--baseline', path.join(scratch, BASELINES[1])], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return scratch;
}
function renderPatch(scratch) {
  renderHandoff(scratch);
  const { spawnSync } = require('node:child_process');
  return HANDOFF_FILES.map(relative => {
    const diff = spawnSync('diff', ['-u', '--label', 'a/' + relative, '--label', 'b/' + relative, path.join(ROOT, relative), path.join(scratch, relative)], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    assert.ok(diff.status === 0 || diff.status === 1, diff.stderr);
    return diff.stdout;
  }).join('');
}
if (require.main === module) process.stdout.write(renderPatch(process.argv[2]));
module.exports = { adaptNode, applyTo, body, METHODS, renderHandoff, renderPatch, HANDOFF_FILES, FLOW_PATHS, BASELINES };
