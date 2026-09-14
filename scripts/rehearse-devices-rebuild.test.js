'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

function runCase(mode) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reh-')), 'copy.db');
  let out, code = 0;
  try { out = execFileSync('node', [path.join(__dirname, 'rehearse-devices-rebuild.js'), mode, db], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
  // The harness prints one JSON line to stdout; node:sqlite's ExperimentalWarning goes to stderr.
  // Take the last line that starts with '{' so the diagnostics survive a non-zero exit.
  const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
  return { json: JSON.parse(line), code };
}

// The diagnostics-carrying form: returns the harness result object regardless of exit code,
// so a case can assert on `aborted`/`error`/`columns`/`rows` rather than only on the exit status.
async function rehearse(mode) {
  const { json } = runCase(mode);
  return json;
}

// osi-os#219 rehearsal case 9 replays Uganda's post-repair devices column set. Uganda is a
// production gateway; until the column list is captured from a fresh .backup with Phil's
// explicit go, the fixture is a placeholder and the case SKIPS loudly instead of passing.
const UGANDA_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/uganda-post-repair-devices-columns.json'), 'utf8'));

test('healthy DB: guard SKIPS the rebuild, rows preserved', () => {
  const { json, code } = runCase('healthy');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.skipped, true);
});

test('a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced', () => {
  const { json, code } = runCase('would-drop');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.rowsPreserved, true);
  assert.strictEqual(json.errorSurfaced, true);
  // The cascade guard: device_data hangs off devices(deveui) ON DELETE CASCADE, so an
  // abort that rolled back badly, or an unfenced swap, would take the telemetry with it.
  assert.strictEqual(json.telemetryBefore, 6, 'two devices x three device_data rows');
  assert.strictEqual(json.telemetryAfter, 6, 'device_data must survive the aborted rebuild');
});

test('legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN', () => {
  const { json, code } = runCase('legit-upgrade');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.hasLorain, true);
  // A real rebuild drops and renames the parent table. With the FK fence intact the
  // cascade never fires; without it every device_data row would go (the Uganda class).
  assert.strictEqual(json.telemetryBefore, 6, 'two devices x three device_data rows');
  assert.strictEqual(json.telemetryAfter, 6, 'device_data must survive the real rebuild');
});

test('SDI-12 sentinels survive the rebuild with all five columns present, including the Sentek layout', () => {
  const { json, code } = runCase('sdi12-sentinels');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.sdi12Preserved, true);
  assert.strictEqual(json.hasSdi12Columns, true);
});

test('extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved', () => {
  const { json, code } = runCase('extra-type');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.skipped, false); // must NOT tolerate the extra type (RED under the old missing-only guard)
  assert.strictEqual(json.rowsPreserved, true);
});

test('missing source columns: rebuild succeeds and backfills defaults', async () => {
  const res = await rehearse('missing-source-columns'); // pre-0026 column set, 6-type CHECK, 2 rows
  assert.strictEqual(res.aborted, false, 'rebuild must not abort: ' + (res.error || ''));
  assert.strictEqual(res.rowCount, 2);
  for (const c of ['sdi12_probe_profile', 'sdi12_probe_status', 'sdi12_identity',
                   'sdi12_value_count', 'sdi12_channel_layout_json']) {
    assert.ok(res.columns.includes(c), `rebuilt devices must have ${c}`);
  }
  assert.strictEqual(res.rows[0].sdi12_channel_layout_json, null);
  assert.strictEqual(res.rows[0].dendro_enabled, 0, 'NOT NULL columns take their default, never NULL');
});

test('extra live column: rebuild ABORTS and devices is left intact', async () => {
  const res = await rehearse('extra-live-column'); // head columns + devices.future_col TEXT, 6-type CHECK
  assert.strictEqual(res.aborted, true);
  assert.match(res.error, /unknown live column\(s\) future_col/);
  assert.ok(res.columns.includes('future_col'), 'the live column and its data survive');
  assert.strictEqual(res.rowCount, 2);
  assert.strictEqual(res.rows[0].future_col, 'KEEPME');
  assert.strictEqual(res.telemetryBefore, 6, 'two devices x three device_data rows');
  assert.strictEqual(res.telemetryAfter, 6, 'device_data must survive the refusal');
});

test('null chameleon_enabled survives the rebuild', async () => {
  const res = await rehearse('null-chameleon');
  assert.strictEqual(res.aborted, false);
  assert.strictEqual(res.rows[0].chameleon_enabled, 0, 'COALESCE default applied');
});

test('Uganda post-repair column set: rebuild succeeds on the manually-repaired shape', {
  skip: UGANDA_FIXTURE.pending_capture
    ? `${UGANDA_FIXTURE.status} - tracked in ${UGANDA_FIXTURE.issue}: ${UGANDA_FIXTURE.capture}`
    : false,
}, async () => {
  const res = await rehearse('uganda-post-repair-columns');
  assert.strictEqual(res.aborted, false, 'rebuild must not abort: ' + (res.error || ''));
  assert.ok(res.columns.includes('chameleon_enabled'));
});

test('every rehearsal case preserves device_data across the FK cascade', () => {
  for (const mode of ['healthy', 'would-drop', 'legit-upgrade', 'sdi12-sentinels', 'extra-type',
                      'missing-source-columns', 'extra-live-column', 'null-chameleon']) {
    const { json, code } = runCase(mode);
    assert.strictEqual(code, 0, `${mode}: ${JSON.stringify(json)}`);
    assert.ok(json.telemetryBefore > 0, `${mode}: the case must seed device_data to witness the cascade`);
    assert.strictEqual(json.telemetryAfter, json.telemetryBefore,
      `${mode}: device_data lost rows to the devices(deveui) ON DELETE CASCADE`);
  }
});
