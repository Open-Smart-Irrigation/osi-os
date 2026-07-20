import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { catalogLabel } from '../../../journal/catalogModel';
import { activeCropChoices } from '../../../journal/cropCycle';
import { buildCorrectionPayload } from '../../../journal/entryCorrection';
import { journalApi } from '../../../services/journalApi';
import type { CaptureEntryValueOutput, JournalCaptureCatalogModel } from '../../../types/journalCapture';
import type { EntryAggregate } from '../../../types/journal';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';
const CORRECTED_ATTRIBUTE_CODES: ReadonlySet<string> = new Set(['attr.crop', 'attr.variety']);

export interface InheritedCropBannerProps {
  model: JournalCaptureCatalogModel;
  locale: string;
  cropCode: string;
  variety: string | null;
  /** Local calendar date (YYYY-MM-DD) the covering seeding was recorded against. */
  seededDate: string;
  seedingEntryUuid: string;
  onOpenSeedingEntry?: (entryUuid: string) => void;
  /** Called after a successful inline correction so the parent can refresh its own cycle-derived state. */
  onCorrected?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStaleVersionError(error: unknown): boolean {
  const status = isRecord(error) && isRecord(error.response) ? error.response.status : undefined;
  return status === 409;
}

function isDesyncError(error: unknown): boolean {
  const response = isRecord(error) && isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;
  return data?.error === 'correction_would_desync_cycle';
}

function entryAttributeValue(entry: EntryAggregate, attributeCode: string): string | null {
  const match = entry.values.find((value) =>
    value.attribute_code === attributeCode && (value.group_index ?? 0) === 0 &&
    value.value_status === 'observed');
  return match?.value_text?.trim() ? match.value_text.trim() : null;
}

function localizedDate(value: string, locale: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

// D3.3 (D8/R2): a read-only strip shown on a non-seeding activity whose plot
// is covered by an open crop cycle — "🌱 <crop> · <variety> · seeded
// <date>". The crop·variety text is tappable and opens a lightweight inline
// sheet that corrects the SEEDING entry (the single source of truth for the
// cycle's crop/variety, per D13) via the existing entry-correction API
// (journal/entryCorrection.ts + journalApi.updateEntry) — never a crop field
// on the activity form itself. The seeded-date also links to the seeding
// entry.
export function InheritedCropBanner({
  model,
  locale,
  cropCode,
  variety,
  seededDate,
  seedingEntryUuid,
  onOpenSeedingEntry,
  onCorrected,
}: InheritedCropBannerProps) {
  const { t } = useTranslation('journal');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [aggregate, setAggregate] = useState<EntryAggregate | null>(null);
  const [draftCrop, setDraftCrop] = useState('');
  const [draftVariety, setDraftVariety] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const [desyncError, setDesyncError] = useState(false);
  const [genericError, setGenericError] = useState(false);

  const cropRow = model.vocabByCode.get(cropCode);
  const cropText = cropRow ? catalogLabel(cropRow, locale) : cropCode;
  const bannerText = variety
    ? t('capture.cycle.bannerCropVariety', { crop: cropText, variety })
    : cropText;
  const choices = activeCropChoices(model, locale);

  const openSheet = async () => {
    setSheetOpen(true);
    setLoadError(false);
    setStaleError(false);
    setDesyncError(false);
    setGenericError(false);
    setLoading(true);
    try {
      const response = await journalApi.listEntries({ entry_uuid: seedingEntryUuid, status: 'all', limit: 1 });
      const found = response.entries.find((entry) => entry.entry_uuid === seedingEntryUuid) ?? null;
      setAggregate(found);
      if (!found) {
        setLoadError(true);
      } else {
        setDraftCrop(entryAttributeValue(found, 'attr.crop') ?? cropCode);
        setDraftVariety(entryAttributeValue(found, 'attr.variety') ?? variety ?? '');
      }
    } catch {
      setAggregate(null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setAggregate(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!aggregate || draftCrop.trim() === '') return;
    setSubmitting(true);
    setStaleError(false);
    setDesyncError(false);
    setGenericError(false);
    const trimmedVariety = draftVariety.trim();
    const editedValues: CaptureEntryValueOutput[] = [
      { attribute_code: 'attr.crop', value_status: 'observed', value: draftCrop },
      ...(trimmedVariety ? [{ attribute_code: 'attr.variety', value_status: 'observed' as const, value: trimmedVariety }] : []),
    ];
    try {
      const payload = buildCorrectionPayload(aggregate, CORRECTED_ATTRIBUTE_CODES, editedValues);
      await journalApi.updateEntry(aggregate.entry_uuid, payload);
      setSubmitting(false);
      closeSheet();
      onCorrected?.();
    } catch (failure) {
      if (isStaleVersionError(failure)) setStaleError(true);
      else if (isDesyncError(failure)) setDesyncError(true);
      else setGenericError(true);
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm text-[var(--text)]">
      <p>
        <span aria-hidden="true">🌱 </span>
        <button
          type="button"
          onClick={() => { void openSheet(); }}
          className={`font-bold underline decoration-dotted underline-offset-2 ${FOCUS_RING}`}
        >
          {bannerText}
        </button>
        {' · '}
        {onOpenSeedingEntry ? (
          <button
            type="button"
            onClick={() => onOpenSeedingEntry(seedingEntryUuid)}
            className={`underline decoration-dotted underline-offset-2 ${FOCUS_RING}`}
          >
            {t('capture.cycle.bannerSeeded', { date: localizedDate(seededDate, locale) })}
          </button>
        ) : (
          <span>{t('capture.cycle.bannerSeeded', { date: localizedDate(seededDate, locale) })}</span>
        )}
      </p>

      {sheetOpen && (
        <div className="mt-3 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <h3 className="font-bold text-[var(--text)]">{t('capture.cycle.correctTitle')}</h3>
          {loading && <p role="status" className="text-[var(--text-secondary)]">{t('where.loading')}</p>}
          {!loading && loadError && (
            <p role="alert" className="font-semibold text-[var(--error-text)]">{t('capture.cycle.correctError')}</p>
          )}
          {!loading && aggregate && (
            <form onSubmit={(event) => { void submit(event); }} className="space-y-3">
              <label className="block space-y-2">
                <span className="block text-sm font-bold text-[var(--text)]">{t('capture.cycle.cropLabel')}</span>
                <select
                  required
                  value={draftCrop}
                  disabled={submitting}
                  onChange={(event) => setDraftCrop(event.target.value)}
                  className={`min-h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
                >
                  <option value="">{t('capture.cycle.selectCrop')}</option>
                  {choices.map((choice) => <option key={choice.code} value={choice.code}>{choice.label}</option>)}
                </select>
              </label>
              <label className="block space-y-2">
                <span className="block text-sm font-bold text-[var(--text)]">{t('capture.cycle.varietyLabel')}</span>
                <input
                  type="text"
                  maxLength={120}
                  value={draftVariety}
                  disabled={submitting}
                  onChange={(event) => setDraftVariety(event.target.value)}
                  className={`w-full ${TOUCH_CONTROL} rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
                />
              </label>
              {staleError && (
                <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t('capture.cycle.correctStale')}</p>
              )}
              {desyncError && (
                <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t('capture.cycle.correctDesynced')}</p>
              )}
              {genericError && (
                <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">{t('capture.cycle.correctError')}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={closeSheet}
                  className={`flex-1 rounded-lg border border-[var(--border)] px-3 py-2 font-bold ${FOCUS_RING}`}
                >
                  {t('capture.cycle.correctCancel')}
                </button>
                <button
                  type="submit"
                  disabled={submitting || draftCrop.trim() === ''}
                  className={`flex-1 rounded-lg bg-[var(--primary)] px-3 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
                >
                  {submitting ? t('capture.cycle.correctSaving') : t('capture.cycle.correctSave')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
