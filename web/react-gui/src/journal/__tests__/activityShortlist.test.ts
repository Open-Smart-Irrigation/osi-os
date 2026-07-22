import { describe, expect, it, vi } from 'vitest';

import type {
  EntryAggregate,
  EntryListFilters,
  EntryListResponse,
  JournalVocabRow,
} from '../../types/journal';
import type {
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
} from '../../types/journalCapture';
import {
  buildActivityShortlist,
  loadActivityShortlist,
  MAX_ACTIVITY_HISTORY_PAGES,
} from '../activityShortlist';
import { deriveActivityLeaves } from '../catalogModel';

const timestamp = '2026-07-16T00:00:00.000Z';

function vocab(code: string, overrides: Partial<JournalVocabRow> = {}): JournalVocabRow {
  return {
    code,
    kind: 'activity',
    parent_code: null,
    value_type: null,
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
    labels: { en: code },
    constraints: null,
    ...overrides,
  };
}

const model: JournalCaptureCatalogModel = {
  vocabByCode: new Map([
    ['irrigation', vocab('irrigation')],
    ['fertilization', vocab('fertilization')],
    ['attr.operation', vocab('attr.operation', {
      kind: 'attribute', value_type: 'choice', labels: { en: 'Operation' },
    })],
    ['attr.device', vocab('attr.device', {
      kind: 'attribute', value_type: 'choice', labels: { en: 'Device' },
    })],
    ['operation.spreading', vocab('operation.spreading', {
      kind: 'choice', parent_code: 'attr.operation', labels: { en: 'Spreading' },
    })],
    ['device.broadcast', vocab('device.broadcast', {
      kind: 'choice', parent_code: 'attr.device', labels: { en: 'Broadcast spreader' },
    })],
  ]),
  templates: new Map(),
  layouts: new Map(),
};

const layout: JournalLayoutDefinition = {
  code: 'open_field',
  version: 3,
  activity_codes: ['irrigation', 'fertilization'],
  supported_templates: ['farmer_quick'],
  fields: [],
  minimum_fields: [],
  conditional_fields: {},
  denominator_contract: [],
  option_dependencies: [
    {
      when: { attribute_code: 'activity_code', equals: 'fertilization' },
      restrict: { attribute_code: 'attr.operation', choices: ['operation.spreading'] },
    },
    {
      when: { attribute_code: 'attr.operation', equals: 'operation.spreading' },
      restrict: { attribute_code: 'attr.device', choices: ['device.broadcast'] },
    },
  ],
};

const independentLayout: JournalLayoutDefinition = {
  ...layout,
  option_dependencies: [
    {
      when: { attribute_code: 'activity_code', equals: 'irrigation' },
      restrict: { attribute_code: 'attr.operation', choices: ['operation.spreading'] },
    },
    {
      when: { attribute_code: 'activity_code', equals: 'fertilization' },
      restrict: { attribute_code: 'attr.device', choices: ['device.broadcast'] },
    },
  ],
};

const farmActivityCodes = ['irrigation', 'fertilization', 'seeding', 'harvest', 'sampling', 'mowing', 'pruning', 'tillage'];
const farmModel: JournalCaptureCatalogModel = {
  vocabByCode: new Map(farmActivityCodes.map((code) => [code, vocab(code)])),
  templates: new Map(),
  layouts: new Map(),
};
const farmLayout: JournalLayoutDefinition = {
  ...layout,
  activity_codes: farmActivityCodes,
  option_dependencies: [],
};

function entry(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: 'entry-1',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'gateway',
    plot_uuid: 'plot-1',
    zone_uuid: 'zone-1',
    device_eui: null,
    season_uuid: 'season-1',
    season_crop: 'Wheat',
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 3,
    catalog_version: 1,
    occurred_start: '2026-07-16T08:00:00.000Z',
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

const leafKey = (leaf: { activity_code: string; dependent_selections: Array<{ attribute_code: string; value: string }> }) =>
  [leaf.activity_code, ...leaf.dependent_selections.map(({ attribute_code, value }) => `${attribute_code}=${value}`)].join('|');

describe('activity shortlist', () => {
  it('retains history for an independent branch whose dependency target is not first', () => {
    const result = buildActivityShortlist({
      entries: [entry({ activity_code: 'fertilization', values: [
        { group_index: 0, attribute_code: 'attr.device', value_status: 'observed', value_text: 'device.broadcast', value_num: null, unit_code: null, entered_value_num: null, entered_unit_code: null },
      ] })],
      model,
      layout: independentLayout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
    });

    expect(deriveActivityLeaves(model, independentLayout).map(leafKey)).toEqual([
      'irrigation|attr.operation=operation.spreading',
      'fertilization|attr.device=device.broadcast',
    ]);
    expect(result.plotRecent.map(leafKey)).toEqual([
      'fertilization|attr.device=device.broadcast',
    ]);
  });

  it('pages a linked plot, derives the newest season, and keeps plot recents separate from seasonal common leaves', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockResolvedValueOnce({
        entries: [
          entry({ entry_uuid: 'new-season', season_uuid: 'season-2', activity_code: 'fertilization', occurred_start: '2026-07-16T08:00:00.000Z', values: [
            { group_index: 0, attribute_code: 'attr.operation', value_status: 'observed', value_text: 'operation.spreading', value_num: null, unit_code: null, entered_value_num: null, entered_unit_code: null },
            { group_index: 0, attribute_code: 'attr.device', value_status: 'observed', value_text: 'device.broadcast', value_num: null, unit_code: null, entered_value_num: null, entered_unit_code: null },
          ] }),
          entry({ entry_uuid: 'old-season', season_uuid: 'season-1', activity_code: 'irrigation', occurred_start: '2026-07-15T08:00:00.000Z' }),
        ],
        next_cursor: 'page-2',
      })
      .mockResolvedValueOnce({
        entries: [entry({ entry_uuid: 'season-2-old', season_uuid: 'season-2', activity_code: 'irrigation', occurred_start: '2026-07-14T08:00:00.000Z' })],
        next_cursor: null,
      });

    const result = await loadActivityShortlist({
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenNthCalledWith(1, expect.objectContaining({
      plot_uuid: 'plot-1', status: 'final', limit: 100, occurred_to: '2026-07-16T09:00:00.000Z',
    }));
    expect(listEntries).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page-2', limit: 100 }));
    expect(result.currentSeasonUuid).toBe('season-2');
    expect(result.plotRecent.map(leafKey)).toEqual([
      'fertilization|attr.operation=operation.spreading|attr.device=device.broadcast',
      'irrigation',
    ]);
    // Common leaves rank by frequency, then newest occurrence, then leaf key.
    // Both leaves occur once here, so the newer fertilization row wins the tie.
    expect(result.seasonCommon.map(leafKey)).toEqual(['fertilization|attr.operation=operation.spreading|attr.device=device.broadcast', 'irrigation']);
    expect(result.farmRecent).toEqual([]);
  });

  it('closes malformed history rows and falls back without a seasonal label when no season exists', () => {
    const result = buildActivityShortlist({
      entries: [
        entry({ entry_uuid: 'malformed', activity_code: '' }),
        entry({ entry_uuid: 'valid', season_uuid: null, activity_code: 'irrigation' }),
      ],
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
    });

    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.seasonCommon).toEqual([]);
    expect(result.currentSeasonUuid).toBeNull();
  });

  it.each([
    '1',
    '2026-07-16T08:30:00',
    '2026-02-30T08:30:00Z',
  ])('excludes malformed API instant %s from current-season derivation', (occurredStart) => {
    const result = buildActivityShortlist({
      entries: [
        entry({
          entry_uuid: `malformed-${occurredStart}`,
          season_uuid: 'season-malformed',
          activity_code: 'unsupported',
          occurred_start: occurredStart,
        }),
        entry({
          entry_uuid: 'valid-season',
          season_uuid: 'season-valid',
          activity_code: 'irrigation',
          occurred_start: '1999-07-16T08:30:00.000Z',
        }),
      ],
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2030-01-01T00:00:00.000Z',
    });

    expect(result.currentSeasonUuid).toBe('season-valid');
    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
  });

  it('accepts strict Z and offset API instants in history ordering and season derivation', () => {
    const result = buildActivityShortlist({
      entries: [
        entry({
          entry_uuid: 'valid-offset',
          season_uuid: 'season-offset',
          activity_code: 'fertilization',
          occurred_start: '2026-07-16T10:30:00+02:00',
          values: [
            { group_index: 0, attribute_code: 'attr.operation', value_status: 'observed', value_text: 'operation.spreading', value_num: null, unit_code: null, entered_value_num: null, entered_unit_code: null },
            { group_index: 0, attribute_code: 'attr.device', value_status: 'observed', value_text: 'device.broadcast', value_num: null, unit_code: null, entered_value_num: null, entered_unit_code: null },
          ],
        }),
        entry({
          entry_uuid: 'valid-z',
          season_uuid: 'season-z',
          activity_code: 'irrigation',
          occurred_start: '2026-07-16T08:00:00.000Z',
        }),
      ],
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
    });

    expect(result.currentSeasonUuid).toBe('season-offset');
    expect(result.plotRecent.map(leafKey)).toEqual([
      'fertilization|attr.operation=operation.spreading|attr.device=device.broadcast',
      'irrigation',
    ]);
  });

  it('derives the current season from the newest valid row before filtering unsupported leaves', () => {
    const result = buildActivityShortlist({
      entries: [
        entry({ entry_uuid: 'unsupported-new-season', season_uuid: 'season-2', activity_code: 'unsupported' }),
        entry({ entry_uuid: 'supported-old-season', season_uuid: 'season-1', activity_code: 'irrigation', occurred_start: '2026-07-15T08:00:00.000Z' }),
      ],
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
    });

    expect(result.currentSeasonUuid).toBe('season-2');
    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.seasonCommon).toEqual([]);
  });

  it('keeps sensorless selected-plot recents plot-labelled instead of relabelling them as farm recents', () => {
    const result = buildActivityShortlist({
      entries: [entry({ entry_uuid: 'sensorless-plot-entry' })],
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
    });

    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.farmRecent).toEqual([]);
    expect(result.seasonCommon).toEqual([]);
    expect(result.currentSeasonUuid).toBeNull();
  });

  it('keeps sensorless plot recents and separately loads distinct farm-wide fallback leaves', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockImplementation(async (filters) => {
        if (filters.plot_uuid === 'plot-1') {
          return {
            entries: [entry({ entry_uuid: 'selected-plot', activity_code: 'irrigation' })],
            next_cursor: null,
          };
        }
        return {
          entries: [
            entry({ entry_uuid: 'other-plot', plot_uuid: 'plot-2', activity_code: 'fertilization', occurred_start: '2026-07-16T08:30:00.000Z' }),
            entry({ entry_uuid: 'farm-level', plot_uuid: null, zone_uuid: null, activity_code: 'irrigation', occurred_start: '2026-07-16T08:00:00.000Z' }),
          ],
          next_cursor: null,
        };
      });

    const result = await loadActivityShortlist({
      model: farmModel,
      layout: farmLayout,
      plotUuid: 'plot-1',
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(listEntries).toHaveBeenNthCalledWith(1, expect.objectContaining({ plot_uuid: 'plot-1' }));
    expect(listEntries).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'final', limit: 100, occurred_to: '2026-07-16T09:00:00.000Z',
    }));
    expect(listEntries.mock.calls[1][0]).not.toHaveProperty('plot_uuid');
    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.farmRecent.map(leafKey)).toEqual(['fertilization', 'irrigation']);
    expect(result.seasonCommon).toEqual([]);
    expect(result.currentSeasonUuid).toBeNull();
  });

  it('uses plot-scoped and farm-level rows for a farm-level selection without seasonal relabelling', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockResolvedValue({
        entries: [
          entry({ entry_uuid: 'plot-entry', plot_uuid: 'plot-2', activity_code: 'fertilization', occurred_start: '2026-07-16T08:30:00.000Z' }),
          entry({ entry_uuid: 'farm-entry', plot_uuid: null, zone_uuid: null, activity_code: 'irrigation', season_uuid: 'season-ignored', occurred_start: '2026-07-16T08:00:00.000Z' }),
        ],
        next_cursor: null,
      });

    const result = await loadActivityShortlist({
      model: farmModel,
      layout: farmLayout,
      plotUuid: null,
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(1);
    expect(listEntries).toHaveBeenCalledWith(expect.objectContaining({
      status: 'final', limit: 100, occurred_to: '2026-07-16T09:00:00.000Z',
    }));
    expect(listEntries.mock.calls[0][0]).not.toHaveProperty('plot_uuid');
    expect(result.plotRecent).toEqual([]);
    expect(result.farmRecent.map(leafKey)).toEqual(['fertilization', 'irrigation']);
    expect(result.seasonCommon).toEqual([]);
    expect(result.currentSeasonUuid).toBeNull();
  });

  it('fails closed for an independent malformed farm fallback without erasing valid plot recents', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockImplementation(async (filters) => {
        if (filters.plot_uuid === 'plot-1') {
          return { entries: [entry({ entry_uuid: 'selected-plot' })], next_cursor: null };
        }
        return { entries: [entry({ entry_uuid: 'partial-farm', plot_uuid: 'plot-2' })], next_cursor: 123 } as unknown as EntryListResponse;
      });

    const result = await loadActivityShortlist({
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.farmRecent).toEqual([]);
  });

  it('fails closed for a rejected farm fallback without erasing valid plot recents', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockImplementation(async (filters) => {
        if (filters.plot_uuid === 'plot-1') {
          return { entries: [entry({ entry_uuid: 'selected-plot' })], next_cursor: null };
        }
        throw new Error('farm history unavailable');
      });

    const result = await loadActivityShortlist({
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.farmRecent).toEqual([]);
  });

  it('fails closed for a farm fallback cursor cycle without erasing valid plot recents', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockImplementation(async (filters) => {
        if (filters.plot_uuid === 'plot-1') {
          return { entries: [entry({ entry_uuid: 'selected-plot' })], next_cursor: null };
        }
        return { entries: [entry({ entry_uuid: 'farm-entry', plot_uuid: 'plot-2' })], next_cursor: 'farm-cycle' };
      });

    const result = await loadActivityShortlist({
      model: farmModel,
      layout: farmLayout,
      plotUuid: 'plot-1',
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(3);
    expect(result.plotRecent.map(leafKey)).toEqual(['irrigation']);
    expect(result.farmRecent).toEqual([]);
  });

  it('uses explicitly farm-level recents and stops after six unique valid leaves', async () => {
    const entries = Array.from({ length: 8 }, (_, index) => entry({
      entry_uuid: `farm-${index}`,
      plot_uuid: null,
      zone_uuid: null,
      season_uuid: index === 0 ? 'season-ignored' : null,
      activity_code: farmActivityCodes[index],
      occurred_start: `2026-07-${String(16 - index).padStart(2, '0')}T08:00:00.000Z`,
    }));
    const listEntries = vi.fn().mockResolvedValue({ entries, next_cursor: 'ignored-after-six' });
    const result = await loadActivityShortlist({
      model: farmModel,
      layout: farmLayout,
      plotUuid: null,
      zoneLinked: false,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(result.farmRecent.map(leafKey)).toEqual(farmActivityCodes.slice(0, 6));
    expect(result.seasonCommon).toEqual([]);
    expect(result.currentSeasonUuid).toBeNull();
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of returning partial history when a page response is malformed', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockResolvedValue({
        entries: [entry({ entry_uuid: 'partial-before-malformed-page' })],
        next_cursor: 123,
      } as unknown as EntryListResponse);

    const result = await loadActivityShortlist({
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(result).toEqual({ plotRecent: [], seasonCommon: [], farmRecent: [], currentSeasonUuid: null });
  });

  it('fails closed when the selected-plot pagination page bound is exhausted', async () => {
    const listEntries = vi.fn<(filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>>()
      .mockImplementation(async () => ({
        entries: [entry({ entry_uuid: `bounded-${listEntries.mock.calls.length}` })],
        next_cursor: `cursor-${listEntries.mock.calls.length}`,
      }));

    const result = await loadActivityShortlist({
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(MAX_ACTIVITY_HISTORY_PAGES);
    expect(result).toEqual({ plotRecent: [], seasonCommon: [], farmRecent: [], currentSeasonUuid: null });
  });

  it('stops a cursor cycle and bounds pathological pagination', async () => {
    const listEntries = vi.fn().mockImplementation(async () => ({
      entries: [entry({ entry_uuid: `entry-${listEntries.mock.calls.length}` })],
      next_cursor: 'same-cursor',
    }));
    const result = await loadActivityShortlist({
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
      listEntries,
    });

    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(listEntries.mock.calls.length).toBeLessThanOrEqual(MAX_ACTIVITY_HISTORY_PAGES);
    expect(result.plotRecent).toEqual([]);
    expect(result.seasonCommon).toEqual([]);
    expect(result.farmRecent).toEqual([]);
    expect(result.currentSeasonUuid).toBeNull();
  });

  // Detailed activity vocabulary plan (Fable P1a, CRITICAL): without the
  // picker_targets knob ALSO governing choiceTargetCodes here (not just
  // deriveActivityLeaves), a device-carrying entry would match NO leaf at
  // all once the picker itself stops at the operation — the device target's
  // leaf-side `expected` would be `null` forever, since deriveActivityLeaves
  // never produces a device-carrying leaf to compare against. That would
  // make "Recent on plot" / "farm recent" permanently empty for every entry
  // on a device-required activity. This guards the fix.
  it('detailed activity vocabulary plan (Fable P1a): a device-carrying entry still matches its operation-depth leaf when picker_targets stops the picker before the device', () => {
    const pickerLayout: JournalLayoutDefinition = { ...layout, picker_targets: ['attr.operation'] };

    // Operation-depth-only: fertilization contributes exactly one leaf — its
    // device target is filtered out of the picker's own expansion entirely.
    expect(deriveActivityLeaves(model, pickerLayout).map(leafKey)).toEqual([
      'irrigation',
      'fertilization|attr.operation=operation.spreading',
    ]);

    // A real captured entry always records BOTH operation and device values
    // (the form sets both regardless of picker depth — Task 5's point).
    const deviceCarryingEntry = entry({
      activity_code: 'fertilization',
      values: [
        {
          group_index: 0, attribute_code: 'attr.operation', value_status: 'observed',
          value_text: 'operation.spreading', value_num: null, unit_code: null,
          entered_value_num: null, entered_unit_code: null,
        },
        {
          group_index: 0, attribute_code: 'attr.device', value_status: 'observed',
          value_text: 'device.broadcast', value_num: null, unit_code: null,
          entered_value_num: null, entered_unit_code: null,
        },
      ],
    });

    const result = buildActivityShortlist({
      entries: [deviceCarryingEntry],
      model,
      layout: pickerLayout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
    });

    expect(result.plotRecent.map(leafKey)).toEqual(['fertilization|attr.operation=operation.spreading']);

    // Unaffected control: the SAME device-carrying entry against a layout
    // with NO picker_targets declared (today's default, matching
    // agroscope_open_field) still matches the full device-depth leaf.
    const unrestrictedResult = buildActivityShortlist({
      entries: [deviceCarryingEntry],
      model,
      layout,
      plotUuid: 'plot-1',
      zoneLinked: true,
      occurrence: '2026-07-16T09:00:00.000Z',
    });
    expect(unrestrictedResult.plotRecent.map(leafKey)).toEqual([
      'fertilization|attr.operation=operation.spreading|attr.device=device.broadcast',
    ]);
  });
});
