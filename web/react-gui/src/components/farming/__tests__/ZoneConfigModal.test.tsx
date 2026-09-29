import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

import { ZoneConfigModal, localTodayIso } from '../ZoneConfigModal';
import { irrigationZonesAPI } from '../../../services/api';
import type { IrrigationZone } from '../../../types/farming';

vi.mock('../../../services/deviceLocation', () => ({
  getDeviceLocationErrorMessage: vi.fn(() => 'Location unavailable'),
  getDeviceLocationSupport: vi.fn().mockResolvedValue({
    available: false,
    reason: 'unsupported',
    message: 'Device GPS unavailable in tests',
    permissionState: 'unknown',
    canOpenSettings: false,
  }),
  openNativeLocationSettings: vi.fn(() => false),
  requestDeviceLocation: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: {
    updateConfig: vi.fn().mockResolvedValue({}),
    updateCalibration: vi.fn().mockResolvedValue(undefined),
    setZoneLocation: vi.fn().mockResolvedValue(undefined),
  },
  zoneExportAPI: {
    download: vi.fn().mockResolvedValue(undefined),
  },
}));

// Resolves `defaultValue` the way i18next does, so the assertions below read
// the English the modal renders now that its copy goes through t().
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (key === 'zone.export.title') return 'Data export';
      if (typeof options === 'string') return options;
      const values = (options ?? {}) as Record<string, unknown>;
      if (key === 'zone.export.rangeSummary') return `${values.from ?? ''} to ${values.to ?? ''}`;
      const template = typeof values.defaultValue === 'string' ? values.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''));
    },
  }),
}));

const zone: IrrigationZone = {
  id: 42,
  name: 'North Block',
  device_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  schedule: null,
  measuredFlowRateLpm: null,
  measurementMethod: null,
};

describe('ZoneConfigModal irrigation calibration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the data export range calendar for an existing zone', async () => {
    render(
      React.createElement(ZoneConfigModal, {
        isOpen: true,
        zone,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(await screen.findByText('Data export')).toBeInTheDocument();
    expect(screen.getByTestId('range-calendar')).toBeInTheDocument();
  });

  it('saves flow rate and measurement method through the calibration endpoint', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      React.createElement(ZoneConfigModal, {
        isOpen: true,
        zone,
        onClose,
        onSaved,
      }),
    );

    fireEvent.change(screen.getByPlaceholderText('L/min'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByPlaceholderText('Bucket test, meter read, or other method'), {
      target: { value: 'Timed bucket test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(irrigationZonesAPI.updateCalibration).toHaveBeenCalledWith(42, {
        measuredFlowRateLpm: 12.5,
        measurementMethod: 'Timed bucket test',
      });
    });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not expose retired prediction advisory or scheduling source controls', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      React.createElement(ZoneConfigModal, {
        isOpen: true,
        zone: {
          ...zone,
          schedulingMode: 'server_preferred',
          predictionCardEnabled: true,
        },
        onClose,
        onSaved,
      }),
    );

    expect(await screen.findByText('Data export')).toBeInTheDocument();
    expect(screen.queryByText('Prediction Advisory')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduling source')).not.toBeInTheDocument();
    expect(screen.queryByText('Used to convert irrigation liters into effective mm for the water balance.')).not.toBeInTheDocument();
    expect(screen.queryByText('Enter the estimated share of delivered water that reaches the crop root zone.')).not.toBeInTheDocument();
    expect(screen.queryByText('Used to align nightly min/max extraction windows. IANA timezone (e.g. Europe/Rome).')).not.toBeInTheDocument();
    expect(screen.queryByText('Selects species-specific stress thresholds for dendrometer analysis.')).not.toBeInTheDocument();
    expect(screen.queryByText('Adjusts stress sensitivity for the current growth phase.')).not.toBeInTheDocument();
    expect(screen.queryByText('Used for weather and VPD lookup. Save both coordinates together.')).not.toBeInTheDocument();
    expect(screen.queryByText('Use your phone or browser location for this zone.')).not.toBeInTheDocument();
    expect(screen.queryByText('Fills latitude and longitude from this device. Review timezone separately if the farm is in a different timezone.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), {
      target: { value: 'Use local schedule defaults.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, {
        notes: 'Use local schedule defaults.',
      });
    });
  });
  it('shows a legacy stored stage mapped and does not write it back when only notes change', async () => {
    const onSaved = vi.fn();
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'grapevine', phenologicalStage: 'veraison' }, onClose: vi.fn(), onSaved }));
    const stage = screen.getByLabelText('Phenological stage') as HTMLSelectElement;
    expect(stage.value).toBe('mid_season');
    expect(stage.selectedOptions[0].textContent).toBe('Mid-season (fruit growth, ripening)');
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'x' }));
  });

  it('writes the FAO key when the user picks a stage, and labels stages by crop family', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const stage = screen.getByLabelText('Phenological stage') as HTMLSelectElement;
    expect([...stage.options].map((o) => o.textContent)).toEqual(['Not set', 'Initial (sowing, emergence)', 'Development (canopy closing)', 'Mid-season (full cover, flowering)', 'Late season (ripening, harvest)', 'Dormancy (no crop)']);
    fireEvent.change(stage, { target: { value: 'late_season' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // Another stage starts today unless the user edits the pre-filled date.
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'late_season', stageStartedOn: localTodayIso() }));
  });

  it('lists the whole catalogue in native groups and explains stages in a HelpTip', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    const crop = screen.getByLabelText('Crop') as HTMLSelectElement;
    expect(crop.querySelectorAll('optgroup')).toHaveLength(15);
    expect(crop.querySelectorAll('option')).toHaveLength(1 + 136 + 1);
    expect(screen.queryByText(/FAO-56 growth stages set the crop coefficient/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About growth stages' }));
    expect(screen.getByText(/FAO-56 growth stages set the crop coefficient/)).toBeInTheDocument();
  });

  it('sends a cleared stage as default so the cloud mirror follows, paired with an empty date, and shows a stored default as not set', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'mid_season' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const stage = screen.getByLabelText('Phenological stage') as HTMLSelectElement;
    fireEvent.change(stage, { target: { value: '' } });
    expect(stage.selectedOptions[0].textContent).toBe('Not set');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // A payload that carries phenologicalStage carries stageStartedOn too, even
    // when there was no stored date to begin with (final review E-I2/E-M-queue).
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'default', stageStartedOn: null }));
  });

  it('selects the catalogue option for a stored crop in another case and does not write it back untouched', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'Maize' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const crop = screen.getByLabelText('Crop') as HTMLSelectElement;
    expect(crop.value).toBe('maize');
    expect(crop.selectedOptions[0].textContent).toBe('Maize (grain)');
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'z' }));
  });

  it('keeps a stored crop outside the catalogue as its own option', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'Heirloom Tomato' }, onClose: vi.fn(), onSaved: vi.fn() }));
    expect((screen.getByLabelText('Crop') as HTMLSelectElement).value).toBe('Heirloom Tomato');
  });

  it('explains in the stage HelpTip that dormancy is not for evergreens', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'About growth stages' }));
    expect(screen.getByText(/Dormancy \(Kc 0\.25\) is for deciduous crops and annual rest periods; evergreens such as citrus, olive, coffee and banana keep their late-season Kc instead\./)).toBeInTheDocument();
  });

  it('does not write back a stored default stage the user did not touch', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, phenologicalStage: 'default' }, onClose: vi.fn(), onSaved: vi.fn() }));
    expect((screen.getByLabelText('Phenological stage') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'y' }));
  });

  it('offers four weather providers and names the gateway default in the auto option', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, weatherSourceDefault: 'meteoswiss' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const provider = screen.getByLabelText('Weather provider') as HTMLSelectElement;
    expect([...provider.options].map((o) => [o.value, o.textContent])).toEqual([
      ['auto', 'Gateway default (MeteoSwiss)'],
      ['open_meteo', 'Open-Meteo'],
      ['meteoswiss', 'MeteoSwiss'],
      ['local', 'Local weather station only'],
    ]);
    expect(provider.value).toBe('auto');
    expect(screen.queryByText(/downloads no weather history/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the weather provider' }));
    expect(screen.getByText(/downloads no weather history/)).toBeInTheDocument();
  });

  it('sends the chosen provider, and nothing when the selection is unchanged', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Weather provider'), { target: { value: 'meteoswiss' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { weatherSource: 'meteoswiss' }));

    vi.clearAllMocks();
    cleanup();
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, weatherSource: 'open_meteo' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'x' }));
  });

  it('shows a cloud-only provider as a disabled selected option and keeps it on a crop save', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, weatherSource: 'openagri' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const provider = screen.getByLabelText('Weather provider') as HTMLSelectElement;
    expect(provider.value).toBe('openagri');
    expect(provider.selectedOptions[0].textContent).toBe('openagri (cloud provider)');
    expect(provider.selectedOptions[0].disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Crop'), { target: { value: 'maize' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { cropType: 'maize' }));
  });

  it('places the provider after the Device GPS panel and before Notes', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    const gps = screen.getByText('Device GPS');
    const provider = screen.getByLabelText('Weather provider');
    const notes = screen.getByLabelText('Notes');
    expect(gps.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(provider.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the stage start date input disabled until a stage is chosen', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
    expect(startedOn.type).toBe('date');
    expect(startedOn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: 'development' } });
    expect(startedOn).not.toBeDisabled();
  });

  it('starts the date empty when the stored stage is unset, even with a leftover stored date', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: null, stageStartedOn: '2026-04-10' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
    expect(startedOn.value).toBe('');
    expect(startedOn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'x' }));
  });

  it('pre-fills today on a stage change, keeps the field editable and sends the edited date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 4, 21, 23, 30));
      render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'initial', stageStartedOn: '2026-04-10' }, onClose: vi.fn(), onSaved: vi.fn() }));
      fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: 'development' } });
      const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
      expect(startedOn.value).toBe('2026-05-21');
      fireEvent.change(startedOn, { target: { value: '2026-05-18' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'development', stageStartedOn: '2026-05-18' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the stored date when landing back on the stored stage, and sends neither key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 4, 21, 23, 30));
      render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'initial', stageStartedOn: '2026-04-10' }, onClose: vi.fn(), onSaved: vi.fn() }));
      const stage = screen.getByLabelText('Phenological stage') as HTMLSelectElement;
      const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
      fireEvent.change(stage, { target: { value: 'development' } });
      expect(startedOn.value).toBe('2026-05-21');
      fireEvent.change(stage, { target: { value: 'initial' } });
      expect(startedOn.value).toBe('2026-04-10');
      fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'x' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('empties the date when the stage is set to Not set, and sends the clear', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'late_season', stageStartedOn: '2026-08-01' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: '' } });
    expect((screen.getByLabelText('Stage started on') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Stage started on')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'default', stageStartedOn: null }));
  });

  it('sends an unset stage picked then given a cleared date as the stage plus an explicit empty date', async () => {
    // (a) unset stage, pick a stage, clear the pre-filled date, save: the
    // payload must carry both the stage and an explicit empty date, not the
    // stage alone (final review E-I2/E-M-queue).
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: 'development' } });
    const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
    fireEvent.change(startedOn, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'development', stageStartedOn: null }));
  });

  it('(b) the date travels with the stage: a second stage change on the day the stored date already is today still sends both', async () => {
    // Ruling (final-fix-brief-edge item 3, overriding a literal reading of the
    // review's prose "so the form sends only the stage"): whenever the payload
    // carries phenologicalStage it must carry stageStartedOn too, even when the
    // pre-filled date is unchanged from the stored one because both already
    // equal the zone-local today. Sending the stage alone here would leave the
    // backend to stamp its own today, which can differ from the browser's
    // across a timezone boundary (cloud form osi-server 070b3f88).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 4, 21, 23, 30));
      render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'initial', stageStartedOn: '2026-05-21' }, onClose: vi.fn(), onSaved: vi.fn() }));
      const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
      expect(startedOn.value).toBe('2026-05-21');
      fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: 'development' } });
      // The date field still reads today (2026-05-21) -- unchanged from the
      // stored value, because "today" has not moved since the last change.
      expect(startedOn.value).toBe('2026-05-21');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'development', stageStartedOn: '2026-05-21' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the start date only when it changed', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-05-01' }, onClose: vi.fn(), onSaved: vi.fn() }));
    expect((screen.getByLabelText('Stage started on') as HTMLInputElement).value).toBe('2026-05-01');
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'n' }));
  });

  it('names the typical stage length in the HelpTip, and leaves it out when the crop has none for the stage', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'development' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'About the stage start date' }));
    expect(screen.getByText(/after the typical length for this crop \(40 days\) Kc stays at the stage's end value/)).toBeInTheDocument();
    cleanup();
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'grass', phenologicalStage: 'late_season' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'About the stage start date' }));
    expect(screen.getByText(/after the typical length for this crop Kc stays at the stage's end value/)).toBeInTheDocument();
    expect(screen.queryByText(/days\)/)).not.toBeInTheDocument();
  });
});
