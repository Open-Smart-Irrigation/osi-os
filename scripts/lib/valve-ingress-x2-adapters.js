'use strict';
const { adaptFlows } = require('./valve-ingress-x2-renderer');
function entryBridge(ingress, original) {
  // Only the independent ingress lookup is supplied here. Valve failures,
  // quarantine and scope resolution continue through the caller's loader.
  return { require(name) {
    if (name !== 'command-ingress') return original.require(name);
    return { ok:true, value:ingress };
  } };
}
const DIAGNOSTICS = /^X2 (?:fan (?:hwmon name|hwmon list|PWM detection|PWM period|PWM disable)|cancel close): /;
function comparable(result) {
  const copy = JSON.parse(JSON.stringify(result));
  copy.effects = copy.effects.filter(effect => !(effect[0] === 'warn' && DIAGNOSTICS.test(effect[1])));
  // The only approved response change is unavailable/quarantined valve control.
  function normalize(value) {
    if (!value || typeof value !== 'object') return;
    if (value.statusCode === 503 && /^valve control module unavailable: /.test(value.payload?.message || '')) value.statusCode = 500;
    for (const child of Object.values(value)) normalize(child);
  }
  normalize(copy);
  return copy;
}
module.exports = { adaptFlows, entryBridge, comparable, DIAGNOSTICS };
