// @vitest-environment jsdom
//
// Unit tests for the shared display fallback banner formatter (#310).
// `display.fallbackReasonCode` is the stable, open-vocabulary code newer
// gateways attach next to the legacy English `display.fallbackReason`
// sentence. The formatter is the one place EnvironmentCard and
// IrrigationZoneCard both consume it, so the honesty rules live here once:
// recognized codes translate, unrecognized codes and inherited prose get the
// generic translated key, and no input ever puts raw prose or a raw
// identifier on screen.
import { initReactI18next } from 'react-i18next';
import i18next, { type TFunction } from 'i18next';
import { beforeEach, describe, expect, it } from 'vitest';

import { formatDisplayFallbackReason } from '../displayFallback';

import enDevices from '../../../public/locales/en/devices.json';
import frDevices from '../../../public/locales/fr/devices.json';

async function buildT(language: string): Promise<TFunction<'devices'>> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: { en: { devices: enDevices }, fr: { devices: frDevices } },
  });
  return instance.getFixedT(null, 'devices');
}

describe('formatDisplayFallbackReason (#310)', () => {
  let fr: TFunction<'devices'>;
  let en: TFunction<'devices'>;

  beforeEach(async () => {
    fr = await buildT('fr');
    en = await buildT('en');
  });

  it('translates a recognized explicit code', () => {
    expect(formatDisplayFallbackReason(fr, { fallbackReasonCode: 'using_last_synced', fallbackReason: 'Using last synced OSI Server values.' }))
      .toBe(frDevices.zone.water.source.using_last_synced);
    expect(formatDisplayFallbackReason(fr, { fallbackReasonCode: 'bundle_unavailable', fallbackReason: 'irrelevant prose' }))
      .toBe(frDevices.zone.water.source.bundle_unavailable);
  });

  it('renders a recognized code that arrives without any prose', () => {
    expect(formatDisplayFallbackReason(fr, { fallbackReasonCode: 'bundle_unavailable', fallbackReason: null }))
      .toBe(frDevices.zone.water.source.bundle_unavailable);
  });

  it('renders the generic key for an unrecognized code, never the raw identifier', () => {
    const out = formatDisplayFallbackReason(fr, { fallbackReasonCode: 'future_gateway_code', fallbackReason: null });
    expect(out).toBe(frDevices.zone.water.source.fallback_generic);
    expect(out).not.toContain('future_gateway_code');
  });

  it('keeps the legacy sentence translation for older responses without a code', () => {
    expect(formatDisplayFallbackReason(fr, { fallbackReason: 'Using last synced OSI Server values.' }))
      .toBe(frDevices.zone.water.source.using_last_synced);
    expect(formatDisplayFallbackReason(fr, { fallbackReason: 'Using local fallback because the OSI Server bundle is unavailable.' }))
      .toBe(frDevices.zone.water.source.bundle_unavailable);
  });

  it('renders the generic key for unknown legacy prose, never the prose itself', () => {
    const out = formatDisplayFallbackReason(en, { fallbackReason: 'A brand new banner the flow node does not emit yet.' });
    expect(out).toBe(enDevices.zone.water.source.fallback_generic);
    expect(out).not.toContain('A brand new banner');
  });

  it('answers null when neither reason nor code exists, so no banner renders', () => {
    expect(formatDisplayFallbackReason(fr, { fallbackReason: null, fallbackReasonCode: null })).toBeNull();
    expect(formatDisplayFallbackReason(fr, {})).toBeNull();
    expect(formatDisplayFallbackReason(fr, undefined)).toBeNull();
    expect(formatDisplayFallbackReason(fr, { fallbackReason: '', fallbackReasonCode: '' })).toBeNull();
  });

  it.each(['constructor', 'toString', '__proto__'])('treats prototype name %s as unknown in both fields', (value) => {
    expect(formatDisplayFallbackReason(fr, { fallbackReasonCode: value }))
      .toBe(frDevices.zone.water.source.fallback_generic);
    expect(formatDisplayFallbackReason(fr, { fallbackReason: value }))
      .toBe(frDevices.zone.water.source.fallback_generic);
  });

  it.each([
    'Using last synced OSI Server values.',
    'Using local fallback because the OSI Server bundle is unavailable.',
  ])('does not reclassify explicitly unrecognized prose: %s', (reason) => {
    expect(formatDisplayFallbackReason(fr, { fallbackReasonCode: null, fallbackReason: reason }))
      .toBe(frDevices.zone.water.source.fallback_generic);
    expect(formatDisplayFallbackReason(fr, { fallbackReasonCode: undefined, fallbackReason: reason }))
      .not.toBe(frDevices.zone.water.source.fallback_generic);
  });

  it('prefers an explicit code over the legacy sentence reading', () => {
    // A newer gateway that says bundle_unavailable while its prose is a
    // sentence the legacy table maps elsewhere: the code wins.
    const out = formatDisplayFallbackReason(fr, { fallbackReasonCode: 'bundle_unavailable', fallbackReason: 'Using last synced OSI Server values.' });
    expect(out).toBe(frDevices.zone.water.source.bundle_unavailable);
  });
});
