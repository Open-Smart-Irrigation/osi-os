'use strict';

// Follows flows.json wiring and copies messages the way Node-RED 3.1.15 does,
// so a test can see what happens to an object a message carries when an
// output has more than one receiver. Function nodes run through the caller's
// executor (scripts/lib/scoped-access-harness.js executeFunction).
//
// Behaviour reproduced, with its source in node-red 3.1.15:
// - Send order and cloning: @node-red/runtime/lib/nodes/Node.js,
//   Node.prototype.send. One `msgSent` flag spans every output and every wire
//   of one send call: the first send event carries the original object, each
//   later one is marked `cloneMessage: true`.
// - Where the clone happens: @node-red/runtime/lib/flows/Flow.js,
//   handlePreRoute, `sendEvent.msg = redUtil.cloneMessage(sendEvent.msg)`.
// - What a clone keeps: @node-red/util/lib/util.js, cloneMessage. Top-level
//   `req` and `res` are lifted out and put back by reference; everything else
//   goes through lodash.clonedeep.
// - What a function node's return value does: @node-red/nodes/core/function/
//   10-function.js, sendResults(..., false) on the returned value, so nothing
//   is cloned before Node.prototype.send.
// - Link nodes: @node-red/runtime/lib/flows/util.js (parseConfig) gives each
//   link out the wires [[every linked link in]], from both the link out's and
//   the link ins' `links`; @node-red/nodes/core/common/60-link.js makes a link
//   in or link out send the message it received.
// - HTTP answer: @node-red/nodes/core/network/21-httpin.js, the http response
//   node calls msg.res._res.status(code).jsonp(payload) (or .send for a
//   non-object payload); with no msg.res it only warns.
//
// lodash.clonedeep, as far as it matters here: arrays and plain objects are
// copied deeply, a function inside an object keeps its reference, and any
// other object becomes Object.create(its prototype) with its own enumerable
// properties copied. A real ServerResponse copied that way no longer works.
// fakeHttpResponse() below stands in for it with a private field, which such
// a copy does not have, so using the copy throws a TypeError.

function cloneDeep(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  let copy;
  if (Array.isArray(value)) copy = [];
  else if (value instanceof Date) return new Date(value.getTime());
  else if (Buffer.isBuffer(value)) return Buffer.from(value);
  else copy = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = cloneDeep(value[key], seen);
  return copy;
}

function cloneMessage(msg) {
  if (msg === null || msg === undefined) return msg;
  const { req, res } = msg;
  delete msg.req;
  delete msg.res;
  const copy = cloneDeep(msg);
  if (req) { copy.req = req; msg.req = req; }
  if (res) { copy.res = res; msg.res = res; }
  return copy;
}

// The express response the http in node wraps. `answers` records every reply.
class FakeServerResponse {
  #answers;
  #statusCode = 200;
  constructor(answers) { this.#answers = answers; }
  status(code) { this.#statusCode = code; return this; }
  set() { return this; }
  get() { return undefined; }
  cookie() { return this; }
  clearCookie() { return this; }
  jsonp(body) { this.#answers.push({ statusCode: this.#statusCode, payload: body }); return this; }
  send(body) { this.#answers.push({ statusCode: this.#statusCode, payload: body }); return this; }
}

// A msg.req / msg.res pair as the http in node creates it (createResponseWrapper).
function fakeHttpRequest(body = {}) {
  const answers = [];
  const res = { _res: new FakeServerResponse(answers) };
  const req = { method: 'POST', headers: {}, body, params: {}, query: {} };
  return { req, res, answers };
}

function linkTargets(flows, linkOut) {
  const targets = new Set(linkOut.links || []);
  for (const node of flows) {
    if (node.type === 'link in' && (node.links || []).includes(linkOut.id)) targets.add(node.id);
  }
  return [[...targets]];
}

// Node.prototype.send: the first event keeps the object, the rest are clones.
function sendEvents(wires, outputs) {
  const events = [];
  let sent = false;
  outputs.forEach((out, port) => {
    if (out === null || out === undefined) return;
    const messages = Array.isArray(out) ? out : [out];
    for (const target of (wires[port] || [])) {
      for (const msg of messages) {
        if (msg === null || msg === undefined) continue;
        events.push({ target, msg: sent ? cloneMessage(msg) : msg });
        sent = true;
      }
    }
  });
  return events;
}

// Runs from startId with msg until no message is left. `runFunction(node, msg)`
// returns the function's result; `wiresOf(node)` may override a node's wires.
// Every other node type a message reaches is recorded in `stopped`.
async function walk({ flows, startId, msg, runFunction, wiresOf = (node) => node.wires || [] }) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const trace = [];
  const stopped = [];
  const errors = [];
  const queue = [{ target: startId, msg }];
  while (queue.length) {
    const { target, msg: current } = queue.shift();
    const node = byId.get(target);
    if (!node) { errors.push('missing node ' + target); continue; }
    trace.push(node.id);
    let outputs = null;
    let wires = wiresOf(node);
    if (node.type === 'function') {
      try {
        const result = await runFunction(node, current);
        outputs = result === null || result === undefined ? null : (Array.isArray(result) ? result : [result]);
      } catch (error) {
        errors.push(node.id + ': ' + (error && error.message ? error.message : error));
      }
    } else if (node.type === 'link in') {
      outputs = [current];
    } else if (node.type === 'link out') {
      wires = linkTargets(flows, node);
      outputs = [current];
    } else if (node.type === 'http response') {
      if (!current.res) { errors.push(node.id + ': no response object'); continue; }
      try {
        const statusCode = Number(current.statusCode || node.statusCode) || 200;
        const body = current.payload;
        if (typeof body === 'object' && !Buffer.isBuffer(body)) current.res._res.status(statusCode).jsonp(body);
        else current.res._res.status(statusCode).send(body);
      } catch (error) {
        errors.push(node.id + ': ' + (error && error.message ? error.message : error));
      }
      continue;
    } else {
      stopped.push({ nodeId: node.id, type: node.type, msg: current });
      continue;
    }
    if (outputs) queue.push(...sendEvents(wires, outputs));
  }
  return { trace, stopped, errors };
}

module.exports = { cloneDeep, cloneMessage, fakeHttpRequest, sendEvents, walk };
