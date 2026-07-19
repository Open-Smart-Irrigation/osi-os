import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, post, put } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('../api', () => ({ api: { get, post, put } }));

import { isJournalUnavailable, journalApi } from '../journalApi';
import type { CreateEntryPayload, UpdateEntryPayload } from '../journalApi';
import type {
  BatchMutationReceipt,
  CreateFinalBatchPayload,
  JournalPlot,
  JournalPlotGroupWritePayload,
  JournalPlotWritePayload,
  PlotGroup,
} from '../../types/journal';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
});

describe('journalApi', () => {
  const plotUuid = '11111111-1111-4111-8111-111111111111';
  const secondPlotUuid = '22222222-2222-4222-8222-222222222222';
  const otherPlotUuid = '33333333-3333-4333-8333-333333333333';
  const zoneUuid = '44444444-4444-4444-8444-444444444444';
  const groupUuid = '55555555-5555-4555-8555-555555555555';
  const otherGroupUuid = '66666666-6666-4666-8666-666666666666';
  const entryUuid = '77777777-7777-4777-8777-777777777777';
  const secondEntryUuid = '88888888-8888-4888-8888-888888888888';
  const batchUuid = '99999999-9999-4999-8999-999999999999';
  const outboxUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondOutboxUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const duplicateAckUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ownerUserUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const principalUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  const plotPayload = (uuid = plotUuid): JournalPlotWritePayload => ({
    plot_uuid: uuid,
    base_sync_version: 0,
    plot_code: 'P-1',
    name: 'North field',
    zone_uuid: null,
    station_code: 'S1',
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  });

  const plotFixture = (uuid = plotUuid, syncVersion = 1): JournalPlot => ({
    contract_version: 1,
    plot_uuid: uuid,
    plot_code: 'P-1',
    name: 'North field',
    zone_uuid: null,
    station_code: 'S1',
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    sync_version: syncVersion,
    owner_user_uuid: ownerUserUuid,
    gateway_device_eui: 'A84041FFFF123456',
    created_at: '2026-07-17T08:00:00Z',
    updated_at: '2026-07-17T08:30:00Z',
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: '2026-07-17T08:30:00Z',
      updated_by_principal_uuid: principalUuid,
      sync_version: syncVersion,
    },
  });

  const plotGroupPayload = (uuid = groupUuid): JournalPlotGroupWritePayload => ({
    group_uuid: uuid,
    base_sync_version: 0,
    label: 'Harvest north',
    members: [plotUuid, secondPlotUuid],
    resolved: false,
  });

  const plotGroupFixture = (
    uuid = groupUuid,
    syncVersion = 1,
    resolved = false,
  ): PlotGroup => ({
    contract_version: 1,
    group_uuid: uuid,
    label: 'Harvest north',
    owner_user_uuid: ownerUserUuid,
    gateway_device_eui: 'A84041FFFF123456',
    created_by_principal_uuid: principalUuid,
    created_at: '2026-07-17T08:00:00Z',
    resolved_at: resolved ? '2026-07-17T08:30:00Z' : null,
    resolved_by_principal_uuid: resolved ? principalUuid : null,
    sync_version: syncVersion,
    deleted_at: null,
    members: [plotUuid, secondPlotUuid],
  });

  const validBatch: CreateFinalBatchPayload = {
    status: 'final',
    members: [
      { plot_uuid: plotUuid, entry_uuid: entryUuid },
      { plot_uuid: secondPlotUuid, entry_uuid: secondEntryUuid },
    ],
    base_sync_version: 0,
    duplicate_guard_ack_entry_uuids: [duplicateAckUuid],
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-17T08:30:00',
    occurred_timezone: 'Europe/Zurich',
    values: [{ attribute_code: 'attr.irrigation_depth', value: 12 }],
  };

  // @ts-expect-error batch status is final-only
  const draftBatch: CreateFinalBatchPayload = { ...validBatch, status: 'draft' };
  // @ts-expect-error batch payload has no scalar plot_uuid
  const scalarPlotBatch: CreateFinalBatchPayload = { ...validBatch, plot_uuid: plotUuid };
  // @ts-expect-error batch payload has no zone_uuid
  const zoneBatch: CreateFinalBatchPayload = { ...validBatch, zone_uuid: zoneUuid };
  // @ts-expect-error batch payload has no entry_uuid
  const entryBatch: CreateFinalBatchPayload = { ...validBatch, entry_uuid: entryUuid };
  // @ts-expect-error batch_uuid is edge-generated
  const clientBatch: CreateFinalBatchPayload = { ...validBatch, batch_uuid: batchUuid };
  const singularAckBatch: CreateFinalBatchPayload = {
    ...validBatch,
    // @ts-expect-error singular acknowledgement is not a batch wire field
    duplicate_guard_ack_entry_uuid: duplicateAckUuid,
  };

  void draftBatch;
  void scalarPlotBatch;
  void zoneBatch;
  void entryBatch;
  void clientBatch;
  void singularAckBatch;

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

  it('creates one final batch request with members and returns the edge batch receipt', async () => {
    const receipt: BatchMutationReceipt = {
      batch_uuid: batchUuid,
      entries: [
        {
          plot_uuid: plotUuid,
          entry_uuid: entryUuid,
          outbox_event_uuid: outboxUuid,
          sync_version: 1,
        },
        {
          plot_uuid: secondPlotUuid,
          entry_uuid: secondEntryUuid,
          outbox_event_uuid: secondOutboxUuid,
          sync_version: 1,
        },
      ],
    };
    post.mockResolvedValue({ data: receipt });

    await expect(journalApi.createFinalBatch(validBatch)).resolves.toEqual(receipt);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/journal/entries', validBatch);
    expect(validBatch.status).toBe('final');
    expect(validBatch.base_sync_version).toBe(0);
    expect(Array.isArray(validBatch.members)).toBe(true);
    expect(validBatch.members).toEqual([
      { plot_uuid: plotUuid, entry_uuid: entryUuid },
      { plot_uuid: secondPlotUuid, entry_uuid: secondEntryUuid },
    ]);
    expect(validBatch).not.toHaveProperty('plot_uuid');
    expect(validBatch).not.toHaveProperty('zone_uuid');
  });

  it('creates a plot through POST and returns JournalPlot from data.plot', async () => {
    const payload = plotPayload();
    const plot = plotFixture(plotUuid, 1);
    post.mockResolvedValue({
      data: { plot, outbox_event_uuid: outboxUuid, created: true },
    });

    await expect(journalApi.createPlot(payload)).resolves.toEqual(plot);
    expect(plot.sync_version).toBe(1);
    expect(plot.settings.sync_version).toBe(1);
    expect(post).toHaveBeenCalledWith('/api/journal/plots', payload);
  });

  it('updates a plot through UUID-encoded PUT and returns JournalPlot from data.plot', async () => {
    const payload: JournalPlotWritePayload = {
      ...plotPayload(),
      base_sync_version: 2,
    };
    const plot = plotFixture(plotUuid, 3);
    put.mockResolvedValue({
      data: { plot, outbox_event_uuid: outboxUuid, created: false },
    });

    await expect(journalApi.updatePlot(plotUuid, payload)).resolves.toEqual(plot);
    expect(plot.sync_version).toBe(3);
    expect(plot.settings.sync_version).toBe(3);
    expect(put).toHaveBeenCalledWith(
      `/api/journal/plots/${encodeURIComponent(plotUuid)}`,
      payload,
    );
  });

  it('rejects a plot update when path and body UUIDs differ before PUT', async () => {
    const payload: JournalPlotWritePayload = {
      ...plotPayload(otherPlotUuid),
      base_sync_version: 2,
    };
    put.mockResolvedValue({
      data: {
        plot: plotFixture(otherPlotUuid, 3),
        outbox_event_uuid: outboxUuid,
        created: false,
      },
    });

    await expect(journalApi.updatePlot(plotUuid, payload)).rejects.toThrow(
      'Plot UUID path/body mismatch',
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('creates a plot group through POST and returns PlotGroup from data.plot_group', async () => {
    const payload = plotGroupPayload();
    const plotGroup = plotGroupFixture(groupUuid, 1, false);
    post.mockResolvedValue({
      data: { plot_group: plotGroup, outbox_event_uuid: outboxUuid, created: true },
    });

    await expect(journalApi.createPlotGroup(payload)).resolves.toEqual(plotGroup);
    expect(plotGroup.sync_version).toBe(1);
    expect(post).toHaveBeenCalledWith('/api/journal/plot-groups', payload);
  });

  it('updates a plot group through UUID-encoded PUT and returns PlotGroup from data.plot_group', async () => {
    const payload: JournalPlotGroupWritePayload = {
      ...plotGroupPayload(),
      base_sync_version: 3,
      resolved: true,
    };
    const plotGroup = plotGroupFixture(groupUuid, 4, true);
    put.mockResolvedValue({
      data: { plot_group: plotGroup, outbox_event_uuid: outboxUuid, created: false },
    });

    await expect(journalApi.updatePlotGroup(groupUuid, payload)).resolves.toEqual(plotGroup);
    expect(plotGroup.sync_version).toBe(4);
    expect(put).toHaveBeenCalledWith(
      `/api/journal/plot-groups/${encodeURIComponent(groupUuid)}`,
      payload,
    );
  });

  it('rejects a plot-group update when path and body UUIDs differ before PUT', async () => {
    const payload: JournalPlotGroupWritePayload = {
      ...plotGroupPayload(otherGroupUuid),
      base_sync_version: 3,
      resolved: true,
    };
    put.mockResolvedValue({
      data: {
        plot_group: plotGroupFixture(otherGroupUuid, 4, true),
        outbox_event_uuid: outboxUuid,
        created: false,
      },
    });

    await expect(journalApi.updatePlotGroup(groupUuid, payload)).rejects.toThrow(
      'Plot-group UUID path/body mismatch',
    );
    expect(put).not.toHaveBeenCalled();
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

  it('discards a draft through the same UUID-encoded PUT route with a discard body', async () => {
    const receipt = { entry_uuid: 'e1/segment', discarded: true as const };
    put.mockResolvedValue({ data: receipt });

    await expect(journalApi.discardDraft('e1/segment')).resolves.toEqual(receipt);
    expect(put).toHaveBeenCalledWith('/api/journal/entries/e1%2Fsegment', { discard: true });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('treats only 404 and 501 responses as journal-unavailable', () => {
    expect(isJournalUnavailable({ response: { status: 404 } })).toBe(true);
    expect(isJournalUnavailable({ response: { status: 501 } })).toBe(true);
    expect(isJournalUnavailable({ response: { status: 500 } })).toBe(false);
  });
});
