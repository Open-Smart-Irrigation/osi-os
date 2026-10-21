// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enDevices from '../../../../public/locales/en/devices.json';
import frDevices from '../../../../public/locales/fr/devices.json';
import lgDevices from '../../../../public/locales/lg/devices.json';
import { DeviceCardFooter } from '../shared/DeviceCardFooter';
import { ABSOLUTE_LAST_SEEN_AFTER_MINUTES, footerBattery, footerLastSeen, footerRawVoltage } from '../shared/deviceCardFooterModel';
import { formatDateTime } from '../../../utils/datetime';

// The one footer of every device card (owner decision 2026-10-21): battery left, last seen right.

const NOW = Date.parse('2026-10-21T08:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function i18n(lng: 'en' | 'fr' | 'lg' = 'en') {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng, fallbackLng: false, defaultNS: 'devices', ns: ['devices'],
    resources: { en: { devices: enDevices }, fr: { devices: frDevices }, lg: { devices: lgDevices } },
    interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false,
  });
  return instance;
}

function renderFooter(props: Parameters<typeof DeviceCardFooter>[0], lng: 'en' | 'fr' | 'lg' = 'en') {
  return render(<I18nextProvider i18n={i18n(lng)}><DeviceCardFooter {...props} /></I18nextProvider>);
}

const battery = () => screen.getByTestId('device-card-battery');
const lastSeen = () => screen.getByTestId('device-card-last-seen');

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DeviceCardFooter battery', () => {
  it('shows a reported percentage in the normal colour from 20 % up', () => {
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: 20 });
    expect(battery()).toHaveTextContent('Battery 20%');
    expect(battery()).not.toHaveAttribute('data-battery-low');
    expect(battery().className).not.toContain('warn');
  });

  it('turns amber below 20 % and says "Battery low" to assistive technology', () => {
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: 19 });
    expect(battery()).toHaveTextContent('Battery low 19%');
    expect(battery()).toHaveAttribute('data-battery-low', 'true');
    expect(battery()).toHaveClass('text-[var(--warn-text)]', 'font-semibold');
  });

  it('marks a percentage estimated from the LSN50 voltage curve, also for screen readers (R16 M4)', () => {
    renderFooter({ lastSeen: ago(5 * MIN), batteryVoltage: 3.5 });
    expect(battery()).toHaveTextContent('≈ 93%');
    expect(battery()).toHaveAttribute('title', 'Estimated from battery voltage');
    // The hint is in the spoken text, not only in the hover title; "≈" itself is not read out.
    expect(battery()).toHaveTextContent('Battery ≈ 93% Estimated from battery voltage');
    expect(screen.getByText('≈', { exact: false, selector: '[aria-hidden="true"]' })).toBeInTheDocument();
    expect([...battery().querySelectorAll('.sr-only')].map((node) => node.textContent?.trim()))
      .toEqual(['Battery', 'Estimated from battery voltage']);
  });

  it('shows the raw voltage of a cell no curve fits when no percentage exists (R16 M1)', () => {
    // STREGA Gen2 stores bat_pct null and bat_v in volts; the LoRain reports volts only.
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: null, rawBatteryVoltage: 3.52 });
    expect(battery()).toHaveTextContent('Battery 3.52 V');
    expect(battery()).not.toHaveAttribute('data-battery-low');
    expect(battery()).not.toHaveTextContent('%');
    cleanup();
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: null, rawBatteryVoltage: 1.1 });
    // No threshold is known for a raw voltage, so it is never amber.
    expect(battery()).not.toHaveAttribute('data-battery-low');
    expect(battery().className).not.toContain('warn');
  });

  it('prefers a reported percentage, then the LSN50 curve, over the raw voltage', () => {
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: 64, rawBatteryVoltage: 3.52 });
    expect(battery()).toHaveTextContent('64%');
    expect(battery()).not.toHaveTextContent('V');
    cleanup();
    renderFooter({ lastSeen: ago(5 * MIN), batteryVoltage: 3.5, rawBatteryVoltage: 3.5 });
    expect(battery()).toHaveTextContent('≈ 93%');
  });

  it('formats the raw voltage for the interface language and rejects implausible readings', () => {
    renderFooter({ lastSeen: ago(5 * MIN), rawBatteryVoltage: 3.6 }, 'fr');
    expect(battery()).toHaveTextContent('Batterie 3,60 V');
    expect(footerRawVoltage('3.4')).toBe(3.4);
    expect(footerRawVoltage(0)).toBeNull();
    expect(footerRawVoltage(-1)).toBeNull();
    expect(footerRawVoltage(65.5)).toBeNull();
    expect(footerRawVoltage('')).toBeNull();
    expect(footerRawVoltage(null)).toBeNull();
    expect(footerRawVoltage(Number.NaN)).toBeNull();
  });

  it('reads a reported percentage before the voltage curve', () => {
    expect(footerBattery(55, 3.6)).toEqual({ percent: 55, low: false, derived: false });
    expect(footerBattery(null, 2.3)).toEqual({ percent: 13, low: true, derived: true });
    expect(footerBattery(null, null)).toBeNull();
  });

  it('keeps an empty battery slot for a mains-powered or non-reporting device, never 0 %', () => {
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: null, batteryVoltage: undefined });
    expect(battery()).toBeEmptyDOMElement();
    expect(battery()).toHaveClass('min-h-5');
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('formats the percentage for the interface language', () => {
    renderFooter({ lastSeen: ago(5 * MIN), batteryPercent: 85 }, 'fr');
    expect(battery()).toHaveTextContent(/Batterie 85\s%/);
  });
});

describe('DeviceCardFooter last seen', () => {
  it('is relative under six hours', () => {
    renderFooter({ lastSeen: ago(15 * MIN) });
    expect(lastSeen()).toHaveTextContent('Last seen 15 min ago');
    cleanup();
    renderFooter({ lastSeen: ago(6 * HOUR - MIN) });
    expect(lastSeen()).toHaveTextContent('Last seen 5 h ago');
  });

  it('shows the full date and time from six hours on', () => {
    const at = ago(6 * HOUR);
    renderFooter({ lastSeen: at });
    expect(lastSeen()).toHaveTextContent(`Last seen ${formatDateTime(at, 'en')}`);
    // The exact time is always one hover away, also on a relative age.
    expect(lastSeen()).toHaveAttribute('title', formatDateTime(at, 'en'));
  });

  it('puts the six-hour boundary exactly at six hours', () => {
    expect(footerLastSeen(ago(ABSOLUTE_LAST_SEEN_AFTER_MINUTES * MIN - MIN), NOW)).toEqual({ kind: 'hours', count: 5 });
    expect(footerLastSeen(ago(ABSOLUTE_LAST_SEEN_AFTER_MINUTES * MIN), NOW).kind).toBe('absolute');
    expect(footerLastSeen(ago(59 * MIN), NOW)).toEqual({ kind: 'minutes', count: 59 });
    expect(footerLastSeen(ago(60 * MIN), NOW)).toEqual({ kind: 'hours', count: 1 });
    expect(footerLastSeen(ago(30_000), NOW)).toEqual({ kind: 'justNow' });
  });

  it('reads "Never seen" for a missing or broken timestamp and "just now" for a future one', () => {
    expect(footerLastSeen(null, NOW)).toEqual({ kind: 'never' });
    expect(footerLastSeen('not a date', NOW)).toEqual({ kind: 'never' });
    expect(footerLastSeen(new Date(NOW + 10 * MIN).toISOString(), NOW)).toEqual({ kind: 'justNow' });
    renderFooter({ lastSeen: null });
    expect(lastSeen()).toHaveTextContent('Never seen');
  });

  it('formats the date for the interface language (French)', () => {
    const at = ago(2 * 24 * HOUR);
    renderFooter({ lastSeen: at }, 'fr');
    expect(lastSeen()).toHaveTextContent(`Vu le ${formatDateTime(at, 'fr')}`);
    cleanup();
    renderFooter({ lastSeen: ago(3 * HOUR) }, 'fr');
    expect(lastSeen()).toHaveTextContent('Vu il y a 3 h');
  });

  it('keeps the human Luganda minutes and never-seen strings', () => {
    renderFooter({ lastSeen: ago(15 * MIN) }, 'lg');
    expect(lastSeen()).toHaveTextContent("Bwagulibwa omulundi gw'omuliko: 15 edakiika ewedde");
    cleanup();
    renderFooter({ lastSeen: null }, 'lg');
    expect(lastSeen()).toHaveTextContent('Tekalabikangako');
  });

  it('shows the given text instead of a time for a device without last-seen (field tester)', () => {
    renderFooter({ lastSeen: null, lastSeenText: 'Readings on the map' });
    expect(lastSeen()).toHaveTextContent('Readings on the map');
    expect(battery()).toBeEmptyDOMElement();
  });
});
