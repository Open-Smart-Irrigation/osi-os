import { useTranslation } from 'react-i18next';

import { allowedChoices, catalogLabel } from '../../../journal/catalogModel';
import type {
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
  JournalScalar,
} from '../../../types/journalCapture';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';
const TOUCH_CONTROL = 'min-h-[56px]';

export interface PlotContextValues {
  [attributeCode: string]: JournalScalar;
}

export interface PlotContextFieldsProps {
  model: JournalCaptureCatalogModel;
  layout: JournalLayoutDefinition | undefined;
  value: PlotContextValues;
  onChange: (next: PlotContextValues) => void;
  disabled?: boolean;
  locale?: string;
}

function isEmptyValue(value: JournalScalar | undefined): boolean {
  return value === undefined || value === null || value === '';
}

// Slice BC (R1 Part 2): plot-static context fields (block/bed/row, structure
// compartment, experimental unit, surface area, ...) are simple, rarely-edited
// facts set once per plot. Number fields are entered directly in the
// attribute's default unit (no multi-unit picker) — deliberately simpler than
// EntryForm's NumberStepper, since these values are not per-entry
// measurements.
export function PlotContextFields({
  model,
  layout,
  value,
  onChange,
  disabled = false,
  locale: localeOverride,
}: PlotContextFieldsProps) {
  const { t, i18n } = useTranslation('journal');
  const locale = localeOverride || i18n?.resolvedLanguage || i18n?.language || 'en';
  const fieldCodes = layout?.static_context_fields ?? [];

  if (fieldCodes.length === 0) return null;

  const setValue = (code: string, next: JournalScalar) => {
    const updated = { ...value };
    if (isEmptyValue(next)) delete updated[code];
    else updated[code] = next;
    onChange(updated);
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 border-0 p-0">
      <legend className="mb-1 block text-sm font-bold text-[var(--text)]">
        {t('plot.context', { defaultValue: 'Plot context' })}
      </legend>
      <p className="text-xs text-[var(--text-secondary)]">
        {t('plot.contextHint', {
          defaultValue: 'Set once per plot and carried onto every entry made here.',
        })}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        {fieldCodes.map((code) => {
          const attribute = model.vocabByCode.get(code);
          if (!attribute) return null;
          const label = catalogLabel(attribute, locale);
          const current = value[code];
          const inputId = `plot-context-${code}`;

          if (attribute.value_type === 'choice') {
            const choices = layout ? allowedChoices(model, layout, code, {}) : [];
            return (
              <div key={code} className="min-w-0">
                <label htmlFor={inputId} className={`mb-2 block ${TOUCH_CONTROL} flex items-center text-sm font-bold text-[var(--text)]`}>
                  {label}
                </label>
                <select
                  id={inputId}
                  className={`w-full ${TOUCH_CONTROL} min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`}
                  value={typeof current === 'string' ? current : ''}
                  onChange={(event) => setValue(code, event.target.value)}
                >
                  <option value="">{t('capture.form.select', { defaultValue: 'Select…' })}</option>
                  {choices.map((choiceCode) => (
                    <option key={choiceCode} value={choiceCode}>
                      {catalogLabel(model.vocabByCode.get(choiceCode)!, locale)}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          if (attribute.value_type === 'number') {
            const unitCode = attribute.default_unit_code;
            const unitRow = unitCode ? model.vocabByCode.get(unitCode) : undefined;
            const unitLabel = unitRow ? catalogLabel(unitRow, locale) : '';
            return (
              <div key={code} className="min-w-0">
                <label htmlFor={inputId} className={`mb-2 block ${TOUCH_CONTROL} flex items-center text-sm font-bold text-[var(--text)]`}>
                  {label}
                  {unitLabel && <span className="ml-2 text-xs font-normal text-[var(--text-secondary)]">({unitLabel})</span>}
                </label>
                <input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  className={`w-full ${TOUCH_CONTROL} min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`}
                  value={typeof current === 'number' ? String(current) : ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw.trim() === '') { setValue(code, null); return; }
                    const parsed = Number(raw);
                    if (Number.isFinite(parsed)) setValue(code, parsed);
                  }}
                />
              </div>
            );
          }

          if (attribute.value_type === 'boolean') {
            return (
              <div key={code} className="min-w-0">
                <span className={`mb-2 block ${TOUCH_CONTROL} flex items-center text-sm font-bold text-[var(--text)]`}>
                  {label}
                </span>
                <div className="inline-flex w-full overflow-hidden rounded-xl border border-[var(--border)]">
                  {([true, false] as const).map((option) => (
                    <button
                      key={String(option)}
                      type="button"
                      aria-pressed={current === option}
                      onClick={() => setValue(code, option)}
                      className={`min-h-12 flex-1 px-4 py-2 text-sm font-bold transition-colors ${
                        current === option ? 'bg-[var(--primary)] text-white' : 'bg-[var(--surface)] text-[var(--text)]'
                      } ${FOCUS_RING}`}
                    >
                      {t(option ? 'capture.form.booleanYes' : 'capture.form.booleanNo')}
                    </button>
                  ))}
                </div>
              </div>
            );
          }

          const type = attribute.value_type === 'date' ? 'date' : 'text';
          return (
            <div key={code} className="min-w-0">
              <label htmlFor={inputId} className={`mb-2 block ${TOUCH_CONTROL} flex items-center text-sm font-bold text-[var(--text)]`}>
                {label}
              </label>
              <input
                id={inputId}
                type={type}
                className={`w-full ${TOUCH_CONTROL} min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] outline-none ${FOCUS_RING}`}
                value={typeof current === 'string' ? current : ''}
                onChange={(event) => setValue(code, event.target.value)}
              />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function parsePlotContextJson(raw: string | null | undefined): PlotContextValues {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: PlotContextValues = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      result[key] = entry;
    }
  }
  return result;
}

// `undefined` when there is nothing meaningful to send, so callers can omit
// `context_json` from a write payload entirely rather than sending `null`
// noise for plots/layouts that have no static-context fields at all.
export function serializePlotContext(
  value: PlotContextValues,
  fieldCodes: readonly string[],
): string | null | undefined {
  if (fieldCodes.length === 0) return undefined;
  const filtered: PlotContextValues = {};
  for (const code of fieldCodes) {
    if (!isEmptyValue(value[code])) filtered[code] = value[code];
  }
  return Object.keys(filtered).length === 0 ? null : JSON.stringify(filtered);
}
