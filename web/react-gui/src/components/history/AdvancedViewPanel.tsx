import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryAdvancedField, HistoryAdvancedResponse } from '../../history/types';

interface AdvancedViewPanelProps {
  data: HistoryAdvancedResponse | undefined;
  isLoading: boolean;
  error?: unknown;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatValue(t: HistoryTranslate, field: HistoryAdvancedField): string {
  if (field.value === null || field.value === undefined || field.value === '') {
    return t('history.advanced.value.unavailable');
  }
  if (typeof field.value === 'boolean') return field.value ? 'true' : 'false';
  return field.unit ? `${field.value} ${field.unit}` : String(field.value);
}

function fieldLabel(t: HistoryTranslate, field: HistoryAdvancedField): string {
  return t(`history.advanced.field.${field.field}`, { defaultValue: field.field });
}

function availabilityLabel(t: HistoryTranslate, field: HistoryAdvancedField): string {
  return t(`history.advanced.availability.${field.availability}`);
}

function getErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  return null;
}

export const AdvancedViewPanel: React.FC<AdvancedViewPanelProps> = ({ data, isLoading, error }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const fields = Object.values(data?.advancedFields ?? {});

  if (isLoading) {
    return (
      <section
        role="region"
        aria-label={t('history.advanced.title')}
        className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
      >
        <p className="text-sm font-semibold text-[var(--text)]">{t('history.advanced.loading')}</p>
      </section>
    );
  }

  const message = getErrorMessage(error);
  if (message) {
    return (
      <section
        role="region"
        aria-label={t('history.advanced.title')}
        className="mt-4 rounded-lg border border-[var(--warning-bg)] bg-[var(--warning-bg)] p-4 text-sm text-[var(--warning-text)]"
      >
        {message}
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.advanced.title')}
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
    >
      <h3 className="text-base font-semibold text-[var(--text)]">{t('history.advanced.title')}</h3>
      {fields.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">{t('history.advanced.emptyTitle')}</p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {fields.map((field) => (
            <div
              key={field.field}
              className="min-h-[5rem] rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="break-words text-sm font-semibold text-[var(--text)]">{fieldLabel(t, field)}</p>
                <span className="text-xs font-semibold text-[var(--text-tertiary)]">
                  {availabilityLabel(t, field)}
                </span>
              </div>
              <p className="mt-2 break-words text-sm font-mono text-[var(--text)]">{formatValue(t, field)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
