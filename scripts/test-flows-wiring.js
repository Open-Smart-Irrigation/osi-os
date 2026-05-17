#!/usr/bin/env node
// Regression guard: every function node opening osiDb.Database must close it.
// osi-os uses sqlite3 (async callback API), so close calls look like
// `db.close((err) => ...)` or wrappers like `await close()` where close is a
// promise wrapper around `_db.close(cb)`. We accept any `\b\w*db\.close\s*\(`
// match anywhere in the function body as evidence of a close.
const fs = require('fs');
const path = require('path');

const flowsPath = path.resolve(__dirname,
    '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));

const OPEN_RX = /new\s+osiDb\.Database/;
// Any `.close(` anywhere in the function body counts. osi-os variable names
// for the db handle vary (db, _db, _dbS2120, etc.), so a name-anchored regex
// produces false negatives. False positives are theoretically possible
// (an unrelated `.close(` call on a Stream, say) but none exist today.
const CLOSE_RX = /\.close\s*\(/;

let leaks = [];
for (const node of flows) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    if (!OPEN_RX.test(node.func)) continue;
    if (CLOSE_RX.test(node.func)) continue;
    leaks.push((node.name || '(unnamed)') + ' [' + node.id + ']');
}
if (leaks.length > 0) {
    console.error('FAIL: ' + leaks.length + ' function node(s) open osiDb.Database without closing it:');
    leaks.forEach(l => console.error('  - ' + l));
    process.exit(1);
}
console.log('PASS: every osiDb-opening function node closes it');
