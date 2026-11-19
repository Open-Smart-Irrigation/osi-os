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
    // Weather sources would add identical series for zones on one location.
    if (channel.sourceKind !== 'device' || channel.availability !== 'available' || channel.zoneId === null) continue;
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

// Display grouping only: every available metric remains selectable under More.
const AGRONOMIC_METRICS = new Set([
  'ambient_temperature', 'relative_humidity', 'light_lux', 'ext_temperature_c',
  'rain_mm_per_hour', 'rain_mm_per_10min', 'rain_mm_today', 'rain_mm_delta',
  'wind_speed_mps', 'wind_gust_mps', 'wind_direction_deg', 'barometric_pressure_hpa',
  'uv_index', 'dendro_stem_change_um', 'dendro_delta_mm',
  'flow_liters_per_min', 'flow_liters_per_10min', 'flow_liters_today', 'flow_liters_delta',
  'global_radiation_wm2', 'et0_mm', 'etc_mm',
]);

function isAgronomicMetric(key: string): boolean {
  return /^(swt_[1-3]|vwc(?:_[0-9]+)?|soil_(?:temp|ec|vic)_[0-9]+)$/.test(key)
    || AGRONOMIC_METRICS.has(key);
}

export function MetricAcrossZonesPicker({ channels, onApply }: MetricAcrossZonesPickerProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const options = useMemo(() => availableMetricOptions(channels), [channels]);
  if (options.length === 0) return null;

  const renderOption = (option: MetricOption) => (
    <button
      key={option.channelKey}
      type="button"
      aria-label={optionLabel(option)}
      onClick={() => onApply(option.channelKey)}
      className="inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-left text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-1"
    >
      <span className="min-w-0 break-words">{option.displayName}</span>
      {option.unit ? <span className="shrink-0 rounded bg-[var(--card)] px-1.5 py-0.5 text-xs font-normal text-[var(--text-secondary)]">{prettyUnit(option.unit)}</span> : null}
    </button>
  );
  const primary = options.filter((option) => isAgronomicMetric(option.channelKey));
  const technical = options.filter((option) => !isAgronomicMetric(option.channelKey));

  return (
    <section aria-label={t('analysis.preset.metricLabel')}>
      <details className="mt-3 min-w-0 rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          {t('analysis.preset.metricLabel')}
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">{primary.map(renderOption)}</div>
        {technical.length > 0 ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">{t('analysis.preset.more')}</summary>
            <div className="mt-2 flex flex-wrap gap-2">{technical.map(renderOption)}</div>
          </details>
        ) : null}
      </details>
    </section>
  );
}
