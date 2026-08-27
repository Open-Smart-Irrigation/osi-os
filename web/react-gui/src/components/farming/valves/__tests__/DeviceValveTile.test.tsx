import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';

import { DeviceValveTile } from '../DeviceValveTile';
import { devicesAPI, valvesAPI } from '../../../../services/api';
import type { ValveTile as ValveTileType } from '../ValveTile';
import type { ValveOpenDialog as ValveOpenDialogType } from '../ValveOpenDialog';
import type { Device, ValveSummary } from '../../../../types/farming';

// I-2 (Bovey final fix wave review): mirrors the OSI Server cloud's own
// `DeviceValveTile.test.tsx` shape -- loading/error placeholder, "renders the SAME ValveTile",
// the removeDevice-vs-devicesAPI.remove delete split with its per-placement copy, and the open
// submission shape -- adapted to the edge's actual architecture: `valve` arrives as a prop
// (already fetched by the caller, see DeviceValveTile.tsx's own doc comment) rather than from
// an internal `useSWR`, and there is no `useValveCommand` poll-to-ACK lifecycle here (the edge's
// `runAction` is a plain try/await/catch, matching ValveControlPanel's own pattern).
const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    loading: 'Loading...',
    actionFailed: 'The action could not be completed.',
    loadFailed: 'Could not load valves.',
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
  devicesAPI: {
    controlValve: vi.fn(),
    cancelIrrigation: vi.fn(),
    remove: vi.fn(),
  },
  valvesAPI: {
    updateSettings: vi.fn(),
    setSchedulerStatus: vi.fn(),
    resendPlan: vi.fn(),
  },
}));

// ValveTile and the four dialogs are real, non-trivial UI covered by their own test suites
// (ValveTile.test.tsx, ValveOpenDialog.test.tsx, ...) -- stubbed here so this suite only
// exercises DeviceValveTile's own wiring: which removal function it calls, which delete copy
// it hands ValveTile, and the shape of the open command it dispatches. Same isolation strategy
// as ValveControlPanel.test.tsx.
vi.mock('../ValveTile', () => ({
  ValveTile: (props: ComponentProps<typeof ValveTileType>) => (
    <div>
      <h3>{props.valve.name}</h3>
      <span>{props.busy ? 'busy' : 'idle'}</span>
      <span data-testid="battery-percent">{String(props.batteryPercent ?? 'none')}</span>
      <span data-testid="delete-menu-label">{props.deleteMenuLabel ?? 'DEFAULT'}</span>
      <button onClick={props.onOpen}>Open</button>
      <button onClick={props.onDelete}>Delete</button>
      <button onClick={props.onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('../ValveOpenDialog', () => ({
  ValveOpenDialog: (props: ComponentProps<typeof ValveOpenDialogType>) =>
    props.open ? <button onClick={() => props.onSubmit(10)}>SubmitOpen</button> : null,
}));

vi.mock('../ValveScheduleDialog', () => ({ ValveScheduleDialog: () => null }));
vi.mock('../ValveSettingsDialog', () => ({ ValveSettingsDialog: () => null }));
vi.mock('../ValveServiceDialog', () => ({ ValveServiceDialog: () => null }));

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C001F1000001',
    name: 'North Valve',
    type_id: 'STREGA_VALVE',
    latest_data: {},
    ...overrides,
  } as Device;
}

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

describe('DeviceValveTile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a loading placeholder while the valve prop has not resolved yet', () => {
    render(<DeviceValveTile device={makeDevice()} valve={undefined} onUpdate={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('renders the load-failed placeholder instead of "loading" once the shared valves fetch has errored', () => {
    render(<DeviceValveTile device={makeDevice()} valve={undefined} error={new Error('network down')} onUpdate={vi.fn()} />);
    expect(screen.getByText('Could not load valves.')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('renders the SAME ValveTile once the matching valve resolves', () => {
    render(<DeviceValveTile device={makeDevice()} valve={makeValve()} onUpdate={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'North Valve' })).toBeInTheDocument();
  });

  it('delete: with removeDevice provided, uses it (zone detach) instead of devicesAPI.remove, and passes the removeFromZone* copy', async () => {
    const removeDevice = vi.fn().mockResolvedValue(undefined);
    const onRemove = vi.fn();
    const onUpdate = vi.fn();
    render(
      <DeviceValveTile
        device={makeDevice()}
        valve={makeValve()}
        onUpdate={onUpdate}
        onRemove={onRemove}
        removeDevice={removeDevice}
      />,
    );

    // Per-placement copy: ValveTile only gets the "Remove from zone" override when a
    // removeDevice is actually injected -- proves the wiring, not just the outcome.
    expect(screen.getByTestId('delete-menu-label').textContent).toBe('removeFromZoneMenuItem');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(removeDevice).toHaveBeenCalledWith('0016C001F1000001'));
    expect(devicesAPI.remove).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('delete: without removeDevice, falls back to devicesAPI.remove (farm-level unclaim) and keeps the default delete copy', async () => {
    vi.mocked(devicesAPI.remove).mockResolvedValue(undefined);
    const onRemove = vi.fn();
    render(<DeviceValveTile device={makeDevice()} valve={makeValve()} onUpdate={vi.fn()} onRemove={onRemove} />);

    expect(screen.getByTestId('delete-menu-label').textContent).toBe('DEFAULT');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(devicesAPI.remove).toHaveBeenCalledWith('0016C001F1000001'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('open: submits OPEN_FOR_DURATION with duration_seconds = minutes * 60', async () => {
    vi.mocked(devicesAPI.controlValve).mockResolvedValue(undefined);
    vi.mocked(valvesAPI.updateSettings).mockResolvedValue(undefined as any);
    const onUpdate = vi.fn();
    render(<DeviceValveTile device={makeDevice()} valve={makeValve()} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'SubmitOpen' }));

    await waitFor(() => expect(devicesAPI.controlValve).toHaveBeenCalledWith(
      '0016C001F1000001',
      { action: 'OPEN_FOR_DURATION', duration_seconds: 600 },
    ));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('a failed cancel/action sets the visible actionFailed error, not a silent failure', async () => {
    vi.mocked(devicesAPI.cancelIrrigation).mockRejectedValueOnce(new Error('boom'));
    render(<DeviceValveTile device={makeDevice()} valve={makeValve()} onUpdate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('The action could not be completed.')).toBeInTheDocument();
  });

  it("passes the device's own latest_data.bat_pct through to the tile as batteryPercent", () => {
    render(
      <DeviceValveTile
        device={makeDevice({ latest_data: { bat_pct: 42 } })}
        valve={makeValve()}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByTestId('battery-percent').textContent).toBe('42');
  });
});
