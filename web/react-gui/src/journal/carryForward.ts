import { journalApi } from '../services/journalApi';
import type {
  EntryAggregate,
  EntryValue,
  JournalDefinitionRow,
} from '../types/journal';
import type {
  CaptureEntryValueInput,
  JournalTemplateDefinition,
} from '../types/journalCapture';

export const CARRY_FORWARD_PAGE_SIZE = 100;
export const CARRY_FORWARD_MAX_PAGES = 100;

export const PLANT_PROTECTION_PRODUCT_CODES = [
  'attr.product_uuid',
  'attr.product',
] as const;

export const PLANT_PROTECTION_RATE_CODES = [
  'attr.dose',
  'attr.amount_mass_area_product',
  'attr.amount_volume_area_product',
  'attr.amount_biological_count_area',
  'attr.amount_count_area',
  'attr.rate',
  'attr.application_rate',
] as const;

export const PLANT_PROTECTION_PROTECTED_CODES = [
  ...PLANT_PROTECTION_PRODUCT_CODES,
  ...PLANT_PROTECTION_RATE_CODES,
  'attr.authorization',
  'attr.authorization_number',
  'attr.target',
  'attr.dose_basis',
  'attr.basis',
  'attr.application_basis',
  'attr.treated_area',
  'attr.area_treated',
  'attr.waiting_period_days',
  'attr.waiting_period',
  'attr.phi',
  'attr.phi_days',
] as const;

const PROTECTED_CODE_SET = new Set<string>(PLANT_PROTECTION_PROTECTED_CODES);

export interface CarryForwardContext {
  plot_uuid: string | null;
  crop: string | null;
  activity_code: string;
  occurred_start: string;
  season_uuid: string | null;
  layout_code: string;
  layout_version: number;
}

export type CarryForwardEntry = Pick<EntryAggregate,
  | 'entry_uuid'
  | 'status'
  | 'plot_uuid'
  | 'season_uuid'
  | 'season_crop'
  | 'activity_code'
  | 'occurred_start'
  | 'layout_code'
  | 'layout_version'
  | 'values'
>;

interface RepeatTreatmentPreviewBase {
  sourceEntryUuid: string;
  sourceDate: string;
  crop: string | null;
  values: CaptureEntryValueInput[];
  context: CarryForwardContext;
}

export type RepeatTreatmentPreview = RepeatTreatmentPreviewBase & (
  | { complete: true; product: string; rate: string }
  | { complete: false; product: null; rate: null }
);

export type CarryForwardLabelMap =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export interface CarryForwardLabelSources {
  productLabels: CarryForwardLabelMap;
  unitLabels: CarryForwardLabelMap;
}

const EMPTY_LABEL_SOURCES: CarryForwardLabelSources = {
  productLabels: {},
  unitLabels: {},
};

export interface CarryForwardPartition {
  automaticValues: CaptureEntryValueInput[];
  repeatTreatment: RepeatTreatmentPreview | null;
}

export interface CarryForwardCandidate {
  draft: CarryForwardEntry;
  source: CarryForwardEntry;
  context: CarryForwardContext;
  repeatTreatment: RepeatTreatmentPreview | null;
}

type TemplateWithDefinition = Pick<JournalDefinitionRow, 'definition'>;
type CarryForwardTemplate =
  | Pick<JournalTemplateDefinition, 'carry_forward'>
  | TemplateWithDefinition;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isValueStatus(value: unknown): value is EntryValue['value_status'] {
  return typeof value === 'string' && [
    'observed',
    'not_observed',
    'not_applicable',
    'below_detection',
  ].includes(value);
}

function isEntryStatus(value: unknown): value is CarryForwardEntry['status'] {
  return typeof value === 'string' && ['draft', 'final', 'voided'].includes(value);
}

function isEntryValue(value: unknown): value is EntryValue {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.group_index) && Number(value.group_index) >= 0 &&
    typeof value.attribute_code === 'string' && value.attribute_code.length > 0 &&
    isValueStatus(value.value_status) &&
    isNullableFiniteNumber(value.value_num) &&
    isNullableString(value.value_text) &&
    isNullableString(value.unit_code) &&
    isNullableFiniteNumber(value.entered_value_num) &&
    isNullableString(value.entered_unit_code);
}

function isCarryForwardEntry(value: unknown): value is CarryForwardEntry {
  if (!isRecord(value)) return false;
  return typeof value.entry_uuid === 'string' && value.entry_uuid.length > 0 &&
    isEntryStatus(value.status) &&
    isNullableNonEmptyString(value.plot_uuid) &&
    isNullableNonEmptyString(value.season_uuid) &&
    isNullableString(value.season_crop) &&
    typeof value.activity_code === 'string' && value.activity_code.length > 0 &&
    typeof value.occurred_start === 'string' && occurredTime(value.occurred_start) != null &&
    typeof value.layout_code === 'string' && value.layout_code.length > 0 &&
    Number.isInteger(value.layout_version) && Number(value.layout_version) > 0 &&
    Array.isArray(value.values) && value.values.every(isEntryValue);
}

function isEntryListResponse(value: unknown): value is {
  entries: CarryForwardEntry[];
  next_cursor: string | null;
} {
  return isRecord(value) && Array.isArray(value.entries) &&
    value.entries.every(isCarryForwardEntry) &&
    (value.next_cursor === null || typeof value.next_cursor === 'string');
}

function contextFromEntry(entry: CarryForwardEntry): CarryForwardContext | null {
  if (typeof entry.activity_code !== 'string' ||
      typeof entry.occurred_start !== 'string' ||
      typeof entry.layout_code !== 'string' ||
      !Number.isInteger(entry.layout_version)) {
    return null;
  }
  return {
    plot_uuid: typeof entry.plot_uuid === 'string' ? entry.plot_uuid : null,
    crop: typeof entry.season_crop === 'string' ? entry.season_crop : null,
    activity_code: entry.activity_code,
    occurred_start: entry.occurred_start,
    season_uuid: typeof entry.season_uuid === 'string' ? entry.season_uuid : null,
    layout_code: entry.layout_code,
    layout_version: entry.layout_version,
  };
}

function occurredTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function compatible(source: CarryForwardEntry, draft: CarryForwardContext): boolean {
  const sourceContext = contextFromEntry(source);
  if (!sourceContext || source.status !== 'final') return false;
  if (draft.season_uuid == null || draft.plot_uuid == null || sourceContext.season_uuid == null ||
      sourceContext.plot_uuid == null) return false;
  const sourceTime = occurredTime(sourceContext.occurred_start);
  const draftTime = occurredTime(draft.occurred_start);
  return sourceContext.season_uuid === draft.season_uuid &&
    sourceContext.plot_uuid === draft.plot_uuid &&
    sourceContext.activity_code === draft.activity_code &&
    sourceContext.layout_code === draft.layout_code &&
    sourceContext.layout_version === draft.layout_version &&
    sourceTime != null && draftTime != null && sourceTime <= draftTime;
}

function preferSource(candidate: CarryForwardEntry, current: CarryForwardEntry | null): boolean {
  if (!current) return true;
  const candidateTime = occurredTime(candidate.occurred_start);
  const currentTime = occurredTime(current.occurred_start);
  if (candidateTime == null) return false;
  if (currentTime == null) return true;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.entry_uuid < current.entry_uuid;
}

function declaredCarryForward(template: CarryForwardTemplate): string[] {
  if ('carry_forward' in template && Array.isArray(template.carry_forward)) {
    return template.carry_forward.filter((code): code is string => typeof code === 'string');
  }
  const definition = 'definition' in template ? template.definition : undefined;
  if (!isRecord(definition) || !Array.isArray(definition.carry_forward)) return [];
  return definition.carry_forward.filter((code): code is string => typeof code === 'string');
}

function captureValue(value: EntryValue): CaptureEntryValueInput {
  return {
    attribute_code: value.attribute_code,
    group_index: value.group_index,
    value_status: value.value_status,
    ...(value.value_num != null ? { value_num: value.value_num } : {}),
    ...(value.value_text != null ? { value_text: value.value_text } : {}),
    ...(value.unit_code != null ? { unit_code: value.unit_code } : {}),
    ...(value.entered_value_num != null ? { entered_value_num: value.entered_value_num } : {}),
    ...(value.entered_unit_code != null ? { entered_unit_code: value.entered_unit_code } : {}),
  };
}

function protectedField(attributeCode: string): boolean {
  return PROTECTED_CODE_SET.has(attributeCode);
}

function resolveLabel(labels: CarryForwardLabelMap, code: string): string | null {
  const maybeMap = labels as { get?: (key: string) => string | undefined };
  const value = typeof maybeMap.get === 'function'
    ? maybeMap.get(code)
    : (labels as Readonly<Record<string, string>>)[code];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstValueForCode(
  values: CaptureEntryValueInput[],
  attributeCode: string,
): CaptureEntryValueInput | undefined {
  return values
    .filter(({ attribute_code: code }) => code === attributeCode)
    .sort((left, right) => (left.group_index ?? 0) - (right.group_index ?? 0))[0];
}

function nonEmptyText(row: CaptureEntryValueInput | undefined): string | null {
  const text = row?.value_text;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

function productLabel(
  values: CaptureEntryValueInput[],
  labels: CarryForwardLabelMap,
): string | null {
  const productUuid = nonEmptyText(firstValueForCode(values, 'attr.product_uuid'));
  const catalogLabel = productUuid == null ? null : resolveLabel(labels, productUuid);
  if (catalogLabel) return catalogLabel;
  return nonEmptyText(firstValueForCode(values, 'attr.product'));
}

function rateLabel(
  values: CaptureEntryValueInput[],
  labels: CarryForwardLabelMap,
): string | null {
  const row = PLANT_PROTECTION_RATE_CODES
    .map((code) => firstValueForCode(values, code))
    .find((value): value is CaptureEntryValueInput => value != null);
  if (!row) return null;

  const enteredPairPresent = row.entered_value_num != null || row.entered_unit_code != null;
  const value = enteredPairPresent ? row.entered_value_num : row.value_num;
  const unitCode = enteredPairPresent ? row.entered_unit_code : row.unit_code;
  if (value == null || unitCode == null) return null;
  const unitLabel = resolveLabel(labels, unitCode);
  return unitLabel == null ? null : `${value} ${unitLabel}`;
}

function repeatTreatment(
  source: CarryForwardEntry,
  values: CaptureEntryValueInput[],
  context: CarryForwardContext,
  labels: CarryForwardLabelSources,
): RepeatTreatmentPreview {
  const product = productLabel(values, labels.productLabels);
  const rate = rateLabel(values, labels.unitLabels);
  const crop = typeof source.season_crop === 'string' && source.season_crop.trim().length > 0
    ? source.season_crop.trim()
    : null;
  const base: RepeatTreatmentPreviewBase = {
    sourceEntryUuid: source.entry_uuid,
    sourceDate: source.occurred_start,
    crop,
    values,
    context,
  };
  return product && rate && crop
    ? { ...base, complete: true, product, rate }
    : { ...base, complete: false, product: null, rate: null };
}

export function partitionCarryForward(
  source: CarryForwardEntry,
  template: CarryForwardTemplate,
  labels: CarryForwardLabelSources = EMPTY_LABEL_SOURCES,
): CarryForwardPartition {
  const declared = new Set(declaredCarryForward(template));
  const values = source.values.map(captureValue);
  const automaticValues = values.filter(({ attribute_code }) =>
    declared.has(attribute_code) && !protectedField(attribute_code));
  const protectedValues = values.filter(({ attribute_code }) => protectedField(attribute_code));
  const sourceContext = contextFromEntry(source);
  return {
    automaticValues,
    repeatTreatment: source.activity_code === 'plant_protection_application' && sourceContext
      ? repeatTreatment(source, protectedValues, sourceContext, labels)
      : null,
  };
}

export function sameCarryForwardContext(
  left: CarryForwardContext,
  right: CarryForwardContext,
): boolean {
  return left.plot_uuid === right.plot_uuid &&
    left.crop === right.crop &&
    left.activity_code === right.activity_code &&
    left.occurred_start === right.occurred_start &&
    left.season_uuid === right.season_uuid &&
    left.layout_code === right.layout_code &&
    left.layout_version === right.layout_version;
}

export async function loadCarryForwardCandidate(
  entryUuid: string,
  labels: CarryForwardLabelSources = EMPTY_LABEL_SOURCES,
): Promise<CarryForwardCandidate | null> {
  const draftResponse = await journalApi.listEntries({
    entry_uuid: entryUuid,
    status: 'all',
    limit: CARRY_FORWARD_PAGE_SIZE,
  });
  if (!isEntryListResponse(draftResponse)) return null;
  if (draftResponse.next_cursor !== null) return null;
  const exactRows = draftResponse.entries.filter((entry) => entry.entry_uuid === entryUuid);
  if (exactRows.length !== 1 || exactRows[0].status !== 'draft') return null;
  const draft = exactRows[0];
  const context = contextFromEntry(draft);
  if (!context || context.season_uuid == null || context.plot_uuid == null) return null;

  let cursor: string | undefined;
  let source: CarryForwardEntry | null = null;
  const seenCursors = new Set<string>();
  let pageCount = 0;
  do {
    if (pageCount >= CARRY_FORWARD_MAX_PAGES) return null;
    pageCount += 1;
    const response = await journalApi.listEntries({
      status: 'final',
      limit: CARRY_FORWARD_PAGE_SIZE,
      ...(cursor == null ? {} : { cursor }),
    });
    if (!isEntryListResponse(response)) return null;
    for (const entry of response.entries) {
      if (compatible(entry, context) && preferSource(entry, source)) source = entry;
    }
    if (response.next_cursor == null) break;
    if (seenCursors.has(response.next_cursor)) return null;
    seenCursors.add(response.next_cursor);
    cursor = response.next_cursor;
  } while (true);

  if (!source) return null;
  const partition = partitionCarryForward(source, {
    definition: { carry_forward: [] },
  }, labels);
  return { draft, source, context, repeatTreatment: partition.repeatTreatment };
}
