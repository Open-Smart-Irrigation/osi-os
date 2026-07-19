import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildCatalogModel, catalogLabel } from '../../../journal/catalogModel';
import { buildCorrectionPayload, parseContextSnapshot } from '../../../journal/entryCorrection';
import { deriveFieldStates } from '../../../journal/templateEngine';
import { useJournalEntries } from '../../../journal/useJournalEntries';
import { journalApi } from '../../../services/journalApi';
import type {
  EntryAggregate,
  EntryValue,
  JournalCatalog,
  JournalPlot,
} from '../../../types/journal';
import type {
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
  JournalScalar,
  JournalSelections,
  JournalTemplateDefinition,
} from '../../../types/journalCapture';
import { EntryForm } from '../capture/EntryForm';
import { formatOccurredDate } from '../JournalEntryRow';
import { statusBadgeClass } from '../statusBadgeClass';

export interface DetailPanelProps {
  catalog: JournalCatalog;
  plots: readonly JournalPlot[];
  selectedEntryUuid: string | null;
  onFocusReturn?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// axios-shaped errors only: this GUI never inspects response bodies beyond
// the status code here, matching how EntryTable/PlotForm read failures.
function isStaleVersionError(error: unknown): boolean {
  const status = isRecord(error) && isRecord(error.response) ? error.response.status : undefined;
  return status === 409;
}

function plotLabelOf(plotUuid: string | null, plots: readonly JournalPlot[]): string | null {
  if (!plotUuid) return null;
  const plot = plots.find((candidate) => candidate.plot_uuid === plotUuid);
  return plot ? (plot.name?.trim() || plot.plot_code) : null;
}

function attributeLabel(
  code: string,
  model: JournalCaptureCatalogModel | null,
  locale: string,
): string {
  const attribute = model?.vocabByCode.get(code);
  return attribute ? catalogLabel(attribute, locale) : code;
}

function formatStoredValue(
  value: EntryValue,
  model: JournalCaptureCatalogModel | null,
  locale: string,
  t: TFunction<'journal'>,
): string {
  if (value.value_status !== 'observed') {
    return t(`capture.carry.valueStatus.${value.value_status}`, value.value_status);
  }
  if (value.value_text != null) {
    const choice = model?.vocabByCode.get(value.value_text);
    return choice ? catalogLabel(choice, locale) : value.value_text;
  }
  if (value.value_num != null) {
    const unit = value.unit_code ? model?.vocabByCode.get(value.unit_code) : undefined;
    const numberText = new Intl.NumberFormat(locale).format(value.value_num);
    return unit ? `${numberText} ${catalogLabel(unit, locale)}` : numberText;
  }
  return '';
}

function scalarSelectionsFromValues(values: readonly CaptureEntryValueInput[]): Record<string, JournalScalar> {
  const result: Record<string, JournalScalar> = {};
  for (const value of values) {
    const scalar = value.value ?? value.value_text ?? value.entered_value_num ?? value.value_num;
    if (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean') {
      result[value.attribute_code] = scalar;
    }
  }
  return result;
}

// The desktop three-pane workspace's right slot: reads a selected entry back
// in full (values plus its frozen sensor-context snapshot), voids a final
// entry with an explicit reason, and lets a final entry be corrected through
// the shared EntryForm capture engine. Draft and voided entries cannot be
// voided or corrected here — drafts resume through the Task 31 queue,
// voided entries are terminal.
export function DetailPanel({ catalog, plots, selectedEntryUuid, onFocusReturn }: DetailPanelProps) {
  const { t } = useTranslation('journal');

  if (!selectedEntryUuid) {
    return (
      <aside
        aria-label={t('workspace.detail.heading')}
        className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--text-secondary)]"
      >
        {t('workspace.detail.placeholder')}
      </aside>
    );
  }

  return (
    <DetailPanelForEntry
      key={selectedEntryUuid}
      catalog={catalog}
      plots={plots}
      entryUuid={selectedEntryUuid}
      onFocusReturn={onFocusReturn}
    />
  );
}

interface DetailPanelForEntryProps {
  catalog: JournalCatalog;
  plots: readonly JournalPlot[];
  entryUuid: string;
  onFocusReturn?: () => void;
}

type PanelMode = 'view' | 'void' | 'correct';

function DetailPanelForEntry({ catalog, plots, entryUuid, onFocusReturn }: DetailPanelForEntryProps) {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language;
  const { entries, loading, error, retry } = useJournalEntries(
    { entry_uuid: entryUuid, status: 'all' },
    true,
  );
  const aggregate = entries.find((candidate) => candidate.entry_uuid === entryUuid) ?? null;
  const modelResult = useMemo(() => buildCatalogModel(catalog), [catalog]);
  const model = modelResult.ok ? modelResult.model : null;
  const [mode, setMode] = useState<PanelMode>('view');

  const heading = (
    <p className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
      {t('workspace.detail.heading')}
    </p>
  );

  if (loading) {
    return (
      <aside aria-label={t('workspace.detail.heading')} className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--text-secondary)]">
        {heading}
        <p role="status" className="mt-3">{t('workspace.detail.loading')}</p>
      </aside>
    );
  }

  if (error) {
    return (
      <aside aria-label={t('workspace.detail.heading')} className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm">
        {heading}
        <div role="alert" className="mt-3 space-y-2">
          <p>{t('workspace.detail.error')}</p>
          <button
            type="button"
            onClick={() => void retry()}
            className="rounded-lg border border-[var(--border)] px-3 py-2 font-bold"
          >
            {t('workspace.detail.retry')}
          </button>
        </div>
      </aside>
    );
  }

  if (!aggregate) {
    return (
      <aside aria-label={t('workspace.detail.heading')} className="min-h-[240px] rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--text-secondary)]">
        {heading}
        <p className="mt-3">{t('workspace.detail.notFound')}</p>
      </aside>
    );
  }

  const template = model?.templates.get(aggregate.template_code);
  const layout = model?.layouts.get(aggregate.layout_code);
  const correctionUnavailable = !model || !template || !layout;
  const plotLabel = plotLabelOf(aggregate.plot_uuid, plots);
  const context = parseContextSnapshot(aggregate.context_json);
  const returnFocus = () => onFocusReturn?.();

  const afterMutation = async () => {
    setMode('view');
    await retry();
    returnFocus();
  };

  return (
    <aside aria-label={t('workspace.detail.heading')} className="flex min-h-[240px] flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm">
      {heading}

      <div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-[var(--text)]">
            {t(`activity.${aggregate.activity_code}`, aggregate.activity_code)}
          </h2>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${statusBadgeClass(aggregate.status)}`}>
            {t(`row.status.${aggregate.status}`)}
          </span>
        </div>
        <p className="text-[var(--text-secondary)]">
          <span>{plotLabel ?? t('row.farmLevel')}</span>
          {' · '}
          <time dateTime={aggregate.occurred_start}>
            {formatOccurredDate(aggregate.occurred_start, aggregate.occurred_timezone, locale)}
          </time>
        </p>
      </div>

      {aggregate.status !== 'final' && (
        <p className="rounded-xl bg-[var(--secondary-bg)] px-3 py-2 text-[var(--text-secondary)]">
          {t(aggregate.status === 'draft' ? 'workspace.detail.locked.draft' : 'workspace.detail.locked.voided')}
        </p>
      )}
      {aggregate.status === 'voided' && aggregate.void_reason && (
        <p className="text-[var(--text-secondary)]">
          <span className="font-bold">{t('workspace.detail.void.reasonLabel')}: </span>
          {aggregate.void_reason}
        </p>
      )}

      <dl className="space-y-1">
        {([
          ['campaign_uuid', aggregate.campaign_uuid],
          ['protocol_code', aggregate.protocol_code],
          ['observation_unit_code', aggregate.observation_unit_code],
          ['season_crop', aggregate.season_crop],
          ['note', aggregate.note],
        ] as const)
          .filter((entry): entry is [typeof entry[0], string] => entry[1] != null && entry[1] !== '')
          .map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">{t(`workspace.detail.field.${key}`, key)}</dt>
              <dd className="text-right font-semibold text-[var(--text)]">{value}</dd>
            </div>
          ))}
      </dl>

      <div>
        <p className="mb-1 font-bold text-[var(--text)]">{t('workspace.detail.values.heading')}</p>
        {aggregate.values.length === 0 ? (
          <p className="text-[var(--text-secondary)]">{t('workspace.detail.values.empty')}</p>
        ) : (
          <ul className="space-y-1">
            {aggregate.values.map((value, index) => (
              <li key={`${value.attribute_code}:${value.group_index}:${index}`} className="flex justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{attributeLabel(value.attribute_code, model, locale)}</span>
                <span className="text-right font-semibold text-[var(--text)]">
                  {formatStoredValue(value, model, locale, t)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1 font-bold text-[var(--text)]">{t('workspace.detail.context.heading')}</p>
        {!context?.channels || !isRecord(context.channels) ? (
          <p className="text-[var(--text-secondary)]">{t('workspace.detail.context.empty')}</p>
        ) : (
          <ul className="space-y-1">
            {Object.entries(context.channels).map(([key, raw]) => {
              const record = isRecord(raw) ? raw : null;
              const rawValue = record?.value;
              const displayValue = typeof rawValue === 'number'
                ? new Intl.NumberFormat(locale).format(rawValue)
                : typeof rawValue === 'string' ? rawValue : null;
              const unit = record && typeof record.unit === 'string' ? record.unit : null;
              return (
                <li key={key} className="flex justify-between gap-3">
                  <span className="text-[var(--text-secondary)]">{key}</span>
                  <span className="text-right font-semibold text-[var(--text)]">
                    {displayValue != null ? `${displayValue}${unit ? ` ${unit}` : ''}` : t('workspace.detail.context.channelEmpty')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {aggregate.status === 'final' && mode === 'view' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              disabled={correctionUnavailable}
              onClick={() => setMode('correct')}
              className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 font-bold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('workspace.detail.actions.correct')}
            </button>
            <button
              type="button"
              onClick={() => setMode('void')}
              className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 font-bold text-[var(--error-text)]"
            >
              {t('workspace.detail.actions.void')}
            </button>
          </div>
          {correctionUnavailable && (
            <p className="text-[var(--text-secondary)]">{t('workspace.detail.correction.unavailable')}</p>
          )}
        </div>
      )}

      {mode === 'void' && (
        <VoidForm
          aggregate={aggregate}
          onCancel={() => { setMode('view'); returnFocus(); }}
          onVoided={afterMutation}
        />
      )}

      {mode === 'correct' && model && template && layout && (
        <EntryCorrectionForm
          key={aggregate.sync_version}
          aggregate={aggregate}
          model={model}
          template={template}
          layout={layout}
          products={catalog.products}
          locale={locale}
          onCancel={() => { setMode('view'); returnFocus(); }}
          onSaved={afterMutation}
        />
      )}
    </aside>
  );
}

interface VoidFormProps {
  aggregate: EntryAggregate;
  onCancel: () => void;
  onVoided: () => void | Promise<void>;
}

function VoidForm({ aggregate, onCancel, onVoided }: VoidFormProps) {
  const { t } = useTranslation('journal');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const [genericError, setGenericError] = useState(false);
  const reasonId = 'journal-detail-void-reason';
  const reasonErrorId = `${reasonId}-error`;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed === '') {
      setTouched(true);
      return;
    }
    setSubmitting(true);
    setStaleError(false);
    setGenericError(false);
    try {
      await journalApi.voidEntry(aggregate.entry_uuid, trimmed, aggregate.sync_version);
      await onVoided();
    } catch (failure) {
      if (isStaleVersionError(failure)) setStaleError(true);
      else setGenericError(true);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-[var(--border)] p-3">
      <label htmlFor={reasonId} className="block font-bold text-[var(--text)]">
        {t('workspace.detail.void.reasonLabel')}
      </label>
      <textarea
        id={reasonId}
        value={reason}
        disabled={submitting}
        autoFocus
        aria-invalid={touched}
        aria-describedby={touched ? reasonErrorId : undefined}
        onChange={(event) => { setReason(event.target.value); setTouched(false); }}
        className="min-h-20 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
      />
      {touched && (
        <p id={reasonErrorId} role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.detail.void.reasonRequired')}
        </p>
      )}
      {staleError && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.detail.void.stale')}
        </p>
      )}
      {genericError && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.detail.void.error')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 font-bold"
        >
          {t('workspace.detail.void.cancel')}
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 rounded-lg bg-[var(--primary)] px-3 py-2 font-bold text-white"
        >
          {submitting ? t('workspace.detail.void.saving') : t('workspace.detail.void.submit')}
        </button>
      </div>
    </form>
  );
}

interface EntryCorrectionFormProps {
  aggregate: EntryAggregate;
  model: JournalCaptureCatalogModel;
  template: JournalTemplateDefinition;
  layout: JournalLayoutDefinition;
  products: JournalCatalog['products'];
  locale: string;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}

function EntryCorrectionForm({
  aggregate,
  model,
  template,
  layout,
  products,
  locale,
  onCancel,
  onSaved,
}: EntryCorrectionFormProps) {
  const { t } = useTranslation('journal');
  const [values, setValues] = useState<CaptureEntryValueInput[]>(() => aggregate.values);
  const [payload, setPayload] = useState<CaptureEntryValueOutput[]>([]);
  const [valid, setValid] = useState(true);
  const [showValidation, setShowValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const [genericError, setGenericError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selections = useMemo<JournalSelections>(() => ({
    activity_code: aggregate.activity_code,
    ...scalarSelectionsFromValues(values),
  }), [aggregate.activity_code, values]);
  const fieldStates = useMemo(
    () => deriveFieldStates(template, layout, selections),
    [template, layout, selections],
  );
  const formOwnedAttributeCodes = useMemo(() => new Set(
    fieldStates
      .filter((state) => model.vocabByCode.get(state.code)?.kind === 'attribute')
      .map((state) => state.code),
  ), [fieldStates, model]);

  useEffect(() => {
    const firstField = containerRef.current?.querySelector<HTMLElement>('input, select, textarea, button');
    firstField?.focus();
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setShowValidation(true);
      return;
    }
    setSubmitting(true);
    setStaleError(false);
    setGenericError(false);
    try {
      const updatePayload = buildCorrectionPayload(aggregate, formOwnedAttributeCodes, payload);
      await journalApi.updateEntry(aggregate.entry_uuid, updatePayload);
      await onSaved();
    } catch (failure) {
      if (isStaleVersionError(failure)) setStaleError(true);
      else setGenericError(true);
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={t('workspace.detail.correction.heading')}
      className="space-y-4 rounded-xl border border-[var(--border)] p-3"
    >
      <div ref={containerRef}>
        <EntryForm
          model={model}
          layout={layout}
          fieldStates={fieldStates}
          values={values}
          onChange={(nextInputs, nextPayload, nextValid) => {
            setValues(nextInputs);
            setPayload(nextPayload);
            setValid(nextValid);
          }}
          selections={selections}
          products={products}
          locale={locale}
          showValidation={showValidation}
        />
      </div>
      {staleError && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.detail.correction.stale')}
        </p>
      )}
      {genericError && (
        <p role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {t('workspace.detail.correction.error')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 font-bold"
        >
          {t('workspace.detail.correction.cancel')}
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 rounded-lg bg-[var(--primary)] px-3 py-2 font-bold text-white"
        >
          {submitting ? t('workspace.detail.correction.saving') : t('workspace.detail.correction.save')}
        </button>
      </div>
    </form>
  );
}
