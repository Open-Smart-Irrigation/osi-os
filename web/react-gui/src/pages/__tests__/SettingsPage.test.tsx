// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { irrigationZonesAPI, supportRequestsAPI } from '../../services/api';
import { readDisplayPreferences } from '../../utils/displayPreferences';
import { SettingsPage } from '../SettingsPage';

const apiMocks = vi.hoisted(() => ({
  disableAllSchedules: vi.fn(),
  createSupportRequest: vi.fn(),
  getSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  irrigationZonesAPI: {
    disableAllSchedules: apiMocks.disableAllSchedules,
  },
  supportRequestsAPI: {
    create: apiMocks.createSupportRequest,
  },
  systemSettingsAPI: {
    get: apiMocks.getSystemSettings,
    update: apiMocks.updateSystemSettings,
  },
  getApiErrorMessage: (error: unknown, fallback: string) => (
    error instanceof Error && error.message ? error.message : fallback
  ),
}));

const i18nMock = vi.hoisted(() => ({
  language: 'en',
  changeLanguage: vi.fn((code: string) => {
    i18nMock.language = code;
    window.localStorage.setItem('i18n_language', code);
    return Promise.resolve();
  }),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    i18n: i18nMock,
    t: (key: string, options?: Record<string, unknown> | string) => {
      const map: Record<string, string> = {
        title: 'Settings',
        backToDashboard: 'Back to dashboard',
        languageTitle: 'Language',
        appearanceTitle: 'Appearance',
        theme: 'Theme',
        light: 'Light',
        dark: 'Dark',
        system: 'System',
        unitsTitle: 'Units & Display',
        swtUnit: 'Soil water tension unit',
        kpa: 'kPa',
        pf: 'pF',
        swtSample: 'SWT sample',
        timeZoneTitle: 'Time zone',
        timeZoneDescription: 'Sets the default time zone for newly created zones and the fallback used when a zone has none. Existing zones keep their own time zone unless you apply this one to all of them.',
        timeZoneLabel: 'Gateway time zone',
        timeZoneSave: 'Save',
        timeZoneSaving: 'Saving...',
        timeZoneSaved: 'Time zone saved',
        timeZoneInvalid: 'Enter a valid IANA time zone (e.g. Europe/Rome)',
        timeZoneSaveError: 'Could not save the time zone',
        timeZoneLoadError: 'Could not load the time zone setting',
        timeZoneApplyAll: 'Apply to all zones',
        timeZoneApplying: 'Applying...',
        timeZoneApplyAllConfirm: "Set every zone's time zone to {{timezone}}? Zones with a different time zone will be overridden.",
        timeZoneApplyAllSuccess_one: 'Updated {{count}} zone to {{timezone}}.',
        timeZoneApplyAllSuccess_other: 'Updated {{count}} zones to {{timezone}}.',
        timeZoneApplyAllError: 'Could not apply the time zone to all zones',
        modulesTitle: 'Modules',
        predictionAdvisory: 'Prediction advisory',
        predictionAdvisoryWarning: 'Experimental, do not use for production!',
        waterCard: 'Water balance',
        environmentCard: 'Environment & weather forecast',
        irrigationSchedule: 'Irrigation schedule',
        valveControl: 'Valve control',
        schedulerDisableConfirm: 'Disable all active irrigation schedules before hiding this module?',
        schedulerDisableSuccess_one: 'Disabled {{count}} active schedule.',
        schedulerDisableSuccess_other: 'Disabled {{count}} active schedules.',
        schedulerDisableError: 'Could not disable irrigation schedules',
        dataTitle: 'Data & Refresh',
        autoRefresh: 'Auto-refresh dashboard',
        userRequestTitle: 'User request',
        requestType: 'Request type',
        bugFix: 'Bug fix',
        featureRequest: 'Feature request',
        requestTitle: 'Title',
        contactEmail: 'Email address (optional)',
        requestArea: 'Area',
        requestImpact: 'Impact',
        requestDescription: 'Description',
        requestShareConsent: 'May be shared publicly without private farm details.',
        requestIncludeDiagnostics: 'Include diagnostics',
        requestSubmit: 'Save request',
        requestSubmitting: 'Saving...',
        requestSaved: 'Saved, waiting for internet',
        requestError: 'Could not save request',
        area_dashboard: 'Dashboard',
        area_history: 'History',
        area_analysis: 'Analysis',
        area_watering: 'Watering',
        area_devices: 'Devices',
        area_sync: 'Sync',
        area_system: 'System',
        area_other: 'Other',
        impact_cant_work: 'Cannot work',
        impact_workaround: 'Workaround available',
        impact_annoying: 'Annoying',
        impact_idea: 'Idea',
        on: 'On',
        off: 'Off',
      };
      let result = map[key] ?? key;
      if (typeof options === 'object' && options) {
        for (const [placeholder, value] of Object.entries(options)) {
          result = result.split(`{{${placeholder}}}`).join(String(value));
        }
      }
      return result;
    },
  }),
}));

function renderSettings() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </SWRConfig>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  i18nMock.language = 'en';
  i18nMock.changeLanguage.mockClear();
  apiMocks.disableAllSchedules.mockReset();
  apiMocks.disableAllSchedules.mockResolvedValue({ disabledSchedules: 0 });
  apiMocks.createSupportRequest.mockReset();
  apiMocks.createSupportRequest.mockResolvedValue({ request_id: 'local-1', local_status: 'QUEUED' });
  apiMocks.getSystemSettings.mockReset();
  apiMocks.getSystemSettings.mockResolvedValue({ gatewayTimezone: 'UTC' });
  apiMocks.updateSystemSettings.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsPage', () => {
  it('renders the Stage A settings sections and controls', () => {
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Units & Display' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Time zone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Modules' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Data & Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'User request' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kPa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'pF' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'On' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Off' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Dashboard density')).not.toBeInTheDocument();
    expect(screen.queryByText('Gateway-wide display and operational defaults.')).not.toBeInTheDocument();
    expect(screen.queryByText('Choose the language for this browser. The saved language continues to use the existing i18next setting.')).not.toBeInTheDocument();
    expect(screen.queryByText('Dark mode updates the application shell and dashboard surfaces in this browser.')).not.toBeInTheDocument();
    expect(screen.queryByText('Show dendrometer irrigation recommendation banners.')).not.toBeInTheDocument();
    expect(screen.queryByText('Controls only dashboard refresh behavior in this browser. It does not change sensor uplink intervals or irrigation scheduler cadence.')).not.toBeInTheDocument();
    expect(screen.queryByText('Field requests')).not.toBeInTheDocument();
  });

  it('changes language through the settings page switcher', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }));

    expect(i18nMock.changeLanguage).toHaveBeenCalledWith('de-CH');
    expect(window.localStorage.getItem('i18n_language')).toBe('de-CH');
  });

  it('persists SWT display unit and updates the visible sample', () => {
    renderSettings();

    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'pF' }));

    expect(readDisplayPreferences().swtUnit).toBe('pF');
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'kPa' }));
    expect(readDisplayPreferences().swtUnit).toBe('kPa');
    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
  });

  it('persists theme selection and reapplies it across a reload simulation', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(readDisplayPreferences().theme).toBe('dark');

    cleanup();
    document.documentElement.removeAttribute('data-theme');
    renderSettings();

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('exposes the intended module defaults and warning copy', () => {
    renderSettings();

    const modules = screen.getByRole('region', { name: 'Modules' });

    expect(within(modules).getByText('Prediction advisory')).toBeInTheDocument();
    expect(within(modules).getByText('Experimental, do not use for production!')).toBeInTheDocument();
    const moduleRows = within(modules).getAllByRole('group');
    expect(moduleRows).toHaveLength(5);
    expect(moduleRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Prediction advisory'),
      expect.stringContaining('Water balance'),
      expect.stringContaining('Irrigation schedule'),
      expect.stringContaining('Valve control'),
      expect.stringContaining('Environment & weather forecast'),
    ]);
    expect(within(moduleRows[0]).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(moduleRows[1]).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(moduleRows[2]).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(moduleRows[3]).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(moduleRows[4]).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('persists display-only module toggles locally', () => {
    renderSettings();

    const modules = screen.getByRole('region', { name: 'Modules' });
    const moduleRows = within(modules).getAllByRole('group');
    fireEvent.click(within(moduleRows[0]).getByRole('button', { name: 'On' }));
    fireEvent.click(within(moduleRows[1]).getByRole('button', { name: 'Off' }));
    fireEvent.click(within(moduleRows[4]).getByRole('button', { name: 'Off' }));

    expect(readDisplayPreferences().modules).toEqual({
      predictionAdvisory: true,
      waterCard: false,
      environment: false,
      schedulerUi: true,
      valveControl: true,
    });
    expect(irrigationZonesAPI.disableAllSchedules).not.toHaveBeenCalled();
  });

  it('does not hide irrigation schedules when the disable confirmation is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings();

    const modules = screen.getByRole('region', { name: 'Modules' });
    const schedulerRow = within(modules).getAllByRole('group')[2];
    fireEvent.click(within(schedulerRow).getByRole('button', { name: 'Off' }));

    expect(irrigationZonesAPI.disableAllSchedules).not.toHaveBeenCalled();
    expect(readDisplayPreferences().modules.schedulerUi).toBe(true);
    expect(within(schedulerRow).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('disables all active schedules before hiding the irrigation schedule module', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiMocks.disableAllSchedules.mockResolvedValueOnce({ disabledSchedules: 3 });
    renderSettings();

    const modules = screen.getByRole('region', { name: 'Modules' });
    const schedulerRow = within(modules).getAllByRole('group')[2];
    fireEvent.click(within(schedulerRow).getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(irrigationZonesAPI.disableAllSchedules).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Disabled 3 active schedules.')).toBeInTheDocument();
    expect(readDisplayPreferences().modules.schedulerUi).toBe(false);
    expect(within(schedulerRow).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the irrigation schedule module visible when backend deactivation fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiMocks.disableAllSchedules.mockRejectedValueOnce(new Error('edge offline'));
    renderSettings();

    const modules = screen.getByRole('region', { name: 'Modules' });
    const schedulerRow = within(modules).getAllByRole('group')[2];
    fireEvent.click(within(schedulerRow).getByRole('button', { name: 'Off' }));

    expect(await screen.findByText('edge offline')).toBeInTheDocument();
    expect(readDisplayPreferences().modules.schedulerUi).toBe(true);
    expect(within(schedulerRow).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reenables the irrigation schedule module without touching schedules', () => {
    window.localStorage.setItem('osi.modules.schedulerUi', 'false');
    renderSettings();

    const modules = screen.getByRole('region', { name: 'Modules' });
    const schedulerRow = within(modules).getAllByRole('group')[2];
    fireEvent.click(within(schedulerRow).getByRole('button', { name: 'On' }));

    expect(irrigationZonesAPI.disableAllSchedules).not.toHaveBeenCalled();
    expect(readDisplayPreferences().modules.schedulerUi).toBe(true);
    expect(within(schedulerRow).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('submits user requests through the improvement request API with all required fields', async () => {
    renderSettings();

    const userRequest = screen.getByRole('region', { name: 'User request' });
    fireEvent.click(within(userRequest).getByRole('button', { name: 'Bug fix' }));
    fireEvent.change(within(userRequest).getByLabelText('Title'), {
      target: { value: 'Water balance layout breaks' },
    });
    fireEvent.change(within(userRequest).getByLabelText('Email address (optional)'), {
      target: { value: 'farmer@example.com' },
    });
    fireEvent.change(within(userRequest).getByLabelText('Area'), {
      target: { value: 'dashboard' },
    });
    fireEvent.change(within(userRequest).getByLabelText('Impact'), {
      target: { value: 'annoying' },
    });
    fireEvent.change(within(userRequest).getByLabelText('Description'), {
      target: { value: 'The water card shifts in dark mode on desktop.' },
    });
    fireEvent.click(within(userRequest).getByLabelText('Include diagnostics'));
    fireEvent.click(within(userRequest).getByLabelText('May be shared publicly without private farm details.'));

    fireEvent.click(within(userRequest).getByRole('button', { name: 'Save request' }));

    await waitFor(() => expect(supportRequestsAPI.create).toHaveBeenCalledWith({
      type: 'bug',
      title: 'Water balance layout breaks',
      contact_email: 'farmer@example.com',
      description: 'The water card shifts in dark mode on desktop.',
      expected: null,
      actual: null,
      steps: null,
      area: 'dashboard',
      severity: 'annoying',
      consent_public: true,
      consent_diagnostics: false,
      route: '/settings',
      current_route: '/settings',
    }));
    expect(await within(userRequest).findByText('Saved, waiting for internet')).toBeInTheDocument();
  });

  it('loads the gateway time zone into the field', async () => {
    apiMocks.getSystemSettings.mockResolvedValue({ gatewayTimezone: 'Europe/Zurich' });
    renderSettings();

    const timeZone = screen.getByRole('region', { name: 'Time zone' });
    await waitFor(() => {
      expect((within(timeZone).getByLabelText('Gateway time zone') as HTMLInputElement).value).toBe('Europe/Zurich');
    });
  });

  it('saves the gateway time zone and shows success feedback', async () => {
    apiMocks.updateSystemSettings.mockResolvedValueOnce({ gatewayTimezone: 'Europe/Zurich', zonesUpdated: 0 });
    renderSettings();

    const timeZone = screen.getByRole('region', { name: 'Time zone' });
    const input = await within(timeZone).findByLabelText('Gateway time zone');
    fireEvent.change(input, { target: { value: 'Europe/Zurich' } });
    fireEvent.click(within(timeZone).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMocks.updateSystemSettings).toHaveBeenCalledWith({ gatewayTimezone: 'Europe/Zurich' }));
    expect(await within(timeZone).findByText('Time zone saved')).toBeInTheDocument();
  });

  it('shows a validation message for a malformed time zone instead of saving', async () => {
    renderSettings();

    const timeZone = screen.getByRole('region', { name: 'Time zone' });
    const input = await within(timeZone).findByLabelText('Gateway time zone');
    fireEvent.change(input, { target: { value: 'Not/A_Real_Zone' } });

    expect(await within(timeZone).findByText('Enter a valid IANA time zone (e.g. Europe/Rome)')).toBeInTheDocument();
    expect(within(timeZone).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(apiMocks.updateSystemSettings).not.toHaveBeenCalled();
  });

  it('shows the save error message when the backend rejects the update', async () => {
    apiMocks.updateSystemSettings.mockRejectedValueOnce(new Error('edge offline'));
    renderSettings();

    const timeZone = screen.getByRole('region', { name: 'Time zone' });
    const input = await within(timeZone).findByLabelText('Gateway time zone');
    fireEvent.change(input, { target: { value: 'Europe/Zurich' } });
    fireEvent.click(within(timeZone).getByRole('button', { name: 'Save' }));

    expect(await within(timeZone).findByText('edge offline')).toBeInTheDocument();
  });

  it('does not apply to all zones when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings();

    const timeZone = screen.getByRole('region', { name: 'Time zone' });
    const input = await within(timeZone).findByLabelText('Gateway time zone');
    fireEvent.change(input, { target: { value: 'Europe/Zurich' } });
    fireEvent.click(within(timeZone).getByRole('button', { name: 'Apply to all zones' }));

    expect(window.confirm).toHaveBeenCalledWith("Set every zone's time zone to Europe/Zurich? Zones with a different time zone will be overridden.");
    expect(apiMocks.updateSystemSettings).not.toHaveBeenCalled();
  });

  it('applies the time zone to all zones after confirmation and reports the count', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiMocks.updateSystemSettings.mockResolvedValueOnce({ gatewayTimezone: 'Europe/Zurich', zonesUpdated: 3 });
    renderSettings();

    const timeZone = screen.getByRole('region', { name: 'Time zone' });
    const input = await within(timeZone).findByLabelText('Gateway time zone');
    fireEvent.change(input, { target: { value: 'Europe/Zurich' } });
    fireEvent.click(within(timeZone).getByRole('button', { name: 'Apply to all zones' }));

    await waitFor(() => expect(apiMocks.updateSystemSettings).toHaveBeenCalledWith({
      gatewayTimezone: 'Europe/Zurich',
      applyToAllZones: true,
    }));
    expect(await within(timeZone).findByText('Updated 3 zones to Europe/Zurich.')).toBeInTheDocument();
  });
});
