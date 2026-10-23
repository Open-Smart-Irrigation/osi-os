import { useEffect, useId, useRef, useState } from 'react';
import type { SensorSeries, SeriesAppearance } from '../shared/types';

export interface SeriesLegendLabels {
  legend: string;
  showAll: string;
  plottedSeries: string;
  seriesCount: (count: number) => string;
  focusAnnouncement: (label: string) => string;
  allSeriesAnnouncement: string;
}

export interface LegendSeries extends SensorSeries {
  appearance: SeriesAppearance;
}

interface SeriesLegendProps {
  series: readonly LegendSeries[];
  focusedSeriesId: string | null;
  onFocus: (id: string) => void;
  onShowAll: () => void;
  labels: SeriesLegendLabels;
  resetKey?: string;
}

export function SeriesSwatch({ appearance }: { appearance: SeriesAppearance }) {
  const marker = appearance.marker === 'circle' ? <circle cx="16" cy="8" r="3" fill={appearance.color} />
    : appearance.marker === 'square' ? <rect x="13" y="5" width="6" height="6" fill={appearance.color} />
      : appearance.marker === 'triangle' ? <path d="M16 4 L20 11 L12 11 Z" fill={appearance.color} />
        : <path d="M16 4 L20 8 L16 12 L12 8 Z" fill={appearance.color} />;
  return <svg className="mobile-series-legend-swatch" viewBox="0 0 32 16" aria-hidden="true">
    <line x1="2" y1="8" x2="30" y2="8" stroke={appearance.color} strokeWidth="2" strokeDasharray={appearance.dash.join(' ') || undefined} />
    {marker}
  </svg>;
}

export function SeriesLegend({ series, focusedSeriesId, onFocus, onShowAll, labels, resetKey = '' }: SeriesLegendProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lastResetKey = useRef(resetKey);
  const panelId = `mobile-series-legend-panel-${useId()}`;
  const compact = series.length >= 4;
  const resetChanged = lastResetKey.current !== resetKey;
  if (resetChanged) lastResetKey.current = resetKey;
  const isOpen = !resetChanged && open;
  useEffect(() => {
    setOpen(false);
  }, [compact, resetKey]);
  const rows = <div className="mobile-series-legend-rows" role="list" aria-label={labels.plottedSeries}>
    {series.map((item) => <div key={item.id} role="listitem"><button
      type="button"
      className={`mobile-series-legend-row${focusedSeriesId && focusedSeriesId !== item.id ? ' is-dimmed' : ''}`}
      aria-label={item.label}
      aria-pressed={focusedSeriesId === item.id}
      onClick={() => { onFocus(item.id); setOpen(false); buttonRef.current?.focus(); }}
    >
      <SeriesSwatch appearance={item.appearance} />
      <span className="mobile-series-legend-label">{item.label}</span>
    </button></div>)}
  </div>;
  const focusedSeries = focusedSeriesId ? series.find((item) => item.id === focusedSeriesId) : undefined;
  const closeWithEscape = (event: React.KeyboardEvent) => { if (event.key === 'Escape' && isOpen) { event.preventDefault(); setOpen(false); buttonRef.current?.focus(); } };
  if (!compact) return <div className="mobile-series-legend inline" aria-label={labels.legend}>{rows}{focusedSeriesId && <button type="button" aria-pressed="false" onClick={onShowAll}>{labels.showAll}</button>}</div>;
  return <div className="mobile-series-legend" aria-label={labels.legend} onKeyDown={closeWithEscape}>
    <div className="mobile-series-legend-toolbar">
      <span>{labels.seriesCount(series.length)}</span>
      <button ref={buttonRef} type="button" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>{labels.legend}</button>
      {focusedSeriesId && <button type="button" aria-pressed="false" onClick={onShowAll}>{labels.showAll}</button>}
    </div>
    {focusedSeries && <div className="mobile-series-legend-focus"><SeriesSwatch appearance={focusedSeries.appearance} /><span className="mobile-series-legend-focused-label">{focusedSeries.label}</span></div>}
    {isOpen && <div id={panelId} className="mobile-series-legend-panel">{rows}</div>}
  </div>;
}
