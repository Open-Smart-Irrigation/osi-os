import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { zoneExportAPI } from '../../services/api';
import { RangeCalendar } from './RangeCalendar';
import type { RangeValue } from './rangeCalendarModel';

type ExportGranularity = 'raw' | 'hourly' | 'daily';

interface DataExportSectionProps {
  zoneId: number;
  todayIso: string;
  defaultChannels?: string[];
  initialRange?: RangeValue;
}

const GRANULARITIES: ExportGranularity[] = ['raw', 'hourly', 'daily'];

function errorMessage(error: unknown, fallback: string): string {
  const responseData = (error as { response?: { data?: { error?: string; suggestion?: string } } })?.response?.data;
  if (responseData?.error && responseData.suggestion) return `${responseData.error}: ${responseData.suggestion}`;
  if (responseData?.error) return responseData.error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export const DataExportSection: React.FC<DataExportSectionProps> = ({
  zoneId,
  todayIso,
  defaultChannels = [],
  initialRange,
}) => {
  const { t } = useTranslation('devices');
  const [range, setRange] = useState<RangeValue>(initialRange ?? { from: null, to: null });
  const [granularity, setGranularity] = useState<ExportGranularity>('raw');
  const [fullExport, setFullExport] = useState(defaultChannels.length === 0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = range.from;
  const to = range.to || range.from;
  const canDownload = Boolean(from && to && !downloading);
  const hasDefaultChannels = defaultChannels.length > 0;

  const handleDownload = async () => {
    if (!from || !to) return;
    setDownloading(true);
    setError(null);
    try {
      await zoneExportAPI.download(zoneId, {
        from,
        to,
        granularity,
        channels: hasDefaultChannels && !fullExport ? defaultChannels : undefined,
      });
    } catch (err) {
      setError(errorMessage(err, t('zone.export.error')));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-[var(--text)]">{t('zone.export.title')}</p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('zone.export.selectRange')}</p>
      </div>

      <RangeCalendar value={range} onChange={setRange} todayIso={todayIso} />

      {hasDefaultChannels && (
        <label className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            checked={fullExport}
            onChange={(event) => setFullExport(event.target.checked)}
            className="h-4 w-4 rounded border-[var(--border)]"
          />
          {t('zone.export.fullExport')}
        </label>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <label className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('zone.export.granularity')}
          <select
            value={granularity}
            onChange={(event) => setGranularity(event.target.value as ExportGranularity)}
            className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--text)]"
          >
            {GRANULARITIES.map((value) => (
              <option key={value} value={value}>{t(`zone.export.${value}`)}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!canDownload}
          onClick={() => void handleDownload()}
          className="self-end rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {downloading ? t('zone.export.downloading') : t('zone.export.download')}
        </button>
      </div>

      <p className="text-xs text-[var(--text-tertiary)]">
        {from && to
          ? t('zone.export.rangeSummary', { from, to })
          : t('zone.export.selectRange')}
      </p>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
      )}
    </div>
  );
};
