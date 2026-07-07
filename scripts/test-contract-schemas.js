#!/usr/bin/env node
// Validates contract schema correctness for known edge cases.
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.resolve(__dirname, '../docs/contracts/sync-schema');

function loadSchema(name) {
    return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

let ok = true;

// L5: events.schema.json syncVersion minimum must be 0
const eventsSchema = loadSchema('events.schema.json');
const svMin = eventsSchema.properties && eventsSchema.properties.syncVersion && eventsSchema.properties.syncVersion.minimum;
if (svMin !== 0) {
    console.error(`FAIL L5: events.schema.json syncVersion minimum is ${svMin}, expected 0`);
    ok = false;
} else {
    console.log('OK  L5: syncVersion minimum is 0');
}

const eventPayload = eventsSchema.properties && eventsSchema.properties.payload;
const eventPayloadContractVersion = eventPayload && eventPayload.properties && eventPayload.properties.contract_version;
if (!eventPayload || !Array.isArray(eventPayload.required) || !eventPayload.required.includes('contract_version')) {
    console.error('FAIL schema: event payload does not require contract_version');
    ok = false;
} else if (!eventPayloadContractVersion || eventPayloadContractVersion.type !== 'integer' || eventPayloadContractVersion.const !== 1) {
    console.error('FAIL schema: event payload contract_version is not integer const 1');
    ok = false;
} else {
    console.log('OK  schema: event payload requires contract_version const 1');
}

const sampleEvent = {
    eventUuid: 'event-fixture-1',
    aggregateType: 'DEVICE_DATA',
    aggregateKey: 'device-fixture-1',
    op: 'DEVICE_DATA_APPENDED',
    syncVersion: 1,
    occurredAt: '2026-07-05T00:00:00.000Z',
    payload: {
        contract_version: 1,
        device_eui: 'DEVICE_FIXTURE_1'
    }
};
const eventRequired = eventsSchema.required || [];
const eventProps = eventsSchema.properties || {};
const sampleMissing = eventRequired.filter((property) => !(property in sampleEvent));
const sampleExtras = Object.keys(sampleEvent).filter((property) => !eventProps[property]);
if (sampleMissing.length || (eventsSchema.additionalProperties === false && sampleExtras.length)) {
    console.error(`FAIL schema: real V2 event sample does not match required envelope; missing=${sampleMissing.join(',') || '(none)'} extra=${sampleExtras.join(',') || '(none)'}`);
    ok = false;
} else if (!eventsSchema.properties.op.enum.includes(sampleEvent.op)) {
    console.error(`FAIL schema: real V2 event sample op ${sampleEvent.op} is not in event op enum`);
    ok = false;
} else if (sampleEvent.payload.contract_version !== eventPayloadContractVersion.const) {
    console.error('FAIL schema: real V2 event sample payload contract_version does not match schema const');
    ok = false;
} else {
    console.log('OK  schema: real V2 event sample matches event envelope');
}

const sampleWorkRequestEvent = {
    eventUuid: 'req-0016C001F11715E2-20260708T120000Z',
    aggregateType: 'WORK_REQUEST',
    aggregateKey: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
    op: 'WORK_REQUEST_SUBMITTED',
    syncVersion: 1,
    occurredAt: '2026-07-08T12:00:00.000Z',
    payload: {
        contract_version: 1,
        schema_version: 1,
        request_id: '019ff001-1111-7222-8333-aaaaaaaaaaaa',
        type: 'bug',
        title: 'Pump status is confusing',
        description: 'The dashboard says the pump is open after I closed it.',
        area: 'dashboard',
        severity: 'annoying',
        consent_public: true,
        consent_diagnostics: true,
        gateway_device_eui: '0016C001F11715E2',
        diagnostics: { sync: { pending_outbox_count: 0 } },
        gui_user: { local_user_id: 7, username: 'field-user' }
    }
};
const workRequestSampleMissing = eventRequired.filter((property) => !(property in sampleWorkRequestEvent));
const workRequestSampleExtras = Object.keys(sampleWorkRequestEvent).filter((property) => !eventProps[property]);
if (workRequestSampleMissing.length || (eventsSchema.additionalProperties === false && workRequestSampleExtras.length)) {
    console.error(`FAIL schema: WORK_REQUEST_SUBMITTED sample does not match required envelope; missing=${workRequestSampleMissing.join(',') || '(none)'} extra=${workRequestSampleExtras.join(',') || '(none)'}`);
    ok = false;
} else if (!eventsSchema.properties.op.enum.includes(sampleWorkRequestEvent.op)) {
    console.error(`FAIL schema: WORK_REQUEST_SUBMITTED sample op ${sampleWorkRequestEvent.op} is not in event op enum`);
    ok = false;
} else if (sampleWorkRequestEvent.payload.contract_version !== eventPayloadContractVersion.const) {
    console.error('FAIL schema: WORK_REQUEST_SUBMITTED sample payload contract_version does not match schema const');
    ok = false;
} else {
    console.log('OK  schema: WORK_REQUEST_SUBMITTED sample matches event envelope');
}

// M7: commands.schema.json SET_STREGA_TIMED_ACTION must not require duration_seconds
const cmdSchema = loadSchema('commands.schema.json');
const commandIdPattern = new RegExp(cmdSchema.properties.command_id.pattern);
for (const commandId of [
    'a1234567-b89c-4def-9012-abcdefabcdef',
    'A1234567-B89C-4DEF-9012-ABCDEFABCDEF'
]) {
    if (!commandIdPattern.test(commandId)) {
        console.error(`FAIL schema: command_id pattern rejects valid UUID casing ${commandId}`);
        ok = false;
    } else {
        console.log(`OK  schema: command_id accepts UUID casing ${commandId}`);
    }
}

const allOf = cmdSchema.allOf || [];
const stregaTimedRequiresDurationSeconds = allOf.some(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'SET_STREGA_TIMED_ACTION' &&
    rule.then && rule.then.required && rule.then.required.includes('duration_seconds')
);
if (stregaTimedRequiresDurationSeconds) {
    console.error('FAIL M7: commands.schema.json SET_STREGA_TIMED_ACTION still requires duration_seconds');
    ok = false;
} else {
    console.log('OK  M7: SET_STREGA_TIMED_ACTION does not require duration_seconds');
}

// M7: commands.schema.json must have 'amount' property
const hasAmount = cmdSchema.properties && cmdSchema.properties.amount;
if (!hasAmount) {
    console.error('FAIL M7: commands.schema.json missing amount property');
    ok = false;
} else {
    console.log('OK  M7: amount property present in commands.schema.json');
}

if (!cmdSchema.properties.command_type.enum.includes('WORK_REQUEST_STATUS')) {
    console.error('FAIL schema: commands.schema.json missing WORK_REQUEST_STATUS command_type');
    ok = false;
} else {
    console.log('OK  schema: WORK_REQUEST_STATUS command_type present');
}

const openForDurationRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'OPEN_FOR_DURATION'
);
const openDurationType = openForDurationRule &&
    openForDurationRule.then &&
    openForDurationRule.then.properties &&
    openForDurationRule.then.properties.duration_seconds &&
    openForDurationRule.then.properties.duration_seconds.type;
if (openDurationType !== 'integer') {
    console.error('FAIL schema: OPEN_FOR_DURATION duration_seconds can still be null');
    ok = false;
} else {
    console.log('OK  schema: OPEN_FOR_DURATION duration_seconds is non-null integer');
}

const stregaTimedRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'SET_STREGA_TIMED_ACTION'
);
const timedAmountType = stregaTimedRule &&
    stregaTimedRule.then &&
    stregaTimedRule.then.properties &&
    stregaTimedRule.then.properties.amount &&
    stregaTimedRule.then.properties.amount.type;
if (timedAmountType !== 'integer') {
    console.error('FAIL schema: SET_STREGA_TIMED_ACTION amount can still be null');
    ok = false;
} else {
    console.log('OK  schema: SET_STREGA_TIMED_ACTION amount is non-null integer');
}

// Contract resources must match edge runtime device and schedule enums.
const resourcesSchema = loadSchema('resources.schema.json');
const deviceTypes = resourcesSchema.definitions.Device.properties.type_id.enum || [];
for (const type of ['TEKTELIC_CLOVER', 'SENSECAP_S2120']) {
    if (!deviceTypes.includes(type)) {
        console.error(`FAIL schema: resources.schema.json missing device type ${type}`);
        ok = false;
    } else {
        console.log(`OK  schema: device type ${type} present`);
    }
}
for (const type of ['S2120_WEATHER', 'GATEWAY']) {
    if (deviceTypes.includes(type)) {
        console.error(`FAIL schema: resources.schema.json contains non-edge device type ${type}`);
        ok = false;
    } else {
        console.log(`OK  schema: non-edge device type ${type} absent`);
    }
}

const triggerMetrics = resourcesSchema.definitions.Schedule.properties.trigger_metric.enum || [];
const expectedTriggerMetrics = ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'SWT_1', 'SWT_2', 'SWT_3', 'DENDRO'];
if (triggerMetrics.join(',') !== expectedTriggerMetrics.join(',')) {
    console.error(`FAIL schema: trigger_metric enum is ${triggerMetrics.join(',')}, expected ${expectedTriggerMetrics.join(',')}`);
    ok = false;
} else {
    console.log('OK  schema: trigger_metric enum matches edge schedule validation');
}

if (!ok) process.exit(1);
console.log('PASS: contract schema checks pass');
