#!/usr/bin/env node
// WS1 verification: STREGA actuation expectations, calibration, dispatch rejection,
// reconciliation monitor, and explicit cancel path.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SEED_DB_PATHS = [
    path.join(REPO, 'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db'),
    path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db'),
    path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db'),
    path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db'),
    path.join(REPO, 'database/farming.db'),
    path.join(REPO, 'web/react-gui/farming.db'),
];
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const STREGA_CARD = path.join(REPO, 'web/react-gui/src/components/farming/StregaValveCard.tsx');
const VALVE_CANCEL_BUTTON = path.join(REPO, 'web/react-gui/src/components/farming/ValveCancelButton.tsx');
const FARMING_TYPES = path.join(REPO, 'web/react-gui/src/types/farming.ts');
const CHIRPSTACK_HELPER = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js');

function readFlows() {
    return JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
}

function findFunctionNode(flows, name) {
    return flows.find(n => n.type === 'function' && n.name === name);
}

function assertFunctionNode(name) {
    const node = findFunctionNode(readFlows(), name);
    if (!node) throw new Error(`Missing function node "${name}"`);
    return node;
}

function assertNodeLib(node, varName, moduleName) {
    const libs = Array.isArray(node.libs) ? node.libs : [];
    const found = libs.some(lib => lib.var === varName && lib.module === moduleName);
    if (!found) throw new Error(`"${node.name}" must declare ${varName} from ${moduleName}`);
}

function assertAsyncOsiDb(node) {
    assertNodeLib(node, 'osiDb', 'osi-db-helper');
    if (!node.func.includes('new osiDb.Database')) {
        throw new Error(`"${node.name}" must use the async osi-db-helper Database`);
    }
    if (node.func.includes("flow.get('db')") || node.func.includes('flow.get("db")') || node.func.includes('.prepare(')) {
        throw new Error(`"${node.name}" must not use a synchronous flow DB/.prepare API`);
    }
}

function assertTable(dbPath, name, requiredColumns) {
    const output = execFileSync('sqlite3', [dbPath, `pragma table_info(${name});`], { encoding: 'utf8' });
    const cols = output.trim().split('\n').filter(l => l).map(l => l.split('|')[1]);
    if (cols.length === 0) throw new Error(`Missing required table: ${name}`);
    for (const col of requiredColumns) {
        if (!cols.includes(col)) throw new Error(`Table ${name} missing column: ${col}`);
    }
    console.log(`  ok ${name} has required columns`);
}

function checkSchema() {
    for (const dbPath of SEED_DB_PATHS) {
        const relative = path.relative(REPO, dbPath);
        assertTable(dbPath, 'valve_actuation_expectations', [
            'expectation_id', 'device_eui', 'zone_id', 'command_id', 'effect_key',
            'commanded_at', 'commanded_duration_seconds', 'expected_close_at',
            'flow_rate_lpm', 'flow_rate_source', 'estimated_gross_liters', 'volume_source',
            'observed_open_at', 'observed_close_at', 'reconciliation_state',
            'cancel_reason', 'created_at',
        ]);
        assertTable(dbPath, 'zone_irrigation_calibration', [
            'zone_id', 'valve_device_eui', 'measured_flow_rate_lpm',
            'measurement_method', 'measured_at', 'created_at', 'updated_at',
        ]);
        console.log(`  ok ${relative} has STREGA safety tables`);
    }
}

function assertIndefiniteOpenRejection() {
    const node = assertFunctionNode('Reject Indefinite Open');
    if (!node.func.includes('requires_duration')) {
        throw new Error('"Reject Indefinite Open" must check requires_duration from the command-type registry');
    }
    if (!node.func.includes("command_type === 'OPEN'")) {
        throw new Error('"Reject Indefinite Open" must explicitly reject command_type === "OPEN"');
    }
    if (node.func.indexOf("command_type === 'OPEN'") > node.func.indexOf('const entry = types')) {
        throw new Error('"Reject Indefinite Open" must reject OPEN before registry lookup so the explicit safety log is reachable');
    }
    console.log('  ok Indefinite-open rejection node present');
}

function assertValveRestRejectsIndefiniteOpen() {
    const node = assertFunctionNode('Auth + Validate + Normalize');
    if (!node.func.includes('duration_seconds')) {
        throw new Error('"Auth + Validate + Normalize" must accept duration_seconds from the GUI/API request');
    }
    if (!node.func.includes("finalAction === 'OPEN'")) {
        throw new Error('"Auth + Validate + Normalize" must explicitly handle plain OPEN');
    }
    if (!node.func.includes('Indefinite OPEN')) {
        throw new Error('"Auth + Validate + Normalize" must reject plain OPEN when no duration is provided');
    }
    if (!node.func.includes("finalAction = 'OPEN_FOR_DURATION'")) {
        throw new Error('"Auth + Validate + Normalize" must normalize timed OPEN requests to OPEN_FOR_DURATION');
    }
    console.log('  ok REST valve endpoint rejects indefinite OPEN and accepts duration_seconds');
}

function assertRouteHandlesSafeValveCommands() {
    const node = assertFunctionNode('Route Command');
    for (const required of ["cmd.command_type", "commandType === 'OPEN_FOR_DURATION'", "commandType === 'CLOSE'", '_stregaExpectationCommand']) {
        if (!node.func.includes(required)) {
            throw new Error(`"Route Command" must preserve and route registry valve commands (${required})`);
        }
    }
    console.log('  ok Route Command handles duration-bound valve registry commands');
}

function assertWriteExpectation() {
    const node = assertFunctionNode('Write STREGA Expectation');
    assertAsyncOsiDb(node);
    const required = [
        'valve_actuation_expectations',
        'isTimedOpen',
        'commanded_duration_seconds',
        'expected_close_at',
        'estimated_gross_liters',
        'volume_source',
        'effect_key',
        'measured_flow_meter',
        'estimated_duration_flow_rate',
    ];
    for (const k of required) {
        if (!node.func.includes(k)) throw new Error(`"Write STREGA Expectation" missing reference to ${k}`);
    }
    console.log('  ok Write-expectation node present and references required fields');
}

function assertReconciliationMonitor() {
    const flows = readFlows();
    const inject = flows.find(n =>
        n.type === 'inject' && n.name === 'STREGA Reconciliation Tick'
    );
    if (!inject) throw new Error('Missing inject node "STREGA Reconciliation Tick"');
    if (String(inject.repeat) !== '60') {
        throw new Error(`STREGA Reconciliation Tick must repeat every 60 seconds (got: ${inject.repeat})`);
    }
    const monitor = flows.find(n =>
        n.type === 'function' && n.name === 'STREGA Reconciliation Monitor'
    );
    if (!monitor) throw new Error('Missing function node "STREGA Reconciliation Monitor"');
    assertAsyncOsiDb(monitor);
    for (const state of ['OBSERVED_RUNNING', 'OBSERVED_COMPLETE', 'STALE_NO_OBSERVATION']) {
        if (!monitor.func.includes(state)) {
            throw new Error(`Reconciliation monitor missing state transition: ${state}`);
        }
    }
    if (monitor.func.match(/issue.*CLOSE/i) || monitor.func.match(/send.*close.*downlink/i)) {
        throw new Error('Reconciliation monitor must NOT issue a CLOSE downlink on timer elapse');
    }
    console.log('  ok STREGA reconciliation monitor present with required state transitions');
}

function assertCancelPath() {
    const flows = readFlows();
    const httpIn = flows.find(n =>
        n.type === 'http in' && n.url === '/api/valve/:deveui/cancel'
    );
    if (!httpIn) throw new Error('Missing HTTP IN node for /api/valve/:deveui/cancel');
    const fn = flows.find(n =>
        n.type === 'function' && n.name === 'Cancel STREGA Actuation'
    );
    if (!fn) throw new Error('Missing function node "Cancel STREGA Actuation"');
    assertAsyncOsiDb(fn);
    assertNodeLib(fn, 'crypto', 'crypto');
    assertNodeLib(fn, 'chirpstack', 'osi-chirpstack-helper');
    for (const required of ['verifyBearer', 'user_id', 'Valve is claimed by another user']) {
        if (!fn.func.includes(required)) {
            throw new Error(`Cancel function must perform authenticated ownership checks (${required})`);
        }
    }
    if (!fn.func.includes('flushDeviceQueue(deveui)')) {
        throw new Error('Cancel function must flush the ChirpStack device queue');
    }
    if (!fn.func.includes("'CANCELLED'") && !fn.func.includes('"CANCELLED"')) {
        throw new Error('Cancel function must set reconciliation_state = CANCELLED');
    }
    if (!fn.func.includes('cancel_reason')) {
        throw new Error('Cancel function must record cancel_reason');
    }
    if (!fn.func.includes('return msg')) {
        throw new Error('Cancel errors must route to the HTTP response output');
    }
    if (fn.func.includes("action: 'CLOSE'") || fn.func.includes('return [closeMsg, responseMsg]')) {
        throw new Error('Cancel success must not emit a CLOSE command');
    }
    console.log('  ok Explicit cancel path flushes queue without a CLOSE downlink');
}

function assertQueueFlushUsesGrpc() {
    const helper = fs.readFileSync(CHIRPSTACK_HELPER, 'utf8');
    for (const required of [
        'new devicePb.FlushDeviceQueueRequest()',
        "grpcInvoke(this.deviceClient, 'flushQueue'",
        "method: 'DeviceService.FlushQueue'",
    ]) {
        if (!helper.includes(required)) {
            throw new Error(`ChirpStack helper must flush the queue through DeviceService.FlushQueue (${required})`);
        }
    }
    for (const forbidden of [
        '`/api/devices/${encodeURIComponent(normalizedDevEui)}/queue`',
        "requestJson('DELETE'",
        'ChirpStack queue flush failed with HTTP',
    ]) {
        if (helper.includes(forbidden)) {
            throw new Error(`ChirpStack helper must not use REST for queue flush (${forbidden})`);
        }
    }
    console.log('  ok ChirpStack queue flush uses DeviceService.FlushQueue gRPC');
}

function assertFrontendValveControls() {
    const stregaCard = fs.readFileSync(STREGA_CARD, 'utf8');
    const cancelButton = fs.readFileSync(VALVE_CANCEL_BUTTON, 'utf8');
    const farmingTypes = fs.readFileSync(FARMING_TYPES, 'utf8');
    if (!farmingTypes.includes("'OPEN_FOR_DURATION'")) {
        throw new Error('ValveActionRequest must allow OPEN_FOR_DURATION');
    }
    for (const required of ['Number.isInteger(durationMinutes)', 'durationMinutes < 1', 'durationMinutes > 255', "action: 'OPEN_FOR_DURATION'"]) {
        if (!stregaCard.includes(required)) {
            throw new Error(`StregaValveCard must validate and send timed open controls (${required})`);
        }
    }
    if (stregaCard.includes("action === 'OPEN' ? 'OPEN_FOR_DURATION' : 'CLOSE'")) {
        throw new Error('StregaValveCard must not send CLOSE from the main valve controls');
    }
    if (!stregaCard.includes('hasActiveValveActuation(device)')) {
        throw new Error('StregaValveCard must gate cancel rendering on an active VAE row');
    }
    for (const required of ['onUpdate?.()', 'onError?.(message)', 'catch (err: any)']) {
        if (!cancelButton.includes(required)) {
            throw new Error(`ValveCancelButton must report cancel success/failure (${required})`);
        }
    }
    if (!cancelButton.includes('cancelQueuedOpen')) {
        throw new Error('ValveCancelButton must label the action as cancelling a queued open');
    }
    console.log('  ok frontend valve controls are duration-bound and report cancel results');
}

function main() {
    checkSchema();
    assertIndefiniteOpenRejection();
    assertValveRestRejectsIndefiniteOpen();
    assertRouteHandlesSafeValveCommands();
    assertWriteExpectation();
    assertReconciliationMonitor();
    assertCancelPath();
    assertQueueFlushUsesGrpc();
    assertFrontendValveControls();
    console.log('verify-command-safety: OK');
}

try { main(); } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
