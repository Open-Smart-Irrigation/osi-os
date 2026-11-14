import axios, {AxiosError, type AxiosAdapter, type AxiosResponse} from 'axios';
import {DemoError, Simulator, type DemoResponse} from './model';

type AdapterSimulator = Pick<Simulator, 'requestResponse'>;
export type DemoAdapterErrorHandler = (code: string, wire: DemoResponse) => void;
export type DemoAdapterResponseHandler = (method: string, path: string, wire: DemoResponse) => void;

async function responseText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return JSON.stringify(data);
}

async function asArrayBuffer(data: unknown): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Blob) return data.arrayBuffer();
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return new TextEncoder().encode(await responseText(data)).buffer;
}

async function encodeResponse(data: unknown, responseType: string | undefined, contentType: string): Promise<unknown> {
  if (responseType === 'blob') return data instanceof Blob ? data : new Blob([await asArrayBuffer(data)], {type: contentType});
  if (responseType === 'arraybuffer') return asArrayBuffer(data);
  if (responseType === 'text') return responseText(data);
  return data;
}

function decodeRequestBody(data: unknown, contentType: string | undefined): unknown {
  if (typeof data !== 'string') return data;
  if (!contentType?.toLowerCase().includes('json')) return data;
  try { return JSON.parse(data) as unknown; }
  catch { throw new DemoError(400, 'invalid_json', {error: 'invalid_json', message: 'Request body is not valid JSON'}); }
}

function errorCode(wire: DemoResponse): string {
  const payload = wire.data;
  return payload && typeof payload === 'object' && typeof (payload as {error?: unknown}).error === 'string'
    ? (payload as {error: string}).error : 'request_failed';
}

export function createDemoAdapter(sim: AdapterSimulator, onError?: DemoAdapterErrorHandler, onResponse?: DemoAdapterResponseHandler): AxiosAdapter {
  return async config => {
    let resolved: URL;
    try {
      const uri = axios.getUri({...config, baseURL: 'http://demo.invalid'});
      resolved = new URL(uri, 'http://demo.invalid');
    } catch {
      throw new AxiosError('Blocked simulator URL', 'ERR_DEMO_BLOCKED', config);
    }
    if (resolved.origin !== 'http://demo.invalid' || (config.baseURL && !['/', 'http://demo.invalid'].includes(config.baseURL))) {
      const wire = {status: 403, headers: {'content-type': 'application/json'}, data: {error: 'blocked'}};
      onError?.('blocked', wire);
      throw new AxiosError('Network access is disabled in this demo.', 'ERR_DEMO', config, undefined, {
        data: wire.data, status: wire.status, statusText: 'Forbidden', headers: wire.headers, config,
      });
    }

    const method = (config.method ?? 'GET').toUpperCase();
    const contentType = String(config.headers?.get?.('Content-Type') ?? config.headers?.['Content-Type'] ?? 'application/json');
    let wire: DemoResponse;
    try {
      wire = sim.requestResponse(method, `${resolved.pathname}${resolved.search}`, decodeRequestBody(config.data, contentType));
    } catch (error) {
      if (error instanceof DemoError) {
        wire = {status: error.status, headers: error.headers, data: error.data ?? {error: error.code}};
      } else {
        wire = {status: 422, headers: {'content-type': 'application/json'}, data: {error: 'invalid'}};
      }
    }
    const headers = Object.fromEntries(Object.entries(wire.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const code = errorCode(wire);
    onResponse?.(method, `${resolved.pathname}${resolved.search}`, wire);
    if (wire.status < 200 || wire.status >= 300) {
      onError?.(code, wire);
      const payload = wire.data;
      const detail = payload && typeof payload === 'object'
        ? (payload as {message?: unknown; detail?: unknown}).message ?? (payload as {detail?: unknown}).detail
        : undefined;
      const message = typeof detail === 'string' ? detail : code;
      const errorData = await encodeResponse(payload, config.responseType, headers['content-type'] ?? 'application/json');
      throw new AxiosError(message, 'ERR_DEMO', config, undefined, {
        data: errorData, status: wire.status, statusText: 'Simulator', headers, config,
      });
    }
    const response: AxiosResponse = {
      data: await encodeResponse(wire.data, config.responseType, headers['content-type'] ?? 'application/json'),
      status: wire.status, statusText: 'OK', headers, config,
    };
    return response;
  };
}
