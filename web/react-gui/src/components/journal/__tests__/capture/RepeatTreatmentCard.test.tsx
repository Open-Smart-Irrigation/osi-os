// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const translations: Record<string, string> = {
  'capture.carry.repeatTreatment': 'Repeat last treatment',
  'capture.carry.repeatTreatmentDescription': 'Review the previous treatment',
  'capture.carry.sourceDate': 'Previous date',
  'capture.carry.crop': 'Crop',
  'capture.carry.product': 'Product',
  'capture.carry.rate': 'Rate',
  'capture.carry.useValues': 'Use these values',
  'capture.carry.dismiss': 'Do not copy',
  'capture.carry.invalidated': 'The previous treatment no longer matches',
  'capture.validation.invalidDefinition': 'This journal form is not available',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
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
          attribute_code: 'attr.dose',
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
        onConfirm={vi.fn()}
        onInvalidate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Catalog Product')).toBeInTheDocument();
    expect(screen.getByText('2 kg/ha')).toBeInTheDocument();
    expect(screen.queryByText('product-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/unit\./)).not.toBeInTheDocument();
  });

  it('renders a hollow preview with source date, crop, product, and rate', () => {
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        onConfirm={vi.fn()}
        onInvalidate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Repeat last treatment' })).toBeInTheDocument();
    expect(screen.getByText('Wheat')).toBeInTheDocument();
    expect(screen.getByText('Product A')).toBeInTheDocument();
    expect(screen.getByText('2 kg/ha')).toBeInTheDocument();
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', '2026-07-15T08:00:00.000Z');
    expect(screen.getByRole('article')).toHaveClass('border-dashed');
  });

  it('does not emit protected values until the farmer confirms, and supports dismissal', () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        onConfirm={onConfirm}
        onInvalidate={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
    expect(onConfirm).toHaveBeenCalledWith(candidate.repeatTreatment?.values);
    fireEvent.click(screen.getByRole('button', { name: 'Do not copy' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('accepts a treatment at most once', () => {
    const onConfirm = vi.fn();
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        onConfirm={onConfirm}
        onInvalidate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Use these values' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
  });

  it('invalidates an accepted candidate on same-context replacement and enables the new one', () => {
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
    const onInvalidate = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        onConfirm={onConfirm}
        onInvalidate={onInvalidate}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));

    rerender(
      <RepeatTreatmentCard
        candidate={replacement}
        currentContext={context}
        onConfirm={onConfirm}
        onInvalidate={onInvalidate}
        onDismiss={onDismiss}
      />,
    );

    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith(candidate.repeatTreatment?.values);
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
        onInvalidate={vi.fn()}
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
    const onInvalidate = vi.fn();
    render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={{ ...context, ...change }}
        onConfirm={vi.fn()}
        onInvalidate={onInvalidate}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The previous treatment no longer matches');
    expect(screen.queryByRole('button', { name: 'Use these values' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveClass('border-dashed');
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['plot', { plot_uuid: 'plot-2' }],
    ['crop', { crop: 'Barley' }],
    ['occurrence', { occurred_start: '2026-07-16T09:00:00.000Z' }],
    ['season', { season_uuid: 'season-2' }],
    ['layout code', { layout_code: 'protected_culture' }],
    ['layout version', { layout_version: 2 }],
  ])('removes confirmed values exactly once when %s changes', (_changed, change) => {
    const onConfirm = vi.fn();
    const onInvalidate = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={context}
        onConfirm={onConfirm}
        onInvalidate={onInvalidate}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
    expect(onConfirm).toHaveBeenCalledWith(candidate.repeatTreatment?.values);

    const invalidContext = { ...context, ...change };
    rerender(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={invalidContext}
        onConfirm={onConfirm}
        onInvalidate={onInvalidate}
        onDismiss={onDismiss}
      />,
    );
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith(candidate.repeatTreatment?.values);

    rerender(
      <RepeatTreatmentCard
        candidate={candidate}
        currentContext={{ ...invalidContext }}
        onConfirm={onConfirm}
        onInvalidate={onInvalidate}
        onDismiss={onDismiss}
      />,
    );
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });
});
