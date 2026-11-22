'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixture=path.join(__dirname,'../fixtures/x3-zone-env');
const approved=/^zone-env (?:compatibility DDL (?:already present|failed):|OpenAgri current failed:|Open-Meteo current failed:|OpenAgri forecast failed:|Open-Meteo forecast failed:|error-path close failed:)/;
function compare(before,after,label) {
  const additional=after.diagnostics.filter(d=>d.kind==='warn'&&approved.test(String(d.value)));
  // Only the lead-approved warnings are exempt. Replies, SQL, IO, existing
  // diagnostics, cache/schema snapshots and close counts stay strict.
  const normalized={...after,diagnostics:after.diagnostics.filter(d=>!additional.includes(d))};
  if (before.branches && !before.branches.loads.includes('zone-env') && after.branches.loads.includes('zone-env')) {
    assert.equal(after.branches.loads.filter(n=>n==='zone-env').length,1,label+' added facade dependency cardinality');
    normalized.branches={...after.branches,loads:after.branches.loads.filter(n=>n!=='zone-env')};
  }
  assert.deepEqual(normalized,before,label);
  return additional;
}
function assertFrozenInput(flows) {
  const legacy=require('../fixtures/x3-zone-env/legacy-nodes.json');
  for(const node of legacy) assert.deepEqual(flows.find(n=>n.id===node.id),node,'capture requires the exact frozen legacy node '+node.id);
}
function assertOriginalBlobs() {
  const manifest=require('../fixtures/x3-zone-env/original-sha256.json');
  for(const [file,sha] of Object.entries(manifest)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture,file))).digest('hex'),sha,'original oracle is immutable: '+file);
}
module.exports={compare,approved,assertFrozenInput,assertOriginalBlobs};
