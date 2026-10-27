import { describe, expect, it } from 'vitest';
import {
  SWT_PRESETS,
  buildCondition,
  conditionDraftFromPolicy,
  isConditionalSchedule,
  legacySixAmPreview,
  normalisePolicyView,
  toPolicyPayload,
} from '../irrigationPolicy';

describe('irrigation policy helpers', () => {
  it('keeps the three exact SWT presets and treats 29.9 as Custom', () => {
    expect(SWT_PRESETS.map(option => option.value)).toEqual([20, 30, 50]);
    expect(conditionDraftFromPolicy({
      kind: 'SWT',
      threshold_kpa: 29.9,
      sources: [{ device_eui: 'aa11', channel: 'swt_1' }],
    })).toMatchObject({ kind: 'SWT', threshold: 29.9 });
    expect(conditionDraftFromPolicy({
      kind: 'SWT',
      threshold_kpa: 30,
      sources: [{ device_eui: 'AA11', channel: 'swt_1' }],
    })).toMatchObject({ kind: 'SWT', threshold: 30 });
  });

  it('keeps blank VWC separate from a measured zero', () => {
    expect(conditionDraftFromPolicy({ kind: 'VWC', threshold_percent: null, sources: [] })).toMatchObject({
      kind: 'VWC',
      threshold: '',
    });
    expect(conditionDraftFromPolicy({ kind: 'VWC', threshold_percent: 0, sources: [] })).toMatchObject({
      kind: 'VWC',
      threshold: 0,
    });
    expect(buildCondition({ kind: 'VWC', threshold: 0, sources: [] })).toEqual({
      kind: 'VWC',
      threshold_percent: 0,
      sources: [],
    });
  });

  it('normalises local and cloud policy views without losing missing runtime values', () => {
    const view = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
      policy: null,
      schedules: [],
      runtime: { availability: 'unavailable', next_check: null, legacy_process_timezone: null },
      source_choices: { SWT: [], VWC: [], DENDRO: [] },
    });
    expect(view.zone).toEqual({ id: null, zoneUuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' });
    expect(view.policy).toBeNull();
    expect(view.runtime.availability).toBe('unavailable');
    expect(view.runtime.nextCheck).toBeNull();
    expect(view.runtime.legacyProcessTimezone).toBeNull();
  });

  it('normalises local readiness and cloud update state into one valve status', () => {
    const local = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
      policy: null,
      eligible_sources: [],
      source_choices: { SWT: [], VWC: [], DENDRO: [] },
      schedules: [],
      valves: [{
        device_eui: 'aa11',
        control: { incident: { incident_id: 'incident-1', state: 'OPEN', retry_revision: 'retry-1' } },
        readiness: { state: 'READY', ready: true, reason: 'all_current_clear_acked' },
      }],
    });
    expect(local.runtime.valves[0]).toEqual(expect.objectContaining({
      deviceEui: 'AA11',
      availability: 'fresh',
      update: { state: 'READY', ready: true, reason: 'all_current_clear_acked' },
      incident: { incident_id: 'incident-1', state: 'OPEN', retry_revision: 'retry-1', retry_pending: true },
      clock: null,
    }));

    const cloud = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
      schedules: [],
      runtime: {
        availability: 'fresh',
        valves: [{ device_eui: 'AA11', update: { state: 'READY', ready: true, reason: null } }],
      },
    });
    expect(cloud.runtime.valves[0]?.update).toEqual({ state: 'READY', ready: true, reason: null });
  });

  it('retains per-valve availability so stale evidence can be gated', () => {
    const view = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
      schedules: [],
      runtime: {
        availability: 'fresh',
        valves: [{ device_eui: 'AA11', availability: 'stale', update: { state: 'APPLIED', ready: true } }],
      },
    });
    expect(view.runtime.valves[0]).toEqual(expect.objectContaining({ deviceEui: 'AA11', availability: 'stale' }));
  });

  it('keeps root qualification and the real DENDRO availability object', () => {
    const view = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: null },
      schedules: [],
      qualification: { qualified: false, reason: 'no_reference_tree' },
      source_choices: {
        SWT: [],
        VWC: [],
        DENDRO: [{ kind: 'DENDRO', eligible: false, state: 'unavailable', reason: 'no_reference_tree', sources: [] }],
      },
      runtime: { availability: 'fresh', clock: { trusted: true } },
    });
    expect(view.runtime.qualification).toEqual({ qualified: false, reason: 'no_reference_tree' });
    expect(view.runtime.sourceChoices.DENDRO).toEqual([expect.objectContaining({
      kind: 'DENDRO', eligible: false, state: 'unavailable', reason: 'no_reference_tree', sources: [],
    })]);
    expect(view.policy).toBeNull();
  });

  it('does not invent UTC when a policy has no authoritative timezone', () => {
    const view = normalisePolicyView({
      zone: { zone_uuid: 'zone-1', name: 'North', timezone: null },
      policy: { policy_uuid: 'policy-1', zone_uuid: 'zone-1', condition: { kind: 'SWT', threshold_kpa: 30, sources: [] }, enabled: true },
      schedules: [],
      runtime: { availability: 'unavailable' },
    });
    expect(view.policy?.timezone).toBeNull();
    expect(toPolicyPayload({
      policyUuid: null,
      expectedPolicyVersion: null,
      zoneUuid: 'zone-1',
      condition: { kind: 'SWT', threshold: 30, sources: [] },
    })).not.toHaveProperty('timezone');
  });

  it('serializes a partial edit and makes detach explicit', () => {
    const payload = toPolicyPayload({
      policyUuid: 'policy-1',
      expectedPolicyVersion: 7,
      zoneUuid: 'zone-1',
      condition: { kind: 'SWT', threshold: 20, sources: [{ deviceEui: 'aa11', channel: 'swt_1' }] },
      timezone: 'Europe/Zurich',
      enabled: true,
      schedules: [{
        scheduleUuid: 'schedule-1',
        expectedSyncVersion: 4,
        deviceEui: 'aa11',
        weekdaysMask: 127,
        startTime: '06:00',
        durationMinutes: 15,
        execution: 'conditional',
        detach: false,
      }, {
        scheduleUuid: 'schedule-2',
        expectedSyncVersion: 5,
        deviceEui: 'bb22',
        detach: true,
      }],
    });
    expect(payload).toEqual(expect.objectContaining({
      policy_uuid: 'policy-1',
      expected_policy_version: 7,
      zone_uuid: 'zone-1',
      condition: { kind: 'SWT', threshold_kpa: 20, sources: [{ device_eui: 'AA11', channel: 'swt_1' }] },
    }));
    expect(payload.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ schedule_uuid: 'schedule-1', expected_sync_version: 4, detach: false }),
      expect.objectContaining({ schedule_uuid: 'schedule-2', expected_sync_version: 5, detach: true }),
    ]));
  });

  it('omits the condition for a schedule-only partial edit', () => {
    expect(toPolicyPayload({
      policyUuid: 'policy-1',
      expectedPolicyVersion: 7,
      zoneUuid: 'zone-1',
      schedules: [{ scheduleUuid: 'schedule-1', expectedSyncVersion: 4, durationMinutes: 15 }],
    })).not.toHaveProperty('condition');
  });

  it('identifies only attached conditional weekly rows', () => {
    expect(isConditionalSchedule({ kind: 'WEEKLY', execution: 'conditional', conditionPolicyUuid: 'p' })).toBe(true);
    expect(isConditionalSchedule({ kind: 'WEEKLY', execution: 'always', conditionPolicyUuid: 'p' })).toBe(false);
    expect(isConditionalSchedule({ kind: 'ONCE', execution: 'conditional', conditionPolicyUuid: 'p' })).toBe(false);
    expect(isConditionalSchedule({ kind: 'WEEKLY', conditionPolicyUuid: null })).toBe(false);
  });

  it('uses the supplied process and policy timezones for dated legacy previews', () => {
    expect(legacySixAmPreview('2026-01-15', 'UTC', 'America/New_York')).toMatchObject({
      legacyTime: '06:00',
      zoneTime: '01:00',
    });
    expect(legacySixAmPreview('2026-07-15', 'UTC', 'America/New_York')).toMatchObject({
      legacyTime: '06:00',
      zoneTime: '02:00',
    });
    expect(legacySixAmPreview('2026-01-15', null, 'America/New_York')).toBeNull();
  });
});
