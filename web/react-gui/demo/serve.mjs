import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
const root = resolve(fileURLToPath(new URL('../demo-build/', import.meta.url)));
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
export const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'";
const port = Number(process.env.DEMO_PORT || 4173);
http.createServer(async (req, res) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new Error('method');
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/') {res.writeHead(302, {Location: '/demo/index.html'}); res.end(); return;}
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw new Error('path');
    const content = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(req.method === 'HEAD' ? undefined : content);
  } catch {res.writeHead(404); res.end('Demo resource unavailable');}
}).listen(port, '127.0.0.1', () => console.log(`OSI demo: http://127.0.0.1:${port}/`));
