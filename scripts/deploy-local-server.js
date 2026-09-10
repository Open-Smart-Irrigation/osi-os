#!/usr/bin/env node
'use strict';

// Zero-dependency static file server, meant to run ON the Pi (BusyBox has no
// python3 and no busybox httpd, but every gateway has node). Serves a bundle
// directory (extracted from deploy-bundle.sh's tarball) on 127.0.0.1 so
// deploy.sh's `curl -fsSLo dest "$BASE/$src"` calls work exactly as they do
// against the SSH-tunnelled workstation server, without needing the tunnel.
//
// Only node:http, node:fs, node:path, node:url -- no npm install step, which
// is the whole point (it must run before/without network access).

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

  const parsed = url.parse(decoded);
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

function createServer(rootDir, options = {}) {
  const log = options.log || (() => {});

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const requestPath = req.url || '/';
    const target = safeResolve(rootDir, requestPath);
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request\n');
      log(`400 ${req.method} ${requestPath}`);
      return;
    }

    fs.stat(target, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found\n');
        log(`404 ${req.method} ${requestPath}`);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
      });

      if (req.method === 'HEAD') {
        res.end();
        log(`200 HEAD ${requestPath}`);
        return;
      }

      const stream = fs.createReadStream(target);
      stream.on('error', () => {
        // stat succeeded but the read failed mid-stream (e.g. removed
        // concurrently); nothing more we can safely send once headers are
        // already flushed, so just tear down the connection.
        res.destroy();
        log(`ERROR streaming ${requestPath}`);
      });
      stream.pipe(res);
      res.on('finish', () => log(`200 GET ${requestPath}`));
    });
  });

  return server;
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
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, safeResolve };
