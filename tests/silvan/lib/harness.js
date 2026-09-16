'use strict';
// Shared per-run context handed to every case, plus the small assertion helpers
// cases use. A case never constructs its own clients: it gets `ctx` and uses it,
// so the safety guards (EUI check, simulated-device check, read-only SQL) cannot
// be bypassed by accident.

const { config, assertSilvanViaSsh, assertSilvanViaApi, assertSimulatedDevice, simDeveui } = require('./config');
const { Ssh } = require('./ssh');
const { Rest } = require('./rest');
const { DownlinkObserver } = require('./observer');
const U = require('./uplinks');
const { connect } = require('./mqtt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls `fn` until it returns a truthy value, or throws after `timeoutMs`.
// Used everywhere instead of a fixed sleep: the edge writes asynchronously
// (MQTT -> function node -> sqlite node), so a fixed wait is either flaky or slow.
async function until(fn, { timeoutMs = 15000, intervalMs = 400, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + what);
    }
    await sleep(intervalMs);
  }
}

class Ctx {
  constructor({ cfg, ssh, rest, transcript, evidence, observer, profiles, env, user }) {
    this.cfg = cfg;
    this.ssh = ssh;
    this.rest = rest;
    this.transcript = transcript;
    this.ev = evidence;
    this.observer = observer;
    this.profiles = profiles;
    this.env = env;
    this.user = user;
    this.U = U;
    this.sleep = sleep;
    this.until = until;
    this.simDeveui = simDeveui;
    this.assertSimulatedDevice = assertSimulatedDevice;
  }

  // --- assertions -----------------------------------------------------------
  expect(name, condition, detail) {
    const ok = this.ev.check(name, condition, detail);
    if (!ok) this._failed = true;
    return ok;
  }

  expectEqual(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return this.expect(name, ok, ok ? { actual } : { actual, expected });
  }

  expectStatus(name, res, expected) {
    const list = Array.isArray(expected) ? expected : [expected];
    const ok = list.includes(res.status);
    return this.expect(name, ok, { status: res.status, expected: list, body: truncate(res.body) });
  }

  // --- simulated-device convenience ----------------------------------------
  // Registers a simulated device through the real API (never by writing SQL).
  async createSimDevice({ deveui, name, type_id, strega_generation, zoneId }) {
    assertSimulatedDevice(deveui);
    const body = {
      deveui,
      name,
      type_id,
      appkey: '00112233445566778899AABBCCDDEE' + deveui.slice(-2),
    };
    if (strega_generation) body.strega_generation = strega_generation;
    const res = await this.rest.post('/api/devices', body);
    if (res.status === 201 && zoneId) {
      await this.rest.put('/api/irrigation-zones/' + zoneId + '/devices/' + deveui, {});
    }
    return res;
  }

  async deleteSimDevice(deveui) {
    assertSimulatedDevice(deveui);
    try {
      const res = await this.rest.del('/api/devices/' + deveui);
      this.ev.cleanupStep('delete device ' + deveui, res.status === 200 || res.status === 404, { status: res.status });
      return res;
    } catch (e) {
      this.ev.cleanupStep('delete device ' + deveui, false, e.message);
      return null;
    }
  }

  async deleteZone(zoneId) {
    try {
      const res = await this.rest.del('/api/irrigation-zones/' + zoneId);
      this.ev.cleanupStep('delete zone ' + zoneId, res.status === 200 || res.status === 404, { status: res.status });
      return res;
    } catch (e) {
      this.ev.cleanupStep('delete zone ' + zoneId, false, e.message);
      return null;
    }
  }

  // Publishes a simulated uplink on the sensors application.
  publishSensorUplink(env) {
    this.observer.publishUplink(env, this.env.CHIRPSTACK_APP_SENSORS);
    return env;
  }

  publishActuatorUplink(env) {
    this.observer.publishUplink(env, this.env.CHIRPSTACK_APP_ACTUATORS);
    return env;
  }
}

function truncate(value, max = 400) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Reads the gateway's effective Node-RED environment (ChirpStack application /
// profile IDs only -- never secrets) so the simulator claims the exact profile
// UUIDs the running flows resolve.
//
// Two sources, merged the way the gateway itself merges them: the process
// environment exported by node-red.init, THEN /srv/node-red/.chirpstack.env,
// which settings.js loads into process.env at startup for every key not already
// set ("if (process.env[key]) continue"). Reading only /proc/<pid>/environ is
// wrong: it is the process's INITIAL environment, so keys settings.js adds at
// boot (CHIRPSTACK_PROFILE_LORAIN, _UC512, _STREGA_GEN2 on this gateway) are
// invisible there even though env.get() resolves them inside a function node.
async function readGatewayEnv(ssh) {
  const WANTED = /^(CHIRPSTACK_APP_|CHIRPSTACK_PROFILE_|DEVICE_EUI=|OSI_SCOPED_ACCESS=|TZ=)/;
  const env = {};
  const absorb = (text, overwrite) => {
    for (const line of String(text).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.indexOf('=');
      if (i <= 0) continue;
      const key = trimmed.slice(0, i).trim();
      if (!WANTED.test(key + '=') && !WANTED.test(key)) continue;
      let value = trimmed.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (overwrite || env[key] === undefined) env[key] = value;
    }
  };

  const procEnv = await ssh.exec(
    'PID=$(pgrep -f node-red | head -1); ' +
    'tr "\\0" "\\n" < /proc/$PID/environ | grep -E "^CHIRPSTACK_APP_|^CHIRPSTACK_PROFILE_|^DEVICE_EUI=|^OSI_SCOPED_ACCESS=|^TZ="'
  );
  absorb(procEnv, true);

  let fileEnv = '';
  try {
    fileEnv = await ssh.exec(
      'grep -E "^(CHIRPSTACK_APP_|CHIRPSTACK_PROFILE_)" /srv/node-red/.chirpstack.env 2>/dev/null || true'
    );
  } catch (_) { /* file absent on some images; the process env is then authoritative */ }
  absorb(fileEnv, false);

  return env;
}

// Fingerprints the flows payload the gateway is actually running. Assertions are
// only meaningful against a known backend version, and the deployed flows.json
// is regularly a different payload from the repo checkout.
async function readDeployedFlows(ssh) {
  try {
    const out = await ssh.exec(
      'F=/srv/node-red/flows.json; readlink -f "$F" 2>/dev/null; md5sum "$F" 2>/dev/null | cut -d" " -f1'
    );
    const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    return { path: lines[0] || null, md5: lines[lines.length - 1] || null };
  } catch (e) {
    return { path: null, md5: null, error: e.message };
  }
}

module.exports = { Ctx, config, assertSilvanViaSsh, assertSilvanViaApi, Ssh, Rest, DownlinkObserver, readGatewayEnv, readDeployedFlows, sleep, until, simDeveui };
