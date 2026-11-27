'use strict';
// Compares two cassettes step by step after normalisation. Each step is
// judged on: status, contract headers, body, database diff, radio calls and
// MQTT publications. A difference anywhere fails the step.
const { make, clockPayload, anchorDayOf, anchorInstantOf, localDay } = require('./normalize');
const { isDeepStrictEqual } = require('node:util');

function firstDiff(a, b, p = '$') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) return { path: p + '.' + k, expected: '<absent>', actual: b[k] };
      if (!(k in b)) return { path: p + '.' + k, expected: a[k], actual: '<absent>' };
      const d = firstDiff(a[k], b[k], p + '.' + k);
      if (d) return d;
    }
  }
  return { path: p, expected: a, actual: b };
}

// A changed column whose old and new value normalise to the same placeholder
// (for example a seconds-granularity timestamp rewritten in the same form) is
// clock noise: whether it changed depends on second boundaries. Known blind
// spot: "timestamp bumped" versus "not bumped" is not compared.
function dropVolatileChanges(db) {
  const out = {};
  for (const [table, d] of Object.entries(db || {})) {
    const changed = d.changed.map((r) => {
      const cols = {};
      for (const [c, v] of Object.entries(r.cols)) if (!isDeepStrictEqual(v.from, v.to)) cols[c] = v;
      return { ...r, cols };
    }).filter((r) => Object.keys(r.cols).length);
    if (d.added.length || d.removed.length || changed.length) out[table] = { ...d, changed };
  }
  return out;
}

// A cloud publish payload that is canonical JSON text (UTF-8 that survives the
// base64 round trip, and JSON.stringify(JSON.parse(text)) === text) is
// normalised inside like any other JSON text: same-form instants, UUIDs and
// epochs become placeholders, numbered with the rest of the cassette. The
// result is re-stringified, so key order, spacing, number spelling and every
// other byte still count. Anything else (binary, non-canonical JSON, a JSON
// scalar) stays the literal base64.
function cloudPayload(payload, n) {
  if (!n || typeof payload !== 'string') return payload;
  const raw = Buffer.from(payload, 'base64');
  if (raw.toString('base64') !== payload) return payload;
  const text = raw.toString('utf8');
  if (Buffer.from(text, 'utf8').toString('base64') !== payload) return payload;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return payload; }
  if (!parsed || typeof parsed !== 'object' || JSON.stringify(parsed) !== text) return payload;
  return '<json-payload>' + JSON.stringify(n.value(parsed));
}

function cloudView() {
  const pending = { client: new Map(), broker: new Map() };
  let next = 1;
  return (packets, n) => (packets || []).map((packet) => {
    const p = { ...packet };
    if (p.cmd === 'publish' && p.payload !== undefined) p.payload = cloudPayload(p.payload, n);
    if (p.messageId !== undefined) {
      const ack = /^(puback|pubrec|pubcomp|suback|unsuback)$/.test(p.cmd);
      const origin = ack ? (p.direction === 'client' ? 'broker' : 'client') : p.direction;
      const ids = pending[origin];
      const id = p.messageId;
      if (!ids.has(id)) ids.set(id, next++);
      p.messageId = ids.get(id);
      if (ack && p.cmd !== 'pubrec' && p.forwarded !== false) ids.delete(id);
    }
    if (p.properties?.messageExpiryInterval !== undefined) {
      p.properties = { ...p.properties, messageExpiryInterval: '<seconds>' };
    }
    return p;
  });
}

// clocks holds one side's Gen1 clock push rows from earlier steps. A radio
// frame re-sent in a later step (a queue flush restores it) is normalised
// against that backend's own latest earlier CLOCK_SYNC row for the device,
// only when the frame equals that row byte for byte, with the same 5 s bound
// against the row's intent_at. A frame equal only to an older, superseded row
// stays literal, so a backend that re-sends a stale frame cannot pass by
// matching its own older row (confirm-B2 S3).
function view(step, n, cloud = cloudView(), clocks = []) {
  const v = { kind: step.kind };
  if (step.response) {
    v.status = step.response.status;
    v.headers = n.value(step.response.headers);
    v.body = n.value(step.response.json !== null ? step.response.json : step.response.text);
    v.bomUtf8 = step.response.bomUtf8;
  }
  const pushes = step.db?.valve_schedule_pushes;
  const clockPushes = (pushes?.added || []).filter((p) => p.purpose === 'CLOCK_SYNC' && p.fport === 12);
  const db = clockPushes.length ? { ...step.db, valve_schedule_pushes: { ...pushes,
    added: pushes.added.map((p) => clockPushes.includes(p) ? { ...p, payload_hex: clockPayload(p.payload_hex, p.transport_json, p.queued_at) } : p) } } : step.db;
  v.db = dropVolatileChanges(n.value(db));
  v.radio = n.value((step.radio || []).map(({ id, ...r }) => {
    const same = (p) => p.device_eui === r.eui && p.payload_hex === r.hex;
    const latest = clocks.findLast((p) => p.device_eui === r.eui);
    const push = r.fn === 'enqueue' && r.port === 12 && (clockPushes.find(same) || (latest && same(latest) ? latest : null));
    return push ? { ...r, hex: clockPayload(r.hex, push.transport_json) } : r;
  }));
  clocks.push(...clockPushes);
  v.mqtt = n.value((step.mqtt || []).map((m) => { let p; try { p = JSON.parse(m.payload); } catch { p = m.payload; } return { topic: m.topic, payload: p }; }));
  // The broker's acknowledgements interleave with the client's publishes by
  // timing alone: the shipped Node-RED backend was recorded both waiting for
  // each PUBACK and publishing the next message first. Compare each direction's
  // packets in its own order (client publishes stay strictly ordered, and every
  // broker packet must still appear, in order), not their interleaving.
  const packets = cloud(step.cloud, n);
  v.cloud = { client: packets.filter((p) => p.direction !== 'broker'), broker: packets.filter((p) => p.direction === 'broker') };
  return v;
}

function compare(expected, actual, { ignore = [] } = {}) {
  const ne = make(anchorDayOf(expected)), na = make(anchorDayOf(actual));
  const ce = cloudView(), ca = cloudView();
  const ke = [], ka = [];
  const results = [];
  const byId = new Map(actual.steps.map((s) => [s.id, s]));
  for (const e of expected.steps) {
    const a = byId.get(e.id);
    if (!a) { results.push({ id: e.id, pass: false, failures: [{ area: 'missing-step' }] }); continue; }
    // A step marked anchorTimeZone computes "today" in that zone: each side's
    // dates are relative to its own local day there, so the result does not
    // depend on the hour of either run.
    const zone = e.anchorTimeZone || a.anchorTimeZone;
    const ve = zone ? ne.withAnchorDay(localDay(anchorInstantOf(expected), zone), () => view(e, ne, ce, ke)) : view(e, ne, ce, ke);
    const va = zone ? na.withAnchorDay(localDay(anchorInstantOf(actual), zone), () => view(a, na, ca, ka)) : view(a, na, ca, ka);
    const failures = [];
    if (a.error || e.error) failures.push({ area: 'step-error', expected: e.error || null, actual: a.error || null });
    for (const area of ['status', 'headers', 'body', 'bomUtf8', 'db', 'radio', 'mqtt', 'cloud']) {
      if (ignore.includes(area) || ignore.includes(e.id + ':' + area)) continue;
      const d = firstDiff(ve[area], va[area]);
      if (d) failures.push({ area, ...d });
    }
    const warnings = [];
    if (!failures.length && JSON.stringify(ve.body) !== JSON.stringify(va.body)) warnings.push({ area: 'body-key-order' });
    results.push({ id: e.id, pass: failures.length === 0, failures, warnings });
  }
  return { pass: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length, results };
}
module.exports = { compare, firstDiff, view, cloudPayload };
