#!/usr/bin/env node
'use strict';
// Census source (c) generator: boots one historical release's own flows and
// boot node headlessly (T1 oracle style) and drives that release's own writers
// through its HTTP routes and MQTT uplinks, so the tables the aged fixtures
// leave empty (irrigation_events, watermark_readings, valve actuation
// expectations/runs, valve and irrigation schedules, journal records) get rows
// written by the release itself. Example identifiers only. Prints counts and
// per-step statuses; never a row value.
//
// Usage: node edge/harness/census/generate.js --ref <git-ref> --label <name> \
//          --census-out <file.json> --work <dir> [--keep] [--skip-archive]
// Requires: scripts/fixtures/release-smoke node_modules installed for the
// pinned oracle Node (OSI_CENSUS_ORACLE_NODE, default 20.18.3).
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']);
  return a;
}, []));
(async () => {
const HARNESS = process.env.OSI_CENSUS_HARNESS_ROOT || path.resolve(__dirname, '../../..');
const ORACLE_NODE = process.env.OSI_CENSUS_ORACLE_NODE
  || path.join(process.env.HOME || '', '.local/node-v20.18.3-linux-x64/bin/node');
const REF = args.ref, LABEL = args.label, OUT = path.resolve(args['census-out']), WORK = path.resolve(args.work);
if (!REF || !LABEL || !OUT || !WORK) { console.error('usage: generate.js --ref R --label L --census-out F --work D'); process.exit(2); }
for (const p of [OUT, WORK]) fs.mkdirSync(path.dirname(p), { recursive: true });
const TREE = path.join(WORK, 'tree'), RUN = path.join(WORK, 'run');
const FLOWS_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const VALVE = 'A840410000000001', SENSOR = 'A840410000000002', WMEUI = 'A840410000000003';
const APP_SENSORS = 'synthetic-sensors-app', APP_ACTUATORS = 'synthetic-actuators-app';
const steps = [];
const step = async (id, fn) => {
  try { const detail = await fn(); steps.push({ id, ok: true, detail: detail ?? null }); }
  catch (e) { steps.push({ id, ok: false, error: String(e && e.message || e).slice(0, 300) }); }
};

function sh(cmd, cmdArgs, opts) { return execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts }); }
function request(port, method, p, body, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const h = { ...headers };
    if (data !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout ' + method + ' ' + p)));
    req.on('error', reject); req.end(data);
  });
}

// ---------- materialize tag tree + seed + oracle ----------
if (!args['skip-archive'] || !fs.existsSync(TREE)) {
  fs.mkdirSync(TREE, { recursive: true });
  sh('bash', ['-c', `git -C ${JSON.stringify(HARNESS)} archive ${REF} | tar -x -C ${JSON.stringify(TREE)}`]);
}
fs.mkdirSync(path.join(RUN, 'data/db'), { recursive: true });
const DBFILE = path.join(RUN, 'data/db/farming.db');
fs.writeFileSync(DBFILE, require('node:child_process').execFileSync('git',
  ['-C', HARNESS, 'cat-file', 'blob', `${REF}:database/farming.db`], { maxBuffer: 256 * 1024 * 1024 }));
const flowsOfTree = JSON.parse(fs.readFileSync(path.join(TREE, FLOWS_REL), 'utf8'));
const httpRoutes = flowsOfTree.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url);
const hasRoute = (m, u) => httpRoutes.includes(m + ' ' + u);

const ready = path.join(RUN, 'oracle-ready.json');
const logFd = fs.openSync(path.join(WORK, 'oracle.log'), 'w');
const oracle = spawn(ORACLE_NODE, ['--max-old-space-size=1536', path.join(HARNESS, 'edge/harness/oracle-node-red.js')], {
  cwd: HARNESS, stdio: ['ignore', logFd, logFd],
  env: {
    PATH: process.env.PATH, HOME: RUN, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: RUN, UV_THREADPOOL_SIZE: '4',
    OSI_SMOKE_RUNTIME: 'image', OSI_SMOKE_RUN: RUN, OSI_SMOKE_SOURCE: TREE, OSI_ORACLE_READY_FILE: ready,
    OSI_ORACLE_SCOPED: '0', OSI_HARNESS_CLOUD: '0', OSI_HARNESS_PODMAN_HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DEVICE_EUI_CONFIDENCE: 'authoritative', DEVICE_EUI_SOURCE: 'uci', JWT_SECRET: 'synthetic-smoke-secret',
    FIRMWARE_VERSION: LABEL, FIRMWARE_COMMIT: REF,
  },
});
const info = await new Promise((resolve, reject) => {
  const end = Date.now() + 180000;
  const t = setInterval(() => {
    if (fs.existsSync(ready)) { clearInterval(t); resolve(JSON.parse(fs.readFileSync(ready, 'utf8'))); }
    else if (oracle.exitCode !== null) { clearInterval(t); reject(new Error('oracle exited ' + oracle.exitCode)); }
    else if (Date.now() > end) { clearInterval(t); reject(new Error('oracle not ready in 180 s')); }
  }, 150);
}).catch((e) => { console.error('ORACLE BOOT FAILED for ' + REF + ': ' + e.message); sh('bash', ['-c', `tail -40 ${JSON.stringify(path.join(WORK, 'oracle.log'))}`]); process.exit(3); });
console.log(`oracle up: node=${info.nodeVersion} sqlite=${info.sqliteVersion} http=${info.http}`);
const api = { http: info.http, control: info.control, mqtt: info.mqtt };
let token = null;
const hreq = async (method, p, body, tok = token) => {
  const r = await request(api.http, method, p, body, tok ? { authorization: 'Bearer ' + tok } : {});
  let json; try { json = JSON.parse(r.text); } catch { json = null; }
  return { status: r.status, json };
};
const ctl = async (p, body) => {
  const r = await request(api.control, body === undefined ? 'GET' : 'POST', p, body, {}, 60000);
  const j = JSON.parse(r.text || 'null');
  if (r.status !== 200) throw new Error('control ' + p + ': ' + r.text.slice(0, 200));
  return j;
};
const fixtureRequire = Module.createRequire(path.join(HARNESS, 'scripts/fixtures/release-smoke/package.json'));
const mqtt = fixtureRequire('mqtt');
// The oracle seeds CHIRPSTACK_PROFILE_* from the standin's fixed synthetic
// profile ids; uplinks carry the matching deviceProfileId so every tag's
// profile discrimination (id-first, name fallback) accepts them.
const PROFILE_ENV = require(path.join(HARNESS, 'edge/harness/chirpstack-standin')).ENV;
const profileIdFor = (eui) => eui === VALVE ? PROFILE_ENV.CHIRPSTACK_PROFILE_STREGA
  : eui === WMEUI ? PROFILE_ENV.CHIRPSTACK_PROFILE_LSN50 : PROFILE_ENV.CHIRPSTACK_PROFILE_KIWI;
const client = mqtt.connect('mqtt://127.0.0.1:' + api.mqtt, { clientId: 'census-gen-' + LABEL, clean: true });
await new Promise((res, rej) => { client.once('connect', res); client.once('error', rej); });
let fcnt = 100, dedup = 0;
async function publish(app, eui, fPort, object, dataB64) {
  const payload = {
    deduplicationId: crypto.randomUUID(), time: new Date().toISOString(), fCnt: ++fcnt, fPort,
    deviceInfo: { devEui: eui.toLowerCase(), deviceProfileId: profileIdFor(eui),
      deviceProfileName: eui === VALVE ? 'OSI STREGA Valve' : (eui === WMEUI ? 'OSI LSN50' : 'OSI KIWI Sensor'), applicationId: app },
    ...(dataB64 !== undefined ? { data: dataB64 } : {}),
    ...(object !== null ? { object } : {}),
  };
  await new Promise((res, rej) => client.publish(`application/${app}/device/${eui.toLowerCase()}/event/up`,
    JSON.stringify(payload), { qos: 1 }, (e) => (e ? rej(e) : res())));
  await new Promise((r) => setTimeout(r, 250));
  await ctl('/settle', {});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbWrite = (sql) => sh('sqlite3', ['-bail', DBFILE], { input: sql.join(';\n') + ';\n' });
const dbCount = (table) => Number(sh('sqlite3', [DBFILE, `SELECT COUNT(*) FROM ${table}`]).trim());

// LSN50 WATERMARK profile-3 frame (osi-watermark-helper/conversion.js layout).
function wmFrame(rTarget, supplyMv, soilTempC) {
  const b = Buffer.alloc(27);
  b[0] = 0xA2; b[1] = 3;
  b.writeUInt16BE(supplyMv, 2);
  b.writeInt16BE(Math.round(soilTempC * 100), 4);
  b.writeInt16BE(Math.round((soilTempC + 3) * 100), 6);
  b[8] = 0x02;
  const cal = { pullup: 47000, pulldown: 47000, series: 0 };
  for (const probe of [9, 18]) {
    b[probe] = 0x00;
    const xf = Math.round(4095 * rTarget / (rTarget + cal.pullup));
    const xr = Math.round(4095 * cal.pulldown / (cal.pulldown + rTarget));
    b.writeUInt16BE(Math.max(1, xf - 4), probe + 1); b.writeUInt16BE(xf, probe + 3);
    b.writeUInt16BE(Math.min(4094, xr + 4), probe + 5); b.writeUInt16BE(xr, probe + 7);
  }
  return b.toString('base64');
}

// ---------- drive that release's own writers ----------
await step('auth', async () => {
  const reg = await hreq('POST', '/auth/register', { username: 'farmer', password: 'synthetic-pass-1' }, null);
  const login = await hreq('POST', '/auth/login', { username: 'farmer', password: 'synthetic-pass-1' }, null);
  if (login.status !== 200 || !login.json || !login.json.token) throw new Error('login ' + login.status);
  token = login.json.token; return { register: reg.status };
});
let zoneId = null, zoneUuid = null;
await step('zone-create', async () => {
  const tries = hasRoute('post', '/api/irrigation-zones') ? [['post', '/api/irrigation-zones', { name: 'Zone A', timezone: 'UTC' }]] : [];
  for (const [m, p, body] of tries) {
    const r = await hreq(m.toUpperCase(), p, body);
    if (r.status >= 200 && r.status < 300) break;
  }
  const listed = await hreq('GET', '/api/irrigation-zones');
  const zones = (listed.json && (listed.json.zones || listed.json)) || [];
  const z = Array.isArray(zones) && zones[0];
  if (!z) throw new Error('no zone after create (list ' + listed.status + ')');
  zoneId = z.id ?? (z.zone && z.zone.id); zoneUuid = z.zone_uuid ?? (z.zone && z.zone.zone_uuid);
  if (zoneId == null) throw new Error('zone id missing in list shape');
  return null;
});
await step('devices-setup', async () => {
  const now = new Date().toISOString();
  const cols = new Set(sh('sqlite3', [DBFILE, 'PRAGMA table_info(devices)']).trim().split('\n').map((l) => l.split('|')[1]));
  const mk = (eui, name, type, extra) => {
    const vals = { deveui: eui, name, type_id: type, user_id: 1, created_at: now, updated_at: now, claimed_at: now, irrigation_zone_id: zoneId, ...extra };
    for (const k of Object.keys(vals)) if (!cols.has(k)) { delete vals[k]; }
    const names = Object.keys(vals).join(',');
    return `INSERT INTO devices (${names}) VALUES (${Object.values(vals).map((v) => v === null ? 'NULL' : typeof v === 'number' ? v : `'${v}'`).join(',')})`;
  };
  dbWrite([
    mk(VALVE, 'Valve 1', 'STREGA_VALVE', { current_state: 'CLOSED', ...(cols.has('strega_model') ? { strega_model: 'MOTORIZED' } : {}) }),
    mk(SENSOR, 'Sensor 1', 'KIWI_SENSOR', { current_state: null }),
    mk(WMEUI, 'WM 1', 'DRAGINO_LSN50', { current_state: null }),
  ]);
  return { devices: dbCount('devices') };
});
await step('sensor-uplinks', async () => {
  const objects = [
    { watermark1_frequency: 3000, watermark2_frequency: 3600, ambient_temperature: 21.3, relative_humidity: 55, light_intensity: 1200 },
    { watermark1_frequency: 1200, watermark2_frequency: 5100, ambient_temperature: 18.25, relative_humidity: 61, light_intensity: 940 },
    { watermark1_frequency: 2400, watermark2_frequency: 2400, ambient_temperature: 22, relative_humidity: 48, light_intensity: 1500 },
  ];
  for (const object of objects) await publish(APP_SENSORS, SENSOR, 2, object);
  return { device_data: dbCount('device_data') };
});
await step('watermark-calibration', async () => {
  if (!hasRoute('put', '/api/devices/:deveui/watermark/calibration')) return 'route absent';
  const cal = {};
  for (const n of [1, 2]) for (const k of ['pullup', 'pulldown']) cal[`${k}_${n}_ohm`] = 47000;
  for (const n of [1, 2]) for (const k of ['series_fwd', 'series_rev']) cal[`${k}_${n}_ohm`] = 0;
  cal.expected_sync_version = 0;
  const r = await hreq('PUT', `/api/devices/${WMEUI}/watermark/calibration`, cal);
  return { status: r.status, json: r.json && JSON.stringify(r.json).slice(0, 160) };
});
await step('watermark-uplinks', async () => {
  if (!flowsOfTree.some((n) => n.id === 'watermark-ingest-fn')) return 'watermark ingest absent';
  for (const [r, t] of [[3000, 22], [12000, 19.5], [40000, 26]]) await publish(APP_SENSORS, WMEUI, 11, null, wmFrame(r, 3300, t));
  await sleep(500); await ctl('/settle', {});
  return { watermark_readings: dbCount('watermark_readings') };
});
const valveRoute = hasRoute('post', '/api/valve/:deveui') ? '/api/valve/' : (hasRoute('post', '/api/valves/:deveui') ? '/api/valves/' : null);
await step('valve-open', async () => {
  if (!valveRoute) throw new Error('no valve command route in ' + LABEL);
  const r = await hreq('POST', valveRoute + VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: 2 });
  if (r.status !== 202 && r.status !== 200) throw new Error('open ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
  await sleep(400); await ctl('/settle', {});
  return null;
});
await step('valve-reports', async () => {
  await publish(APP_ACTUATORS, VALVE, 4, { Valve: '1', Battery: 90, Temperature: 21, Hygrometry: 40 });
  await publish(APP_ACTUATORS, VALVE, 4, { Valve: '0', Battery: 89, Temperature: 21, Hygrometry: 41 });
  return null;
});
await step('valve-second-open-cancel-close', async () => {
  const r2 = await hreq('POST', valveRoute + VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: 3 });
  const cancelRoute = hasRoute('post', '/api/valve/:deveui/cancel') ? '/api/valve/' : '/api/v1/valves/';
  const c = await hreq('POST', cancelRoute + VALVE + '/cancel', {});
  const cl = await hreq('POST', valveRoute + VALVE, { action: 'CLOSE' });
  return { second: r2.status, cancel: c.status, close: cl.status };
});
const findInject = (pred) => flowsOfTree.find((n) => n.type === 'inject' && pred(n));
const timerId = (kind) => {
  const byName = {
    valveOnce: (n) => /One-time opens/i.test(n.name || ''),
    valveClock: (n) => /Valve tick/i.test(n.name || ''),
  }[kind];
  return (byName && (findInject(byName) || {}).id) || null;
};
// Injects on enabled tabs that can reach the irrigation-events writer. The
// obvious scheduler inject can sit on a disabled "Simulations" tab, so the
// wiring is walked backwards from the writer instead of trusting names.
function schedulerInjectIds() {
  const byId = new Map(flowsOfTree.map((n) => [n.id, n]));
  const disabledTabs = new Set(flowsOfTree.filter((n) => n.type === 'tab' && n.disabled).map((n) => n.id));
  const writer = flowsOfTree.find((n) => n.type === 'function' && /INSERT INTO irrigation_events/.test(n.func || ''));
  if (!writer) return [];
  const seen = new Set([writer.id]);
  const queue = [writer.id];
  const injects = [];
  while (queue.length) {
    const node = byId.get(queue.shift());
    for (const candidate of flowsOfTree) {
      if (seen.has(candidate.id)) continue;
      const reaches = (candidate.wires || []).some((w) => w.includes(node.id))
        || (candidate.type === 'link out' && (candidate.links || []).includes(node.id));
      if (reaches) {
        seen.add(candidate.id);
        queue.push(candidate.id);
        if (candidate.type === 'inject' && !disabledTabs.has(candidate.z)) injects.push(candidate.id);
      }
    }
  }
  return injects;
}
await step('valve-ticks', async () => {
  const out = {};
  for (const k of ['valveOnce', 'valveClock']) {
    const id = timerId(k);
    if (id) { await ctl('/inject', { id }); out[k] = 'fired'; } else out[k] = 'absent';
  }
  await ctl('/settle', {}); return out;
});
await step('irrigation-schedule-save', async () => {
  if (!hasRoute('put', '/api/irrigation-zones/:id/schedule')) return 'route absent';
  const r = await hreq('PUT', `/api/irrigation-zones/${zoneId}/schedule`, { trigger_metric: 'SWT_WM1', threshold_kpa: 30, duration_minutes: 15, enabled: true });
  if (r.status >= 300) throw new Error('schedule save ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
  return { irrigation_schedules: dbCount('irrigation_schedules') };
});
await step('scheduler-tick', async () => {
  await publish(APP_SENSORS, SENSOR, 2, { watermark1_frequency: 1200, watermark2_frequency: 1300, ambient_temperature: 20.1, relative_humidity: 50, light_intensity: 1000 });
  const ids = schedulerInjectIds();
  if (!ids.length) return 'scheduler inject absent';
  for (const id of ids) await ctl('/inject', { id });
  await ctl('/settle', {});
  return { fired: ids.length, irrigation_events: dbCount('irrigation_events') };
});
await step('valve-schedule-save', async () => {
  if (!hasRoute('post', '/api/valves/:deveui/schedules')) return 'route absent';
  const weekly = { kind: 'WEEKLY', weekdays_mask: 127, start_time: '06:00', duration_minutes: 20, timezone: 'UTC', enabled: true };
  const r = await hreq('POST', `/api/valves/${VALVE}/schedules`, weekly);
  if (r.status >= 300) throw new Error('weekly save ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
  const clock = timerId('valveClock');
  if (clock) { await ctl('/inject', { id: clock }); await ctl('/settle', {}); }
  return { valve_schedules: dbCount('valve_schedules') };
});
await step('journal-writes', async () => {
  if (!hasRoute('post', '/api/journal/plots')) return 'journal routes absent';
  const out = {};
  const brief = (r) => r.status + (r.json ? ' ' + JSON.stringify(r.json).slice(0, 140) : '');
  const plotUuid = crypto.randomUUID();
  let r = await hreq('POST', '/api/journal/plots', { plot_uuid: plotUuid, plot_code: 'PLOT-A', name: 'Plot A', layout_code: 'open_field', base_sync_version: 0, zone_uuid: zoneUuid ?? undefined });
  out.plots = brief(r);
  if (hasRoute('post', '/api/journal/plot-groups')) {
    r = await hreq('POST', '/api/journal/plot-groups', { group_uuid: crypto.randomUUID(), label: 'Group A', resolved: false, members: [plotUuid], base_sync_version: 0 });
    out.plotGroups = brief(r);
  }
  if (hasRoute('post', '/api/journal/entries')) {
    r = await hreq('POST', '/api/journal/entries', { status: 'draft', plot_uuid: plotUuid, entry_uuid: crypto.randomUUID(), activity_code: 'irrigation', template_code: 'farmer_quick', template_version: 1, layout_code: 'open_field', layout_version: 1, occurred_timezone: 'UTC', occurred_start_local: '2026-11-23T10:00', note: 'synthetic census entry', values: [{ attribute_code: 'attr.irrigation_depth', group_index: 0, value: 12, unit_code: 'unit.mm_water', value_status: 'observed' }] });
    out.entryDraft = brief(r);
    try {
      const logs = await ctl('/logs');
      const rel = logs.filter((l) => /journal/i.test(JSON.stringify(l))).slice(-3);
      if (rel.length) out.entryLogs = rel.map((l) => l.msg).join(' || ').slice(0, 300);
    } catch { /* logs optional */ }
  }
  return out;
});
await step('settle-stop', async () => {
  await ctl('/settle', {}); await sleep(500);
  return null;
});

client.end(true);
try { await ctl('/stop', {}); } catch { /* may race exit */ }
await new Promise((r) => oracle.exitCode !== null || oracle.signalCode !== null ? r() : oracle.once('exit', r));
fs.writeFileSync(path.join(WORK, 'steps.json'), JSON.stringify({ ref: REF, label: LABEL, steps }, null, 1));

// ---------- census ----------
const census = sh(process.env.OSI_CENSUS_SYSTEM_NODE || process.execPath,
  [path.join(HARNESS, 'edge/harness/typeof-census.js'), DBFILE, '--json']);
fs.writeFileSync(OUT, census);
const parsed = JSON.parse(census);
const nonEmpty = Object.entries(parsed).filter(([, v]) => v.rows > 0).map(([t, v]) => t + ':' + v.rows);
console.log(`GENERATED ${LABEL} (${REF})`);
console.log('steps: ' + steps.map((s) => s.id + '=' + (s.ok ? 'ok' : 'FAIL:' + s.error).slice(0, 90)).join(' | '));
console.log('non-empty tables (' + nonEmpty.length + '): ' + nonEmpty.join(', '));
process.exit(0);
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
