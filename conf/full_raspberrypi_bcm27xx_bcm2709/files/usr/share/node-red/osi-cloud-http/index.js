'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;

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
  requestJsonIpv4
};
