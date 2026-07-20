// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  updateEntry: vi.fn(),
}));

vi.mock('../../../../services/journalApi', () => ({
  journalApi: apiMocks,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key}:${Object.values(values).join(',')}`
      : key,
  }),
}));

import type { EntryAggregate, EntryValue, JournalVocabRow } from '../../../../types/journal';
import type { JournalCaptureCatalogModel } from '../../../../types/journalCapture';
import { InheritedCropBanner } from '../InheritedCropBanner';

const timestamp = '2026-07-01T08:00:00.000Z';
const seedingEntryUuid = '11111111-1111-4111-8111-111111111111';

function vocabRow(overrides: Partial<JournalVocabRow> & { code: string }): JournalVocabRow {
  return {
    kind: 'choice',
    parent_code: 'attr.crop',
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
    labels: { en: overrides.code },
    constraints: null,
    ...overrides,
  };
}

const model: JournalCaptureCatalogModel = {
  vocabByCode: new Map([
    ['agroscope.crop.wheat_winter', vocabRow({ code: 'agroscope.crop.wheat_winter', labels: { en: 'Winter wheat' } })],
    ['agroscope.crop.barley_spring', vocabRow({ code: 'agroscope.crop.barley_spring', labels: { en: 'Spring barley' } })],
  ]),
  templates: new Map(),
  layouts: new Map(),
};

function entryValue(attributeCode: string, valueText: string): EntryValue {
  return {
    group_index: 0,
    attribute_code: attributeCode,
    value_status: 'observed',
    value_num: null,
    value_text: valueText,
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
  };
}

function seedingAggregate(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: seedingEntryUuid,
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
    sync_version: 3,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [
      entryValue('attr.crop', 'agroscope.crop.wheat_winter'),
      entryValue('attr.variety', 'Marlene'),
    ],
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.listEntries.mockReset();
  apiMocks.updateEntry.mockReset().mockResolvedValue({
    entry_uuid: seedingEntryUuid, sync_version: 4, outbox_event_uuid: 'outbox-1',
  });
});

describe('InheritedCropBanner', () => {
  it('renders the read-only crop · variety · seeded date banner from the live-resolved crop', () => {
    render(
      <InheritedCropBanner
        model={model}
        locale="en"
        cropCode="agroscope.crop.wheat_winter"
        variety="Marlene"
        seededDate="2026-07-01"
        seedingEntryUuid={seedingEntryUuid}
      />,
    );
    expect(screen.getByRole('button', { name: 'capture.cycle.bannerCropVariety:Winter wheat,Marlene' })).toBeInTheDocument();
    expect(screen.getByText(/capture.cycle.bannerSeeded/)).toBeInTheDocument();
  });

  it('links the seeded date to the seeding entry when a handler is supplied', () => {
    const onOpenSeedingEntry = vi.fn();
    render(
      <InheritedCropBanner
        model={model}
        locale="en"
        cropCode="agroscope.crop.wheat_winter"
        variety="Marlene"
        seededDate="2026-07-01"
        seedingEntryUuid={seedingEntryUuid}
        onOpenSeedingEntry={onOpenSeedingEntry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /capture.cycle.bannerSeeded/ }));
    expect(onOpenSeedingEntry).toHaveBeenCalledWith(seedingEntryUuid);
  });

  it('opens the inline correction sheet, prefills from the fetched seeding entry, and posts the correction to it', async () => {
    apiMocks.listEntries.mockResolvedValue({ entries: [seedingAggregate()], next_cursor: null });
    const onCorrected = vi.fn();
    render(
      <InheritedCropBanner
        model={model}
        locale="en"
        cropCode="agroscope.crop.wheat_winter"
        variety="Marlene"
        seededDate="2026-07-01"
        seedingEntryUuid={seedingEntryUuid}
        onCorrected={onCorrected}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.bannerCropVariety:Winter wheat,Marlene' }));
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalledWith({
      entry_uuid: seedingEntryUuid, status: 'all', limit: 1,
    }));

    const cropSelect = await screen.findByDisplayValue('Winter wheat');
    expect(cropSelect).toBeInTheDocument();
    const varietyInput = screen.getByDisplayValue('Marlene') as HTMLInputElement;

    fireEvent.change(cropSelect, { target: { value: 'agroscope.crop.barley_spring' } });
    fireEvent.change(varietyInput, { target: { value: 'Django' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.correctSave' }));

    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(1));
    const [calledUuid, payload] = apiMocks.updateEntry.mock.calls[0];
    expect(calledUuid).toBe(seedingEntryUuid);
    expect(payload.entry_uuid).toBe(seedingEntryUuid);
    expect(payload.base_sync_version).toBe(3);
    expect(payload.plot_uuid).toBe('plot-a');
    expect(payload.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_code: 'attr.crop', value: 'agroscope.crop.barley_spring' }),
      expect.objectContaining({ attribute_code: 'attr.variety', value: 'Django' }),
    ]));
    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
  });

  it('shows a stale-version error and does not call onCorrected when the update conflicts', async () => {
    apiMocks.listEntries.mockResolvedValue({ entries: [seedingAggregate()], next_cursor: null });
    apiMocks.updateEntry.mockReset().mockRejectedValue({ response: { status: 409, data: {} } });
    const onCorrected = vi.fn();
    render(
      <InheritedCropBanner
        model={model}
        locale="en"
        cropCode="agroscope.crop.wheat_winter"
        variety="Marlene"
        seededDate="2026-07-01"
        seedingEntryUuid={seedingEntryUuid}
        onCorrected={onCorrected}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.bannerCropVariety:Winter wheat,Marlene' }));
    await screen.findByDisplayValue('Winter wheat');
    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.correctSave' }));

    await waitFor(() => expect(screen.getByText('capture.cycle.correctStale')).toBeInTheDocument());
    expect(onCorrected).not.toHaveBeenCalled();
  });
});
