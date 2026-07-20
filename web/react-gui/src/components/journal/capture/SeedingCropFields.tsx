import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { activeCropChoices } from '../../../journal/cropCycle';
import type { JournalCaptureCatalogModel } from '../../../types/journalCapture';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

export interface SeedingCropOverlap {
  crop_code: string;
  variety: string | null;
}

export interface SeedingCropFieldsProps {
  model: JournalCaptureCatalogModel;
  locale: string;
  crop: string;
  // Some catalog templates (the real farmer_quick@3 quick_fields for
  // seeding/planting_transplanting) already declare attr.crop as a normal,
  // catalog-driven EntryForm field. When that's the case the PARENT flow
  // sets this false so this component never renders a second, independently
  // stated crop control bound to different state than the one that actually
  // gets saved — `crop` is then just the value EntryForm already collected,
  // read-only from this component's point of view (the variety field and
  // same-crop prompt below still apply regardless, since attr.variety and
  // the cycle_action prompt never come from the generic catalog form).
  showCropField?: boolean;
  variety: string;
  onCropChange: (code: string) => void;
  onVarietyChange: (value: string) => void;
  varietySuggestions: readonly string[];
  /** An open cycle already covering the target plot(s), if any. */
  overlap: SeedingCropOverlap | null;
  cycleAction: 'continue' | 'new' | null;
  onCycleActionChange: (action: 'continue' | 'new') => void;
  showValidation?: boolean;
}

// D3.1 (group-first seeding, D7) + D3.2 (same-crop reseed prompt, R4): the
// seeding-specific crop dropdown (controlled attr.crop list) and free-text
// variety field (autocomplete sourced client-side, see journal/cropCycle.ts)
// that replace a generic activity form's fields for a seeding/
// planting_transplanting entry. When the crop+variety being entered exactly
// matches an already-open cycle covering the target plot(s), this is the
// load-bearing "continue or start new?" prompt (R4) — the parent flow must
// block finalizing until one is chosen and must send the result as
// cycle_action on the payload (a differing crop/variety never needs this:
// the edge always auto-reseeds it regardless of cycle_action).
export function SeedingCropFields({
  model,
  locale,
  crop,
  showCropField = true,
  variety,
  onCropChange,
  onVarietyChange,
  varietySuggestions,
  overlap,
  cycleAction,
  onCycleActionChange,
  showValidation = false,
}: SeedingCropFieldsProps) {
  const { t } = useTranslation('journal');
  const generatedId = useId().replace(/:/g, '');
  const cropId = `seeding-crop-${generatedId}`;
  const varietyId = `seeding-variety-${generatedId}`;
  const varietyListId = `${varietyId}-list`;
  const choices = activeCropChoices(model, locale);
  const normalizedVariety = variety.trim();
  const overlapping = overlap != null && overlap.crop_code === crop && crop !== '' &&
    (overlap.variety ?? '') === normalizedVariety;
  const cropMissing = showCropField && showValidation && crop.trim() === '';
  const cropErrorId = `${cropId}-error`;
  const promptId = `${cropId}-cycle-prompt`;

  return (
    <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
      {showCropField && (
        <div className="space-y-2">
          <label htmlFor={cropId} className="block text-sm font-bold text-[var(--text)]">
            {t('capture.cycle.cropLabel')}
          </label>
          <select
            id={cropId}
            required
            value={crop}
            aria-invalid={cropMissing}
            aria-describedby={cropMissing ? cropErrorId : undefined}
            onChange={(event) => onCropChange(event.target.value)}
            className={`min-h-12 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
          >
            <option value="">{t('capture.cycle.selectCrop')}</option>
            {choices.map((choice) => (
              <option key={choice.code} value={choice.code}>{choice.label}</option>
            ))}
          </select>
          {cropMissing && (
            <p id={cropErrorId} role="alert" className="text-sm font-semibold text-[var(--error-text)]">
              {t('capture.cycle.cropRequired')}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor={varietyId} className="block text-sm font-bold text-[var(--text)]">
          {t('capture.cycle.varietyLabel')}
        </label>
        <input
          id={varietyId}
          type="text"
          maxLength={120}
          list={varietySuggestions.length > 0 ? varietyListId : undefined}
          value={variety}
          placeholder={t('capture.cycle.varietyPlaceholder')}
          onChange={(event) => onVarietyChange(event.target.value)}
          className={`w-full ${TOUCH_CONTROL} rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] ${FOCUS_RING}`}
        />
        {varietySuggestions.length > 0 && (
          <datalist id={varietyListId}>
            {varietySuggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
          </datalist>
        )}
      </div>

      {overlapping && (
        <div
          role="group"
          aria-labelledby={promptId}
          className="space-y-3 rounded-xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-3"
        >
          <p id={promptId} className="font-bold text-[var(--text)]">{t('capture.cycle.sameCropTitle')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={cycleAction === 'continue'}
              onClick={() => onCycleActionChange('continue')}
              className={`rounded-xl border px-4 py-2 font-bold ${TOUCH_CONTROL} ${FOCUS_RING} ${
                cycleAction === 'continue'
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]'
              }`}
            >
              {t('capture.cycle.continueCycle')}
            </button>
            <button
              type="button"
              aria-pressed={cycleAction === 'new'}
              onClick={() => onCycleActionChange('new')}
              className={`rounded-xl border px-4 py-2 font-bold ${TOUCH_CONTROL} ${FOCUS_RING} ${
                cycleAction === 'new'
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]'
              }`}
            >
              {t('capture.cycle.startNewCycle')}
            </button>
          </div>
          {showValidation && cycleAction == null && (
            <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
              {t('capture.cycle.cycleActionRequired')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
