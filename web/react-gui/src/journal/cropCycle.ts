// Slice D Phase 3 (GUI): client-side helpers for the crop-cycle lifecycle
// (docs/superpowers/specs/2026-07-20-journal-capture-streamlining-design.md
// §6/§7; plan docs/superpowers/plans/2026-07-20-journal-slice-d-crop-cycle.md
// task D-3). The edge (osi-journal/lifecycle.js) is the authority on cycle
// state — journal_crop_cycles/journal_crop_cycle_plots are never exposed to
// the GUI directly. Everything here is either:
//   (a) a read of the plot's own AUTHORITATIVE active_crop_cycles (Slice D
//       hardening, P1-a/P1-b — see osi-journal/api.js listPlots), used to
//       decide when to show a prompt/banner and to suppress a redundant crop
//       requirement the app already has via the cycle,
//   (b) a parser for the structured error details the edge returns when it
//       needs the caller to disambiguate (cycle_uuid_required/
//       cycle_not_found) or confirm a cascade (cycle_has_dependents) —
//       mirroring the duplicate-candidate error-parsing pattern already used
//       in JournalCaptureFlow.tsx.
//
// Slice D hardening (P1-b) note: currentCropInfoForPlot previously inferred
// "what is currently growing" from the MOST RECENT final entry with a
// resolved season_crop. That is fundamentally unable to distinguish a crop
// still growing from one whose cycle has since closed: freezeClosedSpan (see
// osi-journal/lifecycle.js) stamps season_crop on every entry in a closed
// cycle's span, so a frozen/historical crop and a live one are stored
// identically once written. Only the edge's own open/closed bookkeeping
// (journal_crop_cycle_plots.ends_on) can tell them apart, hence
// active_crop_cycles below.
import type { ActiveCropCycle, EntryAggregate } from '../types/journal';
import type { JournalCaptureCatalogModel } from '../types/journalCapture';
import { catalogLabel } from './catalogModel';

export const SEEDING_ACTIVITY_CODES: ReadonlySet<string> = new Set([
  'seeding', 'planting_transplanting',
]);

export const MANUAL_CLOSE_ACTIVITY_CODES: ReadonlySet<string> = new Set([
  'tillage_soil_work', 'mowing', 'plant_protection_application',
]);

export interface CropChoiceOption {
  code: string;
  label: string;
}

// All active, non-deleted choices under attr.crop — the controlled crop list
// (spec §9: the 26 Agroscope crops plus the farmer-facing additions), sorted
// by the catalog's own sort_order (export/display order), matching how
// EntryForm/allowedChoices already order choice options.
export function activeCropChoices(
  model: JournalCaptureCatalogModel,
  locale: string,
): CropChoiceOption[] {
  return [...model.vocabByCode.values()]
    .filter((row) => row.kind === 'choice' && row.parent_code === 'attr.crop' &&
      row.active === 1 && row.deleted_at == null)
    .sort((left, right) => left.sort_order - right.sort_order || left.code.localeCompare(right.code))
    .map((row) => ({ code: row.code, label: catalogLabel(row, locale) }));
}

function entryAttributeValue(entry: EntryAggregate, attributeCode: string): string | null {
  const match = entry.values.find((value) =>
    value.attribute_code === attributeCode && (value.group_index ?? 0) === 0 &&
    value.value_status === 'observed');
  return match?.value_text?.trim() ? match.value_text.trim() : null;
}

function isUsableEntry(entry: EntryAggregate): boolean {
  return entry.status === 'final' && entry.deleted_at == null;
}

// D3.1 variety autocomplete (brief: "derive from crop/variety already present
// in loaded entries/plots client-side"). Distinct, non-empty attr.variety
// values recorded on final seeding/planting entries whose OWN attr.crop
// matches cropCode, drawn only from already-loaded `entries` — no dedicated
// edge endpoint exists for this and none is added here.
export function varietySuggestionsFor(
  cropCode: string,
  entries: readonly EntryAggregate[],
): string[] {
  if (!cropCode) return [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isUsableEntry(entry) || !SEEDING_ACTIVITY_CODES.has(entry.activity_code)) continue;
    if (entryAttributeValue(entry, 'attr.crop') !== cropCode) continue;
    const variety = entryAttributeValue(entry, 'attr.variety');
    if (variety) seen.add(variety);
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

export interface CurrentCropInfo {
  crop_code: string;
  variety: string | null;
  /** Local calendar date (YYYY-MM-DD) the covering cycle started. */
  seededDate: string;
  /** The seeding/planting entry that opened the covering cycle. */
  seedingEntryUuid: string;
}

// P1-a/P1-b (Slice D hardening): the authoritative "what is this plot's open
// crop cycle right now" signal, read from the plot's OWN active_crop_cycles
// (osi-journal/api.js listPlots — see the module doc comment above for why
// entries' season_crop can never answer this correctly). Non-null only when
// EXACTLY ONE cycle is open: zero means nothing is growing, and more than
// one is a genuinely intercropped plot where "the" current crop is
// ambiguous — deferred to the capture form / disambiguation flow (R7),
// exactly like the edge's own resolveLiveCropOverrides leaves an
// intercropped entry's stored value alone rather than guessing. Used to
// decide whether to show the D3.2 same-crop continue/new prompt, the D3.3
// inherited-crop banner, and (P1-a) whether the Where/Activity steps may
// skip the crop-entry requirement — never sent to the edge as authoritative.
export function currentCropInfoForPlot(
  activeCropCycles: readonly ActiveCropCycle[] | null | undefined,
): CurrentCropInfo | null {
  const cycles = activeCropCycles ?? [];
  if (cycles.length !== 1) return null;
  const [cycle] = cycles;
  return {
    crop_code: cycle.crop_code,
    variety: cycle.variety?.trim() ? cycle.variety : null,
    seededDate: cycle.seeded_on,
    seedingEntryUuid: cycle.opened_by_entry_uuid,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  return data && typeof data.error === 'string' ? data.error
    : data && typeof data.code === 'string' ? data.code
      : typeof error.code === 'string' ? error.code : null;
}

function errorDetails(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error)) return null;
  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  const details = data && isRecord(data.details) ? data.details : null;
  return details ?? (isRecord(error.details) ? error.details : null);
}

export interface CycleOption {
  cycle_uuid: string;
  crop_code: string;
  variety: string | null;
}

function isCycleOption(value: unknown): value is CycleOption {
  return isRecord(value) && typeof value.cycle_uuid === 'string' && typeof value.crop_code === 'string' &&
    (value.variety === null || value.variety === undefined || typeof value.variety === 'string');
}

// R7: seeding, harvest, and manual-close all refuse an intercropped plot
// (>1 open cycle covering it) with this error unless the caller names
// cycle_uuid — see osi-journal/lifecycle.js cycleDisambiguationError /
// selectTargetCycle. The refusal already carries every open cycle's
// crop/variety, so the GUI can show a picker without a dedicated endpoint.
export function cycleDisambiguationFromError(error: unknown): CycleOption[] | null {
  const code = errorCode(error);
  if (code !== 'cycle_uuid_required' && code !== 'cycle_not_found') return null;
  const details = errorDetails(error);
  const openCycles = details?.openCycles;
  if (!Array.isArray(openCycles)) return null;
  const options = openCycles
    .filter(isCycleOption)
    .map((option) => ({ cycle_uuid: option.cycle_uuid, crop_code: option.crop_code, variety: option.variety ?? null }));
  return options.length > 0 ? options : null;
}

// D13/R7: voiding a seeding whose crop cycle has dependent entries (other
// entries currently relying on it live, or already frozen by it) is refused
// with this error and the affected entry_uuids, unless cascade_ack is set —
// see osi-journal/lifecycle.js applyVoidCycleCascade / findCycleDependents.
export function cycleDependentsFromError(error: unknown): string[] | null {
  if (errorCode(error) !== 'cycle_has_dependents') return null;
  const details = errorDetails(error);
  const dependents = details?.dependentEntryUuids;
  if (!Array.isArray(dependents)) return null;
  const uuids = dependents.filter((value): value is string => typeof value === 'string');
  return uuids.length > 0 ? uuids : null;
}

export function cycleOptionLabel(
  option: CycleOption,
  model: JournalCaptureCatalogModel,
  locale: string,
): string {
  const crop = model.vocabByCode.get(option.crop_code);
  const cropLabel = crop ? catalogLabel(crop, locale) : option.crop_code;
  return option.variety ? `${cropLabel} · ${option.variety}` : cropLabel;
}
