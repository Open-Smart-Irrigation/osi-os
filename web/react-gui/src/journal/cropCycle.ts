// Slice D Phase 3 (GUI): client-side helpers for the crop-cycle lifecycle
// (docs/superpowers/specs/2026-07-20-journal-capture-streamlining-design.md
// §6/§7; plan docs/superpowers/plans/2026-07-20-journal-slice-d-crop-cycle.md
// task D-3). The edge (osi-journal/lifecycle.js) is the authority on cycle
// state — journal_crop_cycles/journal_crop_cycle_plots are never exposed to
// the GUI directly. Everything here is either:
//   (a) a best-effort client-side READ of already-loaded entries, used only
//       to decide when to show a prompt/banner (the edge silently falls back
//       to a safe default — "continue" — if the GUI's guess is wrong; a
//       missed differing-crop reseed is never ambiguous server-side either),
//       or
//   (b) a parser for the structured error details the edge returns when it
//       needs the caller to disambiguate (cycle_uuid_required/
//       cycle_not_found) or confirm a cascade (cycle_has_dependents) —
//       mirroring the duplicate-candidate error-parsing pattern already used
//       in JournalCaptureFlow.tsx.
import type { EntryAggregate } from '../types/journal';
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

function byOccurredDesc(left: EntryAggregate, right: EntryAggregate): number {
  return Date.parse(right.occurred_start) - Date.parse(left.occurred_start);
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
  /** occurred_start (UTC instant) of the entry the crop info was read from. */
  asOfOccurredStart: string;
}

// Best-effort "what is currently growing on this plot" signal, read from the
// MOST RECENT final entry on the plot that carries a resolved crop
// (season_crop/season_variety — live-overridden by the edge for any entry an
// open cycle currently covers, see osi-journal/lifecycle.js
// resolveLiveCropOverrides). Used only to decide whether to show the D3.2
// same-crop continue/new prompt and the D3.3 inherited-crop banner — never
// sent to the edge as authoritative. `entries` should already be scoped to a
// single plot_uuid (a fresh, plot-scoped fetch — the general-purpose
// `recentEntries` prop is not reliably plot-scoped).
export function currentCropInfoForPlot(entries: readonly EntryAggregate[]): CurrentCropInfo | null {
  const covering = entries
    .filter((entry) => isUsableEntry(entry) && entry.season_crop != null && entry.season_crop.trim() !== '')
    .sort(byOccurredDesc);
  const latest = covering[0];
  if (!latest?.season_crop) return null;
  return {
    crop_code: latest.season_crop,
    variety: latest.season_variety?.trim() ? latest.season_variety : null,
    asOfOccurredStart: latest.occurred_start,
  };
}

export interface SeedingEntryRef {
  entry_uuid: string;
  /** Local calendar date (YYYY-MM-DD) the seeding was recorded against. */
  occurredDate: string;
}

// Best-effort reverse lookup for the D3.3 banner's "seeded {date}" link and
// inline-correction target: among final seeding/planting entries on the
// plot, the most recent one whose OWN recorded attr.crop/attr.variety match
// the currently-displayed crop/variety exactly. A "continue" seeding never
// opens a new cycle row (see osi-journal/lifecycle.js
// applySeedingCycleEffect), so the entry that originally opened the still-
// open cycle is not always the most recent seeding entry on the plot — this
// match-by-recorded-value walk finds the right one without needing the edge
// to expose cycle_uuid/opened_by_entry_uuid directly.
export function findSeedingEntryFor(
  entries: readonly EntryAggregate[],
  cropCode: string,
  variety: string | null,
): SeedingEntryRef | null {
  const candidates = entries
    .filter((entry) => isUsableEntry(entry) && SEEDING_ACTIVITY_CODES.has(entry.activity_code))
    .sort(byOccurredDesc);
  for (const entry of candidates) {
    if (entryAttributeValue(entry, 'attr.crop') !== cropCode) continue;
    if ((entryAttributeValue(entry, 'attr.variety') ?? null) !== variety) continue;
    return { entry_uuid: entry.entry_uuid, occurredDate: entry.occurred_start.slice(0, 10) };
  }
  return null;
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
