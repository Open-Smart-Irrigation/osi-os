#!/usr/bin/env node
// verify-sync-contract.js — validates flows.json command types and JSON Schemas
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'docs/contracts/sync-schema');
const FLOWS = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const STAGING_MANIFEST = path.join(ROOT, 'scripts/fixtures/sync-contract-staging.json');
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
const EXACT_STAGED_JOURNAL_COMMANDS = [
    'UPSERT_JOURNAL_ENTRY',
    'VOID_JOURNAL_ENTRY',
    'UPSERT_JOURNAL_CUSTOM_VOCAB',
    'UPSERT_JOURNAL_PLOT',
    'UPSERT_JOURNAL_PLOT_GROUP',
];

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

function loadStagedCommands() {
    const staging = JSON.parse(fs.readFileSync(STAGING_MANIFEST, 'utf8'));
    if (staging.version !== 1 || !staging.commands || typeof staging.commands !== 'object') {
        throw new Error('sync-contract staging manifest has invalid command metadata');
    }
    const commandKeys = Object.keys(staging.commands).sort();
    if (commandKeys.join(',') !== 'cloudDeferred,edgeDeferred') {
        throw new Error(`sync-contract staging command axes must be cloudDeferred,edgeDeferred; got ${commandKeys.join(',') || '(none)'}`);
    }
    assertExactList('staging commands.edgeDeferred', staging.commands.edgeDeferred, EXACT_STAGED_JOURNAL_COMMANDS);
    assertExactList('staging commands.cloudDeferred', staging.commands.cloudDeferred, EXACT_STAGED_JOURNAL_COMMANDS);
    return staging.commands.edgeDeferred;
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

    // 2. Verify schema files exist
    for (const name of ['commands.schema.json', 'events.schema.json', 'resources.schema.json']) {
        const f = path.join(SCHEMA_DIR, name);
        if (!fs.existsSync(f)) throw new Error(`Missing schema: ${name}`);
        JSON.parse(fs.readFileSync(f, 'utf8')); // validate parseable
        console.log(`  ok ${name} is valid JSON`);
    }

    console.log('verify-sync-contract: OK');
}

try { main(); } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
