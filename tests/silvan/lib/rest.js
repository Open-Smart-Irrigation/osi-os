'use strict';
// Thin REST client for the edge Node-RED API, reached through the SSH tunnel.
// Records every request/response pair so the evidence writer can dump a full
// HTTP transcript for each case.
//
// Evidence files are committed, copied around and pasted into reviews, so
// nothing secret may reach one. Every request and response body and every
// header is redacted on the way INTO the transcript -- not on the way out --
// so there is no path that records a secret and relies on a later filter.

const net = require('node:net');
const { assertConnectableBase } = require('./config');

const REDACTED = '[redacted]';

// Redirects are followed by hand, same-origin only (see request()).
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

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

// A bearer/session token by SHAPE alone: two or three dot-separated
// base64url-ish segments, each long enough that this cannot be an incidental
// dotted word (a filename, a hostname, an ISO timestamp, a version number).
// This catches a token that reaches evidence with no recognisable key name
// (isSecretKey never sees it) and no literal "Bearer " prefix -- e.g. a raw
// `{"token":"..."}` response body already flattened to a string by a
// truncator, or a token pasted into a free-text note (F134/F136). OSI's own
// tokens are two-part (`header.signature`, see A1's own check); this also
// matches a full three-part JWT, which is what the selftest probes with.
const TOKEN_SHAPE_RE = /\b[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,}){1,2}\b/g;

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
// and re-serialize; otherwise strip anything that looks like a bearer token --
// by the literal "Bearer " prefix, or by shape alone (TOKEN_SHAPE_RE), so a
// token survives neither path.
function redactString(text) {
  const raw = String(text);
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redact(JSON.parse(trimmed), 1));
    } catch (_) { /* not JSON after all (e.g. truncated mid-object); fall through
                     to the shape-based scan below, which still finds a token
                     inside the unparseable fragment. */ }
  }
  return raw
    .replace(/\bBearer\s+\S+/gi, 'Bearer ' + REDACTED)
    .replace(TOKEN_SHAPE_RE, REDACTED);
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
  constructor(baseUrl, { token = null, transcript = null, gateway = null } = {}) {
    // Second check at the client: a base URL must still be the local end of the
    // tunnel or the gateway this run targets, with no userinfo and no forbidden
    // host hidden anywhere in it -- whether or not it came from config(). With
    // `gateway` it is pinned to THAT allow-list entry, not merely to any.
    const host = assertConnectableBase(baseUrl, 'the REST client', gateway);
    // Rebuilt from the validated host, so what this client requests is what was
    // checked: "http://LOCALHOST:18800" and "http://[::ffff:127.0.0.1]:18800"
    // both become the canonical loopback base.
    const url = new URL(String(baseUrl));
    url.hostname = net.isIPv6(host) ? '[' + host + ']' : host;
    url.search = '';
    url.hash = '';
    this.gateway = gateway;
    this.origin = url.origin;
    this.baseUrl = (url.origin + url.pathname).replace(/\/$/, '');
    this.token = token;
    this.transcript = transcript; // array, or null to skip recording
  }

  withToken(token) {
    return new Rest(this.baseUrl, { token, transcript: this.transcript, gateway: this.gateway });
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
    // Redirects are NOT followed by fetch itself. A 3xx is followed here only
    // when it stays on this client's own origin, so a redirect from the gateway
    // can never replay this request -- bearer token included -- somewhere else.
    // The gateway's own /gui -> /gui/ 301 is same-origin and still works.
    const redirects = [];
    try {
      let currentUrl = url;
      let currentMethod = method;
      let currentBody = body;
      for (;;) {
        res = await fetch(currentUrl, {
          method: currentMethod,
          headers: h,
          body: currentBody === undefined
            ? undefined
            : (typeof currentBody === 'string' ? currentBody : JSON.stringify(currentBody)),
          redirect: 'manual',
          signal: controller.signal,
        });
        const location = REDIRECT_STATUSES.includes(res.status) ? res.headers.get('location') : null;
        if (!location) break;
        const next = new URL(location, currentUrl);
        if (next.origin !== this.origin) {
          throw new Error(
            'REFUSING to follow a ' + res.status + ' redirect from ' + path + ' to another origin (' +
            next.origin + '); this client only talks to ' + this.origin + '.'
          );
        }
        if (redirects.length >= MAX_REDIRECTS) {
          throw new Error('too many redirects (' + (redirects.length + 1) + ') starting at ' + path);
        }
        redirects.push({ status: res.status, location: redactString(location) });
        try { await res.text(); } catch (_) { /* drain the redirect body */ }
        // 303, and 301/302 on a non-idempotent method, continue as a GET with
        // no body -- the same rule a browser applies.
        if (res.status === 303 || (currentMethod !== 'GET' && currentMethod !== 'HEAD' &&
            (res.status === 301 || res.status === 302))) {
          currentMethod = 'GET';
          currentBody = undefined;
          delete h['Content-Type'];
        }
        currentUrl = next.toString();
      }
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
    if (redirects.length) record.redirects = redirects;
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
