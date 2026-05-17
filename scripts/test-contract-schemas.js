#!/usr/bin/env node
// Validates contract schema correctness for known edge cases.
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.resolve(__dirname, '../docs/contracts/sync-schema');

function loadSchema(name) {
    return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

let ok = true;

// L5: events.schema.json sync_version minimum must be 0
const eventsSchema = loadSchema('events.schema.json');
const svMin = eventsSchema.properties && eventsSchema.properties.sync_version && eventsSchema.properties.sync_version.minimum;
if (svMin !== 0) {
    console.error(`FAIL L5: events.schema.json sync_version minimum is ${svMin}, expected 0`);
    ok = false;
} else {
    console.log('OK  L5: sync_version minimum is 0');
}

// M7: commands.schema.json SET_STREGA_TIMED_ACTION must not require duration_seconds
const cmdSchema = loadSchema('commands.schema.json');
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
const expectedTriggerMetrics = ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'DENDRO'];
if (triggerMetrics.join(',') !== expectedTriggerMetrics.join(',')) {
    console.error(`FAIL schema: trigger_metric enum is ${triggerMetrics.join(',')}, expected ${expectedTriggerMetrics.join(',')}`);
    ok = false;
} else {
    console.log('OK  schema: trigger_metric enum matches edge schedule validation');
}

if (!ok) process.exit(1);
console.log('PASS: contract schema checks pass');
