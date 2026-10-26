import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const valueFor = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

const root = path.resolve(valueFor('--root'));
const port = Number(valueFor('--port', '4181'));
const basePath = valueFor('--base', '/');
const indexFile = path.join(root, 'index.html');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function pathWithinRoot(candidate) {
  const resolved = path.resolve(root, candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function relativeRequestPath(requestPath) {
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  if (requestPath === normalizedBase.slice(0, -1) || requestPath === normalizedBase) return 'index.html';
  if (normalizedBase !== '/' && requestPath.startsWith(normalizedBase)) return requestPath.slice(normalizedBase.length);
  if (normalizedBase === '/') return requestPath.slice(1);
  return null;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (requestUrl.pathname === '/__mobile_history_health') {
    send(response, 200, 'ok\n');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'method not allowed\n');
    return;
  }

  const relative = relativeRequestPath(requestUrl.pathname);
  if (relative === null) {
    send(response, 404, 'not found\n');
    return;
  }
  const requestedFile = pathWithinRoot(relative) ?? indexFile;
  let file = requestedFile;
  try {
    await readFile(file);
  } catch {
    // BrowserRouter routes and hash-root navigation need the production index.
    file = indexFile;
  }
  try {
    const body = await readFile(file);
    const type = mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  } catch {
    send(response, 404, 'not found\n');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mobile-history static server listening on http://127.0.0.1:${port}${basePath}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
