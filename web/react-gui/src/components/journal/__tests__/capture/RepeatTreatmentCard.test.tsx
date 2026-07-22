// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ value: 'en' }));
const translations: Record<string, string> = {
  'capture.carry.repeatTreatment': 'Repeat last treatment',
  'capture.carry.repeatTreatmentDescription': 'Review the previous treatment',
  'capture.carry.sourceDate': 'Previous date',
  'capture.carry.crop': 'Crop',
  'capture.carry.product': 'Product',
  'capture.carry.rate': 'Rate',
  'capture.carry.protectedValues': 'Protected values',
  'capture.carry.unknownProduct': 'Product unavailable',
  'capture.carry.unknownRate': 'Rate unavailable',
  'capture.carry.unknownValue': 'Value unavailable',
  'capture.carry.valueStatus.observed': 'Observed',
  'capture.carry.valueStatus.not_observed': 'Not observed',
  'capture.carry.valueStatus.not_applicable': 'Not applicable',
  'capture.carry.valueStatus.below_detection': 'Below detection',
  'capture.carry.group': 'Group {{number}}',
  'capture.carry.useValues': 'Use these values',
  'capture.carry.dismiss': 'Do not copy',
  'capture.carry.invalidated': 'The previous treatment no longer matches',
  'capture.validation.invalidDefinition': 'This journal form is not available',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { number?: number }) =>
      (translations[key] ?? key).replace('{{number}}', String(options?.number ?? '')),
    i18n: { language: language.value, resolvedLanguage: language.value },
  }),
}));

import { RepeatTreatmentCard } from '../../capture/RepeatTreatmentCard';
import { partitionCarryForward } from '../../../../journal/carryForward';
import type {
  CarryForwardCandidate,
  CarryForwardContext,
  CarryForwardEntry,
} from '../../../../journal/carryForward';
import type { EntryValue } from '../../../../types/journal';

const context: CarryForwardContext = {
  plot_uuid: 'plot-1',
  crop: 'Wheat',
  activity_code: 'plant_protection_application',
  occurred_start: '2026-07-16T08:00:00.000Z',
  season_uuid: 'season-1',
  layout_code: 'open_field',
  layout_version: 1,
};

function entryValue(
  attribute_code: string,
  value_text: string,
  overrides: Partial<EntryValue> = {},
): EntryValue {
  return {
    group_index: 0,
    attribute_code,
    value_status: 'observed',
    value_num: null,
    value_text,
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
    ...overrides,
  };
}

const candidate = {
  context,
  repeatTreatment: {
    complete: true,
    sourceEntryUuid: 'source-1',
    sourceDate: '2026-07-15T08:00:00.000Z',
    crop: 'Wheat',
    product: 'Product A',
    rate: '2 kg/ha',
    values: [{ attribute_code: 'attr.product_uuid', value: 'product-1' }],
    context,
  },
  source: {} as CarryForwardCandidate['source'],
  draft: {} as CarryForwardCandidate['draft'],
} satisfies CarryForwardCandidate;

describe('RepeatTreatmentCard', () => {
  it('renders catalog-resolved product and unit labels from real source values', () => {
    const source: CarryForwardEntry = {
      entry_uuid: 'source-real',
      status: 'final',
      plot_uuid: context.plot_uuid,
      season_uuid: context.season_uuid,
      season_crop: context.crop,
      activity_code: context.activity_code,
      occurred_start: '2026-07-15T08:00:00.000Z',
      layout_code: context.layout_code,
      layout_version: context.layout_version,
      values: [
        {
          group_index: 0,
          attribute_code: 'attr.product_uuid',
          value_status: 'observed',
          value_num: null,
          value_text: 'product-1',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.amount_mass_area_product',
          value_status: 'observed',
          value_num: 2000,
          value_text: null,
          unit_code: 'unit.g_per_ha_product',
          entered_value_num: 2,
          entered_unit_code: 'unit.kg_per_ha_product',
        },
      ] satisfies EntryValue[],
    };
    const partition = partitionCarryForward(
      source,
      { carry_forward: [] },
      {
        productLabels: new Map([['product-1', 'Catalog Product']]),
        unitLabels: new Map([['unit.kg_per_ha_product', 'kg/ha']]),
      },
    );
    const realCandidate: CarryForwardCandidate = {
      context,
      source,
      draft: {
        ...source,
        entry_uuid: 'draft-real',
        status: 'draft',
        occurred_start: context.occurred_start,
      },
      repeatTreatment: partition.repeatTreatment,
    };

    render(
      <RepeatTreatmentCard
        candidate={realCandidate}
        currentContext={context}
        catalog={{
          products: [{ product_uuid: 'product-1', name: 'Catalog Product' }],
          vocab: [
            { code: 'attr.product_uuid', kind: 'attribute', labels: { en: 'Catalog product' } },
            { code: 'attr.amount_mass_area_product', kind: 'attribute', labels: { en: 'Product rate' } },
            { code: 'unit.kg_per_ha_product', kind: 'unit', labels: { en: 'kg/ha' } },
          ],
        }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Catalog product · Group 1: Catalog Product')).toBeInTheDocument();
    expect(screen.getByText('Product rate · Group 1: 2 kg/ha')).toBeInTheDocument();
    expect(screen.queryByText('product-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/unit\./)).not.toBeInTheDocument();
  });

  it('renders a hollow preview with source date, crop, product, and rate', () => {
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        catalog={{
          products: [{ product_uuid: 'product-1', name: 'Product A' }],
          vocab: [{ code: 'attr.product_uuid', kind: 'attribute', labels: { en: 'Catalog product' } }],
        }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Repeat last treatment' })).toBeInTheDocument();
    expect(screen.getByText('Wheat')).toBeInTheDocument();
    expect(screen.getByText('Catalog product · Group 1: Product A')).toBeInTheDocument();
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', '2026-07-15T08:00:00.000Z');
    expect(screen.getByRole('article')).toHaveClass('border-dashed');
  });

  // BUG 3: treatment.crop can be a choice CODE (e.g.
  // agroscope.crop.barley_spring), not a display string -- resolve it via
  // catalog.vocab + catalogLabel the same way InheritedCropBanner.tsx does,
  // instead of rendering the raw code.
  it('resolves a choice-code crop to its catalog label instead of the raw code', () => {
    const codedCandidate: CarryForwardCandidate = {
      ...candidate,
      repeatTreatment: {
        ...candidate.repeatTreatment!,
        crop: 'agroscope.crop.barley_spring',
      },
    };
    render(
      <RepeatTreatmentCard
        candidate={codedCandidate}
        currentContext={context}
        catalog={{
          products: [{ product_uuid: 'product-1', name: 'Product A' }],
          vocab: [
            { code: 'attr.product_uuid', kind: 'attribute', labels: { en: 'Catalog product' } },
            {
              code: 'agroscope.crop.barley_spring',
              kind: 'choice',
              labels: { en: 'Barley, spring' },
            },
          ],
        }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Barley, spring')).toBeInTheDocument();
    expect(screen.queryByText('agroscope.crop.barley_spring')).not.toBeInTheDocument();
  });

  it('falls back to the raw crop code when the catalog has no matching vocab row', () => {
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        catalog={{
          products: [{ product_uuid: 'product-1', name: 'Product A' }],
          vocab: [{ code: 'attr.product_uuid', kind: 'attribute', labels: { en: 'Catalog product' } }],
        }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    // 'Wheat' is a plain fixture string here, not a catalog code -- no
    // matching vocab row, so it renders as-is (unchanged pre-existing
    // behavior for a non-coded crop value).
    expect(screen.getByText('Wheat')).toBeInTheDocument();
  });

  it('does not emit protected values until the farmer confirms, and supports dismissal', () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );

    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
    expect(onConfirm).toHaveBeenCalledWith(candidate.repeatTreatment?.values);
    fireEvent.click(screen.getByRole('button', { name: 'Do not copy' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('uses parent-owned acceptance to disable an already accepted treatment', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        accepted={false}
        onConfirm={onConfirm}
        onDismiss={vi.fn()}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Use these values' });
    fireEvent.click(confirm);
    rerender(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        accepted
        onConfirm={onConfirm}
        onDismiss={vi.fn()}
      />,
    );

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
  });

  it('does not invalidate a complete confirmed treatment on generic unmount', () => {
    const source: CarryForwardCandidate['source'] = {
      ...(candidate.source as CarryForwardCandidate['source']),
      entry_uuid: 'source-complete',
      status: 'final',
      plot_uuid: context.plot_uuid,
      season_uuid: context.season_uuid,
      season_crop: context.crop,
      activity_code: context.activity_code,
      occurred_start: context.occurred_start,
      layout_code: context.layout_code,
      layout_version: context.layout_version,
      values: [
        entryValue('attr.product_uuid', 'product-1'),
        entryValue('attr.amount_mass_area_product', '2', {
          value_text: null,
          value_num: 2,
          unit_code: 'unit.kg_per_ha_product',
          entered_value_num: 2,
          entered_unit_code: 'unit.kg_per_ha_product',
        }),
        entryValue('attr.treated_area', '1200', {
          value_text: null,
          value_num: 1200,
          unit_code: 'unit.m2_area',
          entered_value_num: 1200,
          entered_unit_code: 'unit.m2_area',
        }),
        entryValue('attr.denominator', 'choice.denominator.area'),
      ] satisfies EntryValue[],
    };
    const partition = partitionCarryForward(
      source,
      { carry_forward: [] },
      { productLabels: new Map([['product-1', 'Product A']]), unitLabels: new Map([['unit.kg_per_ha_product', 'kg/ha']]) },
    );
    const completeCandidate: CarryForwardCandidate = {
      context,
      source,
      draft: source,
      repeatTreatment: partition.repeatTreatment,
    };
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <RepeatTreatmentCard
        candidate={completeCandidate}
        currentContext={context}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
    rerender(<div data-context="plot-2-protected-culture" />);

    expect(onConfirm).toHaveBeenCalledWith(partition.repeatTreatment?.values);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('discloses every protected row in a real multi-group treatment without exposing codes', () => {
    const source: CarryForwardCandidate['source'] = {
      ...(candidate.source as CarryForwardCandidate['source']),
      entry_uuid: 'source-multi-group',
      status: 'final',
      plot_uuid: context.plot_uuid,
      season_uuid: context.season_uuid,
      season_crop: context.crop,
      activity_code: context.activity_code,
      occurred_start: context.occurred_start,
      layout_code: context.layout_code,
      layout_version: context.layout_version,
      values: [
        entryValue('attr.product_uuid', 'product-1', { group_index: 0 }),
        entryValue('attr.product', 'Hand-entered mix', { group_index: 0 }),
        entryValue('attr.amount_mass_area_product', '', {
          group_index: 0,
          value_text: null,
          value_num: 2,
          unit_code: 'unit.g_per_ha_product',
          entered_value_num: 2,
          entered_unit_code: 'unit.kg_per_ha_product',
        }),
        entryValue('attr.amount_volume_area_product', '', {
          group_index: 0,
          value_text: null,
          value_num: 4,
          unit_code: 'unit.l_per_ha_product',
          entered_value_num: 4,
          entered_unit_code: 'unit.l_per_ha_product',
        }),
        entryValue('attr.product_uuid', 'product-2', { group_index: 1 }),
        entryValue('attr.amount_mass_area_product', '', {
          group_index: 1,
          value_text: null,
          value_num: 3,
          unit_code: 'unit.g_per_ha_product',
          entered_value_num: 3,
          entered_unit_code: 'unit.kg_per_ha_product',
        }),
      ] satisfies EntryValue[],
    };
    const partition = partitionCarryForward(source, { carry_forward: [] }, {
      productLabels: new Map([
        ['product-1', 'Product A'],
        ['product-2', 'Product B'],
      ]),
      unitLabels: new Map([
        ['unit.kg_per_ha_product', 'kg/ha'],
        ['unit.l_per_ha_product', 'L/ha'],
      ]),
    });
    const onConfirm = vi.fn();
    const localizedCatalog = {
      products: [
        { product_uuid: 'product-1', name: 'Product A' },
        { product_uuid: 'product-2', name: 'Product B' },
      ],
      vocab: [
        { code: 'attr.product_uuid', kind: 'attribute' as const, labels: { en: 'Catalog product' } },
        { code: 'attr.product', kind: 'attribute' as const, labels: { en: 'Product name' } },
        { code: 'attr.amount_mass_area_product', kind: 'attribute' as const, labels: { en: 'Mass rate' } },
        { code: 'attr.amount_volume_area_product', kind: 'attribute' as const, labels: { en: 'Volume rate' } },
        { code: 'unit.kg_per_ha_product', kind: 'unit' as const, labels: { en: 'kg/ha' } },
        { code: 'unit.l_per_ha_product', kind: 'unit' as const, labels: { en: 'L/ha' } },
      ],
    };

    render(
      <RepeatTreatmentCard
        candidate={{ ...candidate, source, repeatTreatment: partition.repeatTreatment }}
        currentContext={context}
        catalog={localizedCatalog}
        onConfirm={onConfirm}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Catalog product · Group 1: Product A')).toBeInTheDocument();
    expect(screen.getByText('Product name · Group 1: Hand-entered mix')).toBeInTheDocument();
    expect(screen.getByText('Mass rate · Group 1: 2 kg/ha')).toBeInTheDocument();
    expect(screen.getByText('Volume rate · Group 1: 4 L/ha')).toBeInTheDocument();
    expect(screen.getByText('Catalog product · Group 2: Product B')).toBeInTheDocument();
    expect(screen.getByText('Mass rate · Group 2: 3 kg/ha')).toBeInTheDocument();
    expect(screen.queryByText(/product-[12]|attr\.|unit\./)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
    expect(onConfirm).toHaveBeenCalledWith(partition.repeatTreatment?.values);
  });

  it('blocks confirmation when any grouped treatment is incomplete', () => {
    const source: CarryForwardCandidate['source'] = {
      ...(candidate.source as CarryForwardCandidate['source']),
      entry_uuid: 'source-incomplete-group',
      status: 'final',
      plot_uuid: context.plot_uuid,
      season_uuid: context.season_uuid,
      season_crop: context.crop,
      activity_code: context.activity_code,
      occurred_start: context.occurred_start,
      layout_code: context.layout_code,
      layout_version: context.layout_version,
      values: [
        entryValue('attr.product_uuid', 'product-1', { group_index: 0 }),
        entryValue('attr.amount_mass_area_product', '', {
          group_index: 0,
          value_text: null,
          value_num: 2,
          unit_code: 'unit.kg_per_ha_product',
          entered_value_num: 2,
          entered_unit_code: 'unit.kg_per_ha_product',
        }),
        entryValue('attr.product_uuid', 'product-2', { group_index: 1 }),
      ] satisfies EntryValue[],
    };
    const partition = partitionCarryForward(source, { carry_forward: [] }, {
      productLabels: new Map([
        ['product-1', 'Product A'],
        ['product-2', 'Product B'],
      ]),
      unitLabels: new Map([['unit.kg_per_ha_product', 'kg/ha']]),
    });
    render(
      <RepeatTreatmentCard
        candidate={{ ...candidate, source, repeatTreatment: partition.repeatTreatment }}
        currentContext={context}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('This journal form is not available');
    expect(screen.queryByRole('button', { name: 'Use these values' })).not.toBeInTheDocument();
  });

  it('uses localized catalog labels without exposing codes or duplicating the first group', () => {
    language.value = 'es';
    const source: CarryForwardCandidate['source'] = {
      ...(candidate.source as CarryForwardCandidate['source']),
      entry_uuid: 'source-spanish',
      status: 'final',
      plot_uuid: context.plot_uuid,
      season_uuid: context.season_uuid,
      season_crop: context.crop,
      activity_code: context.activity_code,
      occurred_start: context.occurred_start,
      layout_code: context.layout_code,
      layout_version: context.layout_version,
      values: [
        entryValue('attr.product_uuid', 'product-1', { group_index: 0 }),
        entryValue('attr.amount_mass_area_product', '', {
          group_index: 0,
          value_text: null,
          value_num: 2,
          unit_code: 'unit.kg_per_ha_product',
          entered_value_num: 2,
          entered_unit_code: 'unit.kg_per_ha_product',
        }),
        entryValue('attr.denominator', 'choice.denominator.area'),
      ] satisfies EntryValue[],
    };
    const partition = partitionCarryForward(source, { carry_forward: [] }, {
      productLabels: new Map([['product-1', 'Producto A']]),
      unitLabels: new Map([['unit.kg_per_ha_product', 'kg/ha']]),
    });
    const localizedCatalog = {
      products: [{ product_uuid: 'product-1', name: 'Producto A' }],
      vocab: [
        { code: 'attr.denominator', kind: 'attribute' as const, labels: { en: 'Denominator', es: 'Denominador' } },
        { code: 'choice.denominator.area', kind: 'choice' as const, labels: { en: 'Area', es: 'Área' } },
        { code: 'unit.kg_per_ha_product', kind: 'unit' as const, labels: { en: 'kg/ha', es: 'kg/ha' } },
      ],
    };

    try {
      render(
        <RepeatTreatmentCard
          candidate={{ ...candidate, source, repeatTreatment: partition.repeatTreatment }}
          currentContext={context}
          catalog={localizedCatalog}
          onConfirm={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByText('Denominador · Group 1: Área')).toBeInTheDocument();
      expect(screen.queryByText(/attr\.|choice\.|unit\.|product-/)).not.toBeInTheDocument();
    } finally {
      language.value = 'en';
    }
  });

  it('localizes a non-English not-observed disclosure instead of exposing the status code', () => {
    language.value = 'de-CH';
    translations['capture.carry.valueStatus.not_observed'] = 'Nicht beobachtet';
    const source: CarryForwardCandidate['source'] = {
      ...(candidate.source as CarryForwardCandidate['source']),
      entry_uuid: 'source-status-label',
      status: 'final',
      plot_uuid: context.plot_uuid,
      season_uuid: context.season_uuid,
      season_crop: context.crop,
      activity_code: context.activity_code,
      occurred_start: context.occurred_start,
      layout_code: context.layout_code,
      layout_version: context.layout_version,
      values: [
        entryValue('attr.product_uuid', 'product-1'),
        entryValue('attr.amount_mass_area_product', '', {
          value_text: null,
          value_num: 2,
          unit_code: 'unit.kg_per_ha_product',
          entered_value_num: 2,
          entered_unit_code: 'unit.kg_per_ha_product',
        }),
        entryValue('attr.denominator', '', {
          value_status: 'not_observed',
          value_text: null,
        }),
      ] satisfies EntryValue[],
    };
    const partition = partitionCarryForward(source, { carry_forward: [] }, {
      productLabels: new Map([['product-1', 'Produkt A']]),
      unitLabels: new Map([['unit.kg_per_ha_product', 'kg/ha']]),
    });
    const localizedCatalog = {
      products: [{ product_uuid: 'product-1', name: 'Produkt A' }],
      vocab: [
        { code: 'attr.denominator', kind: 'attribute' as const, labels: { en: 'Denominator', 'de-CH': 'Nenner' } },
      ],
    };

    try {
      render(
        <RepeatTreatmentCard
          candidate={{ ...candidate, source, repeatTreatment: partition.repeatTreatment }}
          currentContext={context}
          catalog={localizedCatalog}
          onConfirm={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByText('Nenner · Group 1: Nicht beobachtet')).toBeInTheDocument();
      expect(screen.queryByText('not_observed')).not.toBeInTheDocument();
    } finally {
      translations['capture.carry.valueStatus.not_observed'] = 'Not observed';
      language.value = 'en';
    }
  });

  it('treats non-observed and unknown runtime statuses as terminal localized disclosures', () => {
    const statusCandidate: CarryForwardCandidate = {
      ...candidate,
      repeatTreatment: candidate.repeatTreatment && {
        ...candidate.repeatTreatment,
        values: [
          {
            attribute_code: 'attr.product_uuid',
            group_index: 0,
            value_status: 'not_observed',
            value_text: 'product-1',
            entered_unit_code: 'unit.kg_per_ha_product',
          },
          {
            attribute_code: 'attr.amount_mass_area_product',
            group_index: 0,
            value_status: 'not_applicable',
            value_num: 2000,
            entered_value_num: 2,
            entered_unit_code: 'unit.kg_per_ha_product',
          },
          {
            attribute_code: 'attr.denominator',
            group_index: 0,
            value_status: 'below_detection',
            value_text: 'choice.denominator.area',
            entered_unit_code: 'unit.kg_per_ha_product',
          },
          {
            attribute_code: 'attr.target',
            group_index: 0,
            value_status: 'runtime_new_status' as EntryValue['value_status'],
            value_text: 'stale raw target',
            entered_unit_code: 'unit.kg_per_ha_product',
          },
        ],
      },
    };
    const localizedCatalog = {
      products: [{ product_uuid: 'product-1', name: 'Product A' }],
      vocab: [
        { code: 'attr.product_uuid', kind: 'attribute' as const, labels: { en: 'Catalog product' } },
        { code: 'attr.amount_mass_area_product', kind: 'attribute' as const, labels: { en: 'Mass rate' } },
        { code: 'attr.denominator', kind: 'attribute' as const, labels: { en: 'Denominator' } },
        { code: 'attr.target', kind: 'attribute' as const, labels: { en: 'Target' } },
        { code: 'choice.denominator.area', kind: 'choice' as const, labels: { en: 'Area' } },
        { code: 'unit.kg_per_ha_product', kind: 'unit' as const, labels: { en: 'kg/ha' } },
      ],
    };

    render(
      <RepeatTreatmentCard
        candidate={statusCandidate}
        currentContext={context}
        catalog={localizedCatalog}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Catalog product · Group 1: Not observed')).toBeInTheDocument();
    expect(screen.getByText('Mass rate · Group 1: Not applicable')).toBeInTheDocument();
    expect(screen.getByText('Denominator · Group 1: Below detection')).toBeInTheDocument();
    expect(screen.getByText('Target · Group 1: Value unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/not_observed|not_applicable|below_detection|runtime_new_status/)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale raw target|Product A|2 kg\/ha|Area/)).not.toBeInTheDocument();
  });

  it('does not own invalidation when a same-context candidate replaces an accepted card', () => {
    const replacementValues = [{ attribute_code: 'attr.product_uuid', value: 'product-2' }];
    const replacement: CarryForwardCandidate = {
      ...candidate,
      source: { ...candidate.source, entry_uuid: 'source-2' },
      repeatTreatment: candidate.repeatTreatment && {
        ...candidate.repeatTreatment,
        sourceEntryUuid: 'source-2',
        product: 'Product B',
        values: replacementValues,
      },
    };
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        accepted
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));

    rerender(
      <RepeatTreatmentCard
        candidate={replacement}
        currentContext={context}
        accepted={false}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );

    const replacementConfirm = screen.getByRole('button', { name: 'Use these values' });
    expect(replacementConfirm).toBeEnabled();
    fireEvent.click(replacementConfirm);
    expect(onConfirm).toHaveBeenLastCalledWith(replacementValues);
  });

  it('renders incomplete safety facts as a dismissible non-confirmable hollow card', () => {
    const incomplete: CarryForwardCandidate = {
      ...candidate,
      repeatTreatment: candidate.repeatTreatment && {
        ...candidate.repeatTreatment,
        complete: false,
        product: null,
        rate: null,
      },
    };
    const onDismiss = vi.fn();
    render(
      <RepeatTreatmentCard
        candidate={incomplete}
        currentContext={context}
        onConfirm={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('This journal form is not available');
    expect(screen.queryByRole('button', { name: 'Use these values' })).not.toBeInTheDocument();
    const dismiss = screen.getByRole('button', { name: 'Do not copy' });
    dismiss.focus();
    expect(dismiss).toHaveFocus();
    expect(screen.getByRole('article')).toHaveClass('border-dashed');
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['plot', { plot_uuid: 'plot-2' }],
    ['crop', { crop: 'Barley' }],
    ['occurrence', { occurred_start: '2026-07-16T09:00:00.000Z' }],
    ['season', { season_uuid: 'season-2' }],
    ['layout code', { layout_code: 'protected_culture' }],
    ['layout version', { layout_version: 2 }],
  ])('invalidates the preview when %s changes', (_changed, change) => {
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={{ ...context, ...change }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The previous treatment no longer matches');
    expect(screen.queryByRole('button', { name: 'Use these values' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveClass('border-dashed');
  });

});
