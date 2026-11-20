'use strict';
// Static guards and mutation controls inspect the exact exported implementation
// only after validating the complete adapter and its declared bindings.
const path = require('node:path');
const assert = require('node:assert/strict');
const { ENTRIES, stateOf } = require('./valve-ingress-x2-renderer');
const baseline = require('../fixtures/valve-ingress-x2/baseline.json');
const ROOT = path.resolve(__dirname, '../..');
function body(fn) { const s=fn.toString(); return s.slice(s.indexOf('\n')+1,s.lastIndexOf('\n}')); }
function resolvedNode(node, profile='bcm2712') {
  const entry = ENTRIES.find(e => e[0] === node.id);
  if (!entry || stateOf(node) === 'legacy') return node;
  const dir = path.join(ROOT,`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red/osi-command-ingress`);
  let source = body(require(path.join(dir,entry[2]))[entry[1]]);
  if (entry[1] === 'routeCommand') {
    const other = body(require(path.join(dir,'command-routing')).routeNonValveCommand);
    const branches = s => [...s.matchAll(/^if \([\s\S]*?^\}/gm)].map(m=>m[0]);
    const key = s => s.slice(0,s.indexOf('{')).trim();
    const available = new Map([...branches(source),...branches(other)].map(s=>[key(s),s]));
    const original = baseline.nodes.find(n=>n.id===node.id).func;
    const ordered = branches(original).map(s=>{assert.ok(available.has(key(s)));return available.get(key(s));});
    assert.equal(available.size,ordered.length,'unexpected router branch');
    source=source.slice(0,source.indexOf('\nif ('))+'\n'+ordered.join('\n\n')+'\nreturn null;';
  }
  return { ...node, func:source };
}
module.exports={resolvedNode,body};
