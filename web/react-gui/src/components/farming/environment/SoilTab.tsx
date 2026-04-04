import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Device, LocalEnvironment } from '../../../types/farming';

interface Props {
  local: LocalEnvironment;
  devices: Device[];
}

function formatValue(value: number | null | undefined, unit: string, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(digits)} ${unit}`;
}

function classifySoil(tensionKpa: number | null): string {
  if (tensionKpa == null || !Number.isFinite(tensionKpa)) {
    return 'No soil tension reading';
  }
  if (tensionKpa < 20) return 'Wet';
  if (tensionKpa < 60) return 'Moderate';
  return 'Dry';
}

export const SoilTab: React.FC<Props> = ({ local, devices }) => {
  const { t } = useTranslation('devices');
  const kiwiReadings = devices.flatMap((device) => {
    const data = device.latest_data;
    return [data?.swt_wm1, data?.swt_wm2].filter((value): value is number => value != null && Number.isFinite(value));
  });
  const representativeSwt = kiwiReadings.length
    ? kiwiReadings.reduce((sum, value) => sum + value, 0) / kiwiReadings.length
    : null;
  const soilMoistureMetric = local.metrics.find((metric) => metric.key === 'soil_moisture_pct');
  const soilTemperatureMetric = local.metrics.find((metric) => metric.key === 'soil_temperature_c');
  const soilState = classifySoil(representativeSwt);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('environment.soil.soilNow', { defaultValue: 'Soil now' })}
          </p>
          <p className="mt-2 text-2xl font-bold text-[var(--text)]">
            {representativeSwt != null ? `${representativeSwt.toFixed(1)} kPa` : '—'}
          </p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{soilState}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('environment.soil.moisture', { defaultValue: 'Soil moisture' })}
          </p>
          <p className="mt-2 text-2xl font-bold text-[var(--text)]">
            {formatValue(soilMoistureMetric?.median, '%', 1)}
          </p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {soilMoistureMetric ? `${soilMoistureMetric.sampleCount} supporting sensors` : 'Available when local sensors report % moisture'}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('environment.soil.temperature', { defaultValue: 'Soil temperature' })}
          </p>
          <p className="mt-2 text-2xl font-bold text-[var(--text)]">
            {formatValue(soilTemperatureMetric?.median, '°C', 1)}
          </p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {local.observedAt
              ? `Updated ${new Date(local.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'Waiting for fresh local readings'}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {t('environment.soil.interpretation', { defaultValue: 'Interpretation' })}
        </p>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          {representativeSwt != null
            ? `${soilState} soil tension based on the active Kiwi sensors. Use this as supporting evidence alongside the water balance and dendrometer recommendation.`
            : 'Soil tension appears when Kiwi sensors report SWT readings. Until then, the water tab stays the main decision view.'}
        </p>
      </div>
    </div>
  );
};
