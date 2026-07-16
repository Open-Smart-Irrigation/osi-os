// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { JournalVocabRow } from '../../../../types/journal';
import type { ActivityLeafSelection } from '../../../../types/journalCapture';

const translations: Record<string, string> = {
  'capture.back': 'Back',
  'capture.picker.title': 'What happened?',
  'capture.picker.recentOnPlot': 'Recent on this plot',
  'capture.picker.commonThisSeason': 'Common this season',
  'capture.picker.farmRecent': 'Recent on this farm',
  'capture.picker.allOptions': 'All options',
  'capture.picker.more': 'More activities',
  'capture.picker.search': 'Search activities',
  'capture.picker.searchPlaceholder': 'Search by name or code',
  'capture.picker.browseAll': 'Browse all',
  'capture.picker.noResults': 'No matching activities',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

import { ActivityPicker } from '../../capture/ActivityPicker';

const timestamp = '2026-07-16T00:00:00.000Z';

function term(
  code: string,
  kind: JournalVocabRow['kind'],
  labels: Record<string, string>,
  overrides: Partial<JournalVocabRow> = {},
): JournalVocabRow {
  return {
    code,
    kind,
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
    labels,
    constraints: null,
    ...overrides,
  };
}

const catalogRows: JournalVocabRow[] = [
  term('irrigation', 'activity', { en: 'Irrigation', 'de-CH': 'Bewässerung' }, {
    icon_key: 'droplets',
  }),
  term('fertilization', 'activity', { en: 'Fertilization', 'de-CH': 'Düngung' }, {
    icon_key: 'fertilizer',
  }),
  term('harvest', 'activity', { en: 'Harvest', 'de-CH': 'Ernte' }, { icon_key: 'harvest' }),
  term('seeding', 'activity', { en: 'Seeding', 'de-CH': 'Aussaat' }, { icon_key: 'seeding' }),
  term('sampling', 'activity', { en: 'Sampling', 'de-CH': 'Probenahme' }, {
    icon_key: 'sampling',
  }),
  term('general_observation', 'activity', { en: 'Observation', 'de-CH': 'Beobachtung' }, {
    icon_key: 'observation',
  }),
  term('equipment_maintenance', 'activity', { en: 'Maintenance', 'de-CH': 'Wartung' }, {
    icon_key: 'maintenance',
  }),
  term('unsupported_activity', 'activity', { en: 'Unsupported', 'de-CH': 'Nicht verfügbar' }),
  term('greenhouse_heating', 'activity', { en: 'Heating', tr: 'ISITMA' }),
  term('field_inspection', 'activity', { en: 'Inspection', ru: 'Наблюдение' }),
  term('rice_harvest', 'activity', { en: 'Rice harvest', ja: '収穫' }),
  term('attr.agroscope.operation', 'attribute', { en: 'Operation', 'de-CH': 'Arbeitsgang' }, {
    value_type: 'choice',
  }),
  term('attr.agroscope.device', 'attribute', { en: 'Device', 'de-CH': 'Gerät' }, {
    value_type: 'choice',
  }),
  term('agroscope.operation.spreading', 'choice', { en: 'Spreading', 'de-CH': 'Ausbringen' }, {
    parent_code: 'attr.agroscope.operation',
  }),
  term('agroscope.operation.injecting', 'choice', { en: 'Injecting', 'de-CH': 'Injizieren' }, {
    parent_code: 'attr.agroscope.operation',
  }),
  term('agroscope.device.broadcast', 'choice', { en: 'Broadcast spreader', 'de-CH': 'Breitstreuer' }, {
    parent_code: 'attr.agroscope.device',
  }),
  term('agroscope.device.injector', 'choice', { en: 'Injector', 'de-CH': 'Injektor' }, {
    parent_code: 'attr.agroscope.device',
  }),
];

const leaf = (activity_code: string): ActivityLeafSelection => ({
  activity_code,
  dependent_selections: [],
});

const spreadingLeaf: ActivityLeafSelection = {
  activity_code: 'fertilization',
  dependent_selections: [
    { attribute_code: 'attr.agroscope.operation', value: 'agroscope.operation.spreading' },
    { attribute_code: 'attr.agroscope.device', value: 'agroscope.device.broadcast' },
  ],
};

const injectingLeaf: ActivityLeafSelection = {
  activity_code: 'fertilization',
  dependent_selections: [
    { attribute_code: 'attr.agroscope.operation', value: 'agroscope.operation.injecting' },
    { attribute_code: 'attr.agroscope.device', value: 'agroscope.device.injector' },
  ],
};

const baseProps = {
  catalogRows,
  plotRecent: [] as ActivityLeafSelection[],
  seasonCommon: [] as ActivityLeafSelection[],
  farmRecent: [] as ActivityLeafSelection[],
  layoutFallback: [
    leaf('irrigation'),
    spreadingLeaf,
    injectingLeaf,
    leaf('harvest'),
    leaf('seeding'),
    leaf('sampling'),
    leaf('general_observation'),
    leaf('equipment_maintenance'),
  ],
  zoneLinked: true,
  locale: 'de-CH',
  onPick: vi.fn(),
};

function activityButtons(region: HTMLElement): HTMLButtonElement[] {
  return within(region).getAllByRole('button') as HTMLButtonElement[];
}

function activateWithKeyboard(button: HTMLElement): void {
  button.focus();
  fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
  // jsdom does not synthesize the browser's default click from Enter.
  fireEvent.click(button, { detail: 0 });
  fireEvent.keyUp(button, { key: 'Enter', code: 'Enter' });
}

describe('ActivityPicker', () => {
  it('ranks plot recents, season common, then fallback with stable dedupe and a six-item cap', () => {
    render(
      <ActivityPicker
        {...baseProps}
        plotRecent={[leaf('irrigation'), spreadingLeaf]}
        seasonCommon={[leaf('irrigation'), leaf('harvest')]}
      />,
    );

    const plot = screen.getByRole('region', { name: 'Recent on this plot' });
    const season = screen.getByRole('region', { name: 'Common this season' });
    const fallback = screen.getByRole('region', { name: 'All options' });
    expect(activityButtons(plot).map(({ textContent }) => textContent)).toEqual([
      expect.stringContaining('Bewässerung'),
      expect.stringContaining('Düngung'),
    ]);
    expect(activityButtons(season)).toHaveLength(1);
    expect(activityButtons(season)[0]).toHaveTextContent('Ernte');
    expect(activityButtons(fallback).map(({ textContent }) => textContent)).toEqual([
      expect.stringContaining('Düngung'),
      expect.stringContaining('Aussaat'),
      expect.stringContaining('Probenahme'),
    ]);
    expect([
      ...activityButtons(plot),
      ...activityButtons(season),
      ...activityButtons(fallback),
    ]).toHaveLength(6);
  });

  it('uses farm recents instead of seasonal inference without a linked zone', () => {
    render(
      <ActivityPicker
        {...baseProps}
        zoneLinked={false}
        seasonCommon={[leaf('harvest')]}
        farmRecent={[leaf('sampling')]}
      />,
    );

    expect(screen.queryByRole('region', { name: 'Common this season' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent on this farm' })).toHaveTextContent(
      'Probenahme',
    );
    expect(screen.getByRole('region', { name: 'Recent on this farm' })).not.toHaveTextContent(
      'Ernte',
    );
  });

  it('shows layout fallback options on a cold start', () => {
    render(<ActivityPicker {...baseProps} layoutFallback={[leaf('irrigation')]} />);

    expect(screen.getByRole('region', { name: 'All options' })).toHaveTextContent('Bewässerung');
  });

  it('filters unsupported recents that are absent from the layout fallback', () => {
    render(
      <ActivityPicker
        {...baseProps}
        plotRecent={[leaf('unsupported_activity'), leaf('irrigation')]}
        layoutFallback={[leaf('irrigation')]}
      />,
    );

    expect(screen.queryByText('Nicht verfügbar')).not.toBeInTheDocument();
    expect(screen.getByText('Bewässerung')).toBeInTheDocument();
  });

  it('searches localized labels, English fallback labels, path labels, and normalized codes', () => {
    const { rerender } = render(<ActivityPicker {...baseProps} />);
    const search = screen.getByRole('searchbox', { name: 'Search activities' });

    fireEvent.change(search, { target: { value: 'Bewässerung' } });
    expect(screen.getByText('Bewässerung')).toBeInTheDocument();
    expect(screen.queryByText('Ernte')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'Fertilization' } });
    expect(screen.getAllByText(/Düngung/)).toHaveLength(2);

    fireEvent.change(search, { target: { value: 'Broadcast spreader' } });
    expect(screen.getByText(/Breitstreuer/)).toBeInTheDocument();
    expect(screen.queryByText(/Injektor/)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'agroscope device injector' } });
    expect(screen.getByText(/Injektor/)).toBeInTheDocument();

    rerender(<ActivityPicker {...baseProps} layoutFallback={[leaf('irrigation')]} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'spray' } });
    expect(screen.getByText('No matching activities')).toBeInTheDocument();
  });

  it('uses locale-aware Turkish casing and preserves Cyrillic and CJK search text', () => {
    const unicodeLeaves = [
      leaf('greenhouse_heating'),
      leaf('field_inspection'),
      leaf('rice_harvest'),
      leaf('irrigation'),
    ];
    const { rerender } = render(
      <ActivityPicker
        {...baseProps}
        locale="tr"
        layoutFallback={unicodeLeaves}
      />,
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ısıtma' } });
    expect(screen.getByRole('button', { name: 'ISITMA' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Irrigation' })).not.toBeInTheDocument();

    rerender(
      <ActivityPicker
        {...baseProps}
        locale="ru"
        layoutFallback={unicodeLeaves}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Наблюдение' } });
    expect(screen.getByRole('button', { name: 'Наблюдение' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Irrigation' })).not.toBeInTheDocument();

    rerender(
      <ActivityPicker
        {...baseProps}
        locale="ja"
        layoutFallback={unicodeLeaves}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '収穫' } });
    expect(screen.getByRole('button', { name: '収穫' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Irrigation' })).not.toBeInTheDocument();
  });

  it('moves focus through keyboard-driven browse, dependency, and Back transitions', () => {
    render(<ActivityPicker {...baseProps} />);

    activateWithKeyboard(screen.getByRole('button', { name: 'Browse all' }));
    expect(screen.getByRole('heading', { name: 'All options' })).toHaveFocus();

    activateWithKeyboard(screen.getByRole('button', { name: 'Düngung' }));
    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toHaveFocus();

    activateWithKeyboard(screen.getByRole('button', { name: 'Ausbringen' }));
    expect(screen.getByRole('heading', { name: 'Gerät' })).toHaveFocus();

    activateWithKeyboard(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toHaveFocus();

    activateWithKeyboard(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'All options' })).toHaveFocus();

    activateWithKeyboard(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'What happened?' })).toHaveFocus();
  });

  it('repairs a stale browse prefix when the available leaves change', () => {
    const { rerender } = render(<ActivityPicker {...baseProps} />);
    activateWithKeyboard(screen.getByRole('button', { name: 'Browse all' }));
    activateWithKeyboard(screen.getByRole('button', { name: 'Düngung' }));
    activateWithKeyboard(screen.getByRole('button', { name: 'Ausbringen' }));
    expect(screen.getByRole('heading', { name: 'Gerät' })).toBeInTheDocument();

    rerender(
      <ActivityPicker
        {...baseProps}
        layoutFallback={[leaf('irrigation'), injectingLeaf]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Injizieren' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ausbringen' })).not.toBeInTheDocument();
  });

  it('browses activity then one dependency level at a time and supports backtracking', () => {
    const onPick = vi.fn();
    render(<ActivityPicker {...baseProps} onPick={onPick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    expect(screen.getByRole('button', { name: 'Düngung' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ausbringen' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Düngung' }));
    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ausbringen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Breitstreuer' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ausbringen' }));
    expect(screen.getByRole('heading', { name: 'Gerät' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Breitstreuer' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ausbringen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Breitstreuer' }));

    expect(onPick).toHaveBeenCalledWith(spreadingLeaf);
  });

  it('selects an activity leaf immediately when it has no dependent choices', () => {
    const onPick = vi.fn();
    render(<ActivityPicker {...baseProps} onPick={onPick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bewässerung' }));

    expect(onPick).toHaveBeenCalledWith(leaf('irrigation'));
  });

  it('returns from the first dependency level to the activity list', () => {
    render(<ActivityPicker {...baseProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Düngung' }));
    expect(screen.getByRole('heading', { name: 'Arbeitsgang' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('heading', { name: 'All options' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Düngung' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Arbeitsgang' })).not.toBeInTheDocument();
  });

  it('uses semantic focusable controls with visible labels for keyboard activation', () => {
    const onPick = vi.fn();
    render(
      <ActivityPicker
        {...baseProps}
        layoutFallback={[leaf('irrigation')]}
        onPick={onPick}
      />,
    );
    const activity = screen.getByRole('button', { name: 'Bewässerung' });

    expect(activity).toHaveAttribute('type', 'button');
    activateWithKeyboard(activity);

    expect(onPick).toHaveBeenCalledWith(leaf('irrigation'));
  });

  it('falls back to the English catalog label', () => {
    const englishOnlyCatalog = catalogRows.map((row) => row.code === 'irrigation'
      ? { ...row, labels: { en: 'Irrigation' } }
      : row);
    render(
      <ActivityPicker
        {...baseProps}
        catalogRows={englishOnlyCatalog}
        layoutFallback={[leaf('irrigation')]}
      />,
    );

    expect(screen.getByRole('button', { name: 'Irrigation' })).toBeInTheDocument();
  });
});
