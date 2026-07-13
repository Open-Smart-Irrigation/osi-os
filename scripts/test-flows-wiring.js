#!/usr/bin/env node
// Combined flow-wiring regression guard.
// Asserts:
//   * STREGA actuation wiring (WS1 — C5/H2/L1/M8)
//   * osiDb.Database handles are always closed (WS2/WS3 osidb audit)
//   * Misc wiring invariants added during the WS2/WS3 review cycle
//     (gateway migration helpers, sync-force timeout, ACK flush gate,
//     S2120 zone_ids validation)
const fs = require('fs');
const path = require('path');

const flowsPath = path.resolve(
    __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(flows.filter((n) => n.id).map((n) => [n.id, n]));

let failures = [];

function hasLib(node, varName, moduleName) {
    const libs = Array.isArray(node && node.libs) ? node.libs : [];
    return libs.some((lib) => lib.var === varName && lib.module === moduleName);
}

function findHttpIn(method, url) {
    return flows.find((node) =>
        node.type === 'http in'
        && String(node.method || '').toLowerCase() === method
        && node.url === url
    );
}

function assertWires(nodeId, expectedWires, label) {
    const node = byId[nodeId];
    if (!node) {
        failures.push(`${label}: node ${nodeId} not found`);
        return;
    }
    const actual = JSON.stringify(node.wires);
    const expected = JSON.stringify(expectedWires);
    if (actual !== expected) {
        failures.push(`${label}: expected wires ${expected}, got ${actual}`);
        return;
    }
    console.log(`OK  ${label}`);
}

// === Field Journal Task 10 routes ===

const journalRoutes = [
    ['journal-catalog-get-http', 'get', '/api/journal/catalog'],
    ['journal-entries-get-http', 'get', '/api/journal/entries'],
    ['journal-entries-post-http', 'post', '/api/journal/entries'],
    ['journal-entry-put-http', 'put', '/api/journal/entries/:uuid'],
    ['journal-entry-void-post-http', 'post', '/api/journal/entries/:uuid/void'],
    ['journal-custom-vocab-post-http', 'post', '/api/journal/custom-vocab'],
    ['journal-custom-vocab-put-http', 'put', '/api/journal/custom-vocab/:uuid'],
    ['journal-plots-get-http', 'get', '/api/journal/plots'],
    ['journal-plots-post-http', 'post', '/api/journal/plots'],
    ['journal-plot-put-http', 'put', '/api/journal/plots/:uuid'],
    ['journal-plot-groups-get-http', 'get', '/api/journal/plot-groups'],
    ['journal-plot-groups-post-http', 'post', '/api/journal/plot-groups'],
    ['journal-plot-group-put-http', 'put', '/api/journal/plot-groups/:uuid'],
    ['journal-export-csv-get-http', 'get', '/api/journal/export.csv'],
    ['journal-export-package-get-http', 'get', '/api/journal/export.package'],
    ['journal-export-json-get-http', 'get', '/api/journal/export.json'],
    ['journal-export-adapt-get-http', 'get', '/api/journal/export.adapt.json'],
];

for (const [id, method, url] of journalRoutes) {
    const route = byId[id];
    if (!route || route.type !== 'http in' || route.method !== method || route.url !== url) {
        failures.push(`journal routes: missing exact ${method.toUpperCase()} ${url} [${id}]`);
    } else if (JSON.stringify(route.wires) !== JSON.stringify([['journal-api-router-fn']])) {
        failures.push(`journal routes: ${id} must wire only to journal-api-router-fn`);
    }
}

const journalRouter = byId['journal-api-router-fn'];
if (!journalRouter) {
    failures.push('journal routes: missing journal-api-router-fn');
} else {
    const exactLibs = [
        { var: 'osiDb', module: 'osi-db-helper' },
        { var: 'osiJournal', module: 'osi-journal' },
    ];
    if (JSON.stringify(journalRouter.libs) !== JSON.stringify(exactLibs)) {
        failures.push('journal routes: journal-api-router-fn must declare only the exact Task 10 libs');
    }
    if (JSON.stringify(journalRouter.wires) !== JSON.stringify([['journal-api-response']])) {
        failures.push('journal routes: router must wire to journal-api-response');
    }
    if (!/osiJournal\.handleHttpRequest/.test(journalRouter.func || '')) {
        failures.push('journal routes: router must delegate lifecycle and database close to osi-journal');
    }
    if (!/edgeBuildVersion:\s*env\.get\('FIRMWARE_VERSION'\)/.test(journalRouter.func || '')) {
        failures.push('journal routes: router must pass the available firmware version to research exports');
    }
    if (!/edgeBuildCommit:\s*env\.get\('FIRMWARE_COMMIT'\)/.test(journalRouter.func || '')) {
        failures.push('journal routes: router must pass the available firmware commit to research exports');
    }
}

assertWires('record-error-catch-journal-api', [['record-error-link-out-journal-api']], 'journal catch → error link out');

for (const profile of ['bcm2712', 'bcm2709']) {
    const profilePath = path.resolve(
        __dirname,
        `../conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`
    );
    const profileFlows = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const profileById = Object.fromEntries(profileFlows.filter((node) => node.id).map((node) => [node.id, node]));
    const journalObjects = profileFlows.filter((node) => node.id === 'journal-api-tab' || node.z === 'journal-api-tab');
    if (journalObjects.length !== 22) {
        failures.push(`journal routes ${profile}: expected exactly 22 journal objects, got ${journalObjects.length}`);
    }
    for (const [id, method, url] of journalRoutes) {
        const route = profileById[id];
        if (!route || route.type !== 'http in' || route.method !== method || route.url !== url ||
            JSON.stringify(route.wires) !== JSON.stringify([['journal-api-router-fn']])) {
            failures.push(`journal routes ${profile}: invalid ${method.toUpperCase()} ${url} [${id}]`);
        }
    }
    const router = profileById['journal-api-router-fn'];
    if (!router || router.func.length > 4096 ||
        JSON.stringify(router.libs) !== JSON.stringify([
            { var: 'osiDb', module: 'osi-db-helper' },
            { var: 'osiJournal', module: 'osi-journal' },
        ]) || JSON.stringify(router.wires) !== JSON.stringify([['journal-api-response']])) {
        failures.push(`journal routes ${profile}: router surface is not exact`);
    }
    const errorIn = profileById['record-error-link-in'];
    const errorOut = profileById['record-error-link-out-journal-api'];
    const reciprocalCount = errorIn && Array.isArray(errorIn.links)
        ? errorIn.links.filter((id) => id === 'record-error-link-out-journal-api').length
        : 0;
    if (reciprocalCount !== 1 || !errorOut ||
        JSON.stringify(errorOut.links) !== JSON.stringify(['record-error-link-in'])) {
        failures.push(`journal routes ${profile}: error links are not reciprocal and unique`);
    }
}

// === Field request intake + status apply wiring ===

for (const route of [
    { method: 'get', url: '/api/improvement-requests' },
    { method: 'get', url: '/api/improvement-requests/diagnostics-preview' },
    { method: 'post', url: '/api/improvement-requests' },
]) {
    const node = findHttpIn(route.method, route.url);
    if (!node) {
        failures.push(`Field requests: missing HTTP IN ${route.method.toUpperCase()} ${route.url}`);
        continue;
    }
    if (JSON.stringify(node.wires || []) !== JSON.stringify([['improvement-requests-api-router']])) {
        failures.push(`Field requests: ${route.method.toUpperCase()} ${route.url} does not wire to improvement-requests-api-router`);
        continue;
    }
    console.log(`OK  Field requests: ${route.method.toUpperCase()} ${route.url} present`);
}

const intakeRouter = byId['improvement-requests-api-router'];
if (!intakeRouter) {
    failures.push('Field requests: improvement-requests-api-router not found');
} else {
    if (!hasLib(intakeRouter, 'osiDb', 'osi-db-helper')) {
        failures.push('Field requests: improvement-requests-api-router missing osiDb lib binding');
    }
    if (!/\.close\s*\(/.test(intakeRouter.func || '')) {
        failures.push('Field requests: improvement-requests-api-router opens DB without .close(');
    }
    if (!/contact_email/i.test(intakeRouter.func || '')) {
        failures.push('Field requests: improvement-requests-api-router does not persist contact_email');
    }
    if (hasLib(intakeRouter, 'osiDb', 'osi-db-helper') && /\.close\s*\(/.test(intakeRouter.func || '') && /contact_email/i.test(intakeRouter.func || '')) {
        console.log('OK  Field requests: intake router declares osiDb, closes DB, and persists contact_email');
    }
}

const pendingSplit = byId['sync-pending-split'];
if (!pendingSplit) {
    failures.push('Field requests: sync-pending-split not found');
} else {
    if (pendingSplit.outputs !== 2) {
        failures.push(`Field requests: sync-pending-split expected 2 outputs, got ${pendingSplit.outputs}`);
    }
    const wires = JSON.stringify(pendingSplit.wires || []);
    const expected = JSON.stringify([['reject-indefinite-open'], ['work-request-status-apply']]);
    if (wires !== expected) {
        failures.push(`Field requests: sync-pending-split expected wires ${expected}, got ${wires}`);
    }
    if (pendingSplit.outputs === 2 && wires === expected) {
        console.log('OK  Field requests: pending commands split status updates away from actuator path');
    }
}

const statusApply = byId['work-request-status-apply'];
if (!statusApply) {
    failures.push('Field requests: work-request-status-apply not found');
} else {
    if (!hasLib(statusApply, 'osiDb', 'osi-db-helper')) {
        failures.push('Field requests: work-request-status-apply missing osiDb lib binding');
    }
    if (!/UPDATE\s+improvement_requests/i.test(statusApply.func || '')) {
        failures.push('Field requests: work-request-status-apply does not update improvement_requests');
    }
    if (JSON.stringify(statusApply.wires || []) !== JSON.stringify([['command-ack-queue-rest']])) {
        failures.push('Field requests: work-request-status-apply does not wire to command-ack-queue-rest');
    }
    if (
        hasLib(statusApply, 'osiDb', 'osi-db-helper')
        && /UPDATE\s+improvement_requests/i.test(statusApply.func || '')
        && JSON.stringify(statusApply.wires || []) === JSON.stringify([['command-ack-queue-rest']])
    ) {
        console.log('OK  Field requests: status apply updates improvement_requests and queues ACK');
    }
}

// === WS1 STREGA wiring (C5 / H2 / L1 / M8) ===

// C5: from scheduler/manual must wire to write-strega-expectation (not directly to Build STREGA downlink)
assertWires('5974306566e99a92',
    [['072f29aa8760340a', 'write-strega-expectation']],
    'C5: from-scheduler/manual → write-strega-expectation');

// C5: write-strega-expectation must wire directly to Build STREGA downlink
assertWires('write-strega-expectation',
    [['cdbaa3891d40d7a1']],
    'C5: write-strega-expectation → Build STREGA downlink');

// H2: reconciliation monitor must handle OBSERVED_RUNNING stale timeout
const reconcNode = byId['strega-reconciliation-monitor'];
if (!reconcNode) {
    failures.push('H2: strega-reconciliation-monitor not found');
} else if (!reconcNode.func.includes('STALE_OPEN_OBSERVED')) {
    failures.push('H2: strega-reconciliation-monitor missing STALE_OPEN_OBSERVED transition');
} else {
    console.log('OK  H2: STALE_OPEN_OBSERVED present in reconciliation monitor');
}

// L1: write-strega-expectation and reject-indefinite-open must not fall back to {}
for (const nodeId of ['write-strega-expectation', 'reject-indefinite-open']) {
    const n = byId[nodeId];
    if (!n) {
        failures.push(`L1: node ${nodeId} not found`);
        continue;
    }
    if (n.func.includes("flow.get('command_types') || {}")) {
        failures.push(`L1: ${nodeId} falls back to {} on startup race`);
        continue;
    }
    console.log(`OK  L1: ${nodeId} has hardcoded fallback`);
}

// M8: today-liters HTTP endpoint nodes must exist
for (const id of ['strega-today-liters-http-in', 'strega-today-liters-fn', 'strega-today-liters-http-out']) {
    if (!byId[id]) {
        failures.push(`M8: node ${id} not found`);
        continue;
    }
    console.log(`OK  M8: ${id} present`);
}

// === WS2/WS3 osiDb.Database close audit ===

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
    leaks.forEach((l) => console.error('  - ' + l));
    process.exit(1);
}
console.log('OK  osiDb.Database: every opening node closes it');

// === Function-node library declaration audit ===

const helperGlobals = [
    { varName: 'osiDb', moduleName: 'osi-db-helper', rx: /\bosiDb\./ },
    { varName: 'osiCloudHttp', moduleName: 'osi-cloud-http', rx: /\bosiCloudHttp\./ },
    { varName: 'chameleon', moduleName: 'osi-chameleon-helper', rx: /\bchameleon\./ },
    { varName: 'dendro', moduleName: 'osi-dendro-helper', rx: /\bdendro\./ },
];

for (const node of flows) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    const libs = Array.isArray(node.libs) ? node.libs : [];
    for (const { varName, moduleName, rx } of helperGlobals) {
        if (!rx.test(node.func)) continue;
        if (!libs.some((lib) => lib.var === varName && lib.module === moduleName)) {
            failures.push(`${node.name || '(unnamed)'} [${node.id}] references ${varName} without libs entry ${moduleName}`);
        }
    }
}
if (!failures.some((failure) => failure.includes('without libs entry'))) {
    console.log('OK  function node helper globals all declare matching libs entries');
}

// === WS2/WS3 misc wiring invariants ===

for (const node of flows) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    const label = (node.name || '(unnamed)') + ' [' + node.id + ']';
    if (/runGatewayMigrationPreflight/.test(node.func)) {
        if (!/const q = \(sql, params = \[\]\) =>/.test(node.func)) {
            failures.push(label + ' defines gateway migration preflight without a parameterized q helper');
        }
        if (!/const run = \(sql, params = \[\]\) =>/.test(node.func)) {
            failures.push(label + ' defines gateway migration preflight without a parameterized run helper');
        }
    }
    if (node.id === 'sync-force-build'
        && !/req\.setTimeout\(timeoutMs/.test(node.func)
        && !/timeoutMs:\s*Number\(env\.get\('OSI_CLOUD_REST_TIMEOUT_MS'/.test(node.func)) {
        failures.push(label + ' requestJson lacks a timeout guard');
    }
    if (node.id === 'command-ack-build-batch' && !/gatewayMigrationPendingBootstrap/.test(node.func)) {
        failures.push(label + ' does not gate ACK flushes on stable gateway identity');
    }
    if (node.id === 's2120-zones-put-auth-fn') {
        if (!/const rawZoneIds =/.test(node.func) || !/Number\.isInteger/.test(node.func)) {
            failures.push(label + ' does not reject malformed zone_ids before deleting assignments');
        }
    }
}

// === Global Settings module gates ===

const disableAllSchedulesHttp = flows.find((node) => (
    node.type === 'http in'
    && node.method === 'post'
    && node.url === '/api/irrigation-zones/schedules/disable-all'
));
if (!disableAllSchedulesHttp) {
    failures.push('settings modules: missing POST /api/irrigation-zones/schedules/disable-all endpoint');
} else {
    console.log('OK  settings modules: bulk schedule-disable endpoint present');
}

const disableAllSchedulesFn = flows.find((node) => (
    node.type === 'function'
    && node.name === 'Disable All Schedules'
));
if (!disableAllSchedulesFn || typeof disableAllSchedulesFn.func !== 'string') {
    failures.push('settings modules: missing Disable All Schedules function');
} else {
    const func = disableAllSchedulesFn.func;
    if (!/verifyBearer/.test(func)) {
        failures.push('settings modules: Disable All Schedules must verify bearer auth');
    }
    if (!/UPDATE\s+irrigation_schedules/i.test(func) || !/SET\s+enabled\s*=\s*0/i.test(func)) {
        failures.push('settings modules: Disable All Schedules must deactivate irrigation_schedules.enabled');
    }
    if (!/irrigation_zones/.test(func) || !/user_id/.test(func)) {
        failures.push('settings modules: Disable All Schedules must scope updates to the authenticated user zones');
    }
    if (!/disabledSchedules/.test(func)) {
        failures.push('settings modules: Disable All Schedules response must report disabledSchedules');
    }
    if (/\b(valve|downlink|strega|chirpstack|mqtt|device_queue)\b/i.test(func)) {
        failures.push('settings modules: Disable All Schedules must not touch valve/downlink command paths');
    }
    const libs = Array.isArray(disableAllSchedulesFn.libs) ? disableAllSchedulesFn.libs : [];
    if (!libs.some((lib) => lib.var === 'osiDb' && lib.module === 'osi-db-helper')) {
        failures.push('settings modules: Disable All Schedules must use osi-db-helper');
    }
}

if (failures.length > 0) {
    console.error('FAIL: ' + failures.length + ' flow wiring regression(s):');
    failures.forEach((l) => console.error('  - ' + l));
    process.exit(1);
}

console.log('PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed');
