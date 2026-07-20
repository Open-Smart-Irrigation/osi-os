// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { JournalVocabRow } from '../../../../types/journal';
import type { JournalCaptureCatalogModel } from '../../../../types/journalCapture';
import { SeedingCropFields } from '../SeedingCropFields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key}:${Object.values(values).join(',')}`
      : key,
  }),
}));

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

const model: JournalCaptureCatalogModel = {
  vocabByCode: new Map([
    ['agroscope.crop.wheat_winter', vocabRow({
      code: 'agroscope.crop.wheat_winter', kind: 'choice', parent_code: 'attr.crop', labels: { en: 'Winter wheat' },
    })],
    ['agroscope.crop.barley_spring', vocabRow({
      code: 'agroscope.crop.barley_spring', kind: 'choice', parent_code: 'attr.crop', labels: { en: 'Spring barley' },
    })],
  ]),
  templates: new Map(),
  layouts: new Map(),
};

function renderFields(overrides: Partial<React.ComponentProps<typeof SeedingCropFields>> = {}) {
  return render(
    <SeedingCropFields
      model={model}
      locale="en"
      crop=""
      variety=""
      onCropChange={vi.fn()}
      onVarietyChange={vi.fn()}
      varietySuggestions={[]}
      overlap={null}
      cycleAction={null}
      onCycleActionChange={vi.fn()}
      {...overrides}
    />,
  );
}

describe('SeedingCropFields', () => {
  it('renders the controlled crop list and emits the chosen code', () => {
    const onCropChange = vi.fn();
    renderFields({ onCropChange });

    const select = screen.getByLabelText('capture.cycle.cropLabel') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: 'Winter wheat' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Spring barley' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'agroscope.crop.wheat_winter' } });
    expect(onCropChange).toHaveBeenCalledWith('agroscope.crop.wheat_winter');
  });

  it('emits variety text and offers autocomplete suggestions', () => {
    const onVarietyChange = vi.fn();
    renderFields({ onVarietyChange, varietySuggestions: ['Marlene', 'Runal'] });

    const input = screen.getByLabelText('capture.cycle.varietyLabel');
    fireEvent.change(input, { target: { value: 'Marl' } });
    expect(onVarietyChange).toHaveBeenCalledWith('Marl');
    const options = Array.from(document.querySelectorAll('datalist option')).map(
      (option) => option.getAttribute('value'),
    );
    expect(options).toEqual(['Marlene', 'Runal']);
  });

  it('does not show the same-crop prompt when there is no overlap', () => {
    renderFields({ crop: 'agroscope.crop.wheat_winter', variety: 'Marlene', overlap: null });
    expect(screen.queryByText('capture.cycle.sameCropTitle')).not.toBeInTheDocument();
  });

  it('does not show the prompt for a differing crop/variety overlap (auto-reseed, no prompt needed)', () => {
    renderFields({
      crop: 'agroscope.crop.wheat_winter',
      variety: 'Marlene',
      overlap: { crop_code: 'agroscope.crop.barley_spring', variety: null },
    });
    expect(screen.queryByText('capture.cycle.sameCropTitle')).not.toBeInTheDocument();
  });

  it('shows the continue/new prompt when crop+variety exactly match an open cycle, and threads the choice', () => {
    const onCycleActionChange = vi.fn();
    renderFields({
      crop: 'agroscope.crop.wheat_winter',
      variety: 'Marlene',
      overlap: { crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
      onCycleActionChange,
    });

    expect(screen.getByText('capture.cycle.sameCropTitle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.continueCycle' }));
    expect(onCycleActionChange).toHaveBeenCalledWith('continue');
    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.startNewCycle' }));
    expect(onCycleActionChange).toHaveBeenCalledWith('new');
  });

  it('requires an explicit choice under validation once the prompt is showing', () => {
    renderFields({
      crop: 'agroscope.crop.wheat_winter',
      variety: 'Marlene',
      overlap: { crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
      cycleAction: null,
      showValidation: true,
    });
    expect(screen.getByText('capture.cycle.cycleActionRequired')).toBeInTheDocument();
  });

  it('shows a required-crop validation message once validation is requested', () => {
    renderFields({ crop: '', showValidation: true });
    expect(screen.getByText('capture.cycle.cropRequired')).toBeInTheDocument();
  });

  // Review fix: when the catalog's own template already owns attr.crop
  // (formOwnsCrop), the parent passes showCropField={false} so this
  // component never renders a second, independently-stated crop control —
  // only variety + the same-crop prompt remain its responsibility.
  it('hides its own crop dropdown when showCropField is false, but still shows variety and the prompt', () => {
    renderFields({
      showCropField: false,
      crop: 'agroscope.crop.wheat_winter',
      variety: 'Marlene',
      overlap: { crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
      showValidation: true,
    });
    expect(screen.queryByLabelText('capture.cycle.cropLabel')).not.toBeInTheDocument();
    expect(screen.queryByText('capture.cycle.cropRequired')).not.toBeInTheDocument();
    expect(screen.getByLabelText('capture.cycle.varietyLabel')).toBeInTheDocument();
    expect(screen.getByText('capture.cycle.sameCropTitle')).toBeInTheDocument();
  });
});
