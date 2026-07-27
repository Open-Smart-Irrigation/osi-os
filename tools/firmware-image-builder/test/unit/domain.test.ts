import { describe, expect, it } from 'vitest';

import {
  ACTOR_MUTATION_GROUPS,
  ACTOR_NAMES,
  ACTIVE_RECOVERY_STATES,
  CLEANUP_ADMISSION_STATES,
  EVIDENCE_OUTCOMES,
  FRESHNESS_STATES,
  JOB_STATES,
  PIPELINE_STAGE_NAMES,
  STATE_TRANSITIONS,
  TARGET_IDS,
  TERMINAL_STATES,
  TRUSTED_OPERATION_IDS,
  isActorName,
  isCleanupAdmissionState,
  isFreshnessState,
  isPipelineStageName,
  isTargetId,
  isTrustedOperationId,
  type EvidenceResult,
  type FreshnessResult,
  type CommandResult,
  type CleanupAdmissionState,
  type OperationResult,
  type FreshnessState,
  type ActorName,
  type AdmissionId,
  type JobState,
  type PipelineStageName,
  type TargetId,
  type TrustedOperationId,
} from '../../domain/types.js';
import { canTransition } from '../../domain/states.js';
import {
  BUILDER_ERROR_CODES,
  assertAdmissionId,
  BuilderError,
  createBuilderError,
  StateTransitionError,
  type BuilderErrorCode,
} from '../../domain/errors.js';
import { assertTransition, isAllowedState, isTerminalState } from '../../domain/states.js';

const expectedTargets = ['rpi-5', 'rpi-2'] as const;
const expectedStages = [
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
] as const;
const expectedOperations = [
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
] as const;
const expectedStates = [
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
] as const;

const expectedErrorCodes = [
  'INVALID_BRANCH',
  'INVALID_SHA',
  'PREFLIGHT_INVALID_TARGET',
  'PREFLIGHT_INVALID_OUTPUT_ROOT',
  'PREFLIGHT_NOT_FOUND',
  'PREFLIGHT_REQUEST_MISMATCH',
  'PREFLIGHT_INVALID_ID',
  'PREFLIGHT_CACHE_DUPLICATE',
  'PREFLIGHT_CACHE_FULL',
  'SOURCE_UNAVAILABLE',
  'REPOSITORY_UNAVAILABLE',
  'TOOL_UNAVAILABLE',
  'BUILDER_LOCK_INVALID',
  'TARGET_MANIFEST_INVALID',
  'OUTPUT_ROOT_INVALID',
  'STAGING_DIRECTORY_INVALID',
  'STAGING_FILESYSTEM_MISMATCH',
  'BRANCH_MOVED',
  'PREFLIGHT_EXPIRED',
  'PREFLIGHT_DISK_SPACE',
  'DOCKER_UNAVAILABLE',
  'DOCKER_EXECUTION_DEFINITION_MISMATCH',
  'BUILDER_DIGEST_MISMATCH',
  'SYSTEMD_USER_UNAVAILABLE',
  'GIT_FETCH_FAILED',
  'ORIGIN_NOT_SSH',
  'FRESHNESS_UNKNOWN',
  'SOURCE_NOT_COMMIT',
  'WORKTREE_CREATE_FAILED',
  'OUTPUT_COLLISION',
  'BUILD_OUTPUT_COLLISION',
  'RELEASE_GATE_FAILED',
  'FRONTEND_DEPENDENCY_FAILURE',
  'FRONTEND_TYPECHECK_FAILED',
  'GUI_MIRROR_MISMATCH',
  'FEED_INSTALL_FAILED',
  'FEED_LINKS_MISSING',
  'PATCH_STATE_AMBIGUOUS',
  'TARGET_CONFIG_MISMATCH',
  'BUILDER_HOST_INCOMPATIBLE',
  'RUST_BOOTSTRAP_UNAVAILABLE',
  'BUILD_FAILED',
  'RUNNER_DISAPPEARED',
  'SERVICE_START_FAILED',
  'CLEANUP_CREDENTIAL_INVALID',
  'CLEANUP_ADMISSION_BLOCKED',
  'CLEANUP_UNIT_UNEXPECTED_EXIT',
  'CLEANUP_UNIT_STOP_FAILED',
  'DOCKER_CONTAINER_ORPHANED',
  'ARTIFACT_STALE',
  'ARTIFACT_TOO_SMALL',
  'CHECKSUM_FAILED',
  'GZIP_FAILED',
  'ROOTFS_CONTENT_FAILED',
  'PUBLISH_RECOVERY_FAILED',
  'UNVERIFIED_FINAL_PATH_BLOCKER',
  'QUARANTINE_PENDING',
  'PUBLISH_FAILED',
  'CANCELLED',
  'RECOVERY_LOG_GAP',
] as const;

const expectedActorMutationGroups = {
  api: [
    'request', 'queue', 'dispatch', 'cancellation-request', 'cleanup-admission',
    'recovery-terminal', 'lease-recovery', 'hand-back', 'fence-clear',
    'blocker-recheck', 'freshness-request',
  ],
  runner: [
    'lease', 'current-stage', 'stage', 'operation', 'container', 'artifact', 'publish',
    'cancellation-terminal', 'normal-terminal',
  ],
  'cleanup-worker': [
    'cleanup-lease-claim', 'cleanup-lease-renew', 'cleanup-lease-complete',
    'cleanup-evidence', 'container-identity-clear',
  ],
} as const;

const expectedStateTransitions = {
  queued: ['starting', 'cancelled'],
  starting: ['preflight', 'cancel_requested', 'interrupted'],
  preflight: ['source', 'failed', 'cancel_requested', 'interrupted'],
  source: ['release_gates', 'failed', 'cancel_requested', 'interrupted'],
  release_gates: ['frontend', 'failed', 'cancel_requested', 'interrupted'],
  frontend: ['target_setup', 'failed', 'cancel_requested', 'interrupted'],
  target_setup: ['feeds', 'failed', 'cancel_requested', 'interrupted'],
  feeds: ['config', 'failed', 'cancel_requested', 'interrupted'],
  config: ['building', 'failed', 'cancel_requested', 'interrupted'],
  building: ['verifying', 'failed', 'cancel_requested', 'interrupted'],
  verifying: ['publishing', 'failed', 'cancel_requested', 'interrupted'],
  publishing: ['succeeded', 'failed'],
  cancel_requested: ['cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
} as const;

const commandResult: CommandResult = {
  argv: ['make', '-C', 'openwrt'],
  exitCode: 0,
  signal: null,
  startedAt: '2026-07-23T00:00:00.000Z',
  finishedAt: '2026-07-23T00:00:01.000Z',
  timedOut: false,
};
const passedOperation: OperationResult<string> = {
  operationId: 'build-image', outcome: 'passed', command: commandResult, value: 'ok',
};
const passedEvidence: EvidenceResult = {
  stage: 'build', operationId: 'build-image', outcome: 'passed',
  evidencePath: 'evidence/build.json', evidenceSha256: 'a'.repeat(64),
};
const freshResult: FreshnessResult = {
  status: 'fresh', pinnedSha: 'a'.repeat(40), observedSha: 'a'.repeat(40), newerSourceAvailable: false,
};
const unknownFreshnessResult: FreshnessResult = {
  status: 'unknown', pinnedSha: 'a'.repeat(40), observedSha: null,
  newerSourceAvailable: false, errorCode: 'FRESHNESS_UNKNOWN',
};

// @ts-expect-error TargetId is closed to the two manifest targets.
const invalidTarget: import('../../domain/types.js').TargetId = 'rpi-6';
// @ts-expect-error PipelineStageName is closed to the ten manifest stages.
const invalidStage: PipelineStageName = 'compile';
// @ts-expect-error TrustedOperationId is closed to the installed operation registry.
const invalidOperationId: TrustedOperationId = 'run-shell';
// @ts-expect-error JobState is closed to the state machine vocabulary.
const invalidJobState: JobState = 'running';
// @ts-expect-error FreshnessState is closed to fresh, advanced, and unknown.
const invalidFreshnessState: FreshnessState = 'stale';
// @ts-expect-error CleanupAdmissionState is closed to the durable admission statuses.
const invalidCleanupState: CleanupAdmissionState = 'released';
// @ts-expect-error ActorName is closed to the three owning actors.
const invalidActor: ActorName = 'worker';
// @ts-expect-error A failed operation must carry an error and cannot carry a value.
const invalidOperation: OperationResult<string> = {
  operationId: 'build-image', outcome: 'failed', command: commandResult, value: 'not allowed',
};
// @ts-expect-error A passed operation cannot carry a failure error.
const invalidPassedOperation: OperationResult<string> = {
  operationId: 'build-image', outcome: 'passed', command: commandResult, value: 'ok',
  error: new BuilderError({
    code: 'BUILD_FAILED', stage: 'build', details: {}, retryable: false, requestId: 'type-test',
    diagnosis: 'failure', recovery: 'recover',
  }),
};
// @ts-expect-error A failed evidence result must carry a stable error.
const invalidEvidence: EvidenceResult = {
  stage: 'build', operationId: 'build-image', outcome: 'failed',
  evidencePath: 'evidence/build.json', evidenceSha256: 'a'.repeat(64),
};
// @ts-expect-error Unknown freshness must not claim that a newer source is available.
const invalidUnknownFreshness: FreshnessResult = {
  status: 'unknown', pinnedSha: 'a'.repeat(40), observedSha: null,
  newerSourceAvailable: true, errorCode: 'FRESHNESS_UNKNOWN',
};
void [EVIDENCE_OUTCOMES, passedOperation, passedEvidence, freshResult, unknownFreshnessResult,
  invalidTarget, invalidStage, invalidOperationId, invalidJobState, invalidFreshnessState,
  invalidCleanupState, invalidActor, invalidOperation, invalidPassedOperation, invalidEvidence,
  invalidUnknownFreshness];

describe('builder domain vocabulary', () => {
  it('exposes exhaustive readonly runtime vocabularies', () => {
    expect(TARGET_IDS).toEqual(expectedTargets);
    expect(PIPELINE_STAGE_NAMES).toEqual(expectedStages);
    expect(TRUSTED_OPERATION_IDS).toEqual(expectedOperations);
    expect(JOB_STATES).toEqual(expectedStates);
    expect(FRESHNESS_STATES).toEqual(['fresh', 'advanced', 'unknown']);
    expect(CLEANUP_ADMISSION_STATES).toEqual([
      'admitted', 'claimed', 'completed', 'failed', 'blocking', 'expired', 'handed_back',
    ]);
    expect(ACTOR_NAMES).toEqual(['api', 'runner', 'cleanup-worker']);
    expect(ACTIVE_RECOVERY_STATES).toEqual([
      'starting', 'preflight', 'source', 'release_gates', 'frontend',
      'target_setup', 'feeds', 'config', 'building', 'verifying', 'cancel_requested',
    ]);
    expect(TERMINAL_STATES).toEqual(['succeeded', 'failed', 'cancelled', 'interrupted']);
    expect(ACTOR_MUTATION_GROUPS).toEqual(expectedActorMutationGroups);
  });

  it('derives the public unions from the runtime tuples', () => {
    const target: TargetId = TARGET_IDS[0];
    const stage: PipelineStageName = PIPELINE_STAGE_NAMES[0];
    const operation: TrustedOperationId = TRUSTED_OPERATION_IDS[0];
    const state: JobState = JOB_STATES[0];
    const actor: ActorName = ACTOR_NAMES[0];
    expect([target, stage, operation, state, actor]).toHaveLength(5);
    expect(isTargetId(target)).toBe(true);
    expect(isPipelineStageName(stage)).toBe(true);
    expect(isTrustedOperationId(operation)).toBe(true);
    expect(isFreshnessState('unknown')).toBe(true);
    expect(isCleanupAdmissionState('handed_back')).toBe(true);
    expect(isActorName(actor)).toBe(true);
  });

  it('derives terminal and allowed-state predicates from the canonical tuples', () => {
    for (const state of JOB_STATES) {
      expect(isAllowedState(state)).toBe(true);
      expect(isTerminalState(state)).toBe((TERMINAL_STATES as readonly string[]).includes(state));
    }
    expect(isAllowedState('not-a-state')).toBe(false);
    expect(isTerminalState('not-a-state')).toBe(false);
  });

  it('rejects unsafe admission IDs and accepts only the exact grammar', () => {
    const accepted = assertAdmissionId('cln_0123456789abcdefghjkmnpqrs' as string);
    expect(accepted).toBe('cln_0123456789abcdefghjkmnpqrs');
    const unsafe = [
      '', 'cln_', 'cln_0123456789abcdefghjkmnpqr', 'cln_0123456789abcdefghjkmnpqrst',
      'CLN_0123456789abcdefghjkmnpqrs', 'cln_0123456789abcdefghjkmnpqrs/',
      'cln_0123456789abcdefghjkmnpqrs@', 'cln_0123456789abcdefghjkmnpqrs.',
      'cln_0123456789abcdefghijklmno', 'cln_0123456789abcdefghjkmnpqrs%20',
      'cln_8123456789abcdefghjkmnpqrs',
    ];
    for (const value of unsafe) expect(() => assertAdmissionId(value)).toThrow(BuilderError);
    const branded: AdmissionId = accepted;
    expect(branded).toBe(accepted);
  });

  it('allows only listed state transitions', () => {
    expect(canTransition('queued', 'starting')).toBe(true);
    expect(canTransition('release_gates', 'interrupted')).toBe(true);
    expect(canTransition('publishing', 'succeeded')).toBe(true);
    expect(canTransition('queued', 'preflight')).toBe(false);
    expect(canTransition('publishing', 'cancel_requested')).toBe(false);
    expect(canTransition('succeeded', 'failed')).toBe(false);
    expect(STATE_TRANSITIONS.succeeded).toEqual([]);
  });

  it('rejects every state pair not listed in the transition map', () => {
    expect(STATE_TRANSITIONS).toEqual(expectedStateTransitions);
    for (const from of expectedStates) {
      for (const to of expectedStates) {
        const allowed = (expectedStateTransitions[from] as readonly string[]).includes(to);
        expect(canTransition(from, to)).toBe(allowed);
      }
    }
  });

  it('keeps transition rows exhaustive and immutable at runtime', () => {
    expect(Object.keys(STATE_TRANSITIONS)).toEqual(expectedStates);
    expect(Object.isFrozen(STATE_TRANSITIONS)).toBe(true);
    for (const state of expectedStates) expect(Object.isFrozen(STATE_TRANSITIONS[state])).toBe(true);
  });

  it('reports illegal transitions as an internal typed error', () => {
    expect(() => assertTransition('queued', 'preflight', 'req-transition')).toThrow(StateTransitionError);
    try {
      assertTransition('queued', 'preflight', 'req-transition');
    } catch (error) {
      expect(error).toMatchObject({
        from: 'queued', to: 'preflight', requestId: 'req-transition',
      });
      expect(error).not.toBeInstanceOf(BuilderError);
      expect((error as { code?: unknown }).code).toBeUndefined();
      expect(JSON.stringify(error)).toBe('{}');
    }
  });
});

describe('builder error contract', () => {
  it('creates an exact stable serialized error without stack/name/cause metadata', () => {
    const error = createBuilderError({
      code: 'BUILD_FAILED',
      stage: 'build',
      details: { exitCode: 17, command: 'make' },
      retryable: true,
      requestId: 'req-123',
      diagnosis: 'The image build command failed.',
      recovery: 'Inspect the build log and create a new job after correction.',
      evidencePath: 'evidence/build.json',
    });
    expect(error).toBeInstanceOf(BuilderError);
    expect(error).toMatchObject({
      code: 'BUILD_FAILED',
      stage: 'build',
      details: { exitCode: 17, command: 'make' },
      retryable: true,
      requestId: 'req-123',
      diagnosis: 'The image build command failed.',
      recovery: 'Inspect the build log and create a new job after correction.',
      evidencePath: 'evidence/build.json',
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'BUILD_FAILED',
      stage: 'build',
      details: { exitCode: 17, command: 'make' },
      retryable: true,
      requestId: 'req-123',
      diagnosis: 'The image build command failed.',
      recovery: 'Inspect the build log and create a new job after correction.',
      evidencePath: 'evidence/build.json',
    });
  });

  it('redacts hostile keys and non-finite numbers without prototype effects', () => {
    const details = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(details, '__proto__', {
      enumerable: true, value: { polluted: true }, writable: true, configurable: true,
    });
    Object.defineProperty(details, 'constructor', {
      enumerable: true, value: { polluted: true }, writable: true, configurable: true,
    });
    Object.defineProperty(details, 'prototype', {
      enumerable: true, value: { polluted: true }, writable: true, configurable: true,
    });
    details.nan = Number.NaN;
    details.infinity = Number.POSITIVE_INFINITY;
    details.negativeInfinity = Number.NEGATIVE_INFINITY;
    details.values = [1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null];

    const error = createBuilderError({
      code: 'BUILD_FAILED',
      stage: 'build',
      details: details as never,
      retryable: false,
      requestId: 'req-hostile',
      diagnosis: 'diagnosis',
      recovery: 'recovery',
    });

    expect(Object.getPrototypeOf(error.details)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(JSON.stringify(error))).toEqual(JSON.parse(JSON.stringify({
      code: 'BUILD_FAILED',
      stage: 'build',
      details: JSON.parse('{"__proto__":"[redacted]","constructor":"[redacted]","prototype":"[redacted]","nan":"[redacted]","infinity":"[redacted]","negativeInfinity":"[redacted]","values":[1,"[redacted]","[redacted]","[redacted]",null]}'),
      retryable: false,
      requestId: 'req-hostile',
      diagnosis: 'diagnosis',
      recovery: 'recovery',
    })));
  });

  it('keeps the error code union aligned with the stable taxonomy', () => {
    expect(BUILDER_ERROR_CODES).toEqual(expectedErrorCodes);
    const code: BuilderErrorCode = 'ORIGIN_NOT_SSH';
    expect(code).toBe('ORIGIN_NOT_SSH');
  });
});
