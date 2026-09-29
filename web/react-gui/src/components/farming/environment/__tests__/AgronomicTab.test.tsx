// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import enDevices from '../../../../../public/locales/en/devices.json';
import { AgronomicTab } from '../AgronomicTab';

function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices'], resources: { en: { devices: enDevices } }, interpolation: { escapeValue: false }, initImmediate: false });
  return instance;
}
const agronomic = { preferredSource: 'local', current: { thermodynamicSource: 'local', evapotranspirationSource: 'open_meteo', cropCoefficientSource: 'unavailable', airTemperatureC: 20, relativeHumidityPct: 60, vpdKpa: 0.9, dewPointC: 12, heatIndexC: 20, thi: 66, referenceEt0MmDay: 4, cropCoefficientKc: null, etcMmDay: null } };
afterEach(cleanup);

describe('AgronomicTab Kc', () => {
  it('resolves the FAO-56 Kc, labels its source with the kcSource keys, and keeps the explanation in a HelpTip', () => {
    render(<I18nextProvider i18n={i18n()}><AgronomicTab agronomic={agronomic as never} cropType="maize" phenologicalStage="veraison" /></I18nextProvider>);
    expect(screen.getByText('1.20')).toBeInTheDocument();
    expect(screen.getByText('Maize (grain), Mid-season')).toBeInTheDocument();
    expect(screen.queryByText(/FAO-56 Kc for Maize/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the crop coefficient' }));
    expect(screen.getByText('FAO-56 Kc for Maize (grain): initial 0.30, mid-season 1.20, end 0.35. Current stage: Mid-season.')).toBeInTheDocument();
  });
});

describe('AgronomicTab stage label fallback', () => {
  it('names the stage from its English fallback when the bundle has no zoneConfig.stage key', () => {
    const { zoneConfig: _dropped, ...withoutZoneConfig } = enDevices as Record<string, unknown>;
    void _dropped;
    const instance = i18next.createInstance();
    void instance.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices'], resources: { en: { devices: withoutZoneConfig } }, interpolation: { escapeValue: false }, initImmediate: false });
    render(<I18nextProvider i18n={instance}><AgronomicTab agronomic={agronomic as never} cropType="maize" phenologicalStage="late_season" /></I18nextProvider>);
    expect(screen.getByText('Maize (grain), Late season')).toBeInTheDocument();
    expect(screen.queryByText(/zoneConfig\.stage/)).not.toBeInTheDocument();
  });
});
