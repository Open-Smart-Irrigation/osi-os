// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { AnalysisControls } from '../AnalysisControls';

afterEach(cleanup);

const base = {
  rangeLabel: '7d',
  mode: 'timeline' as const,
  layout: 'stacked' as const,
  toggles: { normalize: false },
};

function renderControls(overrides: Partial<ComponentProps<typeof AnalysisControls>> = {}) {
  const props = {
    ...base,
    onRangeChange: vi.fn(),
    onModeChange: vi.fn(),
    onLayoutChange: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  };
  render(<AnalysisControls {...props} />);
  return props;
}

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

describe('AnalysisControls', () => {
  it('emits range and mode changes', () => {
    const onRangeChange = vi.fn();
    const onModeChange = vi.fn();
    renderControls({ onRangeChange, onModeChange });
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(onRangeChange).toHaveBeenCalledWith('30d');
    fireEvent.click(screen.getByRole('button', { name: 'analysis.mode.correlation' }));
    expect(onModeChange).toHaveBeenCalledWith('correlation');
  });

  it('shows timeline layout controls and normalize without multi-axis', () => {
    const onLayoutChange = vi.fn();
    renderControls({ onLayoutChange });

    expect(screen.getByRole('group', { name: 'analysis.layout.label' })).toBeInTheDocument();
    expect(screen.getByLabelText('analysis.toggle.normalize')).toBeInTheDocument();
    expect(screen.queryByLabelText(`analysis.toggle.${'multi' + 'Axis'}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'analysis.layout.overlaid' }));
    expect(onLayoutChange).toHaveBeenCalledWith('overlaid');
  });

  it('hides timeline layout and normalize controls in correlation mode', () => {
    renderControls({ mode: 'correlation' });

    expect(screen.queryByRole('group', { name: 'analysis.layout.label' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('analysis.toggle.normalize')).not.toBeInTheDocument();
  });

  it('emits normalize toggle changes', () => {
    const onToggle = vi.fn();
    renderControls({ onToggle });
    fireEvent.click(screen.getByLabelText('analysis.toggle.normalize'));
    expect(onToggle).toHaveBeenCalledWith('normalize', true);
  });

  it('applies a valid custom range as ISO instants', () => {
    const onRangeChange = vi.fn();
    renderControls({ onRangeChange });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.custom' }));
    fireEvent.change(screen.getByLabelText('analysis.range.from'), { target: { value: '2026-06-01T00:00' } });
    fireEvent.change(screen.getByLabelText('analysis.range.to'), { target: { value: '2026-06-02T12:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.apply' }));
    expect(onRangeChange).toHaveBeenCalledWith({
      mode: 'custom',
      label: 'custom',
      from: new Date('2026-06-01T00:00').toISOString(),
      to: new Date('2026-06-02T12:30').toISOString(),
    });
  });

  it('hydrates saved custom range bounds into datetime-local inputs', () => {
    const from = '2026-06-01T08:15:00.000Z';
    const to = '2026-06-02T17:45:00.000Z';
    renderControls({
      rangeLabel: 'custom',
      range: { mode: 'custom', label: 'custom', from, to },
    });

    expect(screen.getByLabelText('analysis.range.from')).toHaveValue(toDatetimeLocalValue(from));
    expect(screen.getByLabelText('analysis.range.to')).toHaveValue(toDatetimeLocalValue(to));
    expect(screen.getByRole('button', { name: 'analysis.range.apply' })).toBeEnabled();
  });

  it('blocks a reversed custom range', () => {
    const onRangeChange = vi.fn();
    renderControls({ onRangeChange });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.custom' }));
    fireEvent.change(screen.getByLabelText('analysis.range.from'), { target: { value: '2026-06-03T00:00' } });
    fireEvent.change(screen.getByLabelText('analysis.range.to'), { target: { value: '2026-06-02T00:00' } });
    expect(screen.getByText('analysis.range.invalid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'analysis.range.apply' })).toBeDisabled();
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('blocks an equal start and end custom range', () => {
    const onRangeChange = vi.fn();
    renderControls({ onRangeChange });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.custom' }));
    fireEvent.change(screen.getByLabelText('analysis.range.from'), { target: { value: '2026-06-02T00:00' } });
    fireEvent.change(screen.getByLabelText('analysis.range.to'), { target: { value: '2026-06-02T00:00' } });
    expect(screen.getByText('analysis.range.invalid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'analysis.range.apply' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.apply' }));
    expect(onRangeChange).not.toHaveBeenCalled();
  });
});
