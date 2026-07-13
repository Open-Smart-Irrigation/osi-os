#!/usr/bin/env node
// Validates contract schema correctness for known edge cases.
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.resolve(__dirname, '../docs/contracts/sync-schema');
const STAGING_MANIFEST = path.resolve(__dirname, 'fixtures/sync-contract-staging.json');
const JOURNAL_AGGREGATE = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/aggregate');
const UUID = '12345678-1234-4234-8234-123456789abc';
const COMPACT_UUID = '12345678123442348234123456789abc';
const JOURNAL_COMMANDS = [
    'UPSERT_JOURNAL_ENTRY',
    'VOID_JOURNAL_ENTRY',
    'UPSERT_JOURNAL_CUSTOM_VOCAB',
    'UPSERT_JOURNAL_PLOT',
    'UPSERT_JOURNAL_PLOT_GROUP',
];
const JOURNAL_EVENT_BINDINGS = {
    JOURNAL_ENTRY_UPSERTED: ['JOURNAL_ENTRY', 'JournalEntry', 'entry_uuid'],
    JOURNAL_ENTRY_VOIDED: ['JOURNAL_ENTRY', 'JournalEntry', 'entry_uuid'],
    JOURNAL_VOCAB_UPSERTED: ['JOURNAL_VOCAB', 'JournalVocab', 'custom_field_uuid'],
    JOURNAL_PLOT_UPSERTED: ['JOURNAL_PLOT', 'JournalPlot', 'plot_uuid'],
    JOURNAL_PLOT_GROUP_UPSERTED: ['JOURNAL_PLOT_GROUP', 'JournalPlotGroup', 'group_uuid'],
};

function loadSchema(name) {
    return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

function valueHasType(value, type) {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

function resolveRef(ref, rootSchema) {
    const parts = ref.split('#');
    const external = parts[0];
    const targetRoot = external ? loadSchema(external) : rootSchema;
    const pointer = parts[1] || '';
    const target = pointer.split('/').filter(Boolean).reduce((value, rawPart) => {
        const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
        return value && value[part];
    }, targetRoot);
    if (!target) throw new Error(`Unresolved schema reference ${ref}`);
    return { schema: target, rootSchema: targetRoot };
}

function validationErrors(schema, value, rootSchema, location) {
    const errors = [];
    const root = rootSchema || schema;
    const at = location || '$';
    if (!schema || typeof schema !== 'object') return [`${at}: schema is missing`];
    if (schema.$ref) {
        const resolved = resolveRef(schema.$ref, root);
        return validationErrors(resolved.schema, value, resolved.rootSchema, at);
    }
    if (Array.isArray(schema.allOf)) {
        for (const part of schema.allOf) errors.push(...validationErrors(part, value, root, at));
    }
    if (schema.if) {
        const conditionMatches = validationErrors(schema.if, value, root, at).length === 0;
        const branch = conditionMatches ? schema.then : schema.else;
        if (branch) errors.push(...validationErrors(branch, value, root, at));
    }
    if (schema.not && validationErrors(schema.not, value, root, at).length === 0) {
        errors.push(`${at}: matches forbidden schema`);
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
        errors.push(`${at}: expected constant ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) {
        errors.push(`${at}: value is not in enum`);
    }
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((type) => valueHasType(value, type))) {
            errors.push(`${at}: expected type ${types.join('|')}`);
            return errors;
        }
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push(`${at}: string is shorter than ${schema.minLength}`);
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            errors.push(`${at}: string is longer than ${schema.maxLength}`);
        }
        if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) {
            errors.push(`${at}: string does not match ${schema.pattern}`);
        }
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
        if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
            errors.push(`${at}: duplicate items`);
        }
        if (schema.items) {
            value.forEach((item, index) => errors.push(...validationErrors(schema.items, item, root, `${at}[${index}]`)));
        }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties = schema.properties || {};
        for (const required of schema.required || []) {
            if (!Object.prototype.hasOwnProperty.call(value, required)) errors.push(`${at}.${required}: is required`);
        }
        for (const [key, propertyValue] of Object.entries(value)) {
            if (properties[key]) {
                errors.push(...validationErrors(properties[key], propertyValue, root, `${at}.${key}`));
            } else if (schema.additionalProperties === false) {
                errors.push(`${at}.${key}: additional property is forbidden`);
            }
            if (schema.propertyNames) {
                errors.push(...validationErrors(schema.propertyNames, key, root, `${at}{${key}}`));
            }
        }
    }
    return errors;
}

function reportCheck(condition, success, failure) {
    if (condition) {
        console.log(`OK  ${success}`);
    } else {
        console.error(`FAIL ${failure}`);
        ok = false;
    }
}

function expectValid(label, schema, value) {
    const errors = validationErrors(schema, value);
    reportCheck(errors.length === 0, `${label} validates`, `${label} rejected: ${errors.join('; ')}`);
}

function expectInvalid(label, schema, value, expectedError) {
    const errors = validationErrors(schema, value);
    const matches = errors.length > 0 && (!expectedError || errors.some((error) => expectedError.test(error)));
    reportCheck(matches, `${label} is rejected`, `${label} unexpectedly validated or missed ${expectedError}: ${errors.join('; ')}`);
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
        contact_email: 'farmer@example.com',
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

const workRequestStatusRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'WORK_REQUEST_STATUS'
);
const workRequestStatusRequired = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.required || [];
const workRequestStatusRequestIdType = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.properties &&
    workRequestStatusRule.then.properties.request_id &&
    workRequestStatusRule.then.properties.request_id.type;
const workRequestStatusStatusType = workRequestStatusRule &&
    workRequestStatusRule.then &&
    workRequestStatusRule.then.properties &&
    workRequestStatusRule.then.properties.status &&
    workRequestStatusRule.then.properties.status.type;
if (!workRequestStatusRequired.includes('request_id') || !workRequestStatusRequired.includes('status')) {
    console.error('FAIL schema: WORK_REQUEST_STATUS does not require request_id and status');
    ok = false;
} else if (workRequestStatusRequestIdType !== 'string' || workRequestStatusStatusType !== 'string') {
    console.error('FAIL schema: WORK_REQUEST_STATUS request_id/status can still be null');
    ok = false;
} else {
    console.log('OK  schema: WORK_REQUEST_STATUS requires non-null request_id and status');
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

const uc512DurationRule = allOf.find(rule =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    rule.if.properties.command_type.const === 'UC512_OPEN_FOR_DURATION'
);
const uc512DurationRequired = uc512DurationRule && uc512DurationRule.then &&
    Array.isArray(uc512DurationRule.then.required) &&
    uc512DurationRule.then.required.includes('duration_seconds');
const uc512DurationType = uc512DurationRule && uc512DurationRule.then &&
    uc512DurationRule.then.properties && uc512DurationRule.then.properties.duration_seconds &&
    uc512DurationRule.then.properties.duration_seconds.type;
reportCheck(
    uc512DurationRequired && uc512DurationType === 'integer',
    'schema: UC512_OPEN_FOR_DURATION requires non-null duration_seconds',
    'schema: UC512_OPEN_FOR_DURATION lacks its runtime duration requirement'
);

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

for (const type of ['AQUASCOPE_LORAIN', 'MILESIGHT_UC512']) {
    reportCheck(
        deviceTypes.includes(type),
        `schema: device type ${type} present`,
        `schema: resources.schema.json missing device type ${type}`
    );
}

let staging;
if (!fs.existsSync(STAGING_MANIFEST)) {
    console.error(`FAIL staging manifest missing at ${STAGING_MANIFEST}`);
    ok = false;
} else {
    staging = JSON.parse(fs.readFileSync(STAGING_MANIFEST, 'utf8'));
    const exactStaging = staging && staging.version === 1 &&
        JSON.stringify(staging.commands && staging.commands.edgeDeferred) === JSON.stringify(JOURNAL_COMMANDS) &&
        JSON.stringify(staging.commands && staging.commands.cloudDeferred) === JSON.stringify(JOURNAL_COMMANDS) &&
        JSON.stringify(staging.eventOps && staging.eventOps.edgeModuleOwned) === JSON.stringify([
            'JOURNAL_ENTRY_UPSERTED',
            'JOURNAL_ENTRY_VOIDED',
        ]) &&
        JSON.stringify(staging.eventOps && staging.eventOps.edgeDeferred) === JSON.stringify([
            'JOURNAL_VOCAB_UPSERTED',
            'JOURNAL_PLOT_UPSERTED',
            'JOURNAL_PLOT_GROUP_UPSERTED',
        ]) &&
        JSON.stringify(staging.eventOps && staging.eventOps.cloudDeferred) === JSON.stringify(Object.keys(JOURNAL_EVENT_BINDINGS));
    reportCheck(exactStaging, 'staging manifest pins the exact journal sets', 'staging manifest drifted from the exact journal sets');
}

const journalEntry = {
    contract_version: 1,
    entry_uuid: UUID,
    base_sync_version: 0,
    owner_user_uuid: COMPACT_UUID,
    author_principal_uuid: COMPACT_UUID,
    author_label: 'Field operator',
    plot_uuid: UUID,
    zone_uuid: UUID,
    device_eui: null,
    season_uuid: null,
    season_crop: null,
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    pass_uuid: null,
    batch_uuid: null,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: '2026-07-13T08:00:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    recorded_at: '2026-07-13T08:01:00.000Z',
    origin: 'cloud-ui',
    status: 'final',
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: 'Irrigation round',
    context_json: null,
    sync_version: 1,
    gateway_device_eui: '0016C001F11715E2',
    created_at: '2026-07-13T08:01:00.000Z',
    updated_at: '2026-07-13T08:01:00.000Z',
    deleted_at: null,
    values: [{
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value_status: 'observed',
        value_num: 12,
        value_text: null,
        unit_code: 'unit.mm_water',
        entered_value_num: 12,
        entered_unit_code: 'unit.mm_water',
    }],
};
const customVocab = {
    contract_version: 1,
    base_sync_version: 0,
    code: `custom.${UUID}`,
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    labels_json: '{"en":"Operator note"}',
    icon_key: null,
    constraints_json: null,
    agrovoc_uri: null,
    icasa_code: null,
    adapt_code: null,
    scope: 'custom',
    owner_user_uuid: COMPACT_UUID,
    gateway_device_eui: '0016C001F11715E2',
    custom_field_uuid: UUID,
    active: 1,
    sort_order: 0,
    sync_version: 1,
    created_at: '2026-07-13T08:00:00.000Z',
    deleted_at: null,
    mappings: [],
};
const plot = {
    contract_version: 1,
    base_sync_version: 0,
    plot_uuid: UUID,
    plot_code: 'LYS-02',
    name: 'Lysimeter 2',
    zone_uuid: null,
    station_code: 'RECKENHOLZ',
    crop_hint: 'barley',
    area_m2: 4,
    active: 1,
    sync_version: 1,
    gateway_device_eui: '0016C001F11715E2',
    created_at: '2026-07-13T08:00:00.000Z',
    updated_at: '2026-07-13T08:00:00.000Z',
    deleted_at: null,
    settings: {
        layout_code: 'open_field',
        updated_at: '2026-07-13T08:00:00.000Z',
        updated_by_principal_uuid: COMPACT_UUID,
        sync_version: 1,
    },
};
const plotGroup = {
    contract_version: 1,
    base_sync_version: 0,
    group_uuid: UUID,
    label: 'Barley 2026',
    gateway_device_eui: '0016C001F11715E2',
    created_by_principal_uuid: UUID,
    created_at: '2026-07-13T08:00:00.000Z',
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 1,
    deleted_at: null,
    members: [UUID],
};

const resourceSamples = {
    JournalEntry: journalEntry,
    JournalVocab: customVocab,
    JournalPlot: plot,
    JournalPlotGroup: plotGroup,
};
const eventResourceSamples = Object.assign({}, resourceSamples, {
    JournalEntry: Object.assign({}, journalEntry),
    JournalVocab: Object.assign({}, customVocab),
    JournalPlot: Object.assign({}, plot),
    JournalPlotGroup: Object.assign({}, plotGroup),
});
for (const sample of Object.values(eventResourceSamples)) delete sample.base_sync_version;

const storedEntryRow = Object.assign({ id: 7, user_id: 3, zone_id: 2 }, eventResourceSamples.JournalEntry);
delete storedEntryRow.values;
const storedValueRows = journalEntry.values.map((value, index) =>
    Object.assign({ id: index + 1, entry_uuid: UUID }, value)
);
const builtEntryAggregate = JOURNAL_AGGREGATE.buildAggregate(storedEntryRow, storedValueRows);
const builtAggregateErrors = validationErrors(
    resourcesSchema.definitions.JournalEntry,
    builtEntryAggregate,
    resourcesSchema
);
reportCheck(
    builtAggregateErrors.length === 0 && !Object.prototype.hasOwnProperty.call(builtEntryAggregate, 'base_sync_version'),
    'actual JournalEntry aggregate builder output validates without base_sync_version',
    `actual JournalEntry aggregate builder output rejected: ${builtAggregateErrors.join('; ')}`
);

const lifecycleSource = fs.readFileSync(
    path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js'),
    'utf8'
);
const entryColumnsMatch = /const ENTRY_COLUMNS = \[([\s\S]*?)\];/.exec(lifecycleSource);
const storedEntryColumns = entryColumnsMatch
    ? [...entryColumnsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    : [];
const aggregateEntryColumns = storedEntryColumns.filter((column) => !['id', 'user_id', 'zone_id'].includes(column));
const journalEntryProperties = Object.keys(resourcesSchema.definitions.JournalEntry.properties);
const missingAggregateFields = aggregateEntryColumns.filter((column) => !journalEntryProperties.includes(column));
const unknownResourceFields = journalEntryProperties.filter((column) =>
    !aggregateEntryColumns.includes(column) && !['contract_version', 'base_sync_version', 'values'].includes(column)
);
reportCheck(
    Boolean(entryColumnsMatch) && missingAggregateFields.length === 0 && unknownResourceFields.length === 0,
    'JournalEntry resource fields match the lifecycle aggregate projection',
    `JournalEntry field drift: missing=${missingAggregateFields.join(',') || '(none)'} unknown=${unknownResourceFields.join(',') || '(none)'}`
);

for (const [op, binding] of Object.entries(JOURNAL_EVENT_BINDINGS)) {
    const [aggregateType, definitionName, watermarkKey] = binding;
    const definition = resourcesSchema.definitions[definitionName];
    reportCheck(
        definition && definition.additionalProperties === false &&
            definition['x-aggregate-type'] === aggregateType &&
            definition['x-watermark-key'] === watermarkKey &&
            Array.isArray(definition.required) && definition.required.includes(watermarkKey),
        `resource ${definitionName} is strict and pins ${aggregateType}/${watermarkKey}`,
        `resource ${definitionName} is not strict or lacks aggregate/watermark metadata`
    );
    const rule = (eventsSchema.allOf || []).find((candidate) =>
        candidate.if && candidate.if.properties && candidate.if.properties.op &&
        candidate.if.properties.op.const === op
    );
    const ruleAggregate = rule && rule.then && rule.then.properties && rule.then.properties.aggregateType;
    const rulePayload = rule && rule.then && rule.then.properties && rule.then.properties.payload;
    const rulePayloadRef = rulePayload && (rulePayload.$ref ||
        (Array.isArray(rulePayload.allOf) && rulePayload.allOf[0] && rulePayload.allOf[0].$ref));
    reportCheck(
        ruleAggregate && ruleAggregate.const === aggregateType &&
            rulePayloadRef === `resources.schema.json#/definitions/${definitionName}`,
        `event ${op} binds ${aggregateType} to ${definitionName}`,
        `event ${op} lacks the exact aggregate/resource binding`
    );
}

for (const definitionName of ['JournalEntry', 'JournalVocab', 'JournalPlot', 'JournalPlotGroup']) {
    const withoutGateway = Object.assign({}, eventResourceSamples[definitionName]);
    delete withoutGateway.gateway_device_eui;
    const errors = validationErrors(resourcesSchema.definitions[definitionName], withoutGateway, resourcesSchema);
    reportCheck(
        errors.some((error) => /gateway_device_eui.*required/.test(error)),
        `${definitionName} requires its gateway tenant key`,
        `${definitionName} accepts a missing gateway_device_eui: ${errors.join('; ')}`
    );
}
const plotWithoutSettings = Object.assign({}, eventResourceSamples.JournalPlot);
delete plotWithoutSettings.settings;
const plotSettingsErrors = validationErrors(resourcesSchema.definitions.JournalPlot, plotWithoutSettings, resourcesSchema);
reportCheck(
    plotSettingsErrors.some((error) => /settings.*required/.test(error)),
    'JournalPlot requires its layout settings aggregate',
    `JournalPlot accepts missing layout settings: ${plotSettingsErrors.join('; ')}`
);

const journalScopeRule = allOf.find((rule) =>
    rule.if && rule.if.properties && rule.if.properties.command_type &&
    Array.isArray(rule.if.properties.command_type.enum) &&
    rule.else && Array.isArray(rule.else.required) && rule.else.required.includes('device_eui')
);
reportCheck(
    journalScopeRule && JSON.stringify(journalScopeRule.if.properties.command_type.enum) === JSON.stringify(JOURNAL_COMMANDS),
    'journal commands are the exact device_eui exemptions',
    'device_eui exemption is missing or is not limited to the exact five journal commands'
);

const commandFixtures = [
    {
        command_type: 'UPSERT_JOURNAL_ENTRY',
        command_id: UUID,
        effect_key: `journal_entry:${UUID}:0`,
        entry: journalEntry,
    },
    {
        command_type: 'VOID_JOURNAL_ENTRY',
        command_id: UUID,
        effect_key: `journal_entry:${UUID}:1`,
        entry_uuid: UUID,
        base_sync_version: 1,
        reason: 'Entered against the wrong plot',
    },
    {
        command_type: 'UPSERT_JOURNAL_CUSTOM_VOCAB',
        command_id: UUID,
        effect_key: `journal_vocab:${UUID}:0`,
        custom_vocab: customVocab,
    },
    {
        command_type: 'UPSERT_JOURNAL_PLOT',
        command_id: UUID,
        effect_key: `journal_plot:${UUID}:0`,
        plot,
    },
    {
        command_type: 'UPSERT_JOURNAL_PLOT_GROUP',
        command_id: UUID,
        effect_key: `journal_plot_group:${UUID}:0`,
        plot_group: plotGroup,
    },
];
for (const fixture of commandFixtures) {
    expectValid(`${fixture.command_type} without device_eui`, cmdSchema, fixture);
    const missingEffect = Object.assign({}, fixture);
    delete missingEffect.effect_key;
    expectInvalid(`${fixture.command_type} without effect_key`, cmdSchema, missingEffect, /effect_key.*required/);
    expectInvalid(
        `${fixture.command_type} with malformed effect_key`,
        cmdSchema,
        Object.assign({}, fixture, { effect_key: 'journal:malformed' }),
        /effect_key.*match/
    );
    expectInvalid(
        `${fixture.command_type} with non-canonical UUID in effect_key`,
        cmdSchema,
        Object.assign({}, fixture, { effect_key: fixture.effect_key.replace(UUID, UUID.toUpperCase()) }),
        /effect_key.*match/
    );
}

for (const [commandType, payloadKey] of [
    ['UPSERT_JOURNAL_ENTRY', 'entry'],
    ['UPSERT_JOURNAL_CUSTOM_VOCAB', 'custom_vocab'],
    ['UPSERT_JOURNAL_PLOT', 'plot'],
    ['UPSERT_JOURNAL_PLOT_GROUP', 'plot_group'],
]) {
    const fixture = commandFixtures.find((candidate) => candidate.command_type === commandType);
    const payloadWithoutBase = Object.assign({}, fixture[payloadKey]);
    delete payloadWithoutBase.base_sync_version;
    expectInvalid(
        `${commandType} without embedded base_sync_version`,
        cmdSchema,
        Object.assign({}, fixture, { [payloadKey]: payloadWithoutBase }),
        /base_sync_version.*required/
    );
}

const invalidCustomCode = Object.assign({}, customVocab, { code: 'custom.operator_note' });
expectInvalid(
    'custom vocabulary without custom.<UUID> code',
    cmdSchema,
    Object.assign({}, commandFixtures[2], { custom_vocab: invalidCustomCode }),
    /code.*match/
);

const wrongJournalPayload = Object.assign({}, commandFixtures[0], { plot });
delete wrongJournalPayload.entry;
expectInvalid('UPSERT_JOURNAL_ENTRY with plot payload', cmdSchema, wrongJournalPayload, /entry.*required|plot.*forbidden|plot.*enum/);
expectInvalid(
    'UPSERT_JOURNAL_ENTRY with null effect_key',
    cmdSchema,
    Object.assign({}, commandFixtures[0], { effect_key: null }),
    /effect_key.*string/
);
expectInvalid(
    'VOID_JOURNAL_ENTRY with oversized reason',
    cmdSchema,
    Object.assign({}, commandFixtures[1], { reason: 'x'.repeat(4001) }),
    /reason.*longer/
);
expectInvalid(
    'unknown journal-like command',
    cmdSchema,
    { command_type: 'UPSERT_JOURNAL_UNKNOWN', command_id: UUID, effect_key: 'journal:unknown' },
    /command_type.*enum/
);

const existingCommandEnvelope = {
    command_id: UUID,
    duration_seconds: 1,
    amount: 1,
    request_id: 'request-1',
    status: 'APPLIED',
};
for (const commandType of cmdSchema.properties.command_type.enum.filter((type) => !JOURNAL_COMMANDS.includes(type))) {
    expectInvalid(
        `${commandType} without device_eui`,
        cmdSchema,
        Object.assign({ command_type: commandType }, existingCommandEnvelope),
        /device_eui.*required/
    );
}
expectValid(
    'existing REBOOT command with device_eui',
    cmdSchema,
    { command_type: 'REBOOT', command_id: UUID, device_eui: '0016C001F11715E2' }
);

for (const [op, binding] of Object.entries(JOURNAL_EVENT_BINDINGS)) {
    const [aggregateType, definitionName, watermarkKey] = binding;
    const payload = op === 'JOURNAL_ENTRY_VOIDED'
        ? Object.assign({}, eventResourceSamples[definitionName], {
            status: 'voided',
            voided_at: '2026-07-13T08:02:00.000Z',
            voided_by_principal_uuid: COMPACT_UUID,
            void_reason: 'Entered against the wrong plot',
        })
        : eventResourceSamples[definitionName];
    const event = {
        eventUuid: UUID,
        aggregateType,
        aggregateKey: payload[watermarkKey],
        op,
        syncVersion: payload.sync_version,
        occurredAt: '2026-07-13T08:01:00.000Z',
        payload,
    };
    expectValid(`${op} flat payload`, eventsSchema, event);
    expectInvalid(
        `${op} wrong aggregateType`,
        eventsSchema,
        Object.assign({}, event, { aggregateType: 'JOURNAL_WRONG' }),
        /aggregateType.*constant/
    );
    const missingWatermark = Object.assign({}, payload);
    delete missingWatermark[watermarkKey];
    expectInvalid(
        `${op} payload without ${watermarkKey}`,
        eventsSchema,
        Object.assign({}, event, { payload: missingWatermark }),
        new RegExp(`${watermarkKey}.*required`)
    );
    if (op === 'JOURNAL_ENTRY_UPSERTED' || op === 'JOURNAL_ENTRY_VOIDED') {
        const wrongStatus = op === 'JOURNAL_ENTRY_UPSERTED' ? 'voided' : 'final';
        expectInvalid(
            `${op} payload with ${wrongStatus} status`,
            eventsSchema,
            Object.assign({}, event, { payload: Object.assign({}, payload, { status: wrongStatus }) }),
            /status.*constant/
        );
    }
}
expectInvalid(
    'JOURNAL_ENTRY_UPSERTED double-nested payload',
    eventsSchema,
    {
        eventUuid: UUID,
        aggregateType: 'JOURNAL_ENTRY',
        aggregateKey: UUID,
        op: 'JOURNAL_ENTRY_UPSERTED',
        syncVersion: 1,
        payload: { contract_version: 1, entry: journalEntry },
    },
    /entry_uuid.*required|entry.*forbidden/
);
expectInvalid(
    'unknown journal-like event op',
    eventsSchema,
    {
        eventUuid: UUID,
        aggregateType: 'JOURNAL_ENTRY',
        aggregateKey: UUID,
        op: 'JOURNAL_ENTRY_UNKNOWN',
        syncVersion: 1,
        payload: journalEntry,
    },
    /op.*enum/
);

const effectKeyDoc = fs.readFileSync(path.join(SCHEMA_DIR, 'effect-keys.md'), 'utf8');
for (const format of [
    'journal_entry:{entry_uuid}:{base_sync_version}',
    'journal_vocab:{custom_field_uuid}:{base_sync_version}',
    'journal_plot:{plot_uuid}:{base_sync_version}',
    'journal_plot_group:{group_uuid}:{base_sync_version}',
]) {
    reportCheck(
        effectKeyDoc.includes(format),
        `effect-key contract pins ${format}`,
        `effect-key contract missing ${format}`
    );
}

if (!ok) process.exit(1);
console.log('PASS: contract schema checks pass');
