import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScheduleSection } from '../ScheduleSection';
import { irrigationZonesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: {
    getAll: vi.fn(),
    updateSchedule: vi.fn().mockResolvedValue({}),
  },
}));

const zone = (schedule: any = null) => [{ id: 7, name: 'Test', device_count: 0, created_at: '', updated_at: '', schedule }];

describe('ScheduleSection persistence', () => {
  it('round trips unchanged 29.9 and retains independent SWT and dendro durations', async () => {
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValueOnce(zone({ trigger_metric: 'SWT_1', threshold_kpa: 29.9, duration_minutes: 20 }));
    render(<ScheduleSection zoneId={7} zoneName="Test" />);
    fireEvent.click((await screen.findAllByRole('button'))[0]);
    const threshold = (await screen.findAllByRole('spinbutton')).find(input => (input as HTMLInputElement).value === '29.9') as HTMLInputElement;
    expect(threshold.value).toBe('29.9');
    expect(screen.getByLabelText(/duration \(min\)/i)).toHaveValue(20);
    fireEvent.click(screen.getByRole('button', { name: /schedule\.saveSchedule/i }));
    await waitFor(() => expect(irrigationZonesAPI.updateSchedule).toHaveBeenCalledWith(7, expect.objectContaining({ threshold_kpa: 29.9, duration_minutes: 20 })));
    vi.mocked(irrigationZonesAPI.updateSchedule).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Dendrometer$/i }));
    const dendroDuration = screen.getByLabelText(/base duration \(min\)/i) as HTMLInputElement;
    fireEvent.change(dendroDuration, { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: /^Soil moisture SWT$/i }));
    expect(screen.getByLabelText(/duration \(min\)/i)).toHaveValue(20);
    fireEvent.click(screen.getByRole('button', { name: /^Dendrometer$/i }));
    expect(screen.getByLabelText(/base duration \(min\)/i)).toHaveValue(33);
    fireEvent.click(screen.getByRole('button', { name: /^Soil moisture SWT$/i }));
    fireEvent.click(screen.getByRole('button', { name: /schedule\.saveSchedule/i }));
    await waitFor(() => expect(irrigationZonesAPI.updateSchedule).toHaveBeenCalledWith(7, expect.objectContaining({ threshold_kpa: 29.9, duration_minutes: 20 })));
  });

  it.each([20, 30, 50])('saves preset-valued Custom SWT threshold %s without changing selection', async candidate => {
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValueOnce(zone({ trigger_metric: 'SWT_1', threshold_kpa: 29.9, duration_minutes: 20 }));
    render(<ScheduleSection zoneId={7} zoneName="Test" />);
    fireEvent.click((await screen.findAllByRole('button'))[0]);
    fireEvent.click(screen.getByRole('radio', { name: /custom/i }));
    const input = (await screen.findAllByRole('spinbutton')).find(control => (control as HTMLInputElement).value === '29.9') as HTMLInputElement;
    fireEvent.change(input, { target: { value: String(candidate) } });
    expect(screen.getByRole('radio', { name: /custom/i })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /schedule\.saveSchedule/i }));
    await waitFor(() => expect(irrigationZonesAPI.updateSchedule).toHaveBeenCalledWith(7, expect.objectContaining({ threshold_kpa: candidate })));
  });

  it('does not invent dendro defaults when no schedule exists', async () => {
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValueOnce(zone());
    render(<ScheduleSection zoneId={7} zoneName="Test" />);
    fireEvent.click((await screen.findAllByRole('button'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /schedule\.saveSchedule/i }));
    await waitFor(() => expect(irrigationZonesAPI.updateSchedule).toHaveBeenCalledWith(7, expect.objectContaining({ trigger_metric: 'SWT_1', threshold_kpa: 30 })));
    expect(irrigationZonesAPI.updateSchedule).not.toHaveBeenCalledWith(7, expect.objectContaining({ trigger_metric: 'DENDRO', threshold_kpa: 2 }));
  });

  it('opens the conditional policy editor even when no legacy schedule exists', async () => {
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValueOnce(zone());
    const onOpenPolicyEditor = vi.fn();
    render(<ScheduleSection zoneId={7} zoneName="Test" onOpenPolicyEditor={onOpenPolicyEditor} />);
    fireEvent.click((await screen.findAllByRole('button'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /configure conditional irrigation/i }));
    expect(onOpenPolicyEditor).toHaveBeenCalledTimes(1);
  });

  it('blocks an invalid active SWT draft but saves a valid DENDRO draft', async () => {
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValueOnce(zone({ trigger_metric: 'SWT_1', threshold_kpa: 30, duration_minutes: 20 }));
    render(<ScheduleSection zoneId={7} zoneName="Test" />);
    fireEvent.click((await screen.findAllByRole('button'))[0]);
    const threshold = (await screen.findAllByRole('spinbutton')).find(input => (input as HTMLInputElement).value === '30') as HTMLInputElement;
    fireEvent.change(threshold, { target: { value: '-1' } });
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /dendrometer/i }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /schedule\.saveSchedule/i }));
    await waitFor(() => expect(irrigationZonesAPI.updateSchedule).toHaveBeenCalledWith(7, expect.objectContaining({ trigger_metric: 'DENDRO', threshold_kpa: 2, duration_minutes: 20 })));
  });

  it('ignores the initial open request and opens only on a later request', async () => {
    vi.mocked(irrigationZonesAPI.getAll).mockResolvedValue(zone({ trigger_metric: 'SWT_1', threshold_kpa: 30, duration_minutes: 20 }));
    const { rerender } = render(<ScheduleSection zoneId={7} zoneName="Test" openRequest={0} />);
    await waitFor(() => expect(irrigationZonesAPI.getAll).toHaveBeenCalled());
    expect(screen.queryByDisplayValue('30')).not.toBeInTheDocument();
    rerender(<ScheduleSection zoneId={7} zoneName="Test" openRequest={1} />);
    expect(await screen.findByDisplayValue('30')).toBeInTheDocument();
  });
});
