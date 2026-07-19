import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildCatalogModel } from '../../journal/catalogModel';
import { firstMissingRequiredFieldCode } from '../../journal/draftResume';
import { buildCorrectionPayload } from '../../journal/entryCorrection';
import { deriveFieldStates } from '../../journal/templateEngine';
import { useDraftsQueue } from '../../journal/useDraftsQueue';
import { useJournalCatalog } from '../../journal/useJournalCatalog';
import type { CreateEntryPayload } from '../../services/journalApi';
import { journalApi } from '../../services/journalApi';
import type { EntryAggregate } from '../../types/journal';
import type {
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalFieldState,
  JournalLayoutDefinition,
  JournalSelections,
  JournalTemplateDefinition,
} from '../../types/journalCapture';
import { EntryForm, validateEntryForm } from './capture/EntryForm';
import type { EntryFormTranslate } from './capture/EntryForm';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// axios-shaped errors only: mirrors DetailPanel's correction/void flows — this
// GUI never inspects response bodies beyond the status code here.
function isStaleVersionError(error: unknown): boolean {
  const status = isRecord(error) && isRecord(error.response) ? error.response.status : undefined;
  return status === 409;
}

// Single source of truth for "what does this draft's template/layout say the
// visible fields are" — shared by the queue's own onResume focus-jump and by
// DraftResumePanel's inline form, so the two can never compute a different
// field-state set for the same draft (previously duplicated inline in both
// places).
function draftFieldStates(
  layout: JournalLayoutDefinition | undefined,
  template: JournalTemplateDefinition | undefined,
  selections: JournalSelections,
): JournalFieldState[] {
  return layout && template ? deriveFieldStates(template, layout, selections) : [];
}

interface DraftResumePanelProps {
  draft: EntryAggregate;
  model: JournalCaptureCatalogModel;
  locale: string | undefined;
  onClose: () => void;
  retry: () => Promise<void>;
}

// Seeds the Complete action's initial payload/valid the same way DetailPanel's
// EntryCorrectionForm seeds a correction (see initialCorrectionSeed there):
// EntryForm only calls onChange on user interaction, never on mount, so
// without this an unedited resume would read as an empty, invalid payload
// even when the draft was already complete except for the focused field.
function initialResumeSeed(
  model: JournalCaptureCatalogModel,
  layout: JournalLayoutDefinition | undefined,
  fieldStates: JournalFieldState[],
  draft: EntryAggregate,
  t: EntryFormTranslate,
): { payload: CaptureEntryValueOutput[]; valid: boolean } {
  if (!layout) return { payload: [], valid: false };
  const result = validateEntryForm({
    model,
    layout,
    fieldStates,
    inputs: draft.values,
    selections: { activity_code: draft.activity_code },
    numberInputErrors: new Map(),
    products: [],
    t,
  });
  return { payload: result.payload, valid: result.valid };
}

const DraftResumePanel: React.FC<DraftResumePanelProps> = ({ draft, model, locale, onClose, retry }) => {
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
    () => draftFieldStates(layout, template, selections),
    [layout, template, selections],
  );
  const focusFieldCode = useMemo(
    () => firstMissingRequiredFieldCode(fieldStates, draft.values),
    [fieldStates, draft.values],
  );
  // Mirrors EntryCorrectionForm's ownership rule exactly (see the comment on
  // formOwnedAttributeCodes in DetailPanel.tsx / I2): the shared EntryForm
  // only ever emits values for visible attribute fields, so Complete must
  // replace only those stored rows and pass every other value through
  // unchanged, or an invisible field's stored value would be silently
  // dropped.
  const formOwnedAttributeCodes = useMemo(() => new Set(
    fieldStates
      .filter((state) => state.visible && model.vocabByCode.get(state.code)?.kind === 'attribute')
      .map((state) => state.code),
  ), [fieldStates, model]);

  const [payload, setPayload] = useState<CaptureEntryValueOutput[]>(
    () => initialResumeSeed(model, layout, fieldStates, draft, t).payload,
  );
  const [valid, setValid] = useState<boolean>(
    () => initialResumeSeed(model, layout, fieldStates, draft, t).valid,
  );
  const [completing, setCompleting] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const [genericError, setGenericError] = useState(false);

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

  // Finalizes the draft through the SAME capture path a brand-new entry uses
  // (POST /api/journal/entries -> createFinalInTransaction ->
  // promoteDraftInTransaction), never PUT/updateEntry: the edge's PUT path
  // (osi-journal/lifecycle.js correctFinalInTransaction) rejects a non-final
  // entry with invalid_state, and only the POST path reaches the version-zero
  // draft -> final promotion.
  const handleComplete = async () => {
    if (!valid || completing) return;
    setCompleting(true);
    setStaleError(false);
    setGenericError(false);
    try {
      const finalizePayload: CreateEntryPayload = {
        ...buildCorrectionPayload(draft, formOwnedAttributeCodes, payload),
        base_sync_version: 0,
      };
      await journalApi.createEntry(finalizePayload);
      await retry();
      onClose();
    } catch (failure) {
      if (isStaleVersionError(failure)) setStaleError(true);
      else setGenericError(true);
      setCompleting(false);
    }
  };

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
        onChange={(inputs, nextPayload, nextValid) => {
          setValues(inputs);
          setPayload(nextPayload);
          setValid(nextValid);
        }}
        selections={selections}
        locale={locale}
        showValidation
      />
      {staleError && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('drafts.completeStale')}
        </p>
      )}
      {genericError && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('drafts.completeError')}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!valid || completing}
          onClick={() => void handleComplete()}
          className={`min-h-9 rounded-lg bg-[var(--primary)] px-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
        >
          {completing ? t('drafts.completing') : t('drafts.complete')}
        </button>
      </div>
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
    const template = model?.templates.get(draft.template_code);
    const fieldStates = draftFieldStates(layout, template, { activity_code: draft.activity_code });
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
                    retry={retry}
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
