'use strict';
// Operator registry: every lib/mutate-op-*.js file is one operator. A new
// tier-B family is a new file here, never a per-case block in the runner.
const fs = require('node:fs'), path = require('node:path');
function loadOperators(filter) {
  const ops = fs.readdirSync(__dirname).filter((f) => /^mutate-op-.+\.js$/.test(f)).sort()
    .map((f) => require(path.join(__dirname, f)));
  const names = new Set(ops.map((o) => o.name));
  if (filter) for (const n of filter) if (!names.has(n)) throw new Error('unknown operator ' + n + ' (have ' + [...names].join(', ') + ')');
  return filter ? ops.filter((o) => filter.includes(o.name)) : ops;
}
module.exports = { loadOperators };
