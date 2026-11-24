'use strict';

const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30000;
// Protocols that carry TLS. Any other protocol reaches a cloud address only
// when its host is loopback.
const TLS_PROTOCOLS = ['https:', 'wss:', 'mqtts:'];
// One line per process, shared by every copy of this module (an image and a
// deployed payload can hold more than one), like the start-up state in
// osi-db-helper.
const REFUSAL_WARNED = Symbol.for('osi.cloud-http.refusalWarned');

// Issue #766: an unlinked gateway reports nothing to the cloud. Linking always
// stores an MQTT password (the link is refused without one, since v0.7.0), and
// node-red.init exports it to the process as DEVICE_MQTT_PASSWORD, empty when
// unlinked. Link and unlink both restart Node-RED, so the value holds for the
// life of the process.
function gatewayLinked(env = process.env) {
  return String((env && env.DEVICE_MQTT_PASSWORD) || '').trim() !== '';
}

// Requests that carry gateway data or keep a gateway session alive. Matched
// as a path segment anywhere in the request path, so a cloud reached under a
// base path (https://host/osi/api/v1/sync/...) is gated the same way.
// Two routes stay open to an unlinked gateway: linking (/auth/local-sync),
// and support work requests (/api/v1/support/edge/work-requests), which the
// farmer starts and which carry only the support request itself. Support is
// the one deliberate exception to "an unlinked gateway sends nothing".
const LINKED_ONLY_PATHS = [/(?:^|\/)api\/v1\/sync\//, /(?:^|\/)api\/v2\/journal\//, /(?:^|\/)auth\/refresh-sync(?:\/|$)/];

function linkedOnlyPath(pathname) {
  return LINKED_ONLY_PATHS.some((pattern) => pattern.test(String(pathname || '')));
}

function unlinkedRefusal(parsed, env = process.env) {
  if (!linkedOnlyPath(parsed.pathname)) return null;
  if (!gatewayLinked(env)) {
    const error = new Error('Gateway is not linked to a cloud account; cloud sync request not sent');
    error.code = 'gateway_unlinked';
    return error;
  }
  // A link, an unlink or an identity change is committed or in progress and
  // Node-RED has not restarted yet: the process still holds the old
  // environment, and a request built before the change may carry the old
  // token. Read at send time, as the cloud MQTT guards do (#766).
  const pending = accountWorkPending();
  if (pending === 'unavailable') {
    const error = new Error('Gateway account-work gate is unavailable; cloud sync request not sent');
    error.code = 'account_gate_unavailable';
    return error;
  }
  if (pending) {
    const error = new Error('Gateway account or identity change is pending a restart; cloud sync request not sent');
    error.code = 'account_restart_pending';
    return error;
  }
  return null;
}

// The account-work gate lives in osi-installation-helper, which itself loads
// this module, so it is required at call time. It is loaded the way osi-lib
// loads it for the flows (by path under OSI_LIB_BASE), so the gate sees the
// flows' instance and its in-progress account operation, on a fresh image
// (where node_modules holds separate copies) as after a deploy. The sibling
// path is the fallback where that base does not exist (test harnesses); it
// still sees the account journal, the restart requests and the sentinel.
let accountWorkFs = require('fs');
function defaultAccountGateLoader() {
  const base = process.env.OSI_LIB_BASE || '/srv/node-red';
  try {
    return require(path.join(base, 'osi-installation-helper'));
  } catch (primaryError) {
    return require('../osi-installation-helper');
  }
}
let loadAccountGate = defaultAccountGateLoader;

function warnGate(text) {
  console.warn('osi-cloud-http: ' + text);
}

// Loopback hosts: 127.0.0.0/8, ::1 and the name localhost. Returns the host
// in one spelling (lower case, no brackets) when it is loopback, else ''.
function loopbackHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return host;
  const address = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return address && address.slice(1).every((octet) => Number(octet) <= 255) ? host : '';
}

function isLoopbackHostname(hostname) {
  return loopbackHostname(hostname) !== '';
}

// The cloud endpoint scheme policy, shared with the account link and the zone
// environment summary: a cloud address uses TLS unless its host is loopback.
// Returns null when the address passes, else an error with the code
// cloud_endpoint_scheme. A caller whose client reads the address with
// another parser passes that reading as { clientHostname }; a plain address
// then passes only when both read the same loopback host. The first refusal
// in a process is logged: nothing else tells an operator that a stored
// address no longer passes. Pass { quiet: true } where the caller reports
// the refusal itself.
function cloudEndpointRefusal(protocol, hostname, options) {
  const settings = options || {};
  if (TLS_PROTOCOLS.includes(String(protocol || '').toLowerCase())) return null;
  const host = loopbackHostname(hostname);
  const clientHost = settings.clientHostname === undefined ? host : loopbackHostname(settings.clientHostname);
  if (host && host === clientHost) return null;
  const error = new Error('A cloud address outside loopback must use TLS; relink the gateway with its https address');
  error.code = 'cloud_endpoint_scheme';
  if (!(options && options.quiet) && !globalThis[REFUSAL_WARNED]) {
    globalThis[REFUSAL_WARNED] = true;
    warnGate('refused a request over ' + String(protocol || 'no protocol').replace(/:$/, '') + ' to ' +
      String(hostname || 'no host') + '. ' + error.message + '. Logged once per start.');
  }
  return error;
}

// true, false, or 'unavailable' when the gate cannot be loaded or run; the
// caller refuses in both the true and the 'unavailable' case.
function accountWorkPending() {
  let helper;
  try {
    helper = loadAccountGate();
    if (!helper || typeof helper.gatewayWorkBlocked !== 'function') throw new Error('gatewayWorkBlocked is not exported');
  } catch (error) {
    warnGate('account-work gate could not be loaded; refusing cloud sync requests: ' + String(error && error.message ? error.message : error));
    return 'unavailable';
  }
  try {
    return helper.gatewayWorkBlocked({ fs: accountWorkFs, warn: warnGate }) ? true : false;
  } catch (error) {
    warnGate('account-work gate failed; refusing cloud sync requests: ' + String(error && error.message ? error.message : error));
    return 'unavailable';
  }
}

function hasHeader(headers, wanted) {
  const needle = String(wanted || '').toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

function parseJsonBody(rawBody) {
  if (rawBody == null || rawBody === '') return null;
  try {
    return JSON.parse(rawBody);
  } catch (_) {
    return rawBody;
  }
}

function normalizeRequest(input) {
  const source = input || {};
  const method = String(source.method || 'GET').trim().toUpperCase();
  const url = String(source.url || '').trim();
  if (!url) {
    throw new Error('Cloud REST URL is required');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported cloud REST protocol: ${parsed.protocol}`);
  }
  const headers = Object.assign({}, source.headers || {});
  const hasBody = source.payload !== undefined && source.payload !== null && method !== 'GET' && method !== 'HEAD';
  const body = hasBody
    ? Buffer.from(typeof source.payload === 'string' ? source.payload : JSON.stringify(source.payload))
    : null;
  if (body && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  if (body && !hasHeader(headers, 'content-length')) {
    headers['Content-Length'] = String(body.length);
  }
  const timeoutMs = Math.max(1000, Number(source.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  return { method, parsed, headers, body, timeoutMs };
}

function requestJsonIpv4(input) {
  const request = normalizeRequest(input);
  const refusal = unlinkedRefusal(request.parsed) ||
    cloudEndpointRefusal(request.parsed.protocol, request.parsed.hostname);
  if (refusal) return Promise.reject(refusal);
  const transport = request.parsed.protocol === 'https:' ? https : http;
  const diagnostics = {
    family: 4,
    host: request.parsed.hostname,
    protocol: request.parsed.protocol
  };
  const options = {
    protocol: request.parsed.protocol,
    hostname: request.parsed.hostname,
    port: request.parsed.port || undefined,
    path: `${request.parsed.pathname}${request.parsed.search}`,
    method: request.method,
    headers: request.headers,
    family: 4,
    timeout: request.timeoutMs
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      error.cloudRestIpv4 = diagnostics;
      reject(error);
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        settleResolve({
          statusCode: Number(res.statusCode || 0),
          headers: res.headers || {},
          payload: parseJsonBody(rawBody),
          rawBody,
          diagnostics
        });
      });
      res.on('aborted', () => {
        settleReject(new Error('Cloud REST IPv4 response aborted before completion'));
      });
      res.on('error', (error) => {
        settleReject(error);
      });
      res.on('close', () => {
        if (!res.complete) {
          settleReject(new Error('Cloud REST IPv4 response closed before completion'));
        }
      });
    });

    req.setTimeout(request.timeoutMs, () => {
      const error = new Error(`Cloud REST IPv4 request timed out after ${request.timeoutMs}ms`);
      settleReject(error);
      req.destroy(error);
    });
    req.on('error', (error) => {
      settleReject(error);
    });
    if (request.body) req.write(request.body);
    req.end();
  });
}

module.exports = {
  requestJsonIpv4,
  gatewayLinked,
  linkedOnlyPath,
  isLoopbackHostname,
  cloudEndpointRefusal
};

// Tests read the account files from an in-memory gateway instead of the disk,
// and can replace the gate loader to simulate a missing helper.
module.exports.useAccountWorkFsForTests = (fsImpl) => { accountWorkFs = fsImpl || require('fs'); };
module.exports.useAccountGateLoaderForTests = (loader) => { loadAccountGate = loader || defaultAccountGateLoader; };
