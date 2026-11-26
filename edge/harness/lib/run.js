'use strict';
// Executes one scenario against a started backend and returns the raw
// cassette steps. Raw values are kept; normalisation happens at compare time.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { request } = require('./backend');
const { snapshot, diff, jsonable } = require('./snapshot');
const fixtureRequire = Module.createRequire(path.resolve(__dirname, '../../../scripts/fixtures/release-smoke/package.json'));

const CONTRACT_HEADERS = ['content-type', 'content-disposition', 'location', 'cache-control',
  'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials'];

const GUI_HEADERS = ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified',
  'content-security-policy', 'x-content-type-options', 'x-powered-by'];

function pick(obj, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

// Scenario date tokens, expanded against the run's anchor instant so a
// scenario means "today"/"tomorrow" whichever day it runs:
//   {{date:+N}} / {{date:-N}}     YYYY-MM-DD in UTC, N days from the anchor day
//   {{date:+N:/}}                 same, slash-separated (legacy "YYYY/MM/DD"
//                                 stamp fixtures keep their textual form)
//   {{datetime:+Nh}} / {{datetime:+Nd}}   ISO with milliseconds, Z
//   {{epochms:+Nd}}               epoch milliseconds as a string
// The anchor is the run's start instant, or OSI_T1_ANCHOR_DAY (UTC midnight
// of that day) when set for a faked-anchor replay.
const TOKEN = /\{\{(date|datetime|epochms):([+-]\d+)(d|h)?(:\/)?\}\}/g;
const TOKEN_LIKE = /\{\{\s*(date|datetime|epochms)\s*:/i;
const DAY_MS = 86400000;
const utcDay = (ms) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

function makeExpander(anchorMs) {
  return function expand(s) {
    if (typeof s !== 'string' || !TOKEN_LIKE.test(s)) return s;
    const out = s.replace(TOKEN, (whole, kind, n, unit, slashSep) => {
      const k = Number(n);
      const at = unit === 'h' ? anchorMs + k * 3600000 : anchorMs + k * DAY_MS;
      if (kind === 'date') return utcDay(at).replace(/-/g, slashSep ? '/' : '-');
      if (kind === 'epochms') return String(Math.round(at));
      return new Date(at).toISOString();
    });
    if (TOKEN_LIKE.test(out)) throw new Error('unexpandable date token in: ' + s);
    return out;
  };
}

function expandDeep(v, expand) {
  if (typeof v === 'string') return expand(v);
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, expand));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = expandDeep(v[k], expand);
    return o;
  }
  return v;
}

// Expand every sent string of a step (http path, headers, body in all raw
// forms, sql, uplink topic/payload). auth is a captured-variable reference,
// not sent content, and is left alone.
function expandStep(step, expand) {
  const s = { ...step };
  if (s.http) {
    s.http = { ...s.http };
    if (s.http.path !== undefined) s.http.path = expand(s.http.path);
    if (s.http.headers !== undefined) s.http.headers = expandDeep(s.http.headers, expand);
    if (s.http.body !== undefined) s.http.body = expandDeep(s.http.body, expand);
    if (s.http.rawBody !== undefined) s.http.rawBody = expand(s.http.rawBody);
    if (s.http.rawBodyBase64 !== undefined) {
      s.http.rawBodyBase64 = Buffer.from(expand(Buffer.from(s.http.rawBodyBase64, 'base64').toString('utf8')), 'utf8').toString('base64');
    }
    if (s.http.rawBodyGzipJson !== undefined) s.http.rawBodyGzipJson = expandDeep(s.http.rawBodyGzipJson, expand);
  }
  if (s.sql !== undefined) s.sql = expand(s.sql);
  for (const key of ['uplink', 'uplinks']) {
    if (!s[key]) continue;
    const one = (u) => expandDeep(u, expand);
    s[key] = Array.isArray(s[key]) ? s[key].map(one) : one(s[key]);
  }
  return s;
}

async function mqttClient(port) {
  const mqtt = fixtureRequire('mqtt');
  const c = mqtt.connect('mqtt://127.0.0.1:' + port, { clientId: 't1-recorder', clean: true });
  await new Promise((res, rej) => { c.once('connect', res); c.once('error', rej); });
  return c;
}

// The sent strings of a step, for keeping the pre-expansion template beside
// the expanded request recorded in the cassette.
function sentParts(st) {
  const h = st.http;
  if (h) {
    const body = h.body !== undefined ? h.body : h.rawBody !== undefined ? { rawBody: h.rawBody }
      : h.rawBodyBase64 !== undefined ? { rawBodyBase64: h.rawBodyBase64 } : { rawBodyGzipJson: h.rawBodyGzipJson };
    return { path: h.path, ...(h.headers !== undefined && { headers: h.headers }), body };
  }
  if (st.sql !== undefined) return { sql: st.sql };
  if (st.uplink) return { topic: st.uplink.topic, payload: st.uplink.payload };
  if (st.uplinks) return { uplinks: st.uplinks.map((u) => ({ topic: u.topic, payload: u.payload })) };
  return null;
}

async function runScenario(backend, scenario, { onStep, cloudSeen = 0, anchorMs = Date.now() } = {}) {
  const vars = {};
  const steps = [];
  const expand = makeExpander(anchorMs);
  let snap = snapshot(backend.db);
  let radioSeen = (await backend.control.radio()).length;
  let mqttSeen = (await backend.control.mqtt()).length;
  let client = null;
  async function publish(u) {
    client = client || await mqttClient(backend.mqtt);
    const payload = typeof u.payload === 'string' ? u.payload : JSON.stringify(u.payload);
    await new Promise((res, rej) => client.publish(u.topic, payload, { qos: 1 }, (e) => e ? rej(e) : res()));
  }
  try {
    for (const rawStep of scenario.steps) {
      const step = expandStep(rawStep, expand);
      const rec = { id: step.id, kind: null, cloud: [] };
      if (step.anchorTimeZone) rec.anchorTimeZone = step.anchorTimeZone;
      try {
      if (step.http) {
        rec.kind = 'http';
        const s = step.http, headers = { ...(s.headers || {}) };
        if (s.auth && s.auth !== 'none') headers.authorization = s.auth.startsWith('Bearer ') ? s.auth : 'Bearer ' + (vars[s.auth] ?? 'missing-' + s.auth);
        const body = s.rawBodyBase64 !== undefined ? Buffer.from(s.rawBodyBase64, 'base64')
          : s.rawBodyGzipJson !== undefined ? require('node:zlib').gzipSync(Buffer.from(JSON.stringify(s.rawBodyGzipJson)))
          : s.rawBody !== undefined ? s.rawBody : s.body;
        const r = await request(backend.http, s.method, s.path, body, headers, s.timeout || 15000);
        const text = r.raw.toString('utf8');
        const gui = /^\/gui(?:[/?]|$)/i.test(s.path);
        const selectedHeaders = gui ? [...CONTRACT_HEADERS, ...GUI_HEADERS] : CONTRACT_HEADERS;
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        rec.request = { method: s.method, path: s.path, body: body === undefined ? null : Buffer.isBuffer(body) ? { base64: body.toString('base64') } : body, auth: s.auth || 'none' };
        rec.response = { status: r.status, headers: Object.fromEntries(selectedHeaders.filter((h) => r.headers[h] !== undefined).map((h) => [h, r.headers[h]])),
          json: gui || json === undefined ? null : json, text: gui ? r.raw.toString('base64') : json === undefined ? text : null, bomUtf8: r.raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) };
        for (const [name, p] of Object.entries(step.capture || {})) vars[name] = pick({ json }, p);
        // Writes may finish after the response; attribute them to this step.
        await backend.control.settle();
      } else if (step.uplink) {
        rec.kind = 'uplink';
        const u = step.uplink;
        if (step.cloudHoldPuback) await backend.control.cloud('hold-puback');
        await publish(u);
        rec.request = { topic: u.topic };
        await new Promise((r) => setTimeout(r, step.waitMs ?? 150));
        await backend.control.settle();
        if (step.cloudHoldPuback) await backend.control.cloud('puback-held');
      } else if (step.uplinks) {
        rec.kind = 'uplinks';
        for (const u of step.uplinks) {
          await publish(u);
          if (step.gapMs) await new Promise((r) => setTimeout(r, step.gapMs));
        }
        rec.request = { uplinks: step.uplinks.length };
        await new Promise((r) => setTimeout(r, 500));
        await backend.control.settle();
      } else if (step.cloudBroker === 'restart') {
        rec.kind = 'cloudBroker';
        const outage = step.outageUplinks || [];
        rec.request = { cloudBroker: 'restart', outageUplinks: outage.length };
        await backend.control.cloud('stop');
        try {
          for (const u of outage) await publish(u);
          await new Promise((r) => setTimeout(r, 500));
          await backend.control.settle();
        } finally { await backend.control.cloud('start'); }
      } else if (step.cloudRecovery === 'block' || step.cloudRecovery === 'unblock') {
        rec.kind = 'cloudRecovery';
        rec.request = { cloudRecovery: step.cloudRecovery };
        const journal = path.join(path.dirname(backend.db), 'osi-account-link-config.json');
        if (step.cloudRecovery === 'block') fs.writeFileSync(journal, '{}', { flag: 'wx' });
        else fs.unlinkSync(journal);
      } else if (step.timer) {
        rec.kind = 'timer'; rec.request = { timer: step.timer };
        await backend.control.timer(step.timer);
        await backend.control.settle();
      } else if (step.sql) {
        rec.kind = 'sql'; rec.request = { sql: step.sql };
        const db = new DatabaseSync(backend.db);
        try { db.exec('PRAGMA busy_timeout=5000'); db.exec(step.sql); } finally { db.close(); }
      } else if (step.waitMs) {
        rec.kind = 'wait'; await new Promise((r) => setTimeout(r, step.waitMs));
      } else throw new Error('unknown step ' + JSON.stringify(step));
      } catch (error) {
        // A backend that lacks a route, hook or timer fails this step, not the run.
        if (/unknown step/.test(String(error && error.message))) throw error;
        rec.error = String(error && error.message || error).slice(0, 500);
      }
      // The cassette records the expanded request (as sent today) and keeps
      // the scenario's token template beside it.
      const template = sentParts(rawStep);
      if (rec.request && template && JSON.stringify(template) !== JSON.stringify(sentParts(step))) rec.template = template;
      const next = snapshot(backend.db);
      rec.db = jsonable(diff(snap, next));
      snap = next;
      const radio = await backend.control.radio(); rec.radio = radio.slice(radioSeen); radioSeen = radio.length;
      const mq = await backend.control.mqtt(); rec.mqtt = mq.slice(mqttSeen).filter((m) => m.topic !== undefined && !String(m.topic).startsWith('$SYS')); mqttSeen = mq.length;
      if (backend.control.cloud) {
        const cloud = await backend.control.cloud();
        rec.cloud = cloud.slice(cloudSeen);
        cloudSeen = cloud.length;
      }
      steps.push(rec);
      if (onStep) onStep(rec);
    }
  } finally { if (client) client.end(true); }
  return { steps, finalSchema: jsonable(snap.schema), cloudSeen };
}
module.exports = { runScenario, CONTRACT_HEADERS };
