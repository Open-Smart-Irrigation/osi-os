#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protocolCli = require('./sync-protocol-capability-cli');

const LIVE_DATABASE = '/data/db/farming.db';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function prepare(request, expectations) {
  requireObject(request, 'request');
  requireObject(expectations, 'expectations');
  if (request.format !== 1) throw new Error('unsupported recovery adapter format');
  if (!['restore', 'rollback'].includes(request.mode)) {
    throw new Error('recovery adapter mode must be restore or rollback');
  }
  requireUuid(request.operationUuid, 'operation UUID');
  requireUuid(request.bundleUuid, 'bundle UUID');
  requireUuid(request.installationUuid, 'installation UUID');
  const expectedInstallation = normalizeUuid(
    expectations.expectedInstallationUuid,
    'expected installation UUID',
  );
  if (request.installationUuid !== expectedInstallation) {
    throw new Error('recovery installation does not match local identity');
  }
  const targetEui = normalizeEui(request.targetGatewayDeviceEui);
  if (targetEui !== normalizeEui(expectations.expectedGatewayEui)) {
    throw new Error('recovery target gateway does not match local identity');
  }

  const databasePath = validateDownloadedDatabase(request.databasePath);
  const bytes = fs.readFileSync(databasePath);
  if (bytes.length !== request.databaseByteLength) {
    throw new Error('recovery database byte length does not match');
  }
  if (bytes.length < SQLITE_HEADER.length
      || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new Error('recovery database has no SQLite header');
  }
  const databaseSha256 = sha256(bytes);
  if (!SHA256.test(String(request.databaseSha256 || ''))
      || databaseSha256 !== request.databaseSha256) {
    throw new Error('recovery database SHA-256 does not match');
  }
  validateMetadata(request, databaseSha256, bytes.length);

  const spec = protocolCli.VERB_FLAGS['prepare-database-restore'];
  requireObject(request.protocolInputs, 'protocolInputs');
  const flagValues = [];
  for (const flag of Object.keys(spec)) {
    if (!Object.hasOwn(request.protocolInputs, flag)) {
      throw new Error(`recovery protocol inputs missing ${flag}`);
    }
    flagValues.push(flag, String(request.protocolInputs[flag]));
  }
  if (request.protocolInputs['--recovery-operation-id'] !== request.operationUuid) {
    throw new Error('recovery protocol operation does not match');
  }
  if (request.protocolInputs['--expected-recovery-phase']
      !== 'database-restore-preparing') {
    throw new Error('recovery protocol phase is not database-restore-preparing');
  }
  protocolCli.parseVerbArgs('prepare-database-restore', flagValues);

  return {
    format: 1,
    action: 'PREPARE_DATABASE_RESTORE',
    mode: request.mode,
    operationUuid: request.operationUuid,
    bundleUuid: request.bundleUuid,
    installationUuid: request.installationUuid,
    targetGatewayDeviceEui: targetEui,
    databasePath,
    databaseSha256,
    databaseByteLength: bytes.length,
    command: {
      executable: process.execPath,
      argv: [
        path.resolve(__dirname, 'sync-protocol-capability-cli.js'),
        'prepare-database-restore',
        ...flagValues,
      ],
    },
    mutationAuthorized: false,
    protocolImplementationState: 'PINNED_NOT_IMPLEMENTED',
  };
}

function validateDownloadedDatabase(value) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error('recovery database path must be absolute');
  }
  if (path.normalize(value) === LIVE_DATABASE) {
    throw new Error('recovery adapter refuses the live farming database path');
  }
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink()) {
    throw new Error('recovery adapter refuses a database symlink');
  }
  if (!stat.isFile()) {
    throw new Error('recovery database must be a regular file');
  }
  if (fs.realpathSync(value) === LIVE_DATABASE) {
    throw new Error('recovery adapter refuses the live farming database');
  }
  return path.resolve(value);
}

function validateMetadata(request, databaseSha256, databaseByteLength) {
  requireObject(request.authenticatedMetadata, 'authenticatedMetadata');
  const metadata = request.authenticatedMetadata;
  if (metadata.installation_uuid !== request.installationUuid) {
    throw new Error('recovery authenticated metadata installation does not match');
  }
  if (metadata.database_sha256 !== databaseSha256) {
    throw new Error('recovery authenticated metadata SHA-256 does not match');
  }
  if (metadata.database_byte_length !== databaseByteLength) {
    throw new Error('recovery authenticated metadata byte length does not match');
  }
  requireObject(metadata.witness, 'authenticatedMetadata.witness');
  if (Object.keys(metadata.witness).length === 0) {
    throw new Error('recovery authenticated metadata witness is empty');
  }
}

function run(argv) {
  const parsed = parseArgs(argv);
  const request = JSON.parse(fs.readFileSync(parsed.request, 'utf8'));
  const result = prepare(request, {
    expectedInstallationUuid: parsed.expectedInstallationUuid,
    expectedGatewayEui: parsed.expectedGatewayEui,
  });
  fs.writeFileSync(parsed.output, JSON.stringify(result, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return result;
}

function parseArgs(argv) {
  if (argv[0] !== 'prepare') throw new Error('expected prepare verb');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !flag.startsWith('--')) throw new Error('invalid argv');
    if (Object.hasOwn(values, flag)) throw new Error(`duplicate ${flag}`);
    values[flag] = value;
  }
  const mapping = {
    '--request': 'request',
    '--expected-installation-uuid': 'expectedInstallationUuid',
    '--expected-gateway-eui': 'expectedGatewayEui',
    '--output': 'output',
  };
  const result = {};
  for (const [flag, name] of Object.entries(mapping)) {
    if (!Object.hasOwn(values, flag)) throw new Error(`missing ${flag}`);
    result[name] = values[flag];
  }
  if (!path.isAbsolute(result.request) || !path.isAbsolute(result.output)) {
    throw new Error('request and output paths must be absolute');
  }
  return result;
}

function normalizeUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  requireUuid(normalized, label);
  return normalized;
}

function requireUuid(value, label) {
  if (!UUID.test(String(value || ''))) throw new Error(`${label} is invalid`);
}

function normalizeEui(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) throw new Error('gateway EUI is required');
  return normalized;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[installation-recovery-adapter] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepare, run, parseArgs };
