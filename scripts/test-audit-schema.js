#!/usr/bin/env node
// Asserts audit-pi-db.js REQUIRED_TABLES uses correct table names.

const { REQUIRED_TABLES: tables } = require('./audit-pi-db.js');

const MUST_HAVE = ['irrigation_zones', 'irrigation_schedules'];
const MUST_NOT_HAVE = ['zones', 'schedules'];
const APPLIED_COMMAND_COLUMNS = [
    'command_id',
    'device_eui',
    'command_type',
    'result_detail',
    'attempt_count',
    'last_error',
    'last_ack_attempt_at',
    'expires_at',
];

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
for (const column of APPLIED_COMMAND_COLUMNS) {
    if (!tables.applied_commands || !tables.applied_commands.includes(column)) {
        console.error(`FAIL M6: applied_commands audit requirement missing '${column}'`);
        ok = false;
    } else {
        console.log(`OK  M6: applied_commands audit requires '${column}'`);
    }
}

if (!ok) process.exit(1);
console.log('PASS: M6 audit table names are correct');
