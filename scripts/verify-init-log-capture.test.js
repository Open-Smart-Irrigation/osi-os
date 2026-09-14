'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { scanInit, scanPersistentSink, INIT_PATH } = require('./verify-init-log-capture');

const initText = () => fs.readFileSync(INIT_PATH, 'utf8');

test('shipped init declares stdout and stderr capture', () => {
  assert.deepStrictEqual(scanInit(initText()), []);
});

test('a missing stderr param is reported', () => {
  const problems = scanInit('procd_open_instance\nprocd_set_param stdout 1\nprocd_close_instance\n');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /procd_set_param stderr/);
});

test('a param outside the instance block does not count', () => {
  const problems = scanInit(
    'procd_set_param stdout 1\nprocd_set_param stderr 1\n'
    + 'procd_open_instance\nprocd_set_param command node red.js\nprocd_close_instance\n',
  );
  assert.strictEqual(problems.length, 2);
});

test('shipped init configures a bounded persistent sink', () => {
  assert.deepStrictEqual(scanPersistentSink(initText()), []);
});

test('procd capture without a persistent sink is reported', () => {
  // This is the shape the plan calls out as not closing #223: stdout/stderr
  // reach logd, and a power cycle empties logd.
  const problems = scanPersistentSink(
    'procd_open_instance\nprocd_set_param stdout 1\nprocd_set_param stderr 1\nprocd_close_instance\n',
  );
  assert.ok(problems.length > 0);
  assert.match(problems[0], /RAM ring buffer/);
});

test('a sink defined but never called is reported', () => {
  const defined = initText().replace(/^\s*ensure_persistent_syslog_sink\s*$/m, '    : # call removed');
  const problems = scanPersistentSink(defined);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /never called from start_service/);
});

test('an unbounded sink is reported', () => {
  const unbounded = initText().replace(/uci -q set system\.@system\[0\]\.log_size=/, 'uci -q unset log_size ');
  const problems = scanPersistentSink(unbounded);
  assert.ok(problems.some((p) => /log_size/.test(p) && /unbounded/.test(p)));
});

test('an oversized bound is reported', () => {
  const huge = initText().replace(/OSI_PERSISTENT_LOG_SIZE_KIB="\d+"/, 'OSI_PERSISTENT_LOG_SIZE_KIB="1048576"');
  const problems = scanPersistentSink(huge);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /outside 1\.\.8192 KiB/);
});

test('a sink outside /data is reported', () => {
  const volatile = initText().replace(/OSI_PERSISTENT_LOG_FILE="[^"]+"/, 'OSI_PERSISTENT_LOG_FILE="/tmp/osi-system.log"');
  const problems = scanPersistentSink(volatile);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /not under \/data/);
});

test('logd buffer pinning is required', () => {
  const unpinned = initText().replace(/uci -q set system\.@system\[0\]\.log_buffer_size=/, 'uci -q noop ');
  const problems = scanPersistentSink(unpinned);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /log_buffer_size/);
});
