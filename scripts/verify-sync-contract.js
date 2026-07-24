#!/usr/bin/env node
// verify-sync-contract.js — validates flows.json command types and JSON Schemas
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'docs/contracts/sync-schema');
const FLOWS = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const STAGING_MANIFEST = path.join(ROOT, 'scripts/fixtures/sync-contract-staging.json');
const GOLDEN_FIXTURE = path.join(SCHEMA_DIR, 'sync-contract-golden.json');
const SEPARATELY_ROUTED_COMMANDS = ['WORK_REQUEST_STATUS'];
const SEPARATE_ROUTE_SPECS = [
    {
        commandType: 'WORK_REQUEST_STATUS',
        splitterId: 'sync-pending-split',
        splitterName: 'Replay Pending Commands',
        outputIndex: 1,
        applierId: 'work-request-status-apply',
        applierName: 'Apply Work Request Status',
    },
];
const EXACT_STAGED_COMMANDS = [];
const EXACT_EDGE_DEFERRED_COMMANDS = [...EXACT_STAGED_COMMANDS];
const EXACT_COMMAND_SEMANTIC_BINDINGS = {
    UPSERT_JOURNAL_ENTRY: {
        effect_key: { prefix: 'journal_entry', uuid_path: 'entry.entry_uuid', version_path: 'entry.base_sync_version' },
    },
    VOID_JOURNAL_ENTRY: {
        effect_key: { prefix: 'journal_entry', uuid_path: 'entry_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_JOURNAL_CUSTOM_VOCAB: {
        effect_key: { prefix: 'journal_vocab', uuid_path: 'custom_vocab.custom_field_uuid', version_path: 'custom_vocab.base_sync_version' },
    },
    UPSERT_JOURNAL_PLOT: {
        effect_key: { prefix: 'journal_plot', uuid_path: 'plot.plot_uuid', version_path: 'plot.base_sync_version' },
    },
    UPSERT_JOURNAL_PLOT_GROUP: {
        effect_key: { prefix: 'journal_plot_group', uuid_path: 'plot_group.group_uuid', version_path: 'plot_group.base_sync_version' },
    },
    UPSERT_SCOPED_USER: {
        effect_key: { prefix: 'scoped_user', uuid_path: 'user.user_uuid', version_path: 'user.base_sync_version' },
    },
    RESET_SCOPED_USER_PASSWORD: {
        effect_key: { prefix: 'scoped_user_password', uuid_path: 'user_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_USER_ZONE_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_zone_assignment', uuid_path: 'zone_assignment.assignment_uuid', version_path: 'zone_assignment.base_sync_version' },
    },
    DELETE_USER_ZONE_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_zone_assignment', uuid_path: 'assignment_uuid', version_path: 'base_sync_version' },
    },
    UPSERT_USER_PLOT_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_plot_assignment', uuid_path: 'plot_assignment.assignment_uuid', version_path: 'plot_assignment.base_sync_version' },
    },
    DELETE_USER_PLOT_ASSIGNMENT: {
        effect_key: { prefix: 'scoped_plot_assignment', uuid_path: 'assignment_uuid', version_path: 'base_sync_version' },
    },
};
const EXACT_EVENT_SEMANTIC_BINDINGS = {
    JOURNAL_ENTRY_UPSERTED: { aggregate_key_path: 'payload.entry_uuid', sync_version_path: 'payload.sync_version' },
    JOURNAL_ENTRY_VOIDED: { aggregate_key_path: 'payload.entry_uuid', sync_version_path: 'payload.sync_version' },
    JOURNAL_VOCAB_UPSERTED: { aggregate_key_path: 'payload.custom_field_uuid', sync_version_path: 'payload.sync_version' },
    JOURNAL_PLOT_UPSERTED: { aggregate_key_path: 'payload.plot_uuid', sync_version_path: 'payload.sync_version' },
    JOURNAL_PLOT_GROUP_UPSERTED: { aggregate_key_path: 'payload.group_uuid', sync_version_path: 'payload.sync_version' },
    USER_UPSERTED: { aggregate_key_path: 'payload.user_uuid', sync_version_path: 'payload.sync_version' },
    USER_ZONE_ASSIGNMENT_UPSERTED: { aggregate_key_path: 'payload.assignment_uuid', sync_version_path: 'payload.sync_version' },
    USER_ZONE_ASSIGNMENT_DELETED: { aggregate_key_path: 'payload.assignment_uuid', sync_version_path: 'payload.sync_version' },
    USER_PLOT_ASSIGNMENT_UPSERTED: { aggregate_key_path: 'payload.assignment_uuid', sync_version_path: 'payload.sync_version' },
    USER_PLOT_ASSIGNMENT_DELETED: { aggregate_key_path: 'payload.assignment_uuid', sync_version_path: 'payload.sync_version' },
};

function loadSchema(name) {
    return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

function extractRegistryCommandTypes() {
    const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
    const registry = flows.find(n => n.type === 'function' && n.name === 'Command Type Registry');
    if (!registry) throw new Error('Command Type Registry node not found in flows.json');
    const source = `${registry.initialize || ''}\n${registry.func || ''}`;
    const types = [];
    const re = /(\b[A-Z][A-Z0-9_]+)\s*:\s*\{/g;
    let m;
    while ((m = re.exec(source)) !== null) types.push(m[1]);
    return types.filter(t => t === t.toUpperCase());
}

function functionNodeSource(node) {
    return `${node.initialize || ''}\n${node.func || ''}\n${node.finalize || ''}`;
}

function extractSeparatelyRoutedCommandTypes() {
    const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
    const routed = [];
    for (const spec of SEPARATE_ROUTE_SPECS) {
        const splitter = flows.find((node) => node.id === spec.splitterId && node.name === spec.splitterName);
        const applier = flows.find((node) => node.id === spec.applierId && node.name === spec.applierName);
        if (!splitter) throw new Error(`separate command splitter missing: ${spec.splitterName} (${spec.splitterId})`);
        if (!applier) throw new Error(`separate command applier missing: ${spec.applierName} (${spec.applierId})`);
        const targetWires = Array.isArray(splitter.wires) && Array.isArray(splitter.wires[spec.outputIndex])
            ? splitter.wires[spec.outputIndex]
            : [];
        if (!targetWires.includes(spec.applierId)) {
            throw new Error(`${spec.commandType} splitter output ${spec.outputIndex} is not wired to ${spec.applierId}`);
        }
        const splitterSource = functionNodeSource(splitter);
        const applierSource = functionNodeSource(applier);
        const quotedType = spec.commandType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!(new RegExp(`commandType\\s*===\\s*['"]${quotedType}['"]`)).test(splitterSource)) {
            throw new Error(`${spec.splitterName} does not dispatch ${spec.commandType}`);
        }
        if (!(new RegExp(`commandType\\s*:\\s*['"]${quotedType}['"]`)).test(applierSource)) {
            throw new Error(`${spec.applierName} does not ACK ${spec.commandType}`);
        }
        routed.push(spec.commandType);
    }
    return routed;
}

function sortedUnique(values) {
    return [...new Set(values)].sort();
}

function assertExactList(name, actual, expected) {
    if (!Array.isArray(actual)) throw new Error(`${name} must be an array`);
    const duplicates = actual.filter((value, index) => actual.indexOf(value) !== index);
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((value) => !actualSet.has(value));
    const extra = actual.filter((value) => !expectedSet.has(value));
    if (missing.length || extra.length || duplicates.length) {
        throw new Error(`${name} drift: missing=${missing.join(',') || '(none)'} extra=${extra.join(',') || '(none)'} duplicates=${sortedUnique(duplicates).join(',') || '(none)'}`);
    }
}

function assertPartition(name, accepted, enabled, staged) {
    assertExactList(`${name}.accepted`, accepted, sortedUnique(enabled.concat(staged)));
    const overlap = enabled.filter((value) => staged.includes(value));
    if (overlap.length) {
        throw new Error(`${name} enablement overlaps staged values: ${sortedUnique(overlap).join(',')}`);
    }
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function assertExactMetadata(name, actual, expected) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`${name} must match the reviewed executable semantic bindings`);
    }
}

function loadStagedCommands() {
    const staging = JSON.parse(fs.readFileSync(STAGING_MANIFEST, 'utf8'));
    if (staging.version !== 1 || !staging.commands || typeof staging.commands !== 'object') {
        throw new Error('sync-contract staging manifest has invalid command metadata');
    }
    const commandKeys = Object.keys(staging.commands).sort();
    if (commandKeys.join(',') !== 'cloudDeferred,edgeDeferred') {
        throw new Error(`sync-contract staging command axes must be cloudDeferred,edgeDeferred; got ${commandKeys.join(',') || '(none)'}`);
    }
    assertExactList('staging commands.edgeDeferred', staging.commands.edgeDeferred, EXACT_EDGE_DEFERRED_COMMANDS);
    assertExactList('staging commands.cloudDeferred', staging.commands.cloudDeferred, EXACT_STAGED_COMMANDS);
    return staging.commands.edgeDeferred;
}

function verifyGoldenFixture(commandSchema, eventsSchema) {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FIXTURE, 'utf8'));
    const rootKeys = Object.keys(golden).sort();
    assertExactList(
        'sync-contract-golden root keys',
        rootKeys,
        ['capabilities', 'commandAckResults', 'commandTypes', 'eventOperations', 'format']
    );
    if (golden.format !== 1) throw new Error(`sync-contract-golden format must be 1; got ${golden.format}`);

    const eventOperations = golden.eventOperations || {};
    assertExactList(
        'golden accepted event operations',
        eventOperations.accepted,
        eventsSchema.properties.op.enum
    );
    assertPartition(
        'golden event operations',
        eventOperations.accepted,
        eventOperations.edgeProducerEnabled,
        eventOperations.staged
    );
    assertExactList(
        'golden server event handlers',
        eventOperations.serverHandlerEnabled,
        eventOperations.edgeProducerEnabled
    );

    const commandTypes = golden.commandTypes || {};
    assertExactList(
        'golden accepted command types',
        commandTypes.accepted,
        commandSchema.properties.command_type.enum
    );
    assertPartition(
        'golden command types',
        commandTypes.accepted,
        commandTypes.cloudIssuerEnabled,
        commandTypes.staged
    );

    const staging = JSON.parse(fs.readFileSync(STAGING_MANIFEST, 'utf8'));
    assertExactList('golden staged events', eventOperations.staged, staging.eventOps.cloudDeferred);
    assertExactList('golden staged commands', commandTypes.staged, staging.commands.cloudDeferred);

    const expectedCapabilities = [
        'command_ack_results_v1',
        'desired_state_conflicts_v1',
        'journal_sync_v1',
        'scoped_access_commands_v1',
        'scoped_access_sync_v1',
    ];
    const capabilities = golden.capabilities || [];
    assertExactList(
        'golden capability names',
        capabilities.map((entry) => entry && entry.name),
        expectedCapabilities
    );
    for (const capability of capabilities) {
        const keys = Object.keys(capability || {}).sort();
        assertExactList(
            `capability ${capability && capability.name} keys`,
            keys,
            ['cloudIssuerEnabled', 'edgeProducerEnabled', 'name', 'schemaAccepted']
        );
        for (const field of ['schemaAccepted', 'edgeProducerEnabled', 'cloudIssuerEnabled']) {
            if (typeof capability[field] !== 'boolean') {
                throw new Error(`capability ${capability.name}.${field} must be boolean`);
            }
        }
        if ((capability.edgeProducerEnabled || capability.cloudIssuerEnabled) && !capability.schemaAccepted) {
            throw new Error(`capability ${capability.name} cannot be enabled before schema acceptance`);
        }
    }

    const ackResults = golden.commandAckResults || [];
    assertExactList(
        'golden command ACK results',
        ackResults.map((entry) => entry && entry.result),
        ['APPLIED', 'CONFLICT', 'EXPIRED', 'FAILED_RETRYABLE', 'REJECTED_PERMANENT']
    );
    const commandIds = ackResults.map((entry) => entry.commandId);
    if (new Set(commandIds).size !== commandIds.length ||
        commandIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error('golden command ACK commandId values must be unique positive safe integers');
    }
    for (const result of ackResults) {
        for (const field of ['requestStatus', 'responseStatus', 'desiredStateStatus']) {
            if (typeof result[field] !== 'string' || !result[field]) {
                throw new Error(`golden command ACK ${result.result}.${field} must be nonempty`);
            }
        }
        for (const field of ['terminal', 'leasedAgain', 'serverHandlerEnabled']) {
            if (typeof result[field] !== 'boolean') {
                throw new Error(`golden command ACK ${result.result}.${field} must be boolean`);
            }
        }
    }
    const conflict = ackResults.find((entry) => entry.result === 'CONFLICT');
    if (!conflict || !conflict.serverHandlerEnabled || conflict.desiredStateStatus !== 'conflicted') {
        throw new Error('golden CONFLICT result must be handled as recoverable desired-state conflict');
    }
    console.log('  ok golden operations, ACK results, and capability rollout metadata');
}

function main() {
    // 1. Verify the schema is exactly deployed registry + routed + staged.
    const schema = loadSchema('commands.schema.json');
    const schemaTypes = schema.properties.command_type.enum;
    const registryTypes = extractRegistryCommandTypes();
    const separatelyRoutedCommands = extractSeparatelyRoutedCommandTypes();
    assertExactList('separately routed commands', separatelyRoutedCommands, SEPARATELY_ROUTED_COMMANDS);
    const stagedCommands = loadStagedCommands();
    const stagedInRegistry = stagedCommands.filter((type) => registryTypes.includes(type));
    if (stagedInRegistry.length) {
        throw new Error(`edge-deferred commands already present in Command Type Registry: ${stagedInRegistry.join(', ')}`);
    }
    const routedInRegistry = separatelyRoutedCommands.filter((type) => registryTypes.includes(type));
    if (routedInRegistry.length) {
        throw new Error(`separately routed commands unexpectedly present in Command Type Registry: ${routedInRegistry.join(', ')}`);
    }
    const expectedTypes = sortedUnique(registryTypes.concat(separatelyRoutedCommands, stagedCommands));
    const schemaUnique = sortedUnique(schemaTypes);
    const missing = expectedTypes.filter((type) => !schemaUnique.includes(type));
    const extra = schemaUnique.filter((type) => !expectedTypes.includes(type));
    const schemaDuplicates = schemaTypes.filter((type, index) => schemaTypes.indexOf(type) !== index);
    if (missing.length || extra.length || schemaDuplicates.length) {
        throw new Error(`commands.schema.json enum drift: missing=${missing.join(',') || '(none)'} extra=${extra.join(',') || '(none)'} duplicates=${sortedUnique(schemaDuplicates).join(',') || '(none)'}`);
    }
    console.log(`  ok command enum = registry ${registryTypes.length} + routed ${separatelyRoutedCommands.length} + staged ${stagedCommands.length}`);

    const eventsSchema = loadSchema('events.schema.json');
    assertExactMetadata(
        'commands.schema.json x-semantic-bindings',
        schema['x-semantic-bindings'],
        EXACT_COMMAND_SEMANTIC_BINDINGS
    );
    assertExactMetadata(
        'events.schema.json x-semantic-bindings',
        eventsSchema['x-semantic-bindings'],
        EXACT_EVENT_SEMANTIC_BINDINGS
    );
    console.log('  ok journal and scoped-access semantic bindings are exact and machine-readable');
    verifyGoldenFixture(schema, eventsSchema);

    // 2. Verify schema files exist
    for (const name of ['commands.schema.json', 'events.schema.json', 'resources.schema.json', 'sync-contract-golden.json']) {
        const f = path.join(SCHEMA_DIR, name);
        if (!fs.existsSync(f)) throw new Error(`Missing schema: ${name}`);
        JSON.parse(fs.readFileSync(f, 'utf8')); // validate parseable
        console.log(`  ok ${name} is valid JSON`);
    }

    console.log('verify-sync-contract: OK');
}

try { main(); } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
