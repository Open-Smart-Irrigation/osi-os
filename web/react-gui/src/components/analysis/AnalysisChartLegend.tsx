import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { seriesColor } from '../../analysis/seriesColors';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface LegendSeries {
  seriesId: string;
  label: string;
}

interface AnalysisChartLegendProps {
  series: LegendSeries[];
  onRename: (seriesId: string, label: string | null) => void;
}

export function AnalysisChartLegend({ series, onRename }: AnalysisChartLegendProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (series.length === 0) return null;

  const startEdit = (s: LegendSeries) => {
    setEditingId(s.seriesId);
    setDraft(s.label);
  };

  const commit = (seriesId: string) => {
    const trimmed = draft.trim();
    onRename(seriesId, trimmed.length === 0 ? null : trimmed);
    setEditingId(null);
  };

  return (
    <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2" aria-label={t('analysis.legend.label')}>
      {series.map((s, i) => (
        <li key={s.seriesId} className="flex items-center gap-1.5 text-xs text-slate-700">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: seriesColor(i) }} aria-hidden />
          {editingId === s.seriesId ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(s.seriesId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(s.seriesId);
                if (e.key === 'Escape') setEditingId(null);
              }}
              className="w-40 rounded border border-slate-300 px-1 py-0.5 text-xs focus:border-slate-500 focus:outline-none"
              aria-label={t('analysis.legend.rename')}
            />
          ) : (
            <button
              type="button"
              onClick={() => startEdit(s)}
              title={t('analysis.legend.rename')}
              className="rounded px-0.5 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              {s.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
