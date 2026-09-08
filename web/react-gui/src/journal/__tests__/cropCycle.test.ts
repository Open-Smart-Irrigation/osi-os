import { describe, expect, it } from 'vitest';

import {
  activeCropChoices,
  currentCropInfoForPlot,
  cycleDependentsFromError,
  cycleDisambiguationFromError,
  cycleOptionLabel,
  varietySuggestionsFor,
} from '../cropCycle';
import type { ActiveCropCycle, EntryAggregate, EntryValue, JournalVocabRow } from '../../types/journal';
import type { JournalCaptureCatalogModel } from '../../types/journalCapture';

const timestamp = '2026-07-20T00:00:00.000Z';

function vocabRow(overrides: Partial<JournalVocabRow> & { code: string }): JournalVocabRow {
  return {
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 0,
    sync_version: 0,
    created_at: timestamp,
    deleted_at: null,
    catalog_errors: [],
    labels: { en: overrides.code },
    constraints: null,
    ...overrides,
  };
}

function buildModel(rows: JournalVocabRow[]): JournalCaptureCatalogModel {
  return {
    vocabByCode: new Map(rows.map((row) => [row.code, row])),
    templates: new Map(),
    layouts: new Map(),
  };
}

const wheatWinter = vocabRow({
  code: 'agroscope.crop.wheat_winter', kind: 'choice', parent_code: 'attr.crop', sort_order: 10,
  labels: { en: 'Winter wheat' },
});
const barleySpring = vocabRow({
  code: 'agroscope.crop.barley_spring', kind: 'choice', parent_code: 'attr.crop', sort_order: 5,
  labels: { en: 'Spring barley' },
});
const deletedCrop = vocabRow({
  code: 'agroscope.crop.deleted', kind: 'choice', parent_code: 'attr.crop', deleted_at: timestamp,
});
const inactiveCrop = vocabRow({
  code: 'agroscope.crop.inactive', kind: 'choice', parent_code: 'attr.crop', active: 0,
});
const model = buildModel([wheatWinter, barleySpring, deletedCrop, inactiveCrop]);

function entryValue(attributeCode: string, valueText: string, groupIndex = 0): EntryValue {
  return {
    group_index: groupIndex,
    attribute_code: attributeCode,
    value_status: 'observed',
    value_num: null,
    value_text: valueText,
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
  };
}

function entry(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: '11111111-1111-4111-8111-111111111111',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'AABBCCDDEEFF0011',
    plot_uuid: 'plot-a',
    zone_uuid: null,
    device_eui: null,
    season_uuid: null,
    season_crop: null,
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    activity_code: 'seeding',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: timestamp,
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    origin: 'edge-ui',
    status: 'final',
    batch_uuid: null,
    pass_uuid: null,
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: null,
    context_json: null,
    sync_version: 1,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [],
    ...overrides,
  };
}

describe('activeCropChoices', () => {
  it('returns only active, non-deleted attr.crop choices sorted by sort_order', () => {
    expect(activeCropChoices(model, 'en')).toEqual([
      { code: 'agroscope.crop.barley_spring', label: 'Spring barley' },
      { code: 'agroscope.crop.wheat_winter', label: 'Winter wheat' },
    ]);
  });
});

describe('varietySuggestionsFor', () => {
  it('collects distinct varieties recorded on final seeding entries for the matching crop', () => {
    const entries = [
      entry({
        entry_uuid: 'e1',
        values: [entryValue('attr.crop', 'agroscope.crop.wheat_winter'), entryValue('attr.variety', 'Marlene')],
      }),
      entry({
        entry_uuid: 'e2', activity_code: 'planting_transplanting',
        values: [entryValue('attr.crop', 'agroscope.crop.wheat_winter'), entryValue('attr.variety', 'Runal')],
      }),
      entry({
        entry_uuid: 'e3',
        values: [entryValue('attr.crop', 'agroscope.crop.wheat_winter'), entryValue('attr.variety', 'Marlene')],
      }),
      entry({
        entry_uuid: 'e4', // different crop: excluded
        values: [entryValue('attr.crop', 'agroscope.crop.barley_spring'), entryValue('attr.variety', 'Django')],
      }),
      entry({
        entry_uuid: 'e5', activity_code: 'fertilization', // not a seeding activity: excluded
        values: [entryValue('attr.crop', 'agroscope.crop.wheat_winter'), entryValue('attr.variety', 'Ignored')],
      }),
    ];
    expect(varietySuggestionsFor('agroscope.crop.wheat_winter', entries)).toEqual(['Marlene', 'Runal']);
  });

  it('returns nothing for an empty crop code', () => {
    expect(varietySuggestionsFor('', [entry()])).toEqual([]);
  });
});

function activeCropCycle(overrides: Partial<ActiveCropCycle> & { cycle_uuid: string }): ActiveCropCycle {
  return {
    crop_code: 'agroscope.crop.wheat_winter',
    variety: 'Marlene',
    seeded_on: '2026-04-01',
    opened_by_entry_uuid: 'seed-1',
    ...overrides,
  };
}

describe('currentCropInfoForPlot', () => {
  it('reads crop/variety/seeded date/seeding entry from the single open cycle', () => {
    const cycles = [activeCropCycle({
      cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene',
      seeded_on: '2026-07-01', opened_by_entry_uuid: 'seed-uuid-1',
    })];
    expect(currentCropInfoForPlot(cycles)).toEqual({
      crop_code: 'agroscope.crop.wheat_winter',
      variety: 'Marlene',
      seededDate: '2026-07-01',
      seedingEntryUuid: 'seed-uuid-1',
    });
  });

  it('returns null when no cycle is open (nothing growing)', () => {
    expect(currentCropInfoForPlot([])).toBeNull();
    expect(currentCropInfoForPlot(null)).toBeNull();
    expect(currentCropInfoForPlot(undefined)).toBeNull();
  });

  it('returns null for a genuinely intercropped plot (more than one open cycle) — ambiguous, deferred to R7', () => {
    const cycles = [
      activeCropCycle({ cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter' }),
      activeCropCycle({ cycle_uuid: 'cycle-2', crop_code: 'agroscope.crop.barley_spring', variety: null }),
    ];
    expect(currentCropInfoForPlot(cycles)).toBeNull();
  });

  it('treats a blank variety the same as no variety', () => {
    const cycles = [activeCropCycle({ cycle_uuid: 'cycle-1', variety: '  ' })];
    expect(currentCropInfoForPlot(cycles)?.variety).toBeNull();
  });
});

describe('cycleDisambiguationFromError', () => {
  it('parses an axios-shaped cycle_uuid_required refusal', () => {
    const error = {
      response: {
        status: 422,
        data: {
          error: 'cycle_uuid_required',
          message: 'Multiple open crop cycles cover this plot',
          details: {
            openCycles: [
              { cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
              { cycle_uuid: 'cycle-2', crop_code: 'agroscope.crop.barley_spring', variety: null },
            ],
          },
        },
      },
    };
    expect(cycleDisambiguationFromError(error)).toEqual([
      { cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
      { cycle_uuid: 'cycle-2', crop_code: 'agroscope.crop.barley_spring', variety: null },
    ]);
  });

  it('also recognizes cycle_not_found', () => {
    const error = {
      response: {
        data: {
          error: 'cycle_not_found',
          details: { openCycles: [{ cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter' }] },
        },
      },
    };
    expect(cycleDisambiguationFromError(error)).toEqual([
      { cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: null },
    ]);
  });

  it('returns null for unrelated errors or malformed details', () => {
    expect(cycleDisambiguationFromError(new Error('boom'))).toBeNull();
    expect(cycleDisambiguationFromError({ response: { data: { error: 'cycle_uuid_required', details: {} } } }))
      .toBeNull();
    expect(cycleDisambiguationFromError({ response: { data: { error: 'duplicate_candidate' } } })).toBeNull();
  });
});

describe('cycleDependentsFromError', () => {
  it('parses an axios-shaped cycle_has_dependents refusal', () => {
    const error = {
      response: {
        status: 409,
        data: {
          error: 'cycle_has_dependents',
          details: { dependentEntryUuids: ['e1', 'e2'] },
        },
      },
    };
    expect(cycleDependentsFromError(error)).toEqual(['e1', 'e2']);
  });

  it('returns null for unrelated errors', () => {
    expect(cycleDependentsFromError({ response: { data: { error: 'not_found' } } })).toBeNull();
  });
});

describe('cycleOptionLabel', () => {
  it('renders crop and variety, falling back to the raw code for an unknown crop', () => {
    expect(cycleOptionLabel({ cycle_uuid: 'c1', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' }, model, 'en'))
      .toBe('Winter wheat · Marlene');
    expect(cycleOptionLabel({ cycle_uuid: 'c2', crop_code: 'agroscope.crop.wheat_winter', variety: null }, model, 'en'))
      .toBe('Winter wheat');
    expect(cycleOptionLabel({ cycle_uuid: 'c3', crop_code: 'unknown.crop', variety: null }, model, 'en'))
      .toBe('unknown.crop');
  });
});
