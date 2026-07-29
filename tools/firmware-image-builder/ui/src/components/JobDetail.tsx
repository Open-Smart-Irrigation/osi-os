import { Ban, FileCheck2, FolderOpen, RefreshCcw, RotateCw, ScrollText } from 'lucide-react';
import { useState } from 'react';

import type { ConnectionState, EvidenceDocument, JobDetail, JobEvent, StageName } from '../types.js';
import { StatusBadge } from './StatusBadge.js';

const ACTIVE = new Set<JobDetail['state']>([
  'starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup',
  'feeds', 'config', 'building', 'verifying', 'cancel_requested',
]);
const STAGE_INDEX: Readonly<Record<StageName, number>> = {
  preflight: 0,
  source: 1,
  'release-gates': 2,
  frontend: 3,
  'target-setup': 4,
  feeds: 5,
  config: 6,
  build: 7,
  verify: 8,
  publish: 9,
};

type DetailTab = 'activity' | 'verification' | 'files';

export interface JobDetailPanelProps {
  readonly job: JobDetail;
  readonly events: readonly JobEvent[];
  readonly connection: ConnectionState;
  readonly runnerActive?: boolean;
  readonly loadedEvidence?: EvidenceDocument | null;
  readonly busyAction: 'cancel' | 'recover' | 'retry' | 'recheck' | null;
  readonly onCancel: () => void;
  readonly onRecover: (retry: boolean) => void;
  readonly onRecheckPublish: () => void;
  readonly onLoadEvidence: (stage: StageName) => void;
}

export function JobDetailPanel(props: JobDetailPanelProps) {
  const [tab, setTab] = useState<DetailTab>('activity');
  const recoverable = props.job.state === 'interrupted'
    || props.job.errors.cleanup !== null
    || props.job.error?.code === 'RUNNER_DISAPPEARED';
  const retryBlocked = props.job.errors.cleanup !== null;
  const publishBlocked = props.job.errors.publish?.code === 'UNVERIFIED_FINAL_PATH_BLOCKER';

  return (
    <section className="job-detail" aria-labelledby="job-detail-title">
      <div className="job-detail__header">
        <div>
          <div className="job-detail__identity">
            <StatusBadge state={props.job.state} />
            <span className={`connection connection--${props.connection}`}>Connection {props.connection}</span>
            {props.runnerActive !== undefined && (
              <span className={`runner-status runner-status--${props.runnerActive ? 'active' : 'inactive'}`}>
                Runner {props.runnerActive ? 'active' : 'inactive'}
              </span>
            )}
          </div>
          <h2 id="job-detail-title">{props.job.branch}</h2>
          <code>{props.job.pinnedSha}</code>
        </div>
        <div className="job-detail__actions">
          {ACTIVE.has(props.job.state) && props.job.state !== 'cancel_requested' && (
            <button className="button button--danger-secondary" type="button" disabled={props.busyAction !== null} onClick={props.onCancel}>
              <Ban size={16} aria-hidden="true" />
              Cancel build
            </button>
          )}
          {recoverable && (
            <button className="button button--secondary" type="button" disabled={props.busyAction !== null} onClick={() => props.onRecover(retryBlocked)}>
              <RefreshCcw size={16} aria-hidden="true" />
              {retryBlocked ? 'Retry cleanup' : 'Recover cleanup'}
            </button>
          )}
          {publishBlocked && (
            <button className="button button--secondary" type="button" disabled={props.busyAction !== null} onClick={props.onRecheckPublish}>
              <RotateCw size={16} aria-hidden="true" />
              Recheck publish
            </button>
          )}
        </div>
      </div>

      {props.job.error !== null && (
        <div className="error-strip" role="alert">
          <strong>{props.job.error.code}</strong>
          {Object.entries(props.job.error.details).map(([key, value]) => <span key={key}>{key}: {String(value)}</span>)}
        </div>
      )}

      <div className="detail-tabs" role="tablist" aria-label="Job details">
        <button role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}><ScrollText size={16} aria-hidden="true" />Activity</button>
        <button role="tab" aria-selected={tab === 'verification'} onClick={() => setTab('verification')}><FileCheck2 size={16} aria-hidden="true" />Verification</button>
        <button role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}><FolderOpen size={16} aria-hidden="true" />Files</button>
      </div>

      {tab === 'activity' && (
        <div className="detail-panel" role="tabpanel">
          <ol className="activity-list">
            {props.events.map((event) => (
              <li key={event.seq}>
                <span className="activity-list__marker" aria-hidden="true" />
                <div>
                  <strong>{event.event.replaceAll('_', ' ')}</strong>
                  <span>{event.stage ?? event.state ?? 'job'}</span>
                  {event.at !== null && <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>}
                  {typeof event.data.text === 'string' && <pre>{event.data.text}</pre>}
                  {(event.event === 'log-gap' || event.event === 'log-truncated') && (
                    <code>{typeof event.data.reason === 'string' ? event.data.reason : 'RECOVERY_LOG_GAP'}</code>
                  )}
                </div>
              </li>
            ))}
            {props.events.length === 0 && <li className="empty-state">No activity recorded.</li>}
          </ol>
        </div>
      )}

      {tab === 'verification' && (
        <div className="detail-panel" role="tabpanel">
          <div className="verification-list">
            {props.job.evidence.map((evidence) => (
              <button key={evidence.stage} type="button" disabled={evidence.path === null} onClick={() => props.onLoadEvidence(evidence.stage)}>
                <span className={`verification-state verification-state--${evidence.outcome ?? 'pending'}`} aria-hidden="true" />
                <strong>{String(STAGE_INDEX[evidence.stage]).padStart(2, '0')} · {evidence.stage}</strong>
                <span>{evidence.outcome ?? 'pending'}</span>
                <time dateTime={evidence.finishedAt ?? evidence.startedAt ?? undefined}>
                  {evidence.finishedAt === null ? 'In progress' : new Date(evidence.finishedAt).toLocaleString()}
                </time>
              </button>
            ))}
          </div>
          {props.loadedEvidence !== undefined && props.loadedEvidence !== null && (
            <div className="evidence-inspector" aria-live="polite">
              <div>
                <strong>{props.loadedEvidence.stage}</strong>
                <span>{props.loadedEvidence.outcome}</span>
              </div>
              <dl>
                {props.loadedEvidence.commands.map((command, index) => (
                  <div key={index}>
                    <dt>Command {index + 1}</dt>
                    <dd><code>{String(command.operationId ?? command.executable ?? 'recorded')}</code></dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {props.job.artifact !== null && (
            <dl className="artifact-facts">
              <div><dt>Artifact SHA-256</dt><dd><code>{props.job.artifact.sha256}</code></dd></div>
              <div><dt>Size</dt><dd>{props.job.artifact.size.toLocaleString()} bytes</dd></div>
              <div><dt>Publish state</dt><dd>{props.job.artifact.publishState ?? 'not started'}</dd></div>
            </dl>
          )}
        </div>
      )}

      {tab === 'files' && (
        <div className="detail-panel" role="tabpanel">
          <ul className="file-list">
            {props.job.evidence.filter((item) => item.path !== null).map((item) => <li key={item.stage}><FileCheck2 size={15} aria-hidden="true" /><code>{item.path}</code></li>)}
            {props.job.artifact?.directory !== null && props.job.artifact?.directory !== undefined && <li><FolderOpen size={15} aria-hidden="true" /><code>{props.job.artifact.directory}</code></li>}
            {props.job.artifact?.path !== null && props.job.artifact?.path !== undefined && <li><FolderOpen size={15} aria-hidden="true" /><code>{props.job.artifact.path}</code></li>}
          </ul>
        </div>
      )}
    </section>
  );
}
