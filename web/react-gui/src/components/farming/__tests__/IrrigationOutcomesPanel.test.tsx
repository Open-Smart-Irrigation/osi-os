import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IrrigationOutcomesPanel } from '../IrrigationOutcomesPanel';
import type { IrrigationActuation, IrrigationActuationsResponse } from '../../../services/api';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'trigger.manual': 'Manual',
    'trigger.on_valve_schedule': 'Scheduled (on valve)',
  };
  return {
    translateForTest: (key: string, options?: { defaultValue?: string; [k: string]: unknown }): string => {
      const template = table[key] ?? options?.defaultValue ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest, i18n: { language: 'en' } }),
}));

function makeActuation(overrides: Partial<IrrigationActuation> = {}): IrrigationActuation {
  return {
    expectationId: 'exp-1',
    deviceEui: '0016C001F1000001',
    deviceName: 'North Valve',
    zoneId: 1,
    zoneName: 'North Block',
    commandId: 'cmd-1',
    commandedAt: '2026-08-20T06:00:00Z',
    commandedDurationSeconds: 1800,
    expectedCloseAt: '2026-08-20T06:30:00Z',
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
  return { generatedAt: '2026-08-20T06:31:00Z', actuations };
}

describe('IrrigationOutcomesPanel compact row', () => {
  it('shows the device/valve name alongside the zone name', () => {
    render(<IrrigationOutcomesPanel response={response([makeActuation()])} loading={false} error={null} />);
    const row = screen.getByText('North Block').closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('North Valve')).toBeInTheDocument();
  });

  it('shows the trigger chip when the actuation has a trigger', () => {
    render(
      <IrrigationOutcomesPanel
        response={response([makeActuation({ trigger: 'on_valve_schedule' })])}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('Scheduled (on valve)')).toBeInTheDocument();
  });

  it('renders no trigger chip when the actuation has no trigger', () => {
    render(<IrrigationOutcomesPanel response={response([makeActuation({ trigger: null })])} loading={false} error={null} />);
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduled (on valve)')).not.toBeInTheDocument();
  });

  it('visibly labels a pending (not-yet-completed) actuation instead of omitting it or showing it as complete', () => {
    render(
      <IrrigationOutcomesPanel
        response={response([makeActuation({ status: 'PENDING_OPEN', trigger: 'manual' })])}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('Pending open')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });
});
