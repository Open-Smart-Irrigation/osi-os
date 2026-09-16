'use strict';
// Downlink observer + programmable valve responder.
//
// The edge queues a STREGA downlink by publishing to the LOCAL broker on
//   application/<CHIRPSTACK_APP_ACTUATORS>/device/<DEVEUI>/command/down
// with { devEui, confirmed, fPort, data: <base64 raw bytes> }
// (flows.json node cdbaa3891d40d7a1 "Build STREGA downlink + emit log ctx",
// and valve-push-mqtt-out for the on-valve scheduler plan).
//
// On a real gateway ChirpStack consumes that topic and transmits. On the test
// gateway there is no valve, so this observer plays the valve: it records every
// downlink and, per a configurable behaviour, answers with an uplink the edge's
// own ACK ledger accepts.
//
// Behaviours (per device, settable mid-case):
//   'ack'       answer with a successful ACK after `delayMs`
//   'nack'      answer with a non-zero status (device refused the write)
//   'delay'     answer successfully, but after `slowDelayMs` (default 8s)
//   'duplicate' answer twice with the same ACK
//   'drop'      never answer
//   'observe'   record only; the case answers by hand

const { connect } = require('./mqtt');
const { assertEndpointGuardPassed } = require('./config');
const U = require('./uplinks');

const DOWNLINK_FILTER = 'application/+/device/+/command/down';

class DownlinkObserver {
  constructor({ cfg, profiles, actuatorsAppId }) {
    this.cfg = cfg;
    this.profiles = profiles;
    this.actuatorsAppId = actuatorsAppId;
    this.client = null;
    this.downlinks = [];           // every downlink seen, in order
    this.uplinksSent = [];         // every uplink this observer published
    this.behaviours = new Map();   // DEVEUI -> { mode, delayMs, slowDelayMs, status }
    this._waiters = [];
  }

  async start() {
    // The observer is the only component that opens a raw TCP socket to a
    // broker, so it re-checks that its config cleared the endpoint guard rather
    // than trusting the caller to have used config().
    assertEndpointGuardPassed(this.cfg, 'the MQTT downlink observer');
    this.client = await connect({
      host: this.cfg.mqttHost,
      port: this.cfg.mqttPort,
      clientId: 'osi-silvan-observer-' + process.pid,
    });
    this.client.on('message', (topic, payload) => this._onDownlink(topic, payload));
    await this.client.subscribe(DOWNLINK_FILTER, 0);
    return this;
  }

  setBehaviour(deveui, mode, opts = {}) {
    this.behaviours.set(String(deveui).toUpperCase(), Object.assign({ mode }, opts));
  }

  _onDownlink(topic, payloadBuf) {
    const m = topic.match(/^application\/([^/]+)\/device\/([^/]+)\/command\/down$/);
    if (!m) return;
    const deveui = m[2].toUpperCase();
    let body = null;
    try { body = JSON.parse(payloadBuf.toString('utf8')); } catch (_) { body = { _unparsed: payloadBuf.toString('base64') }; }
    const bytes = body && body.data ? Array.from(Buffer.from(body.data, 'base64')) : [];
    const record = {
      at: new Date().toISOString(),
      topic,
      applicationId: m[1],
      deveui,
      fPort: body ? body.fPort : null,
      confirmed: body ? body.confirmed : null,
      dataB64: body ? body.data : null,
      bytes,
      bytesHex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
      decoded: decodeStregaDownlink(body ? body.fPort : null, bytes),
    };
    this.downlinks.push(record);
    for (const w of this._waiters.slice()) {
      if (w.match(record)) {
        this._waiters.splice(this._waiters.indexOf(w), 1);
        w.resolve(record);
      }
    }
    this._respond(record);
  }

  _respond(record) {
    const b = this.behaviours.get(record.deveui);
    if (!b || b.mode === 'drop' || b.mode === 'observe') return;
    const send = (extraDelay, status) => {
      setTimeout(() => {
        try { this.answer(record, { status }); } catch (e) { /* case may have ended */ }
      }, extraDelay).unref();
    };
    if (b.mode === 'ack') send(b.delayMs == null ? 150 : b.delayMs, '00');
    else if (b.mode === 'nack') send(b.delayMs == null ? 150 : b.delayMs, b.status || '01');
    else if (b.mode === 'delay') send(b.slowDelayMs == null ? 8000 : b.slowDelayMs, '00');
    else if (b.mode === 'duplicate') { send(b.delayMs == null ? 150 : b.delayMs, '00'); send((b.delayMs == null ? 150 : b.delayMs) + 400, '00'); }
  }

  // Publishes the uplink a real STREGA valve would send in reply to `record`.
  answer(record, { status = '00', open = null, gen2 = false } = {}) {
    const fp = Number(record.fPort);
    let env;
    if (fp >= 14 && fp <= 20) {
      env = gen2
        ? U.stregaGen2Ack(this.profiles, { deveui: record.deveui, ackPort: fp, ackValue: parseInt(status, 16) })
        : U.stregaGen1WeekdayAck(this.profiles, { deveui: record.deveui, weekdayFport: fp, status });
    } else if (fp === 21) {
      env = gen2
        ? U.stregaGen2Ack(this.profiles, { deveui: record.deveui, ackPort: 21, ackValue: parseInt(status, 16) })
        : U.stregaGen1StatusAck(this.profiles, { deveui: record.deveui, status });
    } else if (fp === 12 || fp === 13 || fp === 25) {
      env = gen2 || fp === 25
        ? U.stregaGen2Ack(this.profiles, { deveui: record.deveui, ackPort: fp, ackValue: parseInt(status, 16) })
        : U.stregaGen1ClockAck(this.profiles, { deveui: record.deveui, port: fp, status });
    } else {
      // fPort 1/2 timed action / immediate open-close: the valve has no ACK
      // frame for these, it simply reports its new state on its next periodic
      // uplink. Mirror that: report the state the downlink commanded.
      const decoded = record.decoded || {};
      const isOpen = open === null ? decoded.opens === true : open;
      if (status !== '00') return null; // NACK for a state command = no state change reported
      env = U.stregaStatusUplink(this.profiles, { deveui: record.deveui, open: isOpen, gen2 });
    }
    this.publishUplink(env);
    return env;
  }

  publishUplink(env, appId) {
    const topic = U.upTopic(appId || this.actuatorsAppId, env.deviceInfo.devEui);
    this.client.publish(topic, JSON.stringify(env), 1);
    this.uplinksSent.push({ at: new Date().toISOString(), topic, devEui: env.deviceInfo.devEui, object: env.object });
  }

  // Resolves with the first downlink matching `predicate` (or rejects on timeout).
  waitForDownlink(predicate, timeoutMs = 10000) {
    const already = this.downlinks.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const waiter = { match: predicate, resolve };
      this._waiters.push(waiter);
      setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) {
          this._waiters.splice(i, 1);
          reject(new Error('timed out after ' + timeoutMs + 'ms waiting for a matching downlink'));
        }
      }, timeoutMs).unref();
    });
  }

  downlinksFor(deveui) {
    const e = String(deveui).toUpperCase();
    return this.downlinks.filter((d) => d.deveui === e);
  }

  async stop() {
    if (this.client) await this.client.end();
  }
}

// STREGA opcode table, byte-exact from flows.json node cdbaa3891d40d7a1.
function decodeStregaDownlink(fPort, bytes) {
  if (!bytes || !bytes.length) return { kind: 'EMPTY' };
  const op = bytes[0];
  const amount = bytes.length > 1 ? bytes[1] : null;
  const table = {
    0x21: { kind: 'TIMED_ACTION', valveAction: 'OPEN', unit: 'SECONDS', opens: true },
    0x20: { kind: 'TIMED_ACTION', valveAction: 'CLOSE', unit: 'SECONDS', opens: false },
    0x41: { kind: 'TIMED_ACTION', valveAction: 'OPEN', unit: 'MINUTES', opens: true },
    0x40: { kind: 'TIMED_ACTION', valveAction: 'CLOSE', unit: 'MINUTES', opens: false },
    0x81: { kind: 'TIMED_ACTION', valveAction: 'OPEN', unit: 'HOURS', opens: true },
    0x80: { kind: 'TIMED_ACTION', valveAction: 'CLOSE', unit: 'HOURS', opens: false },
    0x31: { kind: 'OPEN', opens: true },
    0x30: { kind: 'CLOSE', opens: false },
  };
  if (fPort >= 14 && fPort <= 20) return { kind: 'WEEKDAY_PLAN', weekday: fPort - 14 };
  if (fPort === 25) return { kind: 'DAYMASK_PLAN' };
  if (fPort === 21) return { kind: 'SCHEDULER_STATUS' };
  if (fPort === 12 || fPort === 13) return { kind: 'CLOCK_SYNC' };
  const hit = table[op];
  if (hit) return Object.assign({ amount }, hit);
  return { kind: 'UNKNOWN', opcode: op, amount };
}

module.exports = { DownlinkObserver, decodeStregaDownlink, DOWNLINK_FILTER };
