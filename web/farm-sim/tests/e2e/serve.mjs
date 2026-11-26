import {createReadStream, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {productionHeaders} from '../../vite.shared.mjs';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));
const smoke = fileURLToPath(new URL('../../test-results/phone-host', import.meta.url));
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export function builtFile(pathname) {
  const urlPath = decodeURIComponent(pathname).replace(/^\/some\/where(?=\/)/, '');
  const directory = urlPath === '/phone-host.html' || urlPath.startsWith('/phone-host-assets/') ? smoke : dist;
  const path = resolve(directory, '.' + (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath));
  if (!path.startsWith(directory + sep)) return undefined;
  return statSync(path, {throwIfNoEntry: false})?.isFile() ? path : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((request, response) => {
    const path = builtFile(new URL(request.url, 'http://localhost').pathname);
    if (!path) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      ...productionHeaders(path.startsWith(resolve(dist, 'phone') + sep)),
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
    });
    createReadStream(path).pipe(response);
  }).listen(4275, '127.0.0.1');
}
