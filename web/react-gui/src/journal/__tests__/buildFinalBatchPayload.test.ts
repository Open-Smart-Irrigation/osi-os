import { describe, expect, it } from 'vitest';

import { buildFinalBatchPayload, buildTankMixPassBatchPayload } from '../buildFinalBatchPayload';

const plotA = '11111111-1111-4111-8111-111111111111';
const plotB = '22222222-2222-4222-8222-222222222222';
const entryA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entryB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const input = {
  members: [
    { plot_uuid: plotB, entry_uuid: entryB },
    { plot_uuid: plotA, entry_uuid: entryA },
  ],
  season_crop: 'barley, winter',
  activity_code: 'irrigation',
  template_code: 'farmer_quick',
  template_version: 1,
  layout_code: 'open_field',
  layout_version: 1,
  occurred_start_local: '2026-07-17T08:30',
  occurred_end_local: null,
  occurred_timezone: 'Europe/Zurich',
  occurred_utc_offset_minutes: 120,
  occurred_end_utc_offset_minutes: null,
  values: [{ attribute_code: 'attr.irrigation_depth', value: 12 }],
} as const;

describe('buildFinalBatchPayload', () => {
  it('rejects an empty selection with the exact invalid_batch envelope', () => {
    expect(buildFinalBatchPayload({ ...input, members: [] })).toEqual({
      ok: false,
      error: { error: 'invalid_batch', message: 'Batch plots must be a nonempty array', details: null },
    });
  });

  it('rejects 101 plots with the exact batch_too_large envelope', () => {
    const members = Array.from({ length: 101 }, (_, index) => ({
      plot_uuid: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      entry_uuid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    }));
    expect(buildFinalBatchPayload({ ...input, members })).toEqual({
      ok: false,
      error: { error: 'batch_too_large', message: 'A journal batch may contain at most 100 plots', details: null },
    });
  });

  it('rejects duplicate plot UUIDs with the exact duplicate_plot envelope', () => {
    expect(buildFinalBatchPayload({ ...input, members: [
      { plot_uuid: plotA, entry_uuid: entryA },
      { plot_uuid: plotA, entry_uuid: entryB },
    ] })).toEqual({
      ok: false,
      error: { error: 'duplicate_plot', message: 'A journal batch cannot contain duplicate plots', details: null },
    });
  });

  it('rejects duplicate member entry UUIDs with the exact duplicate_entry_uuid envelope', () => {
    expect(buildFinalBatchPayload({ ...input, members: [
      { plot_uuid: plotA, entry_uuid: entryA },
      { plot_uuid: plotB, entry_uuid: entryA },
    ] })).toEqual({
      ok: false,
      error: {
        error: 'duplicate_entry_uuid',
        message: 'A journal batch cannot contain duplicate member entry UUIDs',
        details: null,
      },
    });
  });

  it('returns one final payload with unique sorted plot UUIDs and no scalar fields', () => {
    const result = buildFinalBatchPayload(input);
    expect(result).toEqual({
      ok: true,
      payload: {
        status: 'final',
        members: [
          { plot_uuid: plotA, entry_uuid: entryA },
          { plot_uuid: plotB, entry_uuid: entryB },
        ],
        base_sync_version: 0,
        season_crop: 'barley, winter',
        activity_code: 'irrigation',
        template_code: 'farmer_quick',
        template_version: 1,
        layout_code: 'open_field',
        layout_version: 1,
        occurred_start_local: '2026-07-17T08:30',
        occurred_end_local: null,
        occurred_timezone: 'Europe/Zurich',
        occurred_utc_offset_minutes: 120,
        occurred_end_utc_offset_minutes: null,
        values: [{ attribute_code: 'attr.irrigation_depth', value: 12 }],
      },
    });

    if (result.ok) {
      expect(result.payload).not.toHaveProperty('entry_uuid');
      expect(result.payload).not.toHaveProperty('batch_uuid');
      expect(result.payload).not.toHaveProperty('plot_uuid');
      expect(result.payload).not.toHaveProperty('zone_uuid');
      expect(result.payload).not.toHaveProperty('duplicate_guard_ack_entry_uuid');
    }
  });

  it('sends deterministic sorted members with one client entry UUID per plot', () => {
    const result = buildFinalBatchPayload({
      ...input,
      members: [
        { plot_uuid: plotB, entry_uuid: entryB },
        { plot_uuid: plotA, entry_uuid: entryA },
      ],
    } as unknown as Parameters<typeof buildFinalBatchPayload>[0]);

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.payload.members).toEqual([
        { plot_uuid: plotA, entry_uuid: entryA },
        { plot_uuid: plotB, entry_uuid: entryB },
      ]);
      expect(result.payload).not.toHaveProperty('plot_uuids');
      expect(result.payload).not.toHaveProperty('batch_uuid');
    }
  });

  it('explicitly allowlists every CreateFinalBatchPayload field against poisoned runtime input', () => {
    const poisoned = {
      ...input,
      entry_uuid: 'poison-entry',
      batch_uuid: 'poison-batch',
      plot_uuid: 'poison-plot',
      zone_uuid: 'poison-zone',
      duplicate_guard_ack_entry_uuid: 'poison-singular-ack',
      unknown_runtime_field: 'must-not-leak',
    } as unknown as Parameters<typeof buildFinalBatchPayload>[0];

    const result = buildFinalBatchPayload(poisoned);

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(Object.keys(result.payload).sort()).toEqual([
        'activity_code',
        'base_sync_version',
        'layout_code',
        'layout_version',
        'members',
        'occurred_end_local',
        'occurred_end_utc_offset_minutes',
        'occurred_start_local',
        'occurred_timezone',
        'occurred_utc_offset_minutes',
        'season_crop',
        'status',
        'template_code',
        'template_version',
        'values',
      ]);
      expect(result.payload).not.toHaveProperty('entry_uuid');
      expect(result.payload).not.toHaveProperty('batch_uuid');
      expect(result.payload).not.toHaveProperty('plot_uuid');
      expect(result.payload).not.toHaveProperty('zone_uuid');
      expect(result.payload).not.toHaveProperty('duplicate_guard_ack_entry_uuid');
      expect(result.payload).not.toHaveProperty('unknown_runtime_field');
    }
  });
});

describe('buildTankMixPassBatchPayload (Slice F, B1/B2 atomic tank-mix pass)', () => {
  const passUuid = '33333333-3333-4333-8333-333333333333';
  const primaryEntryUuid = '44444444-4444-4444-8444-444444444444';
  const herbicideEntryUuid = '55555555-5555-4555-8555-555555555555';
  const adjuvantEntryUuid = '66666666-6666-4666-8666-666666666666';

  const sharedInput = {
    plot_uuid: plotA,
    season_crop: null,
    activity_code: 'plant_protection_application',
    template_code: 'full_record',
    template_version: 6,
    layout_code: 'open_field',
    layout_version: 3,
    occurred_start_local: '2026-07-20T08:00',
    occurred_end_local: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    occurred_end_utc_offset_minutes: null,
    pass_uuid: passUuid,
    primary_entry_uuid: primaryEntryUuid,
    primary_values: [
      { attribute_code: 'attr.treated_area', value_num: 1000, unit_code: 'unit.m2_area' },
      { attribute_code: 'attr.product', value: 'Herbicide X (primary)' },
    ],
  };

  it('builds ONE batch payload covering the primary plus every queued member, all sharing plot and pass_uuid', () => {
    const result = buildTankMixPassBatchPayload({
      ...sharedInput,
      members: [
        { entry_uuid: herbicideEntryUuid, values: [{ attribute_code: 'attr.product', value: 'Herbicide X' }] },
        { entry_uuid: adjuvantEntryUuid, values: [{ attribute_code: 'attr.product', value: 'Adjuvant Y' }] },
      ],
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) throw new Error('expected ok: true');
    const { payload } = result;
    expect(payload.pass_uuid).toBe(passUuid);
    expect(payload.status).toBe('final');
    expect(payload.base_sync_version).toBe(0);
    expect(payload.members).toEqual([
      { plot_uuid: plotA, entry_uuid: primaryEntryUuid, values: sharedInput.primary_values },
      {
        plot_uuid: plotA, entry_uuid: herbicideEntryUuid,
        values: [{ attribute_code: 'attr.product', value: 'Herbicide X' }],
      },
      {
        plot_uuid: plotA, entry_uuid: adjuvantEntryUuid,
        values: [{ attribute_code: 'attr.product', value: 'Adjuvant Y' }],
      },
    ]);
    // Every member shares the SAME plot -- the opposite of
    // buildFinalBatchPayload's cross-plot rule above.
    expect(new Set(payload.members.map((member) => member.plot_uuid)).size).toBe(1);
    // No per-member duplicate_guard_ack_entry_uuid chain — the edge now
    // excludes same-pass_uuid entries from the duplicate guard outright, so
    // no per-member acknowledgement is ever built here.
    expect(payload).not.toHaveProperty('duplicate_guard_ack_entry_uuid');
    expect(payload.members.every((member) => !('duplicate_guard_ack_entry_uuid' in member))).toBe(true);
  });

  it('builds a single-member batch (primary only) for a pass with no queued siblings', () => {
    const result = buildTankMixPassBatchPayload({ ...sharedInput, members: [] });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.payload.members).toEqual([
        { plot_uuid: plotA, entry_uuid: primaryEntryUuid, values: sharedInput.primary_values },
      ]);
    }
  });

  it('rejects a member entry UUID colliding with the primary (or another member) with duplicate_entry_uuid', () => {
    const result = buildTankMixPassBatchPayload({
      ...sharedInput,
      members: [{ entry_uuid: primaryEntryUuid, values: [] }],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        error: 'duplicate_entry_uuid',
        message: 'A tank-mix pass cannot contain duplicate member entry UUIDs',
        details: null,
      },
    });
  });

  it('rejects a pass with no resolved plot', () => {
    const result = buildTankMixPassBatchPayload({ ...sharedInput, plot_uuid: '', members: [] });
    expect(result).toEqual({
      ok: false,
      error: { error: 'invalid_batch', message: 'A tank-mix pass requires a resolved plot', details: null },
    });
  });

  it('carries the crop-cycle cascade fields once at the batch top level, never per member', () => {
    const result = buildTankMixPassBatchPayload({
      ...sharedInput,
      ends_crop_cycle: true,
      members: [{ entry_uuid: herbicideEntryUuid, values: [] }],
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.payload.ends_crop_cycle).toBe(true);
      expect(result.payload.members.every((member) => !('ends_crop_cycle' in member))).toBe(true);
    }
  });
});
