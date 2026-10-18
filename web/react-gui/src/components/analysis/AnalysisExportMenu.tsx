import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisCatalogEntry, AnalysisSeries } from '../../analysis/types';
import { toTidyCsv } from '../../analysis/csv';
import { downloadBlob, downloadDataUrl } from '../../analysis/download';
import { exportFileName } from '../../analysis/exportName';
import { historyExportAPI, type HistoryExportGranularity } from '../../services/api';
import type { EChartHandle } from './EChart';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

// The gateway answers 413 past its range or row bound, 429 while another
// export runs and 400 for a range it cannot export.
function allZonesErrorKey(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 413) return 'analysis.export.errors.tooLarge';
  if (status === 429) return 'analysis.export.errors.busy';
  if (status === 400) return 'analysis.export.errors.invalidRange';
  return 'analysis.export.errors.failed';
}

interface AnalysisExportMenuProps {
  series: AnalysisSeries[];
  catalogById: Map<string, AnalysisCatalogEntry>;
  chartRef: RefObject<EChartHandle | null>;
  username: string | null;
  exportRange: { from: string; to: string } | null;
  exportGranularity: HistoryExportGranularity;
  /** The applied aggregation of the shown series; names rain amounts and bounds buckets in the CSV. */
  aggregation?: string;
  /** The end instant of the shown range; the last bucket of a version 2 row ends there. */
  rangeEnd?: string;
}

export function AnalysisExportMenu({
  series,
  catalogById,
  chartRef,
  username,
  exportRange,
  exportGranularity,
  aggregation,
  rangeEnd,
}: AnalysisExportMenuProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const disabled = series.length === 0;
  // Version 1 stays the default for saved scripts; version 2 adds timezone, period
  // bounds, quality, coverage and sample count (owner decision D3).
  const [qualityColumns, setQualityColumns] = useState(false);

  const exportCsv = () => {
    const csv = toTidyCsv(series, catalogById, { version: qualityColumns ? 2 : 1, aggregation, rangeEnd });
    downloadBlob(exportFileName(username, 'csv'), csv, 'text/csv');
  };

  const exportPng = () => {
    const dataUrl = chartRef.current?.getExportDataURL();
    if (dataUrl) downloadDataUrl(exportFileName(username, 'png'), dataUrl);
  };

  const [allZonesPending, setAllZonesPending] = useState(false);
  const [allZonesError, setAllZonesError] = useState<string | null>(null);

  const exportAllZonesCsv = () => {
    if (!exportRange || allZonesPending) return;
    setAllZonesPending(true);
    setAllZonesError(null);
    historyExportAPI.downloadAllZones({
      ...exportRange,
      granularity: exportGranularity,
    })
      .catch((error: unknown) => setAllZonesError(allZonesErrorKey(error)))
      .finally(() => setAllZonesPending(false));
  };

  return (
    <div className="analysis-export-menu">
    <div className="flex flex-wrap items-start gap-2">
      {/* The quality-columns switch belongs to this CSV only; the all-zones export is the gateway's own file. */}
      <div role="group" aria-label={t('analysis.export.csv')} className="flex flex-col gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={exportCsv}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--secondary-bg)] disabled:opacity-50"
        >
          {t('analysis.export.csv')}
        </button>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={qualityColumns}
            onChange={(event) => setQualityColumns(event.target.checked)}
            className="h-4 w-4 rounded border-[var(--border)]"
          />
          {t('analysis.export.qualityColumns')}
        </label>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={exportPng}
        className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--secondary-bg)] disabled:opacity-50"
      >
        {t('analysis.export.png')}
      </button>
      <button
        type="button"
        disabled={!exportRange || allZonesPending}
        aria-busy={allZonesPending}
        onClick={exportAllZonesCsv}
        className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--secondary-bg)] disabled:opacity-50"
      >
        {t(allZonesPending ? 'analysis.export.allZonesCsvBusy' : 'analysis.export.allZonesCsv')}
      </button>
    </div>
    {allZonesError && (
      <p role="alert" className="mt-2 text-sm text-[var(--warn-text)]">
        {t(allZonesError)}
      </p>
    )}
    </div>
  );
}
