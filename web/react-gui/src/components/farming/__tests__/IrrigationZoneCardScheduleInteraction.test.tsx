// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enCommon from '../../../../public/locales/en/common.json';
import enDevices from '../../../../public/locales/en/devices.json';
import enValves from '../../../../public/locales/en/valves.json';
import type { IrrigationZone } from '../../../types/farming';

const api = vi.hoisted(() => ({
  getAll: vi.fn(), updateSchedule: vi.fn().mockResolvedValue(undefined),
  getZoneRecommendations: vi.fn().mockResolvedValue([]), getSummary: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { getAll: api.getAll, updateSchedule: api.updateSchedule, delete: vi.fn(), removeDevice: vi.fn() },
  dendroAnalyticsAPI: { getZoneRecommendations: api.getZoneRecommendations },
  environmentAPI: { getSummary: api.getSummary },
}));
vi.mock('../../../hooks/useGatewayModules', () => ({ useGatewayModules: () => ({ data: true, network: true, gatewayHub: true, journal: true }) }));
vi.mock('../../../utils/displayPreferences', () => ({ useDisplayPreferences: () => ({ swtUnit: 'kPa', modules: { schedulerUi: true, environment: false, predictionAdvisory: false } }) }));
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: () => true }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => null }));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => null }));
vi.mock('../ZoneDeviceModal', () => ({ ZoneDeviceModal: () => null }));
vi.mock('../ZoneConfigModal', () => ({ ZoneConfigModal: () => null }));
vi.mock('../shared/EditableName', () => ({ EditableName: () => null }));
vi.mock('../shared/HelpTip', () => ({ HelpTip: () => null }));
vi.mock('../InfoTip', () => ({ InfoTip: () => null }));

import { IrrigationZoneCard } from '../IrrigationZoneCard';

const zone = {
  id: 7, name: 'Test zone', device_count: 0,
  schedule: { trigger_metric: 'DENDRO', threshold_kpa: 2, duration_minutes: 18, response_mode: 'fixed' },
} as IrrigationZone;
const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { common: enCommon, devices: enDevices, valves: enValves } }, interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false });

beforeEach(() => {
  api.getAll.mockReset()
    .mockResolvedValueOnce([{ id: 7, schedule: zone.schedule }])
    .mockResolvedValueOnce([{ id: 7, schedule: { ...zone.schedule, duration_minutes: 23 } }]);
  api.updateSchedule.mockClear();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('IrrigationZoneCard schedule integration', () => {
  it('opens the shared editor from the drawer, refreshes through the request token, and saves current data', async () => {
    const user = userEvent.setup();
    render(<I18nextProvider i18n={i18n}><MemoryRouter><IrrigationZoneCard zone={zone} devices={[]} unassignedDevices={[]} onUpdate={vi.fn()} /></MemoryRouter></I18nextProvider>);
    await user.click(screen.getByRole('button', { name: /Test zone/ }));
    const section = screen.getByRole('button', { name: /trigger-based irrigation|irrigation schedule/i });
    await user.click(section);
    await user.click(await screen.findByRole('button', { name: /advanced settings/i }));
    await user.click(await screen.findByRole('button', { name: /edit schedule/i }));
    await waitFor(() => expect(api.getAll).toHaveBeenCalledTimes(2));
    expect(section).toHaveAttribute('aria-expanded', 'true');
    await user.click(await screen.findByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith(7, expect.objectContaining({ trigger_metric: 'DENDRO', duration_minutes: 23, threshold_kpa: 2 })));
  });
});
