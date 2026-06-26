import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { prettyUnit } from '../../analysis/channelLabels';
import type { AnalysisCatalogEntry } from '../../analysis/types';
import { canonicalize } from '../../channels/registry';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface MetricAcrossZonesPickerProps {
  channels: AnalysisCatalogEntry[];
  onApply: (channelKey: string) => void;
}

interface MetricOption {
  channelKey: string;
  displayName: string;
  unit: string | null;
}

function optionLabel(option: MetricOption): string {
  const unit = option.unit ? prettyUnit(option.unit) : '';
  return unit ? `${option.displayName} ${unit}` : option.displayName;
}

function availableMetricOptions(channels: AnalysisCatalogEntry[]): MetricOption[] {
  const options: MetricOption[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    if (channel.availability !== 'available') continue;
    const channelKey = canonicalize(channel.channelKey);
    if (seen.has(channelKey)) continue;
    seen.add(channelKey);
    options.push({
      channelKey,
      displayName: channel.displayName,
      unit: channel.unit,
    });
  }
  return options;
}

export function MetricAcrossZonesPicker({ channels, onApply }: MetricAcrossZonesPickerProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const options = useMemo(() => availableMetricOptions(channels), [channels]);
  if (options.length === 0) return null;

  return (
    <section
      aria-label={t('analysis.preset.metricLabel')}
      className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t('analysis.preset.metricLabel')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.channelKey}
            type="button"
            aria-label={optionLabel(option)}
            onClick={() => onApply(option.channelKey)}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-1"
          >
            <span>{option.displayName}</span>
            {option.unit ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600">
                {prettyUnit(option.unit)}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}
