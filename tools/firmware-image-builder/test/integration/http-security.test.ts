import { once } from 'node:events';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createHttpServer,
  jsonResponse,
  type ApiRouteHandler,
  type ApiRouteContext,
} from '../../api/src/server.js';

const ORIGIN = 'http://127.0.0.1:43129';

async function start(handler: ApiRouteHandler) {
  const server = createHttpServer({ origin: ORIGIN, routeHandler: handler });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return { server, port: address.port };
}

async function stop(server: ReturnType<typeof createHttpServer>) {
  server.close();
  await once(server, 'close');
}

async function raw(port: number, target: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(response);
      if (match === null) {
        reject(new Error(`missing HTTP status in response: ${response}`));
        return;
      }
      resolve({ status: Number(match[1]), body: response });
    });
    socket.on('connect', () => socket.end([
      `GET ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')));
  });
}

describe('HTTP request-target parsing', () => {
  it.each([
    ['literal backslash', '/api\\health'],
    ['same-origin absolute-form', `${ORIGIN}/api/health`],
    ['network-path reference', '//127.0.0.1/api/health'],
    ['fragment delimiter', '/api/health#fragment'],
    ['encoded dot-segment cloud escape', '/api/%2e%2e/v1/secret'],
  ])('rejects %s before route dispatch', async (_name, target) => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await raw(port, target);
      expect(response.status).toBe(400);
      expect(response.body).toContain('"code":"INVALID_PATH"');
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('separates the raw query from the decoded path exactly once', async () => {
    let seen: ApiRouteContext | undefined;
    const { server, port } = await start((context) => {
      seen = context;
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await raw(port, '/api/%68ealth?branch=main%2Fstable&encoded=%3F');
      expect(response.status).toBe(200);
      expect(seen?.path).toBe('/api/health');
      expect(seen?.query.get('branch')).toBe('main/stable');
      expect(seen?.query.get('encoded')).toBe('?');
    } finally {
      await stop(server);
    }
  });
});
