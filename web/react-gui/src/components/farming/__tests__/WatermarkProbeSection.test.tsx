import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const base = { soilTempC: 19.9 };
afterEach(() => window.localStorage.clear());

describe('WatermarkProbeSection', () => {
  it('shows kPa with the shared soil status colour', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 1 as const, depthCm: 20, reading: ch({ kpa: 56.4, r_solved: 9977, offset_mv: 0.6 }) },
    ]} />);
    expect(screen.getByText('56.4 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('shows the canonical clipped estimate as ordinary SWT', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 1 as const, depthCm: null, reading: ch({ status: 'wet_offset_clipped', kpa: 11.2, kpa_upper_bound: 11.2, r_upper_bound: 1325, offset_mv: 114.9 }) },
    ]} />);
    expect(screen.queryByText(/watermark\.wetUpTo/)).not.toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
  });

  it('uses the same dry colour for a high canonical clipped estimate', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 1 as const, depthCm: null, reading: ch({ status: 'wet_offset_clipped', kpa: 93.2, kpa_upper_bound: 93.2, r_upper_bound: 8502 }) },
    ]} />);
    expect(screen.queryByText(/watermark\.wetUpTo/)).not.toBeInTheDocument();
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
    expect(screen.getByText('93.2 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('shows the unbounded status text (not the "at most" promise) when a clipped reading has no upper bound', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 1 as const, depthCm: null, reading: ch({ status: 'wet_offset_clipped', kpa_upper_bound: null, r_upper_bound: 210000 }) },
    ]} />);
    expect(screen.getByText('watermark.status.wet_offset_clipped_unbounded')).toBeInTheDocument();
    expect(screen.queryByText('watermark.status.wet_offset_clipped')).not.toBeInTheDocument();
    expect(screen.queryByText(/watermark\.resistanceUpTo/)).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
  });

  it('shows the status colour for a valid kPa reading regardless of its age', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 1 as const, depthCm: null, reading: ch({ kpa: 56.4 }) },
    ]} />);
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('shows no colour for a probe without kPa', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 2 as const, depthCm: null, reading: ch({ status: 'calibration_required', r_solved: null }) },
    ]} />);
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
    expect(screen.getByText(/watermark\.status\.calibration_required/)).toBeInTheDocument();
  });

  it('shows an unsettled numerical value without ordinary-card diagnostics', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { channel: 1 as const, depthCm: 20, reading: ch({ status: 'unsettled', kpa: 26.8, r_solved: 4953, offset_mv: 70 }) },
    ]} />);
    expect(screen.getByText('26.8 kPa')).toBeInTheDocument();
    expect(screen.queryByText(/watermark\.status\.unsettled/)).not.toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
  });

  it('keeps electrical diagnostics off the ordinary card', () => {
    render(<WatermarkProbeSection {...base} probes={[]} />);
    expect(screen.queryByText(/watermark\.supply|watermark\.dieTemp/)).not.toBeInTheDocument();
  });
});

describe('WatermarkProbeSection history', () => {
  const probes = [
    { channel: 1 as const, depthCm: 20, reading: ch({ kpa: 56.4 }) },
    { channel: 2 as const, depthCm: 40, reading: ch({ status: 'unsettled', kpa: 26.8 }) },
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
    fireEvent.click(screen.getByRole('button', { name: /soilTension\.soilTemp/ }));
    expect(onOpenHistory).toHaveBeenCalledWith('ext_temperature_c');
  });

  it('omits soil temperature when the canonical reading is absent', () => {
    render(<WatermarkProbeSection {...base} soilTempC={null} probes={probes} onOpenHistory={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /soilTension\.soilTemp/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/watermark\.soilTempNotMeasured/)).not.toBeInTheDocument();
  });

  it('shows no history cue without a handler', () => {
    render(<WatermarkProbeSection {...base} probes={probes} />);
    expect(screen.queryAllByTitle(/common\.viewHistory/)).toHaveLength(0);
  });
});

describe('ordinary WATERMARK presentation', () => {
  it('does not reconstruct missing canonical kPa from diagnostic bounds', () => {
    render(<WatermarkProbeSection {...base} probes={[{ channel: 1 as const, depthCm: null, reading: ch({ status: 'wet_offset_clipped', kpa_upper_bound: 11.2 }) }]} />);
    expect(screen.queryByText(/11.2/)).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
  it('uses the common pF conversion for a clipped canonical value', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<WatermarkProbeSection {...base} probes={[{ channel: 1 as const, depthCm: null, reading: ch({ status: 'wet_offset_clipped', kpa: 30, kpa_upper_bound: 30, offset_mv: 100 }) }]} />);
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.queryByText(/watermark\.offset|watermark\.status\.wet_offset_clipped/)).not.toBeInTheDocument();
  });
});
