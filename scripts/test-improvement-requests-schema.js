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
      consent_public, consent_diagnostics, diagnostics_json, gateway_device_eui, submitted_at
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

  console.log('PASS: improvement_requests schema emits WORK_REQUEST_SUBMITTED outbox payload');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
