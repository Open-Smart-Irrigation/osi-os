import { createRequire } from 'node:module';
import { request } from 'node:http';
import { connect as connectHttp2 } from 'node:http2';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createDependencyEgressTlsMaterial } from '../../runner/src/dependency-egress-tls.js';

const require = createRequire(import.meta.url);

interface RuntimePolicy {
  readonly DEPENDENCY_PROXY_LIMITS: Readonly<{
    readonly globalConnections: number;
    readonly http2ConcurrentStreams: number;
    readonly maxRequestBodyBytes: number;
    readonly maxHeaderBytes: number;
    readonly headersTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly upstreamTimeoutMs: number;
    readonly tlsClientHelloTimeoutMs: number;
  }>;
  readonly createDependencyProxyServer: (options: Readonly<{
    allowedHosts: readonly string[];
    credential: string;
    lookup: (host: string) => Promise<readonly { readonly address: string; readonly family: number }[]>;
    verifyTls?: (destination: Readonly<{ readonly host: string; readonly address: string; readonly family: 4 | 6; readonly port: number }>) => Promise<void>;
    tls?: Readonly<{ certificates: Readonly<Record<string, Readonly<{ cert: string; key: string }>>> }>;
  }>) => import('node:http').Server & Readonly<{
    activeDependencyConnections: () => number;
    cancelDependencyConnections: () => void;
  }>;
  readonly proxyAuthorization: (credential: string) => string;
  readonly validProxyAuthorization: (header: string | undefined, credential: string) => boolean;
  readonly parseTlsClientHelloServerName: (bytes: Buffer) => string;
  readonly resolveDependencyDestination: (
    request: Readonly<{
      allowedHosts: readonly string[];
      host: string;
      port: number;
      tlsServerName: string | null;
    }>,
    lookup: (host: string) => Promise<readonly { readonly address: string; readonly family: number }[]>,
  ) => Promise<Readonly<{ host: string; address: string; family: 4 | 6; port: number }>>;
  readonly redirectIsAllowed: (response: Readonly<{ statusCode: number; headers: Readonly<{ location?: string | string[] }> }>, selected: Readonly<{ host: string }>, allowedHosts: readonly string[]) => boolean;
  readonly validateRequestAuthority: (input: Readonly<Record<string, unknown>>) => Readonly<{ host: string; port: 443 }>;
  readonly sanitizeHopByHopHeaders: (headers: Readonly<Record<string, string | readonly string[] | undefined>>) => Readonly<Record<string, string | readonly string[]>>;
  readonly validateRequestFraming: (input: Readonly<{
    protocol: 'http/1.1' | 'h2';
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    rawHeaders?: readonly string[];
  }>) => Readonly<{ contentLength: number }>;
  readonly validateResponseFraming: (input: Readonly<{
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    rawHeaders: readonly string[];
  }>) => void;
}

function runtime(): RuntimePolicy {
  return require('../../builder/operations/osi-dependency-egress-proxy.cjs') as RuntimePolicy;
}

function serverNameExtension(entries: readonly Readonly<{ type: number; name: Buffer }>[]): Buffer {
  const serverNameEntries = entries.map(({ type, name }) => Buffer.concat([
    Buffer.from([type]),
    Buffer.from([name.length >>> 8, name.length & 0xff]),
    name,
  ]));
  const serverNameList = Buffer.concat([
    Buffer.from([
      Buffer.concat(serverNameEntries).length >>> 8,
      Buffer.concat(serverNameEntries).length & 0xff,
    ]),
    ...serverNameEntries,
  ]);
  return Buffer.concat([
    Buffer.from([0, 0, serverNameList.length >>> 8, serverNameList.length & 0xff]),
    serverNameList,
  ]);
}

function alpnExtension(protocols: readonly string[]): Buffer {
  const protocolList = Buffer.concat(protocols.map((protocol) => {
    const bytes = Buffer.from(protocol, 'ascii');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  }));
  return Buffer.concat([
    Buffer.from([0, 16, (protocolList.length + 2) >>> 8, (protocolList.length + 2) & 0xff]),
    Buffer.from([protocolList.length >>> 8, protocolList.length & 0xff]),
    protocolList,
  ]);
}

function clientHelloWithExtensions(extensionsValue: readonly Buffer[]): Buffer {
  const extensionBytes = Buffer.concat(extensionsValue);
  const extensions = Buffer.concat([
    Buffer.from([extensionBytes.length >>> 8, extensionBytes.length & 0xff]),
    extensionBytes,
  ]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 1),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    extensions,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([1, body.length >>> 16, (body.length >>> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  return Buffer.concat([
    Buffer.from([0x16, 3, 1, handshake.length >>> 8, handshake.length & 0xff]),
    handshake,
  ]);
}

function clientHello(serverName: string): Buffer {
  return clientHelloWithExtensions([
    serverNameExtension([{ type: 0, name: Buffer.from(serverName, 'ascii') }]),
  ]);
}

describe('tool-owned dependency egress proxy runtime', () => {
  it('pins immutable connection, stream, size, and timeout budgets', () => {
    expect(Object.isFrozen(runtime().DEPENDENCY_PROXY_LIMITS)).toBe(true);
    expect(runtime().DEPENDENCY_PROXY_LIMITS).toEqual({
      globalConnections: 64,
      http2ConcurrentStreams: 16,
      maxRequestBodyBytes: 8 * 1024 * 1024,
      maxHeaderBytes: 32 * 1024,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
      upstreamTimeoutMs: 30_000,
      tlsClientHelloTimeoutMs: 10_000,
    });
  });

  it('drops connections beyond the global budget and cancels all active sockets', async () => {
    const server = runtime().createDependencyProxyServer({
      allowedHosts: ['registry.npmjs.org'],
      credential: '0123456789abcdef0123456789abcdef0123456789abcdef',
      lookup: vi.fn(),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    const sockets: import('node:net').Socket[] = [];
    try {
      for (let index = 0; index < runtime().DEPENDENCY_PROXY_LIMITS.globalConnections; index += 1) {
        const socket = connect(address.port, '127.0.0.1');
        await once(socket, 'connect');
        sockets.push(socket);
      }
      expect(server.activeDependencyConnections()).toBe(runtime().DEPENDENCY_PROXY_LIMITS.globalConnections);

      const saturated = connect(address.port, '127.0.0.1');
      await once(saturated, 'connect');
      await Promise.race([
        once(saturated, 'close'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('saturated proxy connection was not dropped')), 1_000)),
      ]);
      expect(server.activeDependencyConnections()).toBe(runtime().DEPENDENCY_PROXY_LIMITS.globalConnections);

      const closed = sockets.map((socket) => once(socket, 'close'));
      server.cancelDependencyConnections();
      await Promise.all(closed);
      expect(server.activeDependencyConnections()).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    }
  });

  it('requires the exact per-operation credential without exposing it in the proxy URL', () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const authorization = runtime().proxyAuthorization(credential);
    expect(authorization).toMatch(/^Basic /u);
    expect(runtime().validProxyAuthorization(undefined, credential)).toBe(false);
    expect(runtime().validProxyAuthorization('Basic bad', credential)).toBe(false);
    expect(runtime().validProxyAuthorization(authorization, credential)).toBe(true);
  });

  it('authenticates readiness and rejects a CONNECT SNI alias before resolution', async () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    const server = runtime().createDependencyProxyServer({
      allowedHosts: ['registry.npmjs.org'],
      credential,
      lookup,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');

    const readiness = (authorization?: string) => new Promise<number>((resolve, reject) => {
      const call = request({
        host: '127.0.0.1',
        port: address.port,
        method: 'GET',
        path: 'http://osi-proxy.invalid/ready',
        headers: authorization === undefined ? {} : { 'proxy-authorization': authorization },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      call.once('error', reject);
      call.end();
    });

    try {
      await expect(readiness()).resolves.toBe(407);
      await expect(readiness(runtime().proxyAuthorization(credential))).resolves.toBe(204);

      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, '127.0.0.1', () => {
          socket.write([
            'CONNECT registry.npmjs.org:443 HTTP/1.1',
            'Host: registry.npmjs.org:443',
            `Proxy-Authorization: ${runtime().proxyAuthorization(credential)}`,
            '',
            '',
          ].join('\r\n'));
        });
        let received = '';
        let tunnelEstablished = false;
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          received += chunk;
          if (!tunnelEstablished && received.includes('200 Connection Established')) {
            tunnelEstablished = true;
            received = '';
            socket.write(clientHello('osicloud.ch'));
          }
          if (received.includes('403 Forbidden')) {
            socket.end();
            resolve(received);
          }
        });
        socket.once('error', reject);
        socket.setTimeout(3_000, () => reject(new Error('proxy CONNECT test timed out')));
      });
      expect(response).toContain('403 Forbidden');
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('upgrades legacy HTTP locally and does not send branch bytes to the resolved endpoint', async () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    const verifyTls = vi.fn();
    const server = runtime().createDependencyProxyServer({ allowedHosts: ['registry.npmjs.org'], credential, lookup, verifyTls });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    try {
      const response = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
        const call = request({
          host: '127.0.0.1', port: address.port, method: 'GET', path: 'http://registry.npmjs.org/package',
          headers: { 'proxy-authorization': runtime().proxyAuthorization(credential) },
        }, (incoming) => {
          incoming.resume();
          incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, location: incoming.headers.location }));
        });
        call.once('error', reject);
        call.end();
      });
      expect(response).toEqual({ status: 308, location: 'https://registry.npmjs.org/package' });
      expect(lookup).toHaveBeenCalledOnce();
      expect(verifyTls).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects every explicit non-80 plain HTTP port without opening an upstream connection', async () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    const verifyTls = vi.fn();
    const server = runtime().createDependencyProxyServer({ allowedHosts: ['registry.npmjs.org'], credential, lookup, verifyTls });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    try {
      for (const port of [443, 8080]) {
        const status = await new Promise<number>((resolve, reject) => {
          const call = request({
            host: '127.0.0.1', port: address.port, method: 'GET', path: `http://registry.npmjs.org:${port}/package`,
            headers: { 'proxy-authorization': runtime().proxyAuthorization(credential) },
          }, (incoming) => {
            incoming.resume();
            incoming.once('end', () => resolve(incoming.statusCode ?? 0));
          });
          call.once('error', reject);
          call.end();
        });
        expect(status, String(port)).toBe(403);
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(verifyTls).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects a public DNS alias when the selected endpoint cannot prove the allowlisted certificate', async () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn().mockResolvedValue([{ address: '203.1.2.3', family: 4 }]);
    const verifyTls = vi.fn().mockRejectedValue(new Error('certificate mismatch'));
    const server = runtime().createDependencyProxyServer({ allowedHosts: ['registry.npmjs.org'], credential, lookup, verifyTls });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, '127.0.0.1', () => socket.write([
          'CONNECT registry.npmjs.org:443 HTTP/1.1',
          'Host: registry.npmjs.org:443',
          `Proxy-Authorization: ${runtime().proxyAuthorization(credential)}`,
          '', '',
        ].join('\r\n')));
        let received = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          received += chunk;
          if (received.includes('200 Connection Established')) {
            received = '';
            socket.write(clientHello('registry.npmjs.org'));
          } else if (received.includes('403 Forbidden')) {
            socket.end();
            resolve(received);
          }
        });
        socket.once('error', reject);
        socket.setTimeout(3_000, () => reject(new Error('proxy certificate ownership test timed out')));
      });
      expect(response).toContain('403 Forbidden');
      expect(verifyTls).toHaveBeenCalledWith({ host: 'registry.npmjs.org', address: '203.1.2.3', family: 4, port: 443 });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('parses the exact SNI from a byte-level TLS ClientHello', () => {
    expect(runtime().parseTlsClientHelloServerName(clientHello('registry.npmjs.org')))
      .toBe('registry.npmjs.org');
    expect(() => runtime().parseTlsClientHelloServerName(Buffer.from('not tls')))
      .toThrow(/clienthello|tls/iu);
    expect(() => runtime().parseTlsClientHelloServerName(clientHello('Registry.npmjs.org')))
      .toThrow(/clienthello|server name|canonical|tls/iu);
    expect(() => runtime().parseTlsClientHelloServerName(clientHello('registry.npmjs.org.')))
      .toThrow(/clienthello|server name|canonical|tls/iu);
  });

  it('rejects a CONNECT Host field that does not byte-match the request authority', async () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn();
    const server = runtime().createDependencyProxyServer({ allowedHosts: ['registry.npmjs.org'], credential, lookup });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, '127.0.0.1', () => socket.write([
          'CONNECT registry.npmjs.org:443 HTTP/1.1',
          'Host: evil.example:443',
          `Proxy-Authorization: ${runtime().proxyAuthorization(credential)}`,
          '', '',
        ].join('\r\n')));
        let received = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          received += chunk;
          if (received.includes('\r\n\r\n')) {
            socket.end();
            resolve(received);
          }
        });
        socket.once('error', reject);
        socket.setTimeout(1_000, () => reject(new Error('CONNECT Host mismatch test timed out')));
      });
      expect(response).toContain('403 Forbidden');
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects ECH ClientHello extensions before any upstream lookup', () => {
    const ech = Buffer.from([0xfe, 0x0d, 0, 1, 0]);
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      serverNameExtension([{ type: 0, name: Buffer.from('registry.npmjs.org', 'ascii') }]), ech,
    ]))).toThrow(/encrypted client hello|ECH/iu);
  });

  it('accepts only the terminated HTTP protocols when ALPN is explicitly advertised', () => {
    const sni = serverNameExtension([{ type: 0, name: Buffer.from('registry.npmjs.org', 'ascii') }]);
    expect(runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      sni,
      alpnExtension(['h2', 'http/1.1']),
    ]))).toBe('registry.npmjs.org');
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      sni,
      alpnExtension(['spdy/3.1']),
    ]))).toThrow(/ALPN|protocol|clienthello/iu);
  });

  it('allows only HTTPS redirects to an immutable allowlisted host', () => {
    const selected = { host: 'registry.npmjs.org' };
    expect(runtime().redirectIsAllowed({ statusCode: 302, headers: { location: 'https://registry.npmjs.org/next' } }, selected, ['registry.npmjs.org'])).toBe(true);
    expect(runtime().redirectIsAllowed({ statusCode: 302, headers: { location: 'https://evil.example/' } }, selected, ['registry.npmjs.org'])).toBe(false);
    expect(runtime().redirectIsAllowed({ statusCode: 302, headers: { location: 'http://registry.npmjs.org/' } }, selected, ['registry.npmjs.org'])).toBe(false);
    expect(runtime().redirectIsAllowed({ statusCode: 302, headers: { location: 'https://registry.npmjs.org./' } }, selected, ['registry.npmjs.org'])).toBe(false);
    expect(runtime().redirectIsAllowed({ statusCode: 302, headers: { location: 'https://%72egistry.npmjs.org/' } }, selected, ['registry.npmjs.org'])).toBe(false);
  });

  it.each(['registry.npmjs.org', 'registry.npmjs.org:443'])('accepts the same raw canonical authority in HTTP/1.1 and HTTP/2: %s', (authority) => {
    expect(runtime().validateRequestAuthority({ protocol: 'http/1.1', host: authority, expectedHost: 'registry.npmjs.org' })).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(runtime().validateRequestAuthority({ protocol: 'h2', authority, expectedHost: 'registry.npmjs.org' })).toEqual({ host: 'registry.npmjs.org', port: 443 });
  });

  it.each([
    'registry%2enpmjs.org',
    '%72egistry.npmjs.org',
    'registry.npmjs.org.',
    'REGISTRY.npmjs.org',
    'registry.npmjs.org:0443',
    'registry.npmjs.org:443 ',
    ' registry.npmjs.org',
  ])('rejects the same noncanonical raw authority in HTTP/1.1 and HTTP/2: %s', (authority) => {
    expect(() => runtime().validateRequestAuthority({ protocol: 'http/1.1', host: authority, expectedHost: 'registry.npmjs.org' })).toThrow(/authority|host|denied/iu);
    expect(() => runtime().validateRequestAuthority({ protocol: 'h2', authority, expectedHost: 'registry.npmjs.org' })).toThrow(/authority|host|denied/iu);
  });

  it('rejects an HTTP/2 Host field that conflicts with :authority', () => {
    expect(() => runtime().validateRequestAuthority({
      protocol: 'h2',
      authority: 'registry.npmjs.org',
      host: 'evil.example',
      expectedHost: 'registry.npmjs.org',
    })).toThrow(/authority|host|denied/iu);
  });

  it('terminates a negotiated HTTP/2 tunnel and validates :authority before lookup', async () => {
    const bounded = <T>(promise: Promise<T>, stage: string) => Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`HTTP/2 transport stalled at ${stage}`)), 2_000)),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-h2-'));
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const material = await createDependencyEgressTlsMaterial({
      credentialHostPath: join(directory, 'frontend-install-1.proxy-credential'),
      jobId: 'job-1', operationId: 'frontend-install', attempt: 1, allowedHosts: ['registry.npmjs.org'],
    });
    const leaf = material.leafCertificates['registry.npmjs.org']!;
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    const server = runtime().createDependencyProxyServer({
      allowedHosts: ['registry.npmjs.org'], credential, lookup,
      verifyTls: vi.fn().mockResolvedValue(undefined),
      tls: { certificates: { 'registry.npmjs.org': { cert: await readFile(leaf.certificateHostPath, 'utf8'), key: await readFile(leaf.keyHostPath, 'utf8') } } },
    });
    server.listen(0, '127.0.0.1');
    await bounded(once(server, 'listening'), 'proxy listen');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    let session: ReturnType<typeof connectHttp2> | null = null;
    try {
      const tunnel = connect(address.port, '127.0.0.1');
      await bounded(once(tunnel, 'connect'), 'CONNECT socket');
      tunnel.write(['CONNECT registry.npmjs.org:443 HTTP/1.1', 'Host: registry.npmjs.org:443', `Proxy-Authorization: ${runtime().proxyAuthorization(credential)}`, '', ''].join('\r\n'));
      let response = '';
      while (!response.includes('\r\n\r\n')) response += String((await bounded(once(tunnel, 'data'), 'CONNECT response'))[0]);
      expect(response).toContain('200 Connection Established');
      const secure = connectTls({ socket: tunnel, servername: 'registry.npmjs.org', ca: await readFile(material.caCertificateHostPath), ALPNProtocols: ['h2'] });
      await bounded(once(secure, 'secureConnect'), 'TLS secureConnect');
      expect(secure.alpnProtocol).toBe('h2');
      session = connectHttp2('https://registry.npmjs.org', { createConnection: () => secure });
      await bounded(once(session, 'connect'), 'HTTP/2 session connect');
      const stream = session.request({ ':method': 'GET', ':scheme': 'https', ':path': '/', ':authority': 'registry.npmjs.org', host: 'evil.example' });
      const [headers] = await bounded(once(stream, 'response'), 'HTTP/2 response');
      stream.resume();
      await bounded(once(stream, 'end'), 'HTTP/2 response end');
      expect(headers[':status']).toBe(403);
      expect(lookup).toHaveBeenCalledOnce();

      let releaseLookups!: () => void;
      const heldLookup = new Promise<readonly { address: string; family: number }[]>((resolve) => {
        releaseLookups = () => resolve([{ address: '104.16.30.34', family: 4 }]);
      });
      lookup.mockImplementation(() => heldLookup);
      expect(session.remoteSettings.maxConcurrentStreams).toBe(runtime().DEPENDENCY_PROXY_LIMITS.http2ConcurrentStreams);
      const saturatedStreams = Array.from({ length: runtime().DEPENDENCY_PROXY_LIMITS.http2ConcurrentStreams + 1 }, () => {
        const request = session!.request({ ':method': 'GET', ':scheme': 'https', ':path': '/', ':authority': 'registry.npmjs.org' });
        request.on('error', () => undefined);
        request.end();
        return request;
      });
      await bounded(new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1_000;
        const inspect = () => {
          if (lookup.mock.calls.length === 1 + runtime().DEPENDENCY_PROXY_LIMITS.http2ConcurrentStreams) resolve();
          else if (Date.now() >= deadline) reject(new Error('HTTP/2 stream limit was not reached'));
          else setTimeout(inspect, 10);
        };
        inspect();
      }), 'HTTP/2 stream saturation');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lookup).toHaveBeenCalledTimes(1 + runtime().DEPENDENCY_PROXY_LIMITS.http2ConcurrentStreams);
      for (const request of saturatedStreams) request.destroy();
      session.destroy();
      secure.destroy();
      tunnel.destroy();
      server.cancelDependencyConnections();
      releaseLookups();
      expect(server.activeDependencyConnections()).toBe(0);
    } finally {
      session?.destroy();
      server.cancelDependencyConnections();
      server.close();
      await bounded(once(server, 'close'), 'proxy close');
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('strips the complete hop-by-hop set and every Connection-listed field in either direction', () => {
    const sanitized = runtime().sanitizeHopByHopHeaders({
      connection: 'keep-alive, X-Remove',
      'x-remove': 'secret',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      'proxy-authenticate': 'Basic realm=test',
      'proxy-authorization': 'Basic secret',
      te: 'trailers',
      trailer: 'digest',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'content-type': 'application/octet-stream',
      'x-keep': ['one', 'two'],
    });
    expect(sanitized).toEqual({ 'content-type': 'application/octet-stream', 'x-keep': ['one', 'two'] });
    expect(() => runtime().sanitizeHopByHopHeaders({ connection: 'valid, invalid token', 'x-keep': 'value' })).toThrow(/connection|header|token/iu);
  });

  it.each(['http/1.1', 'h2'] as const)('rejects ambiguous or oversized %s request framing', (protocol) => {
    const frame = (headers: Readonly<Record<string, string | readonly string[]>>, rawHeaders?: readonly string[]) => runtime().validateRequestFraming({ protocol, headers, rawHeaders });
    expect(frame({ 'content-length': '0' }, protocol === 'http/1.1' ? ['Content-Length', '0'] : undefined)).toEqual({ contentLength: 0 });
    expect(frame({ 'content-length': '8388608' }, protocol === 'http/1.1' ? ['Content-Length', '8388608'] : undefined)).toEqual({ contentLength: 8 * 1024 * 1024 });
    expect(() => frame({ 'content-length': '1', 'transfer-encoding': 'chunked' }, protocol === 'http/1.1' ? ['Content-Length', '1', 'Transfer-Encoding', 'chunked'] : undefined)).toThrow(/framing|transfer|length/iu);
    expect(() => frame({ 'content-length': ['1', '1'] }, protocol === 'http/1.1' ? ['Content-Length', '1', 'Content-Length', '1'] : undefined)).toThrow(/framing|length/iu);
    expect(() => frame({ 'content-length': '01' }, protocol === 'http/1.1' ? ['Content-Length', '01'] : undefined)).toThrow(/framing|length/iu);
    expect(() => frame({ 'content-length': '8388609' }, protocol === 'http/1.1' ? ['Content-Length', '8388609'] : undefined)).toThrow(/body|framing|length|large/iu);
    expect(() => frame({ 'transfer-encoding': 'chunked' }, protocol === 'http/1.1' ? ['Transfer-Encoding', 'chunked'] : undefined)).toThrow(/framing|transfer/iu);
  });

  it('rejects ambiguous upstream response framing before forwarding', () => {
    expect(() => runtime().validateResponseFraming({ headers: { 'content-length': '12' }, rawHeaders: ['Content-Length', '12'] })).not.toThrow();
    expect(() => runtime().validateResponseFraming({ headers: { 'transfer-encoding': 'chunked' }, rawHeaders: ['Transfer-Encoding', 'chunked'] })).not.toThrow();
    expect(() => runtime().validateResponseFraming({ headers: { 'content-length': '12', 'transfer-encoding': 'chunked' }, rawHeaders: ['Content-Length', '12', 'Transfer-Encoding', 'chunked'] })).toThrow(/framing|ambiguous|smuggl/iu);
    expect(() => runtime().validateResponseFraming({ headers: { 'content-length': '12' }, rawHeaders: ['Content-Length', '12', 'Content-Length', '12'] })).toThrow(/framing|ambiguous|smuggl/iu);
    expect(() => runtime().validateResponseFraming({ headers: { 'transfer-encoding': 'gzip, chunked' }, rawHeaders: ['Transfer-Encoding', 'gzip, chunked'] })).toThrow(/framing|transfer|smuggl/iu);
  });

  it('rejects duplicate SNI extensions and duplicate or unknown server-name entries', () => {
    const host = Buffer.from('registry.npmjs.org', 'ascii');
    const extension = serverNameExtension([{ type: 0, name: host }]);
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([extension, extension])))
      .toThrow(/clienthello|server name|tls/iu);
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      serverNameExtension([{ type: 0, name: host }, { type: 0, name: host }]),
    ]))).toThrow(/clienthello|server name|tls/iu);
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      serverNameExtension([{ type: 1, name: host }]),
    ]))).toThrow(/clienthello|server name|tls/iu);
  });

  it('rejects high-bit SNI bytes, malformed unknown extensions, and trailing record ambiguity', () => {
    const highBit = Buffer.from('registry.npmjs.org', 'ascii');
    highBit[0] = 0xf2;
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      serverNameExtension([{ type: 0, name: highBit }]),
    ]))).toThrow(/clienthello|server name|tls/iu);

    const malformedUnknownExtension = Buffer.from([0, 42, 0, 2, 0]);
    expect(() => runtime().parseTlsClientHelloServerName(clientHelloWithExtensions([
      malformedUnknownExtension,
      serverNameExtension([{ type: 0, name: Buffer.from('registry.npmjs.org', 'ascii') }]),
    ]))).toThrow(/clienthello|server name|tls/iu);

    expect(() => runtime().parseTlsClientHelloServerName(Buffer.concat([
      clientHello('registry.npmjs.org'),
      Buffer.from([0]),
    ]))).toThrow(/clienthello|server name|tls/iu);
  });

  it('rejects trailing ClientHello tunnel bytes before DNS or TLS verification', async () => {
    const credential = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    const verifyTls = vi.fn().mockResolvedValue(undefined);
    const server = runtime().createDependencyProxyServer({ allowedHosts: ['registry.npmjs.org'], credential, lookup, verifyTls });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(address.port, '127.0.0.1', () => socket.write([
          'CONNECT registry.npmjs.org:443 HTTP/1.1',
          'Host: registry.npmjs.org:443',
          `Proxy-Authorization: ${runtime().proxyAuthorization(credential)}`,
          '', '',
        ].join('\r\n')));
        let received = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          received += chunk;
          if (received.includes('200 Connection Established')) {
            received = '';
            socket.write(Buffer.concat([clientHello('registry.npmjs.org'), Buffer.from([0])]));
          } else if (received.includes('403 Forbidden')) {
            socket.end();
            resolve(received);
          }
        });
        socket.once('error', reject);
        socket.setTimeout(1_000, () => reject(new Error('proxy trailing ClientHello test timed out')));
      });
      expect(response).toContain('403 Forbidden');
      expect(lookup).not.toHaveBeenCalled();
      expect(verifyTls).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects an allowlisted CONNECT alias carrying production SNI before DNS lookup', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    await expect(runtime().resolveDependencyDestination({
      allowedHosts: ['registry.npmjs.org'],
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'osicloud.ch',
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('uses byte-classified DNS results and rejects mapped IPv6 and mixed rebinding answers', async () => {
    for (const address of [
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::ffff:c0a8:101',
      '::7f00:1',
      '0:0:0:0:0:0:127.0.0.1',
    ]) {
      const mappedOrCompatible = vi.fn().mockResolvedValue([{ address, family: 6 }]);
      await expect(runtime().resolveDependencyDestination({
        allowedHosts: ['registry.npmjs.org'],
        host: 'registry.npmjs.org',
        port: 443,
        tlsServerName: 'registry.npmjs.org',
      }, mappedOrCompatible), address).rejects.toThrow(/dependency egress denied/u);
    }

    const rebound = vi.fn().mockResolvedValue([
      { address: '104.16.30.34', family: 4 },
      { address: '::ffff:0a2a:7', family: 6 },
    ]);
    await expect(runtime().resolveDependencyDestination({
      allowedHosts: ['registry.npmjs.org'],
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    }, rebound)).rejects.toThrow(/dependency egress denied/u);
    expect(rebound).toHaveBeenCalledTimes(1);
  });

  it('rejects special-purpose IPv6 transition ranges and accepts native global unicast', async () => {
    const requestIdentity = {
      allowedHosts: ['registry.npmjs.org'],
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    } as const;
    for (const address of [
      '64:ff9b::a2a:7',
      '64:ff9b::6810:1e22',
      '2002:0a2a:0007::',
      '2002:6810:1e22::',
      '2001:0000:4136:e378:8000:63bf:f5d5:fff8',
      '3fff::1',
      '2001:db8::1',
      '2001:20::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
    ]) {
      await expect(runtime().resolveDependencyDestination(
        requestIdentity,
        vi.fn().mockResolvedValue([{ address, family: 6 }]),
      ), address).rejects.toThrow(/dependency egress denied/u);
    }

    await expect(runtime().resolveDependencyDestination(
      requestIdentity,
      vi.fn().mockResolvedValue([{ address: '2606:4700::6810:1e22', family: 6 }]),
    )).resolves.toEqual({
      host: 'registry.npmjs.org',
      address: '2606:4700::6810:1e22',
      family: 6,
      port: 443,
    });
  });
});
