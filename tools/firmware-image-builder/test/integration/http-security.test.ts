import { once } from 'node:events';
import { connect } from 'node:net';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createHttpServer,
  jsonResponse,
  type ApiRouteHandler,
  type ApiRouteContext,
} from '../../api/src/server.js';

const EPHEMERAL_ORIGIN = 'http://127.0.0.1:0';

function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function start(handler: ApiRouteHandler) {
  const server = createHttpServer({ origin: EPHEMERAL_ORIGIN, routeHandler: handler });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return { server, port: address.port, origin: originFor(address.port) };
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

async function rawRequest(port: number, requestText: string): Promise<{ readonly status: number; readonly body: string }> {
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
    socket.on('connect', () => socket.end(requestText));
  });
}

async function rawWithoutHalfClose(port: number, requestText: string): Promise<{ readonly status: number; readonly body: string; readonly closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('socket was not closed by the server'));
    }, 2_000);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = Buffer.concat(chunks).toString('utf8');
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(body);
      if (match === null) {
        reject(new Error(`missing HTTP status in response: ${body}`));
        return;
      }
      resolve({ status: Number(match[1]), body, closed: true });
    });
    socket.on('connect', () => socket.write(requestText));
  });
}

async function call(port: number, options: {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}): Promise<{ readonly status: number; readonly headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const requestValue = request({ host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    requestValue.on('error', reject);
    if (options.body === undefined) requestValue.end();
    else requestValue.end(options.body);
  });
}

describe('HTTP request-target parsing', () => {
  it.each([
    ['literal backslash', '/api\\health'],
    ['same-origin absolute-form', 'http://127.0.0.1:43129/api/health'],
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

  it('uses the actual listener port for mutation and preflight origins', async () => {
    const { server, port, origin } = await start(() => jsonResponse(200, { ok: true }));
    try {
      const accepted = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin, 'content-type': 'application/json' }, body: '{}',
      });
      expect(accepted.status).toBe(200);

      const rejected = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin: EPHEMERAL_ORIGIN, 'content-type': 'application/json' }, body: '{}',
      });
      expect(rejected.status).toBe(403);

      const preflight = await call(port, {
        method: 'OPTIONS', path: '/api/jobs',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    } finally {
      await stop(server);
    }
  });

  it('rejects HTTPS and mismatched configured origins', async () => {
    expect(() => createHttpServer({ origin: 'https://127.0.0.1:43129', routeHandler: () => jsonResponse(200, {}) })).toThrow();
    const server = createHttpServer({ origin: 'http://127.0.0.1:43129', routeHandler: () => jsonResponse(200, {}) });
    expect(() => server.listen(43130)).toThrow(/origin port/iu);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('rejects a zero Content-Length on %s before route dispatch', async (method) => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await rawRequest(port, [
        `${method} /api/health HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Length: 0',
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      expect(response.status).toBe(400);
      if (method !== 'HEAD') expect(response.body).toContain('"code":"BODY_NOT_ALLOWED"');
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('rejects Transfer-Encoding on %s before route dispatch', async (method) => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await rawRequest(port, [
        `${method} /api/health HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '0',
        '',
        '',
      ].join('\r\n'));
      expect(response.status).toBe(400);
      if (method !== 'HEAD') expect(response.body).toContain('"code":"BODY_NOT_ALLOWED"');
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('drains and closes an unread mutation body when origin validation rejects it', async () => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await rawRequest(port, [
        'POST /api/jobs HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Origin: https://evil.example',
        'Content-Type: application/json',
        'Content-Length: 2',
        'Connection: keep-alive',
        '',
        '{}',
      ].join('\r\n'));
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/connection: close/iu);
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('drains and closes framed %s with an invalid Host without returning a pipelined response', async (method) => {
    const { server, port } = await start(() => {
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await rawWithoutHalfClose(port, [
        `${method} /api/health HTTP/1.1`,
        'Host: 127.0.0.1:1',
        'Content-Length: 4',
        'Connection: keep-alive',
        '',
        'body',
        'GET /api/health HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      expect(response.status).toBe(400);
      expect(response.body).not.toContain('HTTP/1.1 200');
      expect(response.closed).toBe(true);
    } finally {
      await stop(server);
    }
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('drains and closes framed %s with an invalid path without returning a pipelined response', async (method) => {
    const { server, port } = await start(() => {
      return jsonResponse(200, { ok: true });
    });
    try {
      const response = await rawWithoutHalfClose(port, [
        `${method} /api/% HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Length: 4',
        'Connection: keep-alive',
        '',
        'body',
        'GET /api/health HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      expect(response.status).toBe(400);
      expect(response.body).not.toContain('HTTP/1.1 200');
      expect(response.closed).toBe(true);
    } finally {
      await stop(server);
    }
  });
});
