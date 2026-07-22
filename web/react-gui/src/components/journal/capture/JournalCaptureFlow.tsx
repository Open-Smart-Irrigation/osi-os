import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  allowedChoices,
  allowedUnits,
  buildCatalogModel,
  catalogLabel,
  deriveActivityLeaves,
  withWeatherAtApplicationVisibility,
} from '../../../journal/catalogModel';
import {
  loadActivityShortlist,
  type ActivityShortlist,
} from '../../../journal/activityShortlist';
import {
  loadCarryForwardCandidate,
  partitionCarryForward,
  sameCarryForwardContext,
} from '../../../journal/carryForward';
import {
  buildEntryValues,
  deriveFieldStates,
} from '../../../journal/templateEngine';
import {
  computeLayoutTransitionDiff,
  layoutTransitionItemKey,
} from '../../../journal/layoutTransition';
import type {
  LayoutTransitionAffectedItem,
  LayoutTransitionResolutionKind,
} from '../../../journal/layoutTransition';
import {
  isValidApiInstant,
  OccurrenceResolutionError,
  resolveOccurrence,
  type ResolvedOccurrence,
} from '../../../journal/occurrence';
import { useCaptureDraft, type CaptureSaveState } from '../../../journal/useCaptureDraft';
import { buildFinalBatchPayload, buildTankMixPassBatchPayload } from '../../../journal/buildFinalBatchPayload';
import { matchingActiveHarvestGroups } from '../../../journal/groupResolutionNudge';
import {
  MANUAL_CLOSE_ACTIVITY_CODES,
  SEEDING_ACTIVITY_CODES,
  currentCropInfoForPlot,
  cycleDisambiguationFromError,
  varietySuggestionsFor,
  type CurrentCropInfo,
  type CycleOption,
} from '../../../journal/cropCycle';
import type {
  JournalPlotGroupResourceActions,
} from '../../../journal/useJournalPlotGroups';
import type { JournalPlotResourceActions } from '../../../journal/useJournalPlots';
import type {
  CarryForwardCandidate,
  CarryForwardContext,
} from '../../../journal/carryForward';
import { journalApi } from '../../../services/journalApi';
import type { CreateEntryPayload } from '../../../services/journalApi';
import type {
  BatchMutationReceipt,
  EntryAggregate,
  EntryFinalMutationReceipt,
  JournalCatalog,
  JournalPlot,
  JournalProductRow,
  PlotGroup,
} from '../../../types/journal';
import type {
  ActivityLeafSelection,
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalLayoutDefinition,
  JournalCaptureCatalogModel,
  JournalScalar,
  JournalSelections,
  JournalTemplateDefinition,
} from '../../../types/journalCapture';
import { ActivityPicker } from './ActivityPicker';
import { ConfirmStrip, type CaptureEditStep, type ConfirmValueToken } from './ConfirmStrip';
import { EntryForm, validateEntryForm } from './EntryForm';
import { LayoutTransitionReviewSheet } from './LayoutTransitionReviewSheet';
import { PlotForm } from '../where/PlotForm';
import { parsePlotContextJson } from '../where/PlotContextFields';
import { HarvestGroupNudge } from '../where/HarvestGroupNudge';
import { PlotPicker } from '../where/PlotPicker';
import { CycleDisambiguationSheet } from './CycleDisambiguationSheet';
import { InheritedCropBanner } from './InheritedCropBanner';
import { RepeatTreatmentCard } from './RepeatTreatmentCard';
import { SaveState } from './SaveState';
import { SeedingCropFields } from './SeedingCropFields';
import { randomUuid } from '../../../utils/uuid';
import { useDisplayPreferences } from '../../../utils/displayPreferences';

export interface JournalCaptureFlowProps {
  catalog: JournalCatalog;
  plots: JournalPlot[];
  plotGroups: PlotGroup[];
  initialPlot?: JournalPlot;
  recentEntries: EntryAggregate[];
  initialTimezone?: string;
  zoneCrops?: Readonly<Record<string, string>>;
  zoneTimezones?: Readonly<Record<string, string>>;
  // 'revalidate' (Slice D hardening): after correcting a seeding's crop via
  // the InheritedCropBanner (which updates the CYCLE row, not this flow's own
  // `plots` prop), refetch the plot list so active_crop_cycles — and
  // everything derived from it (openCropCycleInfo/bannerInfo/the Where-step
  // display) — reflects the correction instead of staying stale.
  plotState: Pick<JournalPlotResourceActions, 'createPlot' | 'updatePlot' | 'revalidate'>;
  groupState: Pick<JournalPlotGroupResourceActions, 'createPlotGroup' | 'updatePlotGroup'>;
  onClose: () => void;
  onOpenExisting: (entryUuid: string) => void;
  onSaved: (receipt: JournalSavedReceipt) => void | Promise<void>;
  // POLISH 7: optional re-fetch hook for the hard-failure catalog state
  // below (a genuine buildCatalogModel failure, not a normal loading state --
  // the caller already gates mounting this component on its own catalog
  // loading/error states, see JournalPage.tsx). Omitted, the failure state
  // still offers a way out via the always-present `onClose`; when the caller
  // wires its own catalog retry, a retry action is offered too.
  onRetryCatalog?: () => void;
}

export type JournalSavedReceipt = EntryFinalMutationReceipt | BatchMutationReceipt;

type CaptureStep = CaptureEditStep | 'confirm';

interface DuplicateCandidate {
  entry_uuid: string;
  occurred_start: string;
  activity_code: string;
  plot_uuid?: string | null;
  values: EntryAggregate['values'];
}

interface DuplicateCandidateGroup {
  key: string;
  label: string;
  candidates: DuplicateCandidate[];
}

interface CropCycleOverlap {
  crop_code: string;
  variety: string | null;
}

interface AcceptedRepeatSnapshot {
  sourceEntryUuid: string;
  context: CarryForwardContext;
  candidateValues: ReadonlyArray<Readonly<CaptureEntryValueInput>>;
  values: CaptureEntryValueInput[];
}

// Slice F (F3): the tank-mix product-family fields a spray pass's "add
// product to this pass" affordance snapshots per queued product and clears
// from the live form so the next product can be entered. Kept to exactly the
// fields plant_protection_application's operation_fields_by_activity/
// quick_fields declare for product identity + dose — treated_area, operator,
// equipment, wind/temp/humidity, growth stage, etc. all stay shared across
// every product in the pass.
const TANK_MIX_PRODUCT_FIELD_CODES = [
  'attr.product_uuid', 'attr.product',
  'attr.amount_mass_area_product', 'attr.amount_volume_area_product', 'attr.amount_biological_count_area',
];

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const EMPTY_NUMBER_INPUT_ERRORS: ReadonlyMap<string, string> = new Map();
// NIT 9: an internal valve-expectation linkage id (a plain `text` attribute)
// with no friendly resolver and no user-meaningful label -- never render its
// raw opaque id on the confirm screen (mirrors DetailPanel's own omission).
const OMITTED_CONFIRM_VALUE_CODE = 'attr.actuation_expectation_id';

function localDefault(timezone: string, fallbackTimezone: string): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: fallbackTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  }
  const parts = formatter.formatToParts(new Date());
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}T${values.get('hour')}:${values.get('minute')}`;
}

function cropForPlot(
  plot: JournalPlot | undefined,
  zoneCrops: Readonly<Record<string, string>>,
): string {
  const zoneCrop = plot?.zone_uuid ? zoneCrops[plot.zone_uuid]?.trim() : '';
  return zoneCrop || plot?.crop_hint?.trim() || '';
}

function normalizedCropLabel(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en');
}

function canonicalCropValue(
  model: JournalCaptureCatalogModel | null,
  crop: string,
): string {
  const value = crop.trim();
  if (!value || !model) return '';
  const attribute = model.vocabByCode.get('attr.crop');
  if (attribute?.value_type !== 'choice') return value;

  const choices = [...model.vocabByCode.values()].filter((row) =>
    row.kind === 'choice' && row.parent_code === 'attr.crop' && row.active === 1 && !row.deleted_at);
  const exact = choices.find((row) => row.code === value);
  if (exact) return exact.code;
  const normalized = normalizedCropLabel(value);
  const matching = choices.filter((row) => Object.values(row.labels ?? {})
    .some((label) => normalizedCropLabel(label) === normalized));
  return matching.length === 1 ? matching[0].code : '';
}

function withCanonicalContextCrop(
  model: JournalCaptureCatalogModel | null,
  crop: string,
  values: CaptureEntryValueInput[],
): CaptureEntryValueInput[] {
  if (model?.vocabByCode.get('attr.crop')?.value_type !== 'choice') return values;
  const withoutCrop = values.filter((value) => value.attribute_code !== 'attr.crop');
  const cropValue = canonicalCropValue(model, crop);
  return cropValue
    ? [...withoutCrop, {
      attribute_code: 'attr.crop',
      value_status: 'observed',
      value: cropValue,
    }]
    : withoutCrop;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isCanonicalUuid(value: unknown): value is string {
  return isTrimmedNonEmpty(value) && CANONICAL_UUID.test(value);
}

function cloneFinalBatchPayload(payload: Parameters<typeof journalApi.createFinalBatch>[0]):
  Parameters<typeof journalApi.createFinalBatch>[0] {
  return {
    ...payload,
    // A pass batch's members each carry their own `values` (unlike a
    // cross-plot batch, where members never set it and share the top-level
    // array below) -- deep-clone that per-member array too so a cached
    // snapshot reused across retries never shares array identity with a
    // freshly-built payload.
    members: payload.members.map((member) => ({
      ...member,
      ...(member.values ? { values: member.values.map((value) => ({ ...value })) } : {}),
    })),
    values: payload.values.map((value) => ({ ...value })),
    ...(payload.duplicate_guard_ack_entry_uuids
      ? { duplicate_guard_ack_entry_uuids: [...payload.duplicate_guard_ack_entry_uuids] }
      : {}),
  };
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  return data && typeof data.error === 'string' ? data.error
    : data && typeof data.code === 'string' ? data.code
      : typeof error.code === 'string' ? error.code : null;
}

function isDuplicateValue(value: unknown): value is EntryAggregate['values'][number] {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.group_index) && Number(value.group_index) >= 0 &&
    isTrimmedNonEmpty(value.attribute_code) &&
    ['observed', 'not_observed', 'not_applicable', 'below_detection'].includes(String(value.value_status)) &&
    (value.value_num === null || typeof value.value_num === 'number' && Number.isFinite(value.value_num)) &&
    (value.value_text === null || typeof value.value_text === 'string') &&
    (value.unit_code === null || typeof value.unit_code === 'string') &&
    (value.entered_value_num === null || typeof value.entered_value_num === 'number' && Number.isFinite(value.entered_value_num)) &&
    (value.entered_unit_code === null || typeof value.entered_unit_code === 'string');
}

function duplicateValues(value: unknown): EntryAggregate['values'] {
  return Array.isArray(value) ? value.filter(isDuplicateValue) : [];
}

function duplicateFromEntry(value: unknown): DuplicateCandidate | null {
  if (!isRecord(value) || !isCanonicalUuid(value.entry_uuid) ||
      !isValidApiInstant(value.occurred_start) || !isTrimmedNonEmpty(value.activity_code)) return null;
  return {
    entry_uuid: value.entry_uuid,
    occurred_start: value.occurred_start,
    activity_code: value.activity_code,
    plot_uuid: typeof value.plot_uuid === 'string' ? value.plot_uuid : null,
    values: duplicateValues(value.values),
  };
}

function duplicateFromError(error: unknown): DuplicateCandidate | null {
  if (errorCode(error) !== 'duplicate_candidate' || !isRecord(error)) return null;
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  const directDetails = isRecord(error.details) ? error.details : null;
  const directCandidate = isRecord(error.duplicateCandidate)
    ? { duplicateCandidate: error.duplicateCandidate }
    : null;
  const responseDetails = data && isRecord(data.details) ? data.details : null;
  const details: Record<string, unknown> | null = directDetails ?? directCandidate ?? responseDetails;
  const candidate = details && isRecord(details.duplicateCandidate)
    ? details.duplicateCandidate
    : details && isRecord(details.duplicate_candidate) ? details.duplicate_candidate : null;
  if (!candidate || !isCanonicalUuid(candidate.entryUuid) ||
      !isValidApiInstant(candidate.occurredStart) || !isTrimmedNonEmpty(candidate.activityCode)) return null;
  return {
    entry_uuid: candidate.entryUuid,
    occurred_start: candidate.occurredStart,
    activity_code: candidate.activityCode,
    plot_uuid: typeof candidate.plotUuid === 'string' ? candidate.plotUuid : null,
    values: duplicateValues(candidate.values),
  };
}

function duplicateCandidatesFromError(error: unknown): DuplicateCandidate[] {
  if (errorCode(error) !== 'duplicate_candidates' || !isRecord(error)) return [];
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  const details = data && isRecord(data.details) ? data.details : null;
  if (!details || !Array.isArray(details.duplicateCandidates)) return [];
  const parsed: Array<DuplicateCandidate | null> = details.duplicateCandidates
    .map((candidate) => {
      if (!isRecord(candidate) || !isCanonicalUuid(candidate.entryUuid) ||
          !isValidApiInstant(candidate.occurredStart) || !isTrimmedNonEmpty(candidate.activityCode)) return null;
      return {
        entry_uuid: candidate.entryUuid,
        occurred_start: candidate.occurredStart,
        activity_code: candidate.activityCode,
        plot_uuid: typeof candidate.plotUuid === 'string' ? candidate.plotUuid : null,
        values: duplicateValues(candidate.values),
      } satisfies DuplicateCandidate;
    });
  return parsed.filter((candidate): candidate is DuplicateCandidate => candidate != null);
}

function localizedNumber(value: number, locale: string): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(locale).format(value) : String(value);
}

function localizedDate(value: string, locale: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

function displayValue(
  value: CaptureEntryValueOutput,
  model: JournalCaptureCatalogModel,
  locale: string,
  booleanLabels: { yes: string; no: string },
  products: readonly Pick<JournalProductRow, 'product_uuid' | 'name'>[],
  unknownProductLabel: string,
): string {
  // BUG 1: attr.product_uuid's value is a per-farm product UUID that is
  // never a model.vocabByCode entry (products are a separate registry, not
  // catalog choices), so it fell through every branch below and printed the
  // raw UUID. Resolve it via the products registry first, mirroring
  // tankMixProductLabel's own product_uuid -> name resolution.
  if (value.attribute_code === 'attr.product_uuid' && typeof value.value === 'string' && value.value) {
    return products.find((product) => product.product_uuid === value.value)?.name
      ?? unknownProductLabel;
  }
  const attribute = model.vocabByCode.get(value.attribute_code);
  if (value.entered_value_num != null) return attribute?.value_type === 'number'
    ? localizedNumber(value.entered_value_num, locale) : String(value.entered_value_num);
  if (value.value !== undefined && value.value !== null) {
    if (typeof value.value === 'string') {
      const choice = model.vocabByCode.get(value.value);
      if (choice) return catalogLabel(choice, locale);
    }
    if (attribute?.value_type === 'date' && typeof value.value === 'string') {
      return localizedDate(value.value, locale) ?? value.value;
    }
    if (attribute?.value_type === 'number' && typeof value.value === 'number') {
      return localizedNumber(value.value, locale);
    }
    if (attribute?.value_type === 'boolean' && typeof value.value === 'boolean') {
      return value.value ? booleanLabels.yes : booleanLabels.no;
    }
    return String(value.value);
  }
  if (value.value_num != null) return attribute?.value_type === 'number'
    ? localizedNumber(value.value_num, locale) : String(value.value_num);
  if (value.value_text != null) return attribute?.value_type === 'date'
    ? localizedDate(value.value_text, locale) ?? value.value_text : value.value_text;
  return '';
}

function occurrenceLabel(value: string, timezone: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: timezone,
  }).format(date);
}

// NIT 10: the batch-duplicate list already shows each candidate's occurrence
// date + activity (the human disambiguator) right beside this -- entry_uuid
// itself only needs to still read as a distinct, human-scannable tag for the
// rare case where two candidates in the same group land on the same
// occurrence label (e.g. rounded to the same displayed minute). A full raw
// UUID added nothing there; the last 8 characters are still enough to tell
// candidates apart without dumping an opaque id onto the screen.
function shortEntryId(entryUuid: string): string {
  return entryUuid.slice(-8);
}

function duplicateValueLabel(
  value: EntryAggregate['values'][number],
  model: JournalCaptureCatalogModel,
  locale: string,
): string {
  const attribute = model.vocabByCode.get(value.attribute_code);
  const label = attribute ? catalogLabel(attribute, locale) : value.attribute_code;
  const raw = value.value_text ?? value.entered_value_num ?? value.value_num;
  if (raw == null) return '';
  const displayRaw = attribute?.value_type === 'number' && typeof raw === 'number'
    ? localizedNumber(raw, locale)
    : attribute?.value_type === 'date' && typeof raw === 'string'
      ? localizedDate(raw, locale) ?? raw
      : String(raw);
  const unitCode = value.entered_unit_code ?? value.unit_code;
  const unit = unitCode ? model.vocabByCode.get(unitCode) : undefined;
  return `${label}: ${displayRaw}${unit ? ` ${catalogLabel(unit, locale)}` : ''}`;
}

// Slice F (F3, tank-mix): summarizes one queued pass member's product
// identity for the "Products in this pass" list. Mirrors
// RepeatTreatmentCard's disclosedValue product-name resolution (a
// product_uuid resolves via the catalog.products registry, not vocab —
// products are a separate registry, not catalog choices).
function tankMixProductLabel(
  values: readonly CaptureEntryValueOutput[],
  products: readonly Pick<JournalProductRow, 'product_uuid' | 'name'>[],
  unknownProductLabel: string,
): string {
  const registered = values.find((value) => value.attribute_code === 'attr.product_uuid');
  if (registered && typeof registered.value === 'string') {
    return products.find((product) => product.product_uuid === registered.value)?.name
      ?? unknownProductLabel;
  }
  const unregistered = values.find((value) => value.attribute_code === 'attr.product');
  if (unregistered && typeof unregistered.value === 'string' && unregistered.value) {
    return unregistered.value;
  }
  return unknownProductLabel;
}

function tankMixDoseLabel(
  values: readonly CaptureEntryValueOutput[],
  model: JournalCaptureCatalogModel,
  locale: string,
): string {
  const dose = values.find((value) =>
    value.attribute_code === 'attr.amount_mass_area_product' ||
    value.attribute_code === 'attr.amount_volume_area_product' ||
    value.attribute_code === 'attr.amount_biological_count_area');
  if (!dose || typeof dose.value_num !== 'number') return '';
  const unit = dose.unit_code ? model.vocabByCode.get(dose.unit_code) : undefined;
  return `${localizedNumber(dose.value_num, locale)}${unit ? ` ${catalogLabel(unit, locale)}` : ''}`;
}

const DETAIL_LEVEL_ORDER = ['farmer_quick', 'full_record', 'research_observation'];

// Effective capture template = the user's global detail-level preference when
// the plot's layout supports it, otherwise the layout's lowest supported
// template (U4: a researcher-only layout like agroscope_open_field floors a
// Quick user to Research). Slice A: detail level is chosen in Settings, never
// per entry.
function effectiveTemplateCode(supportedTemplates: string[], preferred: string): string {
  if (supportedTemplates.includes(preferred)) return preferred;
  const ordered = [...supportedTemplates].sort(
    (a, b) => DETAIL_LEVEL_ORDER.indexOf(a) - DETAIL_LEVEL_ORDER.indexOf(b),
  );
  return ordered[0] ?? '';
}

function activityDependencyInputs(leaf: ActivityLeafSelection | null): CaptureEntryValueInput[] {
  return leaf?.dependent_selections.map(({ attribute_code, value }) => ({
    attribute_code,
    value_status: 'observed' as const,
    value,
  })) ?? [];
}

// Slice BC (R1 Part 2): snapshot the plot's static-context values (carried
// from journal_plot_settings.context_json, read-only on the capture form —
// PlotContextFields stores number fields already canonicalized in the
// attribute's default unit, see PlotForm.tsx) onto the entry so record
// integrity survives a later plot-context edit. Unconditional — not gated on
// the template having quick_fields — but harmless for full_record/research:
// payloadValues below pushes this BEFORE formPayload, so a real typed edit to
// the same attribute (still possible there; it stays a normal editable field
// for those templates) always wins the same-key merge.
function plotContextInputs(
  model: JournalCaptureCatalogModel | null,
  layout: JournalLayoutDefinition | undefined,
  plot: JournalPlot | null,
): CaptureEntryValueInput[] {
  if (!model || !layout || !plot?.settings.context_json) return [];
  const parsed = parsePlotContextJson(plot.settings.context_json);
  const inputs: CaptureEntryValueInput[] = [];
  for (const code of layout.static_context_fields ?? []) {
    const raw = parsed[code];
    if (raw === undefined || raw === null || raw === '') continue;
    const attribute = model.vocabByCode.get(code);
    if (!attribute || attribute.kind !== 'attribute') continue;
    if (attribute.value_type === 'number') {
      if (typeof raw !== 'number' || !attribute.default_unit_code) continue;
      inputs.push({
        attribute_code: code,
        value_status: 'observed',
        entered_value_num: raw,
        entered_unit_code: attribute.default_unit_code,
      });
      continue;
    }
    inputs.push({ attribute_code: code, value_status: 'observed', value: raw });
  }
  return inputs;
}

function captureSelections(
  model: JournalCaptureCatalogModel | null,
  leaf: ActivityLeafSelection | null,
  crop: string,
): JournalSelections {
  const cropValue = canonicalCropValue(model, crop);
  return {
    activity_code: leaf?.activity_code,
    ...(leaf?.dependent_selections.reduce<Record<string, JournalScalar>>((result, selection) => ({
      ...result, [selection.attribute_code]: selection.value,
    }), {}) ?? {}),
    ...(cropValue ? { 'attr.crop': cropValue } : {}),
  };
}

function inputHasValue(input: CaptureEntryValueInput): boolean {
  if (input.value_status != null && input.value_status !== 'observed') return true;
  return input.value !== undefined && input.value !== null && input.value !== ''
    || input.value_text !== undefined && input.value_text !== null && input.value_text !== ''
    || input.entered_value_num !== undefined && input.entered_value_num !== null
    || input.value_num !== undefined && input.value_num !== null;
}

function carryForwardValueKey(value: CaptureEntryValueInput): string {
  return `${value.attribute_code}:${value.group_index ?? 0}`;
}

function sameCaptureValue(
  left: CaptureEntryValueInput,
  right: CaptureEntryValueInput,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableCaptureValueContent(value: Readonly<CaptureEntryValueInput>): string {
  return JSON.stringify([
    value.attribute_code,
    value.group_index ?? 0,
    value.value_status ?? null,
    value.value ?? null,
    value.value_num ?? null,
    value.value_text ?? null,
    value.unit_code ?? null,
    value.entered_value_num ?? null,
    value.entered_unit_code ?? null,
  ]);
}

function sameCandidateValues(
  left: ReadonlyArray<Readonly<CaptureEntryValueInput>>,
  right: ReadonlyArray<Readonly<CaptureEntryValueInput>>,
): boolean {
  if (left.length !== right.length) return false;
  const leftContent = left.map(stableCaptureValueContent).sort();
  const rightContent = right.map(stableCaptureValueContent).sort();
  return leftContent.every((value, index) => value === rightContent[index]);
}

function withoutUnchangedOwnedValues(
  values: CaptureEntryValueInput[],
  owned: Iterable<CaptureEntryValueInput>,
): CaptureEntryValueInput[] {
  const byKey = new Map(
    [...owned].map((value) => [carryForwardValueKey(value), value]),
  );
  return values.filter((value) => {
    const snapshot = byKey.get(carryForwardValueKey(value));
    return !snapshot || !sameCaptureValue(value, snapshot);
  });
}

// Treated-area-optional plan (2026-07-22, maintainer-confirmed): a plot that
// already has an area on file (journal_plots.area_m2) implies a routine
// full-plot entry, so attr.treated_area defaults from it -- visible in the
// editable input, not merely recorded read-only (attr.treated_area stays a
// normal editable field for every template; unlike plotContextInputs'
// static_context_fields, it is never force-required as of catalog v8, so
// this is a convenience default, not a correction-context snapshot). Same
// unit as area_m2 (m2), no conversion -- mirrors plotContextInputs' own
// number-attribute shape.
const TREATED_AREA_ATTRIBUTE_CODE = 'attr.treated_area';
const TREATED_AREA_UNIT_CODE = 'unit.m2_area';

function treatedAreaPrefillValue(
  plot: JournalPlot | null | undefined,
): CaptureEntryValueInput | null {
  const areaM2 = plot?.area_m2;
  if (typeof areaM2 !== 'number' || !Number.isFinite(areaM2)) return null;
  return {
    attribute_code: TREATED_AREA_ATTRIBUTE_CODE,
    value_status: 'observed',
    entered_value_num: areaM2,
    entered_unit_code: TREATED_AREA_UNIT_CODE,
  };
}

// Applies the plot-area default onto a values array and registers it as an
// "owned" automatic value in the supplied map, using the exact same
// ownership bookkeeping/pattern as automaticPrefillRef's carry-forward
// prefills (see withoutUnchangedOwnedValues above) -- but tracked in its own
// dedicated ref (treatedAreaOwnedRef, wired in the component below) rather
// than sharing automaticPrefillRef itself. Sharing that ref was tried first;
// it does not work here because applyCarryForwardCandidate unconditionally
// clears automaticPrefillRef and re-derives it from ONLY the recent-entry
// carry-forward candidate on every draft autosave (see updateStableDraft),
// which would silently drop an untouched treated_area default the moment the
// user advances past the details step -- before they ever get a chance to
// see it on the confirm screen. A dedicated ref keeps the exact same
// user-edit-wins / clear-and-reapply-on-plot-change semantics without that
// cross-feature collision.
//
// No-op (never clobbers) if treated_area is already present in
// candidateValues -- whether that's a kept user edit, a carry-forward value,
// or an already-applied plot default from a prior render of the same plot.
function withTreatedAreaPrefill(
  candidateValues: CaptureEntryValueInput[],
  plot: JournalPlot | null | undefined,
  ownedValues: Map<string, CaptureEntryValueInput>,
): CaptureEntryValueInput[] {
  if (candidateValues.some((value) => value.attribute_code === TREATED_AREA_ATTRIBUTE_CODE)) {
    return candidateValues;
  }
  const prefill = treatedAreaPrefillValue(plot);
  if (!prefill) return candidateValues;
  ownedValues.set(carryForwardValueKey(prefill), prefill);
  return [...candidateValues, prefill];
}

function requiredFieldsSatisfied(
  states: Array<{ code: string; visible: boolean; required: boolean; required_any_groups: number[] }>,
  inputs: CaptureEntryValueInput[],
): boolean {
  const hasValue = (code: string) => inputs.some((input) => input.attribute_code === code && inputHasValue(input));
  if (states.some((state) => state.visible && state.required && !hasValue(state.code))) return false;
  const groups = new Set(states.flatMap((state) => state.required_any_groups));
  return [...groups].every((group) => states.some((state) =>
    state.visible && state.required_any_groups.includes(group) && hasValue(state.code)));
}

function sanitizeValues(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition | undefined,
  template: JournalTemplateDefinition | undefined,
  leaf: ActivityLeafSelection | null,
  crop: string,
  values: CaptureEntryValueInput[],
  excludedCodes: ReadonlySet<string> = new Set(),
): CaptureEntryValueInput[] {
  if (!layout || !template) return [];
  const cropValue = canonicalCropValue(model, crop);
  const selections: JournalSelections = {
    activity_code: leaf?.activity_code,
    ...(leaf?.dependent_selections.reduce<Record<string, JournalScalar>>((result, selection) => ({
      ...result, [selection.attribute_code]: selection.value,
    }), {}) ?? {}),
    ...(cropValue ? { 'attr.crop': cropValue } : {}),
  };
  const fieldStates = deriveFieldStates(template, layout, selections);
  const visibleCodes = new Set(fieldStates.filter((state) => state.visible).map((state) => state.code));
  const dependencyCodes = new Set(leaf?.dependent_selections.map(({ attribute_code }) => attribute_code) ?? []);
  const choiceTargets = new Set(layout.option_dependencies
    .filter(({ restrict }) => 'choices' in restrict)
    .map(({ restrict }) => restrict.attribute_code));
  const unitTargets = new Set(layout.option_dependencies
    .filter(({ restrict }) => 'units' in restrict)
    .map(({ restrict }) => restrict.attribute_code));
  return values.filter((input) => {
    if (excludedCodes.has(input.attribute_code) ||
        (!visibleCodes.has(input.attribute_code) && !dependencyCodes.has(input.attribute_code))) return false;
    const attribute = model.vocabByCode.get(input.attribute_code);
    if (!attribute || input.value_status != null && input.value_status !== 'observed') return true;
    const selection = input.value ?? input.value_text;
    if (attribute.value_type === 'choice' && typeof selection === 'string') {
      const choices = allowedChoices(model, layout, input.attribute_code, selections);
      if ((choiceTargets.has(input.attribute_code) || choices.length > 0) &&
          !choices.includes(selection)) return false;
    }
    if (attribute.value_type === 'number') {
      const unit = input.entered_unit_code ?? input.unit_code;
      const units = allowedUnits(model, layout, input.attribute_code, selections);
      if (unit != null && (unitTargets.has(input.attribute_code) || units.length > 0) &&
          !units.includes(unit)) return false;
    }
    return true;
  });
}

// Task 32 follow-up fix: computeLayoutTransitionDiff is intentionally pure
// and returns [] when the target layout is undefined (there's nothing to
// diff *against*) — see layoutTransition.ts. But an empty/"No plot" target is
// itself a real transition that hides every field a value was entered under,
// and the "never silently sanitize a user-entered value" contract applies to
// it just the same. Mirrors computeLayoutTransitionDiff's field_hidden branch
// (same hasEnteredValue/attribute-kind filtering as `inputHasValue` below),
// but every currently-entered value counts as hidden by definition since
// there is no layout left for anything to be visible under.
function fieldHiddenForEmptyTarget(
  values: readonly CaptureEntryValueInput[],
  model: JournalCaptureCatalogModel,
): LayoutTransitionAffectedItem[] {
  const items: LayoutTransitionAffectedItem[] = [];
  for (const value of values) {
    if (!inputHasValue(value)) continue;
    const attribute = model.vocabByCode.get(value.attribute_code);
    if (!attribute || attribute.kind !== 'attribute') continue;
    items.push({
      attribute_code: value.attribute_code,
      group_index: value.group_index ?? 0,
      reason: 'field_hidden',
      value,
    });
  }
  return items;
}

export const JournalCaptureFlow: React.FC<JournalCaptureFlowProps> = ({
  catalog,
  plots,
  plotGroups,
  initialPlot,
  recentEntries,
  initialTimezone,
  zoneCrops = {},
  zoneTimezones = {},
  plotState,
  groupState,
  onClose,
  onOpenExisting,
  onSaved,
  onRetryCatalog,
}) => {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const modelResult = useMemo(() => buildCatalogModel(catalog), [catalog]);
  const model = modelResult.ok ? modelResult.model : null;
  const { journalDetailLevel } = useDisplayPreferences();
  const usableInitialPlot = initialPlot && initialPlot.active === 1 && initialPlot.deleted_at === null
    ? initialPlot
    : undefined;
  const [step, setStep] = useState<CaptureStep>(usableInitialPlot ? 'activity' : 'where');
  const [selectedPlotUuids, setSelectedPlotUuids] = useState<string[]>(
    usableInitialPlot ? [usableInitialPlot.plot_uuid] : [],
  );
  const [layoutCode, setLayoutCode] = useState(usableInitialPlot?.settings.layout_code ?? '');
  const [templateCode, setTemplateCode] = useState(() => {
    const initialLayout = model?.layouts.get(usableInitialPlot?.settings.layout_code ?? '');
    return initialLayout
      ? effectiveTemplateCode(initialLayout.supported_templates, journalDetailLevel)
      : journalDetailLevel;
  });
  const [leaf, setLeaf] = useState<ActivityLeafSelection | null>(null);
  const initialCrop = cropForPlot(usableInitialPlot, zoneCrops);
  const [crop, setCrop] = useState(initialCrop);
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const effectiveInitialTimezone = initialTimezone ?? browserTimezone;
  const [timezone, setTimezone] = useState(effectiveInitialTimezone);
  const [occurredLocal, setOccurredLocal] = useState(() =>
    localDefault(effectiveInitialTimezone, browserTimezone));
  const [occurredEndLocal, setOccurredEndLocal] = useState('');
  const [utcOffset, setUtcOffset] = useState<number | null>(null);
  const [endUtcOffset, setEndUtcOffset] = useState<number | null>(null);
  const [resolved, setResolved] = useState<ResolvedOccurrence | null>(null);
  const [endResolved, setEndResolved] = useState<ResolvedOccurrence | null>(null);
  const resolvedRef = useRef<ResolvedOccurrence | null>(null);
  const endResolvedRef = useRef<ResolvedOccurrence | null>(null);
  const [occurrenceError, setOccurrenceError] = useState<OccurrenceResolutionError | null>(null);
  const [endOccurrenceError, setEndOccurrenceError] = useState<OccurrenceResolutionError | null>(null);
  const [values, setValues] = useState<CaptureEntryValueInput[]>(() =>
    withCanonicalContextCrop(model, initialCrop, []));
  const [formPayload, setFormPayload] = useState<CaptureEntryValueOutput[]>([]);
  const [formValid, setFormValid] = useState(true);
  const [numberInputErrors, setNumberInputErrors] = useState<ReadonlyMap<string, string>>(
    EMPTY_NUMBER_INPUT_ERRORS,
  );
  const [showValidation, setShowValidation] = useState(false);
  const [whereError, setWhereError] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [shortlist, setShortlist] = useState<ActivityShortlist>(() => ({
    plotRecent: [], seasonCommon: [], farmRecent: [], currentSeasonUuid: null,
  }));
  const [duplicateCandidate, setDuplicateCandidate] = useState<DuplicateCandidate | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[]>([]);
  const [duplicateAckEntryUuids, setDuplicateAckEntryUuids] = useState<string[]>([]);
  const [duplicateAck, setDuplicateAck] = useState<string | null>(null);
  const [duplicateInFlight, setDuplicateInFlight] = useState(false);
  const [duplicateWarningShown, setDuplicateWarningShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [carryForwardCandidate, setCarryForwardCandidate] = useState<CarryForwardCandidate | null>(null);
  const [acceptedRepeat, setAcceptedRepeat] = useState<AcceptedRepeatSnapshot | null>(null);
  const [safePrefill, setSafePrefill] = useState<CaptureEntryValueInput[]>([]);
  const [stickyLossWarning, setStickyLossWarning] = useState(false);
  const [finalReceipt, setFinalReceipt] = useState<JournalSavedReceipt | null>(null);
  const [receiptHarvestGroups, setReceiptHarvestGroups] = useState<PlotGroup[]>([]);
  const [groupResolutionErrors, setGroupResolutionErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [plotEditor, setPlotEditor] = useState<{ mode: 'create' | 'update'; plot?: JournalPlot } | null>(null);
  const [preparingConfirm, setPreparingConfirm] = useState(false);
  const [batchAttemptPending, setBatchAttemptPending] = useState(false);
  // Slice F (F3, tank-mix): "Add product to this pass" queues the current
  // form's product-family values (TANK_MIX_PRODUCT_FIELD_CODES) as a linked
  // pass member and clears them so the next product can be entered. All
  // members (including the entry the user is currently editing, which
  // becomes the pass's primary/first entry at Save) share one `passUuid`
  // (P8's existing pass_uuid mechanism) — not a new table. Single-plot only:
  // a pass links different operations/products on the SAME plot, orthogonal
  // to the multi-plot batch mechanism.
  //
  // B1/B2 fix: the primary AND every queued member are finalized together
  // as ONE atomic pass batch (buildPassBatchInput/finalizeBatch below,
  // sharing the exact same saving/error/retry machinery the multi-plot
  // batch already has) rather than the primary via a normal finalize
  // followed by a loop of separate creates — see finalizeBatch's isTankMixPass
  // branch and buildTankMixPassBatchPayload's doc comment for why.
  const [passUuid, setPassUuid] = useState<string | null>(null);
  const [passMembers, setPassMembers] = useState<
    Array<{ id: string; entryUuid: string; values: CaptureEntryValueOutput[] }>
  >([]);
  // Slice D Phase 3 (crop-cycle GUI, D3.1-D3.4b): `variety` is the seeding-
  // only counterpart to the existing `crop` state (D3.1) — both are injected
  // into payloadValues below the same way. `cycleAction` answers the D3.2
  // same-crop reseed prompt; `endsCropCycle` is the D3.4b manual-close
  // toggle. `cycleUuid` disambiguates an intercropped plot (R7) and is only
  // ever set reactively, after the edge refuses a save with
  // cycle_uuid_required/cycle_not_found (see cycleDisambiguationOptions
  // below) — never guessed proactively.
  const [variety, setVariety] = useState('');
  const [cycleAction, setCycleAction] = useState<'continue' | 'new' | null>(null);
  const [endsCropCycle, setEndsCropCycle] = useState(false);
  const [cycleUuid, setCycleUuid] = useState<string | null>(null);
  const [cycleDisambiguationOptions, setCycleDisambiguationOptions] = useState<CycleOption[] | null>(null);
  const [pendingCycleRetry, setPendingCycleRetry] = useState(false);
  // Layout-transition review gate (Task 32): values a plot/layout switch would
  // otherwise silently sanitize away (a hidden field, an invalid choice) sit
  // here pending explicit user resolution instead. Never mutated directly.
  const [pendingTransitionItems, setPendingTransitionItems] = useState<LayoutTransitionAffectedItem[]>([]);
  const [keptTransitionValues, setKeptTransitionValues] = useState<CaptureEntryValueInput[]>([]);
  const [transitionSheetOpen, setTransitionSheetOpen] = useState(false);
  // An empty ("No plot") target is itself a transition that can hide every
  // field a value was entered under, and PlotPicker routes a plot-A -> plot-B
  // switch across different layouts through exactly that empty step (it
  // forbids co-selecting plots of different layouts, so the farmer must
  // deselect A before picking B). By the time B is picked, `layout`/`leaf`
  // component state has already been reset to nothing by the empty step, so
  // the closure values alone can no longer supply the diff's "old" side. This
  // ref remembers the last *real* layout/leaf a value was entered under so
  // the eventual real-to-real diff (e.g. greenhouse -> open_field) still
  // fires correctly across the empty step instead of comparing against
  // `undefined` and silently losing the transition a second time.
  const lastRealDiffContextRef = useRef<{
    layout: JournalLayoutDefinition;
    leaf: ActivityLeafSelection | null;
  } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const savedCallbackFiredRef = useRef(false);
  const closeStartedRef = useRef(false);
  const closePromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const preparationTokenRef = useRef(0);
  const batchPayloadSnapshotRef = useRef<Parameters<typeof journalApi.createFinalBatch>[0] | null>(null);
  const batchEntryUuidsRef = useRef(new Map<string, string>());
  const contextKeyRef = useRef('');
  const automaticPrefillRef = useRef(new Map<string, CaptureEntryValueInput>());
  // Dedicated ownership map for the plot-area treated_area default -- see
  // withTreatedAreaPrefill's comment above for why this is not folded into
  // automaticPrefillRef.
  const treatedAreaOwnedRef = useRef(new Map<string, CaptureEntryValueInput>());
  const acceptedRepeatRef = useRef<AcceptedRepeatSnapshot | null>(null);
  const prefillContextRef = useRef<string | null>(null);

  const selectedPlotUuid = selectedPlotUuids.length === 1 ? selectedPlotUuids[0] : '';
  const selectedPlot = plots.find(({ plot_uuid: uuid, active, deleted_at }) =>
    uuid === selectedPlotUuid && active === 1 && deleted_at === null) ?? null;
  const selectedPlots = selectedPlotUuids
    .map((uuid) => plots.find((plot) => plot.plot_uuid === uuid))
    .filter((plot): plot is JournalPlot => plot != null && plot.active === 1 && plot.deleted_at === null);
  const duplicateCandidateGroups = useMemo<DuplicateCandidateGroup[]>(() => {
    const groups = new Map<string, DuplicateCandidateGroup>();
    duplicateCandidates.forEach((candidate) => {
      const key = candidate.plot_uuid ?? '__farm__';
      const plot = plots.find(({ plot_uuid: plotUuid, active, deleted_at }) =>
        plotUuid === candidate.plot_uuid && active === 1 && deleted_at === null);
      const label = plot?.name?.trim() || plot?.plot_code || t('capture.confirm.farmLevel');
      const group = groups.get(key);
      if (group) {
        group.candidates.push(candidate);
      } else {
        groups.set(key, { key, label, candidates: [candidate] });
      }
    });
    return [...groups.values()];
  }, [duplicateCandidates, plots, t]);
  const isMultiPlot = selectedPlotUuids.length > 1;
  const zoneLinked = Boolean(selectedPlot?.zone_uuid);
  // B3 fix (Slice F): whether the selected plot's zone actually has a
  // weather-capable device assigned (osi-journal/api.js's
  // zoneHasWeatherSource, resolved into JournalPlot.zone_has_weather_source
  // the same additive way active_crop_cycles was). This is NOT the same
  // fact as zoneLinked above: a zone-linked plot whose zone has only soil
  // sensors (no weather station) must still show the manual
  // wind/temp/humidity group, so this is kept as its own variable rather
  // than folded into zoneLinked, which stays used for its other,
  // zone-uuid-only purposes (crop-hint fallback, shortlist scoping, etc.).
  const hasWeatherSource = Boolean(selectedPlot?.zone_has_weather_source);
  // Slice F (F3): tank-mix ("add product to this pass") is only offered for
  // a single-plot plant-protection entry — see the passUuid/passMembers
  // state doc comment above.
  const isTankMixEligible = !isMultiPlot && leaf?.activity_code === 'plant_protection_application';
  // B1/B2 fix: true only once there is an actual PASS to finalize atomically
  // (a primary plus at least one queued product) — a lone product with no
  // queued siblings is just a normal single-entry finalize, unmodified.
  const isTankMixPass = isTankMixEligible && passMembers.length > 0;
  const layout: JournalLayoutDefinition | undefined = model?.layouts.get(layoutCode);
  const templates = useMemo(() => {
    if (!model || !layout) return [];
    return layout.supported_templates
      .map((code) => model.templates.get(code))
      .filter((template): template is NonNullable<typeof template> => template != null)
      .sort((left, right) => {
        const order = ['farmer_quick', 'full_record', 'research_observation'];
        return order.indexOf(left.code) - order.indexOf(right.code) || left.code.localeCompare(right.code);
      });
  }, [layout, model]);
  const template = templates.find((candidate) => candidate.code === templateCode) ?? templates[0];
  const carryForwardLabels = useMemo(() => ({
    productLabels: new Map(catalog.products.map((product) => [product.product_uuid, product.name])),
    unitLabels: new Map(
      catalog.vocab
        .filter((row) => row.kind === 'unit')
        .map((row) => [row.code, catalogLabel(row, locale)]),
    ),
  }), [catalog.products, catalog.vocab, locale]);
  const fallbackLeaves = useMemo(
    () => model && layout ? deriveActivityLeaves(model, layout) : [],
    [layout, model],
  );
  const cropValue = useMemo(() => canonicalCropValue(model, crop), [crop, model]);
  const selections = useMemo<JournalSelections>(
    () => captureSelections(model, leaf, crop),
    [crop, leaf, model],
  );
  const fieldStates = useMemo(() => {
    const base = model && layout && template && leaf
      ? deriveFieldStates(template, layout, selections)
      : [];
    // B3 fix (Slice F, F2): hide the manual weather-at-application group
    // only when the plot's zone actually HAS a weather-capable device
    // (hasWeatherSource) — see withWeatherAtApplicationVisibility
    // (catalogModel.ts). A no-op for every activity other than
    // plant_protection_application, since no other activity's definition
    // ever declares these codes.
    return withWeatherAtApplicationVisibility(base, hasWeatherSource);
  }, [hasWeatherSource, layout, leaf, model, selections, template]);
  const formOwnsCrop = fieldStates.some((state) => state.code === 'attr.crop' && state.visible);
  // Slice D Phase 3: crop-cycle GUI derived state (see journal/cropCycle.ts
  // for the rationale behind each best-effort/reasoned signal).
  const isSeedingLeaf = Boolean(leaf && SEEDING_ACTIVITY_CODES.has(leaf.activity_code));
  const isManualCloseLeaf = Boolean(leaf && MANUAL_CLOSE_ACTIVITY_CODES.has(leaf.activity_code));
  const isHarvestLeaf = Boolean(leaf && leaf.activity_code === 'harvest');
  // Slice D hardening (P1-a/P1-b/P2-b): the open crop cycle covering the
  // SINGLE selected plot, read directly from the plot's own AUTHORITATIVE
  // active_crop_cycles (osi-journal/api.js listPlots via journal/cropCycle.ts
  // currentCropInfoForPlot) -- already loaded with `plots`, no fetch needed.
  // This is deliberately synchronous (no useEffect/useState): it must be
  // available the instant a plot is selected, before any activity is even
  // chosen, so the Where-step crop requirement (below) can consult it.
  const openCropCycleInfo: CurrentCropInfo | null = !isMultiPlot && selectedPlot
    ? currentCropInfoForPlot(selectedPlot.active_crop_cycles)
    : null;
  // D3.2 (review fix, B1): an open cycle already covering EACH target plot,
  // one entry per selected plot that has a single resolvable covering crop.
  // Collected across ALL selected plots, not just the first that resolves —
  // a same-crop+variety match on ANY plot (not only the first) must make the
  // continue/new prompt load-bearing, otherwise a multi-plot seeding can
  // silently merge into a non-first plot's open cycle with no cycle_action
  // sent at all. An intercropped plot (>1 open cycle) legitimately yields no
  // entry here (currentCropInfoForPlot returns null) and falls through to the
  // reactive cycle_uuid_required disambiguation instead.
  const seedingOverlaps: readonly CropCycleOverlap[] = isSeedingLeaf
    ? selectedPlots
        .map((plot) => currentCropInfoForPlot(plot.active_crop_cycles))
        .filter((info): info is CurrentCropInfo => info != null)
        .map((info) => ({ crop_code: info.crop_code, variety: info.variety }))
    : [];
  // The real catalog's farmer_quick@3 quick_fields DOES declare attr.crop for
  // seeding/planting_transplanting (journal-catalog-core.js), so formOwnsCrop
  // is true there and EntryForm already renders its own attr.crop choice
  // control bound through `values`/`formPayload`. SeedingCropFields must
  // never show a SECOND, independently-stated crop control in that case —
  // review fix: it previously always rendered its own dropdown bound to the
  // separate `crop` state, which payloadValues (below) never actually
  // persisted when formOwnsCrop is true (`if (cropValue && !formOwnsCrop)`),
  // so the visibly-selected crop silently diverged from the saved one.
  // effectiveSeedingCrop reads whichever path is authoritative for THIS
  // template/layout, so cycle detection/validation/variety-suggestions
  // always agree with what actually gets submitted.
  const formCropValue = useMemo(() => {
    if (!formOwnsCrop) return '';
    const match = values.find((value) => value.attribute_code === 'attr.crop');
    return typeof match?.value === 'string' ? match.value : '';
  }, [formOwnsCrop, values]);
  const effectiveSeedingCrop = formOwnsCrop ? formCropValue : cropValue;
  const varietySuggestions = useMemo(
    () => varietySuggestionsFor(effectiveSeedingCrop, recentEntries),
    [effectiveSeedingCrop, recentEntries],
  );
  // D3.2 (R4, review fix B1): the same-crop reseed prompt is load-bearing
  // when the crop+variety being entered EXACTLY matches an open cycle
  // already covering ANY target plot — a differing crop/variety always
  // auto-reseeds server-side regardless of cycle_action, so no
  // prompt/gating applies there. `matchingSeedingOverlap` also doubles as
  // the single overlap SeedingCropFields' prompt needs (its own
  // "overlapping" check is redundant with this one but harmless: at most one
  // element of seedingOverlaps can match a given crop+variety pair at a
  // time).
  const matchingSeedingOverlap = seedingOverlaps.find((overlap) =>
    overlap.crop_code === effectiveSeedingCrop && (overlap.variety ?? '') === variety.trim()) ?? null;
  const cycleActionRequired = isSeedingLeaf && matchingSeedingOverlap != null;
  // seedingOverlaps is now a synchronous read of already-loaded plot data
  // (no fetch, see openCropCycleInfo/seedingOverlaps above), so there is no
  // in-flight window to gate on here any more.
  const cycleActionSatisfied = !isSeedingLeaf || !cycleActionRequired || cycleAction != null;
  // D3.3 (P1-b, Slice D hardening): the inherited-crop banner's content for
  // the single selected plot, gated on an OPEN covering cycle as-of today
  // (not merely "some past entry recorded a crop") — see
  // journal/cropCycle.ts currentCropInfoForPlot's module doc comment for why
  // entries' season_crop alone can never answer this correctly. Never shown
  // for a seeding activity (SeedingCropFields owns the crop there instead).
  const bannerInfo: CurrentCropInfo | null = !isSeedingLeaf ? openCropCycleInfo : null;
  const cropCycleLabel = useCallback((cropCode: string, variety: string | null): string => {
    const row = model?.vocabByCode.get(cropCode);
    const label = row ? catalogLabel(row, locale) : cropCode;
    return variety ? `${label} · ${variety}` : label;
  }, [locale, model]);
  // P2-b (Slice D hardening): harvest, a checked manual-close, and a
  // differing-crop reseed all close an existing open cycle server-side (see
  // osi-journal/lifecycle.js applyHarvestCycleEffect/
  // applyManualCloseCycleEffect/applySeedingCycleEffect) — surface which
  // crop(s) that will be, across every selected plot, as a confirmation
  // before the farmer saves. A same-crop-and-variety seeding is deliberately
  // excluded here: that is the D3.2 continue/new prompt's job, not a close.
  const closingCropCycles: readonly CropCycleOverlap[] = (() => {
    const dedupe = (candidates: readonly CropCycleOverlap[]): CropCycleOverlap[] => {
      const seen = new Set<string>();
      return candidates.filter((candidate) => {
        const key = `${candidate.crop_code}:${candidate.variety ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    if (isHarvestLeaf || (isManualCloseLeaf && endsCropCycle)) {
      return dedupe(selectedPlots
        .map((plot) => currentCropInfoForPlot(plot.active_crop_cycles))
        .filter((info): info is CurrentCropInfo => info != null)
        .map((info) => ({ crop_code: info.crop_code, variety: info.variety })));
    }
    if (isSeedingLeaf && effectiveSeedingCrop) {
      const trimmedVariety = variety.trim();
      return dedupe(seedingOverlaps
        .filter((overlap) => !(overlap.crop_code === effectiveSeedingCrop && (overlap.variety ?? '') === trimmedVariety)));
    }
    return [];
  })();
  // Slice BC (R1 Part 2): read-only plot-context display for the Quick
  // template only — full_record/research still render these as normal
  // editable EntryForm fields (unchanged by this slice), so a redundant
  // read-only echo there would just be confusing duplication.
  const plotContextDisplay = useMemo(() => {
    if (!model || !layout || !template?.quick_fields) return [];
    const fieldCodes = layout.static_context_fields ?? [];
    if (fieldCodes.length === 0) return [];
    const parsed = parsePlotContextJson(selectedPlot?.settings.context_json);
    const entries: { code: string; label: string; value: string }[] = [];
    for (const code of fieldCodes) {
      const raw = parsed[code];
      if (raw === undefined || raw === null || raw === '') continue;
      const attribute = model.vocabByCode.get(code);
      if (!attribute) continue;
      const label = catalogLabel(attribute, locale);
      let displayValue: string;
      if (attribute.value_type === 'choice' && typeof raw === 'string') {
        const choice = model.vocabByCode.get(raw);
        displayValue = choice ? catalogLabel(choice, locale) : raw;
      } else if (attribute.value_type === 'number' && typeof raw === 'number') {
        const unit = attribute.default_unit_code ? model.vocabByCode.get(attribute.default_unit_code) : undefined;
        displayValue = unit ? `${localizedNumber(raw, locale)} ${catalogLabel(unit, locale)}` : localizedNumber(raw, locale);
      } else if (attribute.value_type === 'boolean' && typeof raw === 'boolean') {
        displayValue = raw ? t('capture.form.booleanYes') : t('capture.form.booleanNo');
      } else {
        displayValue = String(raw);
      }
      entries.push({ code, label, value: displayValue });
    }
    return entries;
  }, [layout, locale, model, selectedPlot, t, template]);
  const payloadValues = useMemo(() => {
    const combined: CaptureEntryValueOutput[] = [];
    if (cropValue && !formOwnsCrop) {
      combined.push({
        attribute_code: 'attr.crop',
        value_status: 'observed',
        value: cropValue,
      });
    }
    // D3.1: attr.variety has no visible_if rule in any template/layout (it is
    // never form-owned — see journal-catalog-core.js, attr.variety is
    // registered but absent from every quick_fields/activity_requirements/
    // conditional_groups entry), so it is injected the same way attr.crop is
    // above whenever this is a seeding activity with a variety entered.
    const trimmedVariety = variety.trim();
    if (isSeedingLeaf && trimmedVariety) {
      combined.push({
        attribute_code: 'attr.variety',
        value_status: 'observed',
        value: trimmedVariety,
      });
    }
    if (model && leaf) {
      try {
        combined.push(...buildEntryValues(model, activityDependencyInputs(leaf))
          .filter((value) => !formOwnsCrop || value.attribute_code !== 'attr.crop'));
      } catch {
        // The catalog model already failed closed; the form remains the visible validation seam.
      }
    }
    if (model && keptTransitionValues.length > 0) {
      try {
        // Kept-under-the-old-setting values (Task 32) bypass the current layout's
        // visibility/choice filtering by design — the user explicitly chose to
        // preserve them rather than lose them silently.
        combined.push(...buildEntryValues(model, keptTransitionValues));
      } catch {
        // A kept value that no longer resolves against the catalog is left out of
        // the payload rather than corrupting it; it stays visible via the review
        // state only, never silently reintroduced.
      }
    }
    if (model && layout) {
      try {
        // Pushed before formPayload so a real typed edit to the same
        // attribute (full_record/research, where these stay normal editable
        // fields) always wins the same-key merge below.
        combined.push(...buildEntryValues(model, plotContextInputs(model, layout, selectedPlot)));
      } catch {
        // A stale/malformed plot-context snapshot must never corrupt the
        // payload; leave it out rather than surface a confusing form error
        // for a value the user never typed.
      }
    }
    combined.push(...formPayload);
    const valuesByKey = new Map<string, CaptureEntryValueOutput>();
    for (const value of combined) {
      valuesByKey.set(`${value.attribute_code}:${value.group_index ?? 0}`, value);
    }
    return [...valuesByKey.values()];
  }, [cropValue, formOwnsCrop, formPayload, isSeedingLeaf, keptTransitionValues, layout, leaf, model, selectedPlot, variety]);
  const validateTransition = useCallback((
    nextLayout: JournalLayoutDefinition | undefined,
    nextTemplate: JournalTemplateDefinition | undefined,
    nextLeaf: ActivityLeafSelection | null,
    nextCrop: string,
    nextValues: CaptureEntryValueInput[],
    inputErrors: ReadonlyMap<string, string> = EMPTY_NUMBER_INPUT_ERRORS,
  ) => {
    if (!model || !nextLayout || !nextTemplate) {
      return {
        valid: false,
        payload: [] as CaptureEntryValueOutput[],
        errors: new Map<string, string>(),
        numberInputErrors: EMPTY_NUMBER_INPUT_ERRORS,
      };
    }
    const nextSelections = captureSelections(model, nextLeaf, nextCrop);
    return validateEntryForm({
      model,
      layout: nextLayout,
      fieldStates: deriveFieldStates(nextTemplate, nextLayout, nextSelections),
      inputs: nextValues,
      selections: nextSelections,
      numberInputErrors: inputErrors,
      products: catalog.products,
      t,
    });
  }, [catalog.products, model, t]);

  const draft = useCaptureDraft();
  const interactionLocked = preparingConfirm || saving || Boolean(finalReceipt) || batchAttemptPending;
  // B1/B2 fix: draft.status tracks the PRIMARY's own autosave lifecycle,
  // which is entirely separate from a batch/pass finalize attempt (both go
  // through journalApi.createFinalBatch, never draft.finish) — so a failed
  // batch or pass leaves draft.status exactly where it already was (e.g.
  // 'draft-saved-gateway', once the single-plot draft-autosave that runs on
  // the way to 'confirm' has succeeded), which would otherwise silently
  // hide SaveState's retry button (it only offers retry when
  // status === 'not-saved'). Override to 'not-saved' whenever a batch/pass
  // attempt has failed (stickyLossWarning, with no successful finalReceipt
  // yet) so the retry button is always available to resend the whole
  // failed attempt as a whole.
  const saveStateStatus: CaptureSaveState = finalReceipt
    ? 'final-saved-gateway'
    : (isMultiPlot || isTankMixPass) && stickyLossWarning
      ? 'not-saved'
      : draft.status;
  const closeLocked = preparingConfirm || saving || batchAttemptPending;

  const prefillContext = JSON.stringify({
    plot: selectedPlotUuid,
    crop,
    activity: leaf,
    layout: layout ? [layout.code, layout.version] : null,
    template: template ? [template.code, template.version] : null,
    occurredLocal,
    occurredEndLocal,
    timezone,
  });
  const attemptContext = JSON.stringify({ prefillContext, values });
  contextKeyRef.current = attemptContext;

  useEffect(() => {
    mountedRef.current = true;
    headingRef.current?.focus();
    return () => {
      mountedRef.current = false;
      preparationTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (draft.lossWarning) setStickyLossWarning(true);
  }, [draft.lossWarning]);

  const inferredCrop = useMemo(() => {
    if (crop.trim()) return crop.trim();
    // A sensorless plot has no authoritative season snapshot to fall back to
    // — EXCEPT (P1-a, Slice D hardening) an open crop cycle already covering
    // it: that IS authoritative (see openCropCycleInfo above), and asking
    // the farmer to re-type a crop the app already has via the cycle is
    // exactly the bug this fixes. Only a genuinely cycle-less sensorless
    // plot still requires the user to provide the context.
    //
    // B2 (pre-deploy review, crop-history integrity): openCropCycleInfo is
    // resolved by the edge "as of today" (osi-journal/lifecycle.js
    // activeCropCyclesForPlot), not as of THIS entry's occurred date. Auto-
    // inheriting it unconditionally would mislabel a backdated entry logged
    // before the open cycle even started — resolveSeason has no way to tell
    // that crop came from "today", not the entry's own date, and stamps it
    // permanently via its explicit-crop tier. Gate the inheritance on the
    // occurred local date falling within the open cycle's span: an open
    // cycle has no end, so ">= seededDate" is the whole test. A backdated
    // entry before that date falls through to '' (explicit-crop-required),
    // exactly like a genuinely cycle-less plot.
    if (selectedPlot && !zoneLinked) {
      const occurredLocalDate = occurredLocal.slice(0, 10);
      if (openCropCycleInfo && occurredLocalDate >= openCropCycleInfo.seededDate) {
        return openCropCycleInfo.crop_code;
      }
      return '';
    }
    const source = recentEntries
      .filter((entry) => entry.plot_uuid === selectedPlotUuid && entry.season_uuid && entry.season_crop)
      .sort((left, right) => Date.parse(right.occurred_start) - Date.parse(left.occurred_start))[0];
    return source?.season_crop?.trim() ?? '';
  }, [crop, occurredLocal, openCropCycleInfo, recentEntries, selectedPlot, selectedPlotUuid, zoneLinked]);

  // Slice D Phase 3: the three cascade-control fields osi-journal/
  // lifecycle.js reads directly off the create/correct entry body (see
  // types/journal.ts's JournalEntryWriteFields doc comment). Shared between
  // the single-entry and batch payload builders below since a batch shares
  // one activity/cascade context across all its member plots.
  const cycleCascadeFields = useCallback((): Pick<
    CreateEntryPayload, 'cycle_action' | 'cycle_uuid' | 'ends_crop_cycle'
  > => ({
    ...(isSeedingLeaf && cycleAction ? { cycle_action: cycleAction } : {}),
    ...(cycleUuid ? { cycle_uuid: cycleUuid } : {}),
    ...(isManualCloseLeaf && endsCropCycle ? { ends_crop_cycle: true } : {}),
  }), [cycleAction, cycleUuid, endsCropCycle, isManualCloseLeaf, isSeedingLeaf]);

  const buildPayload = useCallback((status: 'draft' | 'final', ack?: string | null): CreateEntryPayload => ({
    entry_uuid: draft.entryUuid ?? undefined,
    base_sync_version: 0,
    status,
    plot_uuid: selectedPlot?.plot_uuid ?? null,
    zone_uuid: selectedPlot?.zone_uuid ?? null,
    season_crop: inferredCrop || null,
    activity_code: leaf?.activity_code ?? '',
    template_code: template?.code ?? '',
    template_version: template?.version ?? 0,
    layout_code: layout?.code ?? '',
    layout_version: layout?.version ?? 0,
    occurred_start_local: occurredLocal,
    occurred_end_local: occurredEndLocal || null,
    occurred_timezone: timezone,
    occurred_utc_offset_minutes: resolvedRef.current?.offsetMinutes ?? resolved?.offsetMinutes ?? utcOffset,
    occurred_end_utc_offset_minutes: endResolvedRef.current?.offsetMinutes ?? endResolved?.offsetMinutes ?? endUtcOffset,
    duplicate_guard_ack_entry_uuid: ack ?? null,
    // Slice F (F3, tank-mix): this payload is only ever actually SENT (via
    // draft.finish/draft autosave) when there is no real pass to finalize
    // atomically (isTankMixPass false) — see finalize() below. It still
    // carries pass_uuid so the continuous draft autosave keeps recording it
    // as metadata while the user is mid-pass, before any queued sibling
    // exists yet.
    ...(passUuid ? { pass_uuid: passUuid } : {}),
    values: payloadValues,
    ...cycleCascadeFields(),
  }), [cycleCascadeFields, draft.entryUuid, endResolved?.offsetMinutes, endUtcOffset, occurredEndLocal, inferredCrop, layout, leaf, occurredLocal, passUuid, payloadValues, resolved?.offsetMinutes, selectedPlot, template, timezone, utcOffset]);

  const buildBatchInput = useCallback((acknowledgements: readonly string[] = []) => ({
    members: selectedPlotUuids.map((plotUuid) => {
      const existingEntryUuid = batchEntryUuidsRef.current.get(plotUuid);
      const entryUuid = existingEntryUuid ?? randomUuid();
      batchEntryUuidsRef.current.set(plotUuid, entryUuid);
      return { plot_uuid: plotUuid, entry_uuid: entryUuid };
    }),
    season_crop: inferredCrop || null,
    activity_code: leaf?.activity_code ?? '',
    template_code: template?.code ?? '',
    template_version: template?.version ?? 0,
    layout_code: layout?.code ?? '',
    layout_version: layout?.version ?? 0,
    occurred_start_local: occurredLocal,
    occurred_end_local: occurredEndLocal || null,
    occurred_timezone: timezone,
    occurred_utc_offset_minutes: resolvedRef.current?.offsetMinutes ?? resolved?.offsetMinutes ?? utcOffset,
    occurred_end_utc_offset_minutes: endResolvedRef.current?.offsetMinutes ?? endResolved?.offsetMinutes ?? endUtcOffset,
    values: payloadValues,
    ...(acknowledgements.length > 0
      ? { duplicate_guard_ack_entry_uuids: acknowledgements }
      : {}),
    ...cycleCascadeFields(),
  }), [cycleCascadeFields, endResolved?.offsetMinutes, endUtcOffset, occurredEndLocal, inferredCrop, layout, leaf, occurredLocal, payloadValues, resolved?.offsetMinutes, selectedPlotUuids, template, timezone, utcOffset]);

  // B1/B2 fix (Slice F, atomic tank-mix pass): builds the WHOLE pass —
  // primary (draft.entryUuid, or a fresh UUID if the draft hasn't been
  // autosaved yet) plus every queued member — as one buildTankMixPassBatchPayload
  // input. The primary's own values (payloadValues) already combine the
  // pass's shared fields (operator/equipment/weather/etc.) with its own
  // product-family values exactly as a normal single-entry finalize would;
  // each queued member instead gets the shared fields recombined with that
  // member's own snapshot (sharedValues + member.values), matching what
  // addProductToPass snapshotted when it was queued.
  const buildPassBatchInput = useCallback((acknowledgements: readonly string[] = []) => {
    const sharedValues = payloadValues.filter((value) =>
      !TANK_MIX_PRODUCT_FIELD_CODES.includes(value.attribute_code));
    return {
      plot_uuid: selectedPlot?.plot_uuid ?? '',
      pass_uuid: passUuid ?? randomUuid(),
      primary_entry_uuid: draft.entryUuid ?? randomUuid(),
      primary_values: payloadValues,
      members: passMembers.map((member) => ({
        entry_uuid: member.entryUuid,
        values: [...sharedValues, ...member.values],
      })),
      season_crop: inferredCrop || null,
      activity_code: leaf?.activity_code ?? '',
      template_code: template?.code ?? '',
      template_version: template?.version ?? 0,
      layout_code: layout?.code ?? '',
      layout_version: layout?.version ?? 0,
      occurred_start_local: occurredLocal,
      occurred_end_local: occurredEndLocal || null,
      occurred_timezone: timezone,
      occurred_utc_offset_minutes: resolvedRef.current?.offsetMinutes ?? resolved?.offsetMinutes ?? utcOffset,
      occurred_end_utc_offset_minutes:
        endResolvedRef.current?.offsetMinutes ?? endResolved?.offsetMinutes ?? endUtcOffset,
      ...(acknowledgements.length > 0
        ? { duplicate_guard_ack_entry_uuids: acknowledgements }
        : {}),
      ...cycleCascadeFields(),
    };
  }, [
    cycleCascadeFields, draft.entryUuid, endResolved?.offsetMinutes, endUtcOffset, occurredEndLocal, inferredCrop,
    layout, leaf, occurredLocal, passMembers, passUuid, payloadValues, resolved?.offsetMinutes, selectedPlot,
    template, timezone, utcOffset,
  ]);

  const commitValues = useCallback((next: CaptureEntryValueInput[]) => {
    const validation = validateTransition(
      layout,
      template,
      leaf,
      crop,
      next,
      numberInputErrors,
    );
    setValues(next);
    setFormPayload(validation.payload);
    setFormValid(validation.valid);
    setNumberInputErrors(validation.numberInputErrors);
  }, [crop, layout, leaf, numberInputErrors, template, validateTransition]);

  // Slice F (F3, tank-mix): snapshots the CURRENT product identity + dose
  // (from payloadValues — the already-canonicalized value_num/unit_code
  // output, not the raw entered `values`) into a queued pass member, then
  // clears those same fields from the live `values` state so the form is
  // ready for the next product. Requires the form to already be fully valid
  // (formValid) so a half-entered product can never be silently queued.
  const addProductToPass = useCallback(() => {
    if (!isTankMixEligible || !formValid) return;
    const snapshot = payloadValues.filter((value) =>
      TANK_MIX_PRODUCT_FIELD_CODES.includes(value.attribute_code));
    if (snapshot.length === 0) return;
    setPassUuid((current) => current ?? randomUuid());
    setPassMembers((current) => [...current, { id: randomUuid(), entryUuid: randomUuid(), values: snapshot }]);
    commitValues(values.filter((value) => !TANK_MIX_PRODUCT_FIELD_CODES.includes(value.attribute_code)));
  }, [commitValues, formValid, isTankMixEligible, payloadValues, values]);

  const removePassMember = useCallback((id: string) => {
    setPassMembers((current) => current.filter((member) => member.id !== id));
  }, []);

  // A pass with no queued siblings is just a normal single-product entry —
  // never send a stray pass_uuid for it.
  useEffect(() => {
    if (passMembers.length === 0 && passUuid) setPassUuid(null);
  }, [passMembers.length, passUuid]);

  const storeAcceptedRepeat = useCallback((snapshot: AcceptedRepeatSnapshot | null) => {
    acceptedRepeatRef.current = snapshot;
    setAcceptedRepeat(snapshot);
  }, []);

  const clearOwnedCarryForward = useCallback((currentValues: CaptureEntryValueInput[]) => {
    const accepted = acceptedRepeatRef.current;
    const withoutAccepted = accepted
      ? withoutUnchangedOwnedValues(currentValues, accepted.values)
      : currentValues;
    const nextValues = withoutUnchangedOwnedValues(
      withoutAccepted,
      automaticPrefillRef.current.values(),
    );
    automaticPrefillRef.current.clear();
    storeAcceptedRepeat(null);
    setSafePrefill([]);
    setCarryForwardCandidate(null);
    return nextValues;
  }, [storeAcceptedRepeat]);

  // Strips a stale, unedited plot-area treated_area default (see
  // withTreatedAreaPrefill) ahead of a plot switch, so the next call site
  // can re-derive it fresh from the newly selected plot's own area_m2 --
  // never touches a value the user actually typed (withoutUnchangedOwnedValues
  // only removes values that still match their owned snapshot verbatim).
  const clearOwnedTreatedAreaPrefill = useCallback((currentValues: CaptureEntryValueInput[]) => {
    const nextValues = withoutUnchangedOwnedValues(currentValues, treatedAreaOwnedRef.current.values());
    treatedAreaOwnedRef.current.clear();
    return nextValues;
  }, []);

  const applyCarryForwardCandidate = useCallback((
    nextCandidate: CarryForwardCandidate | null,
    incomingAutomatic: CaptureEntryValueInput[],
  ) => {
    let nextValues = values;
    const accepted = acceptedRepeatRef.current;
    const nextTreatment = nextCandidate?.repeatTreatment;
    const acceptedStillCurrent = Boolean(
      accepted && nextCandidate && nextTreatment &&
      accepted.sourceEntryUuid === nextTreatment.sourceEntryUuid &&
      sameCarryForwardContext(accepted.context, nextCandidate.context) &&
      sameCandidateValues(accepted.candidateValues, nextTreatment.values),
    );
    if (accepted && !acceptedStillCurrent) {
      nextValues = withoutUnchangedOwnedValues(nextValues, accepted.values);
      storeAcceptedRepeat(null);
    }

    nextValues = withoutUnchangedOwnedValues(
      nextValues,
      automaticPrefillRef.current.values(),
    );
    automaticPrefillRef.current.clear();
    const existing = new Set(nextValues.map(carryForwardValueKey));
    const additions = incomingAutomatic.filter((value) =>
      !existing.has(carryForwardValueKey(value)));
    additions.forEach((value) => {
      automaticPrefillRef.current.set(carryForwardValueKey(value), value);
      existing.add(carryForwardValueKey(value));
    });
    const mergedValues = [...nextValues, ...additions];
    if (JSON.stringify(mergedValues) !== JSON.stringify(values)) commitValues(mergedValues);
    setSafePrefill(incomingAutomatic);
    setCarryForwardCandidate(nextCandidate);
  }, [commitValues, storeAcceptedRepeat, values]);

  const updateStableDraft = useCallback(async (token: number, contextKey: string): Promise<boolean> => {
    const current = () => mountedRef.current && token === preparationTokenRef.current &&
      contextKey === contextKeyRef.current;
    if (!current() || !model || !layout || !template || !leaf || !resolvedRef.current || !formValid) return false;
    draft.updateDraft(buildPayload('draft'));
    const receipt = await draft.saveDraft();
    if (!current() || !receipt?.entry_uuid || !template) return false;
    const candidate = await loadCarryForwardCandidate(receipt.entry_uuid, carryForwardLabels);
    if (!current()) return false;
    if (!candidate) {
      applyCarryForwardCandidate(null, []);
      return true;
    }
    const partition = partitionCarryForward(candidate.source, template, carryForwardLabels);
    if (!current()) return false;
    applyCarryForwardCandidate(
      { ...candidate, repeatTreatment: partition.repeatTreatment },
      partition.automaticValues,
    );
    return true;
  }, [applyCarryForwardCandidate, buildPayload, carryForwardLabels, draft, formValid, layout, leaf, model, template]);

  useEffect(() => {
    if (!model || !layout || !selectedPlotUuid && layoutCode === '') return;
    let cancelled = false;
    const options = {
      model,
      layout: layout ?? fallbackLayout(model),
      plotUuid: selectedPlotUuid || null,
      zoneLinked,
      occurrence: resolved?.instant ?? null,
    };
    const load = async () => {
      try {
        const result = await loadActivityShortlist({ ...options, listEntries: journalApi.listEntries });
        if (!cancelled) setShortlist(result);
      } catch {
        if (!cancelled) setShortlist({
          plotRecent: [],
          seasonCommon: [],
          farmRecent: [],
          currentSeasonUuid: null,
        });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [fallbackLeaves, layout, layoutCode, model, recentEntries, resolved?.instant, selectedPlotUuid, zoneLinked]);

  useEffect(() => {
    if (!model || !layout || !leaf || !resolved || !selectedPlot?.plot_uuid) {
      setDuplicateCandidate(null);
      return;
    }
    let cancelled = false;
    const instant = Date.parse(resolved.instant);
    const list = async () => {
      setDuplicateInFlight(true);
      try {
        const response = await journalApi.listEntries({
          status: 'final',
          plot_uuid: selectedPlot.plot_uuid,
          activity_code: leaf.activity_code,
          occurred_from: new Date(instant - 60 * 60 * 1000).toISOString(),
          occurred_to: new Date(instant + 60 * 60 * 1000).toISOString(),
          limit: 100,
        });
        if (cancelled) return;
        const entries = Array.isArray(response?.entries) ? response.entries : [];
        const candidate = entries
          .filter((entry) => isRecord(entry) && entry.entry_uuid !== draft.entryUuid && entry.status === 'final')
          .map(duplicateFromEntry)
          .find((entry): entry is DuplicateCandidate => entry != null);
        setDuplicateCandidate(candidate ?? null);
      } catch {
        if (!cancelled) setDuplicateCandidate(null);
      } finally {
        if (!cancelled) setDuplicateInFlight(false);
      }
    };
    void list();
    return () => { cancelled = true; };
  }, [draft.entryUuid, leaf, layout, model, resolved, selectedPlot]);

  // Task 32: replaces the unconditional sanitizeValues() call at a plot/layout
  // transition with an explicit review gate. Values sanitizeValues would hide or
  // reject (a field the new growing setting no longer shows, a choice it no
  // longer allows) are pulled out of `retainedValues` and preserved raw rather
  // than dropped; everything else still goes through the existing sanitize path
  // unchanged. Previously kept values are re-diffed too, so a value kept through
  // one transition that becomes affected again by a later one comes back for
  // review instead of riding along forever.
  const applyLayoutTransitionGate = (
    oldLayoutForDiff: JournalLayoutDefinition | undefined,
    oldLeafForDiff: ActivityLeafSelection | null,
    nextLayout: JournalLayoutDefinition | undefined,
    nextTemplateDef: JournalTemplateDefinition | undefined,
    nextCrop: string,
    retainedValues: CaptureEntryValueInput[],
  ): CaptureEntryValueInput[] => {
    if (!model) {
      setPendingTransitionItems([]);
      setTransitionSheetOpen(false);
      lastRealDiffContextRef.current = null;
      return retainedValues;
    }
    // If the immediate old layout is itself unavailable (component state was
    // already reset to nothing by a prior empty-target transition — see
    // lastRealDiffContextRef above), fall back to the last real layout/leaf a
    // value was entered under so a real-to-real diff still fires correctly
    // across the empty step.
    const effectiveOldLayout = oldLayoutForDiff ?? lastRealDiffContextRef.current?.layout;
    const effectiveOldLeaf = oldLayoutForDiff
      ? oldLeafForDiff
      : lastRealDiffContextRef.current?.leaf ?? oldLeafForDiff;
    // Diffing uses the activity/context the values were entered under (the leaf
    // about to be reset for re-picking), not the empty post-reset selections —
    // otherwise an activity-anchored option_dependency (e.g. "this choice is
    // only valid for irrigation") can never fire during the transition itself.
    const diffSelections = captureSelections(model, effectiveOldLeaf, nextCrop);
    const candidateValues = [...retainedValues, ...keptTransitionValues];
    // An empty/"No plot" target (nextLayout === undefined) hides every field a
    // value was entered under — the same "never silently sanitize" contract
    // applies as to a real layout swap. computeLayoutTransitionDiff is pure
    // and deliberately returns [] when there's no target layout to diff
    // against (see layoutTransition.ts), so that case is handled here instead
    // of falling through to sanitizeValues(..., undefined, ...), which always
    // returns [] and would otherwise silently drop every entered value with
    // no review sheet.
    const diffItems = nextLayout
      ? computeLayoutTransitionDiff({
        model,
        oldLayout: effectiveOldLayout,
        newLayout: nextLayout,
        template: nextTemplateDef,
        selections: diffSelections,
        currentValues: candidateValues,
      })
      : fieldHiddenForEmptyTarget(candidateValues, model);
    const diffKeys = new Set(diffItems.map((item) =>
      layoutTransitionItemKey(item.attribute_code, item.group_index)));
    const survivingKept = keptTransitionValues.filter((value) =>
      !diffKeys.has(layoutTransitionItemKey(value.attribute_code, value.group_index ?? 0)));
    const nonDiffValues = retainedValues.filter((value) =>
      !diffKeys.has(layoutTransitionItemKey(value.attribute_code, value.group_index ?? 0)));
    const diffValues = retainedValues.filter((value) =>
      diffKeys.has(layoutTransitionItemKey(value.attribute_code, value.group_index ?? 0)));
    const sanitizedNonDiff = sanitizeValues(model, nextLayout, nextTemplateDef, null, nextCrop, nonDiffValues);
    setKeptTransitionValues(survivingKept);
    setPendingTransitionItems(diffItems);
    setTransitionSheetOpen(diffItems.length > 0);
    lastRealDiffContextRef.current = nextLayout
      ? null
      : effectiveOldLayout
        ? { layout: effectiveOldLayout, leaf: effectiveOldLeaf }
        : null;
    return [...sanitizedNonDiff, ...diffValues];
  };

  const resolveTransitionItem = (
    item: LayoutTransitionAffectedItem,
    resolution: LayoutTransitionResolutionKind,
  ) => {
    const key = layoutTransitionItemKey(item.attribute_code, item.group_index);
    setPendingTransitionItems((current) => current.filter((candidate) =>
      layoutTransitionItemKey(candidate.attribute_code, candidate.group_index) !== key));
    if (resolution === 'kept') {
      setKeptTransitionValues((current) => [...current, item.value]);
    }
    const nextValues = values.filter((value) =>
      layoutTransitionItemKey(value.attribute_code, value.group_index ?? 0) !== key);
    if (nextValues.length !== values.length) commitValues(nextValues);
  };

  const selectPlot = (uuid: string, selectionOverride?: readonly string[]) => {
    if (interactionLocked) return;
    const requestedSelection = [...new Set(selectionOverride ?? (uuid ? [uuid] : []))];
    const invalidSelection = requestedSelection.some((plotUuid) => {
      const candidate = plots.find((plot) => plot.plot_uuid === plotUuid);
      return candidate == null || candidate.active !== 1 || candidate.deleted_at !== null;
    });
    if (invalidSelection) {
      setWhereError('capture.validation.invalidDefinition');
      return;
    }
    batchPayloadSnapshotRef.current = null;
    batchEntryUuidsRef.current.clear();
    setBatchAttemptPending(false);
    const nextPlot = plots.find(({ plot_uuid: plotUuid }) => plotUuid === uuid);
    const nextLayoutCode = nextPlot?.settings.layout_code ?? '';
    const nextLayout = model?.layouts.get(nextLayoutCode);
    const nextTemplate = nextLayout
      ? effectiveTemplateCode(nextLayout.supported_templates, journalDetailLevel)
      : '';
    const plotContextChanged = requestedSelection.length !== selectedPlotUuids.length ||
      requestedSelection.some((plotUuid, index) => plotUuid !== selectedPlotUuids[index]);
    const layoutContextChanged = nextLayoutCode !== layoutCode;
    const contextValues = plotContextChanged || layoutContextChanged
      ? clearOwnedTreatedAreaPrefill(clearOwnedCarryForward(values))
      : values;
    const dependencyCodes = new Set(
      leaf?.dependent_selections.map(({ attribute_code }) => attribute_code) ?? [],
    );
    const retainedValues = contextValues.filter((value) =>
      !dependencyCodes.has(value.attribute_code));

    const nextTimezone = nextPlot?.zone_uuid
      ? zoneTimezones[nextPlot.zone_uuid] ?? browserTimezone
      : browserTimezone;
    setSelectedPlotUuids(requestedSelection);
    setLayoutCode(nextLayoutCode);
    setTemplateCode(nextTemplate);
    const nextCrop = cropForPlot(nextPlot, zoneCrops);
    setCrop(nextCrop);
    setTimezone(nextTimezone);
    setOccurredLocal(localDefault(nextTimezone, browserTimezone));
    setOccurredEndLocal('');
    setResolved(null);
    resolvedRef.current = null;
    setEndResolved(null);
    endResolvedRef.current = null;
    setUtcOffset(null);
    setEndUtcOffset(null);
    setOccurrenceError(null);
    setEndOccurrenceError(null);
    setLeaf(null);
    const nextTemplateDef = model?.templates.get(nextTemplate);
    const nextValues = withTreatedAreaPrefill(
      withCanonicalContextCrop(
        model,
        nextCrop,
        applyLayoutTransitionGate(layout, leaf, nextLayout, nextTemplateDef, nextCrop, retainedValues),
      ),
      nextPlot,
      treatedAreaOwnedRef.current,
    );
    const validation = validateTransition(
      nextLayout,
      nextTemplateDef,
      null,
      nextCrop,
      nextValues,
    );
    setValues(nextValues);
    setFormPayload(validation.payload);
    setFormValid(validation.valid);
    setNumberInputErrors(validation.numberInputErrors);
    setShowValidation(false);
    setShortlist({
      plotRecent: [], seasonCommon: [], farmRecent: [], currentSeasonUuid: null,
    });
    setDuplicateCandidate(null);
    setDuplicateCandidates([]);
    setDuplicateAck(null);
    setDuplicateAckEntryUuids([]);
    setBatchError(null);
    setDuplicateInFlight(false);
    setCarryForwardCandidate(null);
    setSafePrefill([]);
    setWhereError(null);
    setVariety('');
    setCycleAction(null);
    setEndsCropCycle(false);
    setCycleUuid(null);
    setCycleDisambiguationOptions(null);
    setPendingCycleRetry(false);
  };

  const handlePlotSelection = (selection: {
    plotUuids: string[];
    layoutCode: string | null;
    isMultiPlot: boolean;
  }) => {
    if (interactionLocked) return;
    const sorted = [...new Set(selection.plotUuids)].sort();
    const first = sorted[0];
    selectPlot(first ?? '', sorted);
    setLayoutCode(selection.layoutCode ?? '');
    if (sorted.length > 1) {
      setDuplicateCandidate(null);
      setDuplicateCandidates([]);
      setDuplicateAckEntryUuids([]);
    }
  };

  const chooseLayout = (code: string) => {
    if (interactionLocked) return;
    const contextValues = code !== layoutCode
      ? clearOwnedCarryForward(values)
      : values;
    setLayoutCode(code);
    const nextLayout = model?.layouts.get(code);
    const nextTemplate = nextLayout
      ? effectiveTemplateCode(nextLayout.supported_templates, journalDetailLevel)
      : '';
    setTemplateCode(nextTemplate);
    const previousDependencyCodes = new Set(leaf?.dependent_selections.map(({ attribute_code }) => attribute_code));
    const retainedValues = contextValues.filter((value) => !previousDependencyCodes.has(value.attribute_code));
    const nextTemplateDef = model?.templates.get(nextTemplate);
    const nextValues = withTreatedAreaPrefill(
      applyLayoutTransitionGate(layout, leaf, nextLayout, nextTemplateDef, crop, retainedValues),
      selectedPlot,
      treatedAreaOwnedRef.current,
    );
    const validation = validateTransition(
      nextLayout,
      nextTemplateDef,
      null,
      crop,
      nextValues,
    );
    setLeaf(null);
    setValues(nextValues);
    setFormPayload(validation.payload);
    setFormValid(validation.valid);
    setNumberInputErrors(validation.numberInputErrors);
  };

  const pickActivity = (chosen: ActivityLeafSelection) => {
    if (interactionLocked) return;
    const contextValues = chosen.activity_code !== leaf?.activity_code
      ? clearOwnedCarryForward(values)
      : values;
    if (chosen.activity_code !== leaf?.activity_code) {
      setVariety('');
      setCycleAction(null);
      setEndsCropCycle(false);
      setCycleUuid(null);
      setCycleDisambiguationOptions(null);
      setPendingCycleRetry(false);
    }
    setLeaf(chosen);
    const previousDependencyCodes = new Set(leaf?.dependent_selections.map(({ attribute_code }) => attribute_code));
    // Seed the plot-area default BEFORE sanitizeValues so the chosen
    // activity's own operation_fields_by_activity visibility governs whether
    // it stays (e.g. hidden again on pruning/harvest/... -- expected, not a
    // bug) -- see withTreatedAreaPrefill's comment above.
    const seededContextValues = withTreatedAreaPrefill(contextValues, selectedPlot, treatedAreaOwnedRef.current);
    const retainedValues = sanitizeValues(model!, layout, template, chosen, crop, seededContextValues, previousDependencyCodes);
    const nextValues = [
      ...retainedValues,
      ...activityDependencyInputs(chosen),
    ];
    setValues(nextValues);
    const validation = validateTransition(layout, template, chosen, crop, nextValues);
    setFormPayload(validation.payload);
    setFormValid(validation.valid);
    setNumberInputErrors(validation.numberInputErrors);
    if (!resolved) resolveCurrentOccurrence();
  };

  const resolveCurrentOccurrence = (): boolean => {
    try {
      const result = resolveOccurrence(occurredLocal, timezone, utcOffset);
      resolvedRef.current = result;
      setResolved(result);
      setOccurrenceError(null);
      setUtcOffset(result.offsetMinutes);
      return true;
    } catch (error) {
      const typed = error instanceof OccurrenceResolutionError ? error : null;
      setResolved(null);
      resolvedRef.current = null;
      setOccurrenceError(typed);
      return false;
    }
  };

  const resolveEndOccurrence = (): boolean => {
    if (!occurredEndLocal) {
      setEndResolved(null);
      endResolvedRef.current = null;
      setEndUtcOffset(null);
      setEndOccurrenceError(null);
      return true;
    }
    try {
      const result = resolveOccurrence(occurredEndLocal, timezone, endUtcOffset);
      endResolvedRef.current = result;
      setEndResolved(result);
      setEndUtcOffset(result.offsetMinutes);
      setEndOccurrenceError(null);
      return true;
    } catch (error) {
      const typed = error instanceof OccurrenceResolutionError ? error : null;
      setEndResolved(null);
      endResolvedRef.current = null;
      setEndOccurrenceError(typed);
      return false;
    }
  };

  const next = async () => {
    if (interactionLocked) return;
    if (pendingTransitionItems.length > 0) {
      setTransitionSheetOpen(true);
      return;
    }
    if (step === 'where') {
      if (!selectedPlot && !layoutCode) {
        setWhereError('capture.validation.invalidDefinition');
        return;
      }
      if (selectedPlot && !zoneLinked && !inferredCrop) {
        setWhereError('capture.validation.cropRequired');
        return;
      }
      if (!layout) {
        setWhereError('capture.validation.invalidDefinition');
        return;
      }
      setWhereError(null);
      setStep('activity');
      return;
    }
    if (step === 'activity') {
      if (!leaf) return;
      if (selectedPlot && !zoneLinked && !inferredCrop) {
        setWhereError('capture.validation.cropRequired');
        return;
      }
      setStep('details');
      return;
    }
    if (step === 'details') {
      const occurrenceValid = resolveCurrentOccurrence();
      const endOccurrenceValid = resolveEndOccurrence();
      setShowValidation(true);
      const requiredValid = requiredFieldsSatisfied(fieldStates, values);
      const seedingCropValid = !isSeedingLeaf || effectiveSeedingCrop !== '';
      if (!occurrenceValid || !endOccurrenceValid || !formValid || !requiredValid || !template || !layout ||
          !seedingCropValid || !cycleActionSatisfied) return;
      if (isMultiPlot) {
        setStep('confirm');
        return;
      }
      const token = preparationTokenRef.current + 1;
      preparationTokenRef.current = token;
      const contextKey = contextKeyRef.current;
      setPreparingConfirm(true);
      try {
        const prepared = await updateStableDraft(token, contextKey);
        if (prepared && mountedRef.current && token === preparationTokenRef.current) {
          setStep('confirm');
        }
      } catch {
        if (mountedRef.current && token === preparationTokenRef.current) setStickyLossWarning(true);
      } finally {
        if (mountedRef.current && token === preparationTokenRef.current) setPreparingConfirm(false);
      }
    }
  };

  const edit = (target: CaptureEditStep) => {
    if (interactionLocked) return;
    preparationTokenRef.current += 1;
    setStep(target);
  };

  // B1/B2 fix (Slice F): this now covers TWO atomic-batch shapes sharing one
  // saving/error/retry/duplicate-candidate machinery -- a cross-plot batch
  // (isMultiPlot, one entry per plot) and a tank-mix pass (isTankMixPass,
  // N product entries on ONE plot sharing one pass_uuid). Both build a
  // CreateFinalBatchPayload and POST it through the exact same
  // journalApi.createFinalBatch call, so a failed pass retries as a whole
  // exactly the way a failed cross-plot batch already did -- there is no
  // separate per-member create loop left to desync.
  const finalizeBatch = useCallback(async (ackOverride: readonly string[] = duplicateAckEntryUuids) => {
    if (finalReceipt || (!isMultiPlot && !isTankMixPass)) return finalReceipt ?? undefined;
    if (savePromiseRef.current) return savePromiseRef.current;
    if (pendingTransitionItems.length > 0) {
      setTransitionSheetOpen(true);
      return undefined;
    }
    if (duplicateCandidates.length > 0 && ackOverride.length === 0) return undefined;

    const payload = batchPayloadSnapshotRef.current
      ? {
          ...cloneFinalBatchPayload(batchPayloadSnapshotRef.current),
          ...(ackOverride.length > 0
            ? { duplicate_guard_ack_entry_uuids: [...ackOverride] }
            : {}),
        }
      : (() => {
          const built = isMultiPlot
            ? buildFinalBatchPayload(buildBatchInput(ackOverride))
            : buildTankMixPassBatchPayload(buildPassBatchInput(ackOverride));
          if (!built.ok) {
            setBatchError(built.error.message);
            return null;
          }
          const snapshot = cloneFinalBatchPayload(built.payload);
          batchPayloadSnapshotRef.current = snapshot;
          return cloneFinalBatchPayload(snapshot);
        })();
    if (!payload) return undefined;

    const promise = (async (): Promise<BatchMutationReceipt> => {
      setBatchAttemptPending(true);
      setSaving(true);
      setBatchError(null);
      try {
        const receipt = await journalApi.createFinalBatch(payload);
        setDuplicateCandidates([]);
        setDuplicateAckEntryUuids([]);
        setStickyLossWarning(false);
        batchPayloadSnapshotRef.current = null;
        setBatchAttemptPending(false);
        setPassMembers([]);
        setReceiptHarvestGroups(matchingActiveHarvestGroups(
          leaf?.activity_code ?? '',
          selectedPlotUuids,
          plotGroups,
        ).map((group) => ({
          ...group,
          members: [...group.members],
        })));
        setFinalReceipt(receipt);
        return receipt;
      } catch (error) {
        const cycleOptions = cycleDisambiguationFromError(error);
        if (cycleOptions) {
          batchPayloadSnapshotRef.current = null;
          // Review fix: always clear the previously chosen cycle_uuid here,
          // including on a RETRY that fails again with this same error (a
          // concurrently-closed cycle, or a stale pick). The retry effect
          // below only fires once cycleUuid is (re-)set, so leaving the old
          // value in place would make it fire immediately with the same
          // already-refused value instead of waiting for a fresh choice.
          setCycleUuid(null);
          setCycleDisambiguationOptions(cycleOptions);
          setPendingCycleRetry(true);
          setStickyLossWarning(false);
          throw error;
        }
        const candidates = duplicateCandidatesFromError(error);
        if (candidates.length > 0) {
          setDuplicateCandidates(candidates);
          setDuplicateAckEntryUuids([]);
          setStickyLossWarning(false);
        } else {
          setStickyLossWarning(true);
        }
        throw error;
      } finally {
        setSaving(false);
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = promise.then(() => undefined, () => undefined);
    return promise;
  }, [
    buildBatchInput,
    buildPassBatchInput,
    duplicateAckEntryUuids,
    duplicateCandidates.length,
    finalReceipt,
    isMultiPlot,
    isTankMixPass,
    leaf?.activity_code,
    pendingTransitionItems.length,
    plotGroups,
    selectedPlotUuids,
  ]);

  const finalize = useCallback(async (ackOverride?: string | null) => {
    if (finalReceipt) return;
    if (isMultiPlot || isTankMixPass) {
      return finalizeBatch(ackOverride ? [ackOverride] : duplicateAckEntryUuids);
    }
    if (savePromiseRef.current) return savePromiseRef.current;
    if (pendingTransitionItems.length > 0) {
      setTransitionSheetOpen(true);
      return;
    }
    const acknowledgedDuplicateUuid = duplicateCandidate &&
      (duplicateAck === duplicateCandidate.entry_uuid || ackOverride === duplicateCandidate.entry_uuid)
      ? duplicateCandidate.entry_uuid
      : null;
    if (duplicateCandidate && !acknowledgedDuplicateUuid) return;
    const promise = (async () => {
      setSaving(true);
      try {
        const receipt = await draft.finish(buildPayload('final', acknowledgedDuplicateUuid));
        setDuplicateCandidate(null);
        setStickyLossWarning(false);
        setFinalReceipt(receipt);
        return receipt;
      } catch (error) {
        const cycleOptions = cycleDisambiguationFromError(error);
        if (cycleOptions) {
          // See the matching comment in finalizeBatch's catch above.
          setCycleUuid(null);
          setCycleDisambiguationOptions(cycleOptions);
          setPendingCycleRetry(true);
          setStickyLossWarning(false);
          throw error;
        }
        const candidate = duplicateFromError(error);
        if (candidate) {
          let values = candidate.values;
          if (values.length === 0) {
            try {
              const response = await journalApi.listEntries({
                entry_uuid: candidate.entry_uuid,
                status: 'all',
                limit: 1,
              });
              const aggregate = Array.isArray(response?.entries)
                ? response.entries.find((entry) => isRecord(entry) && entry.entry_uuid === candidate.entry_uuid)
                : undefined;
              if (aggregate) values = duplicateValues(aggregate.values);
            } catch {
              values = [];
            }
          }
          setDuplicateCandidate({ ...candidate, values: duplicateValues(values) });
          setStickyLossWarning(false);
        } else {
          setStickyLossWarning(true);
        }
        throw error;
      } finally {
        setSaving(false);
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = promise.then(() => undefined, () => undefined);
    return promise;
  }, [buildPayload, duplicateAck, duplicateAckEntryUuids, duplicateCandidate, draft, finalizeBatch, isMultiPlot, isTankMixPass, pendingTransitionItems.length, payloadValues]);

  // R7: once the user picks which cycle_uuid an intercrop-disambiguation
  // error named (see cycleDisambiguationFromError above), retry the same
  // save automatically. This waits for a render to commit rather than
  // retrying inline in the picker's onClick, so buildPayload/buildBatchInput
  // (both depend on `cycleUuid`) have already been rebuilt with the fresh
  // value — the same reason duplicate-guard acknowledgements are threaded as
  // explicit call arguments elsewhere in this file rather than read back
  // from state synchronously after a setState. finalize() itself already
  // dispatches to finalizeBatch for both the cross-plot and tank-mix-pass
  // cases (isMultiPlot || isTankMixPass), so one call covers every mode.
  useEffect(() => {
    if (!pendingCycleRetry || cycleUuid == null) return;
    setPendingCycleRetry(false);
    setCycleDisambiguationOptions(null);
    void finalize().catch(() => undefined);
  }, [cycleUuid, finalize, pendingCycleRetry]);

  // B1/B2 fix: a failed pass batch now retries as a WHOLE (finalizeBatch is
  // fully idempotent/atomic — see its doc comment above), the same way a
  // failed cross-plot batch already did. There is no longer a separate
  // "retry just the pass members" path.
  const retry = useCallback(async () => {
    if (savePromiseRef.current) return savePromiseRef.current;
    if (isMultiPlot || isTankMixPass) return finalizeBatch(duplicateAckEntryUuids);
    const promise = (async () => {
      setSaving(true);
      try {
        const receipt = await draft.retry();
        if (receipt && 'outbox_event_uuid' in receipt && receipt.outbox_event_uuid) {
          setStickyLossWarning(false);
          setFinalReceipt(receipt);
          setStep('confirm');
        }
      } finally {
        setSaving(false);
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = promise.then(() => undefined, () => undefined);
    return promise;
  }, [draft, duplicateAckEntryUuids, finalizeBatch, isMultiPlot, isTankMixPass]);

  const resolveHarvestGroup = useCallback(async (group: PlotGroup) => {
    setGroupResolutionErrors((current) => {
      const next = new Map(current);
      next.delete(group.group_uuid);
      return next;
    });

    const latestGroup = plotGroups.find((candidate) => candidate.group_uuid === group.group_uuid);
    if (!latestGroup || latestGroup.deleted_at !== null) {
      setGroupResolutionErrors((current) =>
        new Map(current).set(group.group_uuid, 'group.changedError'));
      throw new Error('plot group changed');
    }
    if (latestGroup.resolved_at !== null) return;
    if (matchingActiveHarvestGroups('harvest', group.members, [latestGroup]).length === 0) {
      setGroupResolutionErrors((current) =>
        new Map(current).set(group.group_uuid, 'group.changedError'));
      throw new Error('plot group changed');
    }

    const payload = {
      group_uuid: latestGroup.group_uuid,
      base_sync_version: latestGroup.sync_version,
      label: latestGroup.label,
      members: [...latestGroup.members].sort(),
      resolved: true,
    };
    try {
      await groupState.updatePlotGroup(latestGroup.group_uuid, payload);
    } catch (cause) {
      setGroupResolutionErrors((current) =>
        new Map(current).set(group.group_uuid, 'group.resolveError'));
      throw cause;
    }
  }, [groupState.updatePlotGroup, plotGroups]);

  const close = useCallback(() => {
    if (closePromiseRef.current) return closePromiseRef.current;
    if (closeStartedRef.current || closeLocked) return Promise.resolve();
    closeStartedRef.current = true;
    const promise = (async () => {
      if (!finalReceipt || savedCallbackFiredRef.current) {
        onClose();
        return;
      }
      savedCallbackFiredRef.current = true;
      try {
        await onSaved(finalReceipt);
      } finally {
        onClose();
      }
    })();
    closePromiseRef.current = promise;
    void promise.then(
      () => { closePromiseRef.current = null; },
      () => { closePromiseRef.current = null; },
    );
    return promise;
  }, [closeLocked, finalReceipt, onClose, onSaved]);

  const saveSeparately = () => {
    if (!duplicateCandidate || interactionLocked) return;
    if (!duplicateWarningShown) setDuplicateWarningShown(true);
    setDuplicateAck(duplicateCandidate.entry_uuid);
    void finalize(duplicateCandidate.entry_uuid).catch(() => undefined);
  };

  const acknowledgeBatchDuplicates = () => {
    if (duplicateCandidates.length === 0 || saving || finalReceipt) return;
    const acknowledgements = duplicateCandidates.map((candidate) => candidate.entry_uuid);
    setDuplicateAckEntryUuids(acknowledgements);
    void finalizeBatch(acknowledgements).catch(() => undefined);
  };

  // Slice BC (R1 Part 2): "apply to all plots in this station" writes the
  // same plot-static context to every other active plot sharing
  // `station_code`, sequentially (the edge DB is single-writer; a batch of
  // concurrent plot upserts would just contend the same lock). A station is
  // expected to be layout-homogeneous in practice (a heterogeneous station is
  // already flagged elsewhere in this flow), so the context blob is applied
  // as-is; a target plot only ever renders the subset of keys its own
  // layout's static_context_fields recognizes.
  const applyContextToStation = async (
    stationCode: string,
    contextJson: string | null,
    sourcePlotUuid: string | null,
  ): Promise<{ appliedCount: number }> => {
    const targets = plots.filter((candidate) =>
      candidate.station_code === stationCode &&
      candidate.plot_uuid !== sourcePlotUuid &&
      candidate.active === 1 && candidate.deleted_at === null);
    let appliedCount = 0;
    for (const target of targets) {
      const targetLayout = model?.layouts.get(target.settings.layout_code);
      await plotState.updatePlot(target.plot_uuid, {
        plot_uuid: target.plot_uuid,
        base_sync_version: target.sync_version,
        plot_code: target.plot_code,
        name: target.name,
        zone_uuid: target.zone_uuid,
        station_code: target.station_code,
        crop_hint: target.crop_hint,
        area_m2: target.area_m2,
        active: target.active === 0 ? 0 : 1,
        layout_code: target.settings.layout_code,
        layout_version: targetLayout?.version ?? 1,
        context_json: contextJson,
      });
      appliedCount += 1;
    }
    return { appliedCount };
  };

  const carryForwardContext = useMemo<CarryForwardContext | null>(() => {
    if (!leaf || !layout || !resolved || !selectedPlot?.plot_uuid || !shortlist.currentSeasonUuid) return null;
    return {
      plot_uuid: selectedPlot.plot_uuid,
      crop: inferredCrop || null,
      activity_code: leaf.activity_code,
      occurred_start: resolved.instant,
      season_uuid: shortlist.currentSeasonUuid,
      layout_code: layout.code,
      layout_version: layout.version,
    };
  }, [inferredCrop, layout, leaf, resolved, selectedPlot, shortlist.currentSeasonUuid]);

  const useRepeatTreatment = useCallback((incoming: CaptureEntryValueInput[]) => {
    const treatment = carryForwardCandidate?.repeatTreatment;
    if (interactionLocked || !treatment || !carryForwardContext) return;
    const previous = acceptedRepeatRef.current;
    const retainedValues = previous
      ? withoutUnchangedOwnedValues(values, previous.values)
      : values;
    const candidateValues = incoming.map((value) => ({ ...value }));
    const acceptedValues = candidateValues.map((value) => ({ ...value }));
    const incomingKeys = new Set(acceptedValues.map(carryForwardValueKey));
    storeAcceptedRepeat({
      sourceEntryUuid: treatment.sourceEntryUuid,
      context: { ...carryForwardContext },
      candidateValues,
      values: acceptedValues,
    });
    commitValues([
      ...retainedValues.filter((value) => !incomingKeys.has(carryForwardValueKey(value))),
      ...acceptedValues,
    ]);
  }, [carryForwardCandidate, carryForwardContext, commitValues, interactionLocked, storeAcceptedRepeat, values]);

  const dismissRepeatTreatment = useCallback(() => {
    if (interactionLocked) return;
    const accepted = acceptedRepeatRef.current;
    const nextValues = accepted
      ? withoutUnchangedOwnedValues(values, accepted.values)
      : values;
    storeAcceptedRepeat(null);
    setCarryForwardCandidate(null);
    if (JSON.stringify(nextValues) !== JSON.stringify(values)) commitValues(nextValues);
  }, [commitValues, interactionLocked, storeAcceptedRepeat, values]);

  const formChanged = useCallback((
    next: CaptureEntryValueInput[],
    payload: CaptureEntryValueOutput[],
    valid: boolean,
    inputErrors: ReadonlyMap<string, string>,
  ) => {
    if (interactionLocked) return;
    for (const [key, automatic] of automaticPrefillRef.current) {
      const current = next.find((value) => carryForwardValueKey(value) === key);
      if (!current || !sameCaptureValue(current, automatic)) {
        automaticPrefillRef.current.delete(key);
      }
    }
    const accepted = acceptedRepeatRef.current;
    if (accepted) {
      const stillOwned = accepted.values.filter((snapshot) => {
        const current = next.find((value) =>
          carryForwardValueKey(value) === carryForwardValueKey(snapshot));
        return current != null && sameCaptureValue(current, snapshot);
      });
      if (stillOwned.length !== accepted.values.length) {
        storeAcceptedRepeat({ ...accepted, values: stillOwned });
      }
    }
    setValues(next);
    setFormPayload(payload);
    setFormValid(valid);
    setNumberInputErrors(inputErrors);
  }, [interactionLocked, storeAcceptedRepeat]);

  useEffect(() => {
    const previousContext = prefillContextRef.current;
    prefillContextRef.current = prefillContext;
    const changed = Boolean(previousContext && previousContext !== prefillContext);
    if (changed) {
      preparationTokenRef.current += 1;
      if (preparingConfirm) setPreparingConfirm(false);
    }
    if (!previousContext || previousContext === prefillContext) return;
    const nextValues = clearOwnedCarryForward(values);
    if (nextValues.length !== values.length) commitValues(nextValues);
  }, [clearOwnedCarryForward, commitValues, preparingConfirm, prefillContext, values]);

  // POLISH 7: distinguish a genuine hard failure (buildCatalogModel actually
  // rejected the catalog -- duplicate codes, an invalid template/layout
  // definition, etc.) from a merely empty one (nothing configured yet, but
  // structurally fine). The caller already gates mounting this component on
  // its own catalog loading/error state (see JournalPage.tsx), so a "still
  // loading" race is not a real concern here -- but printing the exact same
  // scary, action-less alert for both a real defect and an empty catalog
  // was. Keep this proportionate: one shared shell (so the header's Close
  // control is always reachable, unlike the old bare-alert return), text and
  // affordances differ by case.
  const catalogEmpty = catalog.vocab.length === 0 && catalog.layouts.length === 0;
  if (!model || catalogEmpty) {
    const emptyOnly = model != null && catalogEmpty;
    return (
      <div className="min-h-full bg-[var(--bg)] px-4 py-5">
        <header className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-[var(--text)]">{t('capture.title')}</h1>
          <button type="button" onClick={onClose} className={`min-h-11 rounded-xl px-3 font-bold text-[var(--primary)] ${FOCUS_RING}`}>
            {t('capture.close')}
          </button>
        </header>
        <div className="mx-auto mt-5 max-w-3xl space-y-3">
          <p role={emptyOnly ? 'status' : 'alert'} className={`text-sm font-semibold ${emptyOnly ? 'text-[var(--text-secondary)]' : 'text-[var(--error-text)]'}`}>
            {t(emptyOnly ? 'capture.validation.catalogEmpty' : 'capture.validation.invalidDefinition')}
          </p>
          {!emptyOnly && (
            <>
              <p className="text-sm text-[var(--text-secondary)]">{t('capture.validation.invalidDefinitionDetail')}</p>
              {onRetryCatalog && (
                <button
                  type="button"
                  onClick={onRetryCatalog}
                  className={`min-h-11 rounded-xl bg-[var(--primary)] px-4 font-bold text-white ${FOCUS_RING}`}
                >
                  {t('error.retry')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const layoutChoices = [...model.layouts.values()].sort((left, right) => left.code.localeCompare(right.code));
  const plotLayoutOptions = layoutChoices.map((candidate) => ({
    code: candidate.code,
    version: candidate.version,
    label: catalogLabel(catalog.layouts.find((row) => row.code === candidate.code) ?? { code: candidate.code }, locale),
  }));
  const activePlotGroups = plotGroups.filter((group) => group.resolved_at === null);
  const resolvedPlotGroups = plotGroups.filter((group) => group.resolved_at !== null);
  const activityRows = catalog.vocab.filter((row) => row.active === 1 && row.deleted_at == null);
  const valueTokens: ConfirmValueToken[] = payloadValues
    // NIT 9: attr.actuation_expectation_id is an internal valve-expectation
    // linkage id with no user-meaningful label and no friendly resolver --
    // omit it from the confirm screen entirely rather than print the raw
    // opaque id.
    .filter((value) => value.attribute_code !== OMITTED_CONFIRM_VALUE_CODE)
    .map((value) => {
      const attribute = model.vocabByCode.get(value.attribute_code);
      const unitCode = value.entered_unit_code ?? value.unit_code;
      const unit = unitCode ? model.vocabByCode.get(unitCode) : undefined;
      return {
        attribute_code: value.attribute_code,
        group_index: value.group_index,
        label: attribute ? catalogLabel(attribute, locale) : value.attribute_code,
        value: displayValue(value, model, locale, {
          yes: t('capture.form.booleanYes'),
          no: t('capture.form.booleanNo'),
        }, catalog.products, t('capture.tankMix.unknownProduct')),
        unit: unit ? catalogLabel(unit, locale) : unitCode,
        step: 'details',
      };
    });
  const confirmValues: ConfirmValueToken[] = occurredEndLocal
    ? [...valueTokens, {
        attribute_code: 'occurred_end_local',
        label: `${t('capture.confirm.occurrence')} · ${t('capture.form.optional')}`,
        value: endResolved ? occurrenceLabel(endResolved.instant, timezone, locale) : occurredEndLocal,
        step: 'details',
      }]
    : valueTokens;
  const duplicateActivityLabel = duplicateCandidate
    ? catalogLabel(
        catalog.vocab.find((row) => row.code === duplicateCandidate.activity_code) ?? {
          code: duplicateCandidate.activity_code,
        },
        locale,
      )
    : '';
  const duplicateActivity = (candidate: DuplicateCandidate): string => catalogLabel(
    catalog.vocab.find((row) => row.code === candidate.activity_code) ?? {
      code: candidate.activity_code,
    },
    locale,
  );
  const selectedPlotLabel = isMultiPlot
    ? selectedPlots.map((plot) => plot.name?.trim() || plot.plot_code).join(', ')
    : selectedPlot?.name?.trim() || selectedPlot?.plot_code || t('capture.confirm.farmLevel');
  const startOccurrenceLabel = `${t('capture.confirm.occurrence')} · ${t('capture.form.required')}`;
  const endOccurrenceLabel = `${t('capture.confirm.occurrence')} · ${t('capture.form.optional')}`;
  const endOffsetLabel = `${t('capture.validation.chooseUtcOffset')} · ${t('capture.form.optional')}`;
  // P1-a (Slice D hardening): the Where/Activity steps' sensorless-plot crop
  // field. Do NOT re-ask a crop the app already has via an open cycle —
  // show it read-only instead (the free-text input stays for a genuinely
  // cycle-less plot, unchanged). Ambiguous intercrop (openCropCycleInfo null
  // because >1 open cycle) falls through to the free-text input, same as
  // before this fix — disambiguating which crop an activity is about is a
  // capture-form concern out of scope here.
  const whereCropField = selectedPlot && !zoneLinked && (
    openCropCycleInfo ? (
      <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text)]">
        <span aria-hidden="true">🌱 </span>
        {cropCycleLabel(openCropCycleInfo.crop_code, openCropCycleInfo.variety)}
      </p>
    ) : (
      <label className="block text-sm font-bold text-[var(--text)]">
        {t('capture.carry.crop')}
        <input
          aria-label={t('capture.carry.crop')}
          value={crop}
          disabled={preparingConfirm || saving || Boolean(finalReceipt)}
          onChange={(event) => { setCrop(event.target.value); setWhereError(null); }}
          className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-[var(--text)]"
        />
      </label>
    )
  );
  // POLISH 5: the treated_area plot-area default (withTreatedAreaPrefill
  // above) is otherwise indistinguishable from a value the farmer actually
  // typed -- give it a small hint whenever the field's CURRENT value still
  // matches exactly what the plot's own area_m2 default would produce (i.e.
  // it is still active and untouched). Content-based rather than reading
  // treatedAreaOwnedRef directly: comparing current state against a freshly
  // recomputed prefill candidate stays correct regardless of ref-timing, and
  // naturally goes false the instant a user edit changes the value.
  const treatedAreaPrefillCandidate = treatedAreaPrefillValue(selectedPlot);
  const treatedAreaCurrentValue = values.find(
    (value) => value.attribute_code === TREATED_AREA_ATTRIBUTE_CODE,
  );
  const treatedAreaPrefillActive = Boolean(
    treatedAreaPrefillCandidate && treatedAreaCurrentValue &&
    sameCaptureValue(treatedAreaCurrentValue, treatedAreaPrefillCandidate),
  );
  const fieldHints = treatedAreaPrefillActive
    ? { [TREATED_AREA_ATTRIBUTE_CODE]: t('capture.form.treatedAreaDefaulted') }
    : undefined;
  const body = () => {
    if (step === 'where') {
      return (
        <section aria-labelledby="capture-where-title" className="space-y-4">
          <h2 id="capture-where-title" className="text-xl font-bold text-[var(--text)]">{t('capture.where.title')}</h2>
          <PlotPicker
            plots={plots}
            activeGroups={activePlotGroups}
            resolvedGroups={resolvedPlotGroups}
            allowNoPlot
            value={{ plotUuids: selectedPlotUuids, layoutCode: layoutCode || null, isMultiPlot }}
            onChange={handlePlotSelection}
            onCreateGroup={groupState.createPlotGroup}
            onUpdateGroup={groupState.updatePlotGroup}
          />
          {plotEditor ? (
            <PlotForm
              mode={plotEditor.mode}
              initialPlot={plotEditor.plot}
              layoutOptions={plotLayoutOptions}
              model={model}
              onSubmit={(payload) => plotEditor.mode === 'create'
                ? plotState.createPlot(payload)
                : plotState.updatePlot(payload.plot_uuid, payload)}
              onAfterSave={(savedPlot) => {
                selectPlot(savedPlot.plot_uuid);
                setPlotEditor(null);
              }}
              onApplyToStation={applyContextToStation}
              onCancel={() => setPlotEditor(null)}
            />
          ) : (
            <div className="flex flex-wrap gap-3">
              <button type="button" className="min-h-[56px] rounded-xl border border-[var(--border)] px-4 font-bold text-[var(--text)]" disabled={interactionLocked} onClick={() => setPlotEditor({ mode: 'create' })}>
                {t('plot.new')}
              </button>
              <button type="button" className="min-h-[56px] rounded-xl border border-[var(--border)] px-4 font-bold text-[var(--text)]" disabled={interactionLocked || !selectedPlot} onClick={() => selectedPlot && setPlotEditor({ mode: 'update', plot: selectedPlot })}>
                {t('plot.edit')}
              </button>
            </div>
          )}
          {!selectedPlot && !plotEditor && (
            <label className="block text-sm font-bold text-[var(--text)]">
              {t('capture.where.layout')}
              <select aria-label={t('capture.where.layout')} value={layoutCode} onChange={(event) => chooseLayout(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-[var(--text)]">
                <option value="">{t('capture.where.selectPlot')}</option>
                {layoutChoices.map((candidate) => <option key={`${candidate.code}:${candidate.version}`} value={candidate.code}>{catalogLabel(catalog.layouts.find((row) => row.code === candidate.code) ?? { code: candidate.code }, locale)} · v{candidate.version}</option>)}
              </select>
            </label>
          )}
          {selectedPlot && <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text-secondary)]">{catalogLabel(catalog.layouts.find((row) => row.code === layout?.code) ?? { code: layout?.code ?? '' }, locale)} · v{layout?.version}</p>}
          {whereCropField}
          {batchError && <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{batchError}</p>}
          {whereError && <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t(whereError as never)}</p>}
        </section>
      );
    }
    if (step === 'activity') {
      return <section className="space-y-3"><p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text-secondary)]">{catalogLabel(catalog.layouts.find((row) => row.code === layout?.code) ?? { code: layout?.code ?? '' }, locale)} · v{layout?.version}</p>{whereCropField}{whereError && <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t(whereError as never)}</p>}<ActivityPicker catalogRows={activityRows} plotRecent={shortlist.plotRecent} seasonCommon={shortlist.seasonCommon} farmRecent={shortlist.farmRecent} layoutFallback={fallbackLeaves} zoneLinked={zoneLinked} locale={locale} onPick={pickActivity} /></section>;
    }
    if (step === 'details') {
      return (
        <section aria-labelledby="capture-form-title" className="space-y-4">
          <h2 id="capture-form-title" className="text-xl font-bold text-[var(--text)]">{t('capture.form.title')}</h2>
          <fieldset disabled={interactionLocked} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text-secondary)]">{catalogLabel(catalog.layouts.find((row) => row.code === layout?.code) ?? { code: layout?.code ?? '' }, locale)} · v{layout?.version}</p>
          <label className="block text-sm font-bold text-[var(--text)]">
            {t('capture.where.timezone')}
            <input aria-label={t('capture.where.timezone')} value={timezone} onChange={(event) => { setTimezone(event.target.value); setResolved(null); resolvedRef.current = null; setEndResolved(null); endResolvedRef.current = null; setUtcOffset(null); setEndUtcOffset(null); }} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-[var(--text)]" />
          </label>
          <label className="block text-sm font-bold text-[var(--text)]">
            {startOccurrenceLabel}
            <input type="datetime-local" aria-label={startOccurrenceLabel} value={occurredLocal} onChange={(event) => { setOccurredLocal(event.target.value); setResolved(null); resolvedRef.current = null; setUtcOffset(null); setOccurrenceError(null); }} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-[var(--text)]" />
          </label>
          <label className="block text-sm font-bold text-[var(--text)]">
            {endOccurrenceLabel}
            <input type="datetime-local" aria-label={endOccurrenceLabel} value={occurredEndLocal} onChange={(event) => { setOccurredEndLocal(event.target.value); setEndResolved(null); endResolvedRef.current = null; setEndUtcOffset(null); setEndOccurrenceError(null); }} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-[var(--text)]" />
          </label>
          {occurrenceError?.code === 'ambiguous_local_time' && <label className="block text-sm font-bold text-[var(--text)]">{t('capture.validation.chooseUtcOffset')}<select aria-label={t('capture.validation.chooseUtcOffset')} value={utcOffset ?? ''} onChange={(event) => setUtcOffset(Number(event.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3"><option value="">{t('capture.form.select')}</option>{occurrenceError.availableOffsets.map((offset) => <option key={offset} value={offset}>{offset}</option>)}</select></label>}
          {occurrenceError && <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t(`capture.validation.${occurrenceError.code === 'ambiguous_local_time' ? 'ambiguousLocalTime' : occurrenceError.code === 'nonexistent_local_time' ? 'nonexistentLocalTime' : occurrenceError.code === 'invalid_timezone' ? 'invalidTimezone' : 'invalidLocalTime'}`)}</p>}
          {endOccurrenceError?.code === 'ambiguous_local_time' && <label className="block text-sm font-bold text-[var(--text)]">{endOffsetLabel}<select aria-label={endOffsetLabel} value={endUtcOffset ?? ''} onChange={(event) => setEndUtcOffset(Number(event.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3"><option value="">{t('capture.form.select')}</option>{endOccurrenceError.availableOffsets.map((offset) => <option key={offset} value={offset}>{offset}</option>)}</select></label>}
          {endOccurrenceError && <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t(`capture.validation.${endOccurrenceError.code === 'ambiguous_local_time' ? 'ambiguousLocalTime' : endOccurrenceError.code === 'nonexistent_local_time' ? 'nonexistentLocalTime' : endOccurrenceError.code === 'invalid_timezone' ? 'invalidTimezone' : 'invalidLocalTime'}`)}</p>}
          {isSeedingLeaf && (
            <SeedingCropFields
              model={model}
              locale={locale}
              crop={effectiveSeedingCrop}
              showCropField={!formOwnsCrop}
              variety={variety}
              onCropChange={setCrop}
              onVarietyChange={setVariety}
              varietySuggestions={varietySuggestions}
              overlap={matchingSeedingOverlap}
              cycleAction={cycleAction}
              onCycleActionChange={setCycleAction}
              showValidation={showValidation}
            />
          )}
          {!isSeedingLeaf && bannerInfo && (
            <InheritedCropBanner
              model={model}
              locale={locale}
              cropCode={bannerInfo.crop_code}
              variety={bannerInfo.variety}
              seededDate={bannerInfo.seededDate}
              seedingEntryUuid={bannerInfo.seedingEntryUuid}
              onOpenSeedingEntry={onOpenExisting}
              onCorrected={() => { void plotState.revalidate(); }}
            />
          )}
          {isManualCloseLeaf && (
            <label className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm font-bold text-[var(--text)]">
              <input
                type="checkbox"
                checked={endsCropCycle}
                onChange={(event) => setEndsCropCycle(event.target.checked)}
                className={`h-5 w-5 ${FOCUS_RING}`}
              />
              <span>
                {t('capture.cycle.manualCloseLabel')}
                <span className="mt-1 block text-xs font-semibold text-[var(--text-secondary)]">
                  {t('capture.cycle.manualCloseHint')}
                </span>
              </span>
            </label>
          )}
          {closingCropCycles.length > 0 && (
            <div role="status" className="space-y-1 rounded-xl border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text)]">
              {closingCropCycles.map((cycle) => (
                <p key={`${cycle.crop_code}:${cycle.variety ?? ''}`} className="font-semibold">
                  {t('capture.cycle.closesCycle', { crop: cropCycleLabel(cycle.crop_code, cycle.variety) })}
                </p>
              ))}
            </div>
          )}
          {plotContextDisplay.length > 0 && (
            <div className="space-y-2 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
              <h3 className="text-sm font-bold text-[var(--text)]">{t('capture.form.plotContext')}</h3>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {plotContextDisplay.map((entry) => (
                  <div key={entry.code} className="min-w-0">
                    <dt className="text-xs font-semibold text-[var(--text-secondary)]">{entry.label}</dt>
                    <dd className="truncate text-sm text-[var(--text)]">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {template && layout && leaf && <EntryForm model={model} layout={layout} fieldStates={fieldStates} values={values} onChange={formChanged} selections={selections} products={catalog.products} locale={locale} showValidation={showValidation} templateCode={template.code} fieldHints={fieldHints} />}
          {isTankMixEligible && model && (
            <div className="space-y-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)] p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-[var(--text)]">{t('capture.tankMix.title')}</h3>
                <button
                  type="button"
                  disabled={!formValid}
                  onClick={addProductToPass}
                  className={`min-h-11 rounded-xl border border-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
                >
                  {t('capture.tankMix.addProduct')}
                </button>
              </div>
              {passMembers.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">{t('capture.tankMix.empty')}</p>
              ) : (
                <ul className="space-y-2">
                  {passMembers.map((member, index) => {
                    const product = tankMixProductLabel(member.values, catalog.products, t('capture.tankMix.unknownProduct'));
                    const dose = tankMixDoseLabel(member.values, model, locale);
                    const detail = dose ? `${product} · ${dose}` : product;
                    return (
                    <li
                      key={member.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate text-[var(--text)]">
                        {t('capture.tankMix.memberLabel', { index: index + 1, detail })}
                      </span>
                      <button
                        type="button"
                        onClick={() => removePassMember(member.id)}
                        className={`shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-[var(--error-text)] hover:bg-[var(--card)] ${FOCUS_RING}`}
                      >
                        {t('capture.tankMix.remove')}
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          {safePrefill.length > 0 && <p role="status" className="text-sm font-semibold text-[var(--text-secondary)]">{t('capture.carry.prefilled')}</p>}
          {carryForwardCandidate?.repeatTreatment && carryForwardContext && (
            <RepeatTreatmentCard
              candidate={carryForwardCandidate}
              currentContext={carryForwardContext}
              catalog={catalog}
              accepted={Boolean(
                acceptedRepeat &&
                acceptedRepeat.sourceEntryUuid === carryForwardCandidate.repeatTreatment.sourceEntryUuid &&
                sameCarryForwardContext(acceptedRepeat.context, carryForwardContext) &&
                sameCandidateValues(
                  acceptedRepeat.candidateValues,
                  carryForwardCandidate.repeatTreatment.values,
                )
              )}
              onConfirm={useRepeatTreatment}
              onDismiss={dismissRepeatTreatment}
            />
          )}
          </fieldset>
        </section>
      );
    }
    return (
      <>
        {batchError && <p role="alert" className="mb-4 text-sm font-semibold text-[var(--error-text)]">{batchError}</p>}
        {duplicateCandidates.length > 0 && <section role="alert" className="mb-4 space-y-3 rounded-xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-4"><h2 className="font-bold text-[var(--text)]">{t('batch.duplicateTitle')}</h2><p className="text-sm text-[var(--text-secondary)]">{t('batch.duplicateBody')}</p><ul className="space-y-3 text-sm text-[var(--text)]">{duplicateCandidateGroups.map((group) => <li key={group.key}><h3 className="font-bold">{group.label}</h3><ul className="ml-4 list-disc space-y-1">{group.candidates.map((candidate) => <li key={candidate.entry_uuid}><span>{occurrenceLabel(candidate.occurred_start, timezone, locale)} · {duplicateActivity(candidate)}</span>{' '}<span className="text-xs text-[var(--text-secondary)]">#{shortEntryId(candidate.entry_uuid)}</span></li>)}</ul></li>)}</ul><button type="button" disabled={saving || Boolean(finalReceipt)} className={`min-h-11 rounded-xl bg-[var(--primary)] px-4 font-bold text-white ${FOCUS_RING}`} onClick={acknowledgeBatchDuplicates}>{t('batch.duplicateAcknowledge')}</button></section>}
        {duplicateCandidate && <section role="alert" className="mb-4 space-y-3 rounded-xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-4"><h2 className="font-bold text-[var(--text)]">{t('capture.confirm.duplicateTitle')}</h2><p className="text-sm text-[var(--text-secondary)]">{occurrenceLabel(duplicateCandidate.occurred_start, timezone, locale)} · {duplicateActivityLabel}</p>{duplicateCandidate.values.length > 0 && <ul className="space-y-1 text-sm text-[var(--text)]">{duplicateCandidate.values.map((value, index) => { const label = duplicateValueLabel(value, model, locale); return label ? <li key={`${value.attribute_code}:${value.group_index ?? index}`}>{label}</li> : null; })}</ul>}<div className="flex flex-wrap gap-2"><button type="button" disabled={saving || Boolean(finalReceipt)} className={`min-h-11 rounded-xl border border-[var(--primary)] px-4 font-bold text-[var(--primary)] ${FOCUS_RING}`} onClick={() => { if (!saving && !finalReceipt) onOpenExisting(duplicateCandidate.entry_uuid); }}>{t('capture.confirm.openExisting')}</button><button type="button" className={`min-h-11 rounded-xl bg-[var(--primary)] px-4 font-bold text-white ${FOCUS_RING}`} onClick={saveSeparately} disabled={saving || Boolean(finalReceipt)}>{t('capture.confirm.saveSeparately')}</button></div>{duplicateWarningShown && <p role="status" className="text-sm font-semibold text-[var(--text-secondary)]">{t('capture.confirm.duplicateBody')}</p>}</section>}
        {/* Review fix: the plot-scoped crop-cycle overlap fetch (effect above)
            is asynchronous and, for a multi-plot batch, `next()` advances
            details -> confirm synchronously with no in-flight gate on it —
            so the same-crop prompt can resolve to "required" only AFTER the
            user has already reached Confirm. Without this, Finalize would go
            silently disabled (via cycleActionSatisfied in finalizeDisabled
            below) with no visible explanation. Mirrors how a duplicate
            candidate is also surfaced here rather than only on Details. */}
        {cycleActionRequired && cycleAction == null && (
          <section role="alert" className="mb-4 space-y-3 rounded-xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-4">
            <h2 className="font-bold text-[var(--text)]">{t('capture.cycle.sameCropTitle')}</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCycleAction('continue')}
                className={`min-h-11 rounded-xl border border-[var(--primary)] px-4 font-bold text-[var(--primary)] ${FOCUS_RING}`}
              >
                {t('capture.cycle.continueCycle')}
              </button>
              <button
                type="button"
                onClick={() => setCycleAction('new')}
                className={`min-h-11 rounded-xl bg-[var(--primary)] px-4 font-bold text-white ${FOCUS_RING}`}
              >
                {t('capture.cycle.startNewCycle')}
              </button>
            </div>
          </section>
        )}
        {isMultiPlot && <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text-secondary)]">{t('batch.confirmCount', { count: selectedPlotUuids.length })}</p>}
        <ConfirmStrip activity={{ label: t('capture.confirm.activity'), value: leaf ? catalogLabel(catalog.vocab.find((row) => row.code === leaf.activity_code) ?? { code: leaf?.activity_code ?? '' }, locale) : '', step: 'activity' }} plot={{ label: t('capture.confirm.plot'), value: selectedPlotLabel, step: 'where' }} layout={{ label: t('capture.confirm.layout'), value: `${catalogLabel(catalog.layouts.find((row) => row.code === layout?.code) ?? { code: layout?.code ?? '' }, locale)} · v${layout?.version}`, step: 'where' }} occurrence={{ label: t('capture.confirm.occurrence'), value: resolved ? occurrenceLabel(resolved.instant, timezone, locale) : occurredLocal, timezone, endTimezone: occurredEndLocal ? timezone : null, step: 'details' }} values={confirmValues} onEdit={edit} onFinalize={() => { void finalize().catch(() => undefined); }} validationInFlight={showValidation && !formValid} duplicateInFlight={duplicateInFlight} saveInFlight={saving} editDisabled={interactionLocked} readOnly={Boolean(finalReceipt)} finalizeDisabled={Boolean(duplicateCandidate && duplicateAck !== duplicateCandidate.entry_uuid) || duplicateCandidates.length > 0 || pendingTransitionItems.length > 0 || !cycleActionSatisfied || Boolean(cycleDisambiguationOptions)} />
      </>
    );
  };

  return (
    <div className="min-h-full bg-[var(--bg)] px-4 py-5">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-3"><h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-[var(--text)]">{t('capture.title')}</h1><button type="button" disabled={closeLocked} onClick={() => { void close().catch(() => undefined); }} className={`min-h-11 rounded-xl px-3 font-bold text-[var(--primary)] ${FOCUS_RING}`}>{t('capture.close')}</button></header>
      <div className="mx-auto mt-5 max-w-3xl space-y-5">
        {pendingTransitionItems.length > 0 && !transitionSheetOpen && (
          <section role="alert" className="space-y-2 rounded-xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-3">
            <p className="text-sm font-semibold text-[var(--text)]">
              {t('capture.transition.pendingBanner')}
            </p>
            <button
              type="button"
              onClick={() => setTransitionSheetOpen(true)}
              className={`min-h-11 rounded-xl bg-[var(--primary)] px-4 font-bold text-white ${FOCUS_RING}`}
            >
              {t('capture.transition.reviewAction')}
            </button>
          </section>
        )}
        {cycleDisambiguationOptions && (
          <CycleDisambiguationSheet
            model={model}
            locale={locale}
            options={cycleDisambiguationOptions}
            onChoose={(chosen) => setCycleUuid(chosen)}
            onCancel={() => { setCycleDisambiguationOptions(null); setPendingCycleRetry(false); }}
          />
        )}
        {body()}
        {receiptHarvestGroups.length > 0 && (
          <HarvestGroupNudge
            groups={receiptHarvestGroups}
            onResolve={resolveHarvestGroup}
            errors={groupResolutionErrors}
          />
        )}
        <div className="flex flex-wrap justify-between gap-3">{step !== 'where' && <button type="button" disabled={interactionLocked} onClick={() => { if (interactionLocked) return; preparationTokenRef.current += 1; setStep(step === 'confirm' ? 'details' : step === 'details' ? 'activity' : 'where'); }} className={`min-h-11 rounded-xl px-4 font-bold text-[var(--primary)] ${FOCUS_RING}`}>{t('capture.back')}</button>}<span />{step !== 'confirm' && <button type="button" onClick={next} disabled={(step === 'activity' && !leaf) || (step === 'details' && preparingConfirm) || interactionLocked} style={{ minHeight: '56px' }} className={`min-h-11 rounded-xl bg-[var(--primary)] px-5 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}>{t('capture.next')}</button>}</div>
        {!duplicateCandidate && duplicateCandidates.length === 0 && (step === 'confirm' || draft.lossWarning || stickyLossWarning) && <SaveState status={saveStateStatus} lossWarning={draft.lossWarning || stickyLossWarning} onRetry={async () => { await retry(); }} />}
      </div>
      {transitionSheetOpen && pendingTransitionItems.length > 0 && (
        <LayoutTransitionReviewSheet
          items={pendingTransitionItems}
          model={model}
          locale={locale}
          onResolve={resolveTransitionItem}
          onRequestClose={() => setTransitionSheetOpen(false)}
        />
      )}
    </div>
  );
};

function fallbackLayout(model: JournalCaptureCatalogModel): JournalLayoutDefinition {
  return [...model.layouts.values()][0] ?? {
    code: '', version: 0, activity_codes: [], supported_templates: [], fields: [], minimum_fields: [], conditional_fields: {}, denominator_contract: [], option_dependencies: [],
  };
}
