import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BuilderError } from '../../domain/errors.js';
import {
  PIPELINE_STAGE_NAMES,
  TRUSTED_OPERATION_IDS,
  type PipelineStageName,
} from '../../domain/types.js';
import { parseJson, JSON_LIMITS, type JsonValue } from './validation.js';

const LOOPBACK_HOST = '127.0.0.1';
const API_PREFIX = '/api/';
const CLOUD_PREFIX = '/api/v1/';
const MAX_BODY_BYTES = JSON_LIMITS.maxEncodedBytes;
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const BODY_DRAIN_TIMEOUT_MS = 5_000;
const HASH40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const TARGET_ID = /^rpi-[25]$/u;
const SAFE_HEADER_VALUE = /^[\t\x20-\x7e]*$/u;
const SAFE_RETRY_AFTER = /^(?:0|[1-9][0-9]{0,8})$/u;
const SAFE_ROUTE_HEADERS = new Set(['location', 'retry-after']);
const SHA40_KEYS = new Set(['expectedSha', 'observedSha']);
const SHA64_KEYS = new Set(['sha256', 'artifactSha256', 'evidenceSha256', 'manifestSha256', 'checksumSha256', 'verificationSha256']);
const INTEGER_DETAIL_KEYS = new Set(['availableBytes', 'requiredBytes', 'timeoutSeconds']);
const STAGE_SET = new Set<string>(PIPELINE_STAGE_NAMES);
const OPERATION_SET = new Set<string>(TRUSTED_OPERATION_IDS);

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

function hasRequestFraming(request: IncomingMessage): boolean {
  return request.headers['content-length'] !== undefined
    || request.headers['transfer-encoding'] !== undefined;
}

function drainRequest(request: IncomingMessage): void {
  request.resume();
  if (!request.socket.destroyed) request.socket.setTimeout(BODY_DRAIN_TIMEOUT_MS, () => request.socket.destroy());
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

function publicStage(value: unknown): PipelineStageName | null {
  return typeof value === 'string' && STAGE_SET.has(value) ? value as PipelineStageName : null;
}

function publicDetails(value: unknown): SafeDetails {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of [...SHA40_KEYS, ...SHA64_KEYS, ...INTEGER_DETAIL_KEYS, 'targetId', 'operationId', 'signal']) {
    const item = input[key];
    if (SHA40_KEYS.has(key) && typeof item === 'string' && HASH40.test(item)) output[key] = item;
    else if (SHA64_KEYS.has(key) && typeof item === 'string' && HASH64.test(item)) output[key] = item;
    else if (INTEGER_DETAIL_KEYS.has(key) && Number.isSafeInteger(item) && Number(item) >= 0) output[key] = Number(item);
    else if (key === 'targetId' && typeof item === 'string' && TARGET_ID.test(item)) output[key] = item;
    else if (key === 'operationId' && typeof item === 'string' && OPERATION_SET.has(item)) output[key] = item;
    else if (key === 'signal' && (item === 'SIGINT' || item === 'SIGHUP' || item === 'SIGTERM' || item === 'SIGKILL')) output[key] = item;
  }
  return output;
}

function safeErrorEnvelope(error: unknown, id: string): { readonly error: Readonly<Record<string, unknown>> } {
  if (error instanceof BuilderError) {
    return {
      error: {
        code: error.code,
        message: publicMessage(error.code),
        stage: publicStage(error.stage),
        details: publicDetails(error.details),
        retryable: error.retryable === true,
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
        details: publicDetails(error.details),
        retryable: error.retryable === true,
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
    case 'BRANCH_MOVED': return 'The remote branch changed after the displayed SHA.';
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
    case 'BODY_NOT_ALLOWED': return 'Request bodies are not allowed for this method.';
    default: return 'The request was rejected.';
  }
}

function fail(code: string, status: number, details?: SafeDetails): never {
  throw new HttpTransportError({ code, status, details });
}

function responseStatus(status: unknown): number {
  if (!Number.isInteger(status) || Number(status) < 200 || Number(status) > 599) {
    throw new HttpTransportError({ code: 'INTERNAL_ERROR', status: 500, retryable: true });
  }
  return Number(status);
}

function routeHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!SAFE_ROUTE_HEADERS.has(key) || typeof value !== 'string' || !SAFE_HEADER_VALUE.test(value)) continue;
    if (key === 'location' && (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 2_048)) continue;
    if (key === 'retry-after' && !SAFE_RETRY_AFTER.test(value)) continue;
    if (output[key] === undefined) output[key] = value;
  }
  return output;
}

interface SendJsonOptions {
  readonly routeHeaders?: Readonly<Record<string, string>>;
  readonly suppressBody?: boolean;
  readonly closeConnection?: boolean;
  readonly corsOrigin?: string;
  readonly preflight?: boolean;
}

function sendJson(response: ServerResponse, status: number, body: unknown, id: string, options: SendJsonOptions = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const validStatus = responseStatus(status);
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    sendError(response, new HttpTransportError({ code: 'INTERNAL_ERROR', status: 500, retryable: true }), id, options.closeConnection === true);
    return;
  }
  if (encoded === undefined) {
    sendError(response, new HttpTransportError({ code: 'INTERNAL_ERROR', status: 500, retryable: true }), id, options.closeConnection === true);
    return;
  }
  const noBodyStatus = validStatus === 204 || validStatus === 304;
  const payload = noBodyStatus ? '' : encoded;
  const corsHeaders = options.corsOrigin === undefined ? {} : {
    'access-control-allow-origin': options.corsOrigin,
    vary: 'Origin',
  };
  const preflightHeaders = options.preflight === true ? {
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  } : {};
  response.shouldKeepAlive = options.closeConnection !== true;
  response.writeHead(validStatus, {
    ...routeHeaders(options.routeHeaders ?? {}),
    ...corsHeaders,
    ...preflightHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload, 'utf8')),
    'cache-control': 'no-store',
    [REQUEST_ID_HEADER]: id,
    connection: options.closeConnection === true ? 'close' : 'keep-alive',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  if (!response.destroyed && !response.writableEnded) response.end(options.suppressBody === true ? undefined : payload);
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpTransportError
    && Number.isInteger(error.status) && error.status >= 200 && error.status <= 599) return error.status;
  if (error instanceof BuilderError && error.code === 'BRANCH_MOVED') return 409;
  return 500;
}

function sendError(response: ServerResponse, error: unknown, id: string, closeConnection = false, corsOrigin?: string): void {
  sendJson(response, errorStatus(error), safeErrorEnvelope(error, id), id, { closeConnection, corsOrigin });
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

function hasUnsafeTargetCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return character === '\\' || character === '#' || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function validatePercentEncoding(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) fail('INVALID_PATH', 400);
    index += 2;
  }
}

function parseRequestUrl(request: IncomingMessage): { readonly pathname: string; readonly query: URLSearchParams } {
  const rawTarget = request.url ?? '';
  if (rawTarget.length === 0 || !rawTarget.startsWith('/') || rawTarget.startsWith('//')
    || hasUnsafeTargetCharacter(rawTarget)) {
    fail('INVALID_PATH', 400);
  }
  validatePercentEncoding(rawTarget);

  const querySeparator = rawTarget.indexOf('?');
  const rawPath = querySeparator === -1 ? rawTarget : rawTarget.slice(0, querySeparator);
  const rawQuery = querySeparator === -1 ? '' : rawTarget.slice(querySeparator + 1);
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    fail('INVALID_PATH', 400);
  }
  if (hasUnsafeTargetCharacter(pathname) || pathname.includes('?') || pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail('INVALID_PATH', 400);
  }
  if (!pathname.startsWith(API_PREFIX)
    || pathname === '/api/v1' || pathname.startsWith(CLOUD_PREFIX)) {
    fail('NOT_FOUND', 404);
  }
  return { pathname, query: new URLSearchParams(rawQuery) };
}

function actualOrigin(request: IncomingMessage): string {
  const localPort = request.socket.localPort;
  if (typeof localPort !== 'number' || !Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) {
    fail('ORIGIN_FORBIDDEN', 403);
  }
  return `http://${LOOPBACK_HOST}:${localPort}`;
}

function checkOrigin(request: IncomingMessage): string {
  const origin = actualOrigin(request);
  const value = request.headers.origin;
  if (value === undefined) fail('ORIGIN_REQUIRED', 403);
  if (Array.isArray(value) || value !== origin) fail('ORIGIN_FORBIDDEN', 403);
  return origin;
}

function preflight(response: ServerResponse, request: IncomingMessage, id: string): void {
  const origin = checkOrigin(request);
  sendJson(response, 204, null, id, { corsOrigin: origin, preflight: true });
}

export function createHttpServer(options: HttpServerOptions): Server {
  const originMatch = /^http:\/\/127\.0\.0\.1:(0|[1-9]\d{0,4})$/u.exec(options.origin);
  const configuredPort = originMatch === null ? -1 : Number(originMatch[1]);
  if (configuredPort < 0 || configuredPort > 65_535) {
    throw new Error('HTTP API origin must be a loopback HTTP origin');
  }
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BODY_BYTES) throw new Error('HTTP API body limit is invalid');

  const server = createServer(async (request, response) => {
    const id = requestId();
    let closeConnection = false;
    let bodyReadSettled = false;
    try {
      const method = request.method ?? '';
      checkHost(request);
      const parsedUrl = parseRequestUrl(request);
      if (['GET', 'HEAD', 'OPTIONS'].includes(method) && hasRequestFraming(request)) {
        closeConnection = true;
        drainRequest(request);
        fail('BODY_NOT_ALLOWED', 400);
      }
      if (request.method === 'OPTIONS') {
        preflight(response, request, id);
        return;
      }
      if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method)) fail('METHOD_NOT_ALLOWED', 405);
      if (isMutation(method)) {
        checkOrigin(request);
        if (!contentTypeIsJson(request.headers['content-type'])) fail('JSON_REQUIRED', 415);
      }
      const body = isMutation(method) ? await readBody(request, limit) : null;
      bodyReadSettled = true;
      const result = await options.routeHandler({
        request,
        requestId: id,
        method,
        path: parsedUrl.pathname,
        query: parsedUrl.query,
        headers: request.headers,
        body,
      });
      if (result === null || result === undefined) fail('NOT_FOUND', 404);
      const status = responseStatus(result.status);
      const origin = actualOrigin(request);
      sendJson(response, status, result.body ?? null, id, {
        routeHeaders: result.headers,
        suppressBody: method === 'HEAD',
        closeConnection,
        corsOrigin: request.headers.origin === origin ? origin : undefined,
      });
    } catch (error) {
      if (isMutation(request.method ?? '') && !bodyReadSettled) {
        closeConnection = true;
        drainRequest(request);
      }
      const origin = (() => {
        try {
          const value = actualOrigin(request);
          return request.headers.origin === value ? value : undefined;
        } catch {
          return undefined;
        }
      })();
      sendError(response, error, id, closeConnection, origin);
    }
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.timeout = SOCKET_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  const listen = server.listen.bind(server);
  server.listen = ((...args: unknown[]) => {
    if (args.length > 2 || typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0 || args[0] > 65_535) {
      throw new TypeError('HTTP API listen accepts only a numeric TCP port and optional callback');
    }
    if (args.length === 2 && typeof args[1] !== 'function') {
      throw new TypeError('HTTP API listen accepts only a numeric TCP port and optional callback');
    }
    const requestedPort = args[0] as number;
    if (configuredPort !== requestedPort) {
      throw new Error('HTTP API configured origin port must match the requested listen port');
    }
    return listen({ port: requestedPort, host: LOOPBACK_HOST }, args[1] as (() => void) | undefined);
  }) as Server['listen'];
  return server;
}
