import { Check, CircleAlert, Hammer, RefreshCw, ScanSearch } from 'lucide-react';

import type {
  BranchRecord,
  BuilderTarget,
  OutputRoot,
  PreflightResult,
  SourceSelection,
  TargetId,
} from '../types.js';

const PREFLIGHT_STALE_MS = 10 * 60 * 1_000;

function branchSlug(branch: string): string {
  const bytes = new TextEncoder().encode(branch);
  let result = '';
  for (const byte of bytes) {
    const literal = (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
    result += literal ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return result;
}

function targetShortLabel(targetId: TargetId): string {
  return targetId === 'rpi-5' ? 'Pi 5' : 'Pi 4 / 400 / 3 / 2';
}

function validPreflight(preflight: PreflightResult | null, selection: SourceSelection, now: string): boolean {
  return preflight !== null
    && preflight.observedSha === selection.expectedSha
    && preflight.expiresAt > now
    && preflight.checks.length > 0
    && preflight.checks.every((check) => check.status === 'passed');
}

export interface BuildFormProps {
  readonly branches: readonly BranchRecord[];
  readonly targets: readonly BuilderTarget[];
  readonly roots: readonly OutputRoot[];
  readonly selection: SourceSelection;
  readonly preflight: PreflightResult | null;
  readonly branchSnapshotAt: string;
  readonly now: string;
  readonly busy: 'refresh' | 'preflight' | 'enqueue' | null;
  readonly errorCode: string | null;
  readonly onSelectionChange: (selection: SourceSelection) => void;
  readonly onRefreshBranches: () => void;
  readonly onRunPreflight: () => void;
  readonly onStartBuild: () => void;
}

export function BuildForm(props: BuildFormProps) {
  const branch = props.branches.find((item) => item.name === props.selection.branch) ?? null;
  const root = props.roots.find((item) => item.id === props.selection.outputRootId) ?? null;
  const destination = branch === null || root === null
    ? ''
    : `${root.path}/${branchSlug(branch.name)}/${branch.sha}/${props.selection.targetId}`;
  const branchSnapshotStale = Date.parse(props.now) - Date.parse(props.branchSnapshotAt) > PREFLIGHT_STALE_MS;
  const canStart = props.busy === null && validPreflight(props.preflight, props.selection, props.now);

  const changeBranch = (name: string): void => {
    const next = props.branches.find((item) => item.name === name);
    if (next !== undefined) props.onSelectionChange({ ...props.selection, branch: next.name, expectedSha: next.sha });
  };

  return (
    <section className="build-form" aria-labelledby="new-build-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">New image</p>
          <h2 id="new-build-title">Build configuration</h2>
        </div>
        <button className="icon-button" type="button" title="Refresh origin branches" aria-label="Refresh origin branches" disabled={props.busy !== null} onClick={props.onRefreshBranches}>
          <RefreshCw size={17} aria-hidden="true" />
        </button>
      </div>

      {branchSnapshotStale && (
        <div className="inline-notice inline-notice--warning" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          Branch snapshot is older than 10 minutes.
        </div>
      )}

      <div className="field">
        <label htmlFor="branch">Remote branch</label>
        <select id="branch" value={props.selection.branch} disabled={props.busy !== null} onChange={(event) => changeBranch(event.target.value)}>
          {props.branches.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </div>

      {branch !== null && (
        <div className="commit-summary">
          <code>{branch.sha}</code>
          <span>{branch.subject}</span>
          <time dateTime={branch.commitTime}>{new Date(branch.commitTime).toLocaleString()}</time>
        </div>
      )}

      <fieldset className="field">
        <legend>Target</legend>
        <div className="segmented-control">
          {props.targets.map((target) => (
            <button
              key={target.id}
              type="button"
              aria-pressed={props.selection.targetId === target.id}
              disabled={props.busy !== null}
              onClick={() => props.onSelectionChange({ ...props.selection, targetId: target.id })}
            >
              {targetShortLabel(target.id)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="output-root">Output location</label>
        <select
          id="output-root"
          value={props.selection.outputRootId}
          disabled={props.busy !== null}
          onChange={(event) => props.onSelectionChange({ ...props.selection, outputRootId: event.target.value })}
        >
          {props.roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {root !== null && <code className="field-hint">{root.path}</code>}
      </div>

      <div className="field">
        <label htmlFor="destination">Destination preview</label>
        <input id="destination" value={destination} readOnly />
      </div>

      <div className="preflight">
        <div className="preflight__header">
          <span>Preflight</span>
          {props.preflight !== null && <time dateTime={props.preflight.expiresAt}>Expires {new Date(props.preflight.expiresAt).toLocaleTimeString()}</time>}
        </div>
        {props.preflight === null ? (
          <p className="empty-state">No current preflight.</p>
        ) : (
          <ul className="check-list">
            {props.preflight.checks.map((check) => (
              <li key={check.id} className={check.status === 'passed' ? 'check-list__passed' : 'check-list__failed'}>
                {check.status === 'passed' ? <Check size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
                <span>{check.id.replaceAll('-', ' ')}</span>
                {check.errorCode !== undefined && <code>{check.errorCode}</code>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {props.errorCode !== null && <div className="inline-notice inline-notice--danger" role="alert">{props.errorCode}</div>}

      <div className="form-actions">
        <button className="button button--secondary" type="button" disabled={props.busy !== null || branch === null || root === null} onClick={props.onRunPreflight}>
          <ScanSearch size={17} aria-hidden="true" />
          {props.busy === 'preflight' ? 'Checking...' : 'Run preflight'}
        </button>
        <button className="button button--primary" type="button" disabled={!canStart} onClick={props.onStartBuild}>
          <Hammer size={17} aria-hidden="true" />
          {props.busy === 'enqueue' ? 'Starting...' : 'Start build'}
        </button>
      </div>
    </section>
  );
}
