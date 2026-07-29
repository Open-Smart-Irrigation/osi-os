// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../components/JobDetail.js';
import type { JobDetail, JobEvent } from '../types.js';

afterEach(cleanup);

const job: JobDetail = {
  id: 'job-detail',
  state: 'building',
  branch: 'main',
  targetId: 'rpi-5',
  outputRootId: 'release',
  acceptedAt: '2026-07-28T10:00:00.000Z',
  currentStage: 'build',
  terminalAt: null,
  queuePosition: null,
  stage: 'build',
  pinnedSha: 'a'.repeat(40),
  cancelRequestedAt: null,
  artifact: null,
  freshnessStatus: 'fresh',
  freshnessCheckedAt: '2026-07-28T10:00:00.000Z',
  newerSourceAvailable: false,
  error: null,
  source: {
    branch: 'main',
    sourceRef: 'refs/remotes/origin/main',
    expectedSha: 'a'.repeat(40),
    pinnedSha: 'a'.repeat(40),
    commitTime: '2026-07-28T09:00:00.000Z',
    author: 'OSI',
    subject: 'Main firmware',
  },
  output: null,
  errors: { terminal: null, publish: null, cleanup: null, freshness: null },
  cancellation: { requestedAt: null, cooperativeDeadlineAt: null, graceDeadlineAt: null },
  runtime: { runnerUnit: 'osi-image-builder-runner@job-detail.service', dispatchedAt: '2026-07-28T10:00:01.000Z', cleanupOutcome: null },
  evidence: [{
    stage: 'build',
    outcome: 'running',
    startedAt: '2026-07-28T10:00:02.000Z',
    finishedAt: null,
    path: 'evidence/07-build.json',
    evidenceSha256: 'b'.repeat(64),
    errorCode: null,
  }],
};
const events: readonly JobEvent[] = [{
  seq: 3,
  event: 'stage',
  state: 'building',
  stage: 'build',
  at: '2026-07-28T10:00:02.000Z',
  data: {},
}];

describe('JobDetailPanel', () => {
  it('switches between activity, verification, and known files without rendering credentials', () => {
    render(<JobDetailPanel job={job} events={events} connection="live" busyAction={null} onCancel={vi.fn()} onRecover={vi.fn()} onRecheckPublish={vi.fn()} onLoadEvidence={vi.fn()} />);

    expect(screen.getByText('Connection live')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Verification' }));
    expect(screen.getByText('07 · build')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByText('evidence/07-build.json')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/credential|\\.token/i);
  });

  it('exposes explicit cancel and recovery commands for active work', () => {
    const onCancel = vi.fn();
    const onRecover = vi.fn();
    const staleJob = {
      ...job,
      error: { code: 'RUNNER_DISAPPEARED', details: {} },
    };
    render(<JobDetailPanel job={staleJob} events={events} connection="reconnecting" busyAction={null} onCancel={onCancel} onRecover={onRecover} onRecheckPublish={vi.fn()} onLoadEvidence={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel build' }));
    expect(onCancel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Recover cleanup' }));
    expect(onRecover).toHaveBeenCalledWith(false);
  });

  it('does not offer cleanup recovery for a healthy active runner', () => {
    render(<JobDetailPanel job={job} events={events} connection="live" runnerActive busyAction={null} onCancel={vi.fn()} onRecover={vi.fn()} onRecheckPublish={vi.fn()} onLoadEvidence={vi.fn()} />);

    expect(screen.getByText('Runner active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover cleanup' })).not.toBeInTheDocument();
  });
});
