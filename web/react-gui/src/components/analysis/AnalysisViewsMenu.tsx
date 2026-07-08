import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisViewResponse } from '../../analysis/types';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface AnalysisViewsMenuProps {
  views: AnalysisViewResponse[];
  onSave: (name: string) => void;
  onLoad: (view: AnalysisViewResponse) => void;
  onDelete?: (id: number) => void;
}

export function AnalysisViewsMenu({ views, onSave, onLoad, onDelete }: AnalysisViewsMenuProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [name, setName] = useState('');
  const trimmed = name.trim();

  const save = () => {
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
  };

  return (
    <section className="analysis-views-menu flex flex-col gap-3" aria-label={t('analysis.views.title')}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">{t('analysis.views.title')}</h2>
        <span className="text-xs font-medium text-[var(--text-tertiary)]">{views.length}</span>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('analysis.views.namePlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
        />
        <button
          type="button"
          disabled={!trimmed}
          onClick={save}
          className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('analysis.views.save')}
        </button>
      </div>

      {views.length === 0 ? (
        <p className="text-sm text-[var(--text-tertiary)]">{t('analysis.views.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {views.map((view) => (
            <li
              key={view.id}
              className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5"
            >
              <button
                type="button"
                onClick={() => onLoad(view)}
                className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--text)] hover:underline"
              >
                {view.name}
              </button>
              {onDelete ? (
                <button
                  type="button"
                  aria-label={t('analysis.views.delete')}
                  onClick={() => onDelete(view.id)}
                  className="h-7 w-7 rounded text-sm font-semibold text-[var(--text-tertiary)] hover:bg-[var(--error-bg)] hover:text-[var(--error-text)]"
                >
                  <span aria-hidden="true">X</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
