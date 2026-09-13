import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enDevices from '../../../../public/locales/en/devices.json';
import type { Device } from '../../../types/farming';
import { devicesAPI } from '../../../services/api';
import { DraginoTempCard } from '../DraginoTempCard';
import { KiwiSensorCard } from '../KiwiSensorCard';
import { LoRainGaugeCard } from '../LoRainGaugeCard';
import { Sdi12SoilCard } from '../Sdi12SoilCard';
import { SenseCapWeatherCard } from '../SenseCapWeatherCard';
import type { DeviceRemoveContext } from '../useDeviceRemoval';

// The operator-visible English copy, pinned here so these tests assert sentences rather
// than key names -- the original defect was copy and behaviour disagreeing: the zone ✕
// deleted the device from the account while the dialog promised it only left the zone.
// `matches public/locales/en/devices.json` below keeps this table honest.
const { EN } = vi.hoisted(() => ({
  EN: {
    'deviceRemoval.titleZone': 'Remove from this zone?',
    'deviceRemoval.titleFarm': 'Remove this device?',
    'deviceRemoval.subtitleZone': 'The device stays registered and keeps its readings — it only leaves this zone.',
    'deviceRemoval.subtitleFarm': 'This will unlink the device from your account. Its readings stay on the gateway.',
    'deviceRemoval.confirmZone': 'Yes, unassign',
    'deviceRemoval.confirmFarm': 'Yes, remove',
    'deviceRemoval.removingZone': 'Unassigning...',
    'deviceRemoval.removingFarm': 'Removing...',
    'deviceRemoval.buttonZone': 'Unassign from this zone',
    'deviceRemoval.buttonFarm': 'Remove device',
  } as Record<string, string>,
}));

const en = (key: string): string => EN[key] ?? key;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => EN[key] ?? options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
  deviceMetadataAPI: { setSoilMoistureDepths: vi.fn().mockResolvedValue(undefined) },
  kiwiAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    enableTemperatureHumidity: vi.fn().mockResolvedValue(undefined),
  },
  s2120API: { setZoneAssignments: vi.fn().mockResolvedValue(undefined) },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

function device(overrides: Partial<Device>): Device {
  return {
    id: 1,
    deveui: '70B3D5E75E004202',
    name: 'Test device',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    last_seen: '2026-09-01T00:00:00Z',
    irrigation_zone_id: null,
    is_claimed: true,
    latest_data: {},
    ...overrides,
  } as unknown as Device;
}

type CardCase = {
  name: string;
  render: (props: { removeContext: DeviceRemoveContext; onRemove: () => void }) => React.ReactElement;
  deveui: string;
};

const cards: CardCase[] = [
  {
    name: 'KiwiSensorCard',
    deveui: '70B3D5E75E004202',
    render: (props) => <KiwiSensorCard device={device({ type_id: 'KIWI_SENSOR', latest_data: { swt_1: 30 } })} {...props} />,
  },
  {
    name: 'DraginoTempCard',
    deveui: 'AA00000000000001',
    render: (props) => (
      <DraginoTempCard device={device({ deveui: 'AA00000000000001', type_id: 'DRAGINO_LSN50' })} {...props} />
    ),
  },
  {
    name: 'Sdi12SoilCard',
    deveui: '70B3D5E75E004203',
    render: (props) => (
      <Sdi12SoilCard device={device({ deveui: '70B3D5E75E004203', type_id: 'DRAGINO_SDI12' })} {...props} />
    ),
  },
  {
    name: 'SenseCapWeatherCard',
    deveui: '2CF7F1C04340000A',
    render: (props) => (
      <SenseCapWeatherCard device={device({ deveui: '2CF7F1C04340000A', type_id: 'SENSECAP_S2120' })} {...props} />
    ),
  },
  {
    name: 'LoRainGaugeCard',
    deveui: '70B3D5E75E004201',
    render: (props) => (
      <LoRainGaugeCard device={device({ deveui: '70B3D5E75E004201', type_id: 'AQUASCOPE_LORAIN' })} {...props} />
    ),
  },
];

function openConfirm(removeContext: DeviceRemoveContext) {
  fireEvent.click(screen.getByTitle(en(removeContext === 'zone' ? 'deviceRemoval.buttonZone' : 'deviceRemoval.buttonFarm')));
}

function clickConfirm(removeContext: DeviceRemoveContext) {
  fireEvent.click(screen.getByText(en(removeContext === 'zone' ? 'deviceRemoval.confirmZone' : 'deviceRemoval.confirmFarm')));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe.each(cards)('$name removal context', ({ name, render: renderCard, deveui }) => {
  it(`${name} removeContext="zone": confirming remove calls onRemove and never devicesAPI.remove`, async () => {
    const onRemove = vi.fn();
    render(renderCard({ removeContext: 'zone', onRemove }));

    openConfirm('zone');
    clickConfirm('zone');

    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    expect(devicesAPI.remove).not.toHaveBeenCalled();
  });

  it(`${name} removeContext="farm": confirming remove calls devicesAPI.remove, then onRemove`, async () => {
    const calls: string[] = [];
    vi.mocked(devicesAPI.remove).mockImplementation(async () => {
      calls.push('devicesAPI.remove');
    });
    const onRemove = vi.fn(() => {
      calls.push('onRemove');
    });
    render(renderCard({ removeContext: 'farm', onRemove }));

    openConfirm('farm');
    clickConfirm('farm');

    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    expect(devicesAPI.remove).toHaveBeenCalledWith(deveui);
    expect(calls).toEqual(['devicesAPI.remove', 'onRemove']);
  });

  it(`${name} zone-context copy promises only a zone detach`, () => {
    render(renderCard({ removeContext: 'zone', onRemove: vi.fn() }));
    openConfirm('zone');

    expect(screen.getByText(en('deviceRemoval.subtitleZone'))).toBeInTheDocument();
    expect(screen.getByText(en('deviceRemoval.titleZone'))).toBeInTheDocument();
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();
  });

  it(`${name} farm-context copy names the account unlink`, () => {
    render(renderCard({ removeContext: 'farm', onRemove: vi.fn() }));
    openConfirm('farm');

    expect(screen.getByText(en('deviceRemoval.subtitleFarm'))).toBeInTheDocument();
    expect(screen.getByText(en('deviceRemoval.titleFarm'))).toBeInTheDocument();
    expect(screen.getByText(/account/i)).toBeInTheDocument();
    // DELETE /api/devices/:deveui never deletes device_data; the copy must not claim it.
    expect(screen.queryByText(/delete .*readings/i)).not.toBeInTheDocument();
  });
});

describe('the pinned English copy', () => {
  it('matches public/locales/en/devices.json', () => {
    const shipped = enDevices.deviceRemoval as Record<string, string>;

    for (const [key, expected] of Object.entries(EN)) {
      expect(shipped[key.replace('deviceRemoval.', '')]).toBe(expected);
    }
  });
});
