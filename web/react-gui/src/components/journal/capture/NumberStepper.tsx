import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]';

function decimalSeparator(locale: string): string {
  return new Intl.NumberFormat(locale).formatToParts(1.1)
    .find(({ type }) => type === 'decimal')?.value ?? '.';
}

function formatValue(value: number | null, locale: string): string {
  return value == null ? '' : new Intl.NumberFormat(locale, {
    maximumFractionDigits: 12,
    useGrouping: false,
  }).format(value);
}

function parseValue(raw: string, locale: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const decimal = decimalSeparator(locale);
  let normalized = trimmed.replace(/[\s\u00a0\u202f]/g, '');
  if (decimal !== '.') normalized = normalized.split(decimal).join('.');
  // Some mobile decimal keyboards expose a comma even when the active locale
  // formats with a dot. Treat it as a decimal only when it is unambiguous.
  if (!normalized.includes('.') && normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

function rounded(value: number): number {
  return Number(value.toPrecision(12));
}

type NumberValidationIssue =
  | { key: 'capture.validation.invalidNumber' }
  | { key: 'capture.validation.minimum'; value: number }
  | { key: 'capture.validation.maximum'; value: number };

function validationIssue(
  value: number | null,
  min?: number,
  max?: number,
): NumberValidationIssue | null {
  if (value != null && !Number.isFinite(value)) return { key: 'capture.validation.invalidNumber' };
  if (value != null && min != null && value < min) {
    return { key: 'capture.validation.minimum', value: min };
  }
  if (value != null && max != null && value > max) {
    return { key: 'capture.validation.maximum', value: max };
  }
  return null;
}

export interface NumberStepperProps {
  id: string;
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  onValidityChange?: (valid: boolean, error?: string) => void;
  locale?: string;
  min?: number;
  max?: number;
  step?: number;
  unitLabel?: string;
  error?: string | null;
  required?: boolean;
  // POLISH 6: true when this field is a required_any group member (not
  // unconditionally required itself, but effectively required until one
  // family member has a value) -- fed by the caller, which alone knows the
  // field's required_any_groups membership.
  requiredAnyGroup?: boolean;
  disabled?: boolean;
  // POLISH 5: a small, unobtrusive supplementary line under the control
  // (e.g. "defaulted from the plot area, edit if needed"). Purely
  // presentational -- NumberStepper has no opinion on when this applies.
  hint?: string | null;
}

export const NumberStepper: React.FC<NumberStepperProps> = ({
  id,
  label,
  value,
  onChange,
  onValidityChange,
  locale: localeOverride,
  min,
  max,
  step = 1,
  unitLabel,
  error: externalError,
  required = false,
  requiredAnyGroup = false,
  disabled = false,
  hint,
}) => {
  const { t, i18n } = useTranslation('journal');
  const locale = localeOverride || i18n.resolvedLanguage || i18n.language;
  const [raw, setRaw] = useState(() => formatValue(value, locale));
  const [localError, setLocalError] = useState<string | null>(null);
  const hasSynced = useRef(false);
  const onValidityChangeRef = useRef(onValidityChange);
  const error = externalError ?? localError;
  const errorId = `${id}-error`;

  useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  }, [onValidityChange]);

  const messageFor = (issue: NumberValidationIssue | null): string | null => {
    if (!issue) return null;
    if (issue.key === 'capture.validation.minimum') {
      return t(issue.key, { min: issue.value });
    }
    if (issue.key === 'capture.validation.maximum') {
      return t(issue.key, { max: issue.value });
    }
    return t(issue.key);
  };

  useEffect(() => {
    setRaw(formatValue(value, locale));
    const nextError = messageFor(validationIssue(value, min, max));
    setLocalError(nextError);
    if (hasSynced.current) {
      onValidityChangeRef.current?.(nextError == null, nextError ?? undefined);
    } else {
      hasSynced.current = true;
    }
  }, [locale, max, min, value]);

  const changeRaw = (nextRaw: string) => {
    setRaw(nextRaw);
    const next = parseValue(nextRaw, locale);
    const nextError = messageFor(validationIssue(next, min, max));
    setLocalError(nextError);
    onValidityChange?.(nextError == null, nextError ?? undefined);
    if (nextError == null) onChange(next);
  };

  const stepBy = (direction: -1 | 1) => {
    const origin = value ?? (min ?? 0);
    const stepped = rounded(origin + direction * step);
    const next = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, stepped));
    setRaw(formatValue(next, locale));
    setLocalError(null);
    onValidityChange?.(true, undefined);
    onChange(next);
  };

  const atMin = useMemo(() => value != null && min != null && value <= min, [min, value]);
  const atMax = useMemo(() => value != null && max != null && value >= max, [max, value]);

  // BUG 4: EntryForm's choice/boolean/text/product branches already render a
  // Required/Optional badge beside the field label; the number branches
  // (this component and NutrientRepeater) delegated to here and rendered
  // only the bare label, so a required number field showed no such signal.
  // Mirrors EntryForm's own statusLabel/aria-hidden pattern exactly (POLISH
  // 6: a required_any member gets its own "choose one" indicator instead of
  // "Optional", since it is effectively required until one family member
  // has a value).
  const statusLabel = required
    ? t('capture.form.required')
    : requiredAnyGroup ? t('capture.form.requiredChooseOne') : t('capture.form.optional');
  const statusHidden = required || requiredAnyGroup ? undefined : true;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--text)]">
        <span>{label}</span>
        <span aria-hidden={statusHidden} className="text-xs font-semibold text-[var(--text-secondary)]">
          {statusLabel}
        </span>
      </label>
      <div className="flex w-full items-stretch overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] focus-within:border-[var(--focus)]">
        <button
          type="button"
          aria-label={t('capture.form.decrease')}
          disabled={disabled || atMin}
          onClick={() => stepBy(-1)}
          className={`min-h-12 min-w-12 border-r border-[var(--border)] text-2xl font-bold text-[var(--primary)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] ${FOCUS_RING}`}
        >
          −
        </button>
        <div className="flex min-w-0 flex-1 items-center">
          <input
            id={id}
            type="text"
            inputMode="decimal"
            value={raw}
            required={required}
            aria-required={required}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => changeRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              stepBy(event.key === 'ArrowUp' ? 1 : -1);
            }}
            className={`min-h-12 min-w-0 flex-1 bg-transparent px-3 text-center text-lg font-bold tabular-nums text-[var(--text)] outline-none ${FOCUS_RING}`}
          />
          {unitLabel && (
            <span className="shrink-0 pr-3 text-sm font-bold text-[var(--text-secondary)]">
              {unitLabel}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label={t('capture.form.increase')}
          disabled={disabled || atMax}
          onClick={() => stepBy(1)}
          className={`min-h-12 min-w-12 border-l border-[var(--border)] text-2xl font-bold text-[var(--primary)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] ${FOCUS_RING}`}
        >
          +
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {error}
        </p>
      )}
      {!error && hint && (
        <p className="text-xs font-semibold text-[var(--text-secondary)]">{hint}</p>
      )}
    </div>
  );
};
