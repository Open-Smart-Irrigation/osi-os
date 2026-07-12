#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-requests-'));
const dbPath = path.join(tmpDir, 'farming.db');

function sqlite(args, input) {
  return execFileSync('sqlite3', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

try {
  sqlite([dbPath], fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8'));

  sqlite([dbPath], `
    INSERT INTO users(id, username, password_hash, created_at, updated_at)
    VALUES (7, 'field-user', 'hash', '2026-07-08T11:59:00.000Z', '2026-07-08T11:59:00.000Z');

    INSERT INTO improvement_requests(
      request_uuid, user_id, type, title, description, area, severity,
      consent_public, consent_diagnostics, diagnostics_json, gateway_device_eui,
      status_secret_hash, contact_email, submitted_at
    ) VALUES (
      '019ff001-1111-7222-8333-aaaaaaaaaaaa',
      7,
      'bug',
      'Pump status is confusing',
      'The dashboard says the pump is open after I closed it.',
      'dashboard',
      'annoying',
      1,
      1,
      '{"sync":{"pending_outbox_count":0}}',
      '0016C001F11715E2',
      'sha256:status-secret-fixture',
      'field-user@example.test',
      '2026-07-08T12:00:00.000Z'
    );
  `);

  const rows = JSON.parse(sqlite([
    '-json',
    dbPath,
    `SELECT op, aggregate_type, payload_json
       FROM sync_outbox
      WHERE aggregate_key = '019ff001-1111-7222-8333-aaaaaaaaaaaa';`,
  ]) || '[]');

  if (rows.length !== 1) {
    throw new Error(`expected one sync_outbox row for improvement request, found ${rows.length}`);
  }
  const row = rows[0];
  if (row.op !== 'WORK_REQUEST_SUBMITTED') {
    throw new Error(`expected op WORK_REQUEST_SUBMITTED, got ${row.op}`);
  }
  if (row.aggregate_type !== 'WORK_REQUEST') {
    throw new Error(`expected aggregate_type WORK_REQUEST, got ${row.aggregate_type}`);
  }

  const payload = JSON.parse(row.payload_json);
  if (payload.contract_version !== 1) {
    throw new Error(`expected payload.contract_version 1, got ${payload.contract_version}`);
  }
  if (payload.consent_public !== true) {
    throw new Error(`expected payload.consent_public true, got ${payload.consent_public}`);
  }
  if (payload.request_id !== '019ff001-1111-7222-8333-aaaaaaaaaaaa') {
    throw new Error(`expected payload.request_id to match inserted request UUID, got ${payload.request_id}`);
  }
  if (payload.status_secret_hash !== 'sha256:status-secret-fixture') {
    throw new Error(`expected payload.status_secret_hash to match inserted hash, got ${payload.status_secret_hash}`);
  }
  if (payload.contact_email !== 'field-user@example.test') {
    throw new Error(`expected payload.contact_email to match inserted contact email, got ${payload.contact_email}`);
  }
  if (payload.gateway_device_eui !== '0016C001F11715E2') {
    throw new Error(`expected payload.gateway_device_eui to match inserted gateway EUI, got ${payload.gateway_device_eui}`);
  }
  if (!payload.gui_user || payload.gui_user.local_user_id !== 7) {
    throw new Error(`expected payload.gui_user.local_user_id 7, got ${JSON.stringify(payload.gui_user)}`);
  }

  let rejectedConsentPublic = false;
  try {
    sqlite([dbPath], `
      INSERT INTO improvement_requests(
        request_uuid, user_id, type, title, description, area, severity,
        consent_public, consent_diagnostics, diagnostics_json
      ) VALUES (
        '019ff001-1111-7222-8333-bbbbbbbbbbbb',
        7,
        'feedback',
        'Private request',
        'This should be rejected because public consent is required.',
        'dashboard',
        'idea',
        0,
        1,
        '{}'
      );
    `);
  } catch (err) {
    rejectedConsentPublic = true;
  }
  if (!rejectedConsentPublic) {
    throw new Error('expected consent_public != 1 insert to be rejected');
  }

  console.log('PASS: improvement_requests schema emits WORK_REQUEST_SUBMITTED outbox payload');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
