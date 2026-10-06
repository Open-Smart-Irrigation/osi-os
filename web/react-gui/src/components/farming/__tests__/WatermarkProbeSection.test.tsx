import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WatermarkProbeSection } from '../shared/WatermarkProbeSection';
import type { WatermarkChannelLatest } from '../../../types/farming';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const labels: Record<string, string> = { 'history.soil.state.wet': 'Wet', 'history.soil.state.moist': 'Moist', 'history.soil.state.dry': 'Dry' };
      if (labels[key]) return labels[key];
      return opts ? `${key}:${JSON.stringify(opts)}` : key;
    },
  }),
}));

const ch = (over: Partial<WatermarkChannelLatest>): WatermarkChannelLatest => ({
  status: 'ok', kpa: null, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null, ...over,
});
const base = { isCurrent: true, swtUnit: 'kPa' as const, soilTempC: 19.9, soilTempMeasured: true, dieTempC: 21.5, supplyMv: 3300 };

describe('WatermarkProbeSection', () => {
  it('shows kPa with the shared soil status colour', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: '20 cm', channel: ch({ kpa: 56.4, r_solved: 9977, offset_mv: 0.6 }) },
    ]} />);
    expect(screen.getByText('56.4 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('colours a clipped probe wet only when its tension bound is itself wet', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ status: 'wet_offset_clipped', kpa_upper_bound: 11.2, r_upper_bound: 1325, offset_mv: 114.9 }) },
    ]} />);
    expect(screen.getByText(/watermark\.wetUpTo/)).toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
  });

  it('shows a clipped probe with a high bound as a bound, without colour', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ status: 'wet_offset_clipped', kpa_upper_bound: 93.2, r_upper_bound: 8502 }) },
    ]} />);
    expect(screen.getByText(/watermark\.wetUpTo/)).toBeInTheDocument();
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
  });

  it('shows the unbounded status text (not the "at most" promise) when a clipped reading has no upper bound', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ status: 'wet_offset_clipped', kpa_upper_bound: null, r_upper_bound: 210000 }) },
    ]} />);
    expect(screen.getByText('watermark.status.wet_offset_clipped_unbounded')).toBeInTheDocument();
    expect(screen.queryByText('watermark.status.wet_offset_clipped')).not.toBeInTheDocument();
    expect(screen.getByText(/watermark\.resistanceUpTo/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
  });

  it('shows no colour for a stale reading or a probe without kPa', () => {
    render(<WatermarkProbeSection {...base} isCurrent={false} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ kpa: 56.4 }) },
      { key: 'swt_2', label: 'Probe 2', depthLabel: null, channel: ch({ status: 'calibration_required', r_solved: null }) },
    ]} />);
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
    expect(screen.getByText(/watermark\.status\.calibration_required/)).toBeInTheDocument();
  });

  it('shows the value of an unsettled reading and keeps its status visible (#415)', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: '20 cm', channel: ch({ status: 'unsettled', kpa: 26.8, r_solved: 4953, offset_mv: 70 }) },
    ]} />);
    expect(screen.getByText('26.8 kPa')).toBeInTheDocument();
    expect(screen.getByText(/watermark\.status\.unsettled/)).toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
  });

  it('says supply, never battery', () => {
    render(<WatermarkProbeSection {...base} probes={[]} />);
    expect(screen.getByText(/watermark\.supply/)).toBeInTheDocument();
  });
});

describe('WatermarkProbeSection history', () => {
  const probes = [
    { key: 'swt_1', label: 'Probe 1', depthLabel: '20 cm', channel: ch({ kpa: 56.4 }) },
    { key: 'swt_2', label: 'Probe 2', depthLabel: '40 cm', channel: ch({ status: 'unsettled', kpa: 26.8 }) },
  ];

  it('marks each probe value as a history control, like the other device cards', () => {
    render(<WatermarkProbeSection {...base} probes={probes} onOpenHistory={vi.fn()} />);
    const controls = screen.getAllByTitle(/common\.viewHistory/);
    // Two probes and the measured soil temperature.
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.tagName).toBe('BUTTON');
      expect(control).toHaveAttribute('type', 'button');
      expect(control).not.toBeDisabled();
      expect(control.className).toContain('focus-visible:ring-2');
    }
    expect(screen.getByText('56.4 kPa').className).toContain('decoration-dotted');
  });

  it('opens the probe series, also for an unsettled reading', () => {
    const onOpenHistory = vi.fn();
    render(<WatermarkProbeSection {...base} probes={probes} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByText('56.4 kPa'));
    fireEvent.click(screen.getByText('26.8 kPa'));
    expect(onOpenHistory.mock.calls).toEqual([['swt_1'], ['swt_2']]);
  });

  it('opens the measured soil temperature series', () => {
    const onOpenHistory = vi.fn();
    render(<WatermarkProbeSection {...base} probes={probes} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByRole('button', { name: /watermark\.soilTemp/ }));
    expect(onOpenHistory).toHaveBeenCalledWith('ext_temperature_c');
  });

  it('offers no soil temperature history when the soil temperature is not measured', () => {
    render(<WatermarkProbeSection {...base} soilTempMeasured={false} probes={probes} onOpenHistory={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /watermark\.soilTemp/ })).not.toBeInTheDocument();
    expect(screen.getByText(/watermark\.soilTempNotMeasured/)).toBeInTheDocument();
  });

  it('shows no history cue without a handler', () => {
    render(<WatermarkProbeSection {...base} probes={probes} />);
    expect(screen.queryAllByTitle(/common\.viewHistory/)).toHaveLength(0);
  });
});
