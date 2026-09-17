import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IrrigationOutcomesPanel } from '../IrrigationOutcomesPanel';
import type { IrrigationActuation, IrrigationActuationsResponse } from '../../../services/api';

/**
 * `formatRelativeTime` built its output from English literals — "0s ago",
 * "5 min ago", "in 3 min", "now" — and never called `t()`, so the Recent
 * irrigations panel printed them on the French dashboard. The relative time
 * belongs to `Intl.RelativeTimeFormat` through `utils/datetime`, which the
 * zone card already uses and which takes the app language explicitly.
 */

const { language } = vi.hoisted(() => ({ language: { current: 'fr' } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; [k: string]: unknown }) => {
      const template = options?.defaultValue ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: language.current },
  }),
}));

function makeActuation(overrides: Partial<IrrigationActuation> = {}): IrrigationActuation {
  return {
    expectationId: 'exp-1',
    deviceEui: '0016C001F1000001',
    deviceName: 'North Valve',
    zoneId: 1,
    zoneName: 'North Block',
    commandId: 'cmd-1',
    commandedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    commandedDurationSeconds: 1800,
    expectedCloseAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
    observedOpenAt: null,
    observedCloseAt: null,
    estimatedGrossLiters: null,
    flowRateLpm: null,
    reconciliationState: 'OBSERVED_RUNNING',
    cancelReason: null,
    trigger: null,
    commandResult: null,
    commandResultDetail: null,
    commandAppliedAt: null,
    status: 'COMPLETED',
    ...overrides,
  };
}

function response(actuations: IrrigationActuation[]): IrrigationActuationsResponse {
  // Five minutes old, so the "updated …" line renders a real distance rather
  // than the zero case both languages spell without a number.
  return { generatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), actuations };
}

afterEach(() => {
  cleanup();
  language.current = 'fr';
});

describe('recent irrigations relative time', () => {
  it('renders no English relative time on a French screen', () => {
    render(<IrrigationOutcomesPanel response={response([makeActuation()])} loading={false} error={null} />);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+s ago/);
    expect(text).not.toMatch(/\d+ min ago/);
    expect(text).not.toMatch(/\bin \d+ min\b/);
    expect(text).not.toMatch(/\bnow\b/);
    // The French form Intl produces for a five-minute-old refresh.
    expect(text).toMatch(/il y a 5 minutes/);
  });

  it('still renders an English relative time in English', () => {
    language.current = 'en';
    render(<IrrigationOutcomesPanel response={response([makeActuation()])} loading={false} error={null} />);

    expect(document.body.textContent ?? '').toMatch(/5 minutes ago/);
  });
});
