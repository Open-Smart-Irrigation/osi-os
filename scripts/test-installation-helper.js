#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const helper = require(path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper'
));

const installationUuid = '8E9C6F90-6A18-4A1A-9F10-9B1C8861703A';

assert.equal(
  helper.normalizeInstallationUuid(installationUuid),
  '8e9c6f90-6a18-4a1a-9f10-9b1c8861703a'
);
assert.equal(helper.normalizeInstallationUuid('not-a-uuid'), '');
assert.match(helper.newInstallationUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

assert.deepEqual(
  helper.mergeGatewayHistory('0016C001F11715E2', ['0016C001F11715E1'], '0016C001F11715E3'),
  {
    currentGatewayDeviceEui: '0016C001F11715E3',
    previousGatewayDeviceEuis: ['0016C001F11715E1', '0016C001F11715E2']
  }
);
assert.deepEqual(
  helper.mergeGatewayHistory('0016C001F11715E3', ['0016C001F11715E1', '0016C001F11715E2'], '0016C001F11715E2'),
  {
    currentGatewayDeviceEui: '0016C001F11715E2',
    previousGatewayDeviceEuis: ['0016C001F11715E1', '0016C001F11715E3']
  }
);

assert.equal(
  helper.verifierVersion(['installation_recovery_v1'], installationUuid),
  2
);
assert.equal(helper.verifierVersion([], installationUuid), 1);
assert.equal(
  helper.verifierSubject('secret', 2, installationUuid, '0016C001F11715E2'),
  'secret::8e9c6f90-6a18-4a1a-9f10-9b1c8861703a'
);
assert.equal(
  helper.verifierSubject('secret', 1, installationUuid, '0016C001F11715E2'),
  'secret::0016C001F11715E2'
);
assert.throws(
  () => helper.assertMatchingInstallation(installationUuid, '31da02aa-b6e5-41bb-8072-597f0c16a6a8'),
  /installation identity mismatch/
);
assert.equal(helper.canonicalWritesAllowed('ACTIVE'), true);
assert.equal(helper.canonicalWritesAllowed('RECONCILING'), false);

console.log('OK installation helper');

