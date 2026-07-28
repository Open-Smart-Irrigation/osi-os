import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BuilderError } from '../../domain/errors.js';
import { parseJson, JSON_LIMITS, type JsonValue } from './validation.js';

const LOOPBACK_HOST = '127.0.0.1';
const API_PREFIX = '/api/';
const CLOUD_PREFIX = '/api/v1/';
const MAX_BODY_BYTES = JSON_LIMITS.maxEncodedBytes;
const REQUEST_ID_HEADER = 'x-request-id';

type SafeDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface HttpResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiRouteContext {
  readonly request: IncomingMessage;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<URLSearchParams>;
  readonly headers: IncomingMessage['headers'];
  readonly body: JsonValue | null;
}

export type ApiRouteHandler = (context: ApiRouteContext) => HttpResponse | null | undefined | Promise<HttpResponse | null | undefined>;

export interface HttpServerOptions {
  readonly origin: string;
  readonly routeHandler: ApiRouteHandler;
  readonly maxBodyBytes?: number;
}

export class HttpTransportError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: SafeDetails;

  constructor(input: {
    readonly code: string;
    readonly status: number;
    readonly retryable?: boolean;
    readonly details?: SafeDetails;
  }) {
    super(input.code);
    this.name = 'HttpTransportError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.details = input.details ?? {};
  }
}

export function jsonResponse(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): HttpResponse {
  return { status, body, headers };
}

function requestId(): string {
  return `req_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '')}`;
}

function isMutation(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function contentTypeIsJson(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

function checkHost(request: IncomingMessage): void {
  const localPort = request.socket.localPort;
  const hostHeaders = [] as string[];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === 'host') hostHeaders.push(request.rawHeaders[index + 1]!);
  }
  if (!Number.isSafeInteger(localPort) || hostHeaders.length !== 1) fail('HOST_REQUIRED', 400);
  const value = hostHeaders[0]!;
  if (value !== `${LOOPBACK_HOST}:${localPort}`) fail('HOST_FORBIDDEN', 400);
}

function safeErrorEnvelope(error: unknown, id: string): { readonly error: Readonly<Record<string, unknown>> } {
  if (error instanceof BuilderError) {
    return {
      error: {
        code: error.code,
        message: error.diagnosis,
        stage: error.stage,
        details: error.details,
        retryable: error.retryable,
        requestId: id,
      },
    };
  }
  if (error instanceof HttpTransportError) {
    return {
      error: {
        code: error.code,
        message: publicMessage(error.code),
        stage: null,
        details: error.details,
        retryable: error.retryable,
        requestId: id,
      },
    };
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
      stage: null,
      details: {},
      retryable: true,
      requestId: id,
    },
  };
}

function publicMessage(code: string): string {
  switch (code) {
    case 'ORIGIN_REQUIRED': return 'A same-origin request is required.';
    case 'ORIGIN_FORBIDDEN': return 'The request origin is not allowed.';
    case 'HOST_REQUIRED': return 'A loopback Host header is required.';
    case 'HOST_FORBIDDEN': return 'The request Host is not allowed.';
    case 'JSON_REQUIRED': return 'Mutating requests must use application/json.';
    case 'INVALID_JSON': return 'The request body is not valid JSON.';
    case 'BODY_TOO_LARGE': return 'The request body exceeds its size limit.';
    case 'INVALID_PATH': return 'The request path is invalid.';
    case 'METHOD_NOT_ALLOWED': return 'The request method is not allowed.';
    case 'NOT_FOUND': return 'The requested resource was not found.';
    case 'INVALID_CONTENT_LENGTH': return 'The request content length is invalid.';
    default: return 'The request was rejected.';
  }
}

function fail(code: string, status: number, details?: SafeDetails): never {
  throw new HttpTransportError({ code, status, details });
}

function sendJson(response: ServerResponse, status: number, body: unknown, id: string, headers: Readonly<Record<string, string>> = {}, suppressBody = false): void {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) {
    sendError(response, new HttpTransportError({ code: 'INTERNAL_ERROR', status: 500, retryable: true }), id);
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    [REQUEST_ID_HEADER]: id,
    ...headers,
  });
  response.end(suppressBody ? undefined : encoded);
}

function sendError(response: ServerResponse, error: unknown, id: string): void {
  const status = error instanceof HttpTransportError ? error.status : 500;
  sendJson(response, status, safeErrorEnvelope(error, id), id);
}

async function readBody(request: IncomingMessage, limit: number): Promise<JsonValue | null> {
  const header = request.headers['content-length'];
  if (header !== undefined) {
    if (Array.isArray(header) || !/^\d+$/u.test(header)) fail('INVALID_CONTENT_LENGTH', 400);
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length > limit) {
      request.resume();
      fail('BODY_TOO_LARGE', 413);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) {
      request.resume();
      fail('BODY_TOO_LARGE', 413);
    }
    chunks.push(bytes);
  }
  if (size === 0) return null;
  try {
    return parseJson(Buffer.concat(chunks).toString('utf8'), 'request body');
  } catch {
    fail('INVALID_JSON', 400);
  }
}

function parseRequestUrl(request: IncomingMessage, origin: string): { readonly url: URL; readonly pathname: string } {
  let url: URL;
  try {
    url = new URL(request.url ?? '', origin);
  } catch {
    fail('INVALID_PATH', 400);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    fail('INVALID_PATH', 400);
  }
  if ([...pathname].some((character) => {
    const code = character.codePointAt(0)!;
    return character === '\\' || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  })) {
    fail('INVALID_PATH', 400);
  }
  if (url.origin !== origin || !pathname.startsWith(API_PREFIX)
    || pathname === '/api/v1' || pathname.startsWith(CLOUD_PREFIX)) {
    fail('NOT_FOUND', 404);
  }
  return { url, pathname };
}

function checkOrigin(request: IncomingMessage, origin: string): void {
  const value = request.headers.origin;
  if (value === undefined) fail('ORIGIN_REQUIRED', 403);
  if (Array.isArray(value) || value !== origin) fail('ORIGIN_FORBIDDEN', 403);
}

function preflight(response: ServerResponse, request: IncomingMessage, origin: string, id: string): void {
  checkOrigin(request, origin);
  response.writeHead(204, {
    [REQUEST_ID_HEADER]: id,
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  });
  response.end();
}

export function createHttpServer(options: HttpServerOptions): Server {
  if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/u.test(options.origin)) {
    throw new Error('HTTP API origin must be a loopback HTTP origin');
  }
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BODY_BYTES) throw new Error('HTTP API body limit is invalid');

  const server = createServer(async (request, response) => {
    const id = requestId();
    try {
      checkHost(request);
      const parsedUrl = parseRequestUrl(request, options.origin);
      if (request.method === 'OPTIONS') {
        preflight(response, request, options.origin, id);
        return;
      }
      const method = request.method ?? '';
      if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method)) fail('METHOD_NOT_ALLOWED', 405);
      if (isMutation(method)) {
        checkOrigin(request, options.origin);
        if (!contentTypeIsJson(request.headers['content-type'])) fail('JSON_REQUIRED', 415);
      }
      const body = isMutation(method) ? await readBody(request, limit) : null;
      const result = await options.routeHandler({
        request,
        requestId: id,
        method,
        path: parsedUrl.pathname,
        query: parsedUrl.url.searchParams,
        headers: request.headers,
        body,
      });
      if (result === null || result === undefined) fail('NOT_FOUND', 404);
      const cors: Readonly<Record<string, string>> = request.headers.origin === options.origin
        ? { 'access-control-allow-origin': options.origin, vary: 'Origin' }
        : {};
      sendJson(response, result.status, result.body ?? null, id, { ...cors, ...(result.headers ?? {}) }, method === 'HEAD');
    } catch (error) {
      sendError(response, error, id);
    }
  });

  const listen = server.listen.bind(server);
  server.listen = ((...args: unknown[]) => {
    if (args.length > 2 || typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0 || args[0] > 65_535) {
      throw new TypeError('HTTP API listen accepts only a numeric TCP port and optional callback');
    }
    if (args.length === 2 && typeof args[1] !== 'function') {
      throw new TypeError('HTTP API listen accepts only a numeric TCP port and optional callback');
    }
    return listen({ port: args[0], host: LOOPBACK_HOST }, args[1] as (() => void) | undefined);
  }) as Server['listen'];
  return server;
}
