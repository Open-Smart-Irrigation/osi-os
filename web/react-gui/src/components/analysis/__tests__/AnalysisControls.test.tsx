// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState, type ComponentProps } from 'react';
import type { AnalysisRange } from '../../../analysis/types';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

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
  it.each(['7d', 'custom'])('cancels Custom with Escape from its keyboard-focused trigger, keeping %s committed', async (rangeLabel) => {
    const user = userEvent.setup();
    const props = renderControls({
      rangeLabel,
      range: rangeLabel === 'custom'
        ? { mode: 'custom', label: 'custom', from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' }
        : { mode: 'relative', label: '7d', from: null, to: null },
    });
    const custom = screen.getByRole('button', { name: 'analysis.range.custom' });
    custom.focus();
    await user.keyboard('{Enter}');
    expect(custom).toHaveFocus();
    expect(custom).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');

    expect(custom).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('analysis.range.from')).not.toBeInTheDocument();
    expect(custom).toHaveFocus();
    expect(props.onRangeChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: rangeLabel === 'custom' ? 'analysis.range.custom' : '7d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: 'analysis.range.label' }).querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });

  it('keeps only the committed range pressed while editing and cancelling Custom', () => {
    const props = renderControls();
    const custom = screen.getByRole('button', { name: 'analysis.range.custom' });
    fireEvent.click(custom);
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    expect(custom).toHaveAttribute('aria-pressed', 'false');
    expect(custom).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByLabelText('analysis.range.from'), { target: { value: '2026-06-01T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByLabelText('analysis.range.from')).not.toBeInTheDocument();
    expect(custom).toHaveAttribute('aria-expanded', 'false');
    expect(props.onRangeChange).not.toHaveBeenCalled();
    expect(custom).toHaveFocus();
  });

  it('restores the committed bounds when cancelling Custom with Escape', () => {
    renderControls({ rangeLabel: 'custom', range: { mode: 'custom', label: 'custom', from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' } });
    fireEvent.change(screen.getByLabelText('analysis.range.from'), { target: { value: '2026-06-03T00:00' } });
    fireEvent.keyDown(screen.getByLabelText('analysis.range.from'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.custom' }));
    expect(screen.getByLabelText('analysis.range.from')).toHaveValue(toDatetimeLocalValue('2026-06-01T00:00:00Z'));
    expect(screen.getByRole('group', { name: 'analysis.range.label' }).querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });

  it('has exactly one pressed range after applying Custom and choosing another preset', () => {
    function Fixture() {
      const [range, setRange] = useState<AnalysisRange>({ mode: 'relative', label: '7d', from: null, to: null });
      return <AnalysisControls {...base} rangeLabel={range.label} range={range}
        onRangeChange={(next) => setRange(typeof next === 'string' ? { mode: 'relative', label: next, from: null, to: null } : next)}
        onModeChange={vi.fn()} onLayoutChange={vi.fn()} onToggle={vi.fn()} />;
    }
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.custom' }));
    fireEvent.change(screen.getByLabelText('analysis.range.from'), { target: { value: '2026-06-01T00:00' } });
    fireEvent.change(screen.getByLabelText('analysis.range.to'), { target: { value: '2026-06-02T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.range.apply' }));
    const group = screen.getByRole('group', { name: 'analysis.range.label' });
    expect(group.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'analysis.range.custom' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(group.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('analysis.range.from')).not.toBeInTheDocument();
  });

  it('allows all translated control groups to wrap without clipping', () => {
    renderControls();
    for (const group of screen.getAllByRole('group')) {
      expect(group).toHaveClass('max-w-full', 'flex-wrap');
      expect(group).not.toHaveClass('overflow-hidden');
    }
  });

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
