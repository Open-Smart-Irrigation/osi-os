// @vitest-environment jsdom
// Slice D Phase 3 (crop-cycle GUI, D3.1-D3.4b): integration tests driving the
// full JournalCaptureFlow state machine for group-first seeding + variety,
// the same-crop reseed prompt (R4), reactive intercrop cycle_uuid
// disambiguation (R7), and the manual-close toggle (R3). Uses two
// sensorless, unstationed plots throughout so a two-plot batch selection
// (D7 group-first flow) skips the legacy single-plot crop-text gate and the
// single-plot draft/carry-forward machinery entirely (see PlotPicker/
// JournalCaptureFlow: `selectedPlot` is only set for an exactly-one-plot
// selection), keeping these tests focused on the crop-cycle behavviour
// itself rather than re-proving machinery the existing JournalCaptureFlow
// test suite already covers exhaustively.
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  createFinalBatch: vi.fn(),
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
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

import type {
  ActiveCropCycle,
  EntryAggregate,
  JournalCatalog,
  JournalPlot,
  JournalVocabRow,
  PlotGroup,
} from '../../../../types/journal';
import { JournalCaptureFlow } from '../../capture/JournalCaptureFlow';

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

function activityRow(code: string): JournalVocabRow {
  return vocabRow({ code, kind: 'activity', value_type: null, icon_key: 'observation' });
}

function minimalTemplate(code: string, version: number) {
  return {
    code,
    version,
    active: 1,
    catalog_errors: [],
    labels: { en: code },
    definition: {
      fields: [],
      sections: [],
      carry_forward: [],
      require_explicit_choices: false,
      show_standard_mappings: false,
      activity_requirements: {},
      conditional_groups: [],
      requirements: { required: [], optional: [], required_any: [] },
    },
  };
}

// Deliberately does NOT declare attr.crop/attr.variety on any template field
// (matching the real catalog: attr.variety has no visible_if rule anywhere,
// see journal-catalog-core.js) so EntryForm never renders them — the crop and
// variety values are exercised purely through SeedingCropFields + the
// payload-injection path this slice adds.
const cycleCatalog: JournalCatalog = {
  catalog_version: 20,
  catalog_hash: 'cycle-catalog',
  vocab: [
    activityRow('seeding'),
    activityRow('harvest'),
    activityRow('tillage_soil_work'),
    vocabRow({ code: 'attr.crop', kind: 'attribute', value_type: 'choice' }),
    vocabRow({
      code: 'agroscope.crop.wheat_winter', kind: 'choice', parent_code: 'attr.crop',
      labels: { en: 'Winter wheat' }, sort_order: 10,
    }),
    vocabRow({
      code: 'agroscope.crop.barley_spring', kind: 'choice', parent_code: 'attr.crop',
      labels: { en: 'Spring barley' }, sort_order: 20,
    }),
    vocabRow({ code: 'attr.variety', kind: 'attribute', value_type: 'text' }),
  ],
  templates: [
    minimalTemplate('farmer_quick', 1),
    minimalTemplate('full_record', 1),
    minimalTemplate('research_observation', 1),
  ],
  layouts: [{
    code: 'open_field',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Open field' },
    definition: {
      activity_codes: ['seeding', 'harvest', 'tillage_soil_work'],
      supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
      fields: [],
      minimum_fields: [],
      conditional_fields: {},
      denominator_contract: [],
      option_dependencies: [],
    },
  }],
  products: [],
  mappings: [],
};

// Review-fix regression fixture: mirrors the REAL production catalog shape
// (scripts/journal-catalog-core.js FARMER_QUICK_V3_QUICK_FIELDS.seeding =
// ['attr.crop', ...]) where farmer_quick@3's quick_fields already declares
// attr.crop as a normal, catalog-driven EntryForm field for seeding. Unlike
// `cycleCatalog` above (whose minimalTemplate deliberately has no
// quick_fields at all), formOwnsCrop is TRUE here — SeedingCropFields must
// not render a second, independently-stated crop control in this shape.
const formOwnedCropCatalog: JournalCatalog = {
  ...cycleCatalog,
  catalog_hash: 'form-owned-crop-catalog',
  vocab: cycleCatalog.vocab.map((row) => row.code === 'attr.crop' ? { ...row, labels: { en: 'Crop' } } : row),
  templates: [
    {
      code: 'farmer_quick',
      version: 3,
      active: 1,
      catalog_errors: [],
      labels: { en: 'Quick' },
      definition: {
        fields: [],
        sections: [{ code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] }],
        quick_fields: { seeding: ['attr.crop', 'note'] },
        carry_forward: [],
        require_explicit_choices: false,
        show_standard_mappings: false,
        activity_requirements: {},
        conditional_groups: [],
        requirements: { required: [], optional: [], required_any: [] },
      },
    },
    minimalTemplate('full_record', 1),
    minimalTemplate('research_observation', 1),
  ],
};

function makePlot(overrides: Partial<JournalPlot> & { plot_uuid: string; plot_code: string; name: string }): JournalPlot {
  return {
    contract_version: 1,
    zone_uuid: null,
    station_code: null,
    crop_hint: null,
    area_m2: null,
    active: 1,
    sync_version: 1,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'AABBCCDDEEFF0011',
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: timestamp,
      updated_by_principal_uuid: 'author',
      sync_version: 1,
      context_json: null,
    },
    ...overrides,
  };
}

// Slice D hardening: the authoritative open-cycle fixture (osi-journal/
// api.js listPlots' active_crop_cycles) that replaces the old fetch-and-
// mock-listEntries approach below — the overlap/banner detection this file
// exercises is now a synchronous read of the plot's OWN data, not a fetch.
function activeCropCycle(overrides: Partial<ActiveCropCycle> & { cycle_uuid: string }): ActiveCropCycle {
  return {
    crop_code: 'agroscope.crop.wheat_winter',
    variety: null,
    seeded_on: '2026-06-01',
    opened_by_entry_uuid: 'seed-entry',
    ...overrides,
  };
}

const plotA = makePlot({ plot_uuid: 'plot-a', plot_code: 'A1', name: 'North field' });
const plotB = makePlot({ plot_uuid: 'plot-b', plot_code: 'B1', name: 'East field' });

const baseProps = {
  catalog: cycleCatalog,
  plots: [plotA, plotB],
  plotGroups: [] as PlotGroup[],
  plotState: { createPlot: vi.fn(), updatePlot: vi.fn(), revalidate: vi.fn() },
  groupState: { createPlotGroup: vi.fn(), updatePlotGroup: vi.fn() },
  recentEntries: [] as EntryAggregate[],
  initialTimezone: 'Europe/Zurich',
  onClose: vi.fn(),
  onOpenExisting: vi.fn(),
  onSaved: vi.fn(),
};

async function selectTwoPlotsAndPickActivity(activityCode: string): Promise<void> {
  const northButtons = screen.getAllByRole('button', { name: 'North field' });
  const eastButtons = screen.getAllByRole('button', { name: 'East field' });
  fireEvent.click(northButtons[northButtons.length - 1]);
  fireEvent.click(eastButtons[eastButtons.length - 1]);
  fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
  const activityButtons = screen.getAllByRole('button', { name: activityCode });
  fireEvent.click(activityButtons[activityButtons.length - 1]);
  fireEvent.click(screen.getByRole('button', { name: 'capture.next' })); // activity -> details
}

async function proceedToConfirmAndFinish(): Promise<void> {
  // Details -> confirm can still be gated on other async effects in the flow
  // (e.g. the duplicate-guard check) that have normally settled by the time
  // a real farmer reaches Confirm but are not yet guaranteed to have
  // resolved the instant this synchronous test helper fires its own click —
  // retry the click until it actually advances. (Slice D hardening: the
  // crop-cycle overlap detection itself is a synchronous read of the plot's
  // own active_crop_cycles now, no longer a fetch with its own in-flight
  // window — see cycleActionSatisfied in JournalCaptureFlow.)
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' })); // details -> confirm
    expect(screen.getByRole('button', { name: 'capture.finish' })).toBeInTheDocument();
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
}

beforeEach(() => {
  apiMocks.listEntries.mockReset().mockResolvedValue({ entries: [], next_cursor: null });
  apiMocks.createEntry.mockReset().mockResolvedValue({ entry_uuid: 'draft-1', sync_version: 0 });
  apiMocks.createFinalBatch.mockReset().mockResolvedValue({
    batch_uuid: 'batch-1',
    entries: [
      { plot_uuid: plotA.plot_uuid, entry_uuid: 'final-a', outbox_event_uuid: 'outbox-a', sync_version: 1 },
      { plot_uuid: plotB.plot_uuid, entry_uuid: 'final-b', outbox_event_uuid: 'outbox-b', sync_version: 1 },
    ],
  });
  apiMocks.updateEntry.mockReset();
  let uuidCounter = 0;
  vi.spyOn(crypto, 'randomUUID').mockReset().mockImplementation(() => {
    const suffix = (0x111111111111 + uuidCounter).toString(16).padStart(12, '0');
    uuidCounter += 1;
    return `11111111-1111-4111-8111-${suffix}` as ReturnType<typeof crypto.randomUUID>;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JournalCaptureFlow crop-cycle GUI (Slice D Phase 3)', () => {
  it('group-first seeding sends attr.crop + attr.variety and no cycle_action when no cycle overlaps', async () => {
    render(<JournalCaptureFlow {...baseProps} />);

    await selectTwoPlotsAndPickActivity('seeding');
    fireEvent.change(screen.getByLabelText('capture.cycle.cropLabel'), {
      target: { value: 'agroscope.crop.wheat_winter' },
    });
    fireEvent.change(screen.getByLabelText('capture.cycle.varietyLabel'), { target: { value: 'Marlene' } });
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    const payload = apiMocks.createFinalBatch.mock.calls[0][0];
    expect(payload.cycle_action).toBeUndefined();
    expect(payload.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_code: 'attr.crop', value: 'agroscope.crop.wheat_winter' }),
      expect.objectContaining({ attribute_code: 'attr.variety', value: 'Marlene' }),
    ]));
  });

  // Review-fix regression: when the catalog's OWN template already owns
  // attr.crop as a normal field (the real production shape — see
  // formOwnedCropCatalog above), SeedingCropFields must not render a second
  // crop control, and the value actually persisted must be the one entered
  // through the catalog-driven control, not silently dropped.
  it('defers to the catalog-owned crop field (no duplicate control) when the template already declares attr.crop', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={formOwnedCropCatalog} />);

    await selectTwoPlotsAndPickActivity('seeding');
    expect(screen.queryByLabelText('capture.cycle.cropLabel')).not.toBeInTheDocument();
    const catalogCropField = screen.getByLabelText(/^Crop/);
    fireEvent.change(catalogCropField, { target: { value: 'agroscope.crop.barley_spring' } });
    fireEvent.change(screen.getByLabelText('capture.cycle.varietyLabel'), { target: { value: 'Django' } });
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    const payload = apiMocks.createFinalBatch.mock.calls[0][0];
    expect(payload.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_code: 'attr.crop', value: 'agroscope.crop.barley_spring' }),
      expect.objectContaining({ attribute_code: 'attr.variety', value: 'Django' }),
    ]));
  });

  it('shows the continue/new prompt for a same-crop+variety overlap and blocks Next until an explicit choice, then threads cycle_action', async () => {
    const plots = [
      { ...plotA, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-covering', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene',
      })] },
      plotB,
    ];

    render(<JournalCaptureFlow {...baseProps} plots={plots} />);
    await selectTwoPlotsAndPickActivity('seeding');
    fireEvent.change(screen.getByLabelText('capture.cycle.cropLabel'), {
      target: { value: 'agroscope.crop.wheat_winter' },
    });
    fireEvent.change(screen.getByLabelText('capture.cycle.varietyLabel'), { target: { value: 'Marlene' } });

    await screen.findByText('capture.cycle.sameCropTitle');
    // Details -> confirm is blocked without an explicit continue/new choice.
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.queryByRole('button', { name: 'capture.finish' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.startNewCycle' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].cycle_action).toBe('new');
  });

  it('does not show the prompt for a differing crop (auto-reseed applies regardless of cycle_action)', async () => {
    const plots = [
      { ...plotA, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-barley', crop_code: 'agroscope.crop.barley_spring', variety: null,
      })] },
      plotB,
    ];

    render(<JournalCaptureFlow {...baseProps} plots={plots} />);
    await selectTwoPlotsAndPickActivity('seeding');
    fireEvent.change(screen.getByLabelText('capture.cycle.cropLabel'), {
      target: { value: 'agroscope.crop.wheat_winter' },
    });
    fireEvent.change(screen.getByLabelText('capture.cycle.varietyLabel'), { target: { value: 'Marlene' } });

    expect(screen.queryByText('capture.cycle.sameCropTitle')).not.toBeInTheDocument();
    // P2-b (Slice D hardening): a differing-crop reseed auto-closes plot A's
    // open barley cycle server-side — the confirmation surfaces that.
    expect(screen.getByText('capture.cycle.closesCycle:Spring barley')).toBeInTheDocument();
    await proceedToConfirmAndFinish();
    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].cycle_action).toBeUndefined();
  });

  // B1 (review fix, blocking): the overlap-detection effect previously
  // stopped at the FIRST selected plot that resolved any covering crop
  // (see the old `for (const entries of perPlot) { ...; return; }` loop),
  // so a same-crop overlap on a NON-first plot was silently masked whenever
  // an earlier plot in the selection had a *different* open cycle. Plot A
  // here covers wheat (a differing crop from what's being seeded) and plot
  // B — the second, not the first, selected plot — covers the exact
  // barley·Laverda being seeded: the prompt must still fire and gate
  // finalize, exactly matching the bug's own repro.
  it('B1: fires the continue/new prompt when the SECOND selected plot (not the first) has the matching open cycle, and threads cycle_action', async () => {
    const plots = [
      { ...plotA, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-a', crop_code: 'agroscope.crop.wheat_winter', variety: null,
      })] },
      { ...plotB, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-b', crop_code: 'agroscope.crop.barley_spring', variety: 'Laverda',
      })] },
    ];

    render(<JournalCaptureFlow {...baseProps} plots={plots} />);
    await selectTwoPlotsAndPickActivity('seeding');
    fireEvent.change(screen.getByLabelText('capture.cycle.cropLabel'), {
      target: { value: 'agroscope.crop.barley_spring' },
    });
    fireEvent.change(screen.getByLabelText('capture.cycle.varietyLabel'), { target: { value: 'Laverda' } });

    await screen.findByText('capture.cycle.sameCropTitle');
    // Details -> confirm is blocked without an explicit continue/new choice,
    // even though plot A's (different-crop) overlap resolved fine on its own.
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.queryByRole('button', { name: 'capture.finish' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.continueCycle' }));
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].cycle_action).toBe('continue');
  });

  // B1 companion (specificity): a non-first plot's overlap must only be
  // load-bearing when its crop+variety EXACTLY matches what's being seeded —
  // an overlap on plot B with a *different* crop must not spuriously trip
  // the same-crop prompt (that case always auto-reseeds server-side
  // regardless of cycle_action, same as the existing plot-A-only variant of
  // this check above).
  it('B1: does not fire the prompt when the SECOND selected plot has a DIFFERENT crop overlap', async () => {
    const plots = [
      plotA,
      { ...plotB, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-b', crop_code: 'agroscope.crop.wheat_winter', variety: null,
      })] },
    ];

    render(<JournalCaptureFlow {...baseProps} plots={plots} />);
    await selectTwoPlotsAndPickActivity('seeding');
    fireEvent.change(screen.getByLabelText('capture.cycle.cropLabel'), {
      target: { value: 'agroscope.crop.barley_spring' },
    });
    fireEvent.change(screen.getByLabelText('capture.cycle.varietyLabel'), { target: { value: 'Laverda' } });

    expect(screen.queryByText('capture.cycle.sameCropTitle')).not.toBeInTheDocument();
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].cycle_action).toBeUndefined();
  });

  it('harvest: catches an intercrop cycle_uuid_required refusal, lets the user disambiguate, and resubmits with the chosen cycle_uuid', async () => {
    const openCycles = [
      { cycle_uuid: 'cycle-1', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene' },
      { cycle_uuid: 'cycle-2', crop_code: 'agroscope.crop.barley_spring', variety: null },
    ];
    apiMocks.createFinalBatch
      .mockRejectedValueOnce({
        response: {
          status: 422,
          data: {
            error: 'cycle_uuid_required',
            message: 'Multiple open crop cycles cover this plot',
            details: { openCycles },
          },
        },
      })
      .mockResolvedValueOnce({
        batch_uuid: 'batch-2',
        entries: [
          { plot_uuid: plotA.plot_uuid, entry_uuid: 'final-a', outbox_event_uuid: 'outbox-a', sync_version: 1 },
          { plot_uuid: plotB.plot_uuid, entry_uuid: 'final-b', outbox_event_uuid: 'outbox-b', sync_version: 1 },
        ],
      });

    render(<JournalCaptureFlow {...baseProps} />);
    await selectTwoPlotsAndPickActivity('harvest');
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].cycle_uuid).toBeUndefined();
    await screen.findByRole('alertdialog', { name: 'capture.cycle.disambiguationTitle' });

    fireEvent.click(screen.getByRole('button', { name: 'Spring barley' }));

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(2));
    expect(apiMocks.createFinalBatch.mock.calls[1][0].cycle_uuid).toBe('cycle-2');
  });

  it('manual close: sets ends_crop_cycle on a tillage_soil_work batch when the toggle is checked', async () => {
    render(<JournalCaptureFlow {...baseProps} />);
    await selectTwoPlotsAndPickActivity('tillage_soil_work');

    const toggle = screen.getByRole('checkbox', { name: /capture.cycle.manualCloseLabel/ });
    fireEvent.click(toggle);
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].ends_crop_cycle).toBe(true);
  });

  it('manual close: omits ends_crop_cycle when the toggle is left unchecked', async () => {
    render(<JournalCaptureFlow {...baseProps} />);
    await selectTwoPlotsAndPickActivity('tillage_soil_work');
    await proceedToConfirmAndFinish();

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(1));
    expect(apiMocks.createFinalBatch.mock.calls[0][0].ends_crop_cycle).toBeUndefined();
  });

  // P2-b (Slice D hardening): harvest closes every covering open cycle
  // server-side (osi-journal/lifecycle.js applyHarvestCycleEffect) — surface
  // which crop(s) that will be before the farmer saves.
  it('harvest: surfaces a "closes crop cycle" confirmation for each covering open cycle', async () => {
    const plots = [
      { ...plotA, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-a', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene',
      })] },
      { ...plotB, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-b', crop_code: 'agroscope.crop.barley_spring', variety: null,
      })] },
    ];
    render(<JournalCaptureFlow {...baseProps} plots={plots} />);
    await selectTwoPlotsAndPickActivity('harvest');

    expect(screen.getByText('capture.cycle.closesCycle:Winter wheat · Marlene')).toBeInTheDocument();
    expect(screen.getByText('capture.cycle.closesCycle:Spring barley')).toBeInTheDocument();
  });

  it('harvest: shows no "closes crop cycle" confirmation when neither plot has an open cycle', async () => {
    render(<JournalCaptureFlow {...baseProps} />);
    await selectTwoPlotsAndPickActivity('harvest');

    expect(screen.queryByText(/capture\.cycle\.closesCycle/)).not.toBeInTheDocument();
  });

  // P2-b (Slice D hardening): the manual-close confirmation only appears once
  // the toggle is actually checked (mirroring ends_crop_cycle itself), and
  // disappears again if the farmer unchecks it.
  it('manual close: shows the "closes crop cycle" confirmation only while the toggle is checked', async () => {
    const plots = [
      { ...plotA, active_crop_cycles: [activeCropCycle({
        cycle_uuid: 'cycle-a', crop_code: 'agroscope.crop.wheat_winter', variety: 'Marlene',
      })] },
      plotB,
    ];
    render(<JournalCaptureFlow {...baseProps} plots={plots} />);
    await selectTwoPlotsAndPickActivity('tillage_soil_work');

    expect(screen.queryByText(/capture\.cycle\.closesCycle/)).not.toBeInTheDocument();

    const toggle = screen.getByRole('checkbox', { name: /capture.cycle.manualCloseLabel/ });
    fireEvent.click(toggle);
    expect(screen.getByText('capture.cycle.closesCycle:Winter wheat · Marlene')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText(/capture\.cycle\.closesCycle/)).not.toBeInTheDocument();
  });
});
