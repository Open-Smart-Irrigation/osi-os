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
let wiringFailures = [];
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

for (const node of flows) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    const label = (node.name || '(unnamed)') + ' [' + node.id + ']';
    if (/runGatewayMigrationPreflight/.test(node.func)) {
        if (!/const q = \(sql, params = \[\]\) =>/.test(node.func)) {
            wiringFailures.push(label + ' defines gateway migration preflight without a parameterized q helper');
        }
        if (!/const run = \(sql, params = \[\]\) =>/.test(node.func)) {
            wiringFailures.push(label + ' defines gateway migration preflight without a parameterized run helper');
        }
    }
    if (node.id === 'sync-force-build' && !/req\.setTimeout\(timeoutMs/.test(node.func)) {
        wiringFailures.push(label + ' requestJson lacks a timeout guard');
    }
    if (node.id === 'command-ack-build-batch' && !/gatewayMigrationPendingBootstrap/.test(node.func)) {
        wiringFailures.push(label + ' does not gate ACK flushes on stable gateway identity');
    }
    if (node.id === 's2120-zones-put-auth-fn') {
        if (!/const rawZoneIds =/.test(node.func) || !/Number\.isInteger/.test(node.func)) {
            wiringFailures.push(label + ' does not reject malformed zone_ids before deleting assignments');
        }
    }
}
if (wiringFailures.length > 0) {
    console.error('FAIL: ' + wiringFailures.length + ' flow wiring regression(s):');
    wiringFailures.forEach(l => console.error('  - ' + l));
    process.exit(1);
}

console.log('PASS: flow DB close and wiring guards passed');
