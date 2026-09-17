'use strict';
// Thin REST client for the edge Node-RED API, reached through the SSH tunnel.
// Records every request/response pair so the evidence writer can dump a full
// HTTP transcript for each case.
//
// Evidence files are committed, copied around and pasted into reviews, so
// nothing secret may reach one. Every request and response body and every
// header is redacted on the way INTO the transcript -- not on the way out --
// so there is no path that records a secret and relies on a later filter.

const { assertConnectableBase } = require('./config');

const REDACTED = '[redacted]';

// Matched case-insensitively against a key with separators removed, so
// `password`, `Password`, `sync_token`, `syncToken` and `SYNC-TOKEN` all hit.
const SECRET_KEY_PATTERNS = [
  /^password$/,
  /^passwordhash$/,
  /^token$/,
  /^accesstoken$/,
  /^refreshtoken$/,
  /^synctoken$/,
  /^servers?synctoken$/,
  /^mqttpassword$/,
  /^authorization$/,
  /^appkey$/,
  /^secret$/,
  /^authtokensecret$/,
  /^jwtsecret$/,
  /^cookie$/,
  /^setcookie$/,
];

function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_PATTERNS.some((re) => re.test(normalized));
}

// Deep copy with every secret-named value replaced. Returns a NEW structure;
// the caller's request body is never mutated.
function redact(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

// A body or header that arrived as text. If it is JSON, redact it structurally
// and re-serialize; otherwise strip anything that looks like a bearer token.
function redactString(text) {
  const raw = String(text);
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redact(JSON.parse(trimmed), 1));
    } catch (_) { /* not JSON after all; fall through */ }
  }
  return raw.replace(/\bBearer\s+\S+/gi, 'Bearer ' + REDACTED);
}

function redactHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) {
    out[k] = isSecretKey(k) ? REDACTED : redactString(v);
  }
  return out;
}

class Rest {
  constructor(baseUrl, { token = null, transcript = null } = {}) {
    // Second check at the client: a base URL must still be the local end of the
    // tunnel or an allow-listed gateway, with no userinfo and no forbidden host
    // hidden anywhere in it -- whether or not it came from config().
    assertConnectableBase(baseUrl, 'the REST client');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.token = token;
    this.transcript = transcript; // array, or null to skip recording
  }

  withToken(token) {
    return new Rest(this.baseUrl, { token, transcript: this.transcript });
  }

  async request(method, path, { body, token, headers = {}, timeoutMs = 30000, raw = false } = {}) {
    const url = this.baseUrl + path;
    const effectiveToken = token === undefined ? this.token : token;
    const h = Object.assign({ Accept: 'application/json' }, headers);
    if (effectiveToken) h.Authorization = 'Bearer ' + effectiveToken;
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let res, text, parsed = null, error = null;
    try {
      res = await fetch(url, {
        method,
        headers: h,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal,
      });
      text = await res.text();
      if (!raw && text) {
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      }
    } catch (e) {
      error = e;
    } finally {
      clearTimeout(timer);
    }

    // Redacted at the point of recording: a secret never enters the transcript
    // array at all, so nothing downstream can leak one by forgetting to filter.
    const record = {
      method,
      path,
      status: error ? 0 : res.status,
      durationMs: Date.now() - startedAt,
      requestHeaders: redactHeaders(h),
      requestBody: body === undefined ? null : redact(body),
      responseHeaders: error ? {} : redactHeaders(res.headers),
      responseBody: error
        ? redactString(String(error.message))
        : redact(parsed !== null ? parsed : (text || '').slice(0, 4000)),
      authenticated: !!effectiveToken,
    };
    if (this.transcript) this.transcript.push(record);
    if (error) throw new Error(method + ' ' + path + ' failed: ' + error.message);

    return { status: res.status, body: parsed !== null ? parsed : text, text, headers: res.headers };
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, Object.assign({ body }, opts)); }
  put(path, body, opts) { return this.request('PUT', path, Object.assign({ body }, opts)); }
  del(path, opts) { return this.request('DELETE', path, opts); }
}

module.exports = { Rest, redact, redactString, redactHeaders, isSecretKey, REDACTED };
