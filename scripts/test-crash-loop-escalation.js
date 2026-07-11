'use strict';

// Crash-loop escalation (refactor-program item 1.A4). Exercises the persistent
// crash-count file that lets a heartbeat distinguish "actually healthy" from
// "crash-looping but still checking in between respawns" — see
// conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HEALTH_HELPER_MODULE =
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper';
const { registerStartup, readCrashState } = require(HEALTH_HELPER_MODULE);

function makeTempCrashFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-crash-loop-'));
  return path.join(dir, 'node-red-crash-count');
}

test('readCrashState with no file returns a reset, non-looping state', () => {
  const crashFilePath = makeTempCrashFilePath();

  const state = readCrashState({ crashFilePath });

  assert.deepStrictEqual(state, { crash_count: 0, crash_looping: false });
});

test('readCrashState is failure-safe against a corrupt file', () => {
  const crashFilePath = makeTempCrashFilePath();
  fs.writeFileSync(crashFilePath, '{not valid json', 'utf8');

  const state = readCrashState({ crashFilePath });

  assert.deepStrictEqual(state, { crash_count: 0, crash_looping: false });
});

test('registerStartup writes the file, and a second call within the window increments the count', () => {
  const crashFilePath = makeTempCrashFilePath();

  const first = registerStartup({ crashFilePath });
  assert.deepStrictEqual(first, { crash_count: 0, crash_looping: false });
  assert.ok(fs.existsSync(crashFilePath), 'registerStartup must write the crash file');

  const writtenAfterFirst = JSON.parse(fs.readFileSync(crashFilePath, 'utf8'));
  assert.strictEqual(writtenAfterFirst.count, 0);
  assert.strictEqual(typeof writtenAfterFirst.lastCrashAt, 'number');
  assert.strictEqual(typeof writtenAfterFirst.startedAt, 'number');

  const second = registerStartup({ crashFilePath });
  assert.deepStrictEqual(second, { crash_count: 1, crash_looping: false });

  const stateAfterSecond = readCrashState({ crashFilePath });
  assert.deepStrictEqual(stateAfterSecond, { crash_count: 1, crash_looping: false });
});

test('registerStartup resets the count once the crash window has elapsed', () => {
  const crashFilePath = makeTempCrashFilePath();
  const windowSeconds = 300;

  // Seed the file as if 3 quick respawns already happened, then simulate a
  // long-since-elapsed window by backdating lastCrashAt.
  const staleLastCrashAt = Date.now() - (windowSeconds * 1000 + 5000);
  fs.writeFileSync(
    crashFilePath,
    JSON.stringify({ count: 3, lastCrashAt: staleLastCrashAt, startedAt: staleLastCrashAt }),
    'utf8'
  );

  const result = registerStartup({ crashFilePath, crashWindowSeconds: windowSeconds });

  assert.deepStrictEqual(result, { crash_count: 0, crash_looping: false });
  const written = JSON.parse(fs.readFileSync(crashFilePath, 'utf8'));
  assert.strictEqual(written.count, 0);
});

test('crash_looping becomes true once the count reaches the threshold', () => {
  const crashFilePath = makeTempCrashFilePath();
  const threshold = 3;

  // Each call is within the (generous, real-time) default window, so every
  // call after the first increments the counter by one.
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(registerStartup({ crashFilePath, crashLoopThreshold: threshold }));
  }

  assert.deepStrictEqual(results.map((r) => r.crash_count), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(results.map((r) => r.crash_looping), [false, false, false, true, true]);

  const finalState = readCrashState({ crashFilePath, crashLoopThreshold: threshold });
  assert.deepStrictEqual(finalState, { crash_count: 4, crash_looping: true });
});

test('crash_looping respects a custom threshold override', () => {
  const crashFilePath = makeTempCrashFilePath();

  registerStartup({ crashFilePath }); // count 0
  registerStartup({ crashFilePath }); // count 1

  const withDefaultThreshold = readCrashState({ crashFilePath });
  assert.strictEqual(withDefaultThreshold.crash_looping, false);

  const withLowThreshold = readCrashState({ crashFilePath, crashLoopThreshold: 1 });
  assert.strictEqual(withLowThreshold.crash_looping, true);
});

// health_state derivation logic, mirrored from gatherWork() in the health
// helper: 'crash_looping' wins over everything, then 'degraded' if there are
// flow errors or rejected sync rows, else 'healthy'.
function deriveHealthState({ crashLooping, errorCount, syncRejected }) {
  const hasErrors = Number.isFinite(errorCount) && errorCount > 0;
  const hasRejected = Number.isFinite(syncRejected) && syncRejected > 0;
  if (crashLooping) return 'crash_looping';
  if (hasErrors || hasRejected) return 'degraded';
  return 'healthy';
}

test('health_state derivation: healthy when nothing is wrong', () => {
  assert.strictEqual(
    deriveHealthState({ crashLooping: false, errorCount: 0, syncRejected: 0 }),
    'healthy'
  );
});

test('health_state derivation: degraded when flow error_count is positive', () => {
  assert.strictEqual(
    deriveHealthState({ crashLooping: false, errorCount: 2, syncRejected: 0 }),
    'degraded'
  );
});

test('health_state derivation: degraded when sync_rejected is positive', () => {
  assert.strictEqual(
    deriveHealthState({ crashLooping: false, errorCount: 0, syncRejected: 1 }),
    'degraded'
  );
});

test('health_state derivation: crash_looping takes priority over degraded signals', () => {
  assert.strictEqual(
    deriveHealthState({ crashLooping: true, errorCount: 5, syncRejected: 5 }),
    'crash_looping'
  );
});

test('registerStartup does not throw when the crash file directory does not exist', () => {
  const crashFilePath = path.join(os.tmpdir(), 'osi-nonexistent-' + Date.now(), 'deep', 'crash-count');
  const result = registerStartup({ crashFilePath });
  assert.strictEqual(result.crash_count, 0);
  assert.strictEqual(result.crash_looping, false);
});

test('registerStartup resets the count when clock steps backwards (NTP correction)', () => {
  const crashFilePath = makeTempCrashFilePath();
  const futureLastCrashAt = Date.now() + 60000;
  fs.writeFileSync(
    crashFilePath,
    JSON.stringify({ count: 2, lastCrashAt: futureLastCrashAt, startedAt: futureLastCrashAt }),
    'utf8'
  );
  const result = registerStartup({ crashFilePath });
  assert.strictEqual(result.crash_count, 0, 'negative delta must reset, not increment');
  assert.strictEqual(result.crash_looping, false);
});

test('gatherEdgeHealth threads crash state and health_state into the health object', async () => {
  const { gatherEdgeHealth } = require(HEALTH_HELPER_MODULE);
  const crashFilePath = makeTempCrashFilePath();

  // Push the crash counter to the looping threshold first.
  for (let i = 0; i < 4; i += 1) registerStartup({ crashFilePath });

  const fakeDb = {
    async all() { return []; },
    async get() { return undefined; }
  };

  const health = await gatherEdgeHealth(fakeDb, {
    timeoutMs: 1000,
    diskPath: os.tmpdir(),
    crashFilePath,
    errorCount: 0
  });

  assert.strictEqual(health.crash_count, 3);
  assert.strictEqual(health.crash_looping, true);
  assert.strictEqual(health.health_state, 'crash_looping');
});
