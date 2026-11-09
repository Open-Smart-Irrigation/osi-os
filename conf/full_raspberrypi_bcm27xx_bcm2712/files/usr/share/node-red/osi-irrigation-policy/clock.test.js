'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { clockStatus, runtimeClockStatus, readRuntimeClock } = require('./clock');

const marker = { boot_id: 'boot-a', epoch_ms: 100000, uptime_ms: 50000, stratum: 2 };

test('clock status accepts same-boot wall/uptime progression and offline operation', () => {
  const status = clockStatus({ bootId: 'boot-a', marker, uptime: 55000, now: 105000,
    lastDue: '1970-01-01T00:01:40.000Z', latestSample: '1970-01-01T00:01:41.000Z' });
  assert.deepEqual(status, { trusted: true, reason: 'trusted' });
});

test('clock status reports exact reasons without shared rejected state', () => {
  assert.deepEqual(clockStatus({ bootId: 'boot-a', marker: null, uptime: 55000, now: 105000 }), { trusted: false, reason: 'clock_untrusted_missing_marker' });
  assert.deepEqual(clockStatus({ bootId: 'boot-b', marker, uptime: 55000, now: 105000 }), { trusted: false, reason: 'clock_untrusted_boot' });
  assert.deepEqual(clockStatus({ bootId: 'boot-a', marker, uptime: 55000, now: 93000 }), { trusted: false, reason: 'clock_untrusted_backward' });
  assert.deepEqual(clockStatus({ bootId: 'boot-a', marker, uptime: 55000, now: 120000 }), { trusted: false, reason: 'clock_untrusted_jump' });
  assert.deepEqual(clockStatus({ bootId: 'boot-a', marker, uptime: 55000, now: 105000, lastDue: '1970-01-01T00:01:46.000Z' }), { trusted: false, reason: 'clock_untrusted_lower_bound' });
  assert.deepEqual(clockStatus({ bootId: 'boot-a', marker, uptime: 55000, now: 105000, latestSample: '1970-01-01T00:01:46.000Z' }), { trusted: false, reason: 'clock_untrusted_lower_bound' });
  assert.equal(clockStatus({ bootId: 'boot-a', marker, uptime: 55000, now: 110000 }).trusted, true); // 5 seconds is inclusive
});

test('runtime rejection survives module reload, restored wall time, and clears on fresh marker', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-runtime-'));
  const markerPath = path.join(dir, 'marker.json');
  const rejectionPath = path.join(dir, 'rejection.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const options = { fs, markerPath, rejectionPath, bootId: 'boot-a', uptime: 55000, now: 120000 };
  assert.equal(runtimeClockStatus(options).trusted, false);
  delete require.cache[require.resolve('./clock')];
  const reloaded = require('./clock');
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_invalidated' });
  const fresh = { ...marker, epoch_ms: 105000, uptime_ms: 55000 };
  fs.writeFileSync(markerPath, JSON.stringify(fresh));
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 105000 }), { trusted: true, reason: 'trusted' });
  assert.equal(fs.existsSync(rejectionPath), false);
});

test('SQLite and ISO lower bounds are parsed as UTC under a non-UTC process timezone', () => {
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', `const {clockStatus}=require(${JSON.stringify(require.resolve('./clock'))}); const now=Date.parse('2026-07-01T04:00:00Z'); const m={boot_id:'boot-a',epoch_ms:now-3600000,uptime_ms:0,stratum:2}; console.log(JSON.stringify([clockStatus({bootId:'boot-a',marker:m,uptime:3600000,now,latestSample:'2026-07-01 05:55:00'}),clockStatus({bootId:'boot-a',marker:m,uptime:3600000,now,latestSample:'2026-07-01T05:55:00Z'})]));`], { env: { ...process.env, TZ: 'Europe/Zurich' }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), [
    { trusted: false, reason: 'clock_untrusted_lower_bound' },
    { trusted: false, reason: 'clock_untrusted_lower_bound' },
  ]);
});

test('write failure leaves durable rejection across restored wall and reload, then fresh marker recovers', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-fallback-'));
  const markerPath = path.join(dir, 'marker.json');
  const rejectionPath = path.join(dir, 'rejection.json');
  const fallbackPath = path.join(dir, 'marker.rejected.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const failingPrimary = new Proxy(fs, { get(target, key) {
    if (key === 'writeFileSync') return (file, ...args) => {
      if (String(file).startsWith(rejectionPath)) throw new Error('primary unavailable');
      return target.writeFileSync(file, ...args);
    };
    return target[key];
  } });
  const options = { fs: failingPrimary, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 120000 };
  assert.deepEqual(runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_persistence' });
  assert.equal(fs.existsSync(fallbackPath), true);
  delete require.cache[require.resolve('./clock')];
  const reloaded = require('./clock');
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_invalidated' });
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, epoch_ms: 105000, uptime_ms: 55000 }));
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 105000 }), { trusted: true, reason: 'trusted' });
  assert.equal(fs.existsSync(fallbackPath), false);
});

test('sticky rejection retries after storage recovery and survives reload until fresh sync', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-retry-'));
  const markerPath = path.join(dir, 'marker.json');
  const rejectionPath = path.join(dir, 'rejection.json');
  const fallbackPath = path.join(dir, 'marker.rejected.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  let writable = false;
  const guarded = new Proxy(fs, { get(target, key) {
    if (['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync'].includes(key)) return (...args) => {
      if (!writable) throw new Error('storage unavailable');
      return target[key](...args);
    };
    return target[key];
  } });
  const options = { fs: guarded, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 120000 };
  assert.deepEqual(runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_persistence' });
  assert.deepEqual(runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_persistence' });
  writable = true;
  assert.deepEqual(runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_invalidated' });
  delete require.cache[require.resolve('./clock')];
  const reloaded = require('./clock');
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_invalidated' });
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, epoch_ms: 105000, uptime_ms: 55000 }));
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 105000 }), { trusted: true, reason: 'trusted' });
});

test('matching fallback rejection wins over stale primary rejection across reload', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-set-'));
  const markerPath = path.join(dir, 'marker.json');
  const rejectionPath = path.join(dir, 'rejection.json');
  const fallbackPath = path.join(dir, 'marker.rejected.json');
  const markerB = { ...marker, epoch_ms: 105000, uptime_ms: 55000 };
  fs.writeFileSync(markerPath, JSON.stringify(markerB));
  fs.writeFileSync(rejectionPath, JSON.stringify({ boot_id: 'boot-a', marker: 'boot-a|100000|50000|2', reason: 'clock_untrusted_jump' }));
  fs.writeFileSync(fallbackPath, JSON.stringify({ boot_id: 'boot-a', marker: 'boot-a|105000|55000|2', reason: 'clock_untrusted_jump' }));
  const options = { fs, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 105000 };
  assert.deepEqual(runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_invalidated' });
  delete require.cache[require.resolve('./clock')];
  const reloaded = require('./clock');
  assert.deepEqual(reloaded.runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_invalidated' });
  fs.writeFileSync(markerPath, JSON.stringify({ ...markerB, epoch_ms: 106000, uptime_ms: 56000 }));
  assert.deepEqual(reloaded.runtimeClockStatus({ ...options, now: 106000, uptime: 56000 }), { trusted: true, reason: 'trusted' });
});

test('cleanup retry does not serialize a malformed rejection and recovers after reload', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-cleanup-'));
  const markerPath = path.join(dir, 'marker.json');
  const rejectionPath = path.join(dir, 'rejection.json');
  const fallbackPath = path.join(dir, 'marker.rejected.json');
  const markerB = { ...marker, epoch_ms: 105000, uptime_ms: 55000 };
  fs.writeFileSync(markerPath, JSON.stringify(markerB));
  fs.writeFileSync(rejectionPath, JSON.stringify({ boot_id: 'boot-a', marker: 'boot-a|100000|50000|2', reason: 'clock_untrusted_jump' }));
  let cleanupWritable = false;
  const guarded = new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync') return (...args) => {
      if (!cleanupWritable) throw new Error('cleanup unavailable');
      return target.unlinkSync(...args);
    };
    return target[key];
  } });
  const options = { fs: guarded, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 105000 };
  assert.deepEqual(runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_persistence' });
  cleanupWritable = true;
  assert.deepEqual(runtimeClockStatus(options), { trusted: true, reason: 'trusted' });
  assert.equal(fs.existsSync(rejectionPath), false);
  delete require.cache[require.resolve('./clock')];
  const reloaded = require('./clock');
  assert.deepEqual(reloaded.runtimeClockStatus(options), { trusted: true, reason: 'trusted' });
});

test('malformed durable rejection pair fails closed even when the other record matches', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  for (const mode of ['malformed', 'read_error']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `osi-clock-${mode}-`));
    const markerPath = path.join(dir, 'marker.json');
    const rejectionPath = path.join(dir, 'rejection.json');
    const fallbackPath = path.join(dir, 'marker.rejected.json');
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    fs.writeFileSync(rejectionPath, mode === 'malformed' ? '{broken' : JSON.stringify({ boot_id: 'boot-a', marker: 'other', reason: 'clock_untrusted_jump' }));
    fs.writeFileSync(fallbackPath, JSON.stringify({ boot_id: 'boot-a', marker: 'boot-a|100000|50000|2', reason: 'clock_untrusted_jump' }));
    const guarded = mode === 'read_error' ? new Proxy(fs, { get(target, key) {
      if (key === 'readFileSync') return (file, ...args) => { if (file === rejectionPath) { const error = new Error('denied'); error.code = 'EACCES'; throw error; } return target.readFileSync(file, ...args); };
      return target[key];
    } }) : fs;
    assert.deepEqual(runtimeClockStatus({ fs: guarded, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 105000 }), { trusted: false, reason: 'clock_untrusted_persistence' });
  }
});

test('fallback rejection keeps a concurrently written fresh marker available', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-race-'));
  const markerPath = path.join(dir, 'marker.json');
  const rejectionPath = path.join(dir, 'rejection.json');
  const fallbackPath = path.join(dir, 'marker.rejected.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const fresh = { ...marker, epoch_ms: 105000, uptime_ms: 55000 };
  const racing = new Proxy(fs, { get(target, key) {
    if (key === 'writeFileSync') return (file, ...args) => {
      if (String(file).startsWith(rejectionPath)) {
        target.writeFileSync(markerPath, JSON.stringify(fresh));
        throw new Error('primary unavailable');
      }
      return target.writeFileSync(file, ...args);
    };
    return target[key];
  } });
  const options = { fs: racing, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 120000 };
  assert.deepEqual(runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_persistence' });
  assert.deepEqual(runtimeClockStatus({ ...options, now: 105000 }), { trusted: true, reason: 'trusted' });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), fresh);
});

test('sticky failure remains untrusted when both durable rejection paths fail', () => {
  const markerPath = '/tmp/sticky-marker.json';
  const rejectionPath = '/tmp/sticky-rejection.json';
  const fallbackPath = '/tmp/sticky-fallback.json';
  let currentMarker = marker;
  const fs = {
    readFileSync(path) {
      if (path === markerPath) return JSON.stringify(currentMarker);
      if (path === rejectionPath || path === fallbackPath) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
      if (path.endsWith('/boot_id')) return 'boot-a\n';
      if (path.endsWith('/uptime')) return '55.0 0.0\n';
      throw new Error('missing');
    },
    mkdirSync() { throw new Error('read-only'); },
  };
  const options = { fs, markerPath, rejectionPath, fallbackPath, bootId: 'boot-a', uptime: 55000, now: 120000 };
  assert.deepEqual(runtimeClockStatus(options), { trusted: false, reason: 'clock_untrusted_persistence' });
  assert.deepEqual(runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_persistence' });
  currentMarker = { ...marker, epoch_ms: 105000, uptime_ms: 55000 };
  assert.deepEqual(runtimeClockStatus({ ...options, now: 105000 }), { trusted: false, reason: 'clock_untrusted_persistence' });
});

test('runtime gate fails closed when durable rejection cannot be written', () => {
  const rejectionPath = '/tmp/rejection.json';
  const markerPath = '/tmp/marker.json';
  const fs = {
    readFileSync(path) {
      if (path === rejectionPath) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
      if (path === markerPath) return JSON.stringify(marker);
      if (path.endsWith('/boot_id')) return 'boot-a\n';
      if (path.endsWith('/uptime')) return '55.0 0.0\n';
      throw new Error('missing');
    },
    mkdirSync() { throw new Error('read-only'); },
  };
  assert.deepEqual(runtimeClockStatus({ fs, markerPath, rejectionPath, bootId: 'boot-a', uptime: 55000, now: 120000 }), { trusted: false, reason: 'clock_untrusted_persistence' });
});

test('readRuntimeClock reads procfs through injectable paths and missing marker is untrusted', () => {
  const fs = { readFileSync(path) {
    if (path.endsWith('boot_id')) return 'boot-a\n';
    if (path.endsWith('uptime')) return '55.0 0.0\n';
    throw new Error('missing');
  } };
  assert.deepEqual(readRuntimeClock({ fs, markerPath: '/missing' }), { bootId: 'boot-a', uptime: 55000, marker: null });
});

function uptimeReading(text) {
  return readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
    if (file.endsWith('boot_id')) return 'boot-a\n';
    if (file.endsWith('uptime')) return text;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } } }).uptime;
}

test('readRuntimeClock converts real procfs-format uptime files to exact integer milliseconds', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-uptime-'));
  try {
    const bootPath = path.join(dir, 'boot_id');
    const uptimePath = path.join(dir, 'uptime');
    fs.writeFileSync(bootPath, 'boot-a\n');
    assert.equal(Number.parseFloat('2.01') * 1000, 2009.9999999999998);
    for (const [text, expected] of [['2.01 0.00\n', 2010], ['1.12 3.40\n', 1120], ['1.13 3.40\n', 1130]]) {
      fs.writeFileSync(uptimePath, text);
      const runtime = readRuntimeClock({ bootPath, uptimePath, markerPath: path.join(dir, 'missing-marker') });
      assert.deepEqual(runtime, { bootId: 'boot-a', uptime: expected, marker: null }, text);
      assert.equal(Number.isInteger(runtime.uptime), true, text);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRuntimeClock maps every centisecond reading to exact, strictly increasing milliseconds', () => {
  let previous = -1;
  for (let centiseconds = 0; centiseconds <= 20000; centiseconds += 1) {
    const text = `${Math.floor(centiseconds / 100)}.${String(centiseconds % 100).padStart(2, '0')} 0.00\n`;
    const uptime = uptimeReading(text);
    assert.equal(uptime, centiseconds * 10, text);
    assert.ok(uptime > previous, text);
    previous = uptime;
  }
  for (const [text, expected] of [['55.0 0.0\n', 55000], ['100.000 0.00\n', 100000], ['0 0\n', 0], ['7 0\n', 7000],
    ['0.001 0\n', 1], ['9007199254740.991 0\n', 9007199254740991]]) {
    assert.equal(uptimeReading(text), expected, text);
  }
});

test('readRuntimeClock leaves missing, malformed, negative, non-finite and sub-millisecond uptime untrusted', () => {
  for (const text of ['', '\n', 'abc 0', 'NaN 0', 'Infinity 0', '-2.00 0', '+1.00 0', '1e3 0', '0x10 0', '2.01abc 0',
    '2. 0', '.5 0', '2.0001 0', '9007199254740.992 0', `${'9'.repeat(400)} 0`]) {
    assert.equal(uptimeReading(text), null, JSON.stringify(text));
  }
  const noUptime = readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
    if (file.endsWith('boot_id')) return 'boot-a\n';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } } });
  assert.deepEqual(noUptime, { bootId: 'boot-a', uptime: null, marker: null });
  const noBoot = readRuntimeClock({ markerPath: '/missing', fs: { readFileSync(file) {
    if (file.endsWith('uptime')) return '2.01 0.00\n';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } } });
  assert.deepEqual(noBoot, { bootId: null, uptime: 2010, marker: null });
});

test('a stratum marker written at 2.01 s uptime stays trusted when read in the same centisecond', () => {
  const files = new Map([['/clock/boot', 'boot-a\n'], ['/clock/uptime', '2.01 0.00\n'],
    ['/clock/marker', JSON.stringify({ boot_id: 'boot-a', epoch_ms: 1800000000000, uptime_ms: 2010, stratum: 2 })]]);
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fs = {
    readFileSync(file) { if (files.has(file)) return files.get(file); throw missing(); },
    writeFileSync(file, value) { files.set(file, value); },
    mkdirSync() {},
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { if (!files.delete(file)) throw missing(); },
  };
  const status = runtimeClockStatus({ fs, bootPath: '/clock/boot', uptimePath: '/clock/uptime', markerPath: '/clock/marker',
    rejectionPath: '/clock/rejection', fallbackPath: '/clock/rejection-fallback', now: 1800000000000 });
  assert.deepEqual(status, { trusted: true, reason: 'trusted' });
  assert.equal(files.has('/clock/rejection'), false);
  assert.equal(files.has('/clock/rejection-fallback'), false);
});
