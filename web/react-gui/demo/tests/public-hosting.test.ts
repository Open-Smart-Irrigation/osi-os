import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {safeRelativePath} from '../public/serve.mjs';

const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function cspValuesFrom(file: string): Promise<string[]> {
  const text = await readFile(path.join(guiRoot, 'demo/public', file), 'utf8');
  return [...text.matchAll(/Content-Security-Policy\s+"([^"]+)"/gi)].map(match => match[1]);
}

function frameAncestors(csp: string): string[] {
  return csp.match(/(?:^|;\s*)frame-ancestors\s+([^;]+)/i)?.[1].trim().split(/\s+/) ?? [];
}

function allowsAncestor(policy: string[], origin: string, responseOrigin: string, staging = false): boolean {
  if (policy.includes("'self'") && origin === responseOrigin) return true;
  if (policy.includes('https://opensmartirrigation.org') && origin === 'https://opensmartirrigation.org') return true;
  return staging && policy.includes('https://staging.opensmartirrigation.org') && origin === 'https://staging.opensmartirrigation.org';
}

function allowsChain(policy: string[], ancestors: string[], responseOrigin: string, staging = false): boolean {
  return ancestors.every(origin => allowsAncestor(policy, origin, responseOrigin, staging));
}

test('Apache templates scope simulator policy and permit only named ancestor origins', async () => {
  const sameValues = await cspValuesFrom('apache.conf');
  const subValues = await cspValuesFrom('apache-subdomain.conf');
  const sameOrigin = sameValues[0] ?? '';
  const subdomainStage = subValues[0] ?? '';
  const subdomainProduction = subValues[1] ?? '';
  assert.ok(sameOrigin, 'same-origin Apache configuration declares a CSP');
  assert.ok(subdomainStage, 'subdomain Apache configuration declares a staging CSP');
  assert.ok(subdomainProduction, 'subdomain Apache configuration declares a production CSP');

  for (const csp of [sameOrigin, subdomainStage, subdomainProduction]) {
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-src 'self'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /worker-src 'none'/);
  }
  const samePolicy = frameAncestors(sameOrigin);
  const subPolicyStage = frameAncestors(subdomainStage);
  const subPolicyProduction = frameAncestors(subdomainProduction);
  assert.ok(allowsAncestor(samePolicy, 'https://opensmartirrigation.org', 'https://opensmartirrigation.org'));
  assert.ok(!allowsAncestor(samePolicy, 'https://attacker.example', 'https://opensmartirrigation.org'));
  assert.ok(!samePolicy.includes('https://attacker.example'));
  assert.ok(allowsAncestor(subPolicyProduction, 'https://opensmartirrigation.org', 'https://simulator.opensmartirrigation.org'));
  assert.ok(!allowsAncestor(subPolicyProduction, 'https://attacker.example', 'https://simulator.opensmartirrigation.org'));
  assert.ok(!allowsAncestor(subPolicyProduction, 'https://staging.opensmartirrigation.org', 'https://simulator.opensmartirrigation.org'));
  assert.ok(allowsAncestor(subPolicyStage, 'https://staging.opensmartirrigation.org', 'https://simulator.opensmartirrigation.org', true));
  assert.ok(!subPolicyProduction.includes('https://staging.opensmartirrigation.org'));
  assert.ok(!subPolicyStage.includes('https://*.opensmartirrigation.org'));

  // The app HTML is nested inside the host. Its policy checks the full ancestor chain too.
  const hostAncestors = ['https://opensmartirrigation.org'];
  const appAncestors = ['https://opensmartirrigation.org', 'https://simulator.opensmartirrigation.org'];
  assert.ok(allowsChain(subPolicyProduction, hostAncestors, 'https://simulator.opensmartirrigation.org'));
  assert.ok(allowsChain(subPolicyProduction, appAncestors, 'https://simulator.opensmartirrigation.org'));
  assert.ok(!allowsChain(subPolicyProduction, ['https://attacker.example', ...appAncestors], 'https://simulator.opensmartirrigation.org'));
  assert.ok(allowsChain(samePolicy, ['https://simulator.opensmartirrigation.org'], 'https://simulator.opensmartirrigation.org'));
  assert.ok(allowsChain(samePolicy, ['https://simulator.opensmartirrigation.org', 'https://simulator.opensmartirrigation.org'], 'https://simulator.opensmartirrigation.org'));
  assert.ok(!allowsChain(samePolicy, ['https://opensmartirrigation.org', 'https://simulator.opensmartirrigation.org'], 'https://simulator.opensmartirrigation.org'));
});

test('permanent public build and server have no proxy and use the deployed base', async () => {
  const vite = await readFile(path.join(guiRoot, 'vite.demo.config.ts'), 'utf8');
  const server = await readFile(path.join(guiRoot, 'demo/public/serve.mjs'), 'utf8');
  assert.match(vite, /root:\s*publicMode\s*\?\s*resolve\('demo\/public'\)/);
  assert.match(vite, /base:\s*publicMode\s*\?\s*'\/simulator\/'/);
  assert.match(vite, /outDir:\s*publicMode\s*\?\s*resolve\('public-demo-build'\)/);
  assert.match(vite, /input:\s*publicMode\s*\?/);
  assert.doesNotMatch(vite, /proxy\s*:/);
  assert.doesNotMatch(server, /http\.request|fetch\(|proxy/i);
  assert.match(server, /127\.0\.0\.1/);
  assert.match(server, /4174/);
  assert.match(server, /connect-src 'none'/);
  assert.match(server, /frame-src 'self'/);
});

test('static roots resolve under their base and reject encoded traversal', () => {
  assert.equal(safeRelativePath('/simulator/', '/simulator/'), 'index.html');
  assert.equal(safeRelativePath('/simulator/app.html', '/simulator/'), 'app.html');
  assert.equal(safeRelativePath('/simulator/assets/app-123456789.js', '/simulator/'), 'assets/app-123456789.js');
  for (const path of [
    '/simulator/../package.json', '/simulator/%2e%2e/package.json', '/simulator/%2f%2e%2e/package.json',
    '/simulator/%5c..%5cpackage.json', '/simulator/%ZZ', '/simulator/./app.html',
  ]) assert.equal(safeRelativePath(path, '/simulator/'), null, `${path} must be rejected`);
  assert.equal(safeRelativePath('/website-demo/%2e%2e/package.json', '/website-demo/'), null);
});
