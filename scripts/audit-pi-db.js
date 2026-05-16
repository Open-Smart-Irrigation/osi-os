#!/usr/bin/env node
// audit-pi-db.js — read-only audit of a deployed Pi /data/db/farming.db
// Usage: node scripts/audit-pi-db.js [/data/db/farming.db]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const dbPath = process.argv[2] || '/data/db/farming.db';

function sql(query) {
    try {
        return execFileSync('sqlite3', ['-readonly', dbPath, query], {
            encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
        }).trim();
    } catch (e) {
        return `ERROR: ${e.message}`;
    }
}

console.log(`Auditing ${dbPath} at ${new Date().toISOString()}`);
console.log('');

// 1. File health
if (!fs.existsSync(dbPath)) { console.error('FAIL: DB file missing'); process.exit(1); }
const stat = fs.statSync(dbPath);
console.log(`File size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

// Check for WAL/SHM sidecars
['-wal', '-shm', '-journal'].forEach(suffix => {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) console.log(`Sidecar present: ${suffix} (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
});

// 2. Integrity check
console.log('');
const integrity = sql('PRAGMA integrity_check;');
console.log(`Integrity: ${integrity}`);

// 3. Expected tables
const required = [
    'devices', 'device_data', 'zones', 'schedules', 'sync_outbox', 'sync_inbox',
    'valve_actuation_expectations', 'zone_irrigation_calibration', 'applied_commands',
    'actuator_log', 'users'
];
const tables = sql(".tables").split(/\s+/).filter(Boolean);
console.log(`\nTable count: ${tables.length}`);
for (const t of required) {
    const present = tables.includes(t);
    console.log(`  ${present ? 'OK' : 'MISSING'} ${t}`);
}

// 4. Row counts
console.log('');
const countSql = tables.map(t => `SELECT '${t}' AS tbl, COUNT(*) FROM ${t}`).join(' UNION ALL ');
const rows = sql(countSql);
rows.split('\n').filter(l => l).forEach(line => {
    const [tbl, count] = line.split('|');
    if (parseInt(count) > 0) console.log(`  ${tbl}: ${count} rows`);
});

// 5. Open valve state
console.log('');
const openValves = sql("SELECT deveui, name, current_state, last_seen FROM devices WHERE type_id = 'STREGA_VALVE' AND current_state = 'OPEN'");
if (openValves) console.log(`OPEN valves:\n${openValves}`);
else console.log('No OPEN valves');

// 6. Pending sync outbox
const outboxCount = sql("SELECT COUNT(*) FROM sync_outbox");
console.log(`\nPending outbox events: ${outboxCount}`);

// 7. Unresolved expectations
const unresolved = sql("SELECT COUNT(*) FROM valve_actuation_expectations WHERE reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')");
console.log(`Unresolved actuation expectations: ${unresolved}`);

console.log('\naudit-pi-db: OK');
