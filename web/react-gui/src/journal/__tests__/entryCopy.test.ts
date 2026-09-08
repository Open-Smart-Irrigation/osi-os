import { describe, expect, it } from 'vitest';

import type { ActiveCropCycle, EntryAggregate } from '../../types/journal';
import type { CaptureEntryValueOutput } from '../../types/journalCapture';
import { buildCopyPayload, deriveCopySeason, type CopyOccurrenceInput } from '../entryCopy';

const timestamp = '2026-07-16T08:00:05.000Z';

function aggregate(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: 'source-entry-1',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'gateway',
    plot_uuid: 'plot-1',
    zone_uuid: 'zone-old',
    device_eui: 'device-1',
    season_uuid: 'season-1',
    season_crop: 'wheat',
    season_variety: 'winter',
    campaign_uuid: 'campaign-1',
    protocol_code: 'protocol-1',
    protocol_version: 'v1',
    observation_unit_code: 'unit-1',
    activity_code: 'irrigation',
    template_code: 'full_record',
    template_version: 7,
    layout_code: 'open_field',
    layout_version: 5,
    catalog_version: 10,
    occurred_start: '2026-07-16T08:00:00.000Z',
    occurred_end: '2026-07-16T09:30:00.000Z',
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    origin: 'edge-ui',
    status: 'final',
    batch_uuid: 'batch-1',
    pass_uuid: 'pass-1',
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: 'original note',
    context_json: '{"schema_version":1,"channels":{}}',
    sync_version: 4,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [
      {
        group_index: 0,
        attribute_code: 'attr.operator',
        value_status: 'observed',
        value_num: null,
        value_text: 'Jordi',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      },
      {
        group_index: 0,
        attribute_code: 'attr.actuation_expectation_id',
        value_status: 'observed',
        value_num: null,
        value_text: 'valve-expectation-abc123',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      },
    ],
    ...overrides,
  };
}

function occurrence(overrides: Partial<CopyOccurrenceInput> = {}): CopyOccurrenceInput {
  return {
    occurred_start_local: '2026-07-20T09:00',
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    zone_uuid: 'zone-current',
    season_crop: null,
    season_variety: null,
    template_code: 'full_record',
    template_version: 11,
    layout_code: 'open_field',
    layout_version: 9,
    note: null,
    ...overrides,
  };
}

describe('buildCopyPayload', () => {
  it('builds a brand-new create with a fresh uuid, never the source entry_uuid', () => {
    const source = aggregate();
    const payload = buildCopyPayload(source, new Set(), [], occurrence());

    expect(payload.entry_uuid).toBeDefined();
    expect(payload.entry_uuid).not.toBe(source.entry_uuid);
    expect(payload.base_sync_version).toBe(0);
    expect(payload.status).toBe('final');
  });

  it('never mutates/references the source aggregate object', () => {
    const source = aggregate();
    const snapshot = JSON.parse(JSON.stringify(source));
    buildCopyPayload(source, new Set(['attr.operator']), [
      { attribute_code: 'attr.operator', value: 'Sam' },
    ], occurrence());
    expect(source).toEqual(snapshot);
  });

  it('omits every batch/pass/cycle/context field entirely', () => {
    const payload = buildCopyPayload(aggregate(), new Set(), [], occurrence());

    expect(payload).not.toHaveProperty('pass_uuid');
    expect(payload).not.toHaveProperty('batch_uuid');
    expect(payload).not.toHaveProperty('cycle_action');
    expect(payload).not.toHaveProperty('cycle_uuid');
    expect(payload).not.toHaveProperty('ends_crop_cycle');
    expect(payload).not.toHaveProperty('duplicate_guard_ack_entry_uuid');
    expect(payload).not.toHaveProperty('context_json');
    expect(payload).not.toHaveProperty('device_eui');
  });

  it('drops attr.actuation_expectation_id from the copied values', () => {
    const payload = buildCopyPayload(aggregate(), new Set(), [], occurrence());

    expect(payload.values.some((value) => value.attribute_code === 'attr.actuation_expectation_id')).toBe(false);
    expect(payload.values.some((value) => value.attribute_code === 'attr.operator')).toBe(true);
  });

  it('carries campaign/protocol/observation-unit identity from the source', () => {
    const payload = buildCopyPayload(aggregate(), new Set(), [], occurrence());

    expect(payload.plot_uuid).toBe('plot-1');
    expect(payload.activity_code).toBe('irrigation');
    expect(payload.campaign_uuid).toBe('campaign-1');
    expect(payload.protocol_code).toBe('protocol-1');
    expect(payload.protocol_version).toBe('v1');
    expect(payload.observation_unit_code).toBe('unit-1');
  });

  it('uses the CURRENT template/layout versions and zone/season/note/occurrence supplied by the host, not the source\'s stale ones', () => {
    const payload = buildCopyPayload(aggregate(), new Set(), [], occurrence({
      zone_uuid: 'zone-current',
      season_crop: 'agroscope.crop.potato',
      season_variety: 'Charlotte',
      template_code: 'full_record',
      template_version: 11,
      layout_code: 'open_field',
      layout_version: 9,
      note: 'edited note',
      occurred_start_local: '2026-07-20T09:00',
      occurred_timezone: 'Europe/Zurich',
      occurred_utc_offset_minutes: 120,
    }));

    expect(payload.zone_uuid).toBe('zone-current');
    expect(payload.zone_uuid).not.toBe('zone-old');
    expect(payload.season_crop).toBe('agroscope.crop.potato');
    expect(payload.season_crop).not.toBe('wheat');
    expect(payload.season_variety).toBe('Charlotte');
    expect(payload.template_version).toBe(11);
    expect(payload.template_version).not.toBe(7);
    expect(payload.layout_version).toBe(9);
    expect(payload.layout_version).not.toBe(5);
    expect(payload.note).toBe('edited note');
    expect(payload.note).not.toBe('original note');
    expect(payload.occurred_start_local).toBe('2026-07-20T09:00');
    expect(payload.occurred_end_local).toBeNull();
    expect(payload.occurred_end_utc_offset_minutes).toBeNull();
  });

  it('re-emits every preserved (form-unowned) value row and applies the edited row for an owned code, exactly like a correction', () => {
    const source = aggregate({
      values: [
        { group_index: 0, attribute_code: 'attr.operator', value_status: 'observed', value_num: null, value_text: 'Jordi', unit_code: null, entered_value_num: null, entered_unit_code: null },
        { group_index: 0, attribute_code: 'attr.legacy', value_status: 'observed', value_num: null, value_text: 'legacy stuff', unit_code: null, entered_value_num: null, entered_unit_code: null },
      ],
    });
    const editedValues: CaptureEntryValueOutput[] = [
      { attribute_code: 'attr.operator', value: 'Sam' },
    ];

    const payload = buildCopyPayload(source, new Set(['attr.operator']), editedValues, occurrence());

    const operator = payload.values.find((value) => value.attribute_code === 'attr.operator');
    expect(operator).toMatchObject({ value: 'Sam' });
    const legacy = payload.values.find((value) => value.attribute_code === 'attr.legacy');
    expect(legacy).toMatchObject({ value_text: 'legacy stuff' });
  });
});

describe('deriveCopySeason', () => {
  function cycle(overrides: Partial<ActiveCropCycle> = {}): ActiveCropCycle {
    return {
      cycle_uuid: 'cycle-1',
      crop_code: 'agroscope.crop.potato',
      variety: 'Charlotte',
      seeded_on: '2026-05-01',
      opened_by_entry_uuid: 'seed-entry-1',
      ...overrides,
    };
  }

  it('re-derives crop/variety from the single open cycle covering the new occurred date', () => {
    expect(deriveCopySeason([cycle()], '2026-07-20')).toEqual({
      season_crop: 'agroscope.crop.potato',
      season_variety: 'Charlotte',
    });
  });

  it('falls back to null for a backdated copy before the open cycle started', () => {
    expect(deriveCopySeason([cycle({ seeded_on: '2026-08-01' })], '2026-07-20')).toEqual({
      season_crop: null,
      season_variety: null,
    });
  });

  it('falls back to null when nothing is growing (no open cycle)', () => {
    expect(deriveCopySeason([], '2026-07-20')).toEqual({ season_crop: null, season_variety: null });
  });

  it('falls back to null for an intercropped plot (more than one open cycle)', () => {
    expect(deriveCopySeason([cycle(), cycle({ cycle_uuid: 'cycle-2', crop_code: 'agroscope.crop.maize' })], '2026-07-20'))
      .toEqual({ season_crop: null, season_variety: null });
  });

  it('never falls back to a variety-less null when the cycle has no variety recorded', () => {
    expect(deriveCopySeason([cycle({ variety: null })], '2026-07-20')).toEqual({
      season_crop: 'agroscope.crop.potato',
      season_variety: null,
    });
  });
});
