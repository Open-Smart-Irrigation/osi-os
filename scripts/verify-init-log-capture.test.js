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

test('a hardcoded logd buffer pin is reported', () => {
  // The defect the review caught: pinning a literal 64 when OpenWrt's
  // generated /etc/config/system ships log_size=128, so the pin restarts logd
  // and halves the ring instead of leaving it alone.
  const literal = initText().replace(
    /uci -q set system\.@system\[0\]\.log_buffer_size="[^"]*"/,
    'uci -q set system.@system[0].log_buffer_size="64"',
  );
  const problems = scanPersistentSink(literal);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /pinned to the literal "64"/);
});

test('a pin not derived from the live values is reported', () => {
  const undereived = initText().replace(/uci -q get system\.@system\[0\]\.log_size/g, 'uci -q get nothing');
  const problems = scanPersistentSink(undereived);
  assert.ok(problems.some((p) => /derived from both live values/.test(p)));
});

test('a floor below the OpenWrt default ring is reported', () => {
  const low = initText().replace(/OSI_LOGD_MIN_BUFFER_KIB="\d+"/, 'OSI_LOGD_MIN_BUFFER_KIB="64"');
  const problems = scanPersistentSink(low);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /is below 128/);
});

test('a declared but unenforced floor is reported', () => {
  const unenforced = initText().replace(/-lt "\$OSI_LOGD_MIN_BUFFER_KIB"/, '-lt "0"');
  const problems = scanPersistentSink(unenforced);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /never enforced as a floor/);
});

test('a call outside start_service does not count as wiring', () => {
  // Moves the call into stop_service, which never runs at startup.
  const moved = initText().replace(
    /^(start_service\(\) \{\n)(.*\n)(\n    ensure_persistent_syslog_sink\n)/m,
    '$1$2\n',
  );
  const elsewhere = 'stop_service() {\n    ensure_persistent_syslog_sink\n}\n' + moved;
  const problems = scanPersistentSink(elsewhere);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /never called from start_service/);
});
