#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = path.join(ROOT, 'docs/contracts/sync-schema/rejection-recovery-v1.json');
const VENDOR_CANDIDATES = [
  process.env.OSI_SERVER_REJECTION_RECOVERY_CONTRACT,
  path.resolve(ROOT, 'osi-server/backend/src/test/resources/sync-contract/rejection-recovery-v1.json'),
  path.resolve(ROOT, '../../../osi-server/backend/src/test/resources/sync-contract/rejection-recovery-v1.json'),
  path.resolve(ROOT, '../osi-server/backend/src/test/resources/sync-contract/rejection-recovery-v1.json'),
].filter(Boolean);

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
  assert.deepEqual(contract.event_result_statuses, ORDINARY_STATUSES);
  assert.deepEqual(contract.result_statuses, RECOVERY_STATUSES);
  assert.deepEqual(contract.rejection_result_fields, {
    code: 'rejectionCode',
    class: 'rejectionClass',
  });
}

function verify() {
  const contract = readJson(CONTRACT);
  assertContract(contract);
  const vendor = VENDOR_CANDIDATES.find((file) => fs.existsSync(file));
  assert.ok(vendor, 'osi-server rejection recovery contract vendor is required');
  assert.equal(
    fs.readFileSync(CONTRACT, 'utf8'),
    fs.readFileSync(vendor, 'utf8'),
    'edge and osi-server rejection recovery contracts must be byte-identical',
  );
  assertContract(readJson(vendor));
  console.log(`rejection recovery contract: OK (vendor ${vendor})`);
}

if (require.main === module) {
  try { verify(); } catch (error) {
    console.error(`rejection recovery contract: FAIL: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { verify, assertContract, EXPECTED_REASONS, ORDINARY_STATUSES, RECOVERY_STATUSES };
