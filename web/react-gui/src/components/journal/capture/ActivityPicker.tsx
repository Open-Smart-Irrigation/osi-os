import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { JournalVocabRow } from '../../../types/journal';
import type {
  ActivityDependentSelection,
  ActivityLeafSelection,
} from '../../../types/journalCapture';

interface ActivityPickerProps {
  catalogRows: JournalVocabRow[];
  plotRecent: ActivityLeafSelection[];
  seasonCommon: ActivityLeafSelection[];
  farmRecent: ActivityLeafSelection[];
  layoutFallback: ActivityLeafSelection[];
  zoneLinked: boolean;
  locale: string;
  onPick: (leaf: ActivityLeafSelection) => void;
}

interface RankedSection {
  label: string;
  leaves: ActivityLeafSelection[];
}

interface BrowseState {
  activityCode: string | null;
  selections: ActivityDependentSelection[];
}

const MAX_DEFAULT_LEAVES = 6;

const ACTIVITY_ICONS: Record<string, string> = {
  droplets: '💧',
  fertilizer: '▦',
  fertigation: '◈',
  plant_protection: '◇',
  weed_control: '⌁',
  seeding: '•',
  planting: '♧',
  pruning: '⌇',
  crop_care: '♢',
  tillage: '≋',
  mowing: '⌁',
  harvest: '⌄',
  sampling: '◉',
  observation: '○',
  pest_disease: '⊙',
  maintenance: '⚙',
};

function leafKey(leaf: ActivityLeafSelection): string {
  return JSON.stringify([
    leaf.activity_code,
    ...leaf.dependent_selections.map(({ attribute_code, value }) => [attribute_code, value]),
  ]);
}

function activeRow(row: JournalVocabRow | undefined): row is JournalVocabRow {
  return Boolean(row && row.active === 1 && row.deleted_at == null);
}

function localizedLabel(row: JournalVocabRow | undefined, locale: string, code: string): string {
  return row?.labels?.[locale]?.trim() || row?.labels?.en?.trim() || code;
}

function normalizeSearch(value: string, locale: string): string {
  let caseFolded: string;
  try {
    caseFolded = value.toLocaleLowerCase(locale);
  } catch {
    caseFolded = value.toLocaleLowerCase();
  }
  return caseFolded
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function prefixMatches(
  leaf: ActivityLeafSelection,
  selections: ActivityDependentSelection[],
): boolean {
  return selections.every((selection, index) => {
    const candidate = leaf.dependent_selections[index];
    return candidate?.attribute_code === selection.attribute_code &&
      candidate.value === selection.value;
  });
}

export function ActivityPicker({
  catalogRows,
  plotRecent,
  seasonCommon,
  farmRecent,
  layoutFallback,
  zoneLinked,
  locale,
  onPick,
}: ActivityPickerProps) {
  const { t } = useTranslation('journal');
  const [query, setQuery] = useState('');
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const browseHeadingRef = useRef<HTMLHeadingElement>(null);
  const pickerHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusPickerAfterBrowseRef = useRef(false);
  const rowsByCode = new Map(catalogRows.map((row) => [row.code, row]));

  const supportedFallback: ActivityLeafSelection[] = [];
  const supportedKeys = new Set<string>();
  for (const candidate of layoutFallback) {
    const activity = rowsByCode.get(candidate.activity_code);
    const key = leafKey(candidate);
    if (!activeRow(activity) || activity.kind !== 'activity' || supportedKeys.has(key)) continue;
    const selectionsExist = candidate.dependent_selections.every(({ value }) => {
      const choice = rowsByCode.get(value);
      return activeRow(choice) && choice.kind === 'choice';
    });
    if (!selectionsExist) continue;
    supportedKeys.add(key);
    supportedFallback.push(candidate);
  }

  const labelForCode = (code: string): string =>
    localizedLabel(rowsByCode.get(code), locale, code);
  const leafLabels = (leaf: ActivityLeafSelection): string[] => [
    labelForCode(leaf.activity_code),
    ...leaf.dependent_selections.map(({ value }) => labelForCode(value)),
  ];
  const leafLabel = (leaf: ActivityLeafSelection): string => leafLabels(leaf).join(' / ');
  const leafSearchText = (leaf: ActivityLeafSelection): string => {
    const codes = [
      leaf.activity_code,
      ...leaf.dependent_selections.flatMap(({ attribute_code, value }) => [attribute_code, value]),
    ];
    const labels = codes.flatMap((code) => {
      const row = rowsByCode.get(code);
      return row?.labels ? Object.values(row.labels) : [];
    });
    return normalizeSearch([...codes, ...labels].join(' '), locale);
  };

  const rankedSections: RankedSection[] = [];
  const rankedKeys = new Set<string>();
  let remaining = MAX_DEFAULT_LEAVES;
  const addSection = (label: string, candidates: ActivityLeafSelection[]) => {
    if (remaining === 0) return;
    const leaves: ActivityLeafSelection[] = [];
    for (const candidate of candidates) {
      const key = leafKey(candidate);
      if (!supportedKeys.has(key) || rankedKeys.has(key)) continue;
      rankedKeys.add(key);
      leaves.push(candidate);
      remaining -= 1;
      if (remaining === 0) break;
    }
    if (leaves.length > 0) rankedSections.push({ label, leaves });
  };
  addSection(t('capture.picker.recentOnPlot'), plotRecent);
  addSection(
    zoneLinked ? t('capture.picker.commonThisSeason') : t('capture.picker.farmRecent'),
    zoneLinked ? seasonCommon : farmRecent,
  );
  addSection(t('capture.picker.allOptions'), supportedFallback);

  const normalizedQuery = normalizeSearch(query, locale);
  const searchResults = normalizedQuery
    ? supportedFallback.filter((candidate) => leafSearchText(candidate).includes(normalizedQuery))
    : [];

  const activityIcon = (leaf: ActivityLeafSelection): string => {
    const iconKey = rowsByCode.get(leaf.activity_code)?.icon_key ?? '';
    return ACTIVITY_ICONS[iconKey] ?? '○';
  };

  const leafButton = (leaf: ActivityLeafSelection) => (
    <button
      key={leafKey(leaf)}
      type="button"
      aria-label={leafLabel(leaf)}
      onClick={() => onPick(leaf)}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-left text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2"
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary-bg)] text-lg text-[var(--primary)]"
      >
        {activityIcon(leaf)}
      </span>
      <span className="min-w-0 leading-tight">{leafLabel(leaf)}</span>
    </button>
  );

  const openActivity = (activityCode: string) => {
    const candidates = supportedFallback.filter((leaf) => leaf.activity_code === activityCode);
    const directLeaf = candidates.find((leaf) => leaf.dependent_selections.length === 0);
    if (directLeaf) {
      onPick(directLeaf);
      return;
    }
    setBrowse({ activityCode, selections: [] });
  };

  const chooseDependency = (selection: ActivityDependentSelection) => {
    if (!browse?.activityCode) return;
    const selections = [...browse.selections, selection];
    const candidates = supportedFallback.filter((leaf) =>
      leaf.activity_code === browse.activityCode && prefixMatches(leaf, selections));
    const complete = candidates.find((leaf) => leaf.dependent_selections.length === selections.length);
    if (complete) {
      onPick(complete);
      return;
    }
    setBrowse({ activityCode: browse.activityCode, selections });
  };

  const supportedSignature = supportedFallback.map(leafKey).join('\u0000');
  useEffect(() => {
    setBrowse((current) => {
      if (!current?.activityCode) return current;
      const activityLeaves = supportedFallback.filter((leaf) =>
        leaf.activity_code === current.activityCode);
      if (activityLeaves.length === 0) return { activityCode: null, selections: [] };
      let selections = current.selections;
      while (selections.length > 0 &&
          !activityLeaves.some((leaf) => prefixMatches(leaf, selections))) {
        selections = selections.slice(0, -1);
      }
      return selections.length === current.selections.length
        ? current
        : { activityCode: current.activityCode, selections };
    });
  }, [supportedSignature]);

  useEffect(() => {
    if (browse) {
      browseHeadingRef.current?.focus();
    } else if (focusPickerAfterBrowseRef.current) {
      focusPickerAfterBrowseRef.current = false;
      pickerHeadingRef.current?.focus();
    }
  }, [browse]);

  const browseContent = () => {
    if (!browse) return null;
    if (!browse.activityCode) {
      const activityCodes = supportedFallback
        .map((leaf) => leaf.activity_code)
        .filter((code, index, all) => all.indexOf(code) === index);
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                focusPickerAfterBrowseRef.current = true;
                setBrowse(null);
              }}
              className="min-h-11 rounded-lg px-3 text-sm font-semibold text-[var(--primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              {t('capture.back')}
            </button>
            <h3
              ref={browseHeadingRef}
              tabIndex={-1}
              className="text-base font-bold text-[var(--text)] outline-none"
            >
              {t('capture.picker.allOptions')}
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {activityCodes.map((code) => {
              const representative = supportedFallback.find((leaf) => leaf.activity_code === code);
              if (!representative) return null;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => openActivity(code)}
                  className="min-h-14 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                >
                  {labelForCode(code)}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    const candidates = supportedFallback.filter((leaf) =>
      leaf.activity_code === browse.activityCode && prefixMatches(leaf, browse.selections));
    const nextIndex = browse.selections.length;
    const nextAttribute = candidates[0]?.dependent_selections[nextIndex]?.attribute_code;
    const options = candidates
      .map((leaf) => leaf.dependent_selections[nextIndex])
      .filter((selection): selection is ActivityDependentSelection => Boolean(selection))
      .filter((selection, index, all) => all.findIndex((candidate) =>
        candidate.attribute_code === selection.attribute_code && candidate.value === selection.value) === index);
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setBrowse(browse.selections.length === 0
              ? { activityCode: null, selections: [] }
              : {
                activityCode: browse.activityCode,
                selections: browse.selections.slice(0, -1),
              })}
            className="min-h-11 rounded-lg px-3 text-sm font-semibold text-[var(--primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
          >
            {t('capture.back')}
          </button>
          <div>
            <p className="text-xs font-semibold text-[var(--text-secondary)]">
              {labelForCode(browse.activityCode)}
            </p>
            <h3
              ref={browseHeadingRef}
              tabIndex={-1}
              className="text-base font-bold text-[var(--text)] outline-none"
            >
              {nextAttribute ? labelForCode(nextAttribute) : t('capture.picker.allOptions')}
            </h3>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {options.map((selection) => (
            <button
              key={`${selection.attribute_code}:${selection.value}`}
              type="button"
              onClick={() => chooseDependency(selection)}
              className="min-h-14 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              {labelForCode(selection.value)}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-4" aria-labelledby="activity-picker-title">
      <div>
        <h2
          ref={pickerHeadingRef}
          id="activity-picker-title"
          tabIndex={-1}
          className="text-lg font-bold text-[var(--text)] outline-none"
        >
          {t('capture.picker.title')}
        </h2>
        <label className="mt-3 block">
          <span className="sr-only">{t('capture.picker.search')}</span>
          <input
            type="search"
            aria-label={t('capture.picker.search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setBrowse(null);
            }}
            placeholder={t('capture.picker.searchPlaceholder')}
            className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--focus)]"
          />
        </label>
      </div>

      {normalizedQuery ? (
        searchResults.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {searchResults.map(leafButton)}
          </div>
        ) : (
          <p role="status" className="rounded-xl bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
            {t('capture.picker.noResults')}
          </p>
        )
      ) : browse ? (
        browseContent()
      ) : (
        <>
          {rankedSections.map((section) => (
            <section key={section.label} aria-label={section.label} className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                {section.label}
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {section.leaves.map(leafButton)}
              </div>
            </section>
          ))}
          {supportedFallback.length === 0 ? (
            <p role="status" className="rounded-xl bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
              {t('capture.picker.noResults')}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setBrowse({ activityCode: null, selections: [] })}
              className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-bold text-[var(--primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              {t('capture.picker.browseAll')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
