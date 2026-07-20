// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { JournalVocabRow } from '../../../../types/journal';
import type { JournalCaptureCatalogModel } from '../../../../types/journalCapture';
import { CycleDisambiguationSheet } from '../CycleDisambiguationSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const timestamp = '2026-07-20T00:00:00.000Z';

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

describe('CycleDisambiguationSheet', () => {
  it('lists every open cycle option with crop + variety and reports the chosen cycle_uuid', () => {
    const onChoose = vi.fn();
    render(
      <CycleDisambiguationSheet
        model={model}
        locale="en"
        options={[
          { cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
          { cycle_uuid: 'cycle-2', crop_code: 'agroscope.crop.barley_spring', variety: null },
        ]}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('alertdialog', { name: 'capture.cycle.disambiguationTitle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Winter wheat · Marlene' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spring barley' }));
    expect(onChoose).toHaveBeenCalledWith('cycle-2');
  });

  it('calls onCancel from the cancel action', () => {
    const onCancel = vi.fn();
    render(
      <CycleDisambiguationSheet
        model={model}
        locale="en"
        options={[{ cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: null }]}
        onChoose={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'where.cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
