import {
  BUILDER_ERROR_CODES,
  isAdmissionId,
  type AdmissionId,
  type BuilderErrorContract,
  type BuilderErrorCode,
  type ErrorDetails,
  type JobState,
  type PipelineStageName,
  type SerializedBuilderError,
  type TrustedOperationId,
} from './types.js';

export { BUILDER_ERROR_CODES } from './types.js';
export type { BuilderErrorCode, ErrorDetails, SerializedBuilderError } from './types.js';

export interface BuilderErrorInput {
  readonly code: BuilderErrorCode;
  readonly stage: PipelineStageName | null;
  readonly details: ErrorDetails;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly diagnosis: string;
  readonly recovery: string;
  readonly evidencePath?: string;
  readonly operationId?: TrustedOperationId;
}

type SafeDetailValue = string | number | boolean | null;

const RESERVED_DETAIL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REDACTED_DETAIL = '[redacted]';

function safeScalar(value: unknown): SafeDetailValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return REDACTED_DETAIL;
}

function safeDetails(details: ErrorDetails): ErrorDetails {
  const result = Object.create(null) as Record<string, SafeDetailValue | readonly SafeDetailValue[]>;
  for (const [key, value] of Object.entries(details)) {
    if (RESERVED_DETAIL_KEYS.has(key)) {
      result[key] = REDACTED_DETAIL;
    } else if (Array.isArray(value)) {
      result[key] = Object.freeze(value.map((item) => safeScalar(item)));
    } else {
      result[key] = safeScalar(value);
    }
  }
  return Object.freeze(result);
}

export class BuilderError extends Error implements BuilderErrorContract {
  readonly code: BuilderErrorCode;
  readonly stage: PipelineStageName | null;
  readonly details: ErrorDetails;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly diagnosis: string;
  readonly recovery: string;
  readonly evidencePath?: string;
  readonly operationId?: TrustedOperationId;

  constructor(input: BuilderErrorInput) {
    super(input.diagnosis);
    this.name = 'BuilderError';
    this.code = input.code;
    this.stage = input.stage;
    this.details = safeDetails(input.details);
    this.retryable = input.retryable;
    this.requestId = input.requestId;
    this.diagnosis = input.diagnosis;
    this.recovery = input.recovery;
    this.evidencePath = input.evidencePath;
    this.operationId = input.operationId;
  }

  toJSON(): SerializedBuilderError {
    return {
      code: this.code,
      stage: this.stage,
      details: this.details,
      retryable: this.retryable,
      requestId: this.requestId,
      diagnosis: this.diagnosis,
      recovery: this.recovery,
      ...(this.evidencePath === undefined ? {} : { evidencePath: this.evidencePath }),
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
    };
  }
}

export function createBuilderError(input: BuilderErrorInput): BuilderError {
  return new BuilderError(input);
}

export function serializeBuilderError(error: BuilderError): SerializedBuilderError {
  return error.toJSON();
}

export function assertAdmissionId(value: unknown, requestId = 'domain'): AdmissionId {
  if (!isAdmissionId(value)) {
    throw new BuilderError({
      code: 'CLEANUP_CREDENTIAL_INVALID',
      stage: null,
      details: { field: 'admissionId' },
      retryable: false,
      requestId,
      diagnosis: 'The cleanup admission ID is invalid.',
      recovery: 'Generate a new tool-owned cleanup admission and retry recovery.',
    });
  }
  return value;
}

export class StateTransitionError extends Error {
  readonly #from: JobState;
  readonly #to: JobState;
  readonly #requestId: string;

  constructor(from: JobState, to: JobState, requestId: string) {
    super(`The state transition ${from} -> ${to} is not allowed.`);
    this.#from = from;
    this.#to = to;
    this.#requestId = requestId;
  }

  get from(): JobState { return this.#from; }
  get to(): JobState { return this.#to; }
  get requestId(): string { return this.#requestId; }
}
