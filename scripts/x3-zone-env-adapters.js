'use strict';
// Exact handoff, prepared without writing either reserved flows.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const legacy = require('./fixtures/x3-zone-env/legacy-nodes.json');
const METHODS = { 'zone-env-fn': 'environmentSummary', 'strega-today-liters-fn': 'todayLiters', 'get-actuations-query': 'queryActuations', 'get-actuations-response': 'formatActuations' };
function body(id) {
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
return loaded.value.environmentSummary(msg, { db, ZE: loaded.value, osiLib, crypto, httpLib, httpsLib, env, node, global, Date });
})();\n`;
  const parameters = id === 'strega-today-liters-fn' ? 'osiDb, osiLib, crypto, env, node, global, Date' : id === 'get-actuations-query' ? 'osiDb, osiLib, env, node, Date' : 'Date';
  return `const loaded = osiLib.require('zone-env');
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
if (require.main === module) {
  // Deliberately no default repository write mode. Produce a reviewable patch
  // to stdout, or render into a caller-supplied scratch tree for gates.
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const requested = process.argv[2];
  assert.ok(requested && path.isAbsolute(requested), 'pass an absolute scratch directory');
  const normalized = path.resolve(requested);
  assert.ok(normalized !== root && !normalized.startsWith(root + path.sep), 'scratch must be outside this checkout');
  fs.mkdirSync(normalized, { recursive: true });
  const scratch = fs.realpathSync(normalized);
  assert.ok(scratch !== root && !scratch.startsWith(root + path.sep), 'scratch symlink must be outside this checkout');
  for (const profile of ['bcm2712', 'bcm2709']) {
    const relative = `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`;
    const original = fs.readFileSync(path.join(root, relative), 'utf8');
    const parsed = JSON.parse(original);
    assert.equal(JSON.stringify(parsed, null, 2) + '\n', original, relative + ' roundtrip');
    const target = path.join(scratch, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(applyTo(parsed), null, 2) + '\n');
    const diff = spawnSync('diff', ['-u', '--label', 'a/' + relative, '--label', 'b/' + relative, path.join(root, relative), target], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.ok(diff.status === 1, diff.stderr);
    process.stdout.write(diff.stdout);
  }
}
module.exports = { adaptNode, applyTo, body, METHODS };
