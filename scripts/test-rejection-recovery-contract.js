#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = path.join(ROOT, 'docs/contracts/sync-schema/rejection-recovery-v1.json');
const VENDOR_CANDIDATES = [
  path.resolve(ROOT, '../../../osi-server/backend/src/test/resources/sync-contract/rejection-recovery-v1.json'),
  path.resolve(ROOT, '../../osi-server/backend/src/test/resources/sync-contract/rejection-recovery-v1.json'),
];

const EXPECTED_REASONS = {
  ownership_precondition_missing: 'REPAIRABLE',
  parent_missing: 'RETRYABLE',
  ownership_mismatch: 'PERMANENT',
  missing_event_uuid: 'PERMANENT',
  unknown_op: 'PERMANENT',
  invalid_payload: 'PERMANENT',
  integrity_violation: 'PERMANENT',
  stale_sync_version: 'PERMANENT',
  equal_version_payload_conflict: 'PERMANENT',
  irrigation_event_identity_collision: 'PERMANENT',
};
const ORDINARY_STATUSES = ['APPLIED', 'DUPLICATE', 'REJECTED', 'RETRYABLE_ERROR'];
const RECOVERY_STATUSES = ['APPLIED', 'ALREADY_APPLIED', 'STILL_REJECTED', 'RETRYABLE_ERROR'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertContract(contract) {
  assert.equal(contract.contract_version, 'rejection-recovery-v1');
  assert.deepEqual(contract.reason_classes, EXPECTED_REASONS);
  assert.deepEqual(contract.ordinary_event_result_statuses, ORDINARY_STATUSES);
  assert.deepEqual(contract.result_statuses, RECOVERY_STATUSES);
  assert.deepEqual(contract.event_result.required, [
    'eventUuid', 'status', 'retryable', 'reason', 'rejectionCode', 'rejectionClass',
  ]);
  assert.deepEqual(contract.event_result.properties.rejectionCode, {
    type: ['string', 'null'],
    enum: [...Object.keys(EXPECTED_REASONS), null],
  });
  assert.deepEqual(contract.event_result.properties.rejectionClass, {
    type: ['string', 'null'],
    enum: ['REPAIRABLE', 'RETRYABLE', 'PERMANENT', 'LEGACY_UNCLASSIFIED', null],
  });
}

function verify() {
  const contract = readJson(CONTRACT);
  assertContract(contract);
  const vendor = VENDOR_CANDIDATES.find((file) => fs.existsSync(file));
  if (vendor) {
    const vendorContract = readJson(vendor);
    // The vendor file is the source for the policy vocabulary. When a sibling
    // vendor publishes the extended shape, its bytes must match this copy.
    assert.deepEqual(contract.reason_classes, vendorContract.reason_classes);
    assert.deepEqual(contract.result_statuses, vendorContract.result_statuses);
    if (Object.prototype.hasOwnProperty.call(vendorContract, 'ordinary_event_result_statuses')) {
      assert.equal(
        fs.readFileSync(CONTRACT, 'utf8'),
        fs.readFileSync(vendor, 'utf8'),
        'edge and extended sibling vendor contract must be byte-identical',
      );
    }
  }
  console.log(`rejection recovery contract: OK${vendor ? ` (vendor policy ${vendor})` : ''}`);
}

if (require.main === module) {
  try { verify(); } catch (error) {
    console.error(`rejection recovery contract: FAIL: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { verify, assertContract, EXPECTED_REASONS, ORDINARY_STATUSES, RECOVERY_STATUSES };
