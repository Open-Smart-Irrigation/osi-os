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

async function call(port: number, options: {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}) {
  const response = await new Promise<{
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: string;
  }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/api/health',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
  return { ...response, json: response.body.length === 0 ? null : JSON.parse(response.body) as unknown };
}

async function stop(server: ReturnType<typeof createHttpServer>) {
  server.close();
  await once(server, 'close');
}

async function raw(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('connect', () => socket.end(input));
  });
}

describe('loopback HTTP security boundary', () => {
  it('binds loopback-only and dispatches a request with a request ID', async () => {
    let seen: ApiRouteContext | undefined;
    const { server, port } = await start((context) => {
      seen = context;
      return jsonResponse(200, { ok: true });
    });

    try {
      const response = await call(port, { path: '/api/health' });
      expect(response.status).toBe(200);
      expect(response.json).toEqual({ ok: true });
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['x-request-id']).toMatch(/^req_/);
      expect(seen?.requestId).toBe(response.headers['x-request-id']);
      expect(seen?.path).toBe('/api/health');
      expect(seen?.method).toBe('GET');
      expect(server.address()).toMatchObject({ address: '127.0.0.1' });
    } finally {
      await stop(server);
    }
  });

  it('requires the exact origin and JSON media type for mutations', async () => {
    const { server, port, origin } = await start(() => jsonResponse(200, { accepted: true }));
    try {
      const foreign = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
      });
      expect(foreign.status).toBe(403);
      expect(foreign.json).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });

      const missing = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(missing.status).toBe(403);
      expect(missing.json).toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });

      const mediaType = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin, 'content-type': 'text/plain' }, body: '{}',
      });
      expect(mediaType.status).toBe(415);
      expect(mediaType.json).toMatchObject({ error: { code: 'JSON_REQUIRED' } });
    } finally {
      await stop(server);
    }
  });

  it('parses bounded JSON and rejects malformed or oversized bodies', async () => {
    const seen: unknown[] = [];
    const { server, port, origin } = await start((context) => {
      seen.push(context.body);
      return jsonResponse(200, { accepted: true });
    });
    try {
      const valid = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin, 'content-type': 'application/json' }, body: '{"branch":"main"}',
      });
      expect(valid.status).toBe(200);
      expect(seen).toEqual([{ branch: 'main' }]);

      const malformed = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin, 'content-type': 'application/json' }, body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(malformed.json).toMatchObject({ error: { code: 'INVALID_JSON' } });

      const oversized = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(70_000) }),
      });
      expect(oversized.status).toBe(413);
      expect(oversized.json).toMatchObject({ error: { code: 'BODY_TOO_LARGE' } });
    } finally {
      await stop(server);
    }
  });

  it('returns stable redacted errors and does not serve arbitrary paths', async () => {
    const { server, port } = await start(() => {
      throw new Error('secret /srv/node-red/flows.json stack trace');
    });
    try {
      const internal = await call(port, { path: '/api/health' });
      expect(internal.status).toBe(500);
      expect(internal.json).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
      expect(JSON.stringify(internal.json)).not.toContain('secret');
      expect(JSON.stringify(internal.json)).not.toContain('/srv');
      expect(JSON.stringify(internal.json)).not.toContain('stack trace');
      expect(internal.json).toMatchObject({ error: { requestId: internal.headers['x-request-id'] } });

      const staticPath = await call(port, { path: '/index.html' });
      expect(staticPath.status).toBe(404);
      expect(staticPath.json).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await stop(server);
    }
  });

  it('handles same-origin preflight without exposing a static or cloud route', async () => {
    const { server, port, origin } = await start(() => jsonResponse(200, { ok: true }));
    try {
      const preflight = await call(port, {
        method: 'OPTIONS', path: '/api/jobs',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.body).toBe('');
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);

      const cloud = await call(port, { path: '/api/v1/sync/gateways/eui/status' });
      expect(cloud.status).toBe(404);
      expect((await call(port, { path: '/api/v1' })).status).toBe(404);

      const unsupported = await call(port, { method: 'PUT', path: '/api/jobs' });
      expect(unsupported.status).toBe(405);
      expect(unsupported.json).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
    } finally {
      await stop(server);
    }
  });

  it('requires the exact loopback Host for the bound local port and rejects foreign absolute URLs', async () => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      expect((await call(port, { headers: { host: `127.0.0.1:${port - 1}` } })).status).toBe(400);
      expect((await call(port, { headers: { host: 'localhost' } })).status).toBe(400);
      expect((await raw(port, 'GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n'))).toMatch(/^HTTP\/1\.1 400 /u);
      expect((await call(port, { path: 'http://evil.example/api/health' })).status).toBe(400);
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('rejects duplicate Host header lines regardless of their ordering', async () => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      const first = await raw(port, [
        'GET /api/health HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Host: 127.0.0.1:1',
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      const second = await raw(port, [
        'GET /api/health HTTP/1.1',
        'Host: 127.0.0.1:1',
        `hOsT: 127.0.0.1:${port}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));

      expect(first).toMatch(/^HTTP\/1\.1 400 /u);
      expect(second).toMatch(/^HTTP\/1\.1 400 /u);
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('decodes the pathname once before routing and reserves encoded cloud paths', async () => {
    const seen: string[] = [];
    let dispatched = 0;
    const { server, port, origin } = await start((context) => {
      dispatched += 1;
      seen.push(context.path);
      return jsonResponse(200, { ok: true });
    });
    try {
      const decoded = await call(port, { path: '/api/%68ealth' });
      expect(decoded.status).toBe(200);
      expect(seen).toEqual(['/api/health']);

      const reserved = await Promise.all([
        call(port, { path: '/api/%76%31' }),
        call(port, { path: '/api/%76%31/secret' }),
        call(port, { path: '/api/v1%2Fsecret' }),
      ]);
      expect(reserved.map((response) => response.status)).toEqual([404, 404, 404]);
      expect(reserved.map((response) => response.json)).toEqual([
        { error: expect.objectContaining({ code: 'NOT_FOUND' }) },
        { error: expect.objectContaining({ code: 'NOT_FOUND' }) },
        { error: expect.objectContaining({ code: 'NOT_FOUND' }) },
      ]);
      expect(dispatched).toBe(1);
    } finally {
      await stop(server);
    }
  });

  it('rejects malformed or unsafe decoded pathnames without dispatch', async () => {
    let dispatched = 0;
    const { server, port } = await start(() => {
      dispatched += 1;
      return jsonResponse(200, { ok: true });
    });
    try {
      const responses = await Promise.all([
        call(port, { path: '/api/%' }),
        call(port, { path: '/api/%80' }),
        call(port, { path: '/api/%00' }),
        call(port, { path: '/api/%0A' }),
        call(port, { path: '/api/%5Csecret' }),
        call(port, { path: '/api/v1%3F/secret' }),
        call(port, { path: '/api/%68ealth%3Fshadow?real=1' }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
      expect(responses.map((response) => response.json)).toEqual([
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
        { error: expect.objectContaining({ code: 'INVALID_PATH' }) },
      ]);
      expect(dispatched).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('accepts only numeric TCP listen ports and reports listener errors', async () => {
    expect(() => createHttpServer({ origin: 'https://127.0.0.1:43129', routeHandler: () => jsonResponse(200, {}) })).toThrow(/loopback HTTP origin/iu);
    expect(() => createHttpServer({ origin: 'http://127.0.0.1', routeHandler: () => jsonResponse(200, {}) })).toThrow(/loopback HTTP origin/iu);
    expect(() => createHttpServer({ origin: 'http://127.0.0.1:65536', routeHandler: () => jsonResponse(200, {}) })).toThrow(/loopback HTTP origin/iu);
    const server = createHttpServer({ origin: EPHEMERAL_ORIGIN, routeHandler: () => jsonResponse(200, {}) });
    expect(() => server.listen('/tmp/osi-image-builder.sock' as never)).toThrow();
    expect(() => server.listen({ port: 0 } as never)).toThrow();
    expect(() => server.listen(0, 128 as never)).toThrow();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => resolve());
    });
    const address = server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    if (address === null || typeof address === 'string') throw new Error('server did not bind to a TCP port');

    const conflicting = createHttpServer({ origin: `http://127.0.0.1:${address.port}`, routeHandler: () => jsonResponse(200, {}) });
    const listenerErrorPromise = once(conflicting, 'error');
    conflicting.listen(address.port);
    const [listenerError] = await listenerErrorPromise as [NodeJS.ErrnoException];
    expect(listenerError.code).toBe('EADDRINUSE');
    await stop(server);
  });

  it('requires the configured origin port to match a nonzero listen port before binding', () => {
    const server = createHttpServer({ origin: 'http://127.0.0.1:43129', routeHandler: () => jsonResponse(200, {}) });
    expect(() => server.listen(43130)).toThrow(/origin port/iu);
  });

  it('uses the actual listener port for same-origin mutations and preflight', async () => {
    const { server, port, origin } = await start(() => jsonResponse(200, { ok: true }));
    try {
      const accepted = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin, 'content-type': 'application/json' }, body: '{}',
      });
      expect(accepted.status).toBe(200);

      const stale = await call(port, {
        method: 'POST', path: '/api/jobs',
        headers: { origin: EPHEMERAL_ORIGIN, 'content-type': 'application/json' }, body: '{}',
      });
      expect(stale.status).toBe(403);
      expect(stale.json).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });

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
});
