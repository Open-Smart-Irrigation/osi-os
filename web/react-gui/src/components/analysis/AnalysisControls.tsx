import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisRange, AnalysisWorkspaceMode, TimelineLayout } from '../../analysis/types';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

const RANGES = ['12h', '24h', '7d', '30d', '90d', 'custom'] as const;
const MODES: AnalysisWorkspaceMode[] = ['timeline', 'correlation'];
const LAYOUTS: TimelineLayout[] = ['stacked', 'overlaid', 'small-multiples'];

interface AnalysisControlsProps {
  rangeLabel: string;
  range?: AnalysisRange;
  mode: AnalysisWorkspaceMode;
  layout: TimelineLayout;
  toggles: { normalize: boolean };
  onRangeChange: (range: string | AnalysisRange) => void;
  onModeChange: (mode: AnalysisWorkspaceMode) => void;
  onLayoutChange: (layout: TimelineLayout) => void;
  onToggle: (key: 'normalize', value: boolean) => void;
}

function inputToIso(value: string): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isoToDatetimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

export function AnalysisControls({
  rangeLabel,
  range,
  mode,
  layout,
  toggles,
  onRangeChange,
  onModeChange,
  onLayoutChange,
  onToggle,
}: AnalysisControlsProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [customOpen, setCustomOpen] = useState(rangeLabel === 'custom' || range?.label === 'custom');
  const [customFrom, setCustomFrom] = useState(() => isoToDatetimeLocal(range?.from));
  const [customTo, setCustomTo] = useState(() => isoToDatetimeLocal(range?.to));
  const customFromMs = Date.parse(customFrom);
  const customToMs = Date.parse(customTo);
  const hasCustomValues = customFrom.length > 0 && customTo.length > 0;
  const customValid = hasCustomValues && Number.isFinite(customFromMs) && Number.isFinite(customToMs) && customFromMs < customToMs;
  const customInvalid = hasCustomValues && !customValid;
  const showCustom = customOpen || rangeLabel === 'custom';
  const segBtn = (active: boolean) => [
    'px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-inset',
    active ? 'bg-[var(--primary)] text-white' : 'bg-[var(--card)] text-[var(--text-secondary)] hover:bg-[var(--secondary-bg)]',
  ].join(' ');
  const layoutLabelKey = (value: TimelineLayout) => (value === 'small-multiples' ? 'smallMultiples' : value);

  useEffect(() => {
    if (rangeLabel !== 'custom' && range?.label !== 'custom') return;
    setCustomOpen(true);
    setCustomFrom(isoToDatetimeLocal(range?.from));
    setCustomTo(isoToDatetimeLocal(range?.to));
  }, [rangeLabel, range?.label, range?.from, range?.to]);

  const applyCustomRange = () => {
    if (!customValid) return;
    const from = inputToIso(customFrom);
    const to = inputToIso(customTo);
    if (!from || !to) return;
    onRangeChange({ mode: 'custom', label: 'custom', from, to });
  };

  return (
    <div className="analysis-controls flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <div
          className="analysis-control-group analysis-ranges inline-flex overflow-hidden rounded-md border border-[var(--border)] divide-x divide-[var(--border)]"
          role="group"
          aria-label={t('analysis.range.label')}
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === rangeLabel || (r === 'custom' && showCustom)}
              onClick={() => {
                if (r === 'custom') {
                  setCustomOpen(true);
                  return;
                }
                setCustomOpen(false);
                onRangeChange(r);
              }}
              className={segBtn(r === rangeLabel || (r === 'custom' && showCustom))}
            >
              {r === 'custom' ? t('analysis.range.custom') : r}
            </button>
          ))}
        </div>
        <div
          className="analysis-control-group analysis-modes inline-flex overflow-hidden rounded-md border border-[var(--border)] divide-x divide-[var(--border)]"
          role="group"
          aria-label={t('analysis.mode.label')}
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mode}
              onClick={() => onModeChange(m)}
              className={segBtn(m === mode)}
            >
              {t(`analysis.mode.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'timeline' ? (
          <>
            <div
              className="analysis-control-group analysis-layouts inline-flex overflow-hidden rounded-md border border-[var(--border)] divide-x divide-[var(--border)]"
              role="group"
              aria-label={t('analysis.layout.label')}
            >
              {LAYOUTS.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={l === layout}
                  onClick={() => onLayoutChange(l)}
                  className={segBtn(l === layout)}
                >
                  {t(`analysis.layout.${layoutLabelKey(l)}`)}
                </button>
              ))}
            </div>
            <div className="analysis-toggle-group flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-2 focus:ring-[var(--focus)]"
                  checked={toggles.normalize}
                  onChange={(e) => onToggle('normalize', e.target.checked)}
                  aria-label={t('analysis.toggle.normalize')}
                />
                {t('analysis.toggle.normalize')}
              </label>
            </div>
          </>
        ) : null}
      </div>
      {showCustom ? (
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]">
            {t('analysis.range.from')}
            <input
              type="datetime-local"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label={t('analysis.range.from')}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-normal text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]">
            {t('analysis.range.to')}
            <input
              type="datetime-local"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label={t('analysis.range.to')}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-normal text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
            />
          </label>
          <button
            type="button"
            onClick={applyCustomRange}
            disabled={!customValid}
            className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white transition hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--toggle-off)] disabled:text-[var(--text-disabled)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-1"
          >
            {t('analysis.range.apply')}
          </button>
          {customInvalid ? <p className="text-sm text-[var(--warn-text)]">{t('analysis.range.invalid')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
