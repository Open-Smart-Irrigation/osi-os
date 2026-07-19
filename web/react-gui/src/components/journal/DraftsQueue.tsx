import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildCatalogModel } from '../../journal/catalogModel';
import { firstMissingRequiredFieldCode } from '../../journal/draftResume';
import { deriveFieldStates } from '../../journal/templateEngine';
import { useDraftsQueue } from '../../journal/useDraftsQueue';
import { useJournalCatalog } from '../../journal/useJournalCatalog';
import { journalApi } from '../../services/journalApi';
import type { EntryAggregate } from '../../types/journal';
import type {
  CaptureEntryValueInput,
  JournalCaptureCatalogModel,
  JournalSelections,
} from '../../types/journalCapture';
import { EntryForm } from './capture/EntryForm';
import { formatOccurredDate } from './JournalEntryRow';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

export interface DraftsQueueProps {
  /** Disables the underlying fetch — mirrors every other journal list hook's `enabled` gate. */
  enabled?: boolean;
  /**
   * Optional seam for a host (e.g. the desktop detail panel) to take over opening the shared
   * capture form itself. When omitted, DraftsQueue opens its own inline EntryForm panel so the
   * queue is fully usable standalone.
   */
  onResume?: (entryUuid: string, focusFieldCode: string | null) => void;
}

interface DraftResumePanelProps {
  draft: EntryAggregate;
  model: JournalCaptureCatalogModel;
  locale: string | undefined;
  onClose: () => void;
}

const DraftResumePanel: React.FC<DraftResumePanelProps> = ({ draft, model, locale, onClose }) => {
  const { t } = useTranslation('journal');
  const layout = model.layouts.get(draft.layout_code ?? '');
  const template = model.templates.get(draft.template_code);
  const [values, setValues] = useState<CaptureEntryValueInput[]>(draft.values);
  const focusedRef = useRef(false);

  const selections: JournalSelections = useMemo(
    () => ({ activity_code: draft.activity_code }),
    [draft.activity_code],
  );
  const fieldStates = useMemo(
    () => (layout && template ? deriveFieldStates(template, layout, selections) : []),
    [layout, template, selections],
  );
  const focusFieldCode = useMemo(
    () => firstMissingRequiredFieldCode(fieldStates, draft.values),
    [fieldStates, draft.values],
  );

  useEffect(() => {
    focusedRef.current = false;
  }, [draft.entry_uuid]);

  useEffect(() => {
    if (focusedRef.current || !focusFieldCode) return;
    const node = document.getElementById(focusFieldCode);
    if (!node) return;
    focusedRef.current = true;
    node.focus();
  });

  if (!layout || !template) {
    return (
      <div role="alert" className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--secondary-bg)] p-3">
        <p className="text-sm text-[var(--text-secondary)]">{t('drafts.resumeUnavailable')}</p>
        <button
          type="button"
          className={`mt-2 text-sm font-bold text-[var(--primary)] ${FOCUS_RING}`}
          onClick={onClose}
        >
          {t('drafts.close')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--secondary-bg)] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-[var(--text)]">
          {t(`activity.${draft.activity_code}`, draft.activity_code)}
        </p>
        <button
          type="button"
          className={`text-sm font-bold text-[var(--primary)] ${FOCUS_RING}`}
          onClick={onClose}
        >
          {t('drafts.close')}
        </button>
      </div>
      <EntryForm
        model={model}
        layout={layout}
        fieldStates={fieldStates}
        values={values}
        onChange={(inputs) => setValues(inputs)}
        selections={selections}
        locale={locale}
        showValidation
      />
    </div>
  );
};

export const DraftsQueue: React.FC<DraftsQueueProps> = ({ enabled = true, onResume }) => {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n?.resolvedLanguage || i18n?.language || undefined;
  const { drafts, status, retry } = useDraftsQueue(enabled);
  const { catalog } = useJournalCatalog();
  const model = useMemo(() => {
    if (!catalog) return null;
    const result = buildCatalogModel(catalog);
    return result.ok ? result.model : null;
  }, [catalog]);

  const [resumingUuid, setResumingUuid] = useState<string | null>(null);
  const [discardPending, setDiscardPending] = useState<Record<string, boolean>>({});
  const [discardError, setDiscardError] = useState<Record<string, boolean>>({});

  const focusCodeFor = (draft: EntryAggregate): string | null => {
    const layout = model?.layouts.get(draft.layout_code ?? '');
    const template = model && model.templates.get(draft.template_code);
    if (!layout || !template) return null;
    const fieldStates = deriveFieldStates(template, layout, { activity_code: draft.activity_code });
    return firstMissingRequiredFieldCode(fieldStates, draft.values);
  };

  const resume = (draft: EntryAggregate) => {
    if (onResume) {
      onResume(draft.entry_uuid, focusCodeFor(draft));
      return;
    }
    setResumingUuid(draft.entry_uuid);
  };

  const discard = async (entryUuid: string) => {
    setDiscardPending((prev) => ({ ...prev, [entryUuid]: true }));
    setDiscardError((prev) => {
      if (!prev[entryUuid]) return prev;
      const next = { ...prev };
      delete next[entryUuid];
      return next;
    });
    try {
      await journalApi.discardDraft(entryUuid);
      if (resumingUuid === entryUuid) setResumingUuid(null);
      await retry();
    } catch {
      setDiscardError((prev) => ({ ...prev, [entryUuid]: true }));
    } finally {
      setDiscardPending((prev) => {
        const next = { ...prev };
        delete next[entryUuid];
        return next;
      });
    }
  };

  if (status === 'loading') {
    return <p role="status" className="text-sm text-[var(--text-secondary)]">{t('drafts.loading')}</p>;
  }

  if (status === 'error') {
    return (
      <div role="alert" className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
        <p className="text-sm font-bold text-[var(--text)]">{t('drafts.error.title')}</p>
        <button
          type="button"
          className={`btn-liquid mt-2 rounded-lg px-3 py-1.5 text-sm ${FOCUS_RING}`}
          onClick={() => void retry()}
        >
          {t('drafts.error.retry')}
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label={t('drafts.title')}
      className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      <h2 className="text-sm font-bold text-[var(--text)]">{t('drafts.title')}</h2>

      {status === 'stale' && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-[var(--warn-bg)] px-3 py-2">
          <p className="text-sm text-[var(--warn-text)]">{t('drafts.stale.body')}</p>
          <button
            type="button"
            className={`shrink-0 text-sm font-bold text-[var(--warn-text)] underline ${FOCUS_RING}`}
            onClick={() => void retry()}
          >
            {t('drafts.stale.retry')}
          </button>
        </div>
      )}

      {status === 'empty' ? (
        <p className="text-sm text-[var(--text-secondary)]">{t('drafts.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {drafts.map((draft) => (
            <li
              key={draft.entry_uuid}
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-bold text-[var(--text)]">
                    {t(`activity.${draft.activity_code}`, draft.activity_code)}
                  </p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    <time dateTime={draft.occurred_start}>
                      {formatOccurredDate(draft.occurred_start, draft.occurred_timezone, locale)}
                    </time>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className={`min-h-9 rounded-lg border border-[var(--border)] px-3 text-sm font-bold text-[var(--text)] ${FOCUS_RING}`}
                    onClick={() => resume(draft)}
                  >
                    {t('drafts.resume')}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(discardPending[draft.entry_uuid])}
                    className={`min-h-9 rounded-lg border border-[var(--border)] px-3 text-sm font-bold text-[var(--error-text)] disabled:opacity-60 ${FOCUS_RING}`}
                    onClick={() => void discard(draft.entry_uuid)}
                  >
                    {discardPending[draft.entry_uuid] ? t('drafts.discarding') : t('drafts.discard')}
                  </button>
                </div>
              </div>

              {discardError[draft.entry_uuid] && (
                <p role="alert" className="mt-2 text-sm font-semibold text-[var(--error-text)]">
                  {t('drafts.discardError')}
                </p>
              )}

              {resumingUuid === draft.entry_uuid && (
                model ? (
                  <DraftResumePanel
                    draft={draft}
                    model={model}
                    locale={locale}
                    onClose={() => setResumingUuid(null)}
                  />
                ) : (
                  <div role="alert" className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--secondary-bg)] p-3">
                    <p className="text-sm text-[var(--text-secondary)]">{t('drafts.resumeUnavailable')}</p>
                    <button
                      type="button"
                      className={`mt-2 text-sm font-bold text-[var(--primary)] ${FOCUS_RING}`}
                      onClick={() => setResumingUuid(null)}
                    >
                      {t('drafts.close')}
                    </button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
