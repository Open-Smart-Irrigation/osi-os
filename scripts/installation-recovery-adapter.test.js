'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const adapter = require('./installation-recovery-adapter');
const protocolCli = require('./sync-protocol-capability-cli');

const INSTALLATION_UUID = '8e9c6f90-6a18-4a1a-9f10-9b1c8861703a';
const OPERATION_UUID = 'f6daf6b2-af75-41d2-9bbc-e9afef193ba5';
const BUNDLE_UUID = '123b810e-bc12-4ed1-8a95-800870270fa7';
const GATEWAY_EUI = 'AABBCCDDEEFF0011';
const SEED = path.resolve('database/farming.db');

test('prepare emits the exact pinned protocol command without mutation authority', () => {
  const fixture = setup();

  const result = adapter.prepare(fixture.request, {
    expectedInstallationUuid: INSTALLATION_UUID,
    expectedGatewayEui: GATEWAY_EUI,
  });

  assert.equal(result.action, 'PREPARE_DATABASE_RESTORE');
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.databasePath, fixture.database);
  assert.equal(result.databaseSha256, sha256(fs.readFileSync(fixture.database)));
  assert.equal(result.command.argv[1], 'prepare-database-restore');
  const parsed = protocolCli.parseVerbArgs(
    'prepare-database-restore',
    result.command.argv.slice(2),
  );
  assert.equal(parsed['--recovery-operation-id'], OPERATION_UUID);
  assert.equal(result.command.argv.includes('/data/db/farming.db'), false);
});

test('prepare rejects the live farming database path', () => {
  const fixture = setup();
  fixture.request.databasePath = '/data/db/farming.db';
  assert.throws(() => adapter.prepare(fixture.request, {
    expectedInstallationUuid: INSTALLATION_UUID,
    expectedGatewayEui: GATEWAY_EUI,
  }), /live farming database/);
});

test('prepare rejects a symlinked downloaded database', () => {
  const fixture = setup();
  const link = path.join(fixture.directory, 'linked.db');
  fs.symlinkSync(fixture.database, link);
  fixture.request.databasePath = link;
  assert.throws(() => adapter.prepare(fixture.request, {
    expectedInstallationUuid: INSTALLATION_UUID,
    expectedGatewayEui: GATEWAY_EUI,
  }), /symlink/);
});

test('prepare rejects wrong installation, gateway, and database hash', () => {
  const wrongInstallation = setup();
  assert.throws(() => adapter.prepare(wrongInstallation.request, {
    expectedInstallationUuid: '31da02aa-b6e5-41bb-8072-597f0c16a6a8',
    expectedGatewayEui: GATEWAY_EUI,
  }), /installation/);

  const wrongGateway = setup();
  assert.throws(() => adapter.prepare(wrongGateway.request, {
    expectedInstallationUuid: INSTALLATION_UUID,
    expectedGatewayEui: 'FFFFFFFFFFFFFFFF',
  }), /gateway/);

  const wrongHash = setup();
  wrongHash.request.databaseSha256 = 'f'.repeat(64);
  assert.throws(() => adapter.prepare(wrongHash.request, {
    expectedInstallationUuid: INSTALLATION_UUID,
    expectedGatewayEui: GATEWAY_EUI,
  }), /SHA-256/);
});

test('prepare rejects an incomplete future protocol invocation', () => {
  const fixture = setup();
  delete fixture.request.protocolInputs['--restore-baseline'];
  assert.throws(() => adapter.prepare(fixture.request, {
    expectedInstallationUuid: INSTALLATION_UUID,
    expectedGatewayEui: GATEWAY_EUI,
  }), /missing --restore-baseline/);
});

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-recovery-adapter-'));
  const database = path.join(directory, 'downloaded.db');
  fs.copyFileSync(SEED, database);
  const bytes = fs.readFileSync(database);
  return {
    directory,
    database,
    request: {
      format: 1,
      mode: 'restore',
      operationUuid: OPERATION_UUID,
      bundleUuid: BUNDLE_UUID,
      installationUuid: INSTALLATION_UUID,
      targetGatewayDeviceEui: GATEWAY_EUI,
      databasePath: database,
      databaseSha256: sha256(bytes),
      databaseByteLength: bytes.length,
      authenticatedMetadata: {
        installation_uuid: INSTALLATION_UUID,
        database_sha256: sha256(bytes),
        database_byte_length: bytes.length,
        witness: { sync_outbox_pending: 3 },
      },
      protocolInputs: protocolInputs(directory),
    },
  };
}

function protocolInputs(directory) {
  const values = {};
  const spec = protocolCli.VERB_FLAGS['prepare-database-restore'];
  for (const [flag, kind] of Object.entries(spec)) {
    if (flag === '--recovery-operation-id') {
      values[flag] = OPERATION_UUID;
    } else if (flag === '--expected-recovery-phase') {
      values[flag] = 'database-restore-preparing';
    } else if (kind === 'generation') {
      values[flag] = '0';
    } else if (kind === 'sha256') {
      values[flag] = 'a'.repeat(64);
    } else if (kind === 'pathOrNotApplicable') {
      values[flag] = 'not-applicable';
    } else if (kind === 'path') {
      values[flag] = path.join(directory, flag.slice(2) + '.json');
    } else {
      values[flag] = 'local-test';
    }
  }
  return values;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
