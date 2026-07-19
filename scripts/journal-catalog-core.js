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
];

const CORE_ACTIVITY_CODES = activities.map((activity) => activity.code);
const ALL_TEMPLATES = ['farmer_quick', 'full_record', 'research_observation'];

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
