#!/usr/bin/env node
'use strict';

// Hand-authored catalog facts. Keep this module data-only: the generator is
// responsible for normalization, Agroscope expansion, hashing, and SQL.

const ACTIVITY_LABELS = [
  ['irrigation', 'Irrigation', 'droplets'],
  ['fertilization', 'Fertilization', 'fertilizer'],
  ['fertigation', 'Fertigation', 'fertigation'],
  ['plant_protection_application', 'Plant protection', 'plant_protection'],
  ['weed_control_nonchemical', 'Non-chemical weed control', 'weed_control'],
  ['seeding', 'Seeding', 'seeding'],
  ['planting_transplanting', 'Planting / transplanting', 'planting'],
  ['pruning', 'Pruning', 'pruning'],
  ['crop_care', 'Crop care', 'crop_care'],
  ['tillage_soil_work', 'Tillage / soil work', 'tillage'],
  ['mowing', 'Mowing', 'mowing'],
  ['harvest', 'Harvest', 'harvest'],
  ['sampling', 'Sampling', 'sampling'],
  ['general_observation', 'General observation', 'observation'],
  ['pest_disease_observation', 'Pest / disease observation', 'pest_disease'],
  ['equipment_maintenance', 'Equipment maintenance', 'maintenance'],
];

const activities = ACTIVITY_LABELS.map(([code, label, icon_key], index) => ({
  code,
  label,
  icon_key,
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
  numberAttribute('attr.amount_nutrient_rate', 'Nutrient rate', 'nutrient_rate', 'nutrient', 'unit.kg_n_per_ha_nutrient', { min: 0 }),
  numberAttribute('attr.amount_count_area', 'Plant count per area', 'count_area', 'plant', 'unit.plants_per_ha', { min: 0 }),
  numberAttribute('attr.amount_biological_count_area', 'Biological-agent count per area', 'biological_count_area', 'biological_agent', 'unit.biological_count_per_ha', { min: 0 }),
  numberAttribute('attr.amount_duration_area', 'Labour duration per area', 'duration_area', 'labor', 'unit.h_per_ha_labor', { min: 0 }),
  numberAttribute('attr.irrigation_volume_area', 'Irrigation volume per area', 'volume_area', 'water', 'unit.m3_per_ha_water', { min: 0 }),

  // Generic activity and layout measurements.
  numberAttribute('attr.irrigation_depth', 'Irrigation depth', 'water_depth', 'water', 'unit.mm_water', { min: 0 }),
  numberAttribute('attr.duration_minutes', 'Duration', 'duration', 'elapsed_time', 'unit.min_duration', { min: 0 }),
  numberAttribute('attr.per_plant_volume', 'Volume per plant', 'volume_per_plant', 'water', 'unit.l_per_plant_water', { min: 0 }),
  numberAttribute('attr.treated_area', 'Treated area', 'area', 'land_area', 'unit.m2_area', { min: 0 }),
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
  scalarAttribute('attr.product', 'Product', 'text', { maxlength: 500 }),
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

const units = [
  unit('unit.cm_operation_depth', 'cm', 'operation_depth', 'operation_depth', 'length_operation_depth', 'unit.cm_operation_depth'),
  unit('unit.g_per_ha_product', 'g/ha', 'mass_area', 'product', 'mass_product_per_area', 'unit.kg_per_ha_product', 0.001),
  unit('unit.kg_per_ha_product', 'kg/ha', 'mass_area', 'product', 'mass_product_per_area', 'unit.kg_per_ha_product'),
  unit('unit.t_per_ha_product', 't/ha', 'mass_area', 'product', 'mass_product_per_area', 'unit.kg_per_ha_product', 1000),
  unit('unit.l_per_ha_product', 'L/ha', 'volume_area', 'product', 'volume_product_per_area', 'unit.l_per_ha_product'),
  unit('unit.m3_per_ha_product', 'm³/ha', 'volume_area', 'product', 'volume_product_per_area', 'unit.l_per_ha_product', 1000),
  unit('unit.m3_per_ha_water', 'm³/ha', 'volume_area', 'water', 'water_volume_per_area', 'unit.m3_per_ha_water'),
  unit('unit.plants_per_ha', 'plants/ha', 'count_area', 'plant', 'plant_count_per_area', 'unit.plants_per_ha'),
  unit('unit.biological_count_per_ha', 'unit/ha', 'biological_count_area', 'biological_agent', 'biological_agent_count_per_area', 'unit.biological_count_per_ha'),
  unit('unit.h_per_ha_labor', 'hours/ha', 'duration_area', 'labor', 'labor_time_per_area', 'unit.h_per_ha_labor'),

  unit('unit.kg_n_per_ha_nutrient', 'kg N/ha', 'nutrient_rate', 'nutrient', 'mass_n_per_area', 'unit.kg_n_per_ha_nutrient', 1, 0, { nutrient: 'N' }),
  unit('unit.kg_p2o5_per_ha_nutrient', 'kg P₂O₅/ha', 'nutrient_rate', 'nutrient', 'mass_p2o5_per_area', 'unit.kg_p2o5_per_ha_nutrient', 1, 0, { nutrient: 'P2O5' }),
  unit('unit.kg_k2o_per_ha_nutrient', 'kg K₂O/ha', 'nutrient_rate', 'nutrient', 'mass_k2o_per_area', 'unit.kg_k2o_per_ha_nutrient', 1, 0, { nutrient: 'K2O' }),
  unit('unit.kg_mg_per_ha_nutrient', 'kg Mg/ha', 'nutrient_rate', 'nutrient', 'mass_mg_per_area', 'unit.kg_mg_per_ha_nutrient', 1, 0, { nutrient: 'Mg' }),
  unit('unit.kg_s_per_ha_nutrient', 'kg S/ha', 'nutrient_rate', 'nutrient', 'mass_s_per_area', 'unit.kg_s_per_ha_nutrient', 1, 0, { nutrient: 'S' }),
  unit('unit.kg_ca_per_ha_nutrient', 'kg Ca/ha', 'nutrient_rate', 'nutrient', 'mass_ca_per_area', 'unit.kg_ca_per_ha_nutrient', 1, 0, { nutrient: 'Ca' }),
  unit('unit.kg_b_per_ha_nutrient', 'kg B/ha', 'nutrient_rate', 'nutrient', 'mass_b_per_area', 'unit.kg_b_per_ha_nutrient', 1, 0, { nutrient: 'B' }),
  unit('unit.kg_na_per_ha_nutrient', 'kg Na/ha', 'nutrient_rate', 'nutrient', 'mass_na_per_area', 'unit.kg_na_per_ha_nutrient', 1, 0, { nutrient: 'Na' }),
  unit('unit.kg_mn_per_ha_nutrient', 'kg Mn/ha', 'nutrient_rate', 'nutrient', 'mass_mn_per_area', 'unit.kg_mn_per_ha_nutrient', 1, 0, { nutrient: 'Mn' }),
  unit('unit.kg_cao_per_ha_nutrient', 'kg CaO/ha', 'nutrient_rate', 'nutrient', 'mass_cao_per_area', 'unit.kg_cao_per_ha_nutrient', 1, 0, { nutrient: 'CaO' }),

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
  {
    code: 'full_record',
    version: 1,
    label: 'Full record',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'occurred_end'] },
        { code: 'operation', fields: ['attr.product', 'attr.treated_area', 'attr.operator', 'attr.equipment', 'attr.method', 'attr.target', 'attr.waiting_period_days'] },
        { code: 'notes', fields: ['note'] },
      ],
      activity_requirements: {
        plant_protection_application: ['attr.product', 'attr.treated_area'],
        harvest: ['attr.crop'],
      },
      certified_compliance_profile: null,
    },
  },
  {
    code: 'research_observation',
    version: 1,
    label: 'Research',
    definition: {
      sections: [
        { code: 'identity', fields: ['activity_code', 'plot_uuid', 'occurred_start', 'protocol_code', 'observation_unit_code'] },
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
