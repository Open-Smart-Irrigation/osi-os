#!/usr/bin/env node
'use strict';

// Hand-authored catalog facts. Keep this module data-only: the generator is
// responsible for normalization, Agroscope expansion, hashing, and SQL.

const ADAPT_SCHEME_URI = 'https://github.com/ADAPT/Standard';
const ADAPT_SOURCE_URI =
  'https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json';

function adaptOperation(external_id, mapping_relation = 'exact') {
  return {
    scheme_uri: ADAPT_SCHEME_URI,
    scheme_version: '1.0.0',
    mapping_role: 'operation_type',
    external_id,
    external_parent_id: null,
    mapping_relation,
    source_uri: ADAPT_SOURCE_URI,
    active: 1,
  };
}

const activities = [
  {
    code: 'irrigation',
    label: 'Irrigation',
    icon_key: 'droplets',
    agroscope_categories: ['irrigation'],
    mappings: [adaptOperation('APPLICATION_IRRIGATION')],
  },
  {
    code: 'fertilization',
    label: 'Fertilization',
    icon_key: 'fertilizer',
    agroscope_categories: ['fertilizer_application'],
    mappings: [adaptOperation('APPLICATION_FERTILIZING')],
  },
  { code: 'fertigation', label: 'Fertigation', icon_key: 'fertigation' },
  {
    code: 'plant_protection_application',
    label: 'Plant protection',
    icon_key: 'plant_protection',
    agroscope_categories: ['crop_protection'],
    mappings: [adaptOperation('APPLICATION_CROP_PROTECTION')],
  },
  {
    code: 'weed_control_nonchemical',
    label: 'Non-chemical weed control',
    icon_key: 'weed_control',
  },
  {
    code: 'seeding',
    label: 'Seeding',
    icon_key: 'seeding',
    agroscope_categories: ['sowing'],
    mappings: [adaptOperation('APPLICATION_SOWING_AND_PLANTING', 'close')],
  },
  {
    code: 'planting_transplanting',
    label: 'Planting / transplanting',
    icon_key: 'planting',
    mappings: [adaptOperation('APPLICATION_SOWING_AND_PLANTING', 'close')],
  },
  { code: 'pruning', label: 'Pruning', icon_key: 'pruning' },
  { code: 'crop_care', label: 'Crop care', icon_key: 'crop_care' },
  {
    code: 'tillage_soil_work',
    label: 'Tillage / soil work',
    icon_key: 'tillage',
    agroscope_categories: ['tillage'],
    mappings: [adaptOperation('FIELD_PREPARATION_TILLAGE')],
  },
  { code: 'mowing', label: 'Mowing', icon_key: 'mowing' },
  {
    code: 'harvest',
    label: 'Harvest',
    icon_key: 'harvest',
    agroscope_categories: ['harvest'],
    mappings: [adaptOperation('HARVEST')],
  },
  { code: 'sampling', label: 'Sampling', icon_key: 'sampling' },
  {
    code: 'general_observation',
    label: 'General observation',
    icon_key: 'observation',
    agroscope_categories: ['other'],
  },
  {
    code: 'pest_disease_observation',
    label: 'Pest / disease observation',
    icon_key: 'pest_disease',
  },
  {
    code: 'equipment_maintenance',
    label: 'Equipment maintenance',
    icon_key: 'maintenance',
  },
].map((activity, index) => ({
  ...activity,
  sort_order: (index + 1) * 10,
}));

function numberAttribute(code, label, quantity_kind, basis, default_unit_code, constraints = {}) {
  return {
    code,
    label,
    value_type: 'number',
    quantity_kind,
    basis,
    default_unit_code,
    constraints,
  };
}

function scalarAttribute(code, label, value_type, constraints = {}) {
  return { code, label, value_type, constraints };
}

const attributes = [
  // Semantic amount families used by the Agroscope device cascade. They stay
  // separate even when one source device accepts more than one family.
  numberAttribute('attr.amount_operation_depth', 'Operation depth', 'operation_depth', 'operation_depth', 'unit.cm_operation_depth', { min: 0, max: 200 }),
  numberAttribute('attr.amount_mass_area_product', 'Product mass per area', 'mass_area', 'product', 'unit.kg_per_ha_product', { min: 0 }),
  numberAttribute('attr.amount_volume_area_product', 'Product volume per area', 'volume_area', 'product', 'unit.l_per_ha_product', { min: 0 }),
  numberAttribute('attr.amount_nutrient_rate', 'Nutrient rate', 'nutrient_rate', 'nutrient', null, {
    min: 0,
    repeatable: true,
    requires_explicit_unit: true,
    semantic_discriminator: 'unit_code',
    allow_default_unit: false,
  }),
  numberAttribute('attr.amount_count_area', 'Plant count per area', 'count_area', 'plant', 'unit.plants_per_ha', { min: 0 }),
  numberAttribute('attr.amount_biological_count_area', 'Biological-agent count per area', 'biological_count_area', 'biological_agent', 'unit.biological_count_per_ha', { min: 0 }),
  numberAttribute('attr.amount_duration_area', 'Labour duration per area', 'duration_area', 'labor', 'unit.h_per_ha_labor', { min: 0 }),
  numberAttribute('attr.irrigation_volume_area', 'Irrigation volume per area', 'volume_area', 'water', 'unit.m3_per_ha_water', { min: 0 }),

  // Generic activity and layout measurements.
  numberAttribute('attr.irrigation_depth', 'Irrigation depth', 'water_depth', 'water', 'unit.mm_water', { min: 0 }),
  numberAttribute('attr.duration_minutes', 'Duration', 'duration', 'elapsed_time', 'unit.min_duration', { min: 0 }),
  numberAttribute('attr.per_plant_volume', 'Volume per plant', 'volume_per_plant', 'water', 'unit.l_per_plant_water', { min: 0 }),
  numberAttribute('attr.treated_area', 'Treated area', 'area', 'land_area', 'unit.m2_area', { min: 0 }),
  numberAttribute('attr.harvest_area', 'Harvest area', 'area', 'land_area', 'unit.m2_area', { min: 0 }),
  numberAttribute('attr.harvest_yield_area', 'Harvest yield per area', 'yield_area', 'fresh_product', 'unit.kg_per_ha_fresh_product', { min: 0 }),
  numberAttribute('attr.surface_area', 'Surface area', 'area', 'land_area', 'unit.m2_area', { min: 0 }),
  numberAttribute('attr.plant_area', 'Plant area', 'area', 'land_area', 'unit.m2_area', { min: 0 }),
  numberAttribute('attr.wetted_area', 'Wetted area', 'area', 'land_area', 'unit.m2_area', { min: 0 }),
  numberAttribute('attr.water_input', 'Water input', 'volume', 'water', 'unit.l_water', { min: 0 }),
  numberAttribute('attr.rain_input', 'Rain input', 'water_depth', 'water', 'unit.mm_water', { min: 0 }),
  numberAttribute('attr.drainage_volume', 'Drainage volume', 'volume', 'water', 'unit.l_water', { min: 0 }),
  numberAttribute('attr.mass_start', 'Start mass', 'mass', 'lysimeter', 'unit.kg_mass', { min: 0 }),
  numberAttribute('attr.mass_end', 'End mass', 'mass', 'lysimeter', 'unit.kg_mass', { min: 0 }),
  numberAttribute('attr.tare_mass', 'Tare mass', 'mass', 'lysimeter', 'unit.kg_mass', { min: 0 }),
  numberAttribute('attr.interval_minutes', 'Measurement interval', 'duration', 'elapsed_time', 'unit.min_duration', { min: 0 }),
  numberAttribute('attr.ec', 'Electrical conductivity', 'electrical_conductivity', 'solution', 'unit.ds_per_m', { min: 0 }),
  numberAttribute('attr.ph', 'pH', 'acidity', 'solution', 'unit.ph', { min: 0, max: 14 }),
  numberAttribute('attr.waiting_period_days', 'Waiting period', 'calendar_duration', 'calendar_day', 'unit.day_duration', { min: 0 }),

  // Agroscope row-level measurements. DMC mass/mass and mass/volume remain
  // distinct; product and nutrient rates are never treated as interchangeable.
  numberAttribute('attr.agroscope.combination_group', 'Combination group', 'count', 'operation_group', 'unit.count_integer', { min: 1, step: 1 }),
  numberAttribute('attr.agroscope.dmc_mass_fraction', 'Dry matter per fresh mass', 'mass_fraction', 'product_wet_mass', 'unit.kg_per_t_dry_matter', { min: 0 }),
  numberAttribute('attr.agroscope.dmc_mass_volume', 'Dry matter per product volume', 'mass_concentration', 'product_volume', 'unit.kg_per_m3_dry_matter', { min: 0 }),
  numberAttribute('attr.agroscope.c_content', 'Carbon content', 'mass_fraction', 'dry_matter_carbon', 'unit.g_c_per_kg_dm', { min: 0 }),
  numberAttribute('attr.agroscope.n_content', 'Nitrogen content', 'mass_fraction', 'dry_matter_nitrogen', 'unit.g_n_per_kg_dm', { min: 0 }),
  numberAttribute('attr.agroscope.crop_product', 'Exported crop product', 'yield_area', 'dry_matter_yield', 'unit.t_per_ha_dm', { min: 0 }),
  numberAttribute('attr.agroscope.crop_residue', 'Crop residue', 'yield_area', 'dry_matter_yield', 'unit.t_per_ha_dm', { min: 0 }),
  numberAttribute('attr.agroscope.cc_product', 'Product carbon concentration', 'mass_fraction', 'dry_matter_carbon', 'unit.g_c_per_kg_dm', { min: 0 }),
  numberAttribute('attr.agroscope.cc_residue', 'Residue carbon concentration', 'mass_fraction', 'dry_matter_carbon', 'unit.g_c_per_kg_dm', { min: 0 }),

  scalarAttribute('attr.agroscope.operation', 'Operation', 'choice'),
  scalarAttribute('attr.agroscope.device', 'Device / method', 'choice'),
  scalarAttribute('attr.crop', 'Crop', 'choice'),
  scalarAttribute('attr.machine', 'Machine', 'text', { maxlength: 500 }),
  scalarAttribute('attr.product_uuid', 'Registered product', 'text', {
    maxlength: 128,
    reference: { table: 'journal_products', column: 'product_uuid' },
  }),
  scalarAttribute('attr.product', 'Unregistered product', 'text', {
    maxlength: 500,
    unregistered_compatibility: true,
  }),
  scalarAttribute('attr.actuation_expectation_id', 'Actuation expectation', 'text', {
    maxlength: 128,
    reference: { table: 'valve_actuation_expectations', column: 'expectation_id' },
  }),
  scalarAttribute('attr.block_bed_row', 'Block / bed / row', 'text', { maxlength: 160 }),
  scalarAttribute('attr.cover_type', 'Cover type', 'choice'),
  scalarAttribute('attr.denominator', 'Application denominator', 'choice'),
  scalarAttribute('attr.structure_compartment', 'Structure / compartment', 'text', { maxlength: 160 }),
  scalarAttribute('attr.root_zone_system', 'Root-zone system', 'choice'),
  scalarAttribute('attr.recirculation', 'Recirculation', 'boolean'),
  scalarAttribute('attr.experimental_unit', 'Experimental unit', 'text', { maxlength: 160 }),
  scalarAttribute('attr.replicate', 'Replicate', 'text', { maxlength: 80 }),
  scalarAttribute('attr.treatment', 'Treatment', 'text', { maxlength: 160 }),
  scalarAttribute('attr.mass_method', 'Mass method', 'choice'),
  scalarAttribute('attr.irrigation_amount_kind', 'Irrigation amount kind', 'choice'),
  scalarAttribute('attr.measurement_source', 'Measurement source', 'choice'),
  scalarAttribute('attr.operator', 'Operator', 'text', { maxlength: 160 }),
  scalarAttribute('attr.equipment', 'Equipment', 'text', { maxlength: 300 }),
  scalarAttribute('attr.method', 'Method', 'text', { maxlength: 300 }),
  scalarAttribute('attr.target', 'Target', 'text', { maxlength: 300 }),
  scalarAttribute('attr.observation_text', 'Observation', 'text', { maxlength: 4000 }),

  // Slice D (crop-cycle lifecycle, catalog v4): free-text variety, scoped to
  // the entry's crop via a client-side autocomplete hint (distinct variety
  // suggestions are drawn from journal_crop_cycles.variety for that crop_code
  // on this gateway; nothing about that lookup lives in the catalog itself).
  // Appended at the very end of this array — not sorted next to attr.crop
  // above — so its arrival does not shift attributeSort for any since=1
  // attribute already baked byte-for-byte into the frozen 0019/0022/0023
  // migrations (attributeSort is a running counter over array order in
  // generate-journal-catalog.js's buildRows, independent of since_version).
  { ...scalarAttribute('attr.variety', 'Variety', 'text', { maxlength: 120, autocomplete: 'variety_by_crop' }), since_version: 4 },

  // Slice F (agronomy adds, catalog v6). F1: structured BBCH growth stage —
  // a NUMBER (0-99), not a choice: BBCH's two-digit principal+secondary
  // structure (e.g. flowering sub-stages 60-69) carries agronomically
  // meaningful granularity a principal-only choice list would lose. Any
  // labelled principal-stage quick-pick is a UI convenience that writes this
  // number, not a parallel choice-typed field (spec R8/F-AG-1).
  {
    ...numberAttribute('attr.growth_stage_bbch', 'Growth stage (BBCH)', 'growth_stage', 'phenology', 'unit.bbch_stage', { min: 0, max: 99, step: 1 }),
    since_version: 6,
  },
  // F2: manual weather-at-application fallback for plant protection on a
  // sensor-less plot (parent spec §4.8 auto-captures wind/temp/humidity into
  // context_json only when the plot links a zone; these are the structured
  // manual equivalent when it doesn't). Wind direction is a compass choice;
  // the other three are numbers with a single-member (dimensionless-free)
  // canonical unit each.
  {
    ...numberAttribute('attr.wind_speed', 'Wind speed', 'wind_speed', 'ambient', 'unit.m_per_s', { min: 0 }),
    since_version: 6,
  },
  { ...scalarAttribute('attr.wind_direction', 'Wind direction', 'choice'), since_version: 6 },
  {
    ...numberAttribute('attr.air_temperature', 'Air temperature', 'temperature', 'ambient', 'unit.deg_c', { min: -50, max: 60 }),
    since_version: 6,
  },
  {
    ...numberAttribute('attr.rel_humidity', 'Relative humidity', 'relative_humidity', 'ambient', 'unit.percent', { min: 0, max: 100 }),
    since_version: 6,
  },
];

function unit(code, label, quantity_kind, basis, dimension, canonical_unit_code, scale = 1, offset = 0, extra = {}) {
  return {
    code,
    label,
    quantity_kind,
    basis,
    dimension,
    to_canonical: { unit_code: canonical_unit_code, scale, offset },
    ...extra,
  };
}

function sourceBinding(label, target_attribute_code, categories) {
  return { label, target_attribute_code, categories };
}

const units = [
  unit('unit.cm_operation_depth', 'cm', 'operation_depth', 'operation_depth', 'length_operation_depth', 'unit.cm_operation_depth', 1, 0, {
    source_bindings: [sourceBinding('cm', 'attr.amount_operation_depth', ['tillage', 'sowing', 'crop_protection'])],
  }),
  unit('unit.g_per_ha_product', 'g/ha', 'mass_area', 'product', 'mass_product_per_area', 'unit.kg_per_ha_product', 0.001, 0, {
    source_bindings: [sourceBinding('g/ha', 'attr.amount_mass_area_product', ['fertilizer_application', 'crop_protection'])],
  }),
  unit('unit.kg_per_ha_product', 'kg/ha', 'mass_area', 'product', 'mass_product_per_area', 'unit.kg_per_ha_product', 1, 0, {
    source_bindings: [sourceBinding('kg/ha', 'attr.amount_mass_area_product', ['sowing'])],
  }),
  unit('unit.t_per_ha_product', 't/ha', 'mass_area', 'product', 'mass_product_per_area', 'unit.kg_per_ha_product', 1000, 0, {
    source_bindings: [sourceBinding('t/ha', 'attr.amount_mass_area_product', ['fertilizer_application'])],
  }),
  unit('unit.l_per_ha_product', 'L/ha', 'volume_area', 'product', 'volume_product_per_area', 'unit.l_per_ha_product', 1, 0, {
    source_bindings: [sourceBinding('l/ha', 'attr.amount_volume_area_product', ['fertilizer_application', 'crop_protection'])],
  }),
  unit('unit.m3_per_ha_product', 'm³/ha', 'volume_area', 'product', 'volume_product_per_area', 'unit.l_per_ha_product', 1000, 0, {
    source_bindings: [sourceBinding('m3/ha', 'attr.amount_volume_area_product', ['fertilizer_application'])],
  }),
  unit('unit.kg_per_ha_fresh_product', 'kg/ha', 'yield_area', 'fresh_product', 'fresh_product_yield_per_area', 'unit.kg_per_ha_fresh_product'),
  unit('unit.t_per_ha_fresh_product', 't/ha', 'yield_area', 'fresh_product', 'fresh_product_yield_per_area', 'unit.kg_per_ha_fresh_product', 1000),
  unit('unit.m3_per_ha_water', 'm³/ha', 'volume_area', 'water', 'water_volume_per_area', 'unit.m3_per_ha_water', 1, 0, {
    source_bindings: [sourceBinding('m3/ha', 'attr.irrigation_volume_area', ['irrigation'])],
  }),
  unit('unit.plants_per_ha', 'plants/ha', 'count_area', 'plant', 'plant_count_per_area', 'unit.plants_per_ha', 1, 0, {
    source_bindings: [sourceBinding('plants/ha', 'attr.amount_count_area', ['sowing'])],
  }),
  unit('unit.biological_count_per_ha', 'unit/ha', 'biological_count_area', 'biological_agent', 'biological_agent_count_per_area', 'unit.biological_count_per_ha', 1, 0, {
    source_bindings: [sourceBinding('unit/ha', 'attr.amount_biological_count_area', ['crop_protection'])],
  }),
  unit('unit.h_per_ha_labor', 'hours/ha', 'duration_area', 'labor', 'labor_time_per_area', 'unit.h_per_ha_labor', 1, 0, {
    source_bindings: [sourceBinding('hours/ha', 'attr.amount_duration_area', ['crop_protection'])],
  }),

  unit('unit.kg_n_per_ha_nutrient', 'kg N/ha', 'nutrient_rate', 'nutrient', 'mass_n_per_area', 'unit.kg_n_per_ha_nutrient', 1, 0, {
    nutrient: 'N', source_bindings: [sourceBinding('kg N/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_p2o5_per_ha_nutrient', 'kg P₂O₅/ha', 'nutrient_rate', 'nutrient', 'mass_p2o5_per_area', 'unit.kg_p2o5_per_ha_nutrient', 1, 0, {
    nutrient: 'P2O5', source_bindings: [sourceBinding('kg P2O5/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_k2o_per_ha_nutrient', 'kg K₂O/ha', 'nutrient_rate', 'nutrient', 'mass_k2o_per_area', 'unit.kg_k2o_per_ha_nutrient', 1, 0, {
    nutrient: 'K2O', source_bindings: [sourceBinding('kg K2O/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_mg_per_ha_nutrient', 'kg Mg/ha', 'nutrient_rate', 'nutrient', 'mass_mg_per_area', 'unit.kg_mg_per_ha_nutrient', 1, 0, {
    nutrient: 'Mg', source_bindings: [sourceBinding('kg Mg/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_s_per_ha_nutrient', 'kg S/ha', 'nutrient_rate', 'nutrient', 'mass_s_per_area', 'unit.kg_s_per_ha_nutrient', 1, 0, {
    nutrient: 'S', source_bindings: [sourceBinding('kg S/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_ca_per_ha_nutrient', 'kg Ca/ha', 'nutrient_rate', 'nutrient', 'mass_ca_per_area', 'unit.kg_ca_per_ha_nutrient', 1, 0, {
    nutrient: 'Ca', source_bindings: [sourceBinding('kg Ca/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_b_per_ha_nutrient', 'kg B/ha', 'nutrient_rate', 'nutrient', 'mass_b_per_area', 'unit.kg_b_per_ha_nutrient', 1, 0, {
    nutrient: 'B', source_bindings: [sourceBinding('kg B/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_na_per_ha_nutrient', 'kg Na/ha', 'nutrient_rate', 'nutrient', 'mass_na_per_area', 'unit.kg_na_per_ha_nutrient', 1, 0, {
    nutrient: 'Na', source_bindings: [sourceBinding('kg Na/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_mn_per_ha_nutrient', 'kg Mn/ha', 'nutrient_rate', 'nutrient', 'mass_mn_per_area', 'unit.kg_mn_per_ha_nutrient', 1, 0, {
    nutrient: 'Mn', source_bindings: [sourceBinding('kg Mn/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),
  unit('unit.kg_cao_per_ha_nutrient', 'kg CaO/ha', 'nutrient_rate', 'nutrient', 'mass_cao_per_area', 'unit.kg_cao_per_ha_nutrient', 1, 0, {
    nutrient: 'CaO', source_bindings: [sourceBinding('kg CaO/ha', 'attr.amount_nutrient_rate', ['fertilizer_application'])],
  }),

  unit('unit.mm_water', 'mm', 'water_depth', 'water', 'water_depth', 'unit.mm_water'),
  unit('unit.min_duration', 'min', 'duration', 'elapsed_time', 'elapsed_time', 'unit.min_duration'),
  unit('unit.hour_duration', 'h', 'duration', 'elapsed_time', 'elapsed_time', 'unit.min_duration', 60),
  unit('unit.day_duration', 'days', 'calendar_duration', 'calendar_day', 'calendar_day', 'unit.day_duration'),
  unit('unit.l_per_plant_water', 'L/plant', 'volume_per_plant', 'water', 'water_volume_per_plant', 'unit.l_per_plant_water'),
  unit('unit.m2_area', 'm²', 'area', 'land_area', 'area', 'unit.m2_area'),
  unit('unit.ha_area', 'ha', 'area', 'land_area', 'area', 'unit.m2_area', 10000),
  unit('unit.l_water', 'L', 'volume', 'water', 'water_volume', 'unit.l_water'),
  unit('unit.kg_mass', 'kg', 'mass', 'lysimeter', 'mass', 'unit.kg_mass'),
  unit('unit.ds_per_m', 'dS/m', 'electrical_conductivity', 'solution', 'electrical_conductivity', 'unit.ds_per_m'),
  unit('unit.ph', 'pH', 'acidity', 'solution', 'acidity', 'unit.ph'),
  unit('unit.count_integer', 'count', 'count', 'operation_group', 'count', 'unit.count_integer'),
  unit('unit.kg_per_t_dry_matter', 'kg/t', 'mass_fraction', 'product_wet_mass', 'dry_matter_mass_per_fresh_mass', 'unit.kg_per_t_dry_matter'),
  unit('unit.kg_per_m3_dry_matter', 'kg/m³', 'mass_concentration', 'product_volume', 'dry_matter_mass_per_product_volume', 'unit.kg_per_m3_dry_matter'),
  unit('unit.g_c_per_kg_dm', 'g C/kg DM', 'mass_fraction', 'dry_matter_carbon', 'carbon_mass_per_dry_matter_mass', 'unit.g_c_per_kg_dm'),
  unit('unit.g_n_per_kg_dm', 'g N/kg DM', 'mass_fraction', 'dry_matter_nitrogen', 'nitrogen_mass_per_dry_matter_mass', 'unit.g_n_per_kg_dm'),
  unit('unit.t_per_ha_dm', 't DM/ha', 'yield_area', 'dry_matter_yield', 'dry_matter_yield_per_area', 'unit.t_per_ha_dm'),

  // Slice F (agronomy adds, catalog v6): companion canonical units for the
  // new number attributes above. Each is its own single-member family (a
  // dimensionless/simple scale-1 canonical root), matching the pattern
  // already used for unit.ds_per_m/unit.ph/unit.count_integer.
  { ...unit('unit.bbch_stage', 'BBCH', 'growth_stage', 'phenology', 'growth_stage', 'unit.bbch_stage'), since_version: 6 },
  { ...unit('unit.m_per_s', 'm/s', 'wind_speed', 'ambient', 'wind_speed', 'unit.m_per_s'), since_version: 6 },
  { ...unit('unit.deg_c', '°C', 'temperature', 'ambient', 'temperature', 'unit.deg_c'), since_version: 6 },
  { ...unit('unit.percent', '%', 'relative_humidity', 'ambient', 'relative_humidity', 'unit.percent'), since_version: 6 },
];

function choice(code, parent_code, label, sort_order) {
  return { code, parent_code, label, sort_order };
}

const choices = [
  choice('choice.cover.bare', 'attr.cover_type', 'Bare soil', 10),
  choice('choice.cover.crop', 'attr.cover_type', 'Crop cover', 20),
  choice('choice.cover.mulch', 'attr.cover_type', 'Mulch', 30),
  choice('choice.denominator.area', 'attr.denominator', 'Per area', 10),
  choice('choice.denominator.plant', 'attr.denominator', 'Per plant', 20),
  choice('choice.denominator.row', 'attr.denominator', 'Per row length', 30),
  choice('choice.root_zone.soil', 'attr.root_zone_system', 'Soil', 10),
  choice('choice.root_zone.container', 'attr.root_zone_system', 'Container', 20),
  choice('choice.root_zone.substrate', 'attr.root_zone_system', 'Substrate', 30),
  choice('choice.root_zone.hydroponic', 'attr.root_zone_system', 'Hydroponic', 40),
  choice('choice.mass_method.direct', 'attr.mass_method', 'Direct weighing', 10),
  choice('choice.mass_method.load_cell', 'attr.mass_method', 'Load cell', 20),
  choice('choice.irrigation_amount.measured', 'attr.irrigation_amount_kind', 'Measured', 10),
  choice('choice.irrigation_amount.estimated', 'attr.irrigation_amount_kind', 'Estimated', 20),
  choice('choice.irrigation_amount.commanded', 'attr.irrigation_amount_kind', 'Commanded', 30),
  choice('choice.measurement.manual', 'attr.measurement_source', 'Manual', 10),
  choice('choice.measurement.sensor', 'attr.measurement_source', 'Sensor', 20),
  choice('choice.measurement.controller', 'attr.measurement_source', 'Controller', 30),

  // Slice D (crop-cycle lifecycle, catalog v4): farmer-facing attr.crop
  // additions alongside the 26 Agroscope-aligned crop choices generated in
  // buildAgroscope() (generate-journal-catalog.js, agroscope.crop.* codes,
  // sort_order 3000+). These five cover categories the Agroscope export list
  // has no code for at all (spec §9) — sort_order starts well above the
  // Agroscope range so they display after it. 'ley, temporary' already
  // covers cover-crop leys generically; 'Green manure / cover crop' is for
  // non-ley cover crops (owner-confirmed, spec §9: no clover-grass qualifier
  // on temporary ley).
  { ...choice('choice.crop.permanent_grassland', 'attr.crop', 'Permanent grassland', 4000), since_version: 4 },
  { ...choice('choice.crop.field_vegetable', 'attr.crop', 'Field vegetable', 4010), since_version: 4 },
  { ...choice('choice.crop.green_manure_cover', 'attr.crop', 'Green manure / cover crop', 4020), since_version: 4 },
  { ...choice('choice.crop.fallow', 'attr.crop', 'Fallow', 4030), since_version: 4 },
  { ...choice('choice.crop.other', 'attr.crop', 'Other', 4040), since_version: 4 },

  // Slice F (agronomy adds, catalog v6): F2 wind-direction compass choices
  // for the manual weather-at-application fallback.
  { ...choice('choice.wind.n', 'attr.wind_direction', 'North', 10), since_version: 6 },
  { ...choice('choice.wind.ne', 'attr.wind_direction', 'Northeast', 20), since_version: 6 },
  { ...choice('choice.wind.e', 'attr.wind_direction', 'East', 30), since_version: 6 },
  { ...choice('choice.wind.se', 'attr.wind_direction', 'Southeast', 40), since_version: 6 },
  { ...choice('choice.wind.s', 'attr.wind_direction', 'South', 50), since_version: 6 },
  { ...choice('choice.wind.sw', 'attr.wind_direction', 'Southwest', 60), since_version: 6 },
  { ...choice('choice.wind.w', 'attr.wind_direction', 'West', 70), since_version: 6 },
  { ...choice('choice.wind.nw', 'attr.wind_direction', 'Northwest', 80), since_version: 6 },

  // Slice 1 (journal capture-followups plan 2026-07-21, Task 1.2 / W3): 16
  // open-field vegetable additions to attr.crop, English-only (matching every
  // existing crop choice — full crop-vocab i18n is a separate follow-up).
  // sort_order 3500..3560 (step 4) so these sort after the Agroscope
  // arable-crop range (agroscope.crop.* ~3000-3025, generate-journal-catalog.js
  // buildAgroscope) and before the generic v4 buckets (permanent_grassland /
  // field_vegetable / fallow / other at 4000-4040). Codes are deliberately
  // distinct from existing agronomically-different crops already in the
  // catalog: choice.crop.garden_pea != Agroscope 'pea, spring/winter' (field
  // pea), choice.crop.table_beet != 'beet, sugar/fodder', choice.crop.sweetcorn
  // != 'maize, grain/silage'.
  { ...choice('choice.crop.carrot', 'attr.crop', 'Carrot', 3500), since_version: 7 },
  { ...choice('choice.crop.onion', 'attr.crop', 'Onion', 3504), since_version: 7 },
  { ...choice('choice.crop.leek', 'attr.crop', 'Leek', 3508), since_version: 7 },
  { ...choice('choice.crop.cabbage', 'attr.crop', 'Cabbage', 3512), since_version: 7 },
  { ...choice('choice.crop.cauliflower', 'attr.crop', 'Cauliflower', 3516), since_version: 7 },
  { ...choice('choice.crop.broccoli', 'attr.crop', 'Broccoli', 3520), since_version: 7 },
  { ...choice('choice.crop.lettuce', 'attr.crop', 'Lettuce', 3524), since_version: 7 },
  { ...choice('choice.crop.spinach', 'attr.crop', 'Spinach', 3528), since_version: 7 },
  { ...choice('choice.crop.celeriac', 'attr.crop', 'Celeriac', 3532), since_version: 7 },
  { ...choice('choice.crop.fennel', 'attr.crop', 'Fennel', 3536), since_version: 7 },
  { ...choice('choice.crop.table_beet', 'attr.crop', 'Table beet', 3540), since_version: 7 },
  { ...choice('choice.crop.courgette', 'attr.crop', 'Courgette / zucchini', 3544), since_version: 7 },
  { ...choice('choice.crop.pumpkin_squash', 'attr.crop', 'Pumpkin / squash', 3548), since_version: 7 },
  { ...choice('choice.crop.sweetcorn', 'attr.crop', 'Sweetcorn', 3552), since_version: 7 },
  { ...choice('choice.crop.garden_pea', 'attr.crop', 'Garden pea', 3556), since_version: 7 },
  { ...choice('choice.crop.green_bean', 'attr.crop', 'Green bean', 3560), since_version: 7 },
];

const CORE_ACTIVITY_CODES = activities.map((activity) => activity.code);
const ALL_TEMPLATES = ['farmer_quick', 'full_record', 'research_observation'];

// v3 (Slice BC / R1): per-activity field sets for the Quick template. Every
// one of the 16 activities must have an entry (enforced by
// generate-journal-catalog.js's validateCore) so deriveFieldStates never
// falls through to an unmapped-activity default in normal operation. 'note'
// is a top-level field, not a catalog attribute, and is valid everywhere.
// Measurement readings are NOT listed under `sampling` here — they come from
// the plot's active layout `reading_fields` (see the layout v3 rows below),
// because the same catalog-wide template cannot hard-code a layout-specific
// field list. This covers the lysimeter water-balance set. NOTE: greenhouse
// EC/pH live in the greenhouse layout's `conditional_fields.solution_managed`,
// NOT `reading_fields`, so they surface only via Full/Research with that
// condition set — Quick `sampling` does not reach them (unchanged from pre-BC).
const FARMER_QUICK_V3_QUICK_FIELDS = {
  irrigation: ['attr.irrigation_depth', 'note'],
  fertilization: [
    'attr.product_uuid', 'attr.product',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
    'note',
  ],
  fertigation: [
    'attr.product_uuid', 'attr.product',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
    'note',
  ],
  plant_protection_application: [
    'attr.product_uuid', 'attr.product',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_biological_count_area',
    'attr.target', 'attr.waiting_period_days',
    'note',
  ],
  weed_control_nonchemical: ['note'],
  seeding: ['attr.crop', 'attr.amount_mass_area_product', 'attr.amount_count_area', 'note'],
  planting_transplanting: ['attr.crop', 'attr.amount_count_area', 'note'],
  pruning: ['note'],
  crop_care: ['note'],
  tillage_soil_work: ['attr.amount_operation_depth', 'note'],
  mowing: ['note'],
  harvest: ['attr.harvest_yield_area', 'note'],
  sampling: ['note'],
  general_observation: ['attr.observation_text', 'note'],
  pest_disease_observation: ['attr.observation_text', 'note'],
  equipment_maintenance: ['note'],
};

// v5 (Slice E / R5, spec §4-B): per-activity visible-field map for
// full_record's `operation` section, mirroring the mechanism farmer_quick@3's
// quick_fields established for Quick (Slice BC / R1) — see
// FARMER_QUICK_V3_QUICK_FIELDS above. full_record@1's `operation` section is a
// flat ~20-field list rendered in full for every activity regardless of what
// it actually needs (the live-UX bug this slice fixes: an irrigation entry
// showed fertilizer/harvest/plant-count fields). This map narrows which of
// the operation section's own declared fields render per activity; the
// section's field list itself (below, on the full_record@5 row) stays the
// exact same 23-field superset already shipped in full_record@1 — this is a
// visibility change, not a new-field change. `activity_requirements` /
// `conditional_groups` (unchanged from @1, duplicated verbatim below) still
// govern requiredness, and templateEngine's deriveFieldStates force-adds any
// field they mark required/required_any regardless of this map (see
// `addRequirement`), so an agronomically load-bearing field can never be
// scoped out from under its own required derivation — this map only trims
// the *optional* clutter. Every one of the 16 activities must have a
// nonempty entry (enforced by generate-journal-catalog.js's validateCore),
// and every field must be a member of the operation section's own declared
// field list (also enforced there).
const FULL_RECORD_V5_OPERATION_FIELDS_BY_ACTIVITY = {
  irrigation: [
    'attr.irrigation_amount_kind', 'attr.measurement_source', 'attr.denominator',
    'attr.irrigation_depth', 'attr.irrigation_volume_area', 'attr.per_plant_volume',
    'attr.actuation_expectation_id', 'attr.operator', 'attr.equipment', 'attr.method',
  ],
  fertilization: [
    'attr.product_uuid', 'attr.product', 'attr.treated_area',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  fertigation: [
    'attr.product_uuid', 'attr.product', 'attr.treated_area',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
    'attr.irrigation_amount_kind', 'attr.measurement_source', 'attr.denominator',
    'attr.irrigation_depth', 'attr.irrigation_volume_area', 'attr.per_plant_volume',
    'attr.actuation_expectation_id', 'attr.operator', 'attr.equipment', 'attr.method',
  ],
  plant_protection_application: [
    'attr.product_uuid', 'attr.product', 'attr.treated_area',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_biological_count_area',
    'attr.target', 'attr.waiting_period_days', 'attr.operator', 'attr.equipment', 'attr.method',
  ],
  weed_control_nonchemical: [
    'attr.treated_area', 'attr.target', 'attr.operator', 'attr.equipment', 'attr.method',
  ],
  seeding: [
    'attr.crop', 'attr.treated_area', 'attr.amount_mass_area_product', 'attr.amount_count_area',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  planting_transplanting: [
    'attr.crop', 'attr.treated_area', 'attr.amount_count_area',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  pruning: ['attr.operator', 'attr.equipment', 'attr.method'],
  crop_care: ['attr.operator', 'attr.equipment', 'attr.method'],
  tillage_soil_work: ['attr.treated_area', 'attr.operator', 'attr.equipment', 'attr.method'],
  mowing: ['attr.treated_area', 'attr.operator', 'attr.equipment', 'attr.method'],
  harvest: [
    'attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  sampling: ['attr.measurement_source', 'attr.operator', 'attr.equipment', 'attr.method'],
  general_observation: ['attr.operator', 'attr.equipment', 'attr.method'],
  pest_disease_observation: ['attr.target', 'attr.operator', 'attr.equipment', 'attr.method'],
  equipment_maintenance: ['attr.equipment', 'attr.operator', 'attr.method'],
};

// v6 (Slice F, R8): F1 folds attr.growth_stage_bbch (Quick optional) into the
// five activities named in the plan for general_observation,
// pest_disease_observation, plant_protection_application, crop_care and
// harvest — everything else in the map is byte-identical to
// FARMER_QUICK_V3_QUICK_FIELDS above (v3 stays untouched so historical Quick
// entries keep resolving against it).
const FARMER_QUICK_V6_QUICK_FIELDS = {
  ...FARMER_QUICK_V3_QUICK_FIELDS,
  plant_protection_application: [
    'attr.product_uuid', 'attr.product',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_biological_count_area',
    'attr.target', 'attr.waiting_period_days', 'attr.growth_stage_bbch',
    'note',
  ],
  crop_care: ['attr.growth_stage_bbch', 'note'],
  harvest: ['attr.harvest_yield_area', 'attr.growth_stage_bbch', 'note'],
  general_observation: ['attr.observation_text', 'attr.growth_stage_bbch', 'note'],
  pest_disease_observation: ['attr.observation_text', 'attr.growth_stage_bbch', 'note'],
};

// v6 (Slice F, R8 + Slice E review follow-ups #1/#2): builds on
// FULL_RECORD_V5_OPERATION_FIELDS_BY_ACTIVITY (which stays byte-identical
// above so full_record@5 keeps resolving unchanged for historical entries).
// Three kinds of deltas land here:
//  - Slice E review fold-in: attr.amount_operation_depth was captured by
//    Quick's tillage_soil_work set (FARMER_QUICK_V3_QUICK_FIELDS above) but
//    missing from Full's tillage_soil_work set, making Full *less* capable
//    than Quick for that one activity. Fixed here, tillage_soil_work only —
//    review fix (B-fold-in): Quick never carried operation-depth on seeding
//    or plant_protection_application either (it is agronomically
//    meaningless for a spraying/seeding pass in the way it is for tillage
//    depth), so Full does not gain it there — an earlier pass over-applied
//    this fold-in to all three activities instead of just the one Quick
//    actually had it on. Likewise attr.observation_text was Quick-only for
//    general_observation/pest_disease_observation; fixed the same way.
//  - F1: attr.growth_stage_bbch added to general_observation,
//    pest_disease_observation, plant_protection_application, crop_care,
//    harvest (Full visible).
//  - F2: the four weather-at-application attributes added to
//    plant_protection_application only. Visibility here is necessary but not
//    sufficient — the GUI additionally hides this group only once the
//    selected plot's zone actually has a weather-capable device assigned
//    (JournalPlot.zone_has_weather_source, resolved by osi-journal/api.js's
//    zoneHasWeatherSource) — review fix (B3): a plot merely having ANY
//    zone_uuid is a different, weaker fact than "has a weather source"; a
//    zone with only soil sensors (e.g. a DRAGINO_LSN50) keeps this group
//    visible.
const FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY = {
  ...FULL_RECORD_V5_OPERATION_FIELDS_BY_ACTIVITY,
  plant_protection_application: [
    'attr.product_uuid', 'attr.product', 'attr.treated_area',
    'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_biological_count_area',
    'attr.target', 'attr.waiting_period_days', 'attr.growth_stage_bbch',
    'attr.wind_speed', 'attr.wind_direction', 'attr.air_temperature', 'attr.rel_humidity',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  seeding: [
    'attr.crop', 'attr.treated_area', 'attr.amount_mass_area_product', 'attr.amount_count_area',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  crop_care: ['attr.growth_stage_bbch', 'attr.operator', 'attr.equipment', 'attr.method'],
  tillage_soil_work: [
    'attr.treated_area', 'attr.amount_operation_depth', 'attr.operator', 'attr.equipment', 'attr.method',
  ],
  harvest: [
    'attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area', 'attr.growth_stage_bbch',
    'attr.operator', 'attr.equipment', 'attr.method',
  ],
  general_observation: ['attr.observation_text', 'attr.growth_stage_bbch', 'attr.operator', 'attr.equipment', 'attr.method'],
  pest_disease_observation: [
    'attr.observation_text', 'attr.growth_stage_bbch', 'attr.target', 'attr.operator', 'attr.equipment', 'attr.method',
  ],
};

// v8 (treated-area-optional plan, 2026-07-22): `attr.treated_area` is removed
// from `activity_requirements.required` for the 5 dosing activities
// (fertilization/fertigation/plant_protection_application/seeding/
// planting_transplanting — see full_record@8 below), so it is no longer
// force-required anywhere. To keep it VISIBLE-optional everywhere it
// rendered before, it must stay reachable via operation_fields_by_activity.
// The only activity that needs it ADDED here is `irrigation` — it was never
// in V5/V6's irrigation list. All 5 dosing activities already carry
// treated_area in FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY (inherited from
// V5, including planting_transplanting), as do weed_control_nonchemical/
// tillage_soil_work/mowing, so only `irrigation` is overridden here — every
// other activity inherits unchanged. Do not mutate the frozen V6 const.
const FULL_RECORD_V8_OPERATION_FIELDS_BY_ACTIVITY = {
  ...FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY,
  irrigation: [
    'attr.irrigation_amount_kind', 'attr.measurement_source', 'attr.denominator',
    'attr.irrigation_depth', 'attr.irrigation_volume_area', 'attr.per_plant_volume',
    'attr.actuation_expectation_id', 'attr.operator', 'attr.equipment', 'attr.method',
    'attr.treated_area',
  ],
};

const templates = [
  {
    code: 'farmer_quick',
    version: 1,
    label: 'Quick',
    definition: {
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        { code: 'key_values', fields: ['attr.irrigation_depth', 'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'note'] },
      ],
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    },
  },
  // v2 (Task 27 / P4 fix): attr.operator/attr.equipment/attr.method were
  // carried forward but never shown in a visible section in v1 — a silent
  // prefill nobody could see or correct. v2 surfaces them as an explicit
  // section so the parseTemplate visibility guard (catalogModel.ts) accepts
  // this definition, and so the GUI actually renders + submits the values.
  // v1 stays byte-identical above so historical entries still resolve.
  {
    code: 'farmer_quick',
    version: 2,
    label: 'Quick',
    definition: {
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        { code: 'key_values', fields: ['attr.irrigation_depth', 'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'note'] },
        { code: 'carried_forward_details', fields: ['attr.operator', 'attr.equipment', 'attr.method'] },
      ],
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    },
  },
  // v3 (Slice BC / R1): replaces the flat, activity-blind `key_values`
  // section with `quick_fields`, an activity_code -> field-code map resolved
  // at render time by templateEngine.deriveFieldStates. There is no
  // `key_values` section on this row at all — the per-activity set IS the
  // Quick form's substantive content, so nothing generic needs to be listed
  // in `sections` to be validated. Plot-static context (block/bed/row,
  // structure/compartment, experimental unit, ...) is deliberately absent
  // from every quick_fields entry: it now comes from the plot's own
  // `journal_plot_settings.context_json` and renders read-only (Part 2 of
  // this slice), not as a per-entry required input. v1/v2 stay byte-identical
  // above so historical entries still resolve.
  {
    code: 'farmer_quick',
    version: 3,
    label: 'Quick',
    definition: {
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        { code: 'carried_forward_details', fields: ['attr.operator', 'attr.equipment', 'attr.method'] },
      ],
      quick_fields: FARMER_QUICK_V3_QUICK_FIELDS,
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    },
  },
  // v6 (Slice F, R8): F1 adds attr.growth_stage_bbch as a Quick-optional
  // field on five activities (FARMER_QUICK_V6_QUICK_FIELDS above); nothing
  // else in this definition differs from v3, which stays byte-identical
  // above so historical Quick entries keep resolving against it. The
  // catalog's single global version counter (spec §8.1) means this jumps
  // straight from v3 to v6 rather than v4 — v4/v5 are already used by other
  // rows (attr.crop farmer additions/attr.variety, full_record@5).
  {
    code: 'farmer_quick',
    version: 6,
    label: 'Quick',
    definition: {
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        { code: 'carried_forward_details', fields: ['attr.operator', 'attr.equipment', 'attr.method'] },
      ],
      quick_fields: FARMER_QUICK_V6_QUICK_FIELDS,
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    },
  },
  {
    code: 'full_record',
    version: 1,
    label: 'Full record',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'occurred_end'] },
        {
          code: 'operation',
          fields: [
            'attr.crop',
            'attr.product_uuid',
            'attr.product',
            'attr.treated_area',
            'attr.harvest_area',
            'attr.harvest_yield_area',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'attr.amount_nutrient_rate',
            'attr.amount_count_area',
            'attr.amount_biological_count_area',
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
            'attr.actuation_expectation_id',
            'attr.operator',
            'attr.equipment',
            'attr.method',
            'attr.target',
            'attr.waiting_period_days',
          ],
        },
        { code: 'notes', fields: ['note'] },
      ],
      activity_requirements: {
        fertilization: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        fertigation: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        plant_protection_application: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_biological_count_area',
            ],
          ],
        },
        seeding: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_mass_area_product', 'attr.amount_count_area']],
        },
        planting_transplanting: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_count_area']],
        },
        harvest: {
          required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
          required_any: [],
        },
      },
      conditional_groups: [
        {
          code: 'irrigation_details',
          activity_codes: ['irrigation', 'fertigation'],
          required: [
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
          ],
          required_any: [[
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
          ]],
          optional: ['attr.actuation_expectation_id'],
        },
      ],
      certified_compliance_profile: null,
    },
  },
  // v5 (Slice E / R5): activity-scoped visibility for the `operation`
  // section, addressing the live-UX bug in the header comment above
  // FULL_RECORD_V5_OPERATION_FIELDS_BY_ACTIVITY. `sections`/
  // `activity_requirements`/`conditional_groups`/`certified_compliance_profile`
  // are otherwise identical in shape and content to full_record@1 (only the
  // `operation` section gains `scoped_by_activity: true`, and the definition
  // gains `operation_fields_by_activity`) — full_record@1 above stays
  // byte-identical so historical Full entries keep resolving against it.
  {
    code: 'full_record',
    version: 5,
    label: 'Full record',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'occurred_end'] },
        {
          code: 'operation',
          scoped_by_activity: true,
          fields: [
            'attr.crop',
            'attr.product_uuid',
            'attr.product',
            'attr.treated_area',
            'attr.harvest_area',
            'attr.harvest_yield_area',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'attr.amount_nutrient_rate',
            'attr.amount_count_area',
            'attr.amount_biological_count_area',
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
            'attr.actuation_expectation_id',
            'attr.operator',
            'attr.equipment',
            'attr.method',
            'attr.target',
            'attr.waiting_period_days',
          ],
        },
        { code: 'notes', fields: ['note'] },
      ],
      operation_fields_by_activity: FULL_RECORD_V5_OPERATION_FIELDS_BY_ACTIVITY,
      activity_requirements: {
        fertilization: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        fertigation: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        plant_protection_application: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_biological_count_area',
            ],
          ],
        },
        seeding: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_mass_area_product', 'attr.amount_count_area']],
        },
        planting_transplanting: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_count_area']],
        },
        harvest: {
          required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
          required_any: [],
        },
      },
      conditional_groups: [
        {
          code: 'irrigation_details',
          activity_codes: ['irrigation', 'fertigation'],
          required: [
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
          ],
          required_any: [[
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
          ]],
          optional: ['attr.actuation_expectation_id'],
        },
      ],
      certified_compliance_profile: null,
    },
  },
  // v6 (Slice F, R8 + Slice E review follow-ups #1/#2): full_record@5 stays
  // byte-identical above so historical Full entries keep resolving against
  // it. This row's `operation` section field superset gains seven fields
  // over @5 (attr.amount_operation_depth, attr.observation_text — the review
  // fold-in — plus attr.growth_stage_bbch and the four weather-at-application
  // attributes from F1/F2); operation_fields_by_activity narrows per-activity
  // visibility exactly as @5 did, via FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY.
  // `activity_requirements`/`conditional_groups` (plus the new
  // weather_at_application group) are unchanged in meaning: every new field
  // is optional, never required, so no activity_requirements delta is
  // needed. The weather_at_application group's own GUI-side
  // "zone has no weather source" gate is not expressible in this generic
  // conditional_groups shape (which only conditions on activity, not
  // plot/zone data) — see JournalCaptureFlow.tsx's hasWeatherSource-based
  // (JournalPlot.zone_has_weather_source) fieldStates post-filter for that
  // half of the mechanism.
  {
    code: 'full_record',
    version: 6,
    label: 'Full record',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'occurred_end'] },
        {
          code: 'operation',
          scoped_by_activity: true,
          fields: [
            'attr.crop',
            'attr.product_uuid',
            'attr.product',
            'attr.treated_area',
            'attr.harvest_area',
            'attr.harvest_yield_area',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'attr.amount_nutrient_rate',
            'attr.amount_count_area',
            'attr.amount_biological_count_area',
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
            'attr.actuation_expectation_id',
            'attr.operator',
            'attr.equipment',
            'attr.method',
            'attr.target',
            'attr.waiting_period_days',
            'attr.amount_operation_depth',
            'attr.observation_text',
            'attr.growth_stage_bbch',
            'attr.wind_speed',
            'attr.wind_direction',
            'attr.air_temperature',
            'attr.rel_humidity',
          ],
        },
        { code: 'notes', fields: ['note'] },
      ],
      operation_fields_by_activity: FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY,
      activity_requirements: {
        fertilization: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        fertigation: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        plant_protection_application: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_biological_count_area',
            ],
          ],
        },
        seeding: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_mass_area_product', 'attr.amount_count_area']],
        },
        planting_transplanting: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_count_area']],
        },
        harvest: {
          required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
          required_any: [],
        },
      },
      conditional_groups: [
        {
          code: 'irrigation_details',
          activity_codes: ['irrigation', 'fertigation'],
          required: [
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
          ],
          required_any: [[
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
          ]],
          optional: ['attr.actuation_expectation_id'],
        },
        // F2: manual weather-at-application fallback. Declared here (mirroring
        // irrigation_details' shape) for documentation/discoverability parity
        // even though operation_fields_by_activity above already makes these
        // fields visible+optional for plant_protection_application on its
        // own — addField's merge-by-code logic (templateEngine.ts) makes the
        // two declarations idempotent together, never conflicting.
        {
          code: 'weather_at_application',
          activity_codes: ['plant_protection_application'],
          required: [],
          required_any: [],
          optional: [
            'attr.wind_speed',
            'attr.wind_direction',
            'attr.air_temperature',
            'attr.rel_humidity',
          ],
        },
      ],
      certified_compliance_profile: null,
    },
  },
  // v7 (Slice 1, journal capture-followups plan 2026-07-21, Task 1.1a): W1
  // relax Full-mode irrigation requiredness. full_record@6 stays
  // byte-identical above so historical Full entries keep resolving against
  // it. This row is identical to @6 in every respect (sections,
  // operation_fields_by_activity — reusing FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY
  // verbatim, activity_requirements, the weather_at_application conditional
  // group, certified_compliance_profile) except the `irrigation_details`
  // conditional group: `attr.measurement_source` and `attr.denominator` move
  // from `required` to `optional` (maintainer "relax to essentials"
  // decision, confirmed). `attr.irrigation_amount_kind` (the unit/kind)
  // stays required, alongside `required_any` (the amount: one of
  // depth/volume/per-plant) — both were never on the maintainer's drop list.
  // Paired with the templateEngine decouple (Task 1.1b), open_field's
  // block_bed_row/cover_type/denominator also become visible-but-optional via
  // static_context_fields, while treated_area stays required (Fable I1).
  {
    code: 'full_record',
    version: 7,
    label: 'Full record',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'occurred_end'] },
        {
          code: 'operation',
          scoped_by_activity: true,
          fields: [
            'attr.crop',
            'attr.product_uuid',
            'attr.product',
            'attr.treated_area',
            'attr.harvest_area',
            'attr.harvest_yield_area',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'attr.amount_nutrient_rate',
            'attr.amount_count_area',
            'attr.amount_biological_count_area',
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
            'attr.actuation_expectation_id',
            'attr.operator',
            'attr.equipment',
            'attr.method',
            'attr.target',
            'attr.waiting_period_days',
            'attr.amount_operation_depth',
            'attr.observation_text',
            'attr.growth_stage_bbch',
            'attr.wind_speed',
            'attr.wind_direction',
            'attr.air_temperature',
            'attr.rel_humidity',
          ],
        },
        { code: 'notes', fields: ['note'] },
      ],
      operation_fields_by_activity: FULL_RECORD_V6_OPERATION_FIELDS_BY_ACTIVITY,
      activity_requirements: {
        fertilization: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        fertigation: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        plant_protection_application: {
          required: ['attr.treated_area'],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_biological_count_area',
            ],
          ],
        },
        seeding: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_mass_area_product', 'attr.amount_count_area']],
        },
        planting_transplanting: {
          required: ['attr.crop', 'attr.treated_area'],
          required_any: [['attr.amount_count_area']],
        },
        harvest: {
          required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
          required_any: [],
        },
      },
      conditional_groups: [
        {
          code: 'irrigation_details',
          activity_codes: ['irrigation', 'fertigation'],
          required: ['attr.irrigation_amount_kind'],
          required_any: [[
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
          ]],
          optional: ['attr.measurement_source', 'attr.denominator', 'attr.actuation_expectation_id'],
        },
        // F2: manual weather-at-application fallback (unchanged from @6). See
        // the @6 comment above for why this declaration and
        // operation_fields_by_activity's own visibility are idempotent
        // together.
        {
          code: 'weather_at_application',
          activity_codes: ['plant_protection_application'],
          required: [],
          required_any: [],
          optional: [
            'attr.wind_speed',
            'attr.wind_direction',
            'attr.air_temperature',
            'attr.rel_humidity',
          ],
        },
      ],
      certified_compliance_profile: null,
    },
  },
  // v8 (treated-area-optional plan, 2026-07-22, maintainer-confirmed):
  // `attr.treated_area` is removed from `activity_requirements.required` for
  // fertilization/fertigation/plant_protection_application/seeding/
  // planting_transplanting — every other required field on those activities
  // is untouched. No activity requires treated_area after this version.
  // `operation_fields_by_activity` switches to
  // FULL_RECORD_V8_OPERATION_FIELDS_BY_ACTIVITY so treated_area stays VISIBLE
  // (now optional) on irrigation (newly added) plus every activity that
  // already carried it. Everything else (sections, conditional_groups,
  // weather group, certified_compliance_profile) is copied verbatim from @7.
  {
    code: 'full_record',
    version: 8,
    label: 'Full record',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'occurred_end'] },
        {
          code: 'operation',
          scoped_by_activity: true,
          fields: [
            'attr.crop',
            'attr.product_uuid',
            'attr.product',
            'attr.treated_area',
            'attr.harvest_area',
            'attr.harvest_yield_area',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'attr.amount_nutrient_rate',
            'attr.amount_count_area',
            'attr.amount_biological_count_area',
            'attr.irrigation_amount_kind',
            'attr.measurement_source',
            'attr.denominator',
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
            'attr.actuation_expectation_id',
            'attr.operator',
            'attr.equipment',
            'attr.method',
            'attr.target',
            'attr.waiting_period_days',
            'attr.amount_operation_depth',
            'attr.observation_text',
            'attr.growth_stage_bbch',
            'attr.wind_speed',
            'attr.wind_direction',
            'attr.air_temperature',
            'attr.rel_humidity',
          ],
        },
        { code: 'notes', fields: ['note'] },
      ],
      operation_fields_by_activity: FULL_RECORD_V8_OPERATION_FIELDS_BY_ACTIVITY,
      activity_requirements: {
        fertilization: {
          required: [],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        fertigation: {
          required: [],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_nutrient_rate',
            ],
          ],
        },
        plant_protection_application: {
          required: [],
          required_any: [
            ['attr.product_uuid', 'attr.product'],
            [
              'attr.amount_mass_area_product',
              'attr.amount_volume_area_product',
              'attr.amount_biological_count_area',
            ],
          ],
        },
        seeding: {
          required: ['attr.crop'],
          required_any: [['attr.amount_mass_area_product', 'attr.amount_count_area']],
        },
        planting_transplanting: {
          required: ['attr.crop'],
          required_any: [['attr.amount_count_area']],
        },
        harvest: {
          required: ['attr.crop', 'attr.harvest_area', 'attr.harvest_yield_area'],
          required_any: [],
        },
      },
      conditional_groups: [
        {
          code: 'irrigation_details',
          activity_codes: ['irrigation', 'fertigation'],
          required: ['attr.irrigation_amount_kind'],
          required_any: [[
            'attr.irrigation_depth',
            'attr.irrigation_volume_area',
            'attr.per_plant_volume',
          ]],
          optional: ['attr.measurement_source', 'attr.denominator', 'attr.actuation_expectation_id'],
        },
        {
          code: 'weather_at_application',
          activity_codes: ['plant_protection_application'],
          required: [],
          required_any: [],
          optional: [
            'attr.wind_speed',
            'attr.wind_direction',
            'attr.air_temperature',
            'attr.rel_humidity',
          ],
        },
      ],
      certified_compliance_profile: null,
    },
  },
  {
    code: 'research_observation',
    version: 1,
    label: 'Research',
    definition: {
      sections: [
        {
          code: 'identity',
          fields: [
            'activity_code',
            'plot_uuid',
            'occurred_start',
            'campaign_uuid',
            'protocol_code',
            'protocol_version',
            'observation_unit_code',
          ],
        },
        { code: 'standard_values', fields: ['attr.observation_text'] },
        { code: 'custom_values', include_scope: 'custom' },
      ],
      require_explicit_choices: true,
      show_standard_mappings: true,
    },
  },
];

const layouts = [
  {
    code: 'open_field',
    version: 1,
    label: 'Open field',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.block_bed_row', 'attr.treated_area', 'attr.cover_type', 'attr.denominator'],
      denominator_contract: ['area', 'plant', 'row'],
      option_dependencies: [],
    },
  },
  {
    code: 'greenhouse',
    version: 1,
    label: 'Greenhouse',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.structure_compartment', 'attr.root_zone_system', 'attr.plant_area', 'attr.wetted_area', 'attr.drainage_volume', 'attr.recirculation'],
      conditional_fields: {
        solution_managed: ['attr.ec', 'attr.ph'],
      },
      option_dependencies: [],
    },
  },
  {
    code: 'lysimeter',
    version: 1,
    label: 'Lysimeter',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.experimental_unit', 'attr.replicate', 'attr.treatment', 'attr.surface_area', 'attr.interval_minutes', 'attr.water_input', 'attr.rain_input', 'attr.drainage_volume', 'attr.mass_start', 'attr.mass_end', 'attr.tare_mass', 'attr.mass_method'],
      option_dependencies: [],
    },
  },
  // v3 (Slice BC / R1): `minimum_fields` on these three rows is unchanged in
  // *meaning* from v1 — full_record/research_observation still resolve the
  // exact same forced field set they always have (templateEngine.ts
  // reconstructs it from minimum_fields + reading_fields for any template
  // other than farmer_quick@3, so their resolution is provably unaffected by
  // this bump). What is new: `static_context_fields` (plot-level facts that
  // now live in journal_plot_settings.context_json and render read-only —
  // Part 2 of this slice) and `reading_fields` (per-measurement readings that
  // now appear only on the `sampling` Quick activity, not on every entry).
  // open_field.minimum_fields keeps attr.treated_area (full_record parity);
  // it is intentionally excluded from static_context_fields because it is
  // activity-variable, not a plot-static fact (R1/BC3) — farmer_quick@3's
  // fertilization/plant_protection_application quick_fields reference the
  // amount attributes directly instead.
  {
    code: 'open_field',
    version: 3,
    label: 'Open field',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.block_bed_row', 'attr.treated_area', 'attr.cover_type', 'attr.denominator'],
      static_context_fields: ['attr.block_bed_row', 'attr.cover_type', 'attr.denominator'],
      reading_fields: [],
      denominator_contract: ['area', 'plant', 'row'],
      option_dependencies: [],
    },
  },
  // v8 (treated-area-optional plan, 2026-07-22): drop attr.treated_area from
  // minimum_fields so the layout no longer force-requires it for any
  // activity (paired with full_record@8's activity_requirements change).
  // static_context_fields is unchanged (still the same 3 fields it already
  // was in v3, which never included treated_area) — the static ⊆ minimum
  // invariant holds trivially since the two sets are now equal.
  {
    code: 'open_field',
    version: 8,
    label: 'Open field',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.block_bed_row', 'attr.cover_type', 'attr.denominator'],
      static_context_fields: ['attr.block_bed_row', 'attr.cover_type', 'attr.denominator'],
      reading_fields: [],
      denominator_contract: ['area', 'plant', 'row'],
      option_dependencies: [],
    },
  },
  {
    code: 'greenhouse',
    version: 3,
    label: 'Greenhouse',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.structure_compartment', 'attr.root_zone_system', 'attr.plant_area'],
      static_context_fields: ['attr.structure_compartment', 'attr.root_zone_system', 'attr.plant_area'],
      reading_fields: ['attr.wetted_area', 'attr.drainage_volume', 'attr.recirculation'],
      conditional_fields: {
        solution_managed: ['attr.ec', 'attr.ph'],
      },
      option_dependencies: [],
    },
  },
  {
    code: 'lysimeter',
    version: 3,
    label: 'Lysimeter',
    definition: {
      activity_codes: CORE_ACTIVITY_CODES,
      supported_templates: ALL_TEMPLATES,
      minimum_fields: ['attr.experimental_unit', 'attr.replicate', 'attr.treatment', 'attr.surface_area'],
      static_context_fields: ['attr.experimental_unit', 'attr.replicate', 'attr.treatment', 'attr.surface_area'],
      reading_fields: ['attr.interval_minutes', 'attr.water_input', 'attr.rain_input', 'attr.drainage_volume', 'attr.mass_start', 'attr.mass_end', 'attr.tare_mass', 'attr.mass_method'],
      option_dependencies: [],
    },
  },
];

// Names are copied verbatim from catalog.json.product_suggestions. The source
// provides no defensible composition values, so every composition stays empty.
const products = [
  { code: 'slurry', name: 'Slurry', kind: 'organic_amendment', composition: {} },
  { code: 'manure', name: 'Manure', kind: 'organic_amendment', composition: {} },
  { code: 'slurry_dairy_cow', name: 'Slurry_dairy_cow', kind: 'organic_amendment', composition: {} },
  { code: 'manure_dairy_cow', name: 'Manure_dairy_cow', kind: 'organic_amendment', composition: {} },
  { code: 'slurry_pig', name: 'Slurry_pig', kind: 'organic_amendment', composition: {} },
  { code: 'manure_laying_hens', name: 'Manure_laying_hens', kind: 'organic_amendment', composition: {} },
  { code: 'digestate_solid', name: 'Digestate_solid', kind: 'organic_amendment', composition: {} },
  { code: 'digestate_liquid', name: 'Digestate_liquid', kind: 'organic_amendment', composition: {} },
  { code: 'compost', name: 'Compost', kind: 'organic_amendment', composition: {} },
  { code: 'glyphosate', name: 'Glyphosate', kind: 'plant_protection', composition: {} },
];

module.exports = {
  activities,
  attributes,
  units,
  choices,
  templates,
  layouts,
  products,
};
