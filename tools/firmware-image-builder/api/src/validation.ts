export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ readonly [key: string]: JsonValue }>;
export type JsonObject = Readonly<{ readonly [key: string]: JsonValue }>;

export const JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxKeys: 256,
  maxArrayElements: 256,
  maxNodes: 512,
  maxEdges: 1_024,
  maxEncodedBytes: 65_536,
  maxCommandBytes: 65_536,
});

export const TEXT_LIMITS: Readonly<Record<'maxTextBytes' | 'maxPathBytes' | 'maxIdentifierBytes' | 'maxChecksumBytes' | 'maxManifestBytes' | 'maxArgvBytes', number>> = Object.freeze({
  maxTextBytes: 65_536,
  maxPathBytes: 4_096,
  maxIdentifierBytes: 256,
  maxChecksumBytes: 65_536,
  maxManifestBytes: 65_536,
  maxArgvBytes: 65_536,
});

const CANONICAL_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

export class SharedValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SharedValidationError';
  }
}

export function boundedText(value: unknown, field: string, maxBytes = TEXT_LIMITS.maxTextBytes): string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new SharedValidationError(`${field} exceeds its bounded text limit`);
  }
  return value;
}

export function canonicalInstant(value: unknown, field: string): string {
  const text = boundedText(value, field, 32);
  const match = CANONICAL_INSTANT.exec(text);
  if (!match) throw new SharedValidationError(`${field} must be a canonical RFC3339 UTC instant`);
  const date = new Date(text);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== text) throw new SharedValidationError(`${field} is not a real calendar instant`);
  return text;
}

export function optionalInstant(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : canonicalInstant(value, field);
}

export function requireChronology(values: readonly (readonly [string, string | null | undefined])[]): void {
  let previous: readonly [string, string] | null = null;
  for (const [field, value] of values) {
    if (value === null || value === undefined) continue;
    canonicalInstant(value, field);
    if (previous !== null && previous[1] > value) throw new SharedValidationError(`${field} must not precede ${previous[0]}`);
    previous = [field, value];
  }
}

/** Path primitives are shared by command validation and persisted read mapping. */
export function stableRelativePath(value: unknown, field: string): string {
  const text = boundedText(value, field, TEXT_LIMITS.maxPathBytes);
  const parts = text.split('/');
  if (text.startsWith('/') || text.includes('\0') || text.includes('\\') || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new SharedValidationError(`${field} must be a stable relative path`);
  }
  return text;
}

export function canonicalAbsolutePath(value: unknown, field: string): string {
  const text = boundedText(value, field, TEXT_LIMITS.maxPathBytes);
  const parts = text.split('/');
  if (!text.startsWith('/') || text.includes('\0') || text.includes('\\') || parts.some((part, index) => index > 0 && (part.length === 0 || part === '.' || part === '..'))) {
    throw new SharedValidationError(`${field} must be a canonical absolute path`);
  }
  return text;
}

interface JsonBudget { nodes: number; edges: number }

function normalizeJsonInternal(value: unknown, field: string, depth: number, seen: WeakSet<object>, budget: JsonBudget): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > JSON_LIMITS.maxNodes || depth > JSON_LIMITS.maxDepth) throw new SharedValidationError(`${field} exceeds JSON bounds`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SharedValidationError(`${field} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') throw new SharedValidationError(`${field} contains a non-JSON value`);
  if (seen.has(value)) throw new SharedValidationError(`${field} contains a cyclic reference`);
  seen.add(value);
  try {
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    let keys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
      keys = Reflect.ownKeys(descriptors);
    } catch (error) {
      throw new SharedValidationError(`${field} contains an unreadable object`, { cause: error });
    }
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) throw new SharedValidationError(`${field} contains a non-plain object`);
    if (keys.some((key) => typeof key !== 'string')) throw new SharedValidationError(`${field} contains a symbol property`);
    const stringKeys = keys as string[];
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > JSON_LIMITS.maxArrayElements) throw new SharedValidationError(`${field} exceeds JSON array bounds`);
      const output: JsonValue[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) throw new SharedValidationError(`${field}[${index}] is an accessor or hole`);
        budget.edges += 1;
        if (budget.edges > JSON_LIMITS.maxEdges) throw new SharedValidationError(`${field} exceeds JSON edge bounds`);
        output.push(normalizeJsonInternal(descriptor.value, `${field}[${index}]`, depth + 1, seen, budget));
      }
      if (stringKeys.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) throw new SharedValidationError(`${field} contains an extra array property`);
      return output;
    }
    if (keys.length > JSON_LIMITS.maxKeys) throw new SharedValidationError(`${field} exceeds JSON key bounds`);
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const key of stringKeys.sort()) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new SharedValidationError(`${field}.${key} is an accessor property`);
      budget.edges += 1;
      if (budget.edges > JSON_LIMITS.maxEdges) throw new SharedValidationError(`${field} exceeds JSON edge bounds`);
      const normalized = normalizeJsonInternal(descriptor.value, `${field}.${key}`, depth + 1, seen, budget);
      Object.defineProperty(output, key, { configurable: true, enumerable: true, value: normalized, writable: true });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function normalizeJson(value: unknown, field: string, depth = 0, seen = new WeakSet<object>(), budget: JsonBudget = { nodes: 0, edges: 0 }): JsonValue {
  try { return normalizeJsonInternal(value, field, depth, seen, budget); }
  catch (error) {
    if (error instanceof SharedValidationError) throw error;
    throw new SharedValidationError(`${field} cannot be normalized`, { cause: error });
  }
}

interface CommandBudget { nodes: number; edges: number }

function normalizeCommandInternal(value: unknown, field: string, seen: WeakSet<object>, budget: CommandBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > JSON_LIMITS.maxNodes || budget.edges > JSON_LIMITS.maxEdges) throw new SharedValidationError(`${field} exceeds command bounds`);
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new SharedValidationError(`${field} contains a non-finite number`);
    return value;
  }
  if (typeof value === 'string') {
    return boundedText(value, field, TEXT_LIMITS.maxTextBytes);
  }
  if (typeof value !== 'object') throw new SharedValidationError(`${field} contains a non-command value`);
  if (seen.has(value)) throw new SharedValidationError(`${field} contains a cyclic reference`);
  seen.add(value);
  try {
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    let keys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
      keys = Reflect.ownKeys(descriptors);
    } catch (error) {
      throw new SharedValidationError(`${field} contains an unreadable command object`, { cause: error });
    }
    if (keys.some((property) => typeof property !== 'string')) throw new SharedValidationError(`${field} contains a symbol property`);
    const stringKeys = keys as string[];
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > JSON_LIMITS.maxArrayElements) throw new SharedValidationError(`${field} exceeds command array bounds`);
      const output: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) throw new SharedValidationError(`${field}[${index}] is an accessor or hole`);
        budget.edges += 1;
        output.push(normalizeCommandInternal(descriptor.value, `${field}[${index}]`, seen, budget));
      }
      if (stringKeys.some((property) => property !== 'length' && !/^(0|[1-9][0-9]*)$/.test(property))) throw new SharedValidationError(`${field} contains an extra array property`);
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) throw new SharedValidationError(`${field} contains a non-plain command object`);
    if (keys.length > JSON_LIMITS.maxKeys) throw new SharedValidationError(`${field} exceeds command key bounds`);
    const output = Object.create(null) as Record<string, unknown>;
    for (const property of stringKeys.sort()) {
      const descriptor = descriptors[property];
      if (!descriptor || !('value' in descriptor)) throw new SharedValidationError(`${field}.${property} is an accessor property`);
      budget.edges += 1;
      if (budget.edges > JSON_LIMITS.maxEdges) throw new SharedValidationError(`${field} exceeds command edge bounds`);
      Object.defineProperty(output, property, { configurable: true, enumerable: true, value: normalizeCommandInternal(descriptor.value, `${field}.${property}`, seen, budget), writable: true });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function normalizeCommand<T>(value: T, field = 'command'): T {
  try {
    const normalized = normalizeCommandInternal(value, field, new WeakSet<object>(), { nodes: 0, edges: 0 });
    const encoded = JSON.stringify(normalized);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > JSON_LIMITS.maxCommandBytes) throw new SharedValidationError(`${field} exceeds the aggregate command byte limit`);
    return normalized as T;
  }
  catch (error) {
    if (error instanceof SharedValidationError) throw error;
    throw new SharedValidationError(`${field} cannot be normalized`, { cause: error });
  }
}

export function encodeJson(value: unknown, field: string, objectOnly = false): string {
  if (objectOnly && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new SharedValidationError(`${field} must be a JSON object`);
  const normalized = normalizeJson(value, field);
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > JSON_LIMITS.maxEncodedBytes) throw new SharedValidationError(`${field} exceeds encoded JSON byte bounds`);
  return encoded;
}

export function parseJson(value: string, field: string, objectOnly = false): JsonValue {
  boundedText(value, field, JSON_LIMITS.maxEncodedBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new SharedValidationError(`${field} contains invalid JSON`, { cause: error }); }
  if (objectOnly && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) throw new SharedValidationError(`${field} must be a JSON object`);
  return normalizeJson(parsed, field);
}
