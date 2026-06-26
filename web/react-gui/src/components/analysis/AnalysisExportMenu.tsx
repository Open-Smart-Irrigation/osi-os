import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisCatalogEntry, AnalysisSeries } from '../../analysis/types';
import { toTidyCsv } from '../../analysis/csv';
import { downloadBlob, downloadDataUrl } from '../../analysis/download';
import { exportFileName } from '../../analysis/exportName';
import type { EChartHandle } from './EChart';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface AnalysisExportMenuProps {
  series: AnalysisSeries[];
  catalogById: Map<string, AnalysisCatalogEntry>;
  chartRef: RefObject<EChartHandle | null>;
  username: string | null;
}

export function AnalysisExportMenu({
  series,
  catalogById,
  chartRef,
  username,
}: AnalysisExportMenuProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const disabled = series.length === 0;

  const exportCsv = () => {
    downloadBlob(exportFileName(username, 'csv'), toTidyCsv(series, catalogById), 'text/csv');
  };

  const exportPng = () => {
    const dataUrl = chartRef.current?.getExportDataURL();
    if (dataUrl) downloadDataUrl(exportFileName(username, 'png'), dataUrl);
  };

  return (
    <div className="analysis-export-menu flex gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={exportCsv}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {t('analysis.export.csv')}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={exportPng}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {t('analysis.export.png')}
      </button>
    </div>
  );
}
