import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import enDevices from '../../../../public/locales/en/devices.json';
import type { Device } from '../../../types/farming';
import { RainTodayLine, RainTodayTile } from '../shared/RainTodayTile';

/**
 * The "rain today" value is the gateway's `rain_mm_today` dated with `rain_day` in the farm
 * timezone. A previous day's total is never labelled today: after the farm's midnight the tile
 * shows "—" and keeps the dated last report visible.
 */

function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices'],
    resources: { en: { devices: enDevices } },
    interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false,
  });
  return instance;
}

type LatestData = NonNullable<Device['latest_data']>;
const zurich = (overrides: Partial<LatestData> = {}): LatestData => ({
  rain_mm_today: 8,
  rain_day: '2026-10-08',
  rain_day_timezone: 'Europe/Zurich',
  rain_day_timezone_basis: 'zone',
  ...overrides,
});

function renderTile(data: Device['latest_data'], onOpenHistory = vi.fn()) {
  return render(
    <I18nextProvider i18n={i18n()}><RainTodayTile data={data} onOpenHistory={onOpenHistory} /></I18nextProvider>,
  );
}

const fakeClock = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(iso));
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RainTodayTile', () => {
  it('shows the value and "so far" when the latest value is from the farm\'s today', () => {
    fakeClock('2026-10-09T07:00:00Z'); // 09:00 in Zurich
    renderTile(zurich({ rain_mm_today: 2.5, rain_day: '2026-10-09' }));

    expect(screen.getByText('Rain recorded today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2.5 mm' })).toBeInTheDocument();
    expect(screen.getByText('so far')).toBeInTheDocument();
  });

  it('a previous day is never today: "—" plus the dated last report', () => {
    fakeClock('2026-10-09T06:00:00Z');
    renderTile(zurich());

    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '8.0 mm' })).not.toBeInTheDocument();
    expect(screen.getByText('Last report Oct 8: 8.0 mm')).toBeInTheDocument();
  });

  it('re-evaluates at farm midnight with fake timers', () => {
    fakeClock('2026-10-08T21:59:00Z'); // 23:59 CEST
    renderTile(zurich({ rain_mm_today: 3.4 }));
    expect(screen.getByRole('button', { name: '3.4 mm' })).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(61_000); });

    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
    expect(screen.getByText('Last report Oct 8: 3.4 mm')).toBeInTheDocument();
  });

  it('uses the farm timezone, not the browser: 22:30Z is already the next day in Zurich', () => {
    fakeClock('2026-07-01T22:30:00Z');
    renderTile(zurich({ rain_mm_today: 1.2, rain_day: '2026-07-01' }));

    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
    expect(screen.getByText('Last report Jul 1: 1.2 mm')).toBeInTheDocument();
  });

  it('unassigned device shows dated value and names UTC', () => {
    fakeClock('2026-10-09T06:00:00Z');
    renderTile({ rain_mm_today: 1.5, rain_day: '2026-10-08', rain_day_timezone: 'UTC', rain_day_timezone_basis: 'unassigned_default' });

    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
    expect(screen.getByText('Last report Oct 8: 1.5 mm (UTC)')).toBeInTheDocument();
  });

  it('a value without a farm day (older gateway response) is unavailable, not today', () => {
    fakeClock('2026-10-09T06:00:00Z');
    renderTile({ rain_mm_today: 4 });

    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
    expect(screen.queryByText('so far')).not.toBeInTheDocument();
  });

  it('opens the history from the value', () => {
    const onOpenHistory = vi.fn();
    renderTile(zurich(), onOpenHistory);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });
});

describe('RainTodayLine', () => {
  it('dates a previous day in the compact line and switches at farm midnight', () => {
    fakeClock('2026-10-08T21:59:00Z');
    render(<I18nextProvider i18n={i18n()}><RainTodayLine data={zurich({ rain_mm_today: 3.4 })} /></I18nextProvider>);
    expect(screen.getByText('3.4 mm')).toBeInTheDocument();
    expect(screen.getByText(/Rain recorded today/)).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(61_000); });

    expect(screen.queryByText('3.4 mm')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Last report Oct 8: 3.4 mm')).toBeInTheDocument();
  });
});
