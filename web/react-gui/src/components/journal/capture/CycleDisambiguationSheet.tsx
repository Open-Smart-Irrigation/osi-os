import { useTranslation } from 'react-i18next';

import { cycleOptionLabel, type CycleOption } from '../../../journal/cropCycle';
import type { JournalCaptureCatalogModel } from '../../../types/journalCapture';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

export interface CycleDisambiguationSheetProps {
  model: JournalCaptureCatalogModel;
  locale: string;
  options: readonly CycleOption[];
  onChoose: (cycleUuid: string) => void;
  onCancel: () => void;
}

// R7: seeding, harvest, and manual-close on an intercropped plot (more than
// one open crop cycle covering it) all require the caller to name which
// cycle_uuid the action applies to. The edge refuses without one
// (cycle_uuid_required/cycle_not_found — see journal/cropCycle.ts's
// cycleDisambiguationFromError) and its refusal already lists every open
// cycle's crop/variety, so this picker is purely reactive: no separate
// endpoint is queried to find the candidates.
export function CycleDisambiguationSheet({
  model,
  locale,
  options,
  onChoose,
  onCancel,
}: CycleDisambiguationSheetProps) {
  const { t } = useTranslation('journal');

  return (
    <section
      role="alertdialog"
      aria-labelledby="journal-cycle-disambiguation-title"
      className="space-y-3 rounded-2xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-4"
    >
      <h2 id="journal-cycle-disambiguation-title" className="font-bold text-[var(--text)]">
        {t('capture.cycle.disambiguationTitle')}
      </h2>
      <p className="text-sm text-[var(--text-secondary)]">{t('capture.cycle.disambiguationBody')}</p>
      <ul className="space-y-2">
        {options.map((option) => (
          <li key={option.cycle_uuid}>
            <button
              type="button"
              onClick={() => onChoose(option.cycle_uuid)}
              className={`w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-left font-bold text-[var(--text)] hover:border-[var(--primary)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
            >
              {cycleOptionLabel(option, model, locale)}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onCancel}
        className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-bold text-[var(--text)] ${TOUCH_CONTROL} ${FOCUS_RING}`}
      >
        {t('where.cancel')}
      </button>
    </section>
  );
}
