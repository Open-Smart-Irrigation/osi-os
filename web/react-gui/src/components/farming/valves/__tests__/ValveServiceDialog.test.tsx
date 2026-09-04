import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { ComponentProps } from 'react';

import { ValveServiceDialog } from '../ValveServiceDialog';
import { devicesAPI, stregaAPI } from '../../../../services/api';
import type { Device, ValveSummary } from '../../../../types/farming';

// Each render gets a fresh SWR cache: the dialog fetches '/api/devices' under the same
// key FarmingDashboard uses (for dedup at runtime), but that means separate tests in this
// suite would otherwise share one process-wide cache and see stale devicesAPI.getAll()
// results across `it()` blocks.
function renderDialog(props: ComponentProps<typeof ValveServiceDialog>) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ValveServiceDialog {...props} />
    </SWRConfig>,
  );
}

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    close: 'Close',
    cancel: 'Cancel',
    'serviceDialog.title': 'Service commands',
    'serviceDialog.subtitle': 'Commissioning and maintenance actions for {{name}}.',
    'serviceDialog.configSection': 'Configuration',
    'serviceDialog.actionsSection': 'Actions that move water',
    'serviceDialog.interval.label': 'Uplink interval',
    'serviceDialog.interval.closedLabel': 'Closed-box interval (min)',
    'serviceDialog.interval.openedLabel': 'Opened-box interval (min)',
    'serviceDialog.interval.tamperLabel': 'Disable tamper alarm',
    'serviceDialog.interval.apply': 'Apply interval',
    'serviceDialog.interval.invalid': 'Enter a value between 1 and 255 minutes.',
    'serviceDialog.interval.pending': 'Interval change requested.',
    'serviceDialog.interval.failed': 'Could not change the uplink interval.',
    'serviceDialog.model.label': 'Valve model',
    'serviceDialog.model.standard': 'Standard / solenoid',
    'serviceDialog.model.motorized': 'Motorized',
    'serviceDialog.model.apply': 'Apply model',
    'serviceDialog.model.pending': 'Valve model update requested.',
    'serviceDialog.model.failed': 'Could not update the valve model.',
    'serviceDialog.timed.label': 'Timed action',
    'serviceDialog.timed.actionOpen': 'Open',
    'serviceDialog.timed.actionClose': 'Close',
    'serviceDialog.timed.unitSeconds': 'Seconds',
    'serviceDialog.timed.unitMinutes': 'Minutes',
    'serviceDialog.timed.unitHours': 'Hours',
    'serviceDialog.timed.amountLabel': 'Amount',
    'serviceDialog.timed.invalid': 'Enter a value between 1 and 255.',
    'serviceDialog.timed.send': 'Send timed action',
    'serviceDialog.timed.confirmTitle': 'Send this timed action?',
    'serviceDialog.timed.confirmBody': 'This can move water immediately.',
    'serviceDialog.timed.confirmButton': 'Yes, send it',
    'serviceDialog.timed.pending': 'Timed action requested.',
    'serviceDialog.timed.failed': 'Could not queue the timed action.',
    'serviceDialog.magnet.label': 'Magnet mode',
    'serviceDialog.magnet.enableLabel': 'Enable magnet control',
    'serviceDialog.magnet.apply': 'Apply magnet mode',
    'serviceDialog.magnet.pending': 'Magnet mode change requested.',
    'serviceDialog.magnet.failed': 'Could not change magnet mode.',
    'serviceDialog.partial.label': 'Partial opening',
    'serviceDialog.partial.actionOpen': 'Open',
    'serviceDialog.partial.actionClose': 'Close',
    'serviceDialog.partial.percentageLabel': 'Percentage',
    'serviceDialog.partial.invalid': 'Enter a percentage between 1 and 100.',
    'serviceDialog.partial.send': 'Send partial opening',
    'serviceDialog.partial.confirmTitle': 'Send this partial opening?',
    'serviceDialog.partial.confirmBody': 'This can move water immediately.',
    'serviceDialog.partial.confirmButton': 'Yes, send it',
    'serviceDialog.partial.pendingOpen': 'Open once to {{percentage}}% sent.',
    'serviceDialog.partial.pendingClose': 'Close once to {{percentage}}% sent.',
    'serviceDialog.partial.failed': 'Could not queue the partial opening.',
    'serviceDialog.flush.label': 'Anti-sediment flushing',
    'serviceDialog.flush.returnLabel': 'Return to',
    'serviceDialog.flush.returnOpen': 'Open',
    'serviceDialog.flush.returnClose': 'Closed',
    'serviceDialog.flush.percentageLabel': 'Percentage',
    'serviceDialog.flush.invalid': 'Enter a percentage between 1 and 100.',
    'serviceDialog.flush.send': 'Send flushing',
    'serviceDialog.flush.confirmTitle': 'Send this flush?',
    'serviceDialog.flush.confirmBody': 'This can move water immediately.',
    'serviceDialog.flush.confirmButton': 'Yes, send it',
    'serviceDialog.flush.pending': 'Flush once at {{percentage}}%, then return to {{state}}, sent.',
    'serviceDialog.flush.failed': 'Could not queue the flushing.',
    'stregaValve.motorizedLocked': 'Set the valve model to motorized to unlock partial opening and flushing commands.',
    'stregaValve.motorizedNote': 'Partial opening and anti-sediment flushing are only supported for motorized valves.',
  };
  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = table[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest, i18n: { language: 'en' } }),
}));

vi.mock('../../../../services/api', () => ({
  stregaAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setTimedAction: vi.fn().mockResolvedValue(undefined),
    setMagnetEnabled: vi.fn().mockResolvedValue(undefined),
    setPartialOpening: vi.fn().mockResolvedValue(undefined),
    setFlushing: vi.fn().mockResolvedValue(undefined),
  },
  devicesAPI: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

function makeValve(overrides: Partial<ValveSummary> = {}): ValveSummary {
  return {
    deviceEui: '0016C001F1000001',
    name: 'North Valve',
    zoneId: 1,
    zoneName: 'North Block',
    zoneUuid: 'uuid-1',
    timezone: 'Europe/Zurich',
    currentState: 'CLOSED',
    targetState: null,
    stregaGeneration: 'GEN1',
    flowRateLpm: null,
    flowRateSource: null,
    defaultOpenMinutes: null,
    schedulerStatus: 'ACTIVE',
    skipTodayDate: null,
    lastUplinkAt: null,
    activeActuation: null,
    recentStaleState: null,
    nextRun: null,
    scheduleCount: 0,
    pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    lastClockSyncAckedAt: null,
    enclosureTemperatureC: null,
    enclosureHumidityPct: null,
    enclosureMeasuredAt: null,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C001F1000001',
    name: 'North Valve',
    type_id: 'STREGA_VALVE' as Device['type_id'],
    latest_data: {},
    strega_model: 'STANDARD',
    ...overrides,
  } as Device;
}

describe('ValveServiceDialog', () => {
  it('renders the four always-available controls', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    expect(await screen.findByText('Uplink interval')).toBeInTheDocument();
    expect(screen.getByText('Valve model')).toBeInTheDocument();
    expect(screen.getByText('Timed action')).toBeInTheDocument();
    expect(screen.getByText('Magnet mode')).toBeInTheDocument();
  });

  it('disables partial opening and flushing with the motorizedLocked copy when the model is not motorized', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice({ strega_model: 'STANDARD' })]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    expect(await screen.findAllByText('Set the valve model to motorized to unlock partial opening and flushing commands.')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send partial opening' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send flushing' })).toBeDisabled();
  });

  it('enables partial opening and flushing when the model is motorized', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice({ strega_model: 'MOTORIZED' })]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send partial opening' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Send flushing' })).not.toBeDisabled();
  });

  it('calls setUplinkInterval exactly once with the typed payload (no confirmation needed)', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    fireEvent.change(await screen.findByLabelText('Closed-box interval (min)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Opened-box interval (min)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply interval' }));

    await waitFor(() => expect(stregaAPI.setUplinkInterval).toHaveBeenCalledTimes(1));
    expect(stregaAPI.setUplinkInterval).toHaveBeenCalledWith('0016C001F1000001', {
      closedMinutes: 15,
      openedMinutes: 2,
      tamperDisabled: false,
    });
  });

  it('calls setModel exactly once with the typed payload (no confirmation needed)', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    fireEvent.change(await screen.findByLabelText('Valve model'), { target: { value: 'MOTORIZED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply model' }));

    await waitFor(() => expect(stregaAPI.setModel).toHaveBeenCalledTimes(1));
    expect(stregaAPI.setModel).toHaveBeenCalledWith('0016C001F1000001', 'MOTORIZED');
  });

  it('calls setMagnetEnabled exactly once with the typed payload (no confirmation needed)', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    fireEvent.click(await screen.findByLabelText('Enable magnet control'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply magnet mode' }));

    await waitFor(() => expect(stregaAPI.setMagnetEnabled).toHaveBeenCalledTimes(1));
    expect(stregaAPI.setMagnetEnabled).toHaveBeenCalledWith('0016C001F1000001', true);
  });

  it('requires confirmation before sending a timed action -- one tap must not move water', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send timed action' }));

    // First tap only arms the confirmation -- the API must not have been called yet.
    expect(stregaAPI.setTimedAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes, send it' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, send it' }));
    await waitFor(() => expect(stregaAPI.setTimedAction).toHaveBeenCalledTimes(1));
    expect(stregaAPI.setTimedAction).toHaveBeenCalledWith('0016C001F1000001', {
      action: 'OPEN',
      unit: 'minutes',
      amount: 10,
    });
  });

  it('requires confirmation before sending partial opening, and uses one-shot copy, not a lasting-position claim', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice({ strega_model: 'MOTORIZED' })]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send partial opening' })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Percentage', { selector: '#service-partial-percentage-0016C001F1000001' }), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send partial opening' }));

    expect(stregaAPI.setPartialOpening).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send it' }));

    await waitFor(() => expect(stregaAPI.setPartialOpening).toHaveBeenCalledTimes(1));
    expect(stregaAPI.setPartialOpening).toHaveBeenCalledWith('0016C001F1000001', {
      action: 'OPEN',
      percentage: 40,
    });
    expect(await screen.findByText('Open once to 40% sent.')).toBeInTheDocument();
    // Must never claim a lasting position -- the valve does not hold 40% open.
    expect(screen.queryByText(/Set opening to 40%/)).not.toBeInTheDocument();
  });

  it('requires confirmation before sending flushing', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice({ strega_model: 'MOTORIZED' })]);
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send flushing' })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Percentage', { selector: '#service-flush-percentage-0016C001F1000001' }), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send flushing' }));

    expect(stregaAPI.setFlushing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send it' }));

    await waitFor(() => expect(stregaAPI.setFlushing).toHaveBeenCalledTimes(1));
    expect(stregaAPI.setFlushing).toHaveBeenCalledWith('0016C001F1000001', {
      returnPosition: 'OPEN',
      percentage: 40,
    });
  });

  it('surfaces an error on failure and does not claim success', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    vi.mocked(stregaAPI.setUplinkInterval).mockRejectedValueOnce(new Error('offline'));
    renderDialog({ valve: makeValve(), open: true, onClose: vi.fn(), onChanged: vi.fn() });

    fireEvent.change(await screen.findByLabelText('Closed-box interval (min)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Opened-box interval (min)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply interval' }));

    expect(await screen.findByText('Could not change the uplink interval.')).toBeInTheDocument();
    expect(screen.queryByText('Interval change requested.')).not.toBeInTheDocument();
  });

  it('dismisses via an X in the header with no Cancel button', async () => {
    const onClose = vi.fn();
    vi.mocked(devicesAPI.getAll).mockResolvedValue([makeDevice()]);
    renderDialog({ valve: makeValve(), open: true, onClose: onClose, onChanged: vi.fn() });

    await screen.findByText('Uplink interval');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
