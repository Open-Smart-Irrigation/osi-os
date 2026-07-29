import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStaticUiService, type StaticUiService } from '../../api/src/static-ui.js';
import { createHttpServer, jsonResponse, type ApiRouteHandler } from '../../api/src/server.js';

const servers: ReturnType<typeof createHttpServer>[] = [];
const services: StaticUiService[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    await once(server, 'close');
  }
  for (const service of services.splice(0)) service.close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'osi-static-http-'));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><main>builder</main>');
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log("builder");');
  return dist;
}

async function start(handler: ApiRouteHandler, ui?: StaticUiService) {
  const server = createHttpServer({
    origin: 'http://127.0.0.1:0',
    routeHandler: handler,
    ...(ui === undefined ? {} : { staticUi: ui }),
  });
  servers.push(server);
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing server address');
  return address.port;
}

async function call(port: number, path: string, method = 'GET') {
  return new Promise<{
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: Buffer;
  }>((resolve, reject) => {
    const target = request({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    target.on('error', reject);
    target.end();
  });
}

describe('same-origin static UI serving', () => {
  it('serves the production UI and assets with API route precedence', async () => {
    const ui = createStaticUiService(await fixture());
    services.push(ui);
    const port = await start((context) => (
      context.path === '/api/health' ? jsonResponse(200, { status: 'ok' }) : null
    ), ui);

    const index = await call(port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.body.toString('utf8')).toContain('<main>builder</main>');

    const asset = await call(port, '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const api = await call(port, '/api/health');
    expect(api.status).toBe(200);
    expect(api.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(api.body.toString('utf8'))).toEqual({ status: 'ok' });
  });

  it('supports HEAD and returns JSON 404 for missing or disallowed assets', async () => {
    const ui = createStaticUiService(await fixture());
    services.push(ui);
    const port = await start(() => null, ui);

    const head = await call(port, '/assets/app.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);

    const missing = await call(port, '/assets/missing.js');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(missing.body.toString('utf8'))).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const arbitrary = await call(port, '/README.md');
    expect(arbitrary.status).toBe(404);
  });

  it('rejects traversal before static resolution and does not serve UI unless configured', async () => {
    const ui = createStaticUiService(await fixture());
    services.push(ui);
    const protectedPort = await start(() => null, ui);
    expect((await call(protectedPort, '/assets/%2e%2e/index.html')).status).toBe(400);
    expect((await call(protectedPort, '/assets/%2fetc%2fpasswd')).status).toBe(400);
    const doubleEncoded = await call(protectedPort, '/assets/%252e%252e/index.html');
    expect(doubleEncoded.status).toBe(400);
    expect(JSON.parse(doubleEncoded.body.toString('utf8'))).toMatchObject({ error: { code: 'INVALID_PATH' } });

    const apiOnlyPort = await start(() => null);
    const response = await call(apiOnlyPort, '/');
    expect(response.status).toBe(404);
  });
});
