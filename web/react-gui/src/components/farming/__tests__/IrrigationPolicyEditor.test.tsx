import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IrrigationPolicyEditor } from '../IrrigationPolicyEditor';
import { irrigationPolicyAPI, systemSettingsAPI } from '../../../services/api';
import type { IrrigationPolicyView } from '../../../types/farming';
import { normalisePolicyView } from '../../../utils/irrigationPolicy';

vi.mock('../../../services/api', () => ({
  irrigationPolicyAPI: {
    get: vi.fn(),
    save: vi.fn(),
    pause: vi.fn(),
    retryValve: vi.fn(),
  },
  systemSettingsAPI: { get: vi.fn() },
}));

const view = (): IrrigationPolicyView => ({
  zone: { id: 7, zoneUuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
  policy: null,
  schedules: [],
  pending: { policyEdit: null, actions: [] },
  runtime: {
    availability: 'fresh',
    eligibleSources: [
      { kind: 'VWC', deviceEui: 'AA11', channel: 'vwc_1', eligible: true, name: 'Probe', depthCm: 20 },
    ],
    sourceChoices: {
      SWT: [],
      VWC: [{ kind: 'VWC', deviceEui: 'AA11', channel: 'vwc_1', eligible: true, name: 'Probe', depthCm: 20 }],
      DENDRO: [],
    },
    valves: [{ deviceEui: 'BB22', update: { state: 'READY', ready: true, reason: null } }],
    clock: { trusted: true, reason: null },
    nextCheck: null,
    legacyProcessTimezone: 'UTC',
    // R17-M1: most tests here exercise VWC, so the fixture gateway has the VWC gate on.
    vwcConditionEnabled: true,
  },
});

const zone = {
  id: 7,
  name: 'North',
  device_count: 2,
  created_at: '',
  updated_at: '',
  schedule: null,
  zone_uuid: 'zone-1',
  timezone: 'Europe/Zurich',
};

const devices = [
  { deveui: 'AA11', name: 'Probe', type_id: 'DRAGINO_SDI12', latest_data: {} },
  { deveui: 'BB22', name: 'Valve', type_id: 'STREGA_VALVE', latest_data: {} },
] as any[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(irrigationPolicyAPI.get).mockResolvedValue(view());
  vi.mocked(irrigationPolicyAPI.save).mockResolvedValue(view());
  vi.mocked(irrigationPolicyAPI.pause).mockResolvedValue({ status: 200, policy: null, cancellations: [], activeExpectations: [] });
  vi.mocked(irrigationPolicyAPI.retryValve).mockResolvedValue({ status: 202, deviceEui: 'BB22', result: { revision: { revision_id: 'r1' } } });
});

describe('IrrigationPolicyEditor', () => {
  it('keeps VWC blank until entered and saves a measured zero with an explicit source and valve', async () => {
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /VWC/i }));
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/VWC threshold/i), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/VWC source/i), { target: { value: 'AA11:vwc_1' } });
    fireEvent.click(screen.getByLabelText(/Valve/i));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      condition: { kind: 'VWC', threshold: 0, sources: [{ deviceEui: 'AA11', channel: 'vwc_1' }] },
    })));
  });

  it('shows the source and valve as unavailable instead of replacing a selected reference', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 29.9, sources: [{ deviceEui: 'CC33', channel: 'swt_3' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'DD44', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);

    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByText(/CC33.*swt_3.*unavailable/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('29.9')).toBeInTheDocument();
    expect(screen.getByText(/DD44.*unavailable/i)).toBeInTheDocument();
  });

  it('offers an explicit retry for a failed valve update', async () => {
    const failed = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
      policy: null,
      eligible_sources: [],
      source_choices: { SWT: [], VWC: [], DENDRO: [] },
      schedules: [],
      valves: [{
        device_eui: 'BB22',
        control: { incident: { incident_id: 'incident-1', state: 'OPEN', retry_pending: false } },
        readiness: { state: 'PENDING', ready: false, reason: 'awaiting_clear_ack' },
      }],
      next_check: null,
      last_result: null,
      qualification: null,
      legacy_process_timezone: null,
    });
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(failed);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByText(/Update: PENDING/i)).toBeInTheDocument();
    expect(screen.getByText(/Incident: OPEN/i)).toBeInTheDocument();
    expect(screen.queryByText(/Valve clock/i)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /retry update/i }));
    await waitFor(() => expect(irrigationPolicyAPI.retryValve).toHaveBeenCalledWith('zone-1', 'BB22'));
  });

  it('converts the attached conditional rows to Always through the policy save action', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 10, startTime: '07:15', durationMinutes: 37, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    const onClose = vi.fn();
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    vi.mocked(irrigationPolicyAPI.save).mockResolvedValueOnce({ ...existing, httpStatus: 202 });
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /convert to always/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      enabled: false,
      schedules: [expect.objectContaining({ scheduleUuid: 'schedule-1', execution: 'always', expectedSyncVersion: 2 })],
    })));
    const schedulePatch = (vi.mocked(irrigationPolicyAPI.save).mock.calls[0]?.[1] as { schedules: Array<Record<string, unknown>> }).schedules[0];
    expect(schedulePatch).not.toHaveProperty('weekdaysMask');
    expect(schedulePatch).not.toHaveProperty('startTime');
    expect(schedulePatch).not.toHaveProperty('durationMinutes');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('serializes every conditional row for a valve with its own identity and calendar facts', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [
      { scheduleUuid: 'schedule-mon', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 10, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
      { scheduleUuid: 'schedule-wed', syncVersion: 5, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 8, startTime: '07:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
    ];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Valve schedule-mon Duration/i), { target: { value: '11' } });
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalled());
    const calls = vi.mocked(irrigationPolicyAPI.save).mock.calls;
    const payload = calls[calls.length - 1]?.[1] as unknown as { schedules: Array<Record<string, unknown>> };
    expect(payload.schedules).toEqual([
      expect.objectContaining({ scheduleUuid: 'schedule-mon', expectedSyncVersion: 2, durationMinutes: 11 }),
    ]);
  });

  it('includes every attached row identity and start time when the policy timezone changes', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [
      { scheduleUuid: 'schedule-morning', syncVersion: 12, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:15', durationMinutes: 10, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
      { scheduleUuid: 'schedule-evening', syncVersion: 19, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 8, startTime: '18:40', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
    ];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    await screen.findByLabelText(/Valve schedule-morning Start time/i);
    fireEvent.change(screen.getByLabelText(/Policy timezone/i), { target: { value: 'Africa/Kampala' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalled());
    const payload = vi.mocked(irrigationPolicyAPI.save).mock.calls[0]?.[1] as unknown as { timezone: string; schedules: Array<Record<string, unknown>> };
    expect(payload.timezone).toBe('Africa/Kampala');
    expect(payload.schedules).toEqual([
      { scheduleUuid: 'schedule-morning', expectedSyncVersion: 12, startTime: '06:15' },
      { scheduleUuid: 'schedule-evening', expectedSyncVersion: 19, startTime: '18:40' },
    ]);
  });

  it('keeps distinct all-day row times in row mode and omits unchanged rows on a no-op save', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [
      { scheduleUuid: 'schedule-morning', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 10, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
      { scheduleUuid: 'schedule-evening', syncVersion: 5, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '18:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
    ];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByLabelText(/Selected days/i)).toBeChecked();
    expect(screen.getByLabelText(/Valve schedule-morning Start time/i)).toHaveValue('06:00');
    expect(screen.getByLabelText(/Valve schedule-evening Start time/i)).toHaveValue('18:00');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalled());
    expect((vi.mocked(irrigationPolicyAPI.save).mock.calls[0]?.[1] as Record<string, unknown>).schedules).toBeUndefined();
  });

  it('sends a policy-only threshold edit without unrelated schedule rows', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [
      { scheduleUuid: 'schedule-mon', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 10, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
      { scheduleUuid: 'schedule-wed', syncVersion: 5, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 8, startTime: '07:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
    ];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Dry/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalled());
    const payload = vi.mocked(irrigationPolicyAPI.save).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.condition).toEqual(expect.objectContaining({ kind: 'SWT', threshold: 50 }));
    expect(payload.schedules).toBeUndefined();
  });

  it('disables save for non-integer or out-of-range durations', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    const save = await screen.findByRole('button', { name: /save/i });
    const duration = screen.getByLabelText(/Valve schedule-1 Duration/i);
    fireEvent.change(duration, { target: { value: '241' } });
    expect(save).toBeDisabled();
    fireEvent.change(duration, { target: { value: '20.5' } });
    expect(save).toBeDisabled();
    expect(irrigationPolicyAPI.save).not.toHaveBeenCalled();
  });

  it('adopts materialized policy and schedule identities before the next create edit', async () => {
    const created = view();
    created.policy = {
      policyUuid: 'policy-created', zoneUuid: 'zone-1',
      condition: { kind: 'VWC', thresholdPercent: 0, sources: [{ deviceEui: 'AA11', channel: 'vwc_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 7,
    };
    created.schedules = [{ scheduleUuid: 'schedule-created', syncVersion: 11, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-created' }];
    vi.mocked(irrigationPolicyAPI.save).mockResolvedValueOnce(created).mockResolvedValueOnce(created);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} initialDeviceEui="BB22" />);

    fireEvent.click(await screen.findByRole('button', { name: /^VWC$/i }));
    fireEvent.change(screen.getByLabelText(/VWC threshold/i), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/VWC source/i), { target: { value: 'AA11:vwc_1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/schedule-created Duration/i), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledTimes(2));
    const secondDraft = vi.mocked(irrigationPolicyAPI.save).mock.calls[1]?.[1] as unknown as { policyUuid: string; expectedPolicyVersion: number; schedules: Array<Record<string, unknown>> };
    expect(secondDraft).toEqual(expect.objectContaining({ policyUuid: 'policy-created', expectedPolicyVersion: 7 }));
    expect(secondDraft.schedules).toEqual([expect.objectContaining({ scheduleUuid: 'schedule-created', expectedSyncVersion: 11 })]);
  });

  it('adopts materialized policy and schedule versions before the next edit save', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    const materialized = { ...existing, policy: { ...existing.policy, syncVersion: 8 }, schedules: [{ ...existing.schedules[0], syncVersion: 9 }] };
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    vi.mocked(irrigationPolicyAPI.save).mockResolvedValueOnce(materialized).mockResolvedValueOnce(materialized);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/schedule-1 Duration/i), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledTimes(2));
    const secondDraft = vi.mocked(irrigationPolicyAPI.save).mock.calls[1]?.[1] as unknown as { expectedPolicyVersion: number; schedules: Array<Record<string, unknown>> };
    expect(secondDraft.expectedPolicyVersion).toBe(8);
    expect(secondDraft.schedules).toEqual([expect.objectContaining({ scheduleUuid: 'schedule-1', expectedSyncVersion: 9 })]);
  });

  it('keeps every-day and selected-day timing drafts independent through a mode round trip', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [
      { scheduleUuid: 'schedule-mon', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 10, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
      { scheduleUuid: 'schedule-wed', syncVersion: 5, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 8, startTime: '07:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' },
    ];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByLabelText(/Every day/i));
    fireEvent.change(screen.getByLabelText(/Start time/i), { target: { value: '09:00' } });
    fireEvent.click(screen.getByLabelText(/Selected days/i));
    expect(screen.getByLabelText(/Valve schedule-mon Start time/i)).toHaveValue('06:00');
    expect(screen.getByLabelText(/Valve schedule-wed Start time/i)).toHaveValue('07:00');
    expect(screen.getByLabelText(/Valve schedule-mon Mon/i)).toBeChecked();
    expect(screen.getByLabelText(/Valve schedule-mon Sun/i)).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalled());
    expect((vi.mocked(irrigationPolicyAPI.save).mock.calls[0]?.[1] as Record<string, unknown>).schedules).toBeUndefined();
  });

  it('refetches the canonical rows after a real pause action envelope before the next edit', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    const paused = { ...existing, policy: { ...existing.policy, enabled: false, syncVersion: 5 } };
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing).mockResolvedValueOnce(paused);
    vi.mocked(irrigationPolicyAPI.pause).mockResolvedValueOnce({ status: 202, policy: { policy_uuid: 'policy-1', sync_version: 5, enabled: false }, cancellations: [{ device_eui: 'BB22', pending: true }], activeExpectations: [] });
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^Pause$/i }));
    await waitFor(() => expect(irrigationPolicyAPI.get).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(/Enabled/i)).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/schedule-1 Duration/i), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      policyUuid: 'policy-1', expectedPolicyVersion: 5, enabled: false,
      schedules: [expect.objectContaining({ scheduleUuid: 'schedule-1', expectedSyncVersion: 2 })],
    })));
  });

  it('keeps a committed pause successful when the canonical refresh is unavailable', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing).mockRejectedValueOnce(new Error('refresh unavailable'));
    vi.mocked(irrigationPolicyAPI.pause).mockResolvedValueOnce({ status: 200, policy: { policy_uuid: 'policy-1', sync_version: 5, enabled: false }, cancellations: [], activeExpectations: [] });
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^Pause$/i }));
    await waitFor(() => expect(screen.getByText(/Action completed, but the current policy state could not be refreshed/i)).toBeInTheDocument());
    expect(screen.queryByText(/Action failed/i)).not.toBeInTheDocument();
  });

  it('refetches canonical rows after a real retry action envelope before the next edit', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    existing.runtime.valves = [{ deviceEui: 'BB22', update: { state: 'FAILED', ready: false, reason: 'flush_failed' } }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing).mockResolvedValueOnce(existing);
    vi.mocked(irrigationPolicyAPI.retryValve).mockResolvedValueOnce({ status: 202, deviceEui: 'BB22', result: { revision: { revision_id: 'retry-1' } } });
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /retry update/i }));
    await waitFor(() => expect(irrigationPolicyAPI.get).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText(/schedule-1 Duration/i), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      expectedPolicyVersion: 4,
      schedules: [expect.objectContaining({ scheduleUuid: 'schedule-1', expectedSyncVersion: 2 })],
    })));
  });

  it('keeps a committed retry successful when the canonical refresh is unavailable', async () => {
    const failed = view();
    failed.runtime.valves = [{ deviceEui: 'BB22', update: { state: 'FAILED', ready: false, reason: 'flush_failed' }, incident: null }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(failed).mockRejectedValueOnce(new Error('refresh unavailable'));
    vi.mocked(irrigationPolicyAPI.retryValve).mockResolvedValueOnce({ status: 202, deviceEui: 'BB22', result: { revision: { revision_id: 'retry-2' } } });
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /retry update/i }));
    await waitFor(() => expect(screen.getByText(/Action completed, but the current policy state could not be refreshed/i)).toBeInTheDocument());
    expect(screen.queryByText(/Action failed/i)).not.toBeInTheDocument();
  });

  it('shows pending edit and action state beside the canonical form baseline', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'AA11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    existing.pending = {
      policyEdit: { state: 'PENDING', enabled: false, condition: { kind: 'SWT', threshold_kpa: 50 } },
      actions: [{ state: 'QUEUED', action: 'retry' }],
    };
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByDisplayValue('30')).toBeInTheDocument();
    expect(screen.getByText(/Pending policy edit: PENDING/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending actions: QUEUED/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('50')).not.toBeInTheDocument();
  });

  it('adds and removes one source without discarding another selected source', async () => {
    const existing = view();
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'VWC', thresholdPercent: 0, sources: [{ deviceEui: 'AA11', channel: 'vwc_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    existing.runtime.sourceChoices.VWC.push({ kind: 'VWC', deviceEui: 'CC33', channel: 'vwc_2', eligible: true, name: 'Second probe', depthCm: 30 });
    existing.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^VWC$/i }));
    fireEvent.change(screen.getByLabelText(/VWC source/i), { target: { value: 'CC33:vwc_2' } });
    expect(screen.getByText(/Second probe/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove source vwc_1/i }));
    expect(screen.queryByRole('button', { name: /Remove source vwc_1/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(irrigationPolicyAPI.save).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      condition: { kind: 'VWC', threshold: 0, sources: [{ deviceEui: 'CC33', channel: 'vwc_2' }] },
    })));
  });

  it('does not present stale qualification or a legacy preview as actionable runtime evidence', async () => {
    const stale = view();
    stale.runtime.availability = 'stale';
    stale.runtime.qualification = { qualified: true, reason: 'old' };
    stale.runtime.legacyProcessTimezone = 'UTC';
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(stale);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    await screen.findByRole('dialog');
    expect(screen.queryByText(/Qualification: available/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Legacy time preview unavailable/i)).toBeInTheDocument();
  });

  it('does not present stale per-valve update evidence as current', async () => {
    const stale = view();
    stale.runtime.valves = [{
      deviceEui: 'BB22', availability: 'stale',
      update: { state: 'APPLIED', ready: true, reason: 'old_revision' },
      incident: { state: 'RECONCILED', reason: 'old_incident' },
      clock: { trusted: true, reason: 'old_clock' },
    }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(stale);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByText(/Valve runtime: stale/i)).toBeInTheDocument();
    expect(screen.queryByText(/Update: APPLIED/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Incident: RECONCILED/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Valve clock: trusted/i)).not.toBeInTheDocument();
  });

  it('keeps source and runtime reasons in the existing help disclosures', async () => {
    const explained = view();
    explained.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'SWT', thresholdKpa: 30, sources: [{ deviceEui: 'CC33', channel: 'swt_3' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    };
    explained.schedules = [{ scheduleUuid: 'schedule-1', syncVersion: 2, deviceEui: 'BB22', kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 20, enabled: true, execution: 'conditional', conditionPolicyUuid: 'policy-1' }];
    explained.runtime.sourceChoices.SWT = [{ kind: 'SWT', deviceEui: 'CC33', channel: 'swt_3', eligible: false, reason: 'calibration_missing' }];
    explained.runtime.qualification = { qualified: false, reason: 'qualification_unavailable' };
    explained.runtime.valves = [{ deviceEui: 'BB22', availability: 'fresh', update: { state: 'FAILED', ready: false, reason: 'flush_failed' }, incident: null, clock: { trusted: false, reason: 'clock_untrusted' } }];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(explained);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByText('calibration_missing')).toBeInTheDocument();
    expect(screen.getByText('qualification_unavailable')).toBeInTheDocument();
    expect(screen.getByText('flush_failed')).toBeInTheDocument();
    expect(screen.getByText('clock_untrusted')).toBeInTheDocument();
  });

  it('uses an authoritative gateway timezone or blocks save without inventing UTC', async () => {
    const missingTimezone = view();
    missingTimezone.zone.timezone = null;
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(missingTimezone);
    vi.mocked(systemSettingsAPI.get).mockResolvedValueOnce({ gatewayTimezone: '' });
    render(<IrrigationPolicyEditor zone={{ ...zone, timezone: null }} devices={devices} open onClose={vi.fn()} />);

    expect(await screen.findByLabelText(/Policy timezone/i)).toHaveValue('');
    expect(screen.getByText(/Enter a valid IANA timezone before saving/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.queryByText(/UTC/)).not.toBeInTheDocument();
  });

  it('R17-M1: with the edge VWC gate off, VWC is not offered as a condition', async () => {
    const gated = view();
    gated.runtime.vwcConditionEnabled = false;
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(gated);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /^SWT$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^VWC$/i })).not.toBeInTheDocument();
  });

  it('R17-M1: the gate is off when the gateway does not report it (absent = off)', () => {
    const normalised = normalisePolicyView({ zone: { zone_uuid: 'zone-1', name: 'North' }, policy: null, source_choices: { SWT: [], VWC: [], DENDRO: [] }, valves: [] });
    expect(normalised.runtime.vwcConditionEnabled).toBe(false);
    const on = normalisePolicyView({ zone: { zone_uuid: 'zone-1', name: 'North' }, policy: null, vwc_condition_enabled: true, inactive_reason: null, valves: [] });
    expect(on.runtime.vwcConditionEnabled).toBe(true);
  });

  it('R17-M1: an existing VWC policy with the gate off is shown as inactive, not as running', async () => {
    const existing = view();
    existing.runtime.vwcConditionEnabled = false;
    existing.runtime.inactiveReason = 'vwc_condition_disabled';
    existing.policy = {
      policyUuid: 'policy-1', zoneUuid: 'zone-1',
      condition: { kind: 'VWC', thresholdPercent: 22, sources: [{ deviceEui: 'AA11', channel: 'vwc_1' }] },
      timezone: 'Europe/Zurich', enabled: true, observationWindowMinutes: 60,
      minIntervalMinutes: 60, maxDailyMinutes: 240, deliverySettings: {}, syncVersion: 4,
    } as IrrigationPolicyView['policy'];
    vi.mocked(irrigationPolicyAPI.get).mockResolvedValueOnce(existing);
    render(<IrrigationPolicyEditor zone={zone} devices={devices} open onClose={vi.fn()} />);
    expect(await screen.findByText(/VWC conditions are turned off on this gateway/i)).toBeInTheDocument();
  });
});
