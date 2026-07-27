export const TARGET_IDS = Object.freeze(['rpi-5', 'rpi-2'] as const);
export type TargetId = (typeof TARGET_IDS)[number];

export const PIPELINE_STAGE_NAMES = Object.freeze([
  'preflight',
  'source',
  'release-gates',
  'frontend',
  'target-setup',
  'feeds',
  'config',
  'build',
  'verify',
  'publish',
] as const);
export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number];

export const TRUSTED_OPERATION_IDS = Object.freeze([
  'activate-target',
  'copy-feed-config',
  'update-feeds',
  'install-feeds',
  'resolve-config',
  'build-image',
  'verify-image',
  'verify-profile-parity',
  'verify-chameleon',
  'verify-db-schema',
  'verify-sync-flow',
  'verify-strega',
  'verify-communication',
  'check-mqtt-topics',
  'frontend-install',
  'frontend-test',
  'frontend-typecheck',
  'frontend-build',
  'mirror-gui',
] as const);
export type TrustedOperationId = (typeof TRUSTED_OPERATION_IDS)[number];

export const BUILDER_ERROR_CODES = Object.freeze([
  'INVALID_BRANCH', 'INVALID_SHA', 'PREFLIGHT_INVALID_TARGET', 'PREFLIGHT_INVALID_OUTPUT_ROOT',
  'PREFLIGHT_NOT_FOUND', 'PREFLIGHT_REQUEST_MISMATCH', 'PREFLIGHT_INVALID_ID',
  'PREFLIGHT_CACHE_DUPLICATE', 'PREFLIGHT_CACHE_FULL', 'SOURCE_UNAVAILABLE',
  'REPOSITORY_UNAVAILABLE', 'TOOL_UNAVAILABLE', 'BUILDER_LOCK_INVALID',
  'TARGET_MANIFEST_INVALID', 'OUTPUT_ROOT_INVALID', 'STAGING_DIRECTORY_INVALID',
  'STAGING_FILESYSTEM_MISMATCH',
  'BRANCH_MOVED', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_DISK_SPACE', 'DOCKER_UNAVAILABLE',
  'DOCKER_EXECUTION_DEFINITION_MISMATCH', 'BUILDER_DIGEST_MISMATCH', 'SYSTEMD_USER_UNAVAILABLE',
  'GIT_FETCH_FAILED', 'ORIGIN_NOT_SSH', 'FRESHNESS_UNKNOWN', 'SOURCE_NOT_COMMIT',
  'WORKTREE_CREATE_FAILED', 'OUTPUT_COLLISION', 'BUILD_OUTPUT_COLLISION', 'RELEASE_GATE_FAILED',
  'FRONTEND_DEPENDENCY_FAILURE', 'FRONTEND_TYPECHECK_FAILED', 'GUI_MIRROR_MISMATCH',
  'FEED_INSTALL_FAILED', 'FEED_LINKS_MISSING', 'PATCH_STATE_AMBIGUOUS', 'TARGET_CONFIG_MISMATCH',
  'BUILDER_HOST_INCOMPATIBLE', 'RUST_BOOTSTRAP_UNAVAILABLE', 'BUILD_FAILED', 'RUNNER_DISAPPEARED',
  'SERVICE_START_FAILED', 'CLEANUP_CREDENTIAL_INVALID', 'CLEANUP_ADMISSION_BLOCKED',
  'CLEANUP_UNIT_UNEXPECTED_EXIT', 'CLEANUP_UNIT_STOP_FAILED', 'DOCKER_CONTAINER_ORPHANED',
  'ARTIFACT_STALE', 'ARTIFACT_TOO_SMALL', 'CHECKSUM_FAILED', 'GZIP_FAILED', 'ROOTFS_CONTENT_FAILED',
  'PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER', 'QUARANTINE_PENDING', 'PUBLISH_FAILED',
  'CANCELLED', 'RECOVERY_LOG_GAP',
] as const);
export type BuilderErrorCode = (typeof BUILDER_ERROR_CODES)[number];

type JsonScalar = string | number | boolean | null;
export type ErrorDetails = Readonly<Record<string, JsonScalar | readonly JsonScalar[]>>;

export interface BuilderErrorContract {
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

export type SerializedBuilderError = BuilderErrorContract;

export const JOB_STATES = Object.freeze([
  'queued',
  'starting',
  'preflight',
  'source',
  'release_gates',
  'frontend',
  'target_setup',
  'feeds',
  'config',
  'building',
  'verifying',
  'publishing',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const);
export type JobState = (typeof JOB_STATES)[number];

export const FRESHNESS_STATES = Object.freeze(['fresh', 'advanced', 'unknown'] as const);
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export const CLEANUP_ADMISSION_STATES = Object.freeze([
  'admitted',
  'claimed',
  'completed',
  'failed',
  'blocking',
  'expired',
  'handed_back',
] as const);
export type CleanupAdmissionState = (typeof CLEANUP_ADMISSION_STATES)[number];

export const ACTOR_NAMES = Object.freeze(['api', 'runner', 'cleanup-worker'] as const);
export type ActorName = (typeof ACTOR_NAMES)[number];

export const ACTIVE_RECOVERY_STATES = Object.freeze([
  'starting',
  'preflight',
  'source',
  'release_gates',
  'frontend',
  'target_setup',
  'feeds',
  'config',
  'building',
  'verifying',
  'cancel_requested',
] as const);
export type ActiveRecoveryState = (typeof ACTIVE_RECOVERY_STATES)[number];

export const TERMINAL_STATES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const);
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const ACTOR_MUTATION_GROUPS = Object.freeze({
  api: Object.freeze([
    'request',
    'queue',
    'dispatch',
    'cancellation-request',
    'cleanup-admission',
    'recovery-terminal',
    'lease-recovery',
    'hand-back',
    'fence-clear',
    'blocker-recheck',
    'freshness-request',
  ] as const),
  runner: Object.freeze([
    'lease',
    'current-stage',
    'stage',
    'operation',
    'container',
    'artifact',
    'publish',
    'cancellation-terminal',
    'normal-terminal',
  ] as const),
  'cleanup-worker': Object.freeze([
    'cleanup-lease-claim',
    'cleanup-lease-renew',
    'cleanup-lease-complete',
    'cleanup-evidence',
    'container-identity-clear',
  ] as const),
} as const);
export type ActorMutationGroups = typeof ACTOR_MUTATION_GROUPS;
export type MutationName = ActorMutationGroups[keyof ActorMutationGroups][number];

const freezeTransitions = <const T extends readonly JobState[]>(values: T): T =>
  Object.freeze(values) as T;

export const STATE_TRANSITIONS = Object.freeze({
  queued: freezeTransitions(['starting', 'cancelled']),
  starting: freezeTransitions(['preflight', 'cancel_requested', 'interrupted']),
  preflight: freezeTransitions(['source', 'failed', 'cancel_requested', 'interrupted']),
  source: freezeTransitions(['release_gates', 'failed', 'cancel_requested', 'interrupted']),
  release_gates: freezeTransitions(['frontend', 'failed', 'cancel_requested', 'interrupted']),
  frontend: freezeTransitions(['target_setup', 'failed', 'cancel_requested', 'interrupted']),
  target_setup: freezeTransitions(['feeds', 'failed', 'cancel_requested', 'interrupted']),
  feeds: freezeTransitions(['config', 'failed', 'cancel_requested', 'interrupted']),
  config: freezeTransitions(['building', 'failed', 'cancel_requested', 'interrupted']),
  building: freezeTransitions(['verifying', 'failed', 'cancel_requested', 'interrupted']),
  verifying: freezeTransitions(['publishing', 'failed', 'cancel_requested', 'interrupted']),
  publishing: freezeTransitions(['succeeded', 'failed']),
  cancel_requested: freezeTransitions(['cancelled', 'interrupted']),
  succeeded: freezeTransitions([]),
  failed: freezeTransitions([]),
  cancelled: freezeTransitions([]),
  interrupted: freezeTransitions([]),
} as const satisfies { readonly [State in JobState]: readonly JobState[] });
export type StateTransitions = typeof STATE_TRANSITIONS;
export type AllowedTransition = {
  [From in JobState]: (typeof STATE_TRANSITIONS)[From][number] extends infer To
    ? To extends JobState ? { readonly from: From; readonly to: To } : never
    : never;
}[JobState];

export const OPERATION_OUTCOMES = Object.freeze(['passed', 'failed'] as const);
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

export const EVIDENCE_OUTCOMES = Object.freeze(['passed', 'failed'] as const);
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export interface CommandResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly timedOut: boolean;
}

export type OperationResult<TValue = unknown> = {
  readonly operationId: TrustedOperationId;
  readonly outcome: 'passed';
  readonly command: CommandResult;
  readonly value: TValue;
  readonly error?: never;
} | {
  readonly operationId: TrustedOperationId;
  readonly outcome: 'failed';
  readonly command: CommandResult;
  readonly value?: never;
  readonly error: BuilderErrorContract;
};

export type EvidenceResult = {
  readonly stage: PipelineStageName;
  readonly operationId: TrustedOperationId;
  readonly outcome: 'passed';
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly error?: never;
} | {
  readonly stage: PipelineStageName;
  readonly operationId: TrustedOperationId;
  readonly outcome: 'failed';
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly error: BuilderErrorContract;
};

export type FreshnessResult =
  | {
    readonly status: 'fresh';
    readonly pinnedSha: string;
    readonly observedSha: string;
    readonly newerSourceAvailable: false;
  }
  | {
    readonly status: 'advanced';
    readonly pinnedSha: string;
    readonly observedSha: string;
    readonly newerSourceAvailable: true;
  }
  | {
    readonly status: 'unknown';
    readonly pinnedSha: string;
    readonly observedSha: null;
    readonly newerSourceAvailable: false;
    readonly errorCode: 'FRESHNESS_UNKNOWN';
  };

declare const admissionIdBrand: unique symbol;
export type AdmissionId = string & { readonly [admissionIdBrand]: 'AdmissionId' };

export const ADMISSION_ID_PATTERN = /^cln_[0-7][0-9a-hj-km-np-tv-z]{25}$/;
export const CLEANUP_CREDENTIAL_TOKEN_MIN_CHARS = 16;
export const CLEANUP_CREDENTIAL_TOKEN_MAX_CHARS = 4096;

export function isAdmissionId(value: unknown): value is AdmissionId {
  return typeof value === 'string' && ADMISSION_ID_PATTERN.test(value);
}

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === 'string' && (TARGET_IDS as readonly string[]).includes(value);
}

export function isPipelineStageName(value: unknown): value is PipelineStageName {
  return typeof value === 'string' && (PIPELINE_STAGE_NAMES as readonly string[]).includes(value);
}

export function isTrustedOperationId(value: unknown): value is TrustedOperationId {
  return typeof value === 'string' && (TRUSTED_OPERATION_IDS as readonly string[]).includes(value);
}

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

export function isFreshnessState(value: unknown): value is FreshnessState {
  return typeof value === 'string' && (FRESHNESS_STATES as readonly string[]).includes(value);
}

export function isCleanupAdmissionState(value: unknown): value is CleanupAdmissionState {
  return typeof value === 'string' && (CLEANUP_ADMISSION_STATES as readonly string[]).includes(value);
}

export function isActorName(value: unknown): value is ActorName {
  return typeof value === 'string' && (ACTOR_NAMES as readonly string[]).includes(value);
}
