// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import deChDevices from '../../../../public/locales/de-CH/devices.json';
import type { Device } from '../../../types/farming';
import { Sdi12SoilCard } from '../Sdi12SoilCard';

const NOW = Date.parse('2026-09-24T08:00:00.000Z');

function germanI18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'de-CH',
    fallbackLng: 'de-CH',
    defaultNS: 'devices',
    ns: ['devices'],
    resources: { 'de-CH': { devices: deChDevices } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
  return instance;
}

const device: Device = {
  deveui: 'A840410000000101',
  name: 'Tensiomark pair',
  type_id: 'DRAGINO_SDI12',
  sdi12_probe_profile: 'TENSIOMARK',
  sdi12_probe_status: 'identified',
  last_seen: new Date(NOW - 30 * 60 * 1000).toISOString(),
  sdi12_channel_layout_json: {
    version: 1,
    kind: 'tensiomark',
    source_unit: 'pF',
    field_order: 'temperature_pf',
    qualification: 'bench_observed',
    sensors: [
      { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
      { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: null, calibration_range: 'unverified' },
    ],
  },
  latest_data: { swt_1: 30.2, soil_temp_1: 21.5, swt_2: 12.5, soil_temp_2: 19.1, bat_v: 3.6 },
};

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Sdi12SoilCard Tensiomark locale', () => {
  it('renders German labels and the common water-state badge', () => {
    render(
      <I18nextProvider i18n={germanI18n()}>
        <Sdi12SoilCard device={device} readOnly removeContext="farm" />
      </I18nextProvider>,
    );

    expect(screen.queryByText('Kalibrierbereich: nicht verifiziert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bodenwasserspannung' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Bodenspannung 1' })).getByRole('button', { name: '30.2 kPa' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Bodenspannung 1' })).getByRole('button', { name: 'Boden 21.5 °C' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Bodenspannung 2' })).getByRole('button', { name: '12.5 kPa' })).toBeInTheDocument();
    expect(screen.getByText('Identifiziert')).toBeInTheDocument();
    expect(screen.getByText(/Zuletzt gesehen: vor 30 Minuten/)).toBeInTheDocument();
    expect(screen.queryByText(/^SWT|Bodentemperatur|TENSIOMARK|Last seen/)).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-swt-status]')).toHaveLength(2);
  });
});
