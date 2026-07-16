import { journalApi } from '../services/journalApi';
import type {
  EntryAggregate,
  EntryListFilters,
  EntryListResponse,
} from '../types/journal';
import type {
  ActivityLeafSelection,
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
} from '../types/journalCapture';
import { deriveActivityLeaves } from './catalogModel';
import { isValidApiInstant } from './occurrence';

export const ACTIVITY_HISTORY_PAGE_SIZE = 100;
export const MAX_ACTIVITY_HISTORY_PAGES = 100;
export const FARM_RECENT_LIMIT = 6;

export interface ActivityShortlist {
  plotRecent: ActivityLeafSelection[];
  seasonCommon: ActivityLeafSelection[];
  farmRecent: ActivityLeafSelection[];
  currentSeasonUuid: string | null;
}

export interface ActivityShortlistOptions {
  model: JournalCaptureCatalogModel;
  layout: JournalLayoutDefinition;
  entries?: unknown[];
  farmEntries?: unknown[];
  plotUuid: string | null;
  zoneLinked: boolean;
  occurrence?: string | null;
}

export interface LoadActivityShortlistOptions extends Omit<ActivityShortlistOptions, 'entries'> {
  listEntries?: (filters: EntryListFilters & { occurred_to?: string }) => Promise<EntryListResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEntryListResponse(value: unknown): value is EntryListResponse {
  return isRecord(value) && Array.isArray(value.entries) &&
    (value.next_cursor === null || typeof value.next_cursor === 'string');
}

function leafKey(leaf: ActivityLeafSelection): string {
  return JSON.stringify([
    leaf.activity_code,
    ...leaf.dependent_selections.map(({ attribute_code, value }) => [attribute_code, value]),
  ]);
}

function validOccurredStart(value: unknown, occurrence: string | null | undefined): value is string {
  if (!isValidApiInstant(value)) return false;
  return !occurrence || isValidApiInstant(occurrence) && Date.parse(value) <= Date.parse(occurrence);
}

function validEntry(
  value: unknown,
  plotUuid: string | null,
  occurrence: string | null | undefined,
): value is EntryAggregate {
  if (!isRecord(value)) return false;
  if (value.status !== 'final' || typeof value.entry_uuid !== 'string' || !value.entry_uuid) return false;
  if (value.plot_uuid !== plotUuid) return false;
  return typeof value.activity_code === 'string' && Boolean(value.activity_code) &&
    validOccurredStart(value.occurred_start, occurrence);
}

function entryValues(entry: EntryAggregate): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  if (Array.isArray(entry.values)) {
    for (const value of entry.values) if (isRecord(value)) values.push(value);
  }
  if (typeof entry.context_json !== 'string') return values;
  try {
    const context: unknown = JSON.parse(entry.context_json);
    if (!isRecord(context) || !Array.isArray(context.values)) return values;
    for (const value of context.values) if (isRecord(value)) values.push(value);
  } catch {
    return values;
  }
  return values;
}

function valueForAttribute(entry: EntryAggregate, attributeCode: string): string | null {
  for (const value of entryValues(entry)) {
    if (value.attribute_code !== attributeCode) continue;
    const candidate = value.value_text ?? value.value;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

function choiceTargetCodes(layout: JournalLayoutDefinition): string[] {
  return layout.option_dependencies
    .filter((dependency) => 'choices' in dependency.restrict)
    .map((dependency) => dependency.restrict.attribute_code)
    .filter((code, index, all) => all.indexOf(code) === index);
}

interface ActivityLeafContext {
  leaves: ActivityLeafSelection[];
  choiceTargets: string[];
}

function deriveActivityLeafContext(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
): ActivityLeafContext {
  return {
    leaves: deriveActivityLeaves(model, layout),
    choiceTargets: choiceTargetCodes(layout),
  };
}

function validChoice(value: string, model: JournalCaptureCatalogModel): boolean {
  const choice = model.vocabByCode.get(value);
  return Boolean(choice && choice.kind === 'choice' && choice.active === 1 && choice.deleted_at == null);
}

function leafMatchesEntry(
  entry: EntryAggregate,
  leaf: ActivityLeafSelection,
  choiceTargets: string[],
  model: JournalCaptureCatalogModel,
): boolean {
  if (leaf.dependent_selections.some(({ value }) => !validChoice(value, model))) return false;
  return choiceTargets.every((target) => {
    const actual = valueForAttribute(entry, target);
    const expected = leaf.dependent_selections.find((selection) => selection.attribute_code === target)?.value ?? null;
    return actual === expected;
  });
}

function leafForEntry(
  entry: EntryAggregate,
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition,
  context: ActivityLeafContext,
): ActivityLeafSelection | null {
  if (!layout.activity_codes.includes(entry.activity_code)) return null;
  return context.leaves
    .find((leaf) => leaf.activity_code === entry.activity_code &&
      leafMatchesEntry(entry, leaf, context.choiceTargets, model)) ?? null;
}

function orderedValidEntries(entries: unknown[], options: ActivityShortlistOptions): EntryAggregate[] {
  return entries
    .filter((entry) => validEntry(entry, options.plotUuid, options.occurrence))
    .sort((left, right) => Date.parse(right.occurred_start) - Date.parse(left.occurred_start)
      || left.entry_uuid.localeCompare(right.entry_uuid));
}

function orderedEntries(
  entries: unknown[],
  options: ActivityShortlistOptions,
  context: ActivityLeafContext,
): Array<{ entry: EntryAggregate; leaf: ActivityLeafSelection }> {
  return orderedValidEntries(entries, options)
    .map((entry) => ({ entry, leaf: leafForEntry(entry, options.model, options.layout, context) }))
    .filter((item): item is { entry: EntryAggregate; leaf: ActivityLeafSelection } => item.leaf != null);
}

function validFarmEntry(
  value: unknown,
  occurrence: string | null | undefined,
  excludedPlotUuid: string | null,
): value is EntryAggregate {
  if (!isRecord(value) || !validOccurredStart(value.occurred_start, occurrence)) return false;
  if (value.status !== 'final' || typeof value.entry_uuid !== 'string' || !value.entry_uuid) return false;
  if (value.plot_uuid !== null && (typeof value.plot_uuid !== 'string' || !value.plot_uuid)) return false;
  return (excludedPlotUuid === null || value.plot_uuid !== excludedPlotUuid) &&
    typeof value.activity_code === 'string' && Boolean(value.activity_code);
}

function orderedFarmEntries(
  entries: unknown[],
  options: ActivityShortlistOptions,
  context: ActivityLeafContext,
): Array<{ entry: EntryAggregate; leaf: ActivityLeafSelection }> {
  return entries
    .filter((entry) => validFarmEntry(entry, options.occurrence, options.plotUuid))
    .sort((left, right) => Date.parse(String(right.occurred_start)) - Date.parse(String(left.occurred_start))
      || String(left.entry_uuid).localeCompare(String(right.entry_uuid)))
    .map((entry) => ({ entry, leaf: leafForEntry(entry, options.model, options.layout, context) }))
    .filter((item): item is { entry: EntryAggregate; leaf: ActivityLeafSelection } => item.leaf != null);
}

function uniqueRecent(items: Array<{ entry: EntryAggregate; leaf: ActivityLeafSelection }>): ActivityLeafSelection[] {
  const seen = new Set<string>();
  return items.flatMap(({ leaf }) => {
    const key = leafKey(leaf);
    if (seen.has(key)) return [];
    seen.add(key);
    return [leaf];
  });
}

function commonSeason(
  items: Array<{ entry: EntryAggregate; leaf: ActivityLeafSelection }>,
  seasonUuid: string | null,
): ActivityLeafSelection[] {
  if (!seasonUuid) return [];
  const counts = new Map<string, { leaf: ActivityLeafSelection; count: number; newest: number }>();
  for (const item of items) {
    if (item.entry.season_uuid !== seasonUuid) continue;
    const key = leafKey(item.leaf);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, {
      leaf: item.leaf,
      count: 1,
      newest: Date.parse(item.entry.occurred_start),
    });
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || right.newest - left.newest || leafKey(left.leaf).localeCompare(leafKey(right.leaf)))
    .map(({ leaf }) => leaf);
}

function buildActivityShortlistWithContext(
  options: ActivityShortlistOptions,
  context: ActivityLeafContext,
): ActivityShortlist {
  const validEntries = orderedValidEntries(options.entries ?? [], options);
  const items = orderedEntries(options.entries ?? [], options, context);
  const plotRecent = uniqueRecent(items);
  if (!options.zoneLinked) {
    const farmItems = orderedFarmEntries(
      options.farmEntries ?? (options.plotUuid === null ? options.entries ?? [] : []),
      options,
      context,
    );
    return {
      plotRecent: options.plotUuid === null ? [] : plotRecent,
      seasonCommon: [],
      farmRecent: uniqueRecent(farmItems).slice(0, FARM_RECENT_LIMIT),
      currentSeasonUuid: null,
    };
  }
  const currentSeasonUuid = validEntries.find((entry) =>
    typeof entry.season_uuid === 'string' && entry.season_uuid.trim().length > 0)?.season_uuid ?? null;
  return {
    plotRecent,
    seasonCommon: commonSeason(items, currentSeasonUuid),
    farmRecent: [],
    currentSeasonUuid,
  };
}

export function buildActivityShortlist(options: ActivityShortlistOptions): ActivityShortlist {
  return buildActivityShortlistWithContext(
    options,
    deriveActivityLeafContext(options.model, options.layout),
  );
}

export async function loadActivityShortlist(options: LoadActivityShortlistOptions): Promise<ActivityShortlist> {
  const listEntries = options.listEntries ?? ((filters) => journalApi.listEntries(filters));
  type EntryFilters = EntryListFilters & { occurred_to?: string };
  const context = deriveActivityLeafContext(options.model, options.layout);

  const loadPages = async (
    plotUuid: string | null,
    shouldStop?: (entries: unknown[]) => boolean,
  ): Promise<unknown[] | null> => {
    const entries: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_ACTIVITY_HISTORY_PAGES; page += 1) {
        const filters: EntryFilters = {
          status: 'final',
          limit: ACTIVITY_HISTORY_PAGE_SIZE,
          ...(plotUuid ? { plot_uuid: plotUuid } : {}),
          ...(options.occurrence ? { occurred_to: options.occurrence } : {}),
          ...(cursor ? { cursor } : {}),
        };
        const response = await listEntries(filters);
        if (!isEntryListResponse(response)) return null;
        entries.push(...response.entries);
        if (shouldStop?.(entries)) return entries;
        const next = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : null;
        if (!next) return entries;
        if (seenCursors.has(next)) return null;
        seenCursors.add(next);
        cursor = next;
      }
    } catch {
      return null;
    }
    return null;
  };

  if (options.plotUuid === null) {
    const farmEntries = await loadPages(null, (entries) =>
      buildActivityShortlistWithContext(
        { ...options, entries: [], farmEntries: entries },
        context,
      ).farmRecent.length >= FARM_RECENT_LIMIT,
    );
    return buildActivityShortlistWithContext(
      { ...options, entries: [], farmEntries: farmEntries ?? [] },
      context,
    );
  }

  const selectedEntries = await loadPages(options.plotUuid);
  if (selectedEntries == null) {
    return buildActivityShortlistWithContext({ ...options, entries: [] }, context);
  }
  if (options.zoneLinked) {
    return buildActivityShortlistWithContext({ ...options, entries: selectedEntries }, context);
  }

  const farmOptions = { ...options, entries: selectedEntries, farmEntries: [] as unknown[] };
  const farmEntries = await loadPages(null, (entries) =>
    buildActivityShortlistWithContext({ ...farmOptions, farmEntries: entries }, context)
      .farmRecent.length >= FARM_RECENT_LIMIT,
  );
  return buildActivityShortlistWithContext(
    { ...farmOptions, farmEntries: farmEntries ?? [] },
    context,
  );
}

export function activityLeafKey(leaf: ActivityLeafSelection): string {
  return leafKey(leaf);
}
