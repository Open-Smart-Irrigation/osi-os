'use strict';
// Effects of one mutant run and the tier-B verdict (CHARTER.md §1.4 point 3).
// An effect is anything Go must never do more of than Node-RED: a database
// row added, removed or changed (accounts, sessions, grants and roles are
// rows), a radio call (gRPC enqueue or flush), a local MQTT publication
// (command/down), a cloud MQTT publish, a token in a response, a file under
// the data root. Effects are compared as multisets with every per-run
// identity removed (placeholder numbering, rowid, integer id), so a run that
// writes a subset of the other's rows never shows up as "more".
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { view } = require('./compare');
const { make } = require('./normalize');

const UPLINK_TOPIC = /^application\/[^/]+\/device\/[^/]+\/event\/up$/;

function denumber(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v).replace(/<(uuid|hex32)#\d+>/g, '<$1>'));
}
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function stripIds(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== '__rowid' && !(k === 'id' && typeof v === 'number')) out[k] = v;
  return out;
}
const tokenCount = (body) => (JSON.stringify(body === undefined ? null : body).match(/<token>/g) || []).length;

// A Gen1 FPort 12 clock frame is one byte per local clock digit
// (HHMMSS0wDDMMYY), so the oracle and the backend, run seconds apart, encode
// different times. The pass compares that a clock frame went out, not its
// time; the cassette comparator checks the offset (normalize.js clockPayload).
const CLOCK_FRAME = /^(0[0-9]){14}$/i;
const clockCall = (r) => (r && Number(r.port) === 12 && CLOCK_FRAME.test(String(r.hex || '')) ? { ...r, hex: '<gen1-clock-frame>' } : r);
const clockRow = (table, row) => (table === 'valve_schedule_pushes' && row && Number(row.fport) === 12 && CLOCK_FRAME.test(String(row.payload_hex || ''))
  ? { ...row, payload_hex: '<gen1-clock-frame>' } : row);

// Ages a backend computes against its own wall clock, from a stamp that the
// snapshot froze: the oracle and the backend run the same steps minutes
// apart, so `analytics_age_hours` (osi-daily-scheduler decision.js, rounded
// to 0.1 h) reads 48 on one side and 48.1 on the other. The pass compares
// that a finite age was written, not its value; a decision the age changes
// (stale past 36 h) still differs in action and reason. null stays null.
const WALL_CLOCK_AGES = new Set(['analytics_age_hours']);
function wallClockAges(v) {
  if (Array.isArray(v)) return v.map(wallClockAges);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = WALL_CLOCK_AGES.has(k) && typeof x === 'number' && Number.isFinite(x) ? '<wall-clock-age>' : wallClockAges(x);
  return out;
}

// records: raw run.js step records of one run; files: fileDiff() output.
function effectsOf(records, files = []) {
  const n = make();
  const items = [];
  for (const rec of records) {
    const v = view(rec, n);
    const at = rec.id;
    for (const [table, d] of Object.entries(v.db || {})) {
      for (const row of d.added) items.push({ at, k: 'db.add', table, row: clockRow(table, stripIds(row)) });
      for (const row of d.removed) items.push({ at, k: 'db.del', table, row: clockRow(table, stripIds(row)) });
      // One effect per changed column: a backend that changes a subset of
      // the oracle's columns did less, not more.
      for (const row of d.changed) for (const [col, ch] of Object.entries(stripIds(row.cols))) items.push({ at, k: 'db.chg', table, col, from: ch.from, to: ch.to });
    }
    for (const r of v.radio || []) items.push({ at, k: 'radio', call: clockCall(r) });
    for (const m of v.mqtt || []) if (!UPLINK_TOPIC.test(String(m.topic))) items.push({ at, k: 'mqtt', topic: m.topic, payload: m.payload });
    const cloudPackets = Array.isArray(v.cloud) ? v.cloud : [...(v.cloud?.client || []), ...(v.cloud?.broker || [])];
    for (const p of cloudPackets) {
      if (p.cmd === 'publish' && p.direction === 'client') items.push({ at, k: 'cloud.publish', topic: p.topic, qos: p.qos, payload: p.payload });
    }
    for (let i = tokenCount(v.body); i > 0; i--) items.push({ at, k: 'token' });
  }
  for (const f of files) items.push({ at: 'files', k: 'file', op: f.op, path: f.path });
  return items.map(wallClockAges).map((it) => ({ ...denumber(it), key: stable(denumber({ ...it, at: undefined })) }));
}

// Multiset a − b on the identity-free key.
function minus(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x.key, (counts.get(x.key) || 0) + 1);
  const out = [];
  for (const x of a) { const c = counts.get(x.key) || 0; if (c > 0) counts.set(x.key, c - 1); else out.push(x); }
  return out;
}

function responsesOf(records) {
  const n = make();
  return records.filter((r) => r.kind === 'http').map((r) => { const v = view(r, n); return { at: r.id, status: v.status, body: denumber(v.body) }; });
}

// side: { records, files, errors: [string], timeouts: [id], unregistered: [name] }
function verdict(oracle, go, control) {
  const errors = [...oracle.errors.map((e) => 'oracle: ' + e), ...go.errors.map((e) => 'go: ' + e)];
  const eo = effectsOf(oracle.records, oracle.files), eg = effectsOf(go.records, go.files);
  const more = minus(eg, eo), lessAll = minus(eo, eg);
  // Effects of oracle ticks that the backend does not register at all are
  // reported apart: they are unported timers, not a reaction to the input.
  const unported = new Set(go.unregistered || []);
  const fromUnported = (x) => /^tick\d+:/.test(x.at) && unported.has(x.at.replace(/^tick\d+:/, ''));
  const less = lessAll.filter((x) => !fromUnported(x)), lessUnported = lessAll.filter(fromUnported);
  const ro = responsesOf(oracle.records), rg = responsesOf(go.records);
  const responseDiffs = [];
  for (let i = 0; i < Math.max(ro.length, rg.length); i++) {
    if (stable(ro[i]) !== stable(rg[i])) responseDiffs.push({ at: (ro[i] || rg[i]).at, oracle: ro[i] && { status: ro[i].status, body: ro[i].body }, go: rg[i] && { status: rg[i].status, body: rg[i].body } });
  }
  let result = errors.length ? 'ERROR' : more.length ? 'TIER-B-FAIL' : (responseDiffs.length || less.length || oracle.timeouts.length || go.timeouts.length) ? 'LOGGED' : 'OK';
  // Attribution: extra effects the unmutated control run also produced from
  // the same snapshot belong to the base scenario, not to the mutation.
  let attributable;
  if (control && result === 'TIER-B-FAIL') attributable = minus(more, control.moreKeys || []).length > 0;
  return { verdict: result, errors, more: more.map(({ key, ...x }) => x), less: less.map(({ key, ...x }) => x), moreKeys: more,
    lessUnported: lessUnported.map(({ key, ...x }) => x),
    responseDiffs, timeouts: { oracle: oracle.timeouts, go: go.timeouts }, attributable,
    effectCounts: { oracle: eo.length, go: eg.length } };
}

// Files under the data root that a backend writes (holds, backups, journals);
// the live database and its sidecars are compared as rows instead.
const FILE_DIRS = ['data', 'srv', 'var'];
const SKIP = /^data\/db\/farming\.db(-wal|-shm|-journal)?$/;
function fileSnapshot(root) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let st; try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) walk(rel ? rel + '/' + e : e); return; }
    if (SKIP.test(rel)) return;
    out[rel] = st.isSymbolicLink() ? 'link:' + fs.readlinkSync(abs) : crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  };
  for (const d of FILE_DIRS) walk(d);
  return out;
}
function fileDiff(before, after) {
  const out = [];
  for (const [p, h] of Object.entries(after)) {
    if (!(p in before)) out.push({ op: 'add', path: p });
    else if (before[p] !== h) out.push({ op: 'change', path: p });
  }
  for (const p of Object.keys(before)) if (!(p in after)) out.push({ op: 'del', path: p });
  return out.map((f) => ({ ...f, path: f.path.replace(/\d{8,}|\d{4}-\d{2}-\d{2}T[\d:.-]+Z?/g, '<stamp>') }));
}

module.exports = { effectsOf, minus, verdict, fileSnapshot, fileDiff, stable, denumber };
