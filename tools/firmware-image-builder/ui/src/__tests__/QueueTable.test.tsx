// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueueTable } from '../components/QueueTable.js';
import type { JobSummary } from '../types.js';

afterEach(cleanup);

const jobs: readonly JobSummary[] = [{
  id: 'job-active',
  state: 'building',
  branch: 'main',
  targetId: 'rpi-5',
  outputRootId: 'release',
  acceptedAt: '2026-07-28T10:00:00.000Z',
  currentStage: 'build',
  queuePosition: null,
  terminalAt: null,
}, {
  id: 'job-queued',
  state: 'queued',
  branch: 'design-sync/agrolink',
  targetId: 'rpi-2',
  outputRootId: 'release',
  acceptedAt: '2026-07-28T10:01:00.000Z',
  currentStage: null,
  queuePosition: 0,
  terminalAt: null,
}];

describe('QueueTable', () => {
  it('renders active and queued work with stable operational fields', () => {
    render(<QueueTable jobs={jobs} selectedJobId={null} now="2026-07-28T10:05:00.000Z" onSelect={vi.fn()} onCancel={vi.fn()} onBuildNewer={vi.fn()} />);

    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('design-sync/agrolink')).toBeInTheDocument();
    expect(screen.getByText('Pi 5')).toBeInTheDocument();
    expect(screen.getByText('Pi 4 / 400 / 3 / 2')).toBeInTheDocument();
    expect(screen.getByText('build')).toBeInTheDocument();
  });

  it('uses explicit select and cancel commands without making the row itself destructive', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    render(<QueueTable jobs={jobs} selectedJobId={null} now="2026-07-28T10:05:00.000Z" onSelect={onSelect} onCancel={onCancel} onBuildNewer={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'View job job-active' }));
    expect(onSelect).toHaveBeenCalledWith('job-active');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job job-queued' }));
    expect(onCancel).toHaveBeenCalledWith('job-queued');
  });
});
