import { describe, expect, it } from 'vitest';

import { buildFinalBatchPayload } from '../buildFinalBatchPayload';

const plotA = '11111111-1111-4111-8111-111111111111';
const plotB = '22222222-2222-4222-8222-222222222222';

const input = {
  plotUuids: [plotB, plotA],
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
    expect(buildFinalBatchPayload({ ...input, plotUuids: [] })).toEqual({
      ok: false,
      error: { error: 'invalid_batch', message: 'Batch plots must be a nonempty array', details: null },
    });
  });

  it('rejects 101 plots with the exact batch_too_large envelope', () => {
    const plotUuids = Array.from({ length: 101 }, (_, index) =>
      `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`);
    expect(buildFinalBatchPayload({ ...input, plotUuids })).toEqual({
      ok: false,
      error: { error: 'batch_too_large', message: 'A journal batch may contain at most 100 plots', details: null },
    });
  });

  it('rejects duplicate UUIDs with the exact duplicate_plot envelope', () => {
    expect(buildFinalBatchPayload({ ...input, plotUuids: [plotA, plotA] })).toEqual({
      ok: false,
      error: { error: 'duplicate_plot', message: 'A journal batch cannot contain duplicate plots', details: null },
    });
  });

  it('returns one final payload with unique sorted plot UUIDs and no scalar fields', () => {
    const result = buildFinalBatchPayload(input);
    expect(result).toEqual({
      ok: true,
      payload: {
        status: 'final',
        plot_uuids: [plotA, plotB],
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
        'occurred_end_local',
        'occurred_end_utc_offset_minutes',
        'occurred_start_local',
        'occurred_timezone',
        'occurred_utc_offset_minutes',
        'plot_uuids',
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
