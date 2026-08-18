#!/usr/bin/node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const libraryPath = fs.existsSync(path.join(__dirname, 'lib/factory-database-seed.js'))
  ? path.join(__dirname, 'lib/factory-database-seed.js') : path.join(__dirname, 'osi-factory-database-seed.js');
const seed = require(libraryPath);

const SPEC = { realize: ['factory-seed', 'expected-seed-sha256', 'database', 'operation-id', 'receipt-out', 'database-lineage-out'] };
function parse(argv) { const verb = argv[0]; const required = SPEC[verb]; if (!required) throw new Error('unknown verb'); const values = {}; for (let i = 1; i < argv.length; i += 2) { const token = argv[i]; const value = argv[i + 1]; if (!token || !token.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('invalid argv'); const key = token.slice(2); if (!required.includes(key)) throw new Error(`unknown flag ${token}`); if (Object.hasOwn(values, key)) throw new Error(`duplicate flag ${token}`); values[key] = value; } for (const key of required) if (!values[key]) throw new Error(`missing --${key}`); for (const key of required.filter((item) => item !== 'operation-id' && item !== 'expected-seed-sha256')) if (!path.isAbsolute(values[key])) throw new Error(`--${key} must be absolute`); return { verb, values }; }
function dispatch(argv) { const parsed = parse(argv); return seed.realize({ factorySeed: parsed.values['factory-seed'], expectedSeedSha256: parsed.values['expected-seed-sha256'], database: parsed.values.database, operationId: parsed.values['operation-id'], receiptOut: parsed.values['receipt-out'], databaseLineageOut: parsed.values['database-lineage-out'] }); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(dispatch(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`[factory-database-seed] ${error.message}\n`); process.exitCode = 1; } }
module.exports = { parse, dispatch };
