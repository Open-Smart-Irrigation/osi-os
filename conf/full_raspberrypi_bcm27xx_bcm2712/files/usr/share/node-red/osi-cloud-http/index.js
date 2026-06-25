'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LOWPOWER_STATE_FILE = '/var/run/osi-lowpower/window.env';

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

function parseLowPowerStateFile(raw) {
  const values = {};
  String(raw || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
    if (!match) return;
    let value = match[2] || '';
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  });
  return values;
}

function lowPowerWindowStatus(options) {
  const deps = options || {};
  const env = deps.env || process.env;
  const runtimeFs = deps.fs || fs;
  const stateFile = String(env.OSI_LOWPOWER_STATE_FILE || DEFAULT_LOWPOWER_STATE_FILE).trim() || DEFAULT_LOWPOWER_STATE_FILE;

  if (env.OSI_LOWPOWER_WINDOWED_SYNC !== '1') {
    return {
      enabled: false,
      stateFile,
      state: 'disabled',
      open: true,
      reason: 'low-power disabled',
      values: {}
    };
  }

  let values;
  try {
    values = parseLowPowerStateFile(runtimeFs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return {
      enabled: true,
      stateFile,
      state: 'missing',
      open: false,
      reason: 'state file missing',
      values: {}
    };
  }

  const state = String(values.OSI_LOWPOWER_WINDOW_STATE || 'missing').trim().toLowerCase() || 'missing';
  const open = state === 'open';
  return {
    enabled: true,
    stateFile,
    state,
    open,
    reason: String(values.OSI_LOWPOWER_REASON || (open ? 'window open' : 'window closed')).trim(),
    values
  };
}

function assertLowPowerCloudWindowOpen(options) {
  const status = lowPowerWindowStatus(options);
  if (!status.enabled || status.open) return status;
  const error = new Error(`low-power cloud window is closed (${status.stateFile}, state=${status.state})`);
  error.code = 'OSI_LOWPOWER_WINDOW_CLOSED';
  error.statusCode = 425;
  error.lowPowerWindowStatus = status;
  throw error;
}

function requestJsonIpv4(input) {
  const requestInput = Object.assign({}, input || {});
  const lowPowerBypass = requestInput.lowPowerBypass === true;
  delete requestInput.lowPowerBypass;

  if (!lowPowerBypass) {
    try {
      assertLowPowerCloudWindowOpen();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const request = normalizeRequest(requestInput);
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
  lowPowerWindowStatus,
  assertLowPowerCloudWindowOpen,
  requestJsonIpv4
};
