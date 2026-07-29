export type ConfigDocumentErrorCode =
  | 'CONFIG_FILE_INVALID'
  | 'REPOSITORY_PATH_NOT_ABSOLUTE'
  | 'OUTPUT_ROOTS_INVALID'
  | 'OUTPUT_ROOT_ID_INVALID'
  | 'OUTPUT_ROOT_ID_DUPLICATE'
  | 'OUTPUT_ROOT_PATH_NOT_ABSOLUTE'
  | 'MAX_QUEUE_INVALID'
  | 'DISK_THRESHOLD_INVALID'
  | 'BUILDER_LOCK_PATH_INVALID';

export interface ApprovedOutputRootDocument {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface ValidatedConfigDocument {
  readonly repositoryPath: string;
  readonly approvedOutputRoots: readonly ApprovedOutputRootDocument[];
  readonly builderLockPath: string;
  readonly maxQueueLength: number;
  readonly diskFreeMinimumBytes: number;
}

export interface AuthorityTopologyInput {
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly installRoot: string;
  readonly repositoryPath?: string;
  readonly approvedOutputRoots?: readonly Readonly<{
    readonly id: string;
    readonly path: string;
  }>[];
}

export interface ValidatedAuthorityTopology {
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly installRoot: string;
  readonly repositoryPath?: string;
  readonly approvedOutputRoots?: readonly Readonly<{
    readonly id: string;
    readonly path: string;
  }>[];
}

export const DEFAULT_MAX_QUEUE_LENGTH: 50;
export const MIN_DISK_FREE_BYTES: number;
export const DEFAULT_BUILDER_LOCK_FILE: 'builder.lock.json';
export const ROOT_ID_PATTERN: RegExp;
export const BUILDER_VERSION_PATTERN: RegExp;
export const MAX_ROOT_LABEL_BYTES: 128;

export class ConfigDocumentValidationError extends Error {
  readonly code: ConfigDocumentErrorCode;
  readonly field?: string;
  constructor(code: ConfigDocumentErrorCode, message: string, field?: string);
}

export class AuthorityTopologyValidationError extends Error {
  readonly code: 'AUTHORITY_TOPOLOGY_INVALID';
  readonly field?: string;
  constructor(message: string, field?: string);
}

export function validateRepositoryPath(value: unknown): string;
export function validateApprovedOutputRoots(value: unknown): readonly ApprovedOutputRootDocument[];
export function validateMaxQueueLength(value: unknown): number;
export function validateDiskFreeMinimumBytes(value: unknown): number;
export function validateBuilderLockPath(value: unknown): string;
export function validateAuthorityTopology(value: AuthorityTopologyInput): ValidatedAuthorityTopology;
export function validateConfigDocument(raw: unknown): ValidatedConfigDocument;
