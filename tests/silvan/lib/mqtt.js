'use strict';
// Minimal MQTT 3.1.1 client (CONNECT / PUBLISH QoS0 / SUBSCRIBE / PING).
//
// Why hand-rolled instead of the `mqtt` npm package: this harness must not add a
// dependency to the repo (there is no root package.json and the edge image is
// built from a pinned feed), and the only MQTT we need is the subset ChirpStack
// itself uses on the local broker -- anonymous, QoS 0/1 publish, wildcard
// subscribe. ~200 lines here beats a vendored node_modules tree.
//
// Broker: the local mosquitto on the gateway, reached through an SSH tunnel.
// `allow_anonymous true`, no credentials (conf/.../etc/mosquitto/mosquitto.conf).

const net = require('node:net');
const { EventEmitter } = require('node:events');

function encodeRemainingLength(len) {
  const out = [];
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    out.push(digit);
  } while (len > 0);
  return Buffer.from(out);
}

function encodeString(str) {
  const body = Buffer.from(str, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

class MqttClient extends EventEmitter {
  constructor({ host, port, clientId, keepalive = 30 }) {
    super();
    this.host = host;
    this.port = port;
    this.clientId = clientId || 'osi-silvan-harness-' + Math.random().toString(16).slice(2, 10);
    this.keepalive = keepalive;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextPacketId = 1;
    this.connected = false;
    this._pingTimer = null;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { this.socket && this.socket.destroy(); } catch (_) { /* socket already gone */ }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('MQTT connect timeout after ' + timeoutMs + 'ms')), timeoutMs);

      this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
        const payload = encodeString(this.clientId);
        const variable = Buffer.concat([
          encodeString('MQTT'),
          Buffer.from([4]),            // protocol level 3.1.1
          Buffer.from([0x02]),         // clean session
          (() => { const b = Buffer.alloc(2); b.writeUInt16BE(this.keepalive, 0); return b; })(),
        ]);
        const body = Buffer.concat([variable, payload]);
        this.socket.write(Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(body.length), body]));
      });

      this.socket.on('error', fail);
      this.socket.on('close', () => {
        this.connected = false;
        if (this._pingTimer) clearInterval(this._pingTimer);
        this.emit('close');
      });
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._drain();
      });

      this.once('connack', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) { reject(new Error('MQTT CONNACK refused, code ' + code)); return; }
        this.connected = true;
        this._pingTimer = setInterval(() => {
          try { this.socket.write(Buffer.from([0xc0, 0x00])); } catch (_) { /* closing */ }
        }, Math.max(1, this.keepalive - 5) * 1000);
        this._pingTimer.unref();
        resolve(this);
      });
    });
  }

  _drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      let multiplier = 1;
      let remaining = 0;
      let i = 1;
      let byte;
      do {
        if (i >= this.buffer.length) return; // length field incomplete
        byte = this.buffer[i++];
        remaining += (byte & 127) * multiplier;
        multiplier *= 128;
      } while ((byte & 128) !== 0);
      const total = i + remaining;
      if (this.buffer.length < total) return;
      const packet = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      this._handle(packet[0], packet.subarray(i, total));
    }
  }

  _handle(header, body) {
    const type = header >> 4;
    if (type === 2) { this.emit('connack', body.length >= 2 ? body[1] : 1); return; }
    if (type === 9) { this.emit('suback', body); return; }
    if (type === 13) { return; } // PINGRESP
    if (type === 3) {
      const qos = (header & 0x06) >> 1;
      const topicLen = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + topicLen).toString('utf8');
      let offset = 2 + topicLen;
      let packetId = null;
      if (qos > 0) { packetId = body.readUInt16BE(offset); offset += 2; }
      const payload = body.subarray(offset);
      if (qos === 1 && packetId !== null) {
        const ack = Buffer.alloc(4);
        ack[0] = 0x40; ack[1] = 0x02; ack.writeUInt16BE(packetId, 2);
        try { this.socket.write(ack); } catch (_) { /* closing */ }
      }
      this.emit('message', topic, payload);
    }
  }

  publish(topic, payload, qos = 0) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const parts = [encodeString(topic)];
    let header = 0x30 | (qos << 1);
    if (qos > 0) {
      const id = Buffer.alloc(2);
      id.writeUInt16BE(this._packetId(), 0);
      parts.push(id);
    }
    parts.push(body);
    const full = Buffer.concat(parts);
    this.socket.write(Buffer.concat([Buffer.from([header]), encodeRemainingLength(full.length), full]));
  }

  subscribe(topicFilter, qos = 0) {
    return new Promise((resolve, reject) => {
      const id = this._packetId();
      const idBuf = Buffer.alloc(2);
      idBuf.writeUInt16BE(id, 0);
      const body = Buffer.concat([idBuf, encodeString(topicFilter), Buffer.from([qos])]);
      const timer = setTimeout(() => reject(new Error('SUBACK timeout for ' + topicFilter)), 10000);
      this.once('suback', () => { clearTimeout(timer); resolve(); });
      this.socket.write(Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(body.length), body]));
    });
  }

  _packetId() {
    const id = this.nextPacketId;
    this.nextPacketId = this.nextPacketId >= 0xffff ? 1 : this.nextPacketId + 1;
    return id;
  }

  async end() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    try { this.socket && this.socket.write(Buffer.from([0xe0, 0x00])); } catch (_) { /* already closed */ }
    await new Promise((resolve) => {
      if (!this.socket) { resolve(); return; }
      this.socket.end(() => resolve());
      setTimeout(resolve, 500).unref();
    });
    this.connected = false;
  }
}

async function connect(opts) {
  const client = new MqttClient(opts);
  await client.connect();
  return client;
}

module.exports = { MqttClient, connect };
