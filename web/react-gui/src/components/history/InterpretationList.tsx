import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryInterpretation } from '../../history/types';

interface InterpretationListProps {
  interpretations: HistoryInterpretation[];
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function toneForSeverity(severity: HistoryInterpretation['severity']): string {
  if (severity === 'warning') return 'border-[var(--cal-warn-border)] bg-[var(--cal-warn-bg)] text-[var(--cal-warn-text)]';
  if (severity === 'critical') return 'border-[var(--cal-bad-border)] bg-[var(--cal-bad-bg)] text-[var(--cal-bad-text)]';
  if (severity === 'success') return 'border-[var(--cal-good-border)] bg-[var(--cal-good-bg)] text-[var(--cal-good-text)]';
  return 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]';
}

function paramsFor(item: HistoryInterpretation): Record<string, unknown> {
  return item.params && typeof item.params === 'object' ? item.params : {};
}

function titleFor(t: HistoryTranslate, item: HistoryInterpretation): string | null {
  if (item.titleKey) return t(item.titleKey, paramsFor(item));
  return typeof item.title === 'string' && item.title.trim() ? item.title : null;
}

function bodyFor(t: HistoryTranslate, item: HistoryInterpretation): string | null {
  if (item.bodyKey) return t(item.bodyKey, paramsFor(item));
  return typeof item.body === 'string' && item.body.trim() ? item.body : null;
}

export const InterpretationList: React.FC<InterpretationListProps> = ({ interpretations }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const items = Array.isArray(interpretations) ? interpretations : [];

  if (items.length === 0) return null;

  return (
    <section className="mt-4" aria-label={t('history.interpretation.title')}>
      <h3 className="text-sm font-semibold text-[var(--text)]">{t('history.interpretation.title')}</h3>
      <ol className="mt-2 space-y-2">
        {items.map((item, index) => {
          const title = titleFor(t, item);
          const body = bodyFor(t, item);
          if (!title && !body) return null;
          return (
            <li
              key={item.id || item.ruleId || `interpretation-${index}`}
              className={`rounded-md border px-3 py-2 ${toneForSeverity(item.severity)}`}
            >
              {title && <p className="text-sm font-semibold">{title}</p>}
              {body && <p className="mt-1 text-sm">{body}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
