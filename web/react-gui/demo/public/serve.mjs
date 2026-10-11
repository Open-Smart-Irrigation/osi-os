import http from 'node:http';
import {realpath, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname, relative, resolve, sep} from 'node:path';

const guiRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const roots = {
  '/simulator/': resolve(guiRoot, 'public-demo-build'),
  '/website-demo/': resolve(guiRoot, 'website-demo-build'),
};
const port = Number(process.env.PUBLIC_DEMO_PORT || 4174);
const ancestorFixturesEnabled = process.env.PUBLIC_DEMO_ANCESTOR_TEST === '1';
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.ico', 'image/x-icon'],
]);
export const simulatorCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'";

let apachePolicies;
async function readApachePolicies() {
  if (!apachePolicies) {
    apachePolicies = (async () => {
      const sameText = await readFile(new URL('./apache.conf', import.meta.url), 'utf8');
      const subdomainText = await readFile(new URL('./apache-subdomain.conf', import.meta.url), 'utf8');
      const policies = text => [...text.matchAll(/Header always set Content-Security-Policy "([^"]+)"/g)].map(match => match[1]);
      const same = policies(sameText)[0];
      const [staging, production] = policies(subdomainText);
      if (!same || !staging || !production) throw new Error('Apache fixture CSP templates are incomplete');
      return {
        same,
        production: production.replace('https://opensmartirrigation.org', 'http://website.osi.test:4174'),
        staging: staging.replace('https://opensmartirrigation.org', 'http://website.osi.test:4174')
          .replace('https://staging.opensmartirrigation.org', 'http://staging.osi.test:4174'),
      };
    })();
  }
  return apachePolicies;
}

async function policyForRequest(req, rawPath) {
  if (!ancestorFixturesEnabled || !rawPath.startsWith('/simulator/')) return simulatorCsp;
  const parsed = new URL(req.url ?? '/', 'http://localhost');
  const host = parsed.searchParams.get('__ancestor_host') ?? req.headers.host?.split(':')[0];
  const policies = await readApachePolicies();
  if (host === 'same.osi.test') return policies.same;
  if (host === 'simulator.osi.test') return policies.production;
  if (host === 'simulator-staging.osi.test') return policies.staging;
  return simulatorCsp;
}

function ancestorFixtureResponse(req, res, rawPath) {
  if (!ancestorFixturesEnabled || !rawPath.startsWith('/__ancestor/')) return false;
  const parsed = new URL(req.url ?? '/', 'http://localhost');
  const target = parsed.searchParams.get('target');
  const hosts = {same: 'same.osi.test', production: 'simulator.osi.test', staging: 'simulator-staging.osi.test'};
  const parents = {same: 'same.osi.test', production: 'website.osi.test', staging: 'staging.osi.test'};
  if (!target || !hosts[target]) {fail(res); return true;}
  const frame = (id, host, source) => `<iframe id="${id}" title="${id}" src="http://${host}:4174${source}"></iframe>`;
  let body;
  if (rawPath === '/__ancestor/outer.html') {
    const wrapper = parsed.searchParams.get('wrap') ?? parents[target];
    if (wrapper !== parents[target] && wrapper !== 'attacker.osi.test') {fail(res); return true;}
    const documentName = parsed.searchParams.get('document') === 'app' ? 'app' : 'host';
    body = `<!doctype html><meta charset="utf-8"><title>Ancestor fixture</title>${frame('wrapper', wrapper, `/__ancestor/wrapper.html?target=${target}&document=${documentName}`)}`;
  } else if (rawPath === '/__ancestor/wrapper.html') {
    const documentName = parsed.searchParams.get('document') === 'app' ? 'app.html' : 'index.html';
    body = `<!doctype html><meta charset="utf-8"><title>Nested ancestor fixture</title>${frame('simulator', hosts[target], `/simulator/${documentName}`)}`;
  } else {fail(res); return true;}
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin'});
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function fail(res, status = 404) {
  res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(status === 404 ? 'Resource not found' : 'Method not allowed');
}

export function safeRelativePath(rawPath, prefix) {
  let decoded;
  try {decoded = decodeURIComponent(rawPath);} catch {return null;}
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) return null;
  const path = decoded.slice(prefix.length);
  if (path.startsWith('/') || path.split('/').includes('.')) return null;
  return path || 'index.html';
}

function isFingerprintAsset(relativePath) {
  return relativePath.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(relativePath);
}

const server = http.createServer(async (req, res) => {
  const rawPath = (req.url ?? '/').split(/[?#]/, 1)[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405);
  if (ancestorFixtureResponse(req, res, rawPath)) return;
  if (rawPath === '/simulator') {
    res.writeHead(308, {'Location': '/simulator/', 'Cache-Control': 'no-store'});
    return res.end();
  }
  if (rawPath === '/website-demo') {
    res.writeHead(308, {'Location': '/website-demo/', 'Cache-Control': 'no-store'});
    return res.end();
  }
  const prefix = Object.keys(roots).find(candidate => rawPath.startsWith(candidate));
  if (!prefix) return fail(res);
  const relativePath = safeRelativePath(rawPath, prefix);
  if (!relativePath) return fail(res);
  const root = roots[prefix];
  try {
    const realRoot = await realpath(root);
    const file = resolve(root, relativePath);
    const resolvedFile = await realpath(file);
    const childPath = relative(realRoot, resolvedFile);
    if (childPath === '' || childPath === '..' || childPath.startsWith(`..${sep}`) || childPath.startsWith(sep)) return fail(res);
    const body = await readFile(resolvedFile);
    const html = extname(resolvedFile).toLowerCase() === '.html';
    const simulator = prefix === '/simulator/';
    const headers = {
      'Content-Type': contentTypes.get(extname(resolvedFile).toLowerCase()) ?? 'application/octet-stream',
      'Cache-Control': html || !isFingerprintAsset(relativePath) ? 'no-store' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    };
    if (simulator) headers['Content-Security-Policy'] = await policyForRequest(req, rawPath);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    fail(res);
  }
});

const scriptPath = process.argv[1] && resolve(process.argv[1]);
if (scriptPath === resolve(fileURLToPath(import.meta.url))) {
  server.listen(port, '127.0.0.1', () => console.log(`OSI public simulator: http://127.0.0.1:${port}/simulator/`));
}
