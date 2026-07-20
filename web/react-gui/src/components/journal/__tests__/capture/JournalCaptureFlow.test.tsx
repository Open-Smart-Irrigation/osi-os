// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode, useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  createFinalBatch: vi.fn(),
  updateEntry: vi.fn(),
}));

const buildFinalBatchPayloadMock = vi.hoisted(() => vi.fn());

const translationMocks = vi.hoisted(() => ({ locale: 'en' }));
const reportConsoleError = console.error.bind(console);
const ACT_WARNING = /not wrapped in act|testing environment is not configured to support act/i;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

vi.mock('../../../../services/journalApi', () => ({
  journalApi: apiMocks,
}));

vi.mock('../../../../journal/buildFinalBatchPayload', async () => {
  const actual = await vi.importActual<typeof import('../../../../journal/buildFinalBatchPayload')>(
    '../../../../journal/buildFinalBatchPayload',
  );
  buildFinalBatchPayloadMock.mockImplementation(actual.buildFinalBatchPayload);
  return { ...actual, buildFinalBatchPayload: buildFinalBatchPayloadMock };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key}:${Object.values(values).join(',')}`
      : key,
    i18n: { language: translationMocks.locale, resolvedLanguage: translationMocks.locale },
  }),
}));

import type {
  CreateFinalBatchPayload,
  EntryAggregate,
  JournalCatalog,
  JournalPlot,
  PlotGroup,
} from '../../../../types/journal';
import { JournalCaptureFlow } from '../../capture/JournalCaptureFlow';

const timestamp = '2026-07-16T00:00:00.000Z';

function duplicateUuid(index: number): string {
  return `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
}

let defaultRandomUuidCounter = 0;

function nextDefaultRandomUuid(): ReturnType<typeof crypto.randomUUID> {
  const suffix = (0x111111111111 + defaultRandomUuidCounter).toString(16).padStart(12, '0');
  defaultRandomUuidCounter += 1;
  return `11111111-1111-4111-8111-${suffix}` as ReturnType<typeof crypto.randomUUID>;
}

function row(code: string, kind: 'activity' | 'attribute', valueType: 'text' | 'choice' = 'text') {
  return {
    code,
    kind,
    parent_code: null,
    value_type: kind === 'activity' ? null : valueType,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: kind === 'activity' ? 'observation' : null,
    scope: 'core' as const,
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
  };
}

function choiceRow(code: string, parentCode: string, label = code) {
  return {
    ...row(code, 'attribute'),
    kind: 'choice' as const,
    parent_code: parentCode,
    value_type: null,
    labels: { en: label },
  };
}

function numericAttribute(code: string, label: string) {
  return {
    ...row(code, 'attribute'),
    value_type: 'number' as const,
    quantity_kind: 'mass_area',
    basis: 'product',
    default_unit_code: 'unit.kg',
    labels: { en: label },
    constraints: { min: 0, max: 2000, step: 0.5 },
  };
}

function unitRow(code: string, label: string, scale: number) {
  return {
    ...row(code, 'attribute'),
    kind: 'unit' as const,
    value_type: null,
    quantity_kind: 'mass_area',
    basis: 'product',
    labels: { en: label },
    constraints: {
      dimension: 'mass_area:product',
      to_canonical: { unit_code: 'unit.kg', scale, offset: 0 },
    },
  };
}

function definition(code: string, fields: string[], version = 1) {
  return {
    code,
    version,
    active: 1,
    catalog_errors: [],
    labels: { en: code },
    definition: {
      fields,
      sections: [],
      carry_forward: ['attr.crop'],
      require_explicit_choices: false,
      show_standard_mappings: false,
      activity_requirements: {},
      conditional_groups: [],
      requirements: { required: [], optional: [], required_any: [] },
    },
  };
}

const catalog: JournalCatalog = {
  catalog_version: 7,
  catalog_hash: 'catalog-hash',
  vocab: [row('irrigation', 'activity'), row('attr.crop', 'attribute')],
  templates: [
    definition('farmer_quick', ['attr.crop'], 4),
    definition('full_record', ['attr.crop'], 2),
    definition('research_observation', ['attr.crop'], 9),
  ],
  layouts: [{
    code: 'greenhouse',
    version: 6,
    active: 1,
    catalog_errors: [],
    labels: { en: 'greenhouse' },
    definition: {
      activity_codes: ['irrigation'],
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

const canonicalCropCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    row('irrigation', 'activity'),
    row('attr.crop', 'attribute', 'choice'),
    choiceRow('agroscope.crop.barley_spring', 'attr.crop', 'barley, spring'),
    choiceRow('agroscope.crop.barley_winter', 'attr.crop', 'barley, winter'),
  ],
};

const harvestCatalog: JournalCatalog = {
  ...catalog,
  vocab: [...catalog.vocab, row('harvest', 'activity')],
  layouts: catalog.layouts.map((layout) => ({
    ...layout,
    definition: { ...layout.definition, activity_codes: ['harvest'] },
  })),
};

// Mirrors the shipped farmer_quick@2 shape (Task 27 / P4 fix): three
// low-risk fields are both visibly shown and carried forward at once.
const tripleCarryForwardCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    ...catalog.vocab,
    row('attr.operator', 'attribute'),
    row('attr.equipment', 'attribute'),
    row('attr.method', 'attribute'),
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: {
          ...candidate.definition,
          fields: ['attr.crop', 'attr.operator', 'attr.equipment', 'attr.method'],
          carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
        },
      }
    : candidate),
};

const quickWithoutCropCatalog: JournalCatalog = {
  ...canonicalCropCatalog,
  templates: canonicalCropCatalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: { ...candidate.definition, fields: [], carry_forward: [] },
      }
    : candidate),
};

const activityCropDependencyCatalog: JournalCatalog = {
  ...canonicalCropCatalog,
  layouts: [{
    ...canonicalCropCatalog.layouts[0],
    definition: {
      ...canonicalCropCatalog.layouts[0].definition,
      option_dependencies: [{
        when: { attribute_code: 'activity_code', equals: 'irrigation' },
        restrict: {
          attribute_code: 'attr.crop',
          choices: ['agroscope.crop.barley_spring', 'agroscope.crop.barley_winter'],
        },
      }],
    },
  }],
};

const plot: JournalPlot = {
  contract_version: 1,
  plot_uuid: 'plot-1',
  plot_code: 'NORTH',
  name: 'North field',
  zone_uuid: 'zone-1',
  station_code: null,
  crop_hint: 'Wheat',
  area_m2: 100,
  active: 1,
  sync_version: 1,
  owner_user_uuid: 'owner',
  gateway_device_eui: 'gateway',
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  settings: {
    layout_code: 'greenhouse',
    updated_at: timestamp,
    updated_by_principal_uuid: 'author',
    sync_version: 1,
  },
};

const sensorlessPlot = { ...plot, plot_uuid: 'plot-2', plot_code: 'SOUTH', name: 'South field', zone_uuid: null, crop_hint: null };

const baseProps = {
  catalog,
  plots: [plot, sensorlessPlot],
  plotGroups: [] as PlotGroup[],
  plotState: {
    createPlot: vi.fn(),
    updatePlot: vi.fn(),
  },
  groupState: {
    createPlotGroup: vi.fn(),
    updatePlotGroup: vi.fn(),
  },
  recentEntries: [],
  initialTimezone: 'Europe/Zurich',
  onClose: vi.fn(),
  onOpenExisting: vi.fn(),
  onSaved: vi.fn(),
};

// Slice BC (R1 Part 2): a farmer_quick@3-shaped template (quick_fields) paired
// with an open_field layout carrying static_context_fields, to prove
// end-to-end that Quick renders only the activity's own fields, the plot's
// static context renders read-only (not as an input), and the saved entry
// still carries the context values via the payload snapshot.
const plotContextCatalog: JournalCatalog = {
  catalog_version: 3,
  catalog_hash: 'plot-context-catalog',
  vocab: [
    row('fertilization', 'activity'),
    row('attr.crop', 'attribute'),
    { ...row('attr.block_bed_row', 'attribute'), labels: { en: 'Block / bed / row' } },
    { ...row('attr.product', 'attribute'), labels: { en: 'Product' } },
    numericAttribute('attr.amount_mass_area_product', 'Amount'),
    unitRow('unit.kg', 'kg/ha', 1),
  ],
  templates: [
    {
      code: 'farmer_quick',
      version: 3,
      active: 1,
      catalog_errors: [],
      labels: { en: 'Quick' },
      definition: {
        sections: [{ code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] }],
        quick_fields: {
          fertilization: ['attr.product', 'attr.amount_mass_area_product', 'note'],
        },
        carry_forward: [],
        require_explicit_choices: false,
        show_standard_mappings: false,
        activity_requirements: {},
        conditional_groups: [],
        requirements: { required: [], optional: [], required_any: [] },
      },
    },
    definition('full_record', ['attr.crop'], 2),
    definition('research_observation', ['attr.crop'], 9),
  ],
  layouts: [{
    code: 'open_field',
    version: 3,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Open field' },
    definition: {
      activity_codes: ['fertilization'],
      supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
      fields: [],
      minimum_fields: ['attr.block_bed_row'],
      static_context_fields: ['attr.block_bed_row'],
      reading_fields: [],
      conditional_fields: {},
      denominator_contract: [],
      option_dependencies: [],
    },
  }],
  products: [],
  mappings: [],
};

const plotWithContext: JournalPlot = {
  ...plot,
  plot_uuid: 'plot-context-1',
  plot_code: 'CTX-1',
  // Sensorless (no zone_uuid) like `sensorlessPlot`, but keeps crop_hint so
  // `inferredCrop` is non-empty and the activity -> details step transition
  // isn't blocked by the "sensorless plot needs an explicit crop" gate.
  zone_uuid: null,
  crop_hint: 'Wheat',
  settings: {
    layout_code: 'open_field',
    updated_at: timestamp,
    updated_by_principal_uuid: 'author',
    sync_version: 1,
    context_json: JSON.stringify({ 'attr.block_bed_row': 'B-7' }),
  },
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
    template_version: 4,
    layout_code: 'greenhouse',
    layout_version: 6,
    catalog_version: 7,
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
    sync_version: 1,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [],
    ...overrides,
  };
}

const researchOnlyCatalog: JournalCatalog = {
  ...catalog,
  layouts: [{
    ...catalog.layouts[0],
    definition: {
      ...catalog.layouts[0].definition,
      supported_templates: ['research_observation'],
    },
  }],
};

const dependencyCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    ...catalog.vocab,
    row('fertilization', 'activity'),
    row('attr.operation', 'attribute', 'choice'),
    row('attr.device', 'attribute', 'choice'),
    choiceRow('operation.spreading', 'attr.operation', 'Spreading'),
    choiceRow('device.broadcast', 'attr.device', 'Broadcast spreader'),
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? definition('farmer_quick', ['attr.crop', 'attr.operation', 'attr.device'], 4)
    : candidate),
  layouts: [{
    ...catalog.layouts[0],
    definition: {
      ...catalog.layouts[0].definition,
      activity_codes: ['fertilization'],
      option_dependencies: [
        { when: { attribute_code: 'activity_code', equals: 'fertilization' }, restrict: { attribute_code: 'attr.operation', choices: ['operation.spreading'] } },
        { when: { attribute_code: 'attr.operation', equals: 'operation.spreading' }, restrict: { attribute_code: 'attr.device', choices: ['device.broadcast'] } },
      ],
    },
  }],
};

const requiredCatalog: JournalCatalog = {
  ...catalog,
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? { ...candidate, definition: { ...candidate.definition, fields: [{ code: 'attr.crop', required: true }] } }
    : candidate),
};

const numericCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    row('irrigation', 'activity'),
    row('attr.crop', 'attribute'),
    numericAttribute('attr.amount', 'Applied amount'),
    unitRow('unit.g', 'g/ha', 0.001),
    unitRow('unit.kg', 'kg/ha', 1),
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: { ...candidate.definition, fields: ['attr.amount'], carry_forward: [] },
      }
    : candidate),
};

const invalidAutomaticCarryCatalog: JournalCatalog = {
  ...numericCatalog,
  templates: numericCatalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: { ...candidate.definition, carry_forward: ['attr.amount'] },
      }
    : candidate),
};

const booleanCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    row('irrigation', 'activity'),
    row('attr.crop', 'attribute'),
    { ...row('attr.success', 'attribute'), value_type: 'boolean' as const, labels: { en: 'Successful' } },
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: { ...candidate.definition, fields: ['attr.success'], carry_forward: [] },
      }
    : candidate),
};

const activityTransitionCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    row('irrigation', 'activity'),
    row('fertilization', 'activity'),
    row('attr.crop', 'attribute'),
    numericAttribute('attr.amount', 'Applied amount'),
    unitRow('unit.kg', 'kg/ha', 1),
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: {
          ...candidate.definition,
          fields: [{ code: 'attr.amount', required: true }],
          carry_forward: [],
        },
      }
    : candidate),
  layouts: [{
    ...catalog.layouts[0],
    definition: {
      ...catalog.layouts[0].definition,
      activity_codes: ['irrigation', 'fertilization'],
      option_dependencies: [{
        when: { attribute_code: 'activity_code', equals: 'irrigation' },
        restrict: { attribute_code: 'attr.amount', units: ['unit.kg'] },
      }],
    },
  }],
};

function validationTransitionCatalog(options: {
  amountMin?: number;
  amountMax?: number;
  secondLayout?: boolean;
  reveal?: 'all' | 'activity';
} = {}): JournalCatalog {
  const reveal = options.reveal ?? 'all';
  return {
    ...catalog,
    vocab: [
      row('irrigation', 'activity'),
      row('fertilization', 'activity'),
      row('attr.crop', 'attribute'),
      {
        ...numericAttribute('attr.amount', 'Applied amount'),
        constraints: {
          min: options.amountMin ?? 0,
          max: options.amountMax ?? 2000,
          step: 0.5,
        },
      },
      unitRow('unit.kg', 'kg/ha', 1),
    ],
    templates: catalog.templates.map((candidate) => {
      if (candidate.code === 'farmer_quick') {
        return {
          ...candidate,
          definition: {
            ...candidate.definition,
            fields: reveal === 'activity' ? [{
              code: 'attr.amount',
              visible_if: { field: 'activity_code', op: 'eq', value: 'fertilization' },
            }] : ['attr.amount'],
            carry_forward: [],
          },
        };
      }
      return candidate;
    }),
    layouts: [
      {
        ...catalog.layouts[0],
        definition: {
          ...catalog.layouts[0].definition,
          activity_codes: reveal === 'activity' ? ['irrigation', 'fertilization'] : ['irrigation'],
        },
      },
      ...(options.secondLayout ? [{
        ...catalog.layouts[0],
        code: 'open_field',
        version: 3,
        labels: { en: 'open field' },
        definition: {
          ...catalog.layouts[0].definition,
          activity_codes: ['irrigation'],
          fields: ['attr.amount'],
        },
      }] : []),
    ],
  };
}

const protectedCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    row('plant_protection_application', 'activity'),
    row('attr.crop', 'attribute'),
    row('attr.product_uuid', 'attribute'),
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: {
          ...candidate.definition,
          fields: ['attr.crop', 'attr.product_uuid'],
          carry_forward: ['attr.crop', 'attr.product_uuid'],
        },
      }
    : candidate),
  layouts: [{
    ...catalog.layouts[0],
    definition: {
      ...catalog.layouts[0].definition,
      activity_codes: ['plant_protection_application'],
    },
  }],
  products: [{
    product_uuid: 'product-1',
    scope: 'farm',
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    name: 'Protected product',
    kind: 'plant_protection',
    active: 1,
    sync_version: 0,
    created_at: timestamp,
    deleted_at: null,
    catalog_errors: [],
  }],
};

const invalidRepeatCatalog: JournalCatalog = {
  ...protectedCatalog,
  vocab: [
    ...protectedCatalog.vocab,
    {
      ...numericAttribute('attr.amount_mass_area_product', 'Product rate'),
      default_unit_code: 'unit.kg_per_ha_product',
    },
    unitRow('unit.kg', 'kg', 1),
    unitRow('unit.kg_per_ha_product', 'kg/ha', 1),
  ],
  templates: protectedCatalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: {
          ...candidate.definition,
          fields: ['attr.product_uuid', 'attr.amount_mass_area_product'],
          carry_forward: ['attr.product_uuid'],
        },
      }
    : candidate),
};

const repeatFlowCatalog: JournalCatalog = {
  ...protectedCatalog,
  vocab: [
    ...protectedCatalog.vocab,
    numericAttribute('attr.amount_mass_area_product', 'Product rate'),
    unitRow('unit.kg', 'kg', 1),
    unitRow('unit.kg_per_ha_product', 'kg/ha', 1),
  ],
  templates: protectedCatalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: {
          ...candidate.definition,
          fields: ['attr.crop', 'attr.product_uuid', 'attr.amount_mass_area_product'],
        },
      }
    : candidate),
  layouts: [
    protectedCatalog.layouts[0],
    {
      ...protectedCatalog.layouts[0],
      code: 'open_field',
      version: 3,
      labels: { en: 'open field' },
    },
  ],
};

const automaticRepeatFlowCatalog: JournalCatalog = {
  ...repeatFlowCatalog,
  vocab: [...repeatFlowCatalog.vocab, row('attr.operator', 'attribute')],
  templates: repeatFlowCatalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? {
        ...candidate,
        definition: {
          ...candidate.definition,
          fields: ['attr.crop', 'attr.operator', 'attr.product_uuid', 'attr.amount_mass_area_product'],
          carry_forward: ['attr.operator'],
        },
      }
    : candidate),
};

const replacementRepeatFlowCatalog: JournalCatalog = {
  ...repeatFlowCatalog,
  products: [
    ...repeatFlowCatalog.products,
    {
      ...repeatFlowCatalog.products[0],
      product_uuid: 'product-2',
      name: 'Replacement product',
    },
  ],
};

const activityRepeatFlowCatalog: JournalCatalog = {
  ...repeatFlowCatalog,
  vocab: [...repeatFlowCatalog.vocab, row('irrigation', 'activity')],
  layouts: repeatFlowCatalog.layouts.map((candidate) => ({
    ...candidate,
    definition: {
      ...candidate.definition,
      activity_codes: ['plant_protection_application', 'irrigation'],
    },
  })),
};

const repeatSource = entry({
  entry_uuid: 'source-repeat-flow',
  activity_code: 'plant_protection_application',
  occurred_start: '2026-07-15T00:00:00.000Z',
  values: [
    {
      group_index: 0,
      attribute_code: 'attr.product_uuid',
      value_status: 'observed' as const,
      value_text: 'product-1',
      value_num: null,
      unit_code: null,
      entered_value_num: null,
      entered_unit_code: null,
    },
    {
      group_index: 0,
      attribute_code: 'attr.amount_mass_area_product',
      value_status: 'observed' as const,
      value_text: null,
      value_num: 2,
      unit_code: 'unit.kg',
      entered_value_num: 2,
      entered_unit_code: 'unit.kg_per_ha_product',
    },
  ],
});

const repeatSourceWithAutomatic = entry({
  ...repeatSource,
  entry_uuid: 'source-repeat-flow-with-automatic',
  values: [
    {
      group_index: 0,
      attribute_code: 'attr.operator',
      value_status: 'observed' as const,
      value_text: 'Alex',
      value_num: null,
      unit_code: null,
      entered_value_num: null,
      entered_unit_code: null,
    },
    ...repeatSource.values,
  ],
});

const replacementRepeatSource = entry({
  ...repeatSource,
  entry_uuid: 'source-repeat-flow-replacement',
  values: repeatSource.values.map((value) => value.attribute_code === 'attr.product_uuid'
    ? { ...value, value_text: 'product-2' }
    : { ...value, value_num: 3, entered_value_num: 3 }),
});

const correctedRepeatSource = entry({
  ...replacementRepeatSource,
  entry_uuid: repeatSource.entry_uuid,
});

const layoutSwitchPlot: JournalPlot = {
  ...plot,
  settings: { ...plot.settings, layout_code: 'open_field' },
};

const invalidRetainedTemplateCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    row('irrigation', 'activity'),
    row('attr.crop', 'attribute'),
    {
      ...numericAttribute('attr.explicit_amount', 'Explicit amount'),
      default_unit_code: null,
      constraints: {
        min: 0,
        max: 2000,
        step: 0.5,
        requires_explicit_unit: true,
        allow_default_unit: false,
        semantic_discriminator: 'unit_code',
      },
    },
  ],
  templates: catalog.templates.map((candidate) => ({
    ...candidate,
    definition: {
      ...candidate.definition,
      fields: candidate.code === 'farmer_quick' ? [] : ['attr.explicit_amount'],
      carry_forward: [],
    },
  })),
};

const plotSwitchCatalog: JournalCatalog = {
  ...dependencyCatalog,
  layouts: [
    dependencyCatalog.layouts[0],
    {
      ...catalog.layouts[0],
      code: 'open_field',
      version: 3,
      labels: { en: 'open field' },
      definition: {
        ...catalog.layouts[0].definition,
        activity_codes: ['irrigation'],
        option_dependencies: [],
      },
    },
  ],
};

const layoutSanitizationCatalog: JournalCatalog = {
  ...catalog,
  vocab: [...catalog.vocab, row('attr.extra', 'attribute')],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? { ...candidate, definition: { ...candidate.definition, fields: ['attr.crop'] } }
    : candidate),
  layouts: [
    {
      ...catalog.layouts[0],
      definition: { ...catalog.layouts[0].definition, fields: ['attr.extra'], activity_codes: ['irrigation'] },
    },
    {
      ...catalog.layouts[0],
      code: 'open_field',
      version: 3,
      labels: { en: 'open field' },
      definition: { ...catalog.layouts[0].definition, fields: [], activity_codes: ['irrigation'] },
    },
  ],
};

// Both plot fixtures' bound layouts appear here (`plot` -> greenhouse,
// `secondPlot` -> open_field, see their `settings.layout_code`), so switching
// between them is itself a layout transition. Only `open_field` restricts
// attr.method to method.a, so a plot switch from `plot` to `secondPlot` can
// strand a previously valid method.b selection.
const layoutTransitionChoiceCatalog: JournalCatalog = {
  ...catalog,
  vocab: [
    ...catalog.vocab,
    row('attr.method', 'attribute', 'choice'),
    choiceRow('method.a', 'attr.method', 'Method A'),
    choiceRow('method.b', 'attr.method', 'Method B'),
  ],
  templates: catalog.templates.map((candidate) => candidate.code === 'farmer_quick'
    ? { ...candidate, definition: { ...candidate.definition, fields: ['attr.crop', 'attr.method'] } }
    : candidate),
  layouts: [
    {
      ...catalog.layouts[0],
      definition: { ...catalog.layouts[0].definition, activity_codes: ['irrigation'], option_dependencies: [] },
    },
    {
      ...catalog.layouts[0],
      code: 'open_field',
      version: 3,
      labels: { en: 'open field' },
      definition: {
        ...catalog.layouts[0].definition,
        activity_codes: ['irrigation'],
        option_dependencies: [{
          when: { attribute_code: 'activity_code', equals: 'irrigation' },
          restrict: { attribute_code: 'attr.method', choices: ['method.a'] },
        }],
      },
    },
  ],
};

const secondPlot: JournalPlot = {
  ...plot,
  plot_uuid: 'plot-b',
  plot_code: 'EAST',
  name: 'East field',
  zone_uuid: 'zone-b',
  crop_hint: 'Barley',
  settings: {
    ...plot.settings,
    layout_code: 'open_field',
  },
};

const mixedLayoutPlot: JournalPlot = secondPlot;

const homogeneousSecondPlot: JournalPlot = {
  ...secondPlot,
  settings: { ...plot.settings },
};

const activeGroup: PlotGroup = {
  contract_version: 1,
  group_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  label: 'North pair',
  owner_user_uuid: 'owner',
  gateway_device_eui: 'gateway',
  created_by_principal_uuid: 'author',
  created_at: timestamp,
  resolved_at: null,
  resolved_by_principal_uuid: null,
  sync_version: 2,
  deleted_at: null,
  members: [plot.plot_uuid, homogeneousSecondPlot.plot_uuid],
};

const secondActiveGroup: PlotGroup = {
  ...activeGroup,
  group_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  label: 'South pair',
};

const singlePlotHarvestGroup: PlotGroup = {
  ...activeGroup,
  group_uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  label: 'North single',
  members: [plot.plot_uuid],
};

const resolvedActiveGroup: PlotGroup = {
  ...activeGroup,
  resolved_at: '2026-07-18T08:30:00.000Z',
  resolved_by_principal_uuid: 'author',
  sync_version: activeGroup.sync_version + 1,
};

interface RevalidatingHarvestCaptureProps {
  updatePlotGroup: ComponentProps<typeof JournalCaptureFlow>['groupState']['updatePlotGroup'];
  onRevalidated: (group: PlotGroup) => void;
  onSaved?: ComponentProps<typeof JournalCaptureFlow>['onSaved'];
}

function RevalidatingHarvestCapture({
  updatePlotGroup,
  onRevalidated,
  onSaved = baseProps.onSaved,
}: RevalidatingHarvestCaptureProps) {
  const [groups, setGroups] = useState<PlotGroup[]>([activeGroup, secondActiveGroup]);
  const updateAndRevalidate: ComponentProps<typeof JournalCaptureFlow>['groupState']['updatePlotGroup'] =
    async (uuid, payload) => {
      const updated = await updatePlotGroup(uuid, payload);
      setGroups((current) => current.map((group) => group.group_uuid === updated.group_uuid ? updated : group));
      onRevalidated(updated);
      return updated;
    };

  return (
    <JournalCaptureFlow
      {...baseProps}
      catalog={harvestCatalog}
      plots={[plot, homogeneousSecondPlot]}
      plotGroups={groups}
      groupState={{ ...baseProps.groupState, updatePlotGroup: updateAndRevalidate }}
      onSaved={onSaved}
    />
  );
}

async function finishHarvestBatch(): Promise<void> {
  const northButtons = screen.getAllByRole('button', { name: 'North field' });
  const eastButtons = screen.getAllByRole('button', { name: 'East field' });
  fireEvent.click(northButtons[northButtons.length - 1]);
  fireEvent.click(eastButtons[eastButtons.length - 1]);
  fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'harvest' }));
  fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
  await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalled());
}

const START_OCCURRENCE_LABEL = 'capture.confirm.occurrence · capture.form.required';
const END_OCCURRENCE_LABEL = 'capture.confirm.occurrence · capture.form.optional';

function deferJournalEffects(): () => Promise<void> {
  const pending: Array<(response: { entries: never[]; next_cursor: null }) => void> = [];
  apiMocks.listEntries.mockImplementation(() => new Promise((resolve) => {
    pending.push(resolve);
  }));
  return async () => {
    await act(async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0);
        batch.forEach((resolve) => resolve({ entries: [], next_cursor: null }));
        await Promise.resolve();
        await Promise.resolve();
      }
    });
  };
}

function mockRepeatAuthorityFor(source: EntryAggregate): void {
  apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) =>
    filters.entry_uuid
      ? {
          entries: [{
            ...source,
            entry_uuid: '11111111-1111-4111-8111-111111111111',
            status: 'draft',
            occurred_start: '2026-07-16T08:30:00.000Z',
            values: [],
          }],
          next_cursor: null,
        }
      : { entries: [source], next_cursor: null });
}

function mockRepeatAuthority(): void {
  mockRepeatAuthorityFor(repeatSource);
}

beforeEach(() => {
  window.localStorage.clear();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    reportConsoleError(...args);
  });
  translationMocks.locale = 'en';
  apiMocks.listEntries.mockReset().mockResolvedValue({ entries: [], next_cursor: null });
  apiMocks.createEntry.mockReset().mockResolvedValue({
    entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0,
  });
  apiMocks.createFinalBatch.mockReset().mockResolvedValue({
    batch_uuid: '99999999-9999-4999-8999-999999999999',
    entries: [
      {
        plot_uuid: plot.plot_uuid,
        entry_uuid: '88888888-8888-4888-8888-888888888888',
        outbox_event_uuid: '77777777-7777-4777-8777-777777777777',
        sync_version: 1,
      },
      {
        plot_uuid: homogeneousSecondPlot.plot_uuid,
        entry_uuid: '66666666-6666-4666-8666-666666666666',
        outbox_event_uuid: '55555555-5555-4555-8555-555555555555',
        sync_version: 1,
      },
    ],
  });
  apiMocks.updateEntry.mockReset().mockResolvedValue({
    entry_uuid: '11111111-1111-4111-8111-111111111111',
    sync_version: 1,
    outbox_event_uuid: 'outbox-1',
  });
  buildFinalBatchPayloadMock.mockClear();
  defaultRandomUuidCounter = 0;
  vi.spyOn(crypto, 'randomUUID').mockReset().mockImplementation(nextDefaultRandomUuid);
});

afterEach(() => {
  cleanup();
  const actWarnings = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
    args.some((value: unknown) => ACT_WARNING.test(String(value))));
  consoleErrorSpy.mockRestore();
  expect(actWarnings).toEqual([]);
});

describe('JournalCaptureFlow', () => {
  it('maps a linked zone crop label to its canonical choice for attr.crop', async () => {
    const propsWithZoneCrop = {
      ...baseProps,
      catalog: canonicalCropCatalog,
      zoneCrops: { 'zone-1': 'Barley, Winter' },
    };
    render(<JournalCaptureFlow {...propsWithZoneCrop} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        season_crop: 'Barley, Winter',
        values: expect.arrayContaining([
          expect.objectContaining({
            attribute_code: 'attr.crop',
            value: 'agroscope.crop.barley_winter',
          }),
        ]),
      }),
    ));
  });

  it('keeps an unmatched zone crop as season context without emitting an invalid choice', async () => {
    const propsWithBroadZoneCrop = {
      ...baseProps,
      catalog: canonicalCropCatalog,
      zoneCrops: { 'zone-1': 'Barley' },
    };
    render(<JournalCaptureFlow {...propsWithBroadZoneCrop} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalled());
    const payload = apiMocks.updateEntry.mock.calls[0][1];
    expect(payload.season_crop).toBe('Barley');
    expect(payload.values).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_code: 'attr.crop' }),
    ]));
  });

  it('seeds a mapped zone crop into the editable full-record crop choice', async () => {
    window.localStorage.setItem('osi.journal.detailLevel', 'full_record');
    const releaseJournalEffects = deferJournalEffects();
    const seedingCatalog: JournalCatalog = {
      ...canonicalCropCatalog,
      vocab: [...canonicalCropCatalog.vocab, row('seeding', 'activity')],
      layouts: canonicalCropCatalog.layouts.map((candidate) => ({
        ...candidate,
        definition: {
          ...candidate.definition,
          activity_codes: ['irrigation', 'seeding'],
        },
      })),
    };
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={seedingCatalog}
      initialPlot={plot}
      zoneCrops={{ 'zone-1': 'barley, winter' }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'seeding' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('combobox', { name: 'attr.crop' })).toHaveValue(
      'agroscope.crop.barley_winter',
    );
    await releaseJournalEffects();
  });

  it('preserves an edited full-record crop through confirmation and finalization', async () => {
    window.localStorage.setItem('osi.journal.detailLevel', 'full_record');
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={canonicalCropCatalog}
      initialPlot={plot}
      zoneCrops={{ 'zone-1': 'Barley, Winter' }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    const cropControl = screen.getByRole('combobox', { name: 'attr.crop' });
    expect(cropControl).toHaveValue('agroscope.crop.barley_winter');
    fireEvent.change(cropControl, { target: { value: 'agroscope.crop.barley_spring' } });
    expect(cropControl).toHaveValue('agroscope.crop.barley_spring');

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry.mock.calls.some(([, payload]) => payload.status === 'final')).toBe(true));
    const finalPayload = apiMocks.updateEntry.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => payload.status === 'final');
    expect(finalPayload.values.filter((value: { attribute_code: string }) => value.attribute_code === 'attr.crop'))
      .toEqual([{
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value: 'agroscope.crop.barley_spring',
      }]);
  });

  it('does not restore the seeded crop after clearing the full-record crop', async () => {
    window.localStorage.setItem('osi.journal.detailLevel', 'full_record');
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={canonicalCropCatalog}
      initialPlot={plot}
      zoneCrops={{ 'zone-1': 'Barley, Winter' }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    const cropControl = screen.getByRole('combobox', { name: 'attr.crop' });
    expect(cropControl).toHaveValue('agroscope.crop.barley_winter');
    fireEvent.change(cropControl, { target: { value: '' } });
    expect(cropControl).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    expect(screen.queryByText(/attr\.crop: barley, winter/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry.mock.calls.some(([, payload]) => payload.status === 'final')).toBe(true));
    const finalPayload = apiMocks.updateEntry.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => payload.status === 'final');
    expect(finalPayload.values.filter((value: { attribute_code: string }) => value.attribute_code === 'attr.crop'))
      .toEqual([]);
  });

  it('injects the mapped crop for a quick form without an attr.crop control', async () => {
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={quickWithoutCropCatalog}
      initialPlot={plot}
      zoneCrops={{ 'zone-1': 'Barley, Winter' }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.queryByRole('combobox', { name: 'attr.crop' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry.mock.calls.some(([, payload]) => payload.status === 'final')).toBe(true));
    const finalPayload = apiMocks.updateEntry.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => payload.status === 'final');
    expect(finalPayload.values.filter((value: { attribute_code: string }) => value.attribute_code === 'attr.crop'))
      .toEqual([{
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value: 'agroscope.crop.barley_winter',
      }]);
  });

  it('keeps an editable form crop ahead of an activity-derived same-key default', async () => {
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={activityCropDependencyCatalog}
      initialPlot={plot}
      zoneCrops={{ 'zone-1': 'Barley, Winter' }}
    />);

    fireEvent.click(screen.getByRole('button', { name: /irrigation \/ barley, spring/i }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    const cropControl = screen.getByRole('combobox', { name: 'attr.crop' });
    fireEvent.change(cropControl, { target: { value: 'agroscope.crop.barley_winter' } });
    expect(cropControl).toHaveValue('agroscope.crop.barley_winter');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry.mock.calls.some(([, payload]) => payload.status === 'final')).toBe(true));
    const finalPayload = apiMocks.updateEntry.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => payload.status === 'final');
    expect(finalPayload.values.filter((value: { attribute_code: string }) => value.attribute_code === 'attr.crop'))
      .toEqual([{
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value: 'agroscope.crop.barley_winter',
      }]);
  });

  it('moves keyboard focus to the capture heading on entry', async () => {
    render(<JournalCaptureFlow {...baseProps} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.title' })).toHaveFocus());
  });

  it('renders the primary Next control with a computed 56px minimum height', () => {
    render(<JournalCaptureFlow {...baseProps} />);

    const next = screen.getByRole('button', { name: 'capture.next' });
    expect(next.style.minHeight).toBe('56px');
    expect(getComputedStyle(next).minHeight).toBe('56px');
  });

  it('completes a full capture transition inside React StrictMode', async () => {
    render(
      <StrictMode>
        <JournalCaptureFlow {...baseProps} initialPlot={plot} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
  });

  it('initializes the local occurrence in the effective farm timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T22:30:00.000Z'));
    try {
      render(<JournalCaptureFlow {...baseProps} initialTimezone="Europe/Zurich" />);
      fireEvent.click(screen.getByRole('button', { name: 'North field' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

      expect(screen.getByLabelText(START_OCCURRENCE_LABEL)).toHaveValue('2026-01-15T23:30');
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders with an invalid supplied timezone and reports it through normal validation', async () => {
    render(<JournalCaptureFlow {...baseProps} initialTimezone="Mars/Olympus" initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('textbox', { name: 'capture.where.timezone' })).toHaveValue('Mars/Olympus');
    expect(screen.getByLabelText(START_OCCURRENCE_LABEL)).not.toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidTimezone');
    cleanup();
  });

  it('keeps single-plot draft POST then PUT promotion unchanged', async () => {
    window.localStorage.setItem('osi.journal.detailLevel', 'full_record');
    render(<JournalCaptureFlow {...baseProps} />);
    expect(screen.getByRole('heading', { name: 'capture.where.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'greenhouse · v6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /greenhouse/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /capture.finish/ }));
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    ));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ template_code: 'full_record', template_version: 2, layout_code: 'greenhouse', layout_version: 6 }),
    ));
    expect(apiMocks.updateEntry.mock.calls[apiMocks.updateEntry.mock.calls.length - 1]?.[1]).toEqual(
      expect.objectContaining({ status: 'final' }),
    );
  });

  it('adopts the linked plot timezone when generic capture selects a plot', async () => {
    const browserTimezone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'America/Los_Angeles' } as Intl.ResolvedDateTimeFormatOptions);
    try {
      render(<JournalCaptureFlow
        {...baseProps}
        zoneTimezones={{ 'zone-1': 'Europe/Zurich' }}
      />);

      fireEvent.click(screen.getByRole('button', { name: 'North field' }));

      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

      await waitFor(() => expect(screen.getByRole('textbox', { name: 'capture.where.timezone' })).toHaveValue('Europe/Zurich'));
    } finally {
      browserTimezone.mockRestore();
    }
  });

  it('starts preselected plots at Activity and keeps the bound layout passive', async () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'capture.where.title' })).not.toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'greenhouse · v6')).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
  });

  it('uses PlotPicker as the only plot authority and rejects an inactive initial plot', () => {
    const inactivePlot = {
      ...plot,
      plot_uuid: '33333333-3333-4333-8333-333333333333',
      name: 'Inactive field',
      active: 0,
      deleted_at: timestamp,
    };
    render(<JournalCaptureFlow {...baseProps} plots={[inactivePlot]} initialPlot={inactivePlot} />);

    expect(screen.getByRole('heading', { name: 'capture.where.title' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'capture.where.plot' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /where\.noPlot/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Inactive field' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidDefinition');
  });

  it('requires crop text for a sensorless plot while keeping its bound layout passive', () => {
    render(<JournalCaptureFlow {...baseProps} plots={[sensorlessPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'South field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByText('capture.validation.cropRequired')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'capture.carry.crop' })).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'greenhouse · v6')).toBeInTheDocument();
    cleanup();
  });

  it('requires crop text before a preselected sensorless plot can leave Activity', () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={sensorlessPlot} />);
    expect(screen.getByRole('textbox', { name: 'capture.carry.crop' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByText('capture.validation.cropRequired')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    cleanup();
  });

  it('requires an explicit growing setting for farm-level capture', () => {
    render(<JournalCaptureFlow {...baseProps} plots={[]} />);
    const layout = screen.getByRole('combobox', { name: 'capture.where.layout' });
    expect(layout).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.invalidDefinition');
    fireEvent.change(layout, { target: { value: 'greenhouse' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    cleanup();
  });

  it('floors the default quick preference to the only template a layout supports', async () => {
    // Default pref is farmer_quick (beforeEach clears localStorage), but this
    // layout only supports research_observation (U4: a researcher-only layout
    // floors a Quick user to Research). There is no per-entry combobox anymore
    // to observe the clamp directly, so we assert its effect: no picker renders,
    // and the saved entry carries the floored template.
    render(<JournalCaptureFlow {...baseProps} catalog={researchOnlyCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.queryByRole('combobox', { name: 'capture.form.detailLevel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    return waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ template_code: 'research_observation', template_version: 9 }),
    ));
  });

  describe('Slice A: effective capture template resolves from the global detail-level preference', () => {
    it('uses the preferred template on a multi-template layout (farmer_quick)', async () => {
      window.localStorage.setItem('osi.journal.detailLevel', 'farmer_quick');
      render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
      fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

      expect(screen.queryByRole('combobox', { name: 'capture.form.detailLevel' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
      await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        expect.objectContaining({ template_code: 'farmer_quick', template_version: 4 }),
      ));
    });

    it('uses the preferred template on a multi-template layout (research_observation)', async () => {
      window.localStorage.setItem('osi.journal.detailLevel', 'research_observation');
      render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
      fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

      expect(screen.queryByRole('combobox', { name: 'capture.form.detailLevel' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
      await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        expect.objectContaining({ template_code: 'research_observation', template_version: 9 }),
      ));
    });

    it('floors an unsupported preferred template to the lowest template the layout supports', async () => {
      window.localStorage.setItem('osi.journal.detailLevel', 'farmer_quick');
      render(<JournalCaptureFlow {...baseProps} catalog={researchOnlyCatalog} initialPlot={plot} />);
      fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

      expect(screen.queryByRole('combobox', { name: 'capture.form.detailLevel' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
      await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        expect.objectContaining({ template_code: 'research_observation', template_version: 9 }),
      ));
    });
  });

  it('carries typed activity dependency choices into confirmation and final values', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={dependencyCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'fertilization / Spreading / Broadcast spreader' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('combobox', { name: 'attr.operation' })).toHaveValue('operation.spreading');
    expect(screen.getByRole('combobox', { name: 'attr.device' })).toHaveValue('device.broadcast');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByText('Spreading')).toBeInTheDocument();
    expect(screen.getByText('Broadcast spreader')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        activity_code: 'fertilization',
        values: expect.arrayContaining([
          expect.objectContaining({ attribute_code: 'attr.operation', value: 'operation.spreading' }),
          expect.objectContaining({ attribute_code: 'attr.device', value: 'device.broadcast' }),
        ]),
      }),
    ));
  });

  it('persists the stable draft before applying a safe stored-draft carry-forward value', async () => {
    const source = entry({
      entry_uuid: 'source-1',
      plot_uuid: 'plot-1',
      zone_uuid: 'zone-1',
      activity_code: 'irrigation',
      occurred_start: '2026-07-16T00:00:00.000Z',
      status: 'final',
      season_uuid: 'season-1',
      season_crop: 'Wheat',
      layout_code: 'greenhouse',
      layout_version: 6,
      values: [{
        group_index: 0,
        attribute_code: 'attr.crop',
        value_status: 'observed' as const,
        value_text: 'Barley',
        value_num: null,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => {
      if (filters.entry_uuid) {
        return { entries: [{ ...source, entry_uuid: '11111111-1111-4111-8111-111111111111', status: 'draft', values: [] }], next_cursor: null };
      }
      return { entries: [source], next_cursor: null };
    });
    render(<JournalCaptureFlow {...baseProps} recentEntries={[source]} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    expect(apiMocks.createEntry.mock.calls[0][0].values).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ attribute_code: 'attr.crop', value: 'Barley' })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.prefilled')).toBeInTheDocument());
  });

  it('quick-entry carry-forward marks and submits all three low-risk values in the final payload (Task 27 P4 fix)', async () => {
    const source = entry({
      entry_uuid: 'source-triple',
      plot_uuid: 'plot-1',
      zone_uuid: 'zone-1',
      activity_code: 'irrigation',
      occurred_start: '2026-07-16T00:00:00.000Z',
      status: 'final',
      season_uuid: 'season-1',
      season_crop: 'Wheat',
      layout_code: 'greenhouse',
      layout_version: 6,
      values: [
        {
          group_index: 0,
          attribute_code: 'attr.operator',
          value_status: 'observed' as const,
          value_text: 'Alex',
          value_num: null,
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.equipment',
          value_status: 'observed' as const,
          value_text: 'Boom sprayer',
          value_num: null,
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.method',
          value_status: 'observed' as const,
          value_text: 'Drip line',
          value_num: null,
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
      ],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => {
      if (filters.entry_uuid) {
        return { entries: [{ ...source, entry_uuid: '11111111-1111-4111-8111-111111111111', status: 'draft', values: [] }], next_cursor: null };
      }
      return { entries: [source], next_cursor: null };
    });
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={tripleCarryForwardCatalog}
      recentEntries={[source]}
      initialPlot={plot}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.prefilled')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'attr.operator' })).toHaveValue('Alex'));
    expect(screen.getByRole('textbox', { name: 'attr.equipment' })).toHaveValue('Boom sprayer');
    expect(screen.getByRole('textbox', { name: 'attr.method' })).toHaveValue('Drip line');

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        values: expect.arrayContaining([
          expect.objectContaining({ attribute_code: 'attr.operator', value: 'Alex' }),
          expect.objectContaining({ attribute_code: 'attr.equipment', value: 'Boom sprayer' }),
          expect.objectContaining({ attribute_code: 'attr.method', value: 'Drip line' }),
        ]),
      }),
    ));
  });

  it('revalidates an out-of-range automatic carry-forward value before Finish', async () => {
    const source = entry({
      entry_uuid: 'source-invalid-automatic',
      occurred_start: '2026-07-15T00:00:00.000Z',
      values: [{
        group_index: 0,
        attribute_code: 'attr.amount',
        value_status: 'observed',
        value_num: 2500,
        value_text: null,
        unit_code: 'unit.kg',
        entered_value_num: 2500,
        entered_unit_code: 'unit.kg',
      }],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => filters.entry_uuid
      ? {
          entries: [{
            ...source,
            entry_uuid: '11111111-1111-4111-8111-111111111111',
            occurred_start: '2026-07-16T08:30:00.000Z',
            status: 'draft',
            values: [],
          }],
          next_cursor: null,
        }
      : { entries: [source], next_cursor: null });
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={invalidAutomaticCarryCatalog}
      recentEntries={[source]}
      initialPlot={plot}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    try {
      await waitFor(() => expect(screen.getByText('2,500 kg/ha')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'capture.finish' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
      expect(screen.getByRole('textbox', { name: 'Applied amount' })).toHaveValue('2500');
      expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.maximum');
    } finally {
      cleanup();
    }
  });

  it('fails closed when the paged activity shortlist query rejects', async () => {
    const activityCodes = ['irrigation', 'activity-2', 'activity-3', 'activity-4', 'activity-5', 'activity-6', 'activity-7'];
    const manyActivitiesCatalog: JournalCatalog = {
      ...catalog,
      vocab: [...catalog.vocab, ...activityCodes.slice(1).map((code) => row(code, 'activity'))],
      layouts: [{
        ...catalog.layouts[0],
        definition: { ...catalog.layouts[0].definition, activity_codes: activityCodes },
      }],
    };
    apiMocks.listEntries.mockRejectedValue(new Error('paged history unavailable'));
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={manyActivitiesCatalog}
      recentEntries={activityCodes.map((activity_code, index) => entry({
        entry_uuid: `recent-${index}`,
        activity_code,
        occurred_start: `2026-07-${String(16 - index).padStart(2, '0')}T00:00:00.000Z`,
      }))}
      initialPlot={plot}
    />);

    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
    expect(screen.queryByText('capture.picker.commonThisSeason')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'capture.picker.recentOnPlot' })).not.toBeInTheDocument();
  });

  it('holds Details to Confirm until stable draft and carry-forward authority finish', async () => {
    let resolveDraft: ((value: unknown) => void) | undefined;
    apiMocks.createEntry.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDraft = resolve;
    }));
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'capture.confirm.title' })).not.toBeInTheDocument();
    resolveDraft?.({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
  });

  it('locks context changes while carry-forward authority is pending', async () => {
    let resolveDraft: ((value: unknown) => void) | undefined;
    let resolveAuthority: ((value: unknown) => void) | undefined;
    const source = entry({ entry_uuid: 'source-pending-authority', values: [] });
    apiMocks.createEntry.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDraft = resolve;
    }));
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string; plot_uuid?: string }) => {
      if (filters.entry_uuid) {
        return { entries: [{ ...source, entry_uuid: '11111111-1111-4111-8111-111111111111', status: 'draft', values: [] }], next_cursor: null };
      }
      if (!filters.plot_uuid) {
        return new Promise((resolve) => { resolveAuthority = resolve; });
      }
      return { entries: [], next_cursor: null };
    });
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    await act(async () => {
      resolveDraft?.({ entry_uuid: '11111111-1111-4111-8111-111111111111', sync_version: 0 });
      await Promise.resolve();
    });
    await waitFor(() => expect(resolveAuthority).toBeDefined());

    const back = screen.getByRole('button', { name: 'capture.back' });
    const close = screen.getByRole('button', { name: 'capture.close' });
    expect(back).toBeDisabled();
    expect(close).toBeDisabled();
    const timezoneInput = screen.getByRole('textbox', { name: 'capture.where.timezone' });
    expect(timezoneInput).toBeDisabled();
    const cropInput = screen.getByRole('textbox', { name: 'attr.crop' });
    expect(cropInput).toBeDisabled();
    await act(async () => {
      fireEvent.change(cropInput, { target: { value: 'Changed while pending' } });
      await Promise.resolve();
    });
    expect(cropInput).toHaveValue('');

    await act(async () => {
      resolveAuthority?.({ entries: [source], next_cursor: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
  });

  it('removes an automatic carry-forward value when its occurrence context changes', async () => {
    const source = entry({
      entry_uuid: 'source-context',
      occurred_start: '2026-07-15T00:00:00.000Z',
      values: [{
        group_index: 0,
        attribute_code: 'attr.crop',
        value_status: 'observed' as const,
        value_text: 'Barley',
        value_num: null,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => {
      if (filters.entry_uuid) {
        return { entries: [{ ...source, entry_uuid: '11111111-1111-4111-8111-111111111111', status: 'draft', values: [] }], next_cursor: null };
      }
      return { entries: [source], next_cursor: null };
    });
    render(<JournalCaptureFlow {...baseProps} recentEntries={[source]} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'attr.crop' })).toHaveValue('Barley'));

    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), { target: { value: '2026-07-17T00:00' } });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'attr.crop' })).toHaveValue(''));
    cleanup();
  });

  it('does not automatically apply an unsafe protected value from the stored-draft authority', async () => {
    const source = entry({
      entry_uuid: 'source-protected',
      plot_uuid: 'plot-1',
      zone_uuid: 'zone-1',
      activity_code: 'plant_protection_application',
      occurred_start: '2026-07-16T00:00:00.000Z',
      status: 'final',
      season_uuid: 'season-1',
      season_crop: 'Wheat',
      layout_code: 'greenhouse',
      layout_version: 6,
      values: [{
        group_index: 0,
        attribute_code: 'attr.product_uuid',
        value_status: 'observed' as const,
        value_text: 'product-1',
        value_num: null,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => {
      if (filters.entry_uuid) {
        return {
          entries: [{
            ...source,
            entry_uuid: '11111111-1111-4111-8111-111111111111',
            status: 'draft',
            values: [],
          }],
          next_cursor: null,
        };
      }
      return { entries: [source], next_cursor: null };
    });
    render(<JournalCaptureFlow {...baseProps} catalog={protectedCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
    expect(screen.queryByText('capture.carry.prefilled')).not.toBeInTheDocument();
  });

  it('retains accepted protected values and accepted UI across Details to Confirm to Details', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={repeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('2'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.carry.useValues' })).toBeDisabled());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('product-1');
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry.mock.calls.some(([, payload]) => payload.status === 'final')).toBe(true));
    const finalPayload = apiMocks.updateEntry.mock.calls
      .map(([, payload]) => payload)
      .find((payload) => payload.status === 'final');
    expect(finalPayload.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_code: 'attr.product_uuid', value: 'product-1' }),
      expect.objectContaining({ attribute_code: 'attr.amount_mass_area_product' }),
    ]));
  });

  it('reconciles a same-context authority replacement before exposing the new candidate', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={replacementRepeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('product-1'));

    mockRepeatAuthorityFor(replacementRepeatSource);
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.carry.useValues' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('product-2');
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('3');
    });
  });

  it('clears acceptance when the same authority row changes its complete protected content', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={replacementRepeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    const rate = screen.getByRole('textbox', { name: 'Product rate' });
    fireEvent.change(rate, { target: { value: '4' } });
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('product-1');
    expect(rate).toHaveValue('4');

    mockRepeatAuthorityFor(correctedRepeatSource);
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.carry.useValues' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('4');
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('product-2');
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('3');
    });
  });

  it('releases an edited accepted row to user ownership before a context change', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={repeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    const rate = screen.getByRole('textbox', { name: 'Product rate' });
    fireEvent.change(rate, { target: { value: '4' } });
    expect(rate).toHaveValue('4');

    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T11:30' },
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('4');
      expect(screen.getByRole('button', { name: 'capture.next' })).toBeEnabled();
    });
  });

  it('removes accepted rows and revalidates retained values when activity changes', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={activityRepeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.crop' }), {
      target: { value: 'Wheat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'attr.crop' })).toHaveValue('Wheat');
    expect(screen.getByRole('button', { name: 'capture.next' })).toBeEnabled();
  });

  it('removes accepted protected values when the farmer switches plots', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={repeatFlowCatalog}
      plots={[plot, homogeneousSecondPlot]}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'East field' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'plant_protection_application' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
  });

  it('removes accepted protected values when a refreshed plot changes its layout', async () => {
    mockRepeatAuthority();
    const props = {
      ...baseProps,
      catalog: repeatFlowCatalog,
      recentEntries: [repeatSource],
      initialPlot: plot,
    };
    const { rerender } = render(<JournalCaptureFlow {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    rerender(<JournalCaptureFlow {...props} plots={[layoutSwitchPlot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'North field' })).toHaveAttribute('aria-pressed', 'false'));
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'North field' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'plant_protection_application' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.next' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
  });

  it('removes accepted protected values when the occurrence changes', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={repeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('2');

    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T11:30' },
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
    });
  });

  it('removes accepted protected values when the timezone changes', async () => {
    mockRepeatAuthority();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={repeatFlowCatalog}
      recentEntries={[repeatSource]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('2');

    fireEvent.change(screen.getByLabelText('capture.where.timezone'), {
      target: { value: 'UTC' },
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
    });
  });

  it('removes automatic and accepted carry-forward rows before clearing ownership on plot change', async () => {
    mockRepeatAuthorityFor(repeatSourceWithAutomatic);
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={automaticRepeatFlowCatalog}
      plots={[plot, homogeneousSecondPlot]}
      recentEntries={[repeatSourceWithAutomatic]}
      initialPlot={plot}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'attr.operator' })).toHaveValue('Alex'));
    expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('2');

    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'East field' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'attr.operator' })).toHaveValue('');
      expect(screen.getByRole('combobox', { name: 'capture.form.product' })).toHaveValue('');
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('');
    });
  });

  it('revalidates an out-of-range repeat-treatment merge before saving another draft', async () => {
    const source = entry({
      entry_uuid: 'source-invalid-repeat',
      activity_code: 'plant_protection_application',
      occurred_start: '2026-07-15T00:00:00.000Z',
      values: [{
        group_index: 0,
        attribute_code: 'attr.product_uuid',
        value_status: 'observed',
        value_num: null,
        value_text: 'product-1',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }, {
        group_index: 0,
        attribute_code: 'attr.amount_mass_area_product',
        value_status: 'observed',
        value_num: 2500,
        value_text: null,
        unit_code: 'unit.kg_per_ha_product',
        entered_value_num: 2500,
        entered_unit_code: 'unit.kg_per_ha_product',
      }],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => filters.entry_uuid
      ? {
          entries: [{
            ...source,
            entry_uuid: '11111111-1111-4111-8111-111111111111',
            occurred_start: '2026-07-16T08:30:00.000Z',
            status: 'draft',
            values: [],
          }],
          next_cursor: null,
        }
      : { entries: [source], next_cursor: null });
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={invalidRepeatCatalog}
      recentEntries={[source]}
      initialPlot={plot}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'plant_protection_application' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    try {
      await waitFor(() => expect(screen.getByText('capture.carry.repeatTreatment')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'capture.carry.useValues' }));
      expect(screen.getByRole('textbox', { name: 'Product rate' })).toHaveValue('2500');
      expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.maximum');
      const updatesBefore = apiMocks.updateEntry.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(apiMocks.updateEntry).toHaveBeenCalledTimes(updatesBefore);
      expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    } finally {
      cleanup();
    }
  });

  it('merges safe stored-draft prefills without replacing typed dependency choices', async () => {
    const source = entry({
      entry_uuid: 'source-dependent',
      plot_uuid: 'plot-1',
      zone_uuid: 'zone-1',
      activity_code: 'fertilization',
      occurred_start: '2026-07-16T00:00:00.000Z',
      status: 'final',
      season_uuid: 'season-1',
      season_crop: 'Wheat',
      layout_code: 'greenhouse',
      layout_version: 6,
      values: [{
        group_index: 0,
        attribute_code: 'attr.crop',
        value_status: 'observed' as const,
        value_text: 'Barley',
        value_num: null,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => {
      if (filters.entry_uuid) {
        return {
          entries: [{
            ...source,
            entry_uuid: '11111111-1111-4111-8111-111111111111',
            status: 'draft',
            values: [],
          }],
          next_cursor: null,
        };
      }
      return { entries: [source], next_cursor: null };
    });
    render(<JournalCaptureFlow {...baseProps} catalog={dependencyCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'fertilization / Spreading / Broadcast spreader' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    await waitFor(() => expect(screen.getByText('capture.carry.prefilled')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'attr.crop' })).toHaveValue('Barley');
    expect(screen.getByRole('combobox', { name: 'attr.operation' })).toHaveValue('operation.spreading');
    expect(screen.getByRole('combobox', { name: 'attr.device' })).toHaveValue('device.broadcast');
  });

  it('does not enter confirmation while a newly selected template has an empty required field', () => {
    render(<JournalCaptureFlow {...baseProps} catalog={requiredCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.required');
    cleanup();
  });

  it('resolves and persists an explicit end occurrence offset', async () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByLabelText(START_OCCURRENCE_LABEL)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(END_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T14:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(END_OCCURRENCE_LABEL) })).toBeInTheDocument());
    expect(screen.getByText('Europe/Zurich')).toBeInTheDocument();

    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        occurred_end_local: '2026-07-16T14:30',
        occurred_end_utc_offset_minutes: 120,
      }),
    ));
  });

  it('requires and persists an explicit UTC offset for a DST-fold end occurrence', async () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-10-25T01:30' },
    });
    fireEvent.change(screen.getByLabelText(END_OCCURRENCE_LABEL), {
      target: { value: '2026-10-25T02:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.ambiguousLocalTime');
    const endOffset = screen.getByRole('combobox', {
      name: 'capture.validation.chooseUtcOffset · capture.form.optional',
    });
    fireEvent.change(endOffset, { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        occurred_end_local: '2026-10-25T02:30',
        occurred_end_utc_offset_minutes: 60,
      }),
    ));
  });

  it('reads back entered numeric values and units while preserving canonical payload values', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={numericCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Applied amount' }), {
      target: { value: '1500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'g/ha' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByText('1,500 g/ha')).toBeInTheDocument());
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalledWith(expect.objectContaining({
      values: expect.arrayContaining([expect.objectContaining({
        attribute_code: 'attr.amount',
        value_num: 1.5,
        unit_code: 'unit.kg',
        entered_value_num: 1500,
        entered_unit_code: 'unit.g',
      })]),
    })));
  });

  it('formats confirmation numbers, dates, and duplicate values with the active app locale', async () => {
    translationMocks.locale = 'fr';
    apiMocks.listEntries.mockResolvedValue({ entries: [entry({
      entry_uuid: duplicateUuid(1),
      occurred_start: '2026-07-16T08:30:00.000Z',
      values: [{
        group_index: 0,
        attribute_code: 'attr.amount',
        value_status: 'observed' as const,
        value_num: 12.5,
        value_text: null,
        unit_code: 'unit.kg',
        entered_value_num: 12.5,
        entered_unit_code: 'unit.kg',
      }],
    })], next_cursor: null });
    render(<JournalCaptureFlow {...baseProps} catalog={numericCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Applied amount' }), {
      target: { value: '12.5' },
    });
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-07-16T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    const expectedDate = new Intl.DateTimeFormat('fr', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich',
    }).format(new Date('2026-07-16T08:30:00.000Z'));
    await waitFor(() => expect(screen.getAllByText(expectedDate).length).toBeGreaterThan(0));
    expect(screen.getByText(`Applied amount: ${new Intl.NumberFormat('fr').format(12.5)} kg/ha`)).toBeInTheDocument();
  });

  it('localizes boolean confirmation values with the existing Yes and No keys', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={booleanCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.form.booleanYes' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    expect(screen.getByText('capture.form.booleanYes')).toBeInTheDocument();
    expect(screen.queryByText('true')).not.toBeInTheDocument();
  });

  it('uses the translated Crop label for sensorless crop context', () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={sensorlessPlot} />);
    expect(screen.getByRole('textbox', { name: 'capture.carry.crop' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'capture.form.value' })).not.toBeInTheDocument();
    cleanup();
  });

  it('lets a confirm token return to its owning edit step', async () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /irrigation/ }));
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
  });

  it('shows the preliminary duplicate candidate with separate open and save actions', async () => {
    apiMocks.listEntries.mockResolvedValue({
      entries: [{
        entry_uuid: duplicateUuid(2), plot_uuid: 'plot-1', activity_code: 'irrigation',
        occurred_start: '2026-07-16T08:30:00.000Z', status: 'final', values: [{
          group_index: 0, attribute_code: 'attr.crop', value_status: 'observed',
          value_text: 'Wheat', value_num: null, unit_code: null,
          entered_value_num: null, entered_unit_code: null,
        }],
      }],
      next_cursor: null,
    });
    const onOpenExisting = vi.fn();
    render(<JournalCaptureFlow {...baseProps} onOpenExisting={onOpenExisting} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
    expect(screen.getByText('attr.crop: Wheat')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.openExisting' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.confirm.openExisting' }));
    expect(onOpenExisting).toHaveBeenCalledWith(duplicateUuid(2));
  });

  it('ignores malformed preliminary duplicate candidates without trapping final save', async () => {
    apiMocks.listEntries.mockImplementation(async (filters: { occurred_from?: string }) => filters.occurred_from
      ? {
          entries: [
            entry({ entry_uuid: '', activity_code: 'irrigation' }),
            entry({ entry_uuid: duplicateUuid(90), occurred_start: 'not-a-time' }),
            entry({ entry_uuid: duplicateUuid(91), activity_code: '   ' }),
            entry({ entry_uuid: duplicateUuid(92), occurred_start: '1' }),
            entry({ entry_uuid: duplicateUuid(93), occurred_start: '2026-07-16T08:30:00' }),
            entry({ entry_uuid: duplicateUuid(94), occurred_start: '2026-02-30T08:30:00Z' }),
          ],
          next_cursor: null,
        }
      : { entries: [], next_cursor: null });
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    expect(screen.queryByRole('button', { name: 'capture.confirm.openExisting' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalled());
  });

  it('localizes the activity shown for a duplicate candidate', async () => {
    translationMocks.locale = 'de';
    const localizedCatalog: JournalCatalog = {
      ...catalog,
      vocab: catalog.vocab.map((candidate) => candidate.code === 'irrigation'
        ? { ...candidate, labels: { en: 'Irrigation', de: 'Bewässerung' } }
        : candidate),
    };
    apiMocks.listEntries.mockImplementation(async (filters: { occurred_from?: string }) => filters.occurred_from
      ? {
          entries: [entry({
            entry_uuid: duplicateUuid(95),
            occurred_start: '2026-07-16T08:30:00.000Z',
          })],
          next_cursor: null,
        }
      : { entries: [], next_cursor: null });
    render(<JournalCaptureFlow {...baseProps} catalog={localizedCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bewässerung' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    const duplicateAlert = await screen.findByRole('alert');
    expect(duplicateAlert).toHaveTextContent('Bewässerung');
    expect(duplicateAlert).not.toHaveTextContent('irrigation');
  });

  it('keeps every plural duplicate candidate review localized and attributable', async () => {
    translationMocks.locale = 'de';
    const localizedCatalog: JournalCatalog = {
      ...catalog,
      vocab: catalog.vocab.map((candidate) => candidate.code === 'irrigation'
        ? { ...candidate, labels: { en: 'Irrigation', de: 'Bewässerung' } }
        : candidate),
    };
    const candidates = [
      { entryUuid: duplicateUuid(14), occurredStart: '2026-07-16T08:30:00.000Z', activityCode: 'irrigation', plotUuid: plot.plot_uuid },
      { entryUuid: duplicateUuid(15), occurredStart: '2026-07-16T09:30:00.000Z', activityCode: 'irrigation', plotUuid: homogeneousSecondPlot.plot_uuid },
    ];
    apiMocks.createFinalBatch.mockRejectedValueOnce({
      response: { data: { error: 'duplicate_candidates', details: { duplicateCandidates: candidates } } },
    });
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={localizedCatalog}
      plots={[plot, homogeneousSecondPlot]}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bewässerung' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(duplicateUuid(14)));

    const firstDate = new Intl.DateTimeFormat('de', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich',
    }).format(new Date(candidates[0].occurredStart));
    const secondDate = new Intl.DateTimeFormat('de', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich',
    }).format(new Date(candidates[1].occurredStart));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(firstDate);
    expect(alert).toHaveTextContent(secondDate);
    expect(alert).toHaveTextContent('Bewässerung');
    expect(alert).toHaveTextContent(duplicateUuid(14));
    expect(alert).toHaveTextContent(duplicateUuid(15));
  });

  it('ignores malformed duplicate candidates and value rows without crashing', async () => {
    apiMocks.updateEntry.mockRejectedValueOnce({
      response: {
        data: {
          error: 'duplicate_candidate',
          details: {
            duplicateCandidate: {
              entryUuid: duplicateUuid(3),
              occurredStart: '2026-07-16T08:30:00.000Z',
              activityCode: 'irrigation',
              values: [null, { attribute_code: 'attr.crop' }, {
                group_index: 0,
                attribute_code: 'attr.crop',
                value_status: 'observed',
                value_text: 'Authoritative crop',
                value_num: null,
                unit_code: null,
                entered_value_num: null,
                entered_unit_code: null,
              }],
            },
          },
        },
      },
    });
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.openExisting' })).toBeInTheDocument());
    expect(screen.getByText('attr.crop: Authoritative crop')).toBeInTheDocument();
    expect(screen.queryByText('attr.crop: undefined')).not.toBeInTheDocument();
  });

  it('surfaces an authoritative duplicate candidate and acknowledges that exact UUID', async () => {
    const duplicateError = Object.assign(new Error('duplicate'), {
      code: 'duplicate_candidate',
      details: {
        duplicateCandidate: {
          entryUuid: duplicateUuid(4),
          occurredStart: '2026-07-16T08:30:00.000Z',
          activityCode: 'irrigation',
          plotUuid: 'plot-1',
        },
      },
    });
    apiMocks.updateEntry
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValueOnce({
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        sync_version: 1,
        outbox_event_uuid: 'outbox-2',
      });
    const onSaved = vi.fn();
    render(<JournalCaptureFlow {...baseProps} onSaved={onSaved} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.openExisting' })).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'capture.confirm.saveSeparately' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(2));
    expect(apiMocks.updateEntry.mock.calls[1][1]).toEqual(expect.objectContaining({
      duplicate_guard_ack_entry_uuid: duplicateUuid(4),
    }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(2));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('handles the Axios response error shape and displays authoritative candidate values', async () => {
    const duplicateError = {
      response: {
        data: {
          error: 'duplicate_candidate',
          details: {
            duplicateCandidate: {
              entryUuid: duplicateUuid(5),
              occurredStart: '2026-07-16T08:30:00.000Z',
              activityCode: 'irrigation',
              plotUuid: 'plot-1',
            },
          },
        },
      },
      code: 'ERR_BAD_REQUEST',
    };
    apiMocks.updateEntry
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValueOnce({
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        sync_version: 1,
        outbox_event_uuid: 'outbox-axios',
      });
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => filters.entry_uuid
      ? { entries: [entry({ entry_uuid: filters.entry_uuid, values: [{
        group_index: 0,
        attribute_code: 'attr.crop',
        value_status: 'observed' as const,
        value_text: 'Wheat',
        value_num: null,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }] })], next_cursor: null }
      : { entries: [], next_cursor: null });
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.crop' }), {
      target: { value: 'Wheat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.openExisting' })).toBeInTheDocument());
    expect(screen.getByText('attr.crop: Wheat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.confirm.saveSeparately' }));
    await waitFor(() => expect(apiMocks.updateEntry.mock.calls[1][1]).toEqual(expect.objectContaining({
      duplicate_guard_ack_entry_uuid: duplicateUuid(5),
    })));
  });

  it('uses response duplicate error data even when Axios supplies a transport code', async () => {
    const duplicateError = {
      code: 'ERR_BAD_REQUEST',
      response: {
        data: {
          error: 'duplicate_candidate',
          details: {
            duplicateCandidate: {
              entryUuid: duplicateUuid(6),
              occurredStart: '2026-07-16T08:30:00.000Z',
              activityCode: 'irrigation',
            },
          },
        },
      },
    };
    apiMocks.updateEntry.mockRejectedValueOnce(duplicateError);
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.openExisting' })).toBeInTheDocument());
    expect(screen.queryByText('capture.save.lossWarning')).not.toBeInTheDocument();
    expect(screen.queryByText('capture.save.notSaved')).not.toBeInTheDocument();
  });

  it('fetches authoritative duplicate values instead of displaying attempted values', async () => {
    const duplicateError = {
      response: {
        data: {
          error: 'duplicate_candidate',
          details: {
            duplicateCandidate: {
              entryUuid: duplicateUuid(7),
              occurredStart: '2026-07-16T08:30:00.000Z',
              activityCode: 'irrigation',
            },
          },
        },
      },
    };
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => filters.entry_uuid
      ? { entries: [entry({ entry_uuid: filters.entry_uuid, values: [{
        group_index: 0,
        attribute_code: 'attr.crop',
        value_status: 'observed' as const,
        value_text: 'Existing crop',
        value_num: null,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }] })], next_cursor: null }
      : { entries: [], next_cursor: null });
    apiMocks.updateEntry.mockRejectedValueOnce(duplicateError);
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.crop' }), { target: { value: 'Attempted crop' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByText('attr.crop: Existing crop')).toBeInTheDocument());
    expect(screen.queryByText('attr.crop: Attempted crop')).not.toBeInTheDocument();
  });

  it('omits duplicate values honestly when the authoritative candidate fetch fails', async () => {
    const duplicateError = {
      response: {
        data: {
          error: 'duplicate_candidate',
          details: {
            duplicateCandidate: {
              entryUuid: duplicateUuid(8),
              occurredStart: '2026-07-16T08:30:00.000Z',
              activityCode: 'irrigation',
            },
          },
        },
      },
    };
    apiMocks.listEntries.mockImplementation(async (filters: { entry_uuid?: string }) => {
      if (filters.entry_uuid === duplicateUuid(8)) throw new Error('candidate fetch failed');
      if (filters.entry_uuid) return { entries: [entry({ entry_uuid: filters.entry_uuid, status: 'draft', values: [] })], next_cursor: null };
      return { entries: [], next_cursor: null };
    });
    apiMocks.updateEntry.mockRejectedValueOnce(duplicateError);
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.crop' }), { target: { value: 'Attempted crop' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.openExisting' })).toBeInTheDocument());
    expect(screen.queryByText('attr.crop: Attempted crop')).not.toBeInTheDocument();
  });

  it('keeps an invalid explicit-unit value blocking confirmation at the research detail level', async () => {
    // Formerly exercised the same catalog by switching templates mid-flow via
    // the (now-removed) per-entry combobox: full_record -> enter an invalid
    // value -> switch to research_observation -> still blocked. Detail level
    // is a Settings-only preference now (Slice A), so there is no in-flow
    // switch to perform; this pins the surviving behavior instead — an invalid
    // explicit-unit value blocks confirmation under a pref'd stricter template.
    window.localStorage.setItem('osi.journal.detailLevel', 'research_observation');
    render(<JournalCaptureFlow {...baseProps} catalog={invalidRetainedTemplateCatalog} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Explicit amount' }), {
      target: { value: '5' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.incompatibleUnit');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'capture.confirm.title' })).not.toBeInTheDocument();
    expect(apiMocks.createEntry).not.toHaveBeenCalled();
  });

  it('clears plot-bound activity, dependencies, and recents before the next plot history resolves', async () => {
    const irrigationRecent = entry({
      entry_uuid: 'plot-a-irrigation',
      activity_code: 'irrigation',
      occurred_start: '2026-07-16T00:00:00.000Z',
      values: [],
    });
    const fertilizationRecent = entry({
      entry_uuid: 'plot-a-fertilization',
      activity_code: 'fertilization',
      occurred_start: '2026-07-15T00:00:00.000Z',
      values: [{
        group_index: 0,
        attribute_code: 'attr.operation',
        value_status: 'observed',
        value_num: null,
        value_text: 'operation.spreading',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }, {
        group_index: 0,
        attribute_code: 'attr.device',
        value_status: 'observed',
        value_num: null,
        value_text: 'device.broadcast',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    });
    const plotBHistory = new Promise<never>(() => undefined);
    apiMocks.listEntries.mockImplementation(async (filters: {
      activity_code?: string;
      entry_uuid?: string;
      plot_uuid?: string;
    }) => {
      if (filters.entry_uuid) return { entries: [], next_cursor: null };
      if (filters.plot_uuid === secondPlot.plot_uuid && !filters.activity_code) return plotBHistory;
      if (filters.plot_uuid === plot.plot_uuid && !filters.activity_code) {
        return { entries: [irrigationRecent, fertilizationRecent], next_cursor: null };
      }
      return { entries: [], next_cursor: null };
    });

    render(<JournalCaptureFlow
      {...baseProps}
      catalog={plotSwitchCatalog}
      plots={[plot, secondPlot]}
      initialPlot={plot}
    />);
    await waitFor(() => expect(screen.getByRole('region', {
      name: 'capture.picker.recentOnPlot',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', {
      name: 'fertilization / Spreading / Broadcast spreader',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /capture\.confirm\.plot: North field/ }));
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    expect(screen.getByRole('button', { name: 'East field' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'capture.picker.recentOnPlot' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', {
      name: 'fertilization / Spreading / Broadcast spreader',
    })).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'capture.next' });
    expect(next).toBeDisabled();
    const updateCount = apiMocks.updateEntry.mock.calls.length;
    fireEvent.click(next);
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    expect(apiMocks.updateEntry).toHaveBeenCalledTimes(updateCount);
  });

  it('warns once while acknowledging each authoritative duplicate candidate exactly', async () => {
    const duplicate = (entryUuid: string) => ({
      response: {
        data: {
          error: 'duplicate_candidate',
          details: {
            duplicateCandidate: {
              entryUuid,
              occurredStart: '2026-07-16T08:30:00.000Z',
              activityCode: 'irrigation',
              plotUuid: 'plot-1',
            },
          },
        },
      },
    });
    apiMocks.updateEntry
      .mockRejectedValueOnce(duplicate(duplicateUuid(9)))
      .mockRejectedValueOnce(duplicate(duplicateUuid(10)))
      .mockResolvedValueOnce({
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        sync_version: 1,
        outbox_event_uuid: 'outbox-warn-once',
      });
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.confirm.saveSeparately' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'capture.confirm.saveSeparately' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('capture.confirm.duplicateBody')).toHaveLength(1);
    expect(apiMocks.updateEntry.mock.calls[1][1]).toEqual(expect.objectContaining({
      duplicate_guard_ack_entry_uuid: duplicateUuid(9),
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'capture.confirm.saveSeparately' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(3));
    expect(apiMocks.updateEntry.mock.calls[2][0]).toBe(apiMocks.updateEntry.mock.calls[0][0]);
    expect(apiMocks.updateEntry.mock.calls[2][1]).toEqual(expect.objectContaining({
      duplicate_guard_ack_entry_uuid: duplicateUuid(10),
    }));
  });

  it('suppresses duplicate Finish clicks while the final submission is pending', async () => {
    let resolveUpdate: ((value: unknown) => void) | undefined;
    apiMocks.updateEntry.mockReturnValueOnce(new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    const finish = screen.getByRole('button', { name: 'capture.finish' });
    fireEvent.click(finish);
    fireEvent.click(finish);
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(1));
    resolveUpdate?.({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 1,
      outbox_event_uuid: 'outbox-3',
    });
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
  });

  it('locks confirmation navigation and becomes read-only after the final receipt', async () => {
    let resolveUpdate: ((value: unknown) => void) | undefined;
    apiMocks.updateEntry.mockReturnValueOnce(new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    expect(screen.getByRole('button', { name: 'capture.finish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /irrigation/ })).toBeDisabled();

    await act(async () => {
      resolveUpdate?.({
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        sync_version: 1,
        outbox_event_uuid: 'outbox-read-only',
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'capture.finish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /irrigation/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.close' })).not.toBeDisabled();
  });

  it('requires an explicit UTC offset for a DST-fold occurrence before confirming', async () => {
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByLabelText(START_OCCURRENCE_LABEL), {
      target: { value: '2026-10-25T02:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.ambiguousLocalTime');
    const offset = screen.getByRole('combobox', { name: 'capture.validation.chooseUtcOffset' });
    fireEvent.change(offset, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(apiMocks.createEntry).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument();
  });

  it('retries a failed final receipt with the same UUID and keeps the editable warning', async () => {
    apiMocks.updateEntry.mockRejectedValueOnce(new Error('gateway unavailable'));
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('capture.save.lossWarning'));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('capture.save.lossWarning');
    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(2));
    expect(apiMocks.updateEntry.mock.calls[1][0]).toBe(apiMocks.updateEntry.mock.calls[0][0]);
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries a failed multi-plot batch once with the immutable payload and accepts the receipt', async () => {
    apiMocks.createFinalBatch
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce({ batch_uuid: duplicateUuid(110), entries: [] });
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.save.retry' })).toBeInTheDocument());
    const firstPayload = JSON.parse(JSON.stringify(apiMocks.createFinalBatch.mock.calls[0][0]));
    expect(screen.getByRole('button', { name: 'capture.close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /capture\.confirm\.occurrence/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(2));
    expect(apiMocks.createFinalBatch.mock.calls[1][0]).toEqual(firstPayload);
    expect(apiMocks.createEntry).not.toHaveBeenCalled();
    expect(apiMocks.updateEntry).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
  });

  it('locks and deduplicates navigation and edits while a retry is pending', async () => {
    let resolveRetry: ((value: unknown) => void) | undefined;
    apiMocks.updateEntry
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));
    render(<JournalCaptureFlow {...baseProps} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('capture.save.lossWarning'));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    const retry = screen.getByRole('button', { name: 'capture.save.retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'capture.close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.back' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'attr.crop' })).toBeDisabled();

    await act(async () => {
      resolveRetry?.({
        entry_uuid: '11111111-1111-4111-8111-111111111111',
        sync_version: 1,
        outbox_event_uuid: 'outbox-retry-lock',
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
  });

  it('calls onSaved only when Close follows a successful final receipt', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<JournalCaptureFlow {...baseProps} onClose={onClose} onSaved={onSaved} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());

    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'capture.close' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 1,
      outbox_event_uuid: 'outbox-1',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('serializes repeated Close clicks while onSaved is still pending', async () => {
    let resolveSaved: (() => void) | undefined;
    const onClose = vi.fn();
    const onSaved = vi.fn(() => new Promise<void>((resolve) => { resolveSaved = resolve; }));
    render(<JournalCaptureFlow {...baseProps} onClose={onClose} onSaved={onSaved} initialPlot={plot} />);
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'capture.close' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.close' }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      resolveSaved?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('opens the layout-transition review sheet for a value the next growing setting would hide, blocks Next until it is resolved, and removes it only once the farmer explicitly says so', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={layoutSanitizationCatalog} />);
    const layoutSelect = screen.getByRole('combobox', { name: 'capture.where.layout' });
    fireEvent.change(layoutSelect, { target: { value: 'greenhouse' } });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.extra' }), {
      target: { value: 'temporary detail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /greenhouse/ }));
    const reopenedLayoutSelect = screen.getByRole('combobox', { name: 'capture.where.layout' });
    reopenedLayoutSelect.focus();
    fireEvent.change(reopenedLayoutSelect, { target: { value: 'open_field' } });

    // The value is never silently dropped: the review sheet opens immediately,
    // names the affected field, and shows its untouched current value.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeVisible();
    expect(screen.getByText('attr.extra')).toBeInTheDocument();
    expect(screen.getByText('temporary detail')).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Next is a finalize-gate no-op while the item is unresolved.
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.where.title' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeVisible();

    // Explicit resolution: the farmer removes the stale value themselves.
    fireEvent.click(screen.getByRole('button', { name: /remove.*attr\.extra/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(reopenedLayoutSelect);

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.queryByRole('textbox', { name: 'attr.extra' })).not.toBeInTheDocument();

    // Ordinary Back navigation is unaffected once the review is resolved.
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());
    expect(screen.queryByText('temporary detail')).not.toBeInTheDocument();
  });

  it('preserves a value kept under the old growing setting through to the final payload, even though the new growing setting hides its field', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={layoutSanitizationCatalog} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'greenhouse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.extra' }), {
      target: { value: 'kept detail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /greenhouse/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'open_field' },
    });

    fireEvent.click(screen.getByRole('button', { name: /keep.*attr\.extra/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.queryByRole('textbox', { name: 'attr.extra' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        values: expect.arrayContaining([
          expect.objectContaining({ attribute_code: 'attr.extra', value: 'kept detail' }),
        ]),
      }),
    ));
  });

  it('opens the layout-transition review sheet when picking a plot narrows an already-chosen value out of its allowed choices', async () => {
    // Farm-level capture first (no plot bound), then the farmer assigns the
    // entry to a specific plot — a single, atomic selectPlot() transition from
    // the farm-level "greenhouse" growing setting to plot East's "open_field"
    // one, exercising the plot-picker leg of the gate (chooseLayout's leg is
    // covered by the growing-setting-dropdown tests above).
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={layoutTransitionChoiceCatalog}
      plots={[plot, secondPlot]}
    />);
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'greenhouse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'attr.method' }), {
      target: { value: 'method.b' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('attr.method')).toBeInTheDocument();
    expect(screen.getByText('Method B')).toBeInTheDocument();

    // The finalize gate blocks progress past the unresolved choice.
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('dialog')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /remove.*method/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('surfaces an entered value through an intervening empty plot selection ([plotA] -> [] -> [plotB]) instead of losing it silently', async () => {
    // PlotPicker forbids co-selecting plots of different layouts, so switching
    // from plot A (greenhouse) to plot B (open_field) forces the farmer to
    // deselect A first — a genuine, ordinary-user-reachable empty selection
    // (`layout` becomes undefined), not a synthetic one. Task 32 originally
    // handled this by falling through to sanitizeValues(..., undefined, ...),
    // which always returns [], silently wiping every entered value with no
    // review sheet. This proves the fix: the value is surfaced (not lost)
    // through the empty step, AND the eventual real greenhouse -> open_field
    // diff still fires once plot B is picked (not suppressed by the gap).
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={layoutTransitionChoiceCatalog}
      plots={[plot, secondPlot]}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'attr.method' }), {
      target: { value: 'method.b' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    expect(screen.getByRole('heading', { name: 'capture.where.title' })).toBeInTheDocument();

    // Deselect plot A: an empty selection with a real, reachable target
    // layout of `undefined` — the exact branch that used to silently sanitize.
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Not lost: surfaced for explicit review, and Next is blocked, exactly
    // like any other layout-transition invalidation.
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('attr.method')).toBeInTheDocument();
    expect(screen.getByText('Method B')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.where.title' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeVisible();

    // Now pick plot B (open_field) without resolving the pending item first.
    // The intervening empty step must not suppress the real greenhouse ->
    // open_field diff: method.b is still not allowed under open_field.
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('attr.method')).toBeInTheDocument();
    expect(screen.getByText('Method B')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove.*method/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.picker.title' })).toBeInTheDocument();
  });

  it('retries a failed finalize after resolving a layout-transition item, keeping the kept value in the retried payload', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={layoutSanitizationCatalog} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'greenhouse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.extra' }), {
      target: { value: 'kept detail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /greenhouse/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'open_field' },
    });
    fireEvent.click(screen.getByRole('button', { name: /keep.*attr\.extra/i }));

    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    const savedDraftCalls = apiMocks.updateEntry.mock.calls.length;
    apiMocks.updateEntry.mockRejectedValueOnce(new Error('gateway unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('capture.save.lossWarning'));

    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(savedDraftCalls + 2));
    const retryCall = apiMocks.updateEntry.mock.calls[savedDraftCalls + 1];
    expect(retryCall[1]).toEqual(expect.objectContaining({
      values: expect.arrayContaining([
        expect.objectContaining({ attribute_code: 'attr.extra', value: 'kept detail' }),
      ]),
    }));
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
  });

  it('reopens the layout-transition review sheet from its pending banner after the farmer dismisses it', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={layoutSanitizationCatalog} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'greenhouse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'attr.extra' }), {
      target: { value: 'temporary detail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'capture.confirm.title' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /greenhouse/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'capture.where.layout' }), {
      target: { value: 'open_field' },
    });
    expect(screen.getByRole('dialog')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /^capture\.transition\.close/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('capture.transition.pendingBanner');

    fireEvent.click(screen.getByRole('button', { name: /^capture\.transition\.reviewAction/ }));
    expect(screen.getByRole('dialog')).toBeVisible();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('drops an ordinary numeric value when the next activity leaves its dependency target empty', async () => {
    render(<JournalCaptureFlow {...baseProps} catalog={activityTransitionCatalog} initialPlot={plot} />);
    await waitFor(() => expect(apiMocks.listEntries).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Applied amount' }), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'fertilization' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect((screen.getByRole('textbox', { name: 'Applied amount' }) as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'capture.confirm.title' })).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });

  it('revalidates a retained out-of-range value across a plot layout transition', async () => {
    const initialCatalog = validationTransitionCatalog({ secondLayout: true, amountMax: 2000 });
    const tightenedCatalog = validationTransitionCatalog({ secondLayout: true, amountMax: 1000 });
    const props = { ...baseProps, plots: [plot, secondPlot], initialPlot: plot };
    const settleJournalEffects = deferJournalEffects();
    const { rerender } = render(<JournalCaptureFlow {...props} catalog={initialCatalog} />);
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Applied amount' }), {
      target: { value: '1500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    rerender(<JournalCaptureFlow {...props} catalog={tightenedCatalog} />);
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('textbox', { name: 'Applied amount' })).toHaveValue('1500');
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.maximum');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'capture.confirm.title' })).not.toBeInTheDocument();
  });

  it('revalidates a retained hidden value when an activity makes it visible', async () => {
    const initialCatalog = validationTransitionCatalog({ amountMax: 2000 });
    const tightenedCatalog = validationTransitionCatalog({ amountMax: 1000, reveal: 'activity' });
    const props = { ...baseProps, initialPlot: plot };
    const settleJournalEffects = deferJournalEffects();
    const { rerender } = render(<JournalCaptureFlow {...props} catalog={initialCatalog} />);
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Applied amount' }), {
      target: { value: '1500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capture.back' }));

    rerender(<JournalCaptureFlow {...props} catalog={tightenedCatalog} />);
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'fertilization' }));
    await settleJournalEffects();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    expect(screen.getByRole('textbox', { name: 'Applied amount' })).toHaveValue('1500');
    expect(screen.getByRole('alert')).toHaveTextContent('capture.validation.maximum');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    expect(screen.getByRole('heading', { name: 'capture.form.title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'capture.confirm.title' })).not.toBeInTheDocument();
  });

  it('renders one shared details form only after homogeneous multi-plot selection', async () => {
    render(<JournalCaptureFlow
      {...baseProps}
      plots={[plot, homogeneousSecondPlot]}
      plotGroups={[activeGroup]}
    />);

    const northButtons = screen.getAllByRole('button', { name: 'North field' });
    const eastButtons = screen.getAllByRole('button', { name: 'East field' });
    fireEvent.click(northButtons[northButtons.length - 1]);
    fireEvent.click(eastButtons[eastButtons.length - 1]);
    expect(screen.getByText(/where\.selectionCount:2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    expect(screen.getByText(/North field, East field/)).toBeInTheDocument();
    expect(apiMocks.createEntry).not.toHaveBeenCalled();
    expect(apiMocks.createFinalBatch).not.toHaveBeenCalled();
  });

  it('blocks mixed-layout selections before EntryForm renders', async () => {
    render(<JournalCaptureFlow {...baseProps} plots={[plot, mixedLayoutPlot]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('where.mixedLayout');
    expect(screen.queryByRole('heading', { name: 'capture.form.title' })).not.toBeInTheDocument();
  });

  it('confirms every target name and count', async () => {
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'capture.confirm.title',
    })).toBeInTheDocument());
    expect(screen.getByText(/batch\.confirmCount:2/)).toBeInTheDocument();
    expect(screen.getByText(/North field, East field/)).toBeInTheDocument();
  });

  it('posts one atomic final batch with sorted members and no batch_uuid', async () => {
    const onSaved = vi.fn();
    render(<JournalCaptureFlow
      {...baseProps}
      plots={[plot, homogeneousSecondPlot]}
      onSaved={onSaved}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledOnce());
    const payload = apiMocks.createFinalBatch.mock.calls[0][0] as CreateFinalBatchPayload;
    expect(payload.members.map(({ plot_uuid }) => plot_uuid)).toEqual(
      [...payload.members.map(({ plot_uuid }) => plot_uuid)].sort(),
    );
    expect(payload.members).toHaveLength(2);
    expect(payload.members.every(({ entry_uuid }) => typeof entry_uuid === 'string')).toBe(true);
    expect(payload).not.toHaveProperty('batch_uuid');
    expect(payload).not.toHaveProperty('entry_uuid');
    expect(payload).not.toHaveProperty('plot_uuid');
    expect(payload).not.toHaveProperty('zone_uuid');
    expect(payload).not.toHaveProperty('duplicate_guard_ack_entry_uuid');
    expect(apiMocks.createEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'capture.close' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      batch_uuid: '99999999-9999-4999-8999-999999999999',
    })));
  });

  it('reuses the same member entry UUIDs when a failed batch is re-finalized', async () => {
    const generatedUuids = [
      '22222222-2222-4222-8222-000000000201',
      '22222222-2222-4222-8222-000000000202',
      '22222222-2222-4222-8222-000000000203',
    ] as const;
    let generatedUuidIndex = 0;
    vi.mocked(crypto.randomUUID).mockImplementation(() =>
      generatedUuids[generatedUuidIndex++] ?? '22222222-2222-4222-8222-000000000204');
    apiMocks.createFinalBatch
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce({ batch_uuid: '99999999-9999-4999-8999-999999999999', entries: [] });
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.save.retry' })).toBeInTheDocument());
    const firstPayload = apiMocks.createFinalBatch.mock.calls[0][0];
    expect(firstPayload.members).toEqual([
      expect.objectContaining({ plot_uuid: plot.plot_uuid, entry_uuid: expect.any(String) }),
      expect.objectContaining({ plot_uuid: homogeneousSecondPlot.plot_uuid, entry_uuid: expect.any(String) }),
    ]);
    expect(new Set(firstPayload.members.map(({ entry_uuid }: { entry_uuid: string }) => entry_uuid)).size).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(2));
    expect(apiMocks.createFinalBatch.mock.calls[1][0].members).toEqual(firstPayload.members);
  });

  it('uses the returned batch receipt', async () => {
    const onSaved = vi.fn();
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.close' }));
    await waitFor(() => expect(onSaved.mock.calls[0][0].entries).toHaveLength(2));
  });

  it('does not POST when final batch building returns the exact domain rejection', async () => {
    buildFinalBatchPayloadMock.mockImplementationOnce(() => ({
      ok: false,
      error: {
        error: 'invalid_batch',
        message: 'Batch plots were rejected by the finalization builder',
        details: null,
      },
    }));
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Batch plots were rejected by the finalization builder',
    ));
    expect(apiMocks.createFinalBatch).not.toHaveBeenCalled();
  });

  it('shows plural duplicate candidates and retries with duplicate_guard_ack_entry_uuids', async () => {
    const candidates = [
      { entryUuid: duplicateUuid(11), occurredStart: timestamp, activityCode: 'irrigation', plotUuid: plot.plot_uuid },
      { entryUuid: duplicateUuid(12), occurredStart: timestamp, activityCode: 'irrigation', plotUuid: plot.plot_uuid },
      { entryUuid: duplicateUuid(13), occurredStart: timestamp, activityCode: 'irrigation', plotUuid: homogeneousSecondPlot.plot_uuid },
    ];
    apiMocks.createFinalBatch
      .mockRejectedValueOnce({ response: { data: { error: 'duplicate_candidates', details: { duplicateCandidates: candidates } } } })
      .mockResolvedValueOnce({ batch_uuid: '99999999-9999-4999-8999-999999999999', entries: [] });
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(duplicateUuid(11)));
    expect(screen.getByRole('alert')).toHaveTextContent(duplicateUuid(12));
    expect(screen.getByRole('alert')).toHaveTextContent(duplicateUuid(13));
    expect(screen.getByRole('heading', { name: 'North field' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'East field' })).toBeInTheDocument();
    const firstPayload = JSON.parse(JSON.stringify(apiMocks.createFinalBatch.mock.calls[0][0]));
    expect(screen.getByRole('button', { name: 'capture.close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'capture.back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /capture\.confirm\.occurrence/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /duplicateAcknowledge/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /duplicateAcknowledge/ }));
    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(2));
    expect(apiMocks.createFinalBatch.mock.calls[1][0]).toEqual({
      ...firstPayload,
      duplicate_guard_ack_entry_uuids: [duplicateUuid(11), duplicateUuid(12), duplicateUuid(13)],
    });
  });

  it('rejects a 101-plot selection before rendering the form', async () => {
    const plots = Array.from({ length: 101 }, (_, index) => ({
      ...plot,
      plot_uuid: duplicateUuid(index + 20),
      plot_code: `P-${index + 1}`,
      name: `Plot ${index + 1}`,
    }));
    render(<JournalCaptureFlow
      {...baseProps}
      plots={plots}
      plotGroups={[{
        ...activeGroup,
        group_uuid: duplicateUuid(2),
        label: 'Large group',
        members: plots.map((candidate) => candidate.plot_uuid),
      }]}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Large group' }));
    expect(screen.getByRole('alert')).toHaveTextContent('batch_too_large');
    expect(screen.queryByRole('heading', { name: 'capture.form.title' })).not.toBeInTheDocument();
  }, 15000);

  it('does not call createEntry once per selected plot', async () => {
    render(<JournalCaptureFlow {...baseProps} plots={[plot, homogeneousSecondPlot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'North field' }));
    fireEvent.click(screen.getByRole('button', { name: 'East field' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'irrigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledOnce());
    expect(apiMocks.createEntry).not.toHaveBeenCalled();
  });

  it('does not offer harvest group resolution after a successful single-entry final save', async () => {
    const updatePlotGroup = vi.fn();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={harvestCatalog}
      initialPlot={plot}
      plotGroups={[singlePlotHarvestGroup]}
      groupState={{ ...baseProps.groupState, updatePlotGroup }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'harvest' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeVisible());
    expect(apiMocks.createFinalBatch).not.toHaveBeenCalled();
    expect(updatePlotGroup).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /harvest group resolution/i })).not.toBeInTheDocument();
  });

  it('does not offer harvest group resolution after a successful single-entry retry', async () => {
    apiMocks.updateEntry.mockRejectedValueOnce(new Error('gateway unavailable'));
    const updatePlotGroup = vi.fn();
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={harvestCatalog}
      initialPlot={plot}
      plotGroups={[singlePlotHarvestGroup]}
      groupState={{ ...baseProps.groupState, updatePlotGroup }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'harvest' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.save.retry' })).toBeVisible());

    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('capture.save.finalSavedGateway')).toBeVisible());
    expect(apiMocks.createFinalBatch).not.toHaveBeenCalled();
    expect(updatePlotGroup).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /harvest group resolution/i })).not.toBeInTheDocument();
  });

  it('offers harvest group resolution after a failed batch succeeds through generic retry', async () => {
    apiMocks.createFinalBatch
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce({
        batch_uuid: duplicateUuid(120),
        entries: [],
      });
    render(<JournalCaptureFlow
      {...baseProps}
      catalog={harvestCatalog}
      plots={[plot, homogeneousSecondPlot]}
      plotGroups={[activeGroup]}
    />);

    await finishHarvestBatch();
    await waitFor(() => expect(screen.getByRole('button', { name: 'capture.save.retry' })).toBeVisible());
    expect(screen.queryByRole('region', { name: /harvest group resolution/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'capture.save.retry' }));
    await waitFor(() => expect(apiMocks.createFinalBatch).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /resolve.*north pair/i })).toBeVisible();
  });

  it('offers harvest group resolution only after a successful batch and sends the exact resolved payload', async () => {
    const updatePlotGroup = vi.fn().mockResolvedValue(resolvedActiveGroup);
    const onRevalidated = vi.fn();
    const onSaved = vi.fn();
    render(<RevalidatingHarvestCapture
      updatePlotGroup={updatePlotGroup}
      onRevalidated={onRevalidated}
      onSaved={onSaved}
    />);

    await finishHarvestBatch();

    await waitFor(() => expect(screen.getByRole('button', { name: /resolve.*north pair/i })).toBeVisible());
    expect(screen.getAllByRole('button', { name: /resolve.*pair/i })).toHaveLength(2);
    expect(updatePlotGroup).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /resolve.*north pair/i }));
    await waitFor(() => expect(updatePlotGroup).toHaveBeenCalledWith(
      activeGroup.group_uuid,
      {
        group_uuid: activeGroup.group_uuid,
        base_sync_version: activeGroup.sync_version,
        label: activeGroup.label,
        members: [...activeGroup.members].sort(),
        resolved: true,
      },
    ));
    await waitFor(() => expect(onRevalidated).toHaveBeenCalledWith(resolvedActiveGroup));
    expect(screen.getByRole('region', { name: /harvest group resolution/i })).toBeVisible();
    expect(screen.getByText(/group\.resolved:Resolved/)).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('keeps harvest group resolution failures visible and retryable after a successful batch', async () => {
    let resolveRetry: ((group: PlotGroup) => void) | undefined;
    const updatePlotGroup = vi.fn()
      .mockRejectedValueOnce(new Error('gateway unavailable for owner@example.test'))
      .mockReturnValueOnce(new Promise<PlotGroup>((resolve) => { resolveRetry = resolve; }));
    const onRevalidated = vi.fn();
    render(<RevalidatingHarvestCapture
      updatePlotGroup={updatePlotGroup}
      onRevalidated={onRevalidated}
    />);

    await finishHarvestBatch();

    const resolveButton = await screen.findByRole('button', { name: /resolve.*north pair/i });
    fireEvent.click(resolveButton);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'group.resolveError:Could not resolve this group.',
    ));
    expect(screen.getByRole('alert')).not.toHaveTextContent('gateway unavailable');
    expect(screen.getByRole('alert')).not.toHaveTextContent('owner@example.test');
    expect(screen.getByRole('button', { name: /resolve.*north pair/i })).toBeVisible();
    expect(onRevalidated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /resolve.*north pair/i }));
    await waitFor(() => expect(updatePlotGroup).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('status').some((status) =>
      status.textContent === 'group.resolving:Resolving…')).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => {
      resolveRetry?.(resolvedActiveGroup);
      await Promise.resolve();
    });
    await waitFor(() => expect(onRevalidated).toHaveBeenCalledWith(resolvedActiveGroup));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /harvest group resolution/i })).toBeVisible();
    expect(screen.getByText(/group\.resolved:Resolved/)).toBeVisible();
  });

  it('reconciles a receipt group to the latest label, members, and sync version before PUT', async () => {
    const latestGroup: PlotGroup = {
      ...activeGroup,
      label: 'North pair revised',
      members: [...activeGroup.members].reverse(),
      sync_version: 9,
    };
    const updatePlotGroup = vi.fn().mockResolvedValue({
      ...latestGroup,
      resolved_at: '2026-07-18T09:00:00.000Z',
    });
    const props = {
      ...baseProps,
      catalog: harvestCatalog,
      plots: [plot, homogeneousSecondPlot],
      groupState: { ...baseProps.groupState, updatePlotGroup },
    };
    const { rerender } = render(<JournalCaptureFlow {...props} plotGroups={[activeGroup]} />);
    await finishHarvestBatch();
    const resolveButton = await screen.findByRole('button', { name: /resolve.*north pair/i });

    rerender(<JournalCaptureFlow {...props} plotGroups={[latestGroup]} />);
    fireEvent.click(resolveButton);

    await waitFor(() => expect(updatePlotGroup).toHaveBeenCalledWith(activeGroup.group_uuid, {
      group_uuid: activeGroup.group_uuid,
      base_sync_version: 9,
      label: 'North pair revised',
      members: [...latestGroup.members].sort(),
      resolved: true,
    }));
  });

  it('treats a receipt group already resolved in latest props as success without another PUT', async () => {
    const updatePlotGroup = vi.fn();
    const props = {
      ...baseProps,
      catalog: harvestCatalog,
      plots: [plot, homogeneousSecondPlot],
      groupState: { ...baseProps.groupState, updatePlotGroup },
    };
    const { rerender } = render(<JournalCaptureFlow {...props} plotGroups={[activeGroup]} />);
    await finishHarvestBatch();
    const resolveButton = await screen.findByRole('button', { name: /resolve.*north pair/i });

    rerender(<JournalCaptureFlow {...props} plotGroups={[resolvedActiveGroup]} />);
    fireEvent.click(resolveButton);

    await waitFor(() => expect(screen.getByText(/group\.resolved:Resolved/)).toBeVisible());
    expect(updatePlotGroup).not.toHaveBeenCalled();
  });

  it('refuses changed receipt membership without PUT and remains retryable after valid props arrive', async () => {
    const changedGroup: PlotGroup = {
      ...activeGroup,
      members: [plot.plot_uuid],
      sync_version: 8,
    };
    const latestValidGroup: PlotGroup = {
      ...activeGroup,
      label: 'North pair current',
      sync_version: 9,
    };
    const updatePlotGroup = vi.fn().mockResolvedValue(latestValidGroup);
    const props = {
      ...baseProps,
      catalog: harvestCatalog,
      plots: [plot, homogeneousSecondPlot],
      groupState: { ...baseProps.groupState, updatePlotGroup },
    };
    const { rerender } = render(<JournalCaptureFlow {...props} plotGroups={[activeGroup]} />);
    await finishHarvestBatch();
    const resolveButton = await screen.findByRole('button', { name: /resolve.*north pair/i });

    rerender(<JournalCaptureFlow {...props} plotGroups={[changedGroup]} />);
    fireEvent.click(resolveButton);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'group.changedError:This group changed. Refresh and try again.',
    ));
    expect(updatePlotGroup).not.toHaveBeenCalled();

    rerender(<JournalCaptureFlow {...props} plotGroups={[latestValidGroup]} />);
    fireEvent.click(screen.getByRole('button', { name: /resolve.*north pair/i }));
    await waitFor(() => expect(updatePlotGroup).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('Slice BC: activity-scoped Quick + plot-static context (R1)', () => {
    it('renders only the activity Quick fields plus read-only plot context, never block/bed/row as an input, and snapshots the context onto the saved entry', async () => {
      const props = {
        ...baseProps,
        catalog: plotContextCatalog,
        plots: [plotWithContext],
      };
      render(<JournalCaptureFlow {...props} initialPlot={plotWithContext} />);

      fireEvent.click(screen.getByRole('button', { name: 'fertilization' }));
      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));

      // The activity's own quick_fields render as inputs...
      const productInput = screen.getByRole('textbox', { name: 'Product' });
      expect(screen.getByRole('textbox', { name: 'Amount' })).toBeInTheDocument();
      // ...but the plot-static context field never renders as an input.
      expect(screen.queryByLabelText(/Block \/ bed \/ row/i)).toBeNull();
      expect(screen.queryByRole('textbox', { name: /block/i })).toBeNull();
      // It does render, read-only, with its plot-context value.
      expect(screen.getByText(/capture\.form\.plotContext/)).toBeInTheDocument();
      expect(screen.getByText('B-7')).toBeInTheDocument();

      fireEvent.change(productInput, { target: { value: 'Compost' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '12' } });

      fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'capture.finish' })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));

      await waitFor(() => expect(apiMocks.updateEntry).toHaveBeenCalled());
      const payload = apiMocks.updateEntry.mock.calls[0][1];
      expect(payload.values).toEqual(expect.arrayContaining([
        expect.objectContaining({ attribute_code: 'attr.product', value: 'Compost' }),
        expect.objectContaining({ attribute_code: 'attr.block_bed_row', value: 'B-7' }),
      ]));
    });

    it('leaves full_record resolution unaffected: block/bed/row still renders as a required field there', async () => {
      // Slice BC's regression guard, checked directly against the resolution
      // engine (deriveFieldStates) rather than round-tripping the capture
      // UI's in-flow detail-level switcher, which this minimal fixture does
      // not exercise: full_record has no quick_fields, so it must keep
      // force-requiring the layout's plot-static field exactly as before.
      const { buildCatalogModel } = await import('../../../../journal/catalogModel');
      const { deriveFieldStates } = await import('../../../../journal/templateEngine');
      const result = buildCatalogModel(plotContextCatalog);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const fullRecord = result.model.templates.get('full_record');
      const layout = result.model.layouts.get('open_field');
      expect(fullRecord).toBeDefined();
      expect(layout).toBeDefined();
      if (!fullRecord || !layout) return;
      const states = deriveFieldStates(fullRecord, layout, { activity_code: 'fertilization' });
      expect(states.find((state) => state.code === 'attr.block_bed_row')).toMatchObject({
        visible: true,
        required: true,
      });
    });
  });
});
