import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  allowedProductKindsForOperation,
  buildCatalogModel,
  catalogLabel,
  vocabLabelOrCode,
} from '../../../journal/catalogModel';
import { cycleDependentsFromError } from '../../../journal/cropCycle';
import {
  buildCorrectionPayload,
  currentNoteValue,
  parseContextSnapshot,
  scalarSelectionsFromValues,
} from '../../../journal/entryCorrection';
import { deriveFieldStates } from '../../../journal/templateEngine';
import { useJournalEntries } from '../../../journal/useJournalEntries';
import { journalApi } from '../../../services/journalApi';
import type {
  EntryAggregate,
  EntryValue,
  JournalCatalog,
  JournalPlot,
  JournalProductRow,
} from '../../../types/journal';
import type {
  CaptureEntryValueInput,
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
  JournalSelections,
  JournalTemplateDefinition,
} from '../../../types/journalCapture';
import { EntryForm, validateEntryForm } from '../capture/EntryForm';
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

// NIT 9: an internal valve-expectation linkage id (a plain `text` attribute)
// with no friendly resolver and no user-meaningful label -- never render its
// raw opaque id.
const OMITTED_VALUE_DISPLAY_CODE = 'attr.actuation_expectation_id';

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

function formatStoredValue(
  value: EntryValue,
  model: JournalCaptureCatalogModel | null,
  products: readonly Pick<JournalProductRow, 'product_uuid' | 'name'>[],
  locale: string,
  t: TFunction<'journal'>,
): string {
  if (value.value_status !== 'observed') {
    return t(`capture.carry.valueStatus.${value.value_status}`, value.value_status);
  }
  // BUG 2: attr.product_uuid stores a per-farm product UUID that is never a
  // vocabByCode entry (products are a separate registry, not catalog
  // choices) -- resolve it via the products list the same way
  // tankMixProductLabel/BUG 1 do on the capture confirm screen, instead of
  // falling through to the raw-code branch below and printing the UUID.
  if (value.attribute_code === 'attr.product_uuid' && value.value_text != null) {
    const product = products.find((candidate) => candidate.product_uuid === value.value_text);
    return product?.name ?? t('capture.tankMix.unknownProduct');
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

// EntryForm only calls onChange on user interaction, never on mount, so a
// correction form's payload/valid state cannot start empty: an unedited
// Save would then submit an empty value set, which the edge correction path
// (DELETE + re-INSERT of every journal_entry_values row) turns into a full
// wipe of the record (C1). Seed the form's initial payload/valid by running
// the same validateEntryForm the live form uses, over the aggregate's own
// stored values, so an unedited save re-emits the identical original value
// set instead of nothing.
function initialCorrectionSeed(
  model: JournalCaptureCatalogModel,
  template: JournalTemplateDefinition,
  layout: JournalLayoutDefinition,
  aggregate: EntryAggregate,
  products: JournalCatalog['products'],
  t: TFunction<'journal'>,
): { payload: CaptureEntryValueOutput[]; valid: boolean } {
  const selections: JournalSelections = {
    activity_code: aggregate.activity_code,
    ...scalarSelectionsFromValues(aggregate.values),
  };
  const fieldStates = deriveFieldStates(template, layout, selections);
  const result = validateEntryForm({
    model,
    layout,
    fieldStates,
    inputs: aggregate.values,
    selections,
    numberInputErrors: new Map(),
    products,
    t,
  });
  return { payload: result.payload, valid: result.valid };
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
  // NIT 9: attr.actuation_expectation_id is an internal valve-expectation
  // linkage id with no user-meaningful label and no friendly resolver --
  // omit it from the values list entirely rather than print the raw opaque
  // id (mirrors the same omission on the capture confirm screen).
  const displayedValues = aggregate.values.filter(
    (value) => value.attribute_code !== OMITTED_VALUE_DISPLAY_CODE,
  );
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
            {vocabLabelOrCode(aggregate.activity_code, model, locale)}
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
          // P2-b (Slice D hardening): a harvest/manual-close/reseed entry
          // that closed a crop cycle deliberately keeps its own season_crop
          // NULL (see osi-journal/lifecycle.js freezeClosedSpan) — fall back
          // to the closed cycle's crop, resolved for display only (see
          // osi-journal/lifecycle.js resolveClosedCropCycleOverrides), so
          // this entry still shows what was harvested/closed.
          ['season_crop', aggregate.season_crop ?? aggregate.closed_crop_code],
          ['note', aggregate.note],
        ] as const)
          .filter((entry): entry is [typeof entry[0], string] => entry[1] != null && entry[1] !== '')
          .map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">{t(`workspace.detail.field.${key}`, key)}</dt>
              <dd className="text-right font-semibold text-[var(--text)]">
                {key === 'season_crop' ? vocabLabelOrCode(value, model, locale) : value}
              </dd>
            </div>
          ))}
      </dl>

      <div>
        <p className="mb-1 font-bold text-[var(--text)]">{t('workspace.detail.values.heading')}</p>
        {displayedValues.length === 0 ? (
          <p className="text-[var(--text-secondary)]">{t('workspace.detail.values.empty')}</p>
        ) : (
          <ul className="space-y-1">
            {displayedValues.map((value, index) => (
              <li key={`${value.attribute_code}:${value.group_index}:${index}`} className="flex justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{vocabLabelOrCode(value.attribute_code, model, locale)}</span>
                <span className="text-right font-semibold text-[var(--text)]">
                  {formatStoredValue(value, model, catalog.products, locale, t)}
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
          plots={plots}
          model={model}
          locale={locale}
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
  plots: readonly JournalPlot[];
  model: JournalCaptureCatalogModel | null;
  locale: string;
  onCancel: () => void;
  onVoided: () => void | Promise<void>;
}

// P2-c: the cascade-void confirmation used to list bare entry UUIDs, which
// mean nothing to a farmer deciding whether to proceed. The refusal
// (osi-journal/lifecycle.js applyVoidCycleCascade) only ever carries UUIDs
// (see cropCycle.ts's cycleDependentsFromError) — there is no richer edge
// payload to read here — so this resolves each one via the same single-entry
// lookup DetailPanelForEntry itself already uses, then composes a label from
// data already available on the resolved aggregate: its catalog activity
// label, its plot label, and its occurred date. A dependent that fails to
// resolve (or hasn't resolved yet) falls back to its raw UUID rather than
// blocking the confirmation.
function dependentEntryLabel(
  entryUuid: string,
  resolved: EntryAggregate | undefined,
  plots: readonly JournalPlot[],
  model: JournalCaptureCatalogModel | null,
  locale: string,
): string {
  if (!resolved) return entryUuid;
  const activityLabel = vocabLabelOrCode(resolved.activity_code, model, locale);
  const plotLabel = plotLabelOf(resolved.plot_uuid, plots);
  const dateLabel = formatOccurredDate(resolved.occurred_start, resolved.occurred_timezone, locale);
  return plotLabel ? `${activityLabel} · ${plotLabel} · ${dateLabel}` : `${activityLabel} · ${dateLabel}`;
}

function VoidForm({ aggregate, plots, model, locale, onCancel, onVoided }: VoidFormProps) {
  const { t } = useTranslation('journal');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const [genericError, setGenericError] = useState(false);
  // D13/R7: voiding a seeding whose crop cycle has dependent entries (other
  // entries currently relying on it live, or already frozen by it) is
  // refused with dependentEntryUuids unless cascade_ack is set — see
  // journal/cropCycle.ts's cycleDependentsFromError and
  // osi-journal/lifecycle.js applyVoidCycleCascade. Surface those UUIDs and
  // require an explicit confirmation before retrying with cascade_ack.
  const [dependentEntryUuids, setDependentEntryUuids] = useState<string[] | null>(null);
  const [resolvedDependents, setResolvedDependents] = useState<Map<string, EntryAggregate>>(new Map());
  const [resolvingDependents, setResolvingDependents] = useState(false);
  const reasonId = 'journal-detail-void-reason';
  const reasonErrorId = `${reasonId}-error`;

  // Guards the two setState calls below when the operator cancels (or the
  // whole panel closes) while the per-dependent lookups are still in
  // flight — mirrors JournalTimeline's own `mounted` ref for the same
  // reason (an async batch of requests outliving the component).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolveDependentLabels = async (entryUuids: string[]) => {
    setResolvingDependents(true);
    const results = await Promise.allSettled(
      entryUuids.map((entryUuid) => journalApi.listEntries({ entry_uuid: entryUuid, status: 'all' })),
    );
    if (!mountedRef.current) return;
    const next = new Map<string, EntryAggregate>();
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const entryUuid = entryUuids[index];
      const found = result.value.entries.find((candidate) => candidate.entry_uuid === entryUuid);
      if (found) next.set(entryUuid, found);
    });
    setResolvedDependents(next);
    setResolvingDependents(false);
  };

  const submitVoid = async (trimmedReason: string, cascadeAck: boolean) => {
    setSubmitting(true);
    setStaleError(false);
    setGenericError(false);
    try {
      await journalApi.voidEntry(aggregate.entry_uuid, trimmedReason, aggregate.sync_version, cascadeAck);
      await onVoided();
    } catch (failure) {
      const dependents = cycleDependentsFromError(failure);
      if (dependents) {
        setDependentEntryUuids(dependents);
        setResolvedDependents(new Map());
        void resolveDependentLabels(dependents);
      } else if (isStaleVersionError(failure)) {
        setStaleError(true);
      } else {
        setGenericError(true);
      }
      setSubmitting(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed === '') {
      setTouched(true);
      return;
    }
    setDependentEntryUuids(null);
    await submitVoid(trimmed, false);
  };

  const confirmCascade = async () => {
    await submitVoid(reason.trim(), true);
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
      {dependentEntryUuids && (
        <div role="alertdialog" aria-label={t('capture.cycle.voidDependentsTitle')} className="space-y-2 rounded-xl border border-[var(--primary)] bg-[var(--secondary-bg)] p-3">
          <p className="font-bold text-[var(--text)]">{t('capture.cycle.voidDependentsTitle')}</p>
          <p className="text-sm text-[var(--text-secondary)]">{t('capture.cycle.voidDependentsBody')}</p>
          {resolvingDependents ? (
            <p role="status" className="text-sm text-[var(--text-secondary)]">
              {t('capture.cycle.voidDependentsLoading')}
            </p>
          ) : (
            <ul className="ml-4 list-disc space-y-1 text-sm text-[var(--text)]">
              {dependentEntryUuids.map((entryUuid) => (
                <li key={entryUuid}>
                  {dependentEntryLabel(entryUuid, resolvedDependents.get(entryUuid), plots, model, locale)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => setDependentEntryUuids(null)}
              className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 font-bold"
            >
              {t('capture.cycle.voidDependentsCancel')}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => { void confirmCascade(); }}
              className="flex-1 rounded-lg bg-[var(--error-text)] px-3 py-2 font-bold text-white"
            >
              {t('capture.cycle.voidDependentsConfirm')}
            </button>
          </div>
        </div>
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
  // M1 fix (2026-07-23): the top-level `note` column is not stored as a
  // journal_entry_values row (see semanticInput shape in EntryForm.tsx), so
  // it must be injected into the form's `values` seed here or the note
  // textarea renders empty on correction even when the entry has a stored
  // note. Matches the shape EntryForm's own onChange path writes.
  const [values, setValues] = useState<CaptureEntryValueInput[]>(() => (
    aggregate.note
      ? [...aggregate.values, { attribute_code: 'note', value: aggregate.note }]
      : aggregate.values
  ));
  const [payload, setPayload] = useState<CaptureEntryValueOutput[]>(
    () => initialCorrectionSeed(model, template, layout, aggregate, products, t).payload,
  );
  const [valid, setValid] = useState<boolean>(
    () => initialCorrectionSeed(model, template, layout, aggregate, products, t).valid,
  );
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
  // Operation-level field/requirement/product scoping plan (full_record@10,
  // spec §2): `selections` above is already live (derived from `values`, the
  // in-form-editable state) so no extra merge is needed here beyond the
  // engine fix in templateEngine.ts.
  const allowedProductKinds = useMemo(
    () => allowedProductKindsForOperation(template, selections),
    [selections, template],
  );
  // Ownership must mirror EntryForm's own visibleAttributeStates filter: the
  // form only ever emits values for visible attribute fields, so a field
  // that is in fieldStates but currently invisible must NOT be "owned" here
  // (I2) — otherwise its stored value is filtered out of `preserved` and
  // never re-emitted, silently dropping it.
  const formOwnedAttributeCodes = useMemo(() => new Set(
    fieldStates
      .filter((state) => state.visible && model.vocabByCode.get(state.code)?.kind === 'attribute')
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
      // M1 fix: buildCorrectionPayload defaults note to aggregate.note
      // (the unedited stored value) since 'note' is never form-owned/
      // attribute-carried — override it with whatever the textarea
      // currently holds so an edited note persists (`?? null` allows the
      // user to clear it, matching every other nullable correction field).
      const updatePayload = {
        ...buildCorrectionPayload(aggregate, formOwnedAttributeCodes, payload),
        note: currentNoteValue(values) ?? null,
      };
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
          templateCode={template?.code}
          allowedProductKinds={allowedProductKinds}
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
