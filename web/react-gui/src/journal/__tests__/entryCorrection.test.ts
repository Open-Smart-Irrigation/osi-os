import { describe, expect, it } from 'vitest';

import type { EntryAggregate } from '../../types/journal';
import type { CaptureEntryValueOutput } from '../../types/journalCapture';
import { buildCorrectionPayload, parseContextSnapshot } from '../entryCorrection';

const timestamp = '2026-07-16T08:00:05.000Z';

function aggregate(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: 'entry-1',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'gateway',
    plot_uuid: 'plot-1',
    zone_uuid: 'zone-1',
    device_eui: 'device-1',
    season_uuid: 'season-1',
    season_crop: 'wheat',
    season_variety: 'winter',
    campaign_uuid: 'campaign-1',
    protocol_code: 'protocol-1',
    protocol_version: 'v1',
    observation_unit_code: 'unit-1',
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 3,
    layout_code: 'open_field',
    layout_version: 2,
    catalog_version: 7,
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
    context_json: null,
    sync_version: 3,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [
      {
        group_index: 0,
        attribute_code: 'attr.rate',
        value_status: 'observed',
        value_num: 12,
        value_text: null,
        unit_code: 'unit.kg_ha',
        entered_value_num: 12,
        entered_unit_code: 'unit.kg_ha',
      },
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
        attribute_code: 'attr.legacy_note',
        value_status: 'observed',
        value_num: null,
        value_text: 'legacy stuff',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      },
    ],
    ...overrides,
  };
}

function sortedByCode<T extends { attribute_code: string; group_index?: number }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    left.attribute_code.localeCompare(right.attribute_code) || (left.group_index ?? 0) - (right.group_index ?? 0));
}

describe('buildCorrectionPayload', () => {
  it('preserves every untouched identity, context, and provenance field when only one value field is edited', () => {
    const source = aggregate();
    const formOwnedAttributeCodes = new Set(['attr.rate']);
    const editedValues: CaptureEntryValueOutput[] = [
      {
        attribute_code: 'attr.rate',
        value_status: 'observed',
        value_num: 20,
        unit_code: 'unit.kg_ha',
        entered_value_num: 20,
        entered_unit_code: 'unit.kg_ha',
      },
    ];

    const payload = buildCorrectionPayload(source, formOwnedAttributeCodes, editedValues);

    expect(payload.entry_uuid).toBe('entry-1');
    expect(payload.base_sync_version).toBe(3);
    expect(payload.status).toBe('final');
    expect(payload.plot_uuid).toBe('plot-1');
    expect(payload.zone_uuid).toBe('zone-1');
    expect(payload.device_eui).toBe('device-1');
    expect(payload.season_crop).toBe('wheat');
    expect(payload.season_variety).toBe('winter');
    expect(payload.campaign_uuid).toBe('campaign-1');
    expect(payload.protocol_code).toBe('protocol-1');
    expect(payload.protocol_version).toBe('v1');
    expect(payload.observation_unit_code).toBe('unit-1');
    expect(payload.pass_uuid).toBe('pass-1');
    expect(payload.batch_uuid).toBe('batch-1');
    expect(payload.activity_code).toBe('irrigation');
    expect(payload.template_code).toBe('farmer_quick');
    expect(payload.template_version).toBe(3);
    expect(payload.layout_code).toBe('open_field');
    expect(payload.layout_version).toBe(2);
    expect(payload.note).toBe('original note');
    expect(payload.occurred_timezone).toBe('Europe/Zurich');
    expect(payload.occurred_utc_offset_minutes).toBe(120);

    // The one edited field carries the new value...
    expect(sortedByCode(payload.values)).toEqual(sortedByCode([
      {
        attribute_code: 'attr.rate',
        value_status: 'observed',
        value_num: 20,
        unit_code: 'unit.kg_ha',
        entered_value_num: 20,
        entered_unit_code: 'unit.kg_ha',
      },
      // ...but every untouched value the form does not own passes through
      // unchanged, exactly as it was stored on the original aggregate.
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
        attribute_code: 'attr.legacy_note',
        value_status: 'observed',
        value_num: null,
        value_text: 'legacy stuff',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      },
    ]));
  });

  it('never lets a correction change batch provenance: batch_uuid always mirrors the source aggregate', () => {
    const payload = buildCorrectionPayload(aggregate({ batch_uuid: 'batch-42' }), new Set(), []);
    expect(payload.batch_uuid).toBe('batch-42');
  });

  it('reconstructs the local occurrence timestamps from the frozen instant and offset', () => {
    const payload = buildCorrectionPayload(aggregate(), new Set(), []);

    // occurred_start 08:00Z + 120 minutes offset -> 10:00 local.
    expect(payload.occurred_start_local).toBe('2026-07-16T10:00');
    // occurred_end 09:30Z + 120 minutes offset -> 11:30 local.
    expect(payload.occurred_end_local).toBe('2026-07-16T11:30');
    expect(payload.occurred_end_utc_offset_minutes).toBe(120);
  });

  it('sends a null occurrence end when the aggregate has no end', () => {
    const payload = buildCorrectionPayload(aggregate({ occurred_end: null }), new Set(), []);

    expect(payload.occurred_end_local).toBeNull();
    expect(payload.occurred_end_utc_offset_minutes).toBeNull();
  });

  it('preserves every grouped row of a value the form does not own', () => {
    const source = aggregate({
      values: [
        { group_index: 0, attribute_code: 'attr.nutrient', value_status: 'observed', value_num: 1, value_text: null, unit_code: 'unit.pct', entered_value_num: 1, entered_unit_code: 'unit.pct' },
        { group_index: 1, attribute_code: 'attr.nutrient', value_status: 'observed', value_num: 2, value_text: null, unit_code: 'unit.pct', entered_value_num: 2, entered_unit_code: 'unit.pct' },
        { group_index: 0, attribute_code: 'attr.rate', value_status: 'observed', value_num: 12, value_text: null, unit_code: 'unit.kg_ha', entered_value_num: 12, entered_unit_code: 'unit.kg_ha' },
      ],
    });
    const editedValues: CaptureEntryValueOutput[] = [
      { attribute_code: 'attr.rate', value_status: 'observed', value_num: 20, unit_code: 'unit.kg_ha', entered_value_num: 20, entered_unit_code: 'unit.kg_ha' },
    ];

    const payload = buildCorrectionPayload(source, new Set(['attr.rate']), editedValues);

    const nutrientRows = payload.values.filter((value) => value.attribute_code === 'attr.nutrient');
    expect(nutrientRows).toHaveLength(2);
    expect(nutrientRows.map((value) => value.group_index).sort()).toEqual([0, 1]);
  });

  it('fully replaces (including removing rows) a value the form owns, even when the edited payload omits it entirely', () => {
    const source = aggregate({
      values: [
        { group_index: 0, attribute_code: 'attr.nutrient', value_status: 'observed', value_num: 1, value_text: null, unit_code: 'unit.pct', entered_value_num: 1, entered_unit_code: 'unit.pct' },
        { group_index: 1, attribute_code: 'attr.nutrient', value_status: 'observed', value_num: 2, value_text: null, unit_code: 'unit.pct', entered_value_num: 2, entered_unit_code: 'unit.pct' },
        { group_index: 0, attribute_code: 'attr.legacy_note', value_status: 'observed', value_num: null, value_text: 'legacy stuff', unit_code: null, entered_value_num: null, entered_unit_code: null },
      ],
    });

    // The user removed both nutrient rows in the form; the form owns
    // attr.nutrient, so the edited (empty) payload wins over the stale rows.
    const payload = buildCorrectionPayload(source, new Set(['attr.nutrient']), []);

    expect(payload.values.some((value) => value.attribute_code === 'attr.nutrient')).toBe(false);
    expect(payload.values.some((value) => value.attribute_code === 'attr.legacy_note')).toBe(true);
  });
});

describe('parseContextSnapshot', () => {
  it('returns null when there is no stored context', () => {
    expect(parseContextSnapshot(null)).toBeNull();
  });

  it('returns null for a malformed JSON string instead of throwing', () => {
    expect(parseContextSnapshot('{not json')).toBeNull();
  });

  it('returns null for valid JSON that is not an object', () => {
    expect(parseContextSnapshot('[1,2,3]')).toBeNull();
    expect(parseContextSnapshot('"just a string"')).toBeNull();
  });

  it('parses a valid context snapshot and exposes its channels', () => {
    const snapshot = parseContextSnapshot(JSON.stringify({
      schema_version: 1,
      zone_uuid: 'zone-1',
      channels: { swt_1: { value: 32, unit: 'kPa' } },
    }));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.channels).toEqual({ swt_1: { value: 32, unit: 'kPa' } });
  });
});
