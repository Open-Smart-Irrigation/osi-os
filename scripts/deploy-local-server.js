#!/usr/bin/env node
'use strict';

// Zero-dependency static file server, meant to run ON the Pi (BusyBox has no
// python3 and no busybox httpd, but every gateway has node). Serves a bundle
// byte snapshot on 127.0.0.1 so
// deploy.sh's `curl -fsSLo dest "$BASE/$src"` calls work exactly as they do
// against the SSH-tunnelled workstation server, without needing the tunnel.
//
// Uses Node builtins only; it runs without an npm install or network access.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

function safeResolve(rootDir, requestPath) {
  // Reject encoded/raw traversal and NUL-byte tricks before ever touching fs.
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.indexOf('\0') !== -1) return null;

  // url.parse throws on malformed absolute-form targets such as
  // `http://[::1/x`; that is a bad request, never a server failure.
  let parsed;
  try {
    parsed = url.parse(decoded);
  } catch {
    return null;
  }
  let pathname = parsed.pathname || '/';
  // Strip leading slashes so path.join treats it as relative to rootDir
  // (an absolute-looking segment must never override the root).
  pathname = pathname.replace(/^\/+/, '');

  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, pathname);

  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
    return null; // escaped the root
  }
  return target;
}

function createVerifiedServer(input, options = {}) {
  // Own the exact buffers checked below; neither callers nor on-disk changes
  // can replace the bytes after verification and before an HTTP request.
  const files = new Map();
  const crypto = require('node:crypto');
  for (const [name, bytes] of input) {
    const copy = Buffer.from(bytes);
    if (options.hashes && crypto.createHash('sha256').update(copy).digest('hex') !== options.hashes[name]) throw new Error('server snapshot hash mismatch');
    files.set(name, copy);
  }
  const diagnostic = options.log || (() => {});
  let logFailed = false;
  let handlerFailed = false;
  const log = line => {
    try { diagnostic(line); }
    catch (error) {
      if (!logFailed) console.error('WARN: deploy access log unavailable:', error);
      logFailed = true;
    }
  };
  // Answers a request that failed inside the handler. Only fixed reason codes
  // reach the logs; the request target is untrusted and is not repeated.
  const fail = (res, status, reason) => {
    log(`${status} ${reason}`);
    try {
      if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(status === 400 ? 'Bad request\n' : 'Internal error\n'); }
      else res.destroy();
    } catch (error) {
      log('500 response_failed');
      try { res.destroy(); } catch (destroyError) { log('500 destroy_failed'); }
    }
  };
  const handle = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const target = safeResolve('/bundle', req.url || '/');
    if (!target) { fail(res, 400, 'bad_request'); return; }
    const bytes = files.get(path.relative('/bundle', target));
    const code = bytes ? 200 : 404;
    res.writeHead(code, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes ? bytes.length : 0),
      'X-Deploy-Instance': options.nonce || '',
    });
    // Logged only once the response is set up; a failure above logs
    // `500 handler_error` instead.
    log(`${code} ${req.method} ${req.url}`);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  // Every exception inside the handler ends that one request. The server, and
  // the supervisor that hosts it, keep running.
  return http.createServer((req, res) => {
    try { handle(req, res); }
    catch (error) {
      // The error text may carry request bytes; stderr gets the fixed code.
      if (!handlerFailed) console.error('WARN: deploy server request failed: handler_error');
      handlerFailed = true;
      fail(res, 500, 'handler_error');
    }
  });
}
function createServer(rootDir, options = {}) {
  const files = new Map();
  function walk(dir, relative = '') {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) {
        const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { files.set(rel, fs.readFileSync(fd)); } finally { fs.closeSync(fd); }
      }
    }
  }
  walk(rootDir);
  return createVerifiedServer(files, options);
}

if (require.main === module) {
  const port = Number(process.argv[2] || 9876);
  const rootDir = path.resolve(process.argv[3] || '.');

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    console.error(`ERROR: not a directory: ${rootDir}`);
    process.exit(1);
  }

  const server = createServer(rootDir, { log: (line) => console.log(line) });
  server.on('error', (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    // deploy-offline.sh polls for this exact token to know the server is up.
    console.log(`READY http://127.0.0.1:${port} root=${rootDir}`);
    const pidfile = process.env.DEPLOY_LOCAL_SERVER_PIDFILE;
    if (pidfile) {
      try {
        fs.writeFileSync(pidfile, String(process.pid));
      } catch (err) {
        console.error(`WARN: could not write pidfile ${pidfile}: ${err.message}`);
      }
    }
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, createVerifiedServer, safeResolve };
