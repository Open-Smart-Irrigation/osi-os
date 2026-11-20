'use strict';
const vm = require('node:vm');
const crypto = require('node:crypto');
const { cloneDeep, cloneMessage } = require('./node-red-send-emulation');
const { EUI, GATEWAY, NOW, SECRET } = require('./valve-ingress-x2-cases');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
function environment(testCase, moduleRoot) {
  const options = testCase.options || {};
  const effects = [];
  const timers = [];
  const msg = cloneDeep(testCase.msg);
  const originalReq = msg.req, originalRes = msg.res;
  const failure = (message, statusCode) => Object.assign(new Error(message), statusCode ? { statusCode } : {});
  const ioError = () => { throw Object.assign(new Error('fixture IO failure'), { code: 'EACCES' }); };
  const fakeFs = {
    readdirSync(file) { effects.push(['readdir', file]); if (options.fan === 'hwmon-dir-error') return ioError(); return options.fan === 'missing' || String(options.fan).startsWith('pwm') ? [] : ['hwmon0']; },
    readFileSync(file, encoding) {
      effects.push(['read', file, encoding]);
      if (file.includes('auth_token_secret')) {
        if (options.secret === 'read' || (options.secret === 'fallback-read' && file.startsWith('/var'))) return SECRET + '\n';
        if (options.secret === 'read-error') return ioError();
        throw Object.assign(new Error('missing fixture secret'), { code: 'ENOENT' });
      }
      if (options.fan === 'pwm-read-error' || (options.fan === 'hwmon-read-error' && file.endsWith('/name'))) return ioError();
      if (file.endsWith('/period') && ['pwm-period-error','pwm-disable-error'].includes(options.fan)) return '0\n';
      return file.endsWith('/name') ? 'pwmfan\n' : '41566\n';
    },
    accessSync(file) { effects.push(['access', file]); if (options.fan === 'missing' || (file.endsWith('/pwm3') && options.fan !== 'pwm-existing')) return ioError(); },
    writeFileSync(file, data, flags) {
      effects.push(['write', file, data, flags]);
      if (file.includes('auth_token_secret') && options.secret === 'write-error') return ioError();
      if ((options.fan === 'hwmon-write-error' && file.endsWith('pwm1')) || (options.fan === 'hwmon-enable-error' && file.endsWith('pwm1_enable')) || (options.fan === 'pwm-duty-error' && file.endsWith('/duty_cycle')) || (options.fan === 'pwm-disable-error' && file.endsWith('/enable') && data === '0') || (options.fan === 'pwm-export-error' && file.endsWith('/export')) || (options.fan === 'pwm-enable-error' && file.endsWith('/enable')) || (options.fan === 'pwm-period-error' && file.endsWith('/period'))) return ioError();
    },
  };
  const db = {
    async get(sql, params) {
      effects.push(['db.get', sql, params]);
      if (options.mode === 'db-error') throw failure('fixture db failed');
      if (/SELECT user_uuid/.test(sql)) return options.mode === 'missing-actor' ? null : { user_uuid: 'actor-1' };
      return options.mode === 'not-found' ? null : { deveui: EUI, type_id: options.mode === 'wrong-type' ? 'MILESIGHT_UC512' : 'STREGA_VALVE', user_id: options.mode === 'other-owner' ? 2 : 1 };
    },
    close(callback) { effects.push(['db.close']); if (options.mode === 'close-error') throw failure('fixture close failed'); callback(); },
  };
  const client = {
    async flushDeviceQueue(eui) { effects.push(['flush', eui]); return { statusCode: 200 }; },
    async getDeviceQueue(eui) { effects.push(['queue', eui]); return []; },
    async enqueueDownlink(item) { effects.push(['enqueue', item]); return { id: 'queue-1' }; },
  };
  const scope = {
    resolveAuthSecret(args) { effects.push(['scope.secret', args.configuredSecret]); if (options.scopeSecretError) throw failure('fixture scope secret failed', 500); return SECRET; },
    async assertFreshDeviceAccess(dbArg, actor, eui, config) { effects.push(['scope.access', dbArg === db, actor, eui, config]); if (/^scope-\d/.test(options.mode || '')) throw failure('fixture scope denied', Number(options.mode.slice(6))); return { role: options.mode === 'viewer' ? 'viewer' : 'admin' }; },
    canMutate(role) { effects.push(['scope.mutate', role]); return role !== 'viewer'; },
  };
  const cancelModule = require(moduleRoot + '/cancel');
  const valve = {
    async cancelActuation(args) {
      effects.push(['cancel', { deviceEui: args.deviceEui, expectationId: args.expectationId, reason: args.reason, now: args.now, db: args.db === db, transport: args.transport === client }]);
      if (options.mode === 'cancel-error') throw failure('fixture cancel failed', 503);
      await args.readQueue(args.deviceEui);
      await args.flushQueue(args.deviceEui);
      // The adapter must supply all callbacks and reuse the very same client.
      await args.enqueue({ fixture: 'collateral-requeue' });
      return options.cancelResult || { ok: true, expectationId: 'expectation-1', outcome: 'cancelled', previousState: 'PENDING_OBSERVATION', reason: args.reason, queueScope: 'full_flush', droppedOpens: 1, collateral: [{ expectation_id: 'other', outcome: 'dropped' }], chirpstackQueueStatus: 200, timestamp: args.now.toISOString() };
    },
    cancelHttpResponse(result, eui) { effects.push(['cancel.response', result, eui]); if (options.mode === 'shape-error') throw failure('fixture shape failed'); return cancelModule.cancelHttpResponse(result, eui); },
  };
  let scopeLoads = 0;
  const deps = {
    msg,
    env: { get(key) { const values = { DEVICE_EUI: GATEWAY, AUTH_TOKEN_SECRET: options.secret ? undefined : SECRET, OSI_SCOPED_ACCESS: options.scoped ? '1' : '0' }; effects.push(['env', key]); return values[key]; } },
    global: { get(key) { effects.push(['global', key]); return key === 'fs' ? (options.secret === 'no-fs' || options.secret === 'absent' ? undefined : fakeFs) : key === 'cp' ? { exec(cmd) { effects.push(['exec', cmd]); if (options.execError) throw failure('fixture reboot process failed'); } } : undefined; } },
    node: { warn(...args) { effects.push(['warn', ...args]); }, error(message, errorMsg) { effects.push(['error', message, errorMsg === msg ? { $identity: 'msg' } : errorMsg]); } },
    flow: { get() { throw failure('request data must not use flow context'); }, set() { throw failure('request data must not use flow context'); } },
    context: { get() { return undefined; }, set() {} },
    crypto: { ...crypto, randomUUID() { effects.push(['uuid']); return '12345678-1234-4234-8234-123456789abc'; }, randomBytes(n) { effects.push(['randomBytes', n]); return Buffer.alloc(n, 0x61); } },
    osiDb: { Database: function(file) { effects.push(['db.open', file]); if (options.mode === 'db-open-error') throw failure('fixture open failed'); return db; } },
    osiLib: { require(name) {
      effects.push(['require', name]);
      if (name === 'scope') { scopeLoads++; return options.scopeMissing || (options.mode === 'scope-second-load-missing' && scopeLoads > 1) ? { ok: false, error: 'fixture missing scope' } : { ok: true, value: scope }; }
      if (name === 'osi-valve-control') return options.mode === 'module-missing' ? { ok: false, error: 'fixture missing valve module' } : { ok: true, value: valve };
      throw failure('unexpected module: ' + name);
    } },
    chirpstack: { createProvisioningClientFromEnv() { effects.push(['client.create']); if (options.mode === 'client-error') throw failure('fixture client failed'); return client; } },
    Date: FixedDate, Buffer,
    setTimeout(fn, ms) { effects.push(['timer', ms]); if (options.timerError) throw failure('fixture timer failed'); timers.push(fn); },
  };
  return { deps, msg, effects, originalReq, originalRes, drainTimers() {
    while (timers.length) {
      effects.push(['timer.fire-after-return']);
      try { timers.shift()(); } catch (error) { effects.push(['async-error', { name: error.name, message: error.message }]); }
    }
  } };
}
function normalize(value, state) {
  if (value === undefined) return { $undefined: true };
  if (value === state.originalReq && value !== undefined) return { $identity: 'req' };
  if (value === state.originalRes && value !== undefined) return { $identity: 'res' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return Array.from(value, v => normalize(v, state));
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key], state)]));
}
function snapshot(state, value, error) {
  state.drainTimers();
  const outputs = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const clones = outputs.map(output => output ? cloneMessage(output) : output);
  return normalize({ value, error: error ? { name: error.name, message: error.message, statusCode: error.statusCode } : null, msg: state.msg, effects: state.effects, clones }, state);
}
async function execute(node, testCase, moduleRoot, runner) {
  const state = environment(testCase, moduleRoot);
  try {
    const value = runner ? await runner(node, state.deps) : await vm.runInNewContext('(function (' + Object.keys(state.deps).join(',') + ') {\n' + node.func + '\n})', {}, { filename: node.id + '.js' })(...Object.values(state.deps));
    return snapshot(state, value, null);
  } catch (error) { return snapshot(state, undefined, error); }
}
module.exports = { execute, environment, normalize, snapshot, FixedDate };
