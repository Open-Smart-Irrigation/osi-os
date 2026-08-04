export const JOB_STATES = [
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

export type JobState = (typeof JOB_STATES)[number];
export type TargetId = 'rpi-5' | 'rpi-2';
export type StageName =
  | 'preflight'
  | 'source'
  | 'release-gates'
  | 'frontend'
  | 'target-setup'
  | 'feeds'
  | 'config'
  | 'build'
  | 'verify'
  | 'publish';

export interface BuilderTarget {
  readonly id: TargetId;
  readonly label: string;
  readonly environment: string;
  readonly openwrtTarget: string;
  readonly profile: string;
  readonly rootfs: string;
  readonly artifactGlob: string;
  readonly rootfsPartSize: number;
  readonly minimumArtifactBytes: number;
  readonly configSymbols: readonly Readonly<{ name: string; type: 'bool' | 'string' | 'number'; value: boolean | string | number }>[];
  readonly operations: readonly string[];
}

export interface OutputRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface BuilderConfig {
  readonly repository: Readonly<{ path: string; remote: 'origin' }>;
  readonly approvedOutputRoots: readonly OutputRoot[];
  readonly targets: readonly BuilderTarget[];
}

export interface HealthSnapshot {
  readonly status: 'ok';
  readonly version: string;
  readonly activeJobId: string | null;
}

export interface BranchRecord {
  readonly name: string;
  readonly sha: string;
  readonly commitTime: string;
  readonly subject: string;
}

export interface BranchSnapshot {
  readonly fetchedAt: string;
  readonly branches: readonly BranchRecord[];
}

export interface SourceSelection {
  readonly branch: string;
  readonly expectedSha: string;
  readonly targetId: TargetId;
  readonly outputRootId: string;
}

export interface PreflightCheck {
  readonly id: string;
  readonly status: 'passed' | 'failed';
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly errorCode?: string;
}

export interface PreflightResult {
  readonly preflightId: string;
  readonly observedSha: string;
  readonly expiresAt: string;
  readonly checks: readonly PreflightCheck[];
}

export interface JobSummary {
  readonly id: string;
  readonly state: JobState;
  readonly branch: string;
  readonly targetId: TargetId;
  readonly outputRootId: string;
  readonly acceptedAt: string;
  readonly currentStage: StageName | null;
  readonly queuePosition: number | null;
  readonly terminalAt: string | null;
}

export interface PublicJobError {
  readonly code: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly at?: string;
}

export interface StageEvidence {
  readonly stage: StageName;
  readonly outcome: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted' | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly path: string | null;
  readonly evidenceSha256: string | null;
  readonly errorCode: string | null;
}

export interface ArtifactRecord {
  readonly rootId: string;
  readonly directory: string | null;
  readonly path: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly mtime: string;
  readonly publishState: string | null;
  readonly publishedAt: string | null;
}

export interface JobDetail extends JobSummary {
  readonly stage: StageName | null;
  readonly pinnedSha: string;
  readonly cancelRequestedAt: string | null;
  readonly artifact: ArtifactRecord | null;
  readonly freshnessStatus: 'fresh' | 'advanced' | 'unknown';
  readonly freshnessCheckedAt: string | null;
  readonly newerSourceAvailable: boolean;
  readonly error: PublicJobError | null;
  readonly source: Readonly<{
    branch: string;
    sourceRef: string;
    expectedSha: string;
    pinnedSha: string;
    commitTime: string;
    author: string;
    subject: string;
  }>;
  readonly output: ArtifactRecord | null;
  readonly errors: Readonly<{
    terminal: PublicJobError | null;
    publish: PublicJobError | null;
    cleanup: PublicJobError | null;
    freshness: PublicJobError | null;
  }>;
  readonly cancellation: Readonly<{
    requestedAt: string | null;
    cooperativeDeadlineAt: string | null;
    graceDeadlineAt: string | null;
  }>;
  readonly runtime: Readonly<{
    runnerUnit: string | null;
    dispatchedAt: string | null;
    cleanupOutcome: string | null;
  }>;
  readonly evidence: readonly StageEvidence[];
}

export type CancellationResult =
  | Readonly<{ kind: 'queued-cancelled'; jobId: string; state: 'cancelled'; requestPersisted: true }>
  | Readonly<{ kind: 'late-publishing'; jobId: string; state: 'publishing'; late: true; requestPersisted: true }>
  | Readonly<{ kind: 'runner-terminal'; jobId: string; state: Extract<JobState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>; runnerOwned: true; requestPersisted: true }>
  | Readonly<{ kind: 'coordination-pending'; jobId: string; state: Exclude<JobState, 'queued' | 'publishing' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>; requestPersisted: true; cancellationClockHighWaterAt: string; cooperativeDeadlineAt: string }>;

export type CancelJobResponse = JobDetail & Readonly<{ cancellationResult: CancellationResult }>;

export interface JobPage {
  readonly jobs: readonly JobSummary[];
  readonly nextCursor: string | null;
}

export interface JobEvent {
  readonly seq: number;
  readonly event: string;
  readonly state: JobState | null;
  readonly stage: StageName | null;
  readonly at: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface EventPage {
  readonly events: readonly JobEvent[];
  readonly next: number;
}

export interface AcceptedJob {
  readonly id: string;
  readonly state: 'queued';
  readonly queuePosition: number;
  readonly branch: string;
  readonly targetId: TargetId;
  readonly outputRootId: string;
}

export interface EvidenceDocument {
  readonly schemaVersion: number;
  readonly jobId: string;
  readonly stage: StageName;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: string;
  readonly operationId: string | null;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly commands: readonly Readonly<Record<string, unknown>>[];
  readonly error: Readonly<Record<string, unknown>> | null;
}

export interface ApiErrorBody {
  readonly error: Readonly<{
    code: string;
    message: string;
    stage: string | null;
    details: Readonly<Record<string, string | number | boolean | null>>;
    retryable: boolean;
    requestId: string;
  }>;
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'closed';
