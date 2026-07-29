// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildForm } from '../components/BuildForm.js';
import type { BranchRecord, BuilderTarget, OutputRoot, PreflightResult, SourceSelection } from '../types.js';

afterEach(cleanup);

const selection: SourceSelection = {
  branch: 'main',
  expectedSha: 'a'.repeat(40),
  targetId: 'rpi-5',
  outputRootId: 'release',
};
const branches: readonly BranchRecord[] = [{
  name: 'main',
  sha: selection.expectedSha,
  commitTime: '2026-07-28T10:00:00.000Z',
  subject: 'Current main firmware',
}, {
  name: 'design-sync/agrolink',
  sha: 'b'.repeat(40),
  commitTime: '2026-07-28T09:00:00.000Z',
  subject: 'Agrolink branding',
}];
const targets: readonly BuilderTarget[] = [{
  id: 'rpi-5',
  label: 'Raspberry Pi 5',
  environment: 'bcm2712',
  openwrtTarget: 'bcm27xx/bcm2712',
  profile: 'DEVICE_rpi-5',
  rootfs: 'ext4',
  artifactGlob: '*.img.gz',
  rootfsPartSize: 14336,
  minimumArtifactBytes: 1,
  configSymbols: [],
  operations: [],
}, {
  id: 'rpi-2',
  label: 'Pi 4 / 400 / 3 / 2',
  environment: 'bcm2709',
  openwrtTarget: 'bcm27xx/bcm2709',
  profile: 'DEVICE_rpi-2',
  rootfs: 'ext4',
  artifactGlob: '*.img.gz',
  rootfsPartSize: 14336,
  minimumArtifactBytes: 1,
  configSymbols: [],
  operations: [],
}];
const roots: readonly OutputRoot[] = [{ id: 'release', label: 'SD card images', path: '/home/phil/sdcard-images/0.7' }];
const passed: PreflightResult = {
  preflightId: 'pf_current',
  observedSha: selection.expectedSha,
  expiresAt: '2026-07-28T10:10:00.000Z',
  checks: [
    { id: 'docker', status: 'passed', details: { available: true } },
    { id: 'output-collision', status: 'passed', details: { exists: false } },
  ],
};

function renderForm(preflight: PreflightResult | null = passed) {
  const onSelectionChange = vi.fn();
  const onStartBuild = vi.fn();
  render(<BuildForm
    branches={branches}
    targets={targets}
    roots={roots}
    selection={selection}
    preflight={preflight}
    branchSnapshotAt="2026-07-28T10:00:00.000Z"
    now="2026-07-28T10:05:00.000Z"
    busy={null}
    errorCode={null}
    onSelectionChange={onSelectionChange}
    onRefreshBranches={vi.fn()}
    onRunPreflight={vi.fn()}
    onStartBuild={onStartBuild}
  />);
  return { onSelectionChange, onStartBuild };
}

describe('BuildForm', () => {
  it('shows immutable source and destination context and starts only with current passing preflight', () => {
    const { onStartBuild } = renderForm();

    expect(screen.getByText('Current main firmware')).toBeInTheDocument();
    expect(screen.getByText(selection.expectedSha)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/sdcard-images\/0.7\/main\//)).toHaveAttribute('readonly');
    const start = screen.getByRole('button', { name: 'Start build' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStartBuild).toHaveBeenCalledOnce();
  });

  it('emits the complete next selection and relies on the parent to clear stale preflight', () => {
    const { onSelectionChange } = renderForm();

    fireEvent.change(screen.getByLabelText('Remote branch'), { target: { value: 'design-sync/agrolink' } });
    expect(onSelectionChange).toHaveBeenCalledWith({
      ...selection,
      branch: 'design-sync/agrolink',
      expectedSha: 'b'.repeat(40),
    });
  });

  it.each([
    ['missing', null],
    ['expired', { ...passed, expiresAt: '2026-07-28T10:04:59.000Z' }],
    ['failed', { ...passed, checks: [{ id: 'docker', status: 'failed' as const, details: {}, errorCode: 'DOCKER_UNAVAILABLE' }] }],
    ['wrong SHA', { ...passed, observedSha: 'c'.repeat(40) }],
  ])('disables Start build for %s preflight evidence', (_case, preflight) => {
    renderForm(preflight);
    expect(screen.getByRole('button', { name: 'Start build' })).toBeDisabled();
  });
});
