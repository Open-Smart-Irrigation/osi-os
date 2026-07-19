import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { catalogLabel } from '../../../journal/catalogModel';
import type {
  LayoutTransitionAffectedItem,
  LayoutTransitionResolutionKind,
} from '../../../journal/layoutTransition';
import type { JournalCaptureCatalogModel } from '../../../types/journalCapture';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

export interface LayoutTransitionReviewSheetProps {
  items: readonly LayoutTransitionAffectedItem[];
  model: JournalCaptureCatalogModel;
  locale: string;
  onResolve: (item: LayoutTransitionAffectedItem, resolution: LayoutTransitionResolutionKind) => void;
  onRequestClose: () => void;
}

function itemDisplayValue(
  item: LayoutTransitionAffectedItem,
  model: JournalCaptureCatalogModel,
  locale: string,
  booleanLabels: { yes: string; no: string },
): string {
  const raw = item.value.value ?? item.value.value_text ??
    item.value.entered_value_num ?? item.value.value_num;
  if (raw == null) return '';
  if (typeof raw === 'boolean') return raw ? booleanLabels.yes : booleanLabels.no;
  if (typeof raw === 'string') {
    const choice = model.vocabByCode.get(raw);
    return choice && choice.kind === 'choice' ? catalogLabel(choice, locale) : raw;
  }
  return String(raw);
}

export function LayoutTransitionReviewSheet({
  items,
  model,
  locale,
  onResolve,
  onRequestClose,
}: LayoutTransitionReviewSheetProps) {
  const { t } = useTranslation('journal');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onRequestCloseRef = useRef(onRequestClose);
  const titleId = 'journal-transition-review-title';

  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onRequestCloseRef.current();
      }
    };
    const node = dialogRef.current;
    node?.addEventListener('keydown', handleKeyDown);
    return () => node?.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (items.length === 0) return null;

  const booleanLabels = {
    yes: t('capture.form.booleanYes'),
    no: t('capture.form.booleanNo'),
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-4" onClick={() => onRequestClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-bold text-[var(--text)]"
          >
            {t('capture.transition.title', { defaultValue: 'Review changed values' })}
          </h2>
          <button
            type="button"
            onClick={() => onRequestClose()}
            className={`min-h-11 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm font-semibold text-[var(--text)] ${FOCUS_RING}`}
          >
            {t('capture.transition.close', { defaultValue: 'Close' })}
          </button>
        </div>

        <div className="max-h-[calc(100vh-8rem)] space-y-4 overflow-y-auto p-5">
          <p className="text-sm text-[var(--text-secondary)]">
            {t('capture.transition.body', {
              defaultValue: 'This growing setting change affects values you already entered. Choose what to do with each one before continuing.',
            })}
          </p>
          <ul className="space-y-4">
            {items.map((item) => {
              const attribute = model.vocabByCode.get(item.attribute_code);
              const label = attribute ? catalogLabel(attribute, locale) : item.attribute_code;
              const value = itemDisplayValue(item, model, locale, booleanLabels);
              const reasonKey = item.reason === 'field_hidden'
                ? 'capture.transition.reasonFieldHidden'
                : 'capture.transition.reasonChoiceInvalid';
              const reasonDefault = item.reason === 'field_hidden'
                ? 'This growing setting no longer shows this field.'
                : 'This value is not allowed under the new growing setting.';
              return (
                <li
                  key={`${item.attribute_code}:${item.group_index}`}
                  className="space-y-2 rounded-xl border border-[var(--border)] p-3"
                >
                  <p className="font-bold text-[var(--text)]">{label}</p>
                  {value && <p className="text-sm text-[var(--text)]">{value}</p>}
                  <p className="text-xs text-[var(--text-secondary)]">{t(reasonKey, { defaultValue: reasonDefault })}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onResolve(item, 'kept')}
                      className={`min-h-11 rounded-lg border border-[var(--border)] px-3 text-sm font-semibold text-[var(--text)] ${FOCUS_RING}`}
                    >
                      {`${t('capture.transition.keep', { defaultValue: 'Keep' })} ${label}`}
                    </button>
                    {item.reason === 'choice_invalid' && (
                      <button
                        type="button"
                        onClick={() => onResolve(item, 'replaced')}
                        className={`min-h-11 rounded-lg border border-[var(--border)] px-3 text-sm font-semibold text-[var(--text)] ${FOCUS_RING}`}
                      >
                        {`${t('capture.transition.replace', { defaultValue: 'Replace' })} ${label}`}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onResolve(item, 'removed')}
                      className={`min-h-11 rounded-lg bg-[var(--primary)] px-3 text-sm font-semibold text-white ${FOCUS_RING}`}
                    >
                      {`${t('capture.transition.remove', { defaultValue: 'Remove' })} ${label}`}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
