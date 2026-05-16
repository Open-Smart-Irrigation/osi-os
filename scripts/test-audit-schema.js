#!/usr/bin/env node
// Asserts audit-pi-db.js REQUIRED_TABLES uses correct table names.

const { REQUIRED_TABLES: tables } = require('./audit-pi-db.js');

const MUST_HAVE = ['irrigation_zones', 'irrigation_schedules'];
const MUST_NOT_HAVE = ['zones', 'schedules'];

let ok = true;
for (const name of MUST_HAVE) {
    if (!tables[name]) {
        console.error(`FAIL M6: REQUIRED_TABLES missing correct name '${name}'`);
        ok = false;
    } else {
        console.log(`OK  M6: '${name}' present in REQUIRED_TABLES`);
    }
}
for (const name of MUST_NOT_HAVE) {
    if (tables[name]) {
        console.error(`FAIL M6: REQUIRED_TABLES has wrong short name '${name}'`);
        ok = false;
    } else {
        console.log(`OK  M6: wrong name '${name}' not present`);
    }
}

if (!ok) process.exit(1);
console.log('PASS: M6 audit table names are correct');
