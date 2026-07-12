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

function requireFuncIncludes(node, needle, label) {
    if (!node || typeof node.func !== 'string' || !node.func.includes(needle)) {
        failures.push(label);
        return false;
    }
    return true;
}

function requireFuncMatches(node, rx, label) {
    if (!node || typeof node.func !== 'string' || !rx.test(node.func)) {
        failures.push(label);
        return false;
    }
    return true;
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

function makeSupportHttpClient(responseBody, capturedRequests) {
    return {
        request(options, callback) {
            let errorHandler = null;
            const request = {
                on(event, handler) {
                    if (event === 'error') errorHandler = handler;
                    return request;
                },
                write(body) {
                    capturedRequests.push({ options, body });
                },
                end() {
                    process.nextTick(() => {
                        try {
                            const responseHandlers = {};
                            const response = {
                                statusCode: 202,
                                setEncoding() {},
                                on(event, handler) {
                                    responseHandlers[event] = handler;
                                    return response;
                                },
                            };
                            callback(response);
                            process.nextTick(() => {
                                if (responseHandlers.data) responseHandlers.data(JSON.stringify(responseBody));
                                if (responseHandlers.end) responseHandlers.end();
                            });
                        } catch (error) {
                            if (errorHandler) errorHandler(error);
                        }
                    });
                },
                destroy(error) {
                    if (errorHandler) errorHandler(error);
                },
            };
            return request;
        },
    };
}

function makeSupportCloudHttp(responseBody, capturedRequests, statusCode) {
    return {
        async requestJsonIpv4(options) {
            capturedRequests.push({
                options,
                payload: options && Object.prototype.hasOwnProperty.call(options, 'payload') ? options.payload : undefined,
            });
            return {
                statusCode: statusCode === undefined ? 202 : statusCode,
                payload: responseBody,
            };
        },
    };
}

async function runSupportDeliveryWorkerCase(label, responseBody, expectation) {
    if (!supportDeliveryWorker || typeof supportDeliveryWorker.func !== 'string') {
        failures.push(`${label}: support-delivery-worker not available for behavior test`);
        return;
    }
    const options = typeof expectation === 'string'
        ? { expectedLocalStatus: expectation }
        : expectation || {};
    const requestId = 'req-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const expectedRequestCount = options.expectedRequestCount === undefined ? 1 : options.expectedRequestCount;
    const updates = [];
    const capturedRequests = [];
    let closed = false;
    class FakeDatabase {
        all(sql, params, callback) {
            callback(null, (options.rows || [{
                request_uuid: requestId,
                gateway_device_eui: '0011223344556677',
                status_secret_hash: 'hash-' + requestId,
                contact_email: 'field@example.test',
            }]));
        }
        get(sql, params, callback) {
            if (sql.includes('FROM users') && sql.includes('server_url')) {
                callback(null, { server_url: 'https://linked-support.example.test/' });
                return;
            }
            if (options.missingOutbox) {
                callback(null, null);
                return;
            }
            callback(null, {
                payload_json: JSON.stringify({
                    request_id: params && params[0] ? params[0] : requestId,
                    gateway_device_eui: '0011223344556677',
                    status_secret_hash: 'hash-' + (params && params[0] ? params[0] : requestId),
                    contact_email: 'field@example.test',
                }),
            });
        }
        run(sql, params, callback) {
            updates.push({ sql, params });
            callback.call({ changes: 1 }, null);
        }
        close(callback) {
            closed = true;
            callback();
        }
    }
    const flowStore = {
        sync_state: {},
        support_delivery_retries: options.initialRetry ? { [requestId]: options.initialRetry } : {},
    };
    const flow = {
        get(key) { return flowStore[key]; },
        set(key, value) { flowStore[key] = value; },
    };
    const env = {
        get(key) {
            if (key === 'OSI_CLOUD_REST_TIMEOUT_MS') return '1000';
            return '';
        },
    };
    const node = { warn(message) { failures.push(`${label}: unexpected warning ${message}`); } };
    const osiDb = { Database: FakeDatabase };
    const https = makeSupportHttpClient(responseBody, capturedRequests);
    const http = makeSupportHttpClient(responseBody, capturedRequests);
    const osiCloudHttp = makeSupportCloudHttp(responseBody, capturedRequests, options.statusCode);
    const runner = new Function('msg', 'node', 'flow', 'env', 'osiDb', 'https', 'http', 'osiCloudHttp', supportDeliveryWorker.func);
    await runner({}, node, flow, env, osiDb, https, http, osiCloudHttp);

    if (!closed) {
        failures.push(`${label}: support-delivery-worker did not close the DB`);
    }
    if (capturedRequests.length !== expectedRequestCount) {
        failures.push(`${label}: expected ${expectedRequestCount} fake HTTP request(s), got ${capturedRequests.length}`);
    } else if (capturedRequests[0] && capturedRequests[0].options.headers && Object.prototype.hasOwnProperty.call(capturedRequests[0].options.headers, 'Authorization')) {
        failures.push(`${label}: support-delivery-worker sent an Authorization header`);
    } else if (capturedRequests[0] && capturedRequests[0].options.url && capturedRequests[0].options.url !== 'https://linked-support.example.test/api/v1/support/edge/work-requests') {
        failures.push(`${label}: support-delivery-worker did not use linked users.server_url, got ${capturedRequests[0].options.url}`);
    } else if (capturedRequests[0] && !capturedRequests[0].options.url && capturedRequests[0].options.hostname !== 'linked-support.example.test') {
        failures.push(`${label}: support-delivery-worker did not use linked users.server_url, got ${capturedRequests[0].options.hostname}`);
    }
    if (options.expectedLocalStatus) {
        const expectedSqlFragment = `local_status = '${options.expectedLocalStatus}'`;
        const matched = updates.some((update) => update.sql.includes(expectedSqlFragment));
        if (!matched) {
            failures.push(`${label}: expected update containing ${expectedSqlFragment}, got ${updates.map((update) => update.sql).join(' | ')}`);
        }
        const wrongStatus = options.expectedLocalStatus === 'SUBMITTED' ? 'REJECTED' : 'SUBMITTED';
        if (updates.some((update) => update.sql.includes(`local_status = '${wrongStatus}'`))) {
            failures.push(`${label}: unexpectedly updated local_status = '${wrongStatus}'`);
        }
    }
    if (options.expectNoTerminalUpdate && updates.some((update) => /local_status = '(SUBMITTED|REJECTED)'/.test(update.sql))) {
        failures.push(`${label}: unexpectedly wrote a terminal local_status update`);
    }
    if (options.expectedCloudStatus !== undefined) {
        const terminalUpdate = updates.find((update) => update.sql.includes("local_status = 'SUBMITTED'"));
        if (!terminalUpdate || terminalUpdate.params[0] !== options.expectedCloudStatus) {
            failures.push(`${label}: expected cloud_status param ${options.expectedCloudStatus}, got ${terminalUpdate ? JSON.stringify(terminalUpdate.params) : 'no SUBMITTED update'}`);
        }
    }
    if (options.expectedCloudReason !== undefined) {
        const rejectedUpdate = updates.find((update) => update.sql.includes("local_status = 'REJECTED'"));
        if (!rejectedUpdate || rejectedUpdate.params[0] !== options.expectedCloudReason) {
            failures.push(`${label}: expected cloud_reason param ${options.expectedCloudReason}, got ${rejectedUpdate ? JSON.stringify(rejectedUpdate.params) : 'no REJECTED update'}`);
        }
    }
    if (options.expectedRetryCount !== undefined) {
        const retry = (flowStore.support_delivery_retries || {})[requestId] || null;
        if (!retry || retry.count !== options.expectedRetryCount || !retry.lastAttempt) {
            failures.push(`${label}: expected retry count ${options.expectedRetryCount} with lastAttempt, got ${JSON.stringify(retry)}`);
        }
    }
    if (options.expectedRetryCleared && Object.prototype.hasOwnProperty.call(flowStore.support_delivery_retries || {}, requestId)) {
        failures.push(`${label}: expected retry state to be cleared, got ${JSON.stringify(flowStore.support_delivery_retries[requestId])}`);
    }
}

async function runSupportDeliveryBehaviorMatrix() {
    const failureCountBefore = failures.length;
    const acceptedCases = [
        ['result-only accepted', { result: 'accepted' }, 'SUBMITTED'],
        ['status-only accepted', { status: 'accepted' }, 'SUBMITTED'],
        ['result-only duplicate', { result: 'duplicate' }, 'DUPLICATE'],
        ['status-only duplicate', { status: 'duplicate' }, 'DUPLICATE'],
    ];
    const rejectedStates = ['quarantined', 'invalid'];
    for (const [label, responseBody, cloudStatus] of acceptedCases) {
        await runSupportDeliveryWorkerCase(`Field requests: ${label}`, responseBody, {
            expectedLocalStatus: 'SUBMITTED',
            expectedCloudStatus: cloudStatus,
        });
    }
    await runSupportDeliveryWorkerCase('Field requests: result-only rate_limited', { result: 'rate_limited' }, {
        expectNoTerminalUpdate: true,
        expectedRetryCount: 1,
    });
    await runSupportDeliveryWorkerCase('Field requests: status-only rate_limited', { status: 'rate_limited' }, {
        expectNoTerminalUpdate: true,
        expectedRetryCount: 1,
    });
    await runSupportDeliveryWorkerCase('Field requests: HTTP 429 rate limited', { error: 'too_many_requests' }, {
        statusCode: 429,
        expectNoTerminalUpdate: true,
        expectedRetryCount: 1,
    });
    await runSupportDeliveryWorkerCase('Field requests: missing outbox below cap', {}, {
        missingOutbox: true,
        expectedRequestCount: 0,
        expectedRetryCount: 1,
    });
    await runSupportDeliveryWorkerCase('Field requests: missing outbox at cap', {}, {
        missingOutbox: true,
        expectedRequestCount: 0,
        expectedLocalStatus: 'REJECTED',
        expectedCloudReason: 'missing_outbox_payload',
        expectedRetryCleared: true,
        initialRetry: { count: 5, lastAttempt: 1 },
    });
    for (const state of rejectedStates) {
        await runSupportDeliveryWorkerCase(`Field requests: result-only ${state}`, { result: state }, { expectedLocalStatus: 'REJECTED' });
        await runSupportDeliveryWorkerCase(`Field requests: status-only ${state}`, { status: state }, { expectedLocalStatus: 'REJECTED' });
    }
    if (failures.length === failureCountBefore) {
        console.log('OK  Field requests: support-delivery-worker accepts result/status terminal response matrix');
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
    let intakeChecks = true;
    if (!hasLib(intakeRouter, 'osiDb', 'osi-db-helper')) {
        failures.push('Field requests: improvement-requests-api-router missing osiDb lib binding');
        intakeChecks = false;
    }
    if (!/\.close\s*\(/.test(intakeRouter.func || '')) {
        failures.push('Field requests: improvement-requests-api-router opens DB without .close(');
        intakeChecks = false;
    }
    intakeChecks = requireFuncIncludes(intakeRouter, 'Invalid contact_email', 'Field requests: improvement-requests-api-router must reject invalid contact_email') && intakeChecks;
    intakeChecks = requireFuncMatches(intakeRouter, /httpError\(400,\s*'Invalid contact_email'\)/, 'Field requests: improvement-requests-api-router validates contact_email before insert') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'body.consent_public !== true', 'Field requests: intake router does not require consent_public') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'rawTitle.length < 3 || rawTitle.length > 80', 'Field requests: intake router does not enforce title length 3-80') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'rawDescription.length < 10 || rawDescription.length > 4000', 'Field requests: intake router does not enforce description length 10-4000') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'bodySize >= 65536', 'Field requests: intake router does not enforce total payload size < 65536 bytes') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "crypto.randomBytes(32).toString('hex')", 'Field requests: intake router does not generate a 32-byte status secret') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'status_secret_hash', 'Field requests: intake router does not store status_secret_hash') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'status_secret: statusSecret', 'Field requests: intake router does not return status_secret') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'contact_email', 'Field requests: intake router does not store optional contact_email') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, 'MAX_DIAGNOSTICS_JSON_BYTES = 32768', 'Field requests: intake router does not cap diagnostics JSON at 32768 bytes') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "flow.get('gateway_health')", 'Field requests: intake router does not prefer flow gateway_health') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "global.get('edge_health')", 'Field requests: intake router does not retain edge_health fallback') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "/[Bb]earer\\s+[A-Za-z0-9._~+/=-]{20,}/g", 'Field requests: redaction does not strip bearer tokens with fixed pattern') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "/eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/g", 'Field requests: redaction does not strip JWT-like strings') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "/\\b[0-9A-Fa-f]{32}\\b/g", 'Field requests: redaction does not strip AppKey-like 32-hex strings') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g", 'Field requests: redaction does not strip email patterns') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "/\\b[0-9A-Fa-f]{16}\\b/g", 'Field requests: redaction does not strip 16-hex EUI patterns') && intakeChecks;
    intakeChecks = requireFuncIncludes(intakeRouter, "replace(pattern, '[REDACTED]')", 'Field requests: redaction does not use fixed [REDACTED] replacement') && intakeChecks;
    if (intakeChecks) {
        console.log('OK  Field requests: intake router declares osiDb and closes DB');
        console.log('OK  Field requests: intake router validates revised public request contract');
    }
}

const supportDeliveryTick = flows.find((node) =>
    node.type === 'inject'
    && /support-delivery/i.test(String(node.id || '') + ' ' + String(node.name || ''))
);
if (!supportDeliveryTick) {
    failures.push('Field requests: support-delivery inject node not found');
} else {
    if (String(supportDeliveryTick.repeat) !== '300') {
        failures.push(`Field requests: support-delivery inject repeat expected 300 seconds, got ${supportDeliveryTick.repeat}`);
    }
    if (JSON.stringify(supportDeliveryTick.wires || []) !== JSON.stringify([['support-delivery-worker']])) {
        failures.push('Field requests: support-delivery inject does not wire to support-delivery-worker');
    }
    if (String(supportDeliveryTick.repeat) === '300'
        && JSON.stringify(supportDeliveryTick.wires || []) === JSON.stringify([['support-delivery-worker']])) {
        console.log('OK  Field requests: support-delivery 5 minute tick present');
    }
}

const supportDeliveryWorker = byId['support-delivery-worker'];
if (!supportDeliveryWorker) {
    failures.push('Field requests: support-delivery-worker not found');
} else {
    let deliveryChecks = true;
    if (!hasLib(supportDeliveryWorker, 'osiDb', 'osi-db-helper')) {
        failures.push('Field requests: support-delivery-worker missing osiDb lib binding');
        deliveryChecks = false;
    }
    if (!hasLib(supportDeliveryWorker, 'osiCloudHttp', 'osi-cloud-http')) {
        failures.push('Field requests: support-delivery-worker missing osiCloudHttp lib binding');
        deliveryChecks = false;
    }
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, '/api/v1/support/edge/work-requests', 'Field requests: support-delivery-worker does not post to support endpoint') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "flow.get('sync_state')", 'Field requests: support-delivery-worker does not resolve server URL from flow sync_state') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'SELECT server_url FROM users', 'Field requests: support-delivery-worker does not resolve linked users.server_url') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "env.get('OSI_CLOUD_SERVER_URL')", 'Field requests: support-delivery-worker does not resolve server URL from OSI_CLOUD_SERVER_URL') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'https://server.opensmartirrigation.org', 'Field requests: support-delivery-worker missing default support server URL') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "flow.get('support_delivery_retries') || {}", 'Field requests: support-delivery-worker does not read retry state') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "flow.set('support_delivery_retries', retries)", 'Field requests: support-delivery-worker does not persist retry state') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'Math.min(300000 * Math.pow(2, retry.count), 3600000)', 'Field requests: support-delivery-worker does not implement exponential backoff') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'MAX_MISSING_OUTBOX_RETRIES', 'Field requests: support-delivery-worker does not cap missing-outbox retries') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'missing_outbox_payload', 'Field requests: support-delivery-worker does not terminally mark stale missing outbox rows') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'let attempted = 0', 'Field requests: support-delivery-worker does not track attempted rows separately from backoff skips') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'attempted >= MAX_DELIVERIES_PER_TICK', 'Field requests: support-delivery-worker still allows backed-off rows to consume the whole tick') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "local_status = 'QUEUED'", 'Field requests: support-delivery-worker does not read queued requests') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'ORDER BY created_at ASC LIMIT 20', 'Field requests: support-delivery-worker does not scan past backed-off queued rows') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "event_uuid = 'work-request-' || ?", 'Field requests: support-delivery-worker does not read matching outbox payload') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'osiCloudHttp.requestJsonIpv4', 'Field requests: support-delivery-worker does not use shared IPv4 HTTP helper') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, 'body.result || body.status', 'Field requests: support-delivery-worker does not accept status-only terminal responses') && deliveryChecks;
    deliveryChecks = requireFuncIncludes(supportDeliveryWorker, "headers: { 'Content-Type': 'application/json' }", 'Field requests: support-delivery-worker must send no Authorization header') && deliveryChecks;
    deliveryChecks = requireFuncMatches(supportDeliveryWorker, /\.close\s*\(/, 'Field requests: support-delivery-worker opens DB without .close(') && deliveryChecks;
    if (deliveryChecks) {
        console.log('OK  Field requests: support-delivery-worker declares osiDb, posts unauthenticated support payloads, and retries with backoff');
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

runSupportDeliveryBehaviorMatrix()
    .then(() => {
        if (failures.length > 0) {
            console.error('FAIL: ' + failures.length + ' flow wiring regression(s):');
            failures.forEach((l) => console.error('  - ' + l));
            process.exit(1);
        }
        console.log('PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed');
    })
    .catch((error) => {
        console.error('FAIL: support-delivery behavior matrix threw: ' + String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
