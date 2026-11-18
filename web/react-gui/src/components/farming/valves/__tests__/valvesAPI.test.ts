import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: axiosMocks.get,
      post: axiosMocks.post,
      put: axiosMocks.put,
      delete: axiosMocks.delete,
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
    isAxiosError: vi.fn((e: any) => !!(e && e.isAxiosError)),
  },
}));

function planConflictError() {
  return {
    isAxiosError: true,
    response: {
      status: 422,
      data: {
        error: 'plan_conflict',
        details: [{ code: 'overlap', weekday: 2, conflicts: ['u1', 'u2'], labels: ['A', 'B'] }],
      },
    },
  };
}

const EUI = '0016C001F1000001';

describe('valvesAPI plan-conflict routing', () => {
  beforeEach(() => {
    axiosMocks.get.mockReset();
    axiosMocks.post.mockReset();
    axiosMocks.put.mockReset();
    axiosMocks.delete.mockReset();
  });

  it('deleteSchedule surfaces a 422 plan_conflict as ValvePlanConflictError with labels intact', async () => {
    axiosMocks.delete.mockRejectedValue(planConflictError());
    const { valvesAPI, ValvePlanConflictError } = await import('../../../../services/api');

    let caught: unknown;
    try {
      await valvesAPI.deleteSchedule(EUI, 'u1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValvePlanConflictError);
    expect((caught as InstanceType<typeof ValvePlanConflictError>).details).toEqual([
      { code: 'overlap', weekday: 2, conflicts: ['u1', 'u2'], labels: ['A', 'B'] },
    ]);
  });

  it('resendPlan surfaces a 422 plan_conflict as ValvePlanConflictError with labels intact', async () => {
    axiosMocks.post.mockRejectedValue(planConflictError());
    const { valvesAPI, ValvePlanConflictError } = await import('../../../../services/api');

    let caught: unknown;
    try {
      await valvesAPI.resendPlan(EUI);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValvePlanConflictError);
    expect((caught as InstanceType<typeof ValvePlanConflictError>).details).toEqual([
      { code: 'overlap', weekday: 2, conflicts: ['u1', 'u2'], labels: ['A', 'B'] },
    ]);
  });
});

describe('normaliseValveSummary defensive actuation handling', () => {
  beforeEach(() => {
    axiosMocks.get.mockReset();
  });

  it('maps push_state lost / scheduler_status_lost, defaulting both when an older gateway omits them (CMD-04 PR0)', async () => {
    axiosMocks.get.mockResolvedValue({
      data: {
        valves: [
          { device_eui: 'valve-with-loss', name: 'V1', push_state: { queued: 1, acked: 0, failed: 6, lost: 6, scheduler_status_lost: true } },
          { device_eui: 'valve-older-gateway', name: 'V2', push_state: { queued: 0, acked: 7, failed: 0 } },
        ],
      },
    });
    const { valvesAPI } = await import('../../../../services/api');

    const [withLoss, older] = await valvesAPI.list();
    expect(withLoss.pushState.lost).toBe(6);
    expect(withLoss.pushState.schedulerStatusLost).toBe(true);
    expect(older.pushState.lost).toBe(0);
    expect(older.pushState.schedulerStatusLost).toBe(false);
  });

  it('drops an active_actuation missing expected_close_at to null (would otherwise NaN in valveState)', async () => {
    axiosMocks.get.mockResolvedValue({
      data: {
        valves: [{
          device_eui: '0016c001f1000001',
          name: 'V1',
          active_actuation: {
            expectation_id: 'e1',
            reconciliation_state: 'OBSERVED_RUNNING',
            commanded_at: '2026-08-19T09:50:00Z',
            // expected_close_at intentionally missing
            duration_seconds: 1800,
            trigger: 'manual',
          },
          push_state: {},
        }],
      },
    });
    const { valvesAPI } = await import('../../../../services/api');

    const [summary] = await valvesAPI.list();
    expect(summary.activeActuation).toBeNull();
  });

  it('drops an active_actuation missing commanded_at to null', async () => {
    axiosMocks.get.mockResolvedValue({
      data: {
        valves: [{
          device_eui: '0016c001f1000001',
          name: 'V1',
          active_actuation: {
            expectation_id: 'e1',
            reconciliation_state: 'OBSERVED_RUNNING',
            // commanded_at intentionally missing
            expected_close_at: '2026-08-19T10:22:00Z',
            duration_seconds: 1800,
            trigger: 'manual',
          },
          push_state: {},
        }],
      },
    });
    const { valvesAPI } = await import('../../../../services/api');

    const [summary] = await valvesAPI.list();
    expect(summary.activeActuation).toBeNull();
  });

  it('keeps a fully-timestamped active_actuation', async () => {
    axiosMocks.get.mockResolvedValue({
      data: {
        valves: [{
          device_eui: '0016c001f1000001',
          name: 'V1',
          active_actuation: {
            expectation_id: 'e1',
            reconciliation_state: 'OBSERVED_RUNNING',
            commanded_at: '2026-08-19T09:50:00Z',
            expected_close_at: '2026-08-19T10:22:00Z',
            duration_seconds: 1800,
            trigger: 'manual',
          },
          push_state: {},
        }],
      },
    });
    const { valvesAPI } = await import('../../../../services/api');

    const [summary] = await valvesAPI.list();
    expect(summary.activeActuation).toEqual({
      expectationId: 'e1',
      reconciliationState: 'OBSERVED_RUNNING',
      commandedAt: '2026-08-19T09:50:00Z',
      expectedCloseAt: '2026-08-19T10:22:00Z',
      durationSeconds: 1800,
      trigger: 'manual',
    });
  });
});

describe('normaliseValveSummary enclosure climate mapping', () => {
  beforeEach(() => {
    axiosMocks.get.mockReset();
  });

  it('passes a measured zero through as 0, not null', async () => {
    axiosMocks.get.mockResolvedValue({
      data: {
        valves: [{
          device_eui: '0016c001f1000001',
          name: 'V1',
          enclosure_temperature_c: 0,
          enclosure_humidity_pct: 0,
          enclosure_measured_at: '2026-08-20T10:00:00.000Z',
          push_state: {},
        }],
      },
    });
    const { valvesAPI } = await import('../../../../services/api');

    const [summary] = await valvesAPI.list();
    expect(summary.enclosureTemperatureC).toBe(0);
    expect(summary.enclosureHumidityPct).toBe(0);
    expect(summary.enclosureMeasuredAt).toBe('2026-08-20T10:00:00.000Z');
  });

  it('maps a missing enclosure reading to null, not undefined', async () => {
    axiosMocks.get.mockResolvedValue({
      data: {
        valves: [{
          device_eui: '0016c001f1000001',
          name: 'V1',
          push_state: {},
        }],
      },
    });
    const { valvesAPI } = await import('../../../../services/api');

    const [summary] = await valvesAPI.list();
    expect(summary.enclosureTemperatureC).toBeNull();
    expect(summary.enclosureHumidityPct).toBeNull();
    expect(summary.enclosureMeasuredAt).toBeNull();
  });
});

// W29: Resume on a conditional valve whose clear is not confirmed is refused by the gateway (409
// conditional_readiness_pending). The API layer tags it so the panel can explain it.
describe('valvesAPI setSchedulerStatus refusal', () => {
  beforeEach(() => { axiosMocks.post.mockReset(); });

  it('tags a 409 conditional_readiness_pending refusal with its code', async () => {
    axiosMocks.post.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { error: 'conditional_readiness_pending' } } });
    const { valvesAPI } = await import('../../../../services/api');
    await expect(valvesAPI.setSchedulerStatus(EUI, 'ACTIVE')).rejects.toMatchObject({ code: 'conditional_readiness_pending' });
  });

  it('passes any other failure through unchanged', async () => {
    const other = { isAxiosError: true, response: { status: 500, data: { error: 'internal_error' } } };
    axiosMocks.post.mockRejectedValue(other);
    const { valvesAPI } = await import('../../../../services/api');
    await expect(valvesAPI.setSchedulerStatus(EUI, 'DEACTIVATED')).rejects.toBe(other);
  });
});


describe('one-time confirmation fields', () => {
  it('maps snake_case and camelCase deadlines and outcomes, with null on older gateways', async () => {
    axiosMocks.get.mockResolvedValue({ data: { schedules: [
      { schedule_uuid: 'waiting', device_eui: 'a840410000000001', kind: 'ONCE', awaiting_confirmation_until: '2026-08-19T10:38:00Z', once_outcome: null },
      { scheduleUuid: 'uncertain', deviceEui: 'A840410000000001', kind: 'ONCE', awaitingConfirmationUntil: null, onceOutcome: 'uncertain' },
      { schedule_uuid: 'old', device_eui: 'A840410000000001', kind: 'ONCE' },
    ] } });
    const { valvesAPI } = await import('../../../../services/api');
    const { schedules } = await valvesAPI.schedules('A840410000000001');
    expect(schedules[0].awaitingConfirmationUntil).toBe('2026-08-19T10:38:00Z');
    expect(schedules[0].deviceEui).toBe('A840410000000001');
    expect(schedules[1].onceOutcome).toBe('uncertain');
    expect(schedules[2].awaitingConfirmationUntil).toBeNull();
    expect(schedules[2].onceOutcome).toBeNull();
  });
});


describe('unzoned one-time uncertainty', () => {
  it('S4: maps a skipped attempt without an irrigation event to the GUI warning outcome', async () => {
    axiosMocks.get.mockResolvedValue({ data: { schedules: [{
      schedule_uuid: 'uncertain-without-zone', device_eui: 'A840410000000001', kind: 'ONCE',
      once_state: 'SKIPPED', dispatch_state: 'SKIPPED', dispatch_attempted_at: '2026-08-19T10:03:00Z',
      awaiting_confirmation_until: null, once_outcome: 'uncertain',
    }] } });
    const { valvesAPI } = await import('../../../../services/api');
    const { schedules: [row] } = await valvesAPI.schedules('A840410000000001');
    expect(row.onceState).toBe('SKIPPED');
    expect(row.onceOutcome).toBe('uncertain');
    expect(row.awaitingConfirmationUntil).toBeNull();
  });
});
