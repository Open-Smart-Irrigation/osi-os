import { Ban, ChevronRight, RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { JobState, JobSummary } from '../types.js';
import { StatusBadge } from './StatusBadge.js';

const TERMINAL = new Set<JobState>(['succeeded', 'failed', 'cancelled', 'interrupted']);

function targetLabel(targetId: JobSummary['targetId']): string {
  return targetId === 'rpi-5' ? 'Pi 5' : 'Pi 4 / 400 / 3 / 2';
}

function elapsed(job: JobSummary, now: string): string {
  const end = job.terminalAt ?? now;
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(job.acceptedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface QueueTableProps {
  readonly jobs: readonly JobSummary[];
  readonly selectedJobId: string | null;
  readonly now: string;
  readonly onSelect: (jobId: string) => void;
  readonly onCancel: (jobId: string) => void;
  readonly onBuildNewer: (jobId: string) => void;
}

export function QueueTable(props: QueueTableProps) {
  const [stateFilter, setStateFilter] = useState<'all' | 'active' | 'terminal'>('all');
  const [branchFilter, setBranchFilter] = useState('');
  const visible = useMemo(() => props.jobs.filter((job) => {
    const terminal = TERMINAL.has(job.state);
    if (stateFilter === 'active' && terminal) return false;
    if (stateFilter === 'terminal' && !terminal) return false;
    return branchFilter.length === 0 || job.branch.toLowerCase().includes(branchFilter.toLowerCase());
  }), [branchFilter, props.jobs, stateFilter]);

  return (
    <section className="queue-section" aria-labelledby="queue-title">
      <div className="section-heading section-heading--queue">
        <div>
          <p className="section-kicker">Queue and history</p>
          <h2 id="queue-title">{props.jobs.length} jobs</h2>
        </div>
        <div className="table-filters">
          <label>
            <span className="sr-only">Filter by state</span>
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}>
              <option value="all">All states</option>
              <option value="active">Active</option>
              <option value="terminal">History</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by branch</span>
            <input type="search" placeholder="Filter branch" value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} />
          </label>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Branch</th>
              <th scope="col">Target</th>
              <th scope="col">State</th>
              <th scope="col">Stage</th>
              <th scope="col">Elapsed</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((job) => (
              <tr key={job.id} data-selected={props.selectedJobId === job.id || undefined}>
                <td>
                  <strong>{job.branch}</strong>
                  <code>{job.id.slice(0, 12)}</code>
                </td>
                <td>{targetLabel(job.targetId)}</td>
                <td><StatusBadge state={job.state} /></td>
                <td>{job.currentStage ?? 'Waiting'}</td>
                <td>{elapsed(job, props.now)}</td>
                <td>
                  <div className="row-actions">
                    {!TERMINAL.has(job.state) && (
                      <button className="icon-button" type="button" title="Cancel job" aria-label={`Cancel job ${job.id}`} onClick={() => props.onCancel(job.id)}>
                        <Ban size={16} aria-hidden="true" />
                      </button>
                    )}
                    {job.state === 'succeeded' && (
                      <button className="icon-button" type="button" title="Build newer commit" aria-label={`Build newer commit for ${job.id}`} onClick={() => props.onBuildNewer(job.id)}>
                        <RotateCw size={16} aria-hidden="true" />
                      </button>
                    )}
                    <button className="icon-button" type="button" title="View job" aria-label={`View job ${job.id}`} onClick={() => props.onSelect(job.id)}>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td className="empty-table" colSpan={6}>No jobs match the filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
