#!/usr/bin/env node
// verify-sync-contract.js — validates flows.json command types and JSON Schemas
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'docs/contracts/sync-schema');
const FLOWS = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

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

function main() {
    // 1. Verify command types in registry match the schema
    const schema = loadSchema('commands.schema.json');
    const schemaTypes = schema.properties.command_type.enum;
    const registryTypes = extractRegistryCommandTypes();

    for (const rt of registryTypes) {
        if (!schemaTypes.includes(rt)) {
            throw new Error(`Registry type "${rt}" not in commands.schema.json enum`);
        }
    }
    console.log(`  ok registry command types match schema (${registryTypes.length} types)`);

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
