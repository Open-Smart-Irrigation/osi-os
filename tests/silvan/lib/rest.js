'use strict';
// Thin REST client for the edge Node-RED API, reached through the SSH tunnel.
// Records every request/response pair so the evidence writer can dump a full
// HTTP transcript for each case.

class Rest {
  constructor(baseUrl, { token = null, transcript = null } = {}) {
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

    const record = {
      method,
      path,
      status: error ? 0 : res.status,
      durationMs: Date.now() - startedAt,
      requestBody: body === undefined ? null : body,
      responseBody: error ? String(error.message) : (parsed !== null ? parsed : (text || '').slice(0, 4000)),
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

module.exports = { Rest };
