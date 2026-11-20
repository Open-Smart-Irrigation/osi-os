'use strict';
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const { NOW } = require('./daily-scheduler-cases');
const ROOT = path.resolve(__dirname, '../..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
function normalize(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return Array.from(value, normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(k => [k, normalize(value[k])]));
  return value;
}
function dependencies(c, profile) {
  const trace = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [c.now ?? NOW])); }
    static now() { return c.now ?? NOW; }
  }
  const fail = name => { if (c.failure === name) throw new Error('synthetic ' + name); };
  const env = { get(key) { fail('env'); return ({ AUTH_TOKEN_SECRET: 'synthetic-x1-secret', OSI_SCOPED_ACCESS: '0', DEVICE_EUI: '0016C001F1000001', ...c.env })[key]; } };
  let reads = 0, writes = 0;
  const fs = {
    readFileSync(file) { trace.push(['read', file]); reads++; fail('fs-read'); if (c.failure === 'fs-empty' || (c.failure === 'fs-empty-first' && reads === 1)) return ''; if (c.failure === 'first-write') throw Object.assign(new Error('absent'), { code: 'ENOENT' }); if(c.failure === 'fs-generate' || c.failure === 'fs-write') throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return 'synthetic-x1-secret\n'; },
    writeFileSync(...args) { trace.push(['write', ...args]); writes++; if (c.failure === 'first-write' && writes === 1) throw new Error('synthetic first-write'); fail('fs-write'); },
  };
  const scope = {
    resolveAuthSecret(options) { trace.push(['resolve-secret', options.configuredSecret]); fail('scope-secret'); if (c.failure === 'scope-warning') options.warn('synthetic scope warning'); return options.configuredSecret; },
    async resolveZoneUuidById(db, id) { trace.push(['resolve-zone', id]); return c.failure === 'zone' ? null : 'synthetic-zone'; },
    async assertFreshZoneAccess(db, actor, zone, options) { trace.push(['access', actor, zone, options]); if(c.failure === 'access') throw Object.assign(new Error('synthetic access'), { statusCode: 403 }); return { role: 'owner' }; },
    canMutate(role) { trace.push(['can-mutate', role]); return c.failure !== 'role'; },
  };
  let scopeLoads = 0;
  const osiLib = { require(name) {
    trace.push(['require', name]);
    if (name === 'daily-scheduler' && ['daily-load', 'daily-quarantined'].includes(c.failure)) return { ok: false, error: 'synthetic ' + c.failure, quarantined: c.failure === 'daily-quarantined' };
    if (name === 'daily-scheduler') return { ok: true, value: require(path.join(ROOT, 'conf', profile, 'files/usr/share/node-red/osi-daily-scheduler')) };
    if (name === 'scope') return (c.failure === 'scope-load' || (c.failure === 'scope-load-second' && ++scopeLoads === 2)) ? { ok: false, error: 'synthetic scope-load' } : { ok: true, value: scope };
    if (name !== 'scheduler-mean-query') throw new Error('unexpected module ' + name);
    if (c.failure === 'mean-load') return { ok: false, error: 'synthetic mean-load' };
    return { ok: true, value: { buildSwtMeanQuery(...args) { trace.push(['mean-query', ...args]); fail('mean-build'); return require(path.join(ROOT, 'conf', profile, 'files/usr/share/node-red/osi-scheduler-mean-query')).buildSwtMeanQuery(...args); } } };
  } };
  class Database {
    constructor(file) { trace.push(['db-open', file]); fail('db-open'); }
    async get(...args) { trace.push(['db-get', ...args]); fail('db-get'); return c.failure === 'actor' ? null : { user_uuid: 'synthetic-actor', role: 'owner' }; }
    close(cb) { trace.push(['db-close']); fail('db-close'); cb(c.failure === 'db-close-callback' ? new Error('synthetic callback close') : undefined); }
  }
  const node = { warn: (...args) => trace.push(['warn', ...args]), error: (...args) => trace.push(['error', ...args]), status: (...args) => trace.push(['status', ...args]), send: (...args) => trace.push(['send', ...args]) };
  const globals = { get(key) { trace.push(['global-get', key]); return c.failure === 'fs-missing' ? undefined : fs; } };
  const fakeCrypto = { ...crypto, randomBytes(n) { trace.push(['random-bytes', n]); return Buffer.alloc(n, 3); } };
  return { env, node, osiLib, osiDb: { Database }, crypto: fakeCrypto, global: globals, Date: Clock, Buffer, trace };
}
async function execute(source, c, profile, invoke, overrides = {}) {
  const msg = structuredClone(c.msg);
  const deps = Object.assign(dependencies(c, profile), overrides);
  let result, error;
  try {
    if (invoke) result = await invoke(msg, deps);
    else result = await new vm.Script('(async function(msg) {\n' + source + '\n})(msg)').runInNewContext({ ...deps, msg });
  } catch (e) { error = { name: e.name, message: e.message, ...e }; }
  // The extra daily-scheduler load belongs to the adapter, rather than to legacy logic.
  const trace = deps.trace.filter(t => !(t[0] === 'require' && t[1] === 'daily-scheduler'));
  const downstream = [];
  if (c.dispatchRefused && Array.isArray(result)) {
    // Independent output wires: refusal on port 0 cannot retract SQL already
    // emitted on ports 1/2. These local sinks deliberately refuse every open.
    const sinks = [
      command => downstream.push(['dispatch', { accepted: false, reason: 'synthetic refusal' }, command]),
      event => downstream.push(['event-write', event.topic]),
      update => downstream.push(['schedule-write', update.topic]),
    ];
    result.forEach((message, port) => { if (message) sinks[port](message); });
  }
  return normalize({ result, msg, trace, error, ...(c.dispatchRefused ? { downstream } : {}) });
}
module.exports = { ROOT, PROFILES, normalize, dependencies, execute };
