#!/usr/bin/env node
'use strict';
// Build step for the boot runner: lifts the frozen boot node "Sync Init
// Schema + Triggers" (sync-init-fn) out of the shipped flows.json, checks it
// against edge/boot/sync-init.pin and writes edge/boot/sync-init-fn.generated.json,
// the only copy of the body that run-sync-init.js executes.
//
//   node edge/boot/gen-sync-init.js            write the generated file
//   node edge/boot/gen-sync-init.js --check    CI: fail if the node, its
//                                              wiring or the generated file
//                                              no longer match the pin
//
// Besides the body hash it checks everything else that changes what the node
// does without changing its body: libs, On Start/On Stop code, a timeout,
// group or flow environment variables (env.get resolution), the inject that
// starts it, and that both image profiles carry the same node.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
const PROFILES = ['bcm2712', 'bcm2709']; // canonical first (AGENTS.md profile parity)
const flowsPath = (p) => `conf/full_raspberrypi_bcm27xx_${p}/files/usr/share/flows.json`;
const PIN_FILE = path.join(__dirname, 'sync-init.pin');
const OUT_FILE = path.join(__dirname, 'sync-init-fn.generated.json');
const NODE_ID = 'sync-init-fn';
const EXPECTED_LIBS = [{ var: 'osiDb', module: 'osi-db-helper' }];

const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function readPin(file = PIN_FILE) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const m = lines.length === 1 && /^sync-init-fn sha256 ([0-9a-f]{64})$/.exec(lines[0].trim());
  if (!m) throw new Error('sync-init.pin: expected exactly one line "sync-init-fn sha256 <64 hex>"');
  return m[1];
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emptyEnv = (env) => env === undefined || (Array.isArray(env) && env.length === 0);

// Every check that guards the runner's semantics, for one profile.
function inspectProfile(profile, root = ROOT) {
  const rel = flowsPath(profile);
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const flows = JSON.parse(text);
  const lines = text.split('\n');
  const problems = [];
  const nodes = flows.filter((n) => n.id === NODE_ID);
  if (nodes.length !== 1) throw new Error(`${rel}: expected one node ${NODE_ID}, found ${nodes.length}`);
  const node = nodes[0];
  const nodeLine = lines.findIndex((l) => l.includes(`"id": "${NODE_ID}"`)) + 1;
  let funcLine = 0;
  for (let i = nodeLine; i < lines.length && i < nodeLine + 40; i++) {
    if (/^\s*"func":/.test(lines[i])) { funcLine = i + 1; break; }
  }
  if (node.type !== 'function') problems.push('type is ' + node.type + ', not function');
  if (typeof node.func !== 'string' || !node.func) problems.push('func is empty');
  if (!sameJson(node.libs, EXPECTED_LIBS)) problems.push('libs changed: ' + JSON.stringify(node.libs));
  if ((node.initialize || '').trim()) problems.push('On Start code present');
  if ((node.finalize || '').trim()) problems.push('On Stop code present');
  if (node.timeout !== undefined && Number(node.timeout) !== 0) problems.push('timeout set: ' + node.timeout);
  if (node.g) problems.push('node is in a group (env.get would read group env): ' + node.g);
  if (node.d) problems.push('node is disabled');
  if (!sameJson(node.wires, [[]])) problems.push('node has downstream wires: ' + JSON.stringify(node.wires));
  const tab = flows.find((n) => n.id === node.z);
  if (!tab || tab.type !== 'tab') problems.push('node is not on a flow tab');
  else {
    if (tab.disabled) problems.push('flow tab is disabled');
    if (!emptyEnv(tab.env)) problems.push('flow tab defines env variables: ' + JSON.stringify(tab.env));
  }
  for (const g of flows.filter((n) => n.type === 'global-config')) {
    if (!emptyEnv(g.env)) problems.push('global-config defines env variables: ' + JSON.stringify(g.env));
  }
  const feeders = flows.filter((n) => Array.isArray(n.wires) && n.wires.flat().includes(NODE_ID));
  const linkIns = flows.filter((n) => n.type === 'link in' && Array.isArray(n.wires) && n.wires.flat().includes(NODE_ID));
  if (feeders.length !== 1 || linkIns.length) problems.push('expected exactly one feeder, found ' + feeders.map((n) => n.id).join(','));
  const inject = feeders[0];
  if (inject && !(inject.type === 'inject' && inject.once === true && !inject.repeat && !inject.crontab && !inject.d)) {
    problems.push('feeder is no longer a once-at-start inject: ' + JSON.stringify({ id: inject.id, type: inject.type, once: inject.once, repeat: inject.repeat, crontab: inject.crontab }));
  }
  return {
    profile, path: rel, node, nodeLine, funcLine, problems,
    inject: inject ? { id: inject.id, name: inject.name, onceDelay: inject.onceDelay, line: lines.findIndex((l) => l.includes(`"id": "${inject.id}"`)) + 1 } : null,
    tab: tab ? { id: tab.id, label: tab.label } : null,
    sha256: sha256(node.func || ''),
  };
}

function build(root = ROOT, pinFile = PIN_FILE) {
  const pin = readPin(pinFile);
  const [canon, mirror] = PROFILES.map((p) => inspectProfile(p, root));
  const problems = [];
  for (const r of [canon, mirror]) for (const p of r.problems) problems.push(`${r.path}: ${p}`);
  if (canon.sha256 !== pin) problems.push(`${canon.path}: sync-init-fn body sha256 ${canon.sha256} differs from sync-init.pin ${pin}`);
  if (mirror.sha256 !== canon.sha256) problems.push(`${mirror.path}: sync-init-fn body differs from the canonical profile (profile parity)`);
  if (!sameJson(mirror.node.libs, canon.node.libs)) problems.push(`${mirror.path}: libs differ from the canonical profile`);
  const generated = {
    _comment: 'GENERATED by edge/boot/gen-sync-init.js from the canonical flows.json; do not edit. run-sync-init.js executes "func" after checking it against sync-init.pin.',
    node: NODE_ID,
    name: canon.node.name,
    sha256: canon.sha256,
    source: { path: canon.path, nodeLine: canon.nodeLine, funcLine: canon.funcLine, tab: canon.tab, inject: canon.inject },
    libs: canon.node.libs,
    outputs: canon.node.outputs,
    func: canon.node.func,
  };
  return { problems, generated, text: JSON.stringify(generated, null, 2) + '\n' };
}

function main(argv) {
  const check = argv.includes('--check');
  const { problems, text, generated } = build();
  if (problems.length) {
    for (const p of problems) console.error('gen-sync-init: FAIL ' + p);
    return 1;
  }
  if (check) {
    let current = null;
    try { current = fs.readFileSync(OUT_FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current !== text) {
      console.error('gen-sync-init: FAIL edge/boot/sync-init-fn.generated.json is missing or stale; run node edge/boot/gen-sync-init.js');
      return 1;
    }
    console.log(`gen-sync-init: ok sync-init-fn sha256 ${generated.sha256} (both profiles, pin, generated file)`);
    return 0;
  }
  fs.writeFileSync(OUT_FILE, text);
  console.log(`gen-sync-init: wrote ${path.relative(ROOT, OUT_FILE)} sha256 ${generated.sha256}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('gen-sync-init: FAIL ' + (e && e.stack || e)); process.exitCode = 2; }
}
module.exports = { build, readPin, inspectProfile, sha256, NODE_ID, EXPECTED_LIBS };
