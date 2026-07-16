import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, post, put } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('../api', () => ({ api: { get, post, put } }));

import { isJournalUnavailable, journalApi } from '../journalApi';
import type { CreateEntryPayload, UpdateEntryPayload } from '../journalApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
});

describe('journalApi', () => {
  it('fetches the light catalog by default and requests definitions explicitly', async () => {
    get.mockResolvedValue({
      data: {
        catalog_version: 1,
        catalog_hash: 'h',
        vocab: [],
        templates: [],
        layouts: [],
        products: [],
        mappings: [],
      },
    });

    await journalApi.getCatalog();
    expect(get).toHaveBeenCalledWith('/api/journal/catalog');

    await journalApi.getCatalog({ includeDefinitions: true });
    expect(get).toHaveBeenLastCalledWith('/api/journal/catalog', {
      params: { include: 'definitions' },
    });
  });

  it('passes entry filters as query params', async () => {
    get.mockResolvedValue({ data: { entries: [], next_cursor: null } });

    await journalApi.listEntries({ plot_uuid: 'p1', limit: 20 });

    expect(get).toHaveBeenCalledWith('/api/journal/entries', {
      params: { plot_uuid: 'p1', limit: 20 },
    });
  });

  it('sends explicit final then draft write payloads and preserves their receipt shapes', async () => {
    const finalPayload: CreateEntryPayload = {
      base_sync_version: 0,
      status: 'final',
      plot_uuid: '11111111-1111-4111-8111-111111111111',
      zone_uuid: '22222222-2222-4222-8222-222222222222',
      device_eui: 'A84041FFFF123456',
      season_crop: 'barley',
      season_variety: 'Golden',
      campaign_uuid: '33333333-3333-4333-8333-333333333333',
      protocol_code: 'soil-manage-r',
      protocol_version: '2026.1',
      observation_unit_code: 'plot',
      pass_uuid: '44444444-4444-4444-8444-444444444444',
      activity_code: 'irrigation',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-16T08:30:00',
      occurred_end_local: '2026-07-16T08:45:00',
      occurred_timezone: 'Europe/Zurich',
      occurred_utc_offset_minutes: 120,
      occurred_end_utc_offset_minutes: 120,
      duplicate_guard_ack_entry_uuid: '55555555-5555-4555-8555-555555555555',
      values: [
        {
          attribute_code: 'attr.irrigation_depth',
          group_index: 0,
          value_status: 'observed',
          value_num: 12,
          unit_code: 'unit.mm_water',
          entered_value_num: 1.2,
          entered_unit_code: 'unit.cm_water',
        },
      ],
    };
    const finalReceipt = {
      entry_uuid: 'e1',
      outbox_event_uuid: 'o1',
      sync_version: 1,
    };
    const draftPayload: CreateEntryPayload = {
      ...finalPayload,
      entry_uuid: 'e2',
      status: 'draft',
    };
    const draftReceipt = { entry_uuid: 'e2', sync_version: 0 as const };
    post
      .mockResolvedValueOnce({ data: finalReceipt })
      .mockResolvedValueOnce({ data: draftReceipt });

    await expect(journalApi.createEntry(finalPayload)).resolves.toEqual(finalReceipt);
    expect(post).toHaveBeenCalledWith('/api/journal/entries', finalPayload);
    expect(finalPayload.values[0]).toEqual({
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value_status: 'observed',
      value_num: 12,
      unit_code: 'unit.mm_water',
      entered_value_num: 1.2,
      entered_unit_code: 'unit.cm_water',
    });
    expect(finalPayload.values[0]).not.toHaveProperty('value');

    await expect(journalApi.createEntry(draftPayload)).resolves.toEqual(draftReceipt);
    expect(post).toHaveBeenLastCalledWith('/api/journal/entries', draftPayload);
  });

  it('unwraps plot and plot-group collection responses including group members', async () => {
    get
      .mockResolvedValueOnce({ data: { plots: [{ plot_uuid: 'p1' }] } })
      .mockResolvedValueOnce({
        data: { plot_groups: [{ group_uuid: 'g1', members: ['p1'] }] },
      });

    await expect(journalApi.listPlots()).resolves.toEqual([{ plot_uuid: 'p1' }]);
    await expect(journalApi.listPlotGroups()).resolves.toEqual([
      { group_uuid: 'g1', members: ['p1'] },
    ]);
  });

  it('promotes a version-zero draft through the UUID-encoded PUT route', async () => {
    const payload: UpdateEntryPayload = {
      base_sync_version: 0,
      status: 'final',
      plot_uuid: '11111111-1111-4111-8111-111111111111',
      activity_code: 'irrigation',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-16T08:30:00',
      occurred_timezone: 'Europe/Zurich',
      values: [
        {
          attribute_code: 'attr.irrigation_depth',
          value: 12,
          unit_code: 'unit.mm_water',
        },
      ],
    };
    const receipt = {
      entry_uuid: 'e1/segment',
      outbox_event_uuid: 'o2',
      sync_version: 1,
    };
    put.mockResolvedValue({ data: receipt });

    await expect(journalApi.updateEntry('e1/segment', payload)).resolves.toEqual(receipt);
    expect(put).toHaveBeenCalledWith('/api/journal/entries/e1%2Fsegment', payload);
  });

  it('URL-encodes the entry UUID and posts the void reason and base version', async () => {
    const receipt = {
      entry_uuid: 'e1/segment',
      outbox_event_uuid: 'o2',
      sync_version: 2,
    };
    post.mockResolvedValue({ data: receipt });

    await expect(journalApi.voidEntry('e1/segment', 'Duplicate', 1)).resolves.toEqual(receipt);
    expect(post).toHaveBeenCalledWith('/api/journal/entries/e1%2Fsegment/void', {
      void_reason: 'Duplicate',
      base_sync_version: 1,
    });
  });

  it('treats only 404 and 501 responses as journal-unavailable', () => {
    expect(isJournalUnavailable({ response: { status: 404 } })).toBe(true);
    expect(isJournalUnavailable({ response: { status: 501 } })).toBe(true);
    expect(isJournalUnavailable({ response: { status: 500 } })).toBe(false);
  });
});
