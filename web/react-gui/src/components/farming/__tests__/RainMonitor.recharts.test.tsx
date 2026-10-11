// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import enDevices from '../../../../public/locales/en/devices.json';
import { sensorAPI } from '../../../services/api';
import type { RainHistory } from '../../../utils/rain';
import { A19_HISTORY } from '../../../analysis/__tests__/fixtures/rainAcceptance';
import { RainMonitor } from '../RainMonitor';

vi.mock('../../../services/api', () => ({
  sensorAPI: {
    getHistory: vi.fn(),
    getDailyRainHistory: vi.fn(),
  },
}));

vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  return {
    ...recharts,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.isValidElement(children)
        ? React.cloneElement(
            children as React.ReactElement<{ width?: number; height?: number }>,
            { width: 640, height: 260 },
          )
        : children,
  };
});

function i18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', defaultNS: 'devices', ns: ['devices'],
    resources: { en: { devices: enDevices } },
    interpolation: { escapeValue: false }, react: { useSuspense: false }, initImmediate: false,
  });
  return instance;
}

async function renderDailyHistory(history: RainHistory) {
  vi.mocked(sensorAPI.getHistory).mockResolvedValue([]);
  vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(history);
  render(
    <I18nextProvider i18n={i18n()}>
      <RainMonitor deveui="A840410000000001" deviceName="Gauge" onClose={vi.fn()} />
    </I18nextProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '7 d' }));
  await screen.findByText('Daily rainfall (mm)');
}

function hoverDay(tickLabel: string) {
  const chart = document.querySelector('.recharts-wrapper');
  const svg = chart?.querySelector('svg');
  if (!svg) throw new Error('Rain chart SVG was not rendered');
  const tick = Array.from(svg.querySelectorAll('.recharts-cartesian-axis-tick-value'))
    .find((element) => element.textContent === tickLabel);
  const x = Number(tick?.getAttribute('x'));
  if (!tick || !Number.isFinite(x)) throw new Error(`Missing chart tick: ${tickLabel}`);
  fireEvent.mouseMove(svg, { clientX: x, clientY: 120 });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RainMonitor visible daily quality tooltip', () => {
  it('shows the received-only quality on an empty A19 day without making it look measured dry', async () => {
    await renderDailyHistory(A19_HISTORY);
    hoverDay('Oct 22');

    expect(await screen.findByText('no data')).toBeInTheDocument();
    expect(screen.getByText('Quality: received only')).toBeInTheDocument();
  });

  it.each([
    ['Oct 23', '0.5 mm', 'Quality: received only'],
    ['Oct 24', '1.0 mm', 'Quality: partial'],
    ['Oct 25', '0.0 mm', 'Quality: complete'],
  ])('shows the API quality for the A19 measured day %s', async (day, amount, quality) => {
    await renderDailyHistory(A19_HISTORY);
    hoverDay(day);

    expect((await screen.findAllByText(amount)).length).toBeGreaterThan(0);
    expect(screen.getByText(quality)).toBeInTheDocument();
  });

  it('labels a current complete-so-far day and an unknown-quality no-data day explicitly', async () => {
    await renderDailyHistory({
      timezone: 'Europe/Zurich', timezoneBasis: 'zone',
      periodStart: '2026-10-25T23:00:00.000Z', periodEnd: '2026-10-27T12:00:00.000Z',
      days: [
        {
          day: '2026-10-26', period_start: '2026-10-25T23:00:00.000Z', period_end: '2026-10-26T23:00:00.000Z',
          total_mm: null, samples: 0, quality: 'unknown', reasons: [], so_far: false,
        },
        {
          day: '2026-10-27', period_start: '2026-10-26T23:00:00.000Z', period_end: '2026-10-27T12:00:00.000Z',
          total_mm: 0.4, samples: 1, quality: 'complete_so_far', reasons: ['ongoing'], so_far: true,
        },
      ],
    });

    hoverDay('Oct 26');
    expect(await screen.findByText('no data')).toBeInTheDocument();
    expect(screen.getByText('Quality: coverage unknown')).toBeInTheDocument();

    hoverDay('Oct 27');
    expect(await screen.findByText('0.4 mm · so far')).toBeInTheDocument();
    expect(screen.getByText('Quality: complete so far')).toBeInTheDocument();
  });
});
