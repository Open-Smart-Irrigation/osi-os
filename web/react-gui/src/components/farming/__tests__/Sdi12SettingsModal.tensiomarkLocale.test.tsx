// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import deChDevices from '../../../../public/locales/de-CH/devices.json';
import type { Device } from '../../../types/farming';
import { fetchSdi12Profiles, putSdi12Config } from '../../../services/api';
import { Sdi12SettingsModal } from '../Sdi12SettingsModal';

vi.mock('../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api')>('../../../services/api');
  return { ...actual, fetchSdi12Profiles: vi.fn(), putSdi12Config: vi.fn(), devicesAPI: { getAll: vi.fn() } };
});

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
  name: 'Tensiomark',
  type_id: 'DRAGINO_SDI12',
  latest_data: { bat_v: 3.6 },
  sdi12_probe_profile: 'TENSIOMARK',
  sdi12_identity: '111TENSIOMARK_2Vh_10A00001',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Sdi12SettingsModal Tensiomark locale', () => {
  it('renders German labels, screen-reader labels and a row-specific error', async () => {
    vi.mocked(fetchSdi12Profiles).mockResolvedValue({
      profiles: [{ id: 'TENSIOMARK', label: 'ecoTech Tensiomark', provisional: true, expectedValues: 2, defaultDepthsCm: [], channels: ['swt_1', 'soil_temp_1'] }],
    });
    render(
      <I18nextProvider i18n={germanI18n()}>
        <Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />
      </I18nextProvider>,
    );
    expect(await screen.findByLabelText('Tensiomark-Adresse 1')).toHaveValue('1');
    expect(screen.getByLabelText('Tensiomark-Identität 1')).toHaveValue('111TENSIOMARK_2Vh_10A00001');
    expect(screen.getByText('Adresse')).toBeInTheDocument();
    expect(screen.getByText('Tiefe (cm)')).toBeInTheDocument();
    expect(screen.queryByText(/Address|Identity|Depth \(cm\)/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sensor hinzufügen' }));
    expect(screen.getByRole('button', { name: 'Tensiomark-Sensor 2 entfernen' })).toHaveTextContent('Entfernen');

    fireEvent.click(screen.getByLabelText('Ich bestätige, dass der Sensor zuerst die Temperatur und dann pF meldet.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Sensor 2: Die Adresse muss ein Buchstabe oder eine Ziffer sein.')).toBeInTheDocument();
    expect(putSdi12Config).not.toHaveBeenCalled();
  });
});
