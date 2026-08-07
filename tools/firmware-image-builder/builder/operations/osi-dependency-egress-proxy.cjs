'use strict';

const { BlockList, isIP } = require('node:net');
const { timingSafeEqual } = require('node:crypto');
const { createServer, request: httpRequest } = require('node:http');
const { createSecureServer: createHttp2SecureServer } = require('node:http2');
const { request: httpsRequest } = require('node:https');
const { connect: connectUpstream } = require('node:net');
const { lookup: dnsLookup } = require('node:dns/promises');
const { readFile } = require('node:fs/promises');
const { connect: connectTls } = require('node:tls');

const DEPENDENCY_PROXY_LIMITS = Object.freeze({
  globalConnections: 64,
  http2ConcurrentStreams: 16,
  maxRequestBodyBytes: 8 * 1024 * 1024,
  maxHeaderBytes: 32 * 1024,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  upstreamTimeoutMs: 30_000,
  tlsClientHelloTimeoutMs: 10_000,
});

const blockedIpv4Addresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');

function deny(message = 'dependency egress denied') {
  throw new Error(message);
}

function proxyAuthorization(credential) {
  if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{48,128}$/u.test(credential)) deny('invalid proxy credential');
  return `Basic ${Buffer.from(`osi:${credential}`, 'utf8').toString('base64')}`;
}

function validProxyAuthorization(header, credential) {
  let expected;
  try { expected = Buffer.from(proxyAuthorization(credential), 'ascii'); }
  catch { return false; }
  if (typeof header !== 'string') return false;
  const observed = Buffer.from(header, 'ascii');
  return observed.length === expected.length && timingSafeEqual(observed, expected);
}

function normalizedHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/u, '');
  if (
    host.length < 1
    || host.length > 253
    || isIP(host) !== 0
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(host)
  ) deny();
  return host;
}

function ipv4Bytes(address) {
  if (isIP(address) !== 4) deny();
  const bytes = address.split('.').map((part) => Number(part));
  if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) deny();
  return Buffer.from(bytes);
}

function ipv6Bytes(address) {
  if (isIP(address) !== 6) deny();
  let value = address.toLowerCase();
  const ipv4Separator = value.lastIndexOf(':');
  if (value.includes('.')) {
    if (ipv4Separator < 0) deny();
    const embedded = ipv4Bytes(value.slice(ipv4Separator + 1));
    value = `${value.slice(0, ipv4Separator)}:${embedded.readUInt16BE(0).toString(16)}:${embedded.readUInt16BE(2).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) deny();
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  const compressed = halves.length === 2;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) deny();
  const groups = compressed
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) deny();
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => result.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return result;
}

function hasPrefix(bytes, prefix, bits) {
  const fullBytes = Math.floor(bits / 8);
  if (!bytes.subarray(0, fullBytes).equals(prefix.subarray(0, fullBytes))) return false;
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function ipv4BytesAreGlobal(bytes) {
  return !blockedIpv4Addresses.check([...bytes].join('.'), 'ipv4');
}

function embeddedIpv4(bytes, offset, inverted = false) {
  const value = Buffer.from(bytes.subarray(offset, offset + 4));
  if (value.length !== 4) deny();
  if (inverted) for (let index = 0; index < value.length; index += 1) value[index] ^= 0xff;
  return ipv4BytesAreGlobal(value);
}

const IPV6_PREFIXES = Object.freeze({
  compatible: ipv6Bytes('::'),
  mapped: ipv6Bytes('::ffff:0:0'),
  nat64: ipv6Bytes('64:ff9b::'),
  sixToFour: ipv6Bytes('2002::'),
  teredo: ipv6Bytes('2001::'),
  protocolAssignments: ipv6Bytes('2001::'),
  documentation: ipv6Bytes('2001:db8::'),
  documentationV2: ipv6Bytes('3fff::'),
  globalUnicast: ipv6Bytes('2000::'),
});

function ipv6AddressIsGlobal(address) {
  const bytes = ipv6Bytes(address);
  if (hasPrefix(bytes, IPV6_PREFIXES.mapped, 96) || hasPrefix(bytes, IPV6_PREFIXES.compatible, 96)) {
    embeddedIpv4(bytes, 12);
    return false;
  }
  if (hasPrefix(bytes, IPV6_PREFIXES.nat64, 96)) {
    embeddedIpv4(bytes, 12);
    return false;
  }
  if (hasPrefix(bytes, IPV6_PREFIXES.sixToFour, 16)) {
    embeddedIpv4(bytes, 2);
    return false;
  }
  if (hasPrefix(bytes, IPV6_PREFIXES.teredo, 32)) {
    embeddedIpv4(bytes, 12, true);
    return false;
  }
  return hasPrefix(bytes, IPV6_PREFIXES.globalUnicast, 3)
    && !hasPrefix(bytes, IPV6_PREFIXES.protocolAssignments, 23)
    && !hasPrefix(bytes, IPV6_PREFIXES.documentation, 32)
    && !hasPrefix(bytes, IPV6_PREFIXES.documentationV2, 20);
}

function publicAddress(value) {
  if (value === null || typeof value !== 'object') deny();
  const family = isIP(value.address);
  if (
    (family !== 4 && family !== 6)
    || value.family !== family
    || (family === 4
      ? blockedIpv4Addresses.check(value.address, 'ipv4')
      : !ipv6AddressIsGlobal(value.address))
  ) deny();
  return Object.freeze({ address: value.address, family });
}

async function resolveDependencyDestination(request, lookup) {
  if (request === null || typeof request !== 'object' || typeof lookup !== 'function') deny();
  const allowedHosts = Array.isArray(request.allowedHosts)
    ? request.allowedHosts.map(normalizedHost)
    : deny();
  const host = normalizedHost(request.host);
  const tlsServerName = request.tlsServerName === null ? null : normalizedHost(request.tlsServerName);
  if (
    !allowedHosts.includes(host)
    || (request.port !== 80 && request.port !== 443)
    || (tlsServerName !== null && tlsServerName !== host)
  ) deny();
  const resolved = await lookup(host);
  if (!Array.isArray(resolved) || resolved.length < 1 || resolved.length > 32) deny();
  const addresses = resolved.map(publicAddress);
  const selected = addresses[0];
  return Object.freeze({ host, address: selected.address, family: selected.family, port: request.port });
}

async function verifyTlsEndpoint(destination) {
  await new Promise((resolve, reject) => {
    const socket = connectTls({
      host: destination.address,
      family: destination.family,
      port: destination.port,
      servername: destination.host,
      rejectUnauthorized: true,
    });
    socket.setTimeout(8_000, () => socket.destroy(new Error('dependency TLS ownership check timed out')));
    socket.once('secureConnect', () => {
      if (!socket.authorized) {
        socket.destroy();
        reject(new Error('dependency TLS ownership check failed'));
        return;
      }
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

function uint16(bytes, offset, limit) {
  if (offset < 0 || offset + 2 > limit) deny('invalid TLS ClientHello');
  return bytes.readUInt16BE(offset);
}

function parseTlsClientHelloServerName(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length < 9 || bytes.length > 65_540 || bytes[0] !== 0x16 || bytes[1] !== 3) deny('invalid TLS ClientHello');
  const recordLength = uint16(bytes, 3, bytes.length);
  const recordEnd = 5 + recordLength;
  if (recordEnd !== bytes.length || bytes[5] !== 1) deny('incomplete TLS ClientHello');
  const handshakeLength = bytes.readUIntBE(6, 3);
  const handshakeEnd = 9 + handshakeLength;
  if (handshakeEnd !== recordEnd || handshakeEnd < 43) deny('invalid TLS ClientHello');

  let offset = 9 + 2 + 32;
  const sessionLength = bytes[offset];
  if (sessionLength === undefined) deny('invalid TLS ClientHello');
  offset += 1 + sessionLength;
  const cipherLength = uint16(bytes, offset, handshakeEnd);
  if (cipherLength < 2 || cipherLength % 2 !== 0) deny('invalid TLS ClientHello');
  offset += 2 + cipherLength;
  if (offset >= handshakeEnd) deny('invalid TLS ClientHello');
  const compressionLength = bytes[offset];
  if (compressionLength === undefined || compressionLength < 1) deny('invalid TLS ClientHello');
  offset += 1 + compressionLength;
  const extensionsLength = uint16(bytes, offset, handshakeEnd);
  offset += 2;
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd !== handshakeEnd) deny('invalid TLS ClientHello');

  let serverName = null;
  let serverNameExtensionCount = 0;
  let alpnExtensionCount = 0;
  while (offset < extensionsEnd) {
    const type = uint16(bytes, offset, extensionsEnd);
    const length = uint16(bytes, offset + 2, extensionsEnd);
    offset += 4;
    const extensionEnd = offset + length;
    if (extensionEnd > extensionsEnd) deny('invalid TLS ClientHello');
    if (type === 0) {
      serverNameExtensionCount += 1;
      if (serverNameExtensionCount !== 1 || length < 5) deny('invalid TLS ClientHello server name');
      const listLength = uint16(bytes, offset, extensionEnd);
      let nameOffset = offset + 2;
      if (nameOffset + listLength !== extensionEnd) deny('invalid TLS ClientHello');
      let entryCount = 0;
      while (nameOffset < extensionEnd) {
        const nameType = bytes[nameOffset];
        const nameLength = uint16(bytes, nameOffset + 1, extensionEnd);
        nameOffset += 3;
        const nameEnd = nameOffset + nameLength;
        if (nameEnd > extensionEnd || nameLength < 1 || nameType !== 0) deny('invalid TLS ClientHello server name');
        entryCount += 1;
        if (entryCount !== 1) deny('invalid TLS ClientHello server name');
        const nameBytes = bytes.subarray(nameOffset, nameEnd);
        if (nameBytes.some((byte) => byte > 0x7f)) deny('invalid TLS ClientHello server name');
        const rawServerName = nameBytes.toString('latin1');
        serverName = normalizedHost(rawServerName);
        if (serverName !== rawServerName) deny('TLS ClientHello server name is not canonical');
        nameOffset = nameEnd;
      }
      if (entryCount !== 1 || serverName === null) deny('TLS ClientHello has no server name');
    }
    if (type === 16) {
      alpnExtensionCount += 1;
      if (alpnExtensionCount !== 1 || length < 4) deny('invalid TLS ClientHello ALPN');
      const listLength = uint16(bytes, offset, extensionEnd);
      let protocolOffset = offset + 2;
      if (protocolOffset + listLength !== extensionEnd || listLength < 2) deny('invalid TLS ClientHello ALPN');
      const protocols = new Set();
      while (protocolOffset < extensionEnd) {
        const protocolLength = bytes[protocolOffset];
        protocolOffset += 1;
        const protocolEnd = protocolOffset + protocolLength;
        if (protocolLength < 1 || protocolEnd > extensionEnd) deny('invalid TLS ClientHello ALPN');
        const protocolBytes = bytes.subarray(protocolOffset, protocolEnd);
        if (protocolBytes.some((byte) => byte > 0x7f)) deny('invalid TLS ClientHello ALPN');
        const protocol = protocolBytes.toString('latin1');
        if ((protocol !== 'h2' && protocol !== 'http/1.1') || protocols.has(protocol)) deny('TLS ClientHello ALPN protocol is not supported');
        protocols.add(protocol);
        protocolOffset = protocolEnd;
      }
      if (protocols.size < 1) deny('invalid TLS ClientHello ALPN');
    }
    if (type === 0xfe0d) deny('encrypted client hello is not supported');
    offset = extensionEnd;
  }
  if (offset !== extensionsEnd || serverNameExtensionCount !== 1 || serverName === null) deny('TLS ClientHello has no server name');
  return serverName;
}

function validateRequestAuthority(input) {
  if (input === null || typeof input !== 'object') deny('request authority is invalid');
  const protocol = input.protocol;
  if (protocol !== 'http/1.1' && protocol !== 'h2') deny('request protocol is not supported');
  const value = protocol === 'h2' ? input.authority : input.host;
  const expectedHost = normalizedHost(input.expectedHost);
  const authority = canonicalHttpsAuthority(value);
  if (protocol === 'h2' && input.host !== undefined && input.host !== value) deny('HTTP/2 Host conflicts with :authority');
  if (authority.host !== expectedHost) deny('request authority does not match the TLS SNI');
  return Object.freeze({ host: authority.host, port: 443 });
}

function certificateForHost(options, host) {
  const entry = options.tls?.certificates?.[host];
  if (entry === undefined || typeof entry.cert !== 'string' || typeof entry.key !== 'string') deny('TLS certificate authority is incomplete');
  return entry;
}

const HOP_BY_HOP_HEADERS = Object.freeze(new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]));

function sanitizeHopByHopHeaders(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) deny('headers are invalid');
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  const connection = Object.entries(headers).find(([name]) => name.toLowerCase() === 'connection')?.[1];
  if (connection !== undefined) {
    const values = Array.isArray(connection) ? connection : [connection];
    for (const value of values) {
      if (typeof value !== 'string') deny('Connection header is invalid');
      for (const token of value.split(',')) {
        const name = token.trim().toLowerCase();
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) deny('Connection header token is invalid');
        blocked.add(name);
      }
    }
  }
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonicalName = name.toLowerCase();
    if (canonicalName.startsWith(':') || blocked.has(canonicalName) || value === undefined) continue;
    result[canonicalName] = value;
  }
  return Object.freeze(result);
}

function rawHeaderCount(rawHeaders, name) {
  if (rawHeaders === undefined) return 0;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0 || rawHeaders.some((value) => typeof value !== 'string')) deny('raw request headers are invalid');
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) if (rawHeaders[index].toLowerCase() === name) count += 1;
  return count;
}

function validateRequestFraming(input) {
  if (input === null || typeof input !== 'object' || (input.protocol !== 'http/1.1' && input.protocol !== 'h2')) deny('request framing protocol is invalid');
  const headers = input.headers;
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) deny('request framing headers are invalid');
  const headerBytes = input.protocol === 'http/1.1' && input.rawHeaders !== undefined
    ? Buffer.byteLength(input.rawHeaders.join('\r\n'), 'latin1')
    : Object.entries(headers).reduce((total, [name, value]) => total + Buffer.byteLength(name) + (Array.isArray(value) ? value.reduce((sum, item) => sum + Buffer.byteLength(String(item)), 0) : Buffer.byteLength(String(value ?? ''))), 0);
  if (headerBytes > DEPENDENCY_PROXY_LIMITS.maxHeaderBytes) deny('request headers are too large');
  const contentLength = headers['content-length'];
  const transferEncoding = headers['transfer-encoding'];
  if (transferEncoding !== undefined || rawHeaderCount(input.rawHeaders, 'transfer-encoding') > 0) deny('ambiguous request transfer framing');
  if (Array.isArray(contentLength) || rawHeaderCount(input.rawHeaders, 'content-length') > 1) deny('ambiguous request content length');
  if (contentLength === undefined) return Object.freeze({ contentLength: 0 });
  if (typeof contentLength !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) deny('request content length is not canonical');
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes > DEPENDENCY_PROXY_LIMITS.maxRequestBodyBytes) deny('request body is too large');
  return Object.freeze({ contentLength: bytes });
}

function validateResponseFraming(input) {
  if (input === null || typeof input !== 'object' || input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers)) deny('upstream response framing is invalid');
  const contentLengthCount = rawHeaderCount(input.rawHeaders, 'content-length');
  const transferEncodingCount = rawHeaderCount(input.rawHeaders, 'transfer-encoding');
  const contentLength = input.headers['content-length'];
  const transferEncoding = input.headers['transfer-encoding'];
  if (contentLengthCount > 1 || transferEncodingCount > 1 || (contentLength !== undefined && transferEncoding !== undefined)) deny('ambiguous upstream response framing');
  if (contentLength !== undefined && (typeof contentLength !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))) deny('invalid upstream response content length');
  if (transferEncoding !== undefined && transferEncoding !== 'chunked') deny('invalid upstream response transfer framing');
  if (Buffer.byteLength(input.rawHeaders.join('\r\n'), 'latin1') > DEPENDENCY_PROXY_LIMITS.maxHeaderBytes) deny('upstream response headers are too large');
}

function responseHeaders(headers) {
  return sanitizeHopByHopHeaders(headers);
}

function redirectIsAllowed(response, selected, allowedHosts) {
  if (response.statusCode < 300 || response.statusCode > 399 || response.headers.location === undefined) return true;
  const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
  if (typeof location !== 'string') return false;
  try {
    if (location.includes('\\') || location.startsWith('//')) return false;
    const absolute = /^https:\/\/([^/?#]+)/u.exec(location);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(location) && absolute === null) return false;
    if (absolute !== null) {
      const authority = canonicalHttpsAuthority(absolute[1]);
      if (!allowedHosts.includes(authority.host)) return false;
    }
    const target = new URL(location, `https://${selected.host}/`);
    return target.protocol === 'https:'
      && (target.port === '' || target.port === '443')
      && allowedHosts.includes(target.hostname)
      && normalizedHost(target.hostname) === target.hostname;
  } catch { return false; }
}

function proxyUpstreamRequest({ request, body, response, stream, selected, allowedHosts, protocol }) {
  const headers = { ...sanitizeHopByHopHeaders(request.headers ?? {}) };
  delete headers.host;
  headers.host = selected.host;
  let terminal = false;
  const upstream = httpsRequest({
    host: selected.address,
    port: 443,
    method: request.method ?? 'GET',
    path: request.path ?? request.url ?? '/',
    headers,
    servername: selected.host,
    rejectUnauthorized: true,
    maxHeaderSize: DEPENDENCY_PROXY_LIMITS.maxHeaderBytes,
    timeout: DEPENDENCY_PROXY_LIMITS.upstreamTimeoutMs,
    lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
  }, (upstreamResponse) => {
    try { validateResponseFraming({ headers: upstreamResponse.headers, rawHeaders: upstreamResponse.rawHeaders }); }
    catch {
      terminal = true;
      upstreamResponse.resume();
      if (protocol === 'h2') {
        if (!stream.destroyed && !stream.headersSent) stream.respond({ ':status': 502 });
        if (!stream.destroyed) stream.end('ambiguous upstream response framing\n');
      } else {
        response.writeHead(502, { connection: 'close' });
        response.end('ambiguous upstream response framing\n');
      }
      return;
    }
    if (!redirectIsAllowed(upstreamResponse, selected, allowedHosts)) {
      upstreamResponse.resume();
      terminal = true;
      if (protocol === 'h2') stream.respond({ ':status': 403, 'content-type': 'text/plain' });
      else response.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      if (protocol === 'h2') stream.end('dependency redirect denied\n'); else response.end('dependency redirect denied\n');
      return;
    }
    const headersOut = responseHeaders(upstreamResponse.headers);
    if (protocol === 'h2') {
      stream.respond({ ':status': upstreamResponse.statusCode ?? 502, ...headersOut });
      upstreamResponse.pipe(stream);
    } else {
      response.writeHead(upstreamResponse.statusCode ?? 502, headersOut);
      upstreamResponse.pipe(response);
    }
  });
  upstream.once('timeout', () => upstream.destroy(new Error('upstream TLS request timed out')));
  upstream.once('error', () => {
    if (terminal) return;
    terminal = true;
    if (protocol === 'h2') {
      if (!stream.destroyed && !stream.headersSent) stream.respond({ ':status': 502 });
      if (!stream.destroyed) stream.end('upstream TLS request failed\n');
    } else if (!response.headersSent) {
      response.writeHead(502, { connection: 'close' });
      response.end('upstream TLS request failed\n');
    }
  });
  if (body !== null) {
    let bodyBytes = 0;
    body.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > DEPENDENCY_PROXY_LIMITS.maxRequestBodyBytes) {
        terminal = true;
        upstream.destroy();
        if (protocol === 'h2') { if (!stream.destroyed) stream.respond({ ':status': 413 }); stream.end('request body too large\n'); }
        else if (!response.headersSent) { response.writeHead(413, { connection: 'close' }); response.end('request body too large\n'); }
        body.destroy();
        return;
      }
      if (!upstream.write(chunk)) body.pause();
    });
    upstream.on('drain', () => body.resume());
    body.once('end', () => { if (!terminal) upstream.end(); });
    body.once('aborted', () => upstream.destroy(new Error('client request cancelled')));
    body.once('error', (error) => upstream.destroy(error));
  } else upstream.end();
}

function attachTerminatedTls(options, client, buffered, expectedHost) {
  const certificate = certificateForHost(options, expectedHost);
  const server = createHttp2SecureServer({
    key: certificate.key,
    cert: certificate.cert,
    allowHTTP1: true,
    ALPNProtocols: ['h2', 'http/1.1'],
    maxHeaderSize: DEPENDENCY_PROXY_LIMITS.maxHeaderBytes,
    maxHeaderListPairs: 128,
    maxSendHeaderBlockLength: DEPENDENCY_PROXY_LIMITS.maxHeaderBytes,
    settings: {
      maxConcurrentStreams: DEPENDENCY_PROXY_LIMITS.http2ConcurrentStreams,
      maxHeaderListSize: DEPENDENCY_PROXY_LIMITS.maxHeaderBytes,
    },
  });
  server.headersTimeout = DEPENDENCY_PROXY_LIMITS.headersTimeoutMs;
  server.requestTimeout = DEPENDENCY_PROXY_LIMITS.requestTimeoutMs;
  server.on('secureConnection', (socket) => {
    options.trackTerminatedConnection(client, socket);
    if (socket.servername !== expectedHost || !['h2', 'http/1.1', false].includes(socket.alpnProtocol)) socket.destroy(new Error('TLS protocol or SNI is not allowed'));
  });
  server.on('tlsClientError', () => client.destroy());
  server.on('session', (session) => session.setTimeout(DEPENDENCY_PROXY_LIMITS.requestTimeoutMs, () => session.destroy()));
  server.on('stream', async (stream, headers) => {
    try {
      const authority = validateRequestAuthority({ protocol: 'h2', authority: headers[':authority'], host: headers.host, expectedHost });
      if (headers[':scheme'] !== 'https' || typeof headers[':path'] !== 'string' || headers[':method'] === 'CONNECT') deny('invalid HTTP/2 request');
      validateRequestFraming({ protocol: 'h2', headers });
      const selected = await options.authorize({ host: authority.host, port: 443, tlsServerName: expectedHost });
      proxyUpstreamRequest({ request: { method: headers[':method'], path: headers[':path'], headers }, body: stream, response: null, stream, selected, allowedHosts: options.allowedHosts, protocol: 'h2' });
    } catch {
      if (!stream.destroyed) stream.respond({ ':status': 403 });
      stream.end('dependency authority denied\n');
    }
  });
  server.on('request', async (request, response) => {
    if (request.httpVersionMajor >= 2) return;
    try {
      const authority = validateRequestAuthority({ protocol: 'http/1.1', host: request.headers.host, expectedHost });
      if (request.url?.startsWith('http://') || request.url?.startsWith('https://')) deny('absolute-form request is not supported');
      validateRequestFraming({ protocol: 'http/1.1', headers: request.headers, rawHeaders: request.rawHeaders });
      const selected = await options.authorize({ host: authority.host, port: 443, tlsServerName: expectedHost });
      proxyUpstreamRequest({ request: { method: request.method, path: request.url, headers: request.headers }, body: request, response, stream: null, selected, allowedHosts: options.allowedHosts, protocol: 'http/1.1' });
    } catch {
      response.writeHead(403, { connection: 'close' });
      response.end('dependency authority denied\n');
    }
  });
  client.pause();
  server.emit('connection', client);
  client.unshift(buffered);
  client.resume();
  return client;
}

function proxyAuthenticationRequired(response) {
  response.writeHead(407, {
    connection: 'close',
    'content-type': 'text/plain',
    'proxy-authenticate': 'Basic realm="osi-image-builder"',
  });
  response.end('proxy authentication required\n');
}

function forbidden(response) {
  response.writeHead(403, { connection: 'close', 'content-type': 'text/plain' });
  response.end('dependency egress denied\n');
}

function connectAuthority(value) {
  return canonicalHttpsAuthority(value);
}

function canonicalHttpsAuthority(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 257) deny('request authority is invalid');
  const hasPort = value.endsWith(':443');
  const host = hasPort ? value.slice(0, -4) : value;
  let normalized;
  try { normalized = normalizedHost(host); }
  catch (error) { throw new Error('request authority is not canonical', { cause: error }); }
  if (host.includes(':') || value !== (hasPort ? `${host}:443` : host) || normalized !== host) deny('request authority is not canonical');
  return Object.freeze({ host, port: 443 });
}

function createDependencyProxyServer(options) {
  if (options === null || typeof options !== 'object' || typeof options.lookup !== 'function') deny();
  proxyAuthorization(options.credential);
  const allowedHosts = Object.freeze([...options.allowedHosts].map(normalizedHost));
  const authorize = (request) => resolveDependencyDestination({ ...request, allowedHosts }, options.lookup);
  const verifyTls = options.verifyTls === undefined ? verifyTlsEndpoint : options.verifyTls;
  if (typeof verifyTls !== 'function') deny();
  const activeSockets = new Set();
  const trackTerminatedConnection = (rawSocket, secureSocket) => {
    activeSockets.delete(rawSocket);
    activeSockets.add(secureSocket);
    secureSocket.once('close', () => activeSockets.delete(secureSocket));
  };

  const server = createServer({ maxHeaderSize: DEPENDENCY_PROXY_LIMITS.maxHeaderBytes }, async (request, response) => {
    if (!validProxyAuthorization(request.headers['proxy-authorization'], options.credential)) {
      proxyAuthenticationRequired(response);
      return;
    }
    if (request.method === 'GET' && request.url === 'http://osi-proxy.invalid/ready') {
      response.writeHead(204, { connection: 'close' });
      response.end();
      return;
    }
    try {
      const target = new URL(request.url || '');
      if (target.protocol !== 'http:' || target.username !== '' || target.password !== '') deny();
      if (target.port !== '') deny();
      const selected = await authorize({ host: target.hostname, port: 80, tlsServerName: null });
      response.writeHead(308, {
        connection: 'close',
        location: `https://${selected.host}${target.pathname}${target.search}`,
      });
      response.end();
    } catch {
      forbidden(response);
    }
  });
  server.maxConnections = DEPENDENCY_PROXY_LIMITS.globalConnections;
  server.dropMaxConnection = true;
  server.headersTimeout = DEPENDENCY_PROXY_LIMITS.headersTimeoutMs;
  server.requestTimeout = DEPENDENCY_PROXY_LIMITS.requestTimeoutMs;
  server.prependListener('connection', (socket) => {
    if (activeSockets.size >= DEPENDENCY_PROXY_LIMITS.globalConnections) {
      socket.destroy();
      return;
    }
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });
  Object.defineProperties(server, {
    activeDependencyConnections: {
      enumerable: false,
      value: () => activeSockets.size,
      writable: false,
    },
    cancelDependencyConnections: {
      enumerable: false,
      value: () => {
        const sockets = [...activeSockets];
        activeSockets.clear();
        for (const socket of sockets) socket.destroy();
      },
      writable: false,
    },
  });

  server.on('connect', (request, client, head) => {
    if (!validProxyAuthorization(request.headers['proxy-authorization'], options.credential)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="osi-image-builder"\r\nConnection: close\r\n\r\n');
      return;
    }
    let authority;
    try {
      authority = connectAuthority(request.url);
      if (rawHeaderCount(request.rawHeaders, 'host') !== 1 || request.headers.host !== request.url) deny('CONNECT Host does not match request authority');
      if (authority.port !== 443) deny();
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    const chunks = [];
    let size = 0;
    let finished = false;
    client.on('error', () => { finished = true; client.destroy(); });
    const reject = () => {
      if (finished) return;
      finished = true;
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    };
    const inspect = async (chunk) => {
      if (finished) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > 65_540) {
        reject();
        return;
      }
      const hello = Buffer.concat(chunks, size);
      if (hello.length < 5) return;
      const expected = 5 + hello.readUInt16BE(3);
      if (expected > 65_540) {
        reject();
        return;
      }
      if (hello.length < expected) return;
      if (hello.length !== expected) {
        reject();
        return;
      }
      try {
        const tlsServerName = parseTlsClientHelloServerName(hello.subarray(0, expected));
        const selected = await authorize({ ...authority, tlsServerName });
        await verifyTls(selected);
        if (finished) return;
        finished = true;
        client.removeListener('data', inspect);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        attachTerminatedTls({ ...options, authorize, trackTerminatedConnection }, client, hello, selected.host);
      } catch {
        reject();
      }
    };
    client.setTimeout(DEPENDENCY_PROXY_LIMITS.tlsClientHelloTimeoutMs, reject);
    client.on('data', inspect);
    if (head.length > 0) void inspect(head);
  });
  return server;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) deny(`missing ${name}`);
  return value;
}

async function readRuntimeCredential() {
  const path = requiredEnvironment('OSI_EGRESS_CREDENTIAL_PATH');
  if (path !== '/run/osi-image-builder/proxy-credential') deny('invalid credential path');
  const value = await readFile(path, 'utf8');
  proxyAuthorization(value);
  return value;
}

function runtimeAllowedHosts() {
  let value;
  try { value = JSON.parse(requiredEnvironment('OSI_EGRESS_ALLOWED_HOSTS_JSON')); }
  catch (error) { throw new Error('invalid installed dependency host policy', { cause: error }); }
  if (!Array.isArray(value) || value.length === 0) deny('empty installed dependency host policy');
  const hosts = value.map(normalizedHost);
  if (new Set(hosts).size !== hosts.length || JSON.stringify(hosts) !== JSON.stringify(value)) deny('noncanonical installed dependency host policy');
  return Object.freeze(hosts);
}

async function runtimeLookup(host) {
  const values = await dnsLookup(host, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family }));
}

async function proxyStatus(host, credential) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host,
      port: 3128,
      method: 'GET',
      path: 'http://osi-proxy.invalid/ready',
      headers: credential === null ? {} : { 'proxy-authorization': proxyAuthorization(credential) },
      timeout: 2_000,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('timeout', () => request.destroy(new Error('proxy readiness timed out')));
    request.once('error', reject);
    request.end();
  });
}

async function endpointDenied(host) {
  if (host === 'none') return false;
  return new Promise((resolve, reject) => {
    const socket = connectUpstream({ host, port: 3128 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('bridge endpoint refusal timed out'));
    }, 2_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function runReadiness(argv) {
  if (argv.length !== 3 || argv[0] !== '--readiness' || isIP(argv[1]) === 0 || (argv[2] !== 'none' && isIP(argv[2]) === 0)) deny('invalid readiness arguments');
  if (requiredEnvironment('OSI_EGRESS_PROXY_PORT') !== '3128') deny('invalid proxy port policy');
  const credential = await readRuntimeCredential();
  const unauthenticatedStatus = await proxyStatus(argv[1], null);
  const authenticatedStatus = await proxyStatus(argv[1], credential);
  const bridgeEndpointDenied = await endpointDenied(argv[2]);
  process.stdout.write(`${JSON.stringify({ authenticated: authenticatedStatus === 204, unauthenticatedStatus, authenticatedStatus, bridgeEndpointDenied })}\n`);
}

async function runServer() {
  if (process.argv.length !== 2) deny('unexpected proxy server arguments');
  if (requiredEnvironment('OSI_EGRESS_PROXY_PORT') !== '3128') deny('invalid proxy port policy');
  if (requiredEnvironment('OSI_EGRESS_BIND_ALIAS') !== 'osi-egress-proxy') deny('invalid proxy bind alias');
  const credential = await readRuntimeCredential();
  const allowedHosts = runtimeAllowedHosts();
  const tlsDirectory = requiredEnvironment('OSI_EGRESS_TLS_DIRECTORY');
  const caCertificatePath = requiredEnvironment('OSI_EGRESS_CA_CERT_PATH');
  if (tlsDirectory !== '/run/osi-image-builder/tls' || caCertificatePath !== `${tlsDirectory}/ca.pem`) deny('invalid TLS material paths');
  const certificates = Object.fromEntries(await Promise.all(allowedHosts.map(async (host) => {
    const name = host.replaceAll('.', '_');
    return [host, { cert: await readFile(`${tlsDirectory}/${name}.pem`, 'utf8'), key: await readFile(`${tlsDirectory}/${name}.key`, 'utf8') }];
  })));
  const bindAddresses = await dnsLookup('osi-egress-proxy', { all: true, verbatim: true });
  if (bindAddresses.length !== 1 || isIP(bindAddresses[0].address) === 0) deny('internal proxy bind identity is ambiguous');
  const server = createDependencyProxyServer({ credential, allowedHosts, lookup: runtimeLookup, tls: { caCertificate: await readFile(caCertificatePath, 'utf8'), certificates } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: bindAddresses[0].address, port: 3128, exclusive: true }, resolve);
  });
}

module.exports = Object.freeze({
  DEPENDENCY_PROXY_LIMITS,
  createDependencyProxyServer,
  parseTlsClientHelloServerName,
  proxyAuthorization,
  resolveDependencyDestination,
  redirectIsAllowed,
  sanitizeHopByHopHeaders,
  validateRequestAuthority,
  validateRequestFraming,
  validateResponseFraming,
  validProxyAuthorization,
});

if (require.main === module) {
  const action = process.argv.slice(2);
  const running = action[0] === '--readiness' ? runReadiness(action) : runServer();
  running.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
