// Wire types for the Slice-1 field-journal REST contract. Snake_case mirrors
// osi-journal/api.js catalogDto/plotAggregate/plotGroupAggregate and
// osi-journal/aggregate.js buildAggregate.

export type JsonObject = Record<string, unknown>;
export type VocabKind = 'activity' | 'attribute' | 'unit' | 'choice';
export type ValueType = 'number' | 'text' | 'choice' | 'date' | 'boolean';
export type ValueStatus = 'observed' | 'not_observed' | 'not_applicable' | 'below_detection';
export type EntryStatus = 'draft' | 'final' | 'voided';
export type EntryWriteStatus = Exclude<EntryStatus, 'voided'>;

export interface JournalVocabRow {
  code: string;
  kind: VocabKind;
  parent_code: string | null;
  value_type: ValueType | null;
  quantity_kind: string | null;
  basis: string | null;
  default_unit_code: string | null;
  icon_key: string | null;
  scope: 'core' | 'custom';
  owner_user_uuid: string | null;
  gateway_device_eui: string | null;
  custom_field_uuid: string | null;
  active: number;
  sort_order: number;
  sync_version: number;
  created_at: string;
  deleted_at: string | null;
  labels?: Record<string, string>;
  constraints?: JsonObject | null;
}

export interface JournalDefinitionRow {
  code: string;
  version: number;
  active: number;
  labels?: Record<string, string>;
  definition?: JsonObject;
}

export interface JournalProductRow {
  product_uuid: string;
  scope: 'core' | 'farm';
  owner_user_uuid: string | null;
  gateway_device_eui: string | null;
  name: string;
  kind: 'mineral' | 'organic_amendment' | 'plant_protection' | 'other';
  active: number;
  sync_version: number;
  created_at: string;
  deleted_at: string | null;
  composition?: JsonObject;
}

export interface JournalMappingRow {
  term_code: string;
  scheme_uri: string;
  scheme_version: string;
  mapping_role: string;
  external_id: string;
  external_parent_id: string | null;
  mapping_relation: string;
  source_uri: string | null;
  active: number;
}

export interface JournalCatalog {
  catalog_version: number;
  catalog_hash: string;
  vocab: JournalVocabRow[];
  templates: JournalDefinitionRow[];
  layouts: JournalDefinitionRow[];
  products: JournalProductRow[];
  mappings: JournalMappingRow[];
}

export interface EntryValue {
  group_index: number;
  attribute_code: string;
  value_status: ValueStatus;
  value_num: number | null;
  value_text: string | null;
  unit_code: string | null;
  entered_value_num: number | null;
  entered_unit_code: string | null;
}

export interface EntryValueInput {
  group_index?: number;
  attribute_code: string;
  value_status?: ValueStatus;
  value?: string | number | boolean | null;
  value_num?: number | null;
  value_text?: string | null;
  unit_code?: string | null;
  entered_value_num?: number | null;
  entered_unit_code?: string | null;
}

export interface EntryAggregate {
  contract_version: number;
  entry_uuid: string;
  owner_user_uuid: string;
  author_principal_uuid: string;
  author_label: string | null;
  gateway_device_eui: string;
  plot_uuid: string | null;
  zone_uuid: string | null;
  device_eui: string | null;
  season_uuid: string | null;
  season_crop: string | null;
  season_variety: string | null;
  campaign_uuid: string | null;
  protocol_code: string | null;
  protocol_version: string | null;
  observation_unit_code: string | null;
  activity_code: string;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  catalog_version: number;
  occurred_start: string;
  occurred_end: string | null;
  occurred_timezone: string;
  occurred_utc_offset_minutes: number;
  origin: 'edge-ui' | 'cloud-ui';
  status: EntryStatus;
  batch_uuid: string | null;
  pass_uuid: string | null;
  voided_at: string | null;
  voided_by_principal_uuid: string | null;
  void_reason: string | null;
  note: string | null;
  context_json: string | null;
  sync_version: number;
  recorded_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  values: EntryValue[];
}

export interface EntryDraftMutationReceipt {
  entry_uuid: string;
  sync_version: 0;
  outbox_event_uuid?: never;
}

export interface EntryFinalMutationReceipt {
  entry_uuid: string;
  outbox_event_uuid: string;
  sync_version: number;
}

export type EntryMutationReceipt = EntryDraftMutationReceipt | EntryFinalMutationReceipt;

export interface EntryListFilters {
  entry_uuid?: string;
  plot_uuid?: string;
  zone_uuid?: string;
  activity_code?: string;
  status?: EntryStatus | 'all';
  occurred_from?: string;
  occurred_to?: string;
  campaign_uuid?: string;
  protocol_code?: string;
  protocol_version?: string;
  observation_unit_code?: string;
  batch_uuid?: string;
  pass_uuid?: string;
  limit?: number;
  cursor?: string;
}

export interface EntryListResponse {
  entries: EntryAggregate[];
  next_cursor: string | null;
}

export interface JournalPlotSettings {
  layout_code: string;
  updated_at: string;
  updated_by_principal_uuid: string;
  sync_version: number;
}

export interface JournalPlot {
  contract_version: number;
  plot_uuid: string;
  plot_code: string;
  name: string | null;
  zone_uuid: string | null;
  station_code: string | null;
  crop_hint: string | null;
  area_m2: number | null;
  active: number;
  sync_version: number;
  owner_user_uuid: string;
  gateway_device_eui: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  settings: JournalPlotSettings;
}

export interface PlotGroup {
  contract_version: number;
  group_uuid: string;
  label: string;
  owner_user_uuid: string;
  gateway_device_eui: string;
  created_by_principal_uuid: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_principal_uuid: string | null;
  sync_version: number;
  deleted_at: string | null;
  members: string[];
}

export interface JournalPlotListResponse {
  plots: JournalPlot[];
}

export interface PlotGroupListResponse {
  plot_groups: PlotGroup[];
}
