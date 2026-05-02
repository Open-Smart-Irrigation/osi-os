import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Device, LocalEnvironment } from '../../../types/farming';
import { collectDeviceSwtValues } from '../../../utils/swt';

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

export const SoilTab: React.FC<Props> = ({ local, devices }) => {
  const { t } = useTranslation('devices');
  const swtReadings = collectDeviceSwtValues(devices);
  const representativeSwt = swtReadings.length
    ? swtReadings.reduce((sum, value) => sum + value, 0) / swtReadings.length
    : null;
  const soilMoistureMetric = local.metrics.find((metric) => metric.key === 'soil_moisture_pct');
  const soilTemperatureMetric = local.metrics.find((metric) => metric.key === 'soil_temperature_c');

  const hasSwt = representativeSwt != null;
  const hasVwc = soilMoistureMetric != null;

  const moistureLabel =
    hasSwt && hasVwc ? 'Soil Moisture (SWT & VWC)' :
    hasSwt           ? 'Soil Moisture (SWT)' :
    hasVwc           ? 'Soil Moisture (VWC)' :
                       'Soil Moisture';

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {/* Soil moisture — combined SWT / VWC tile */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {moistureLabel}
          </p>
          {hasSwt && hasVwc ? (
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
                {representativeSwt!.toFixed(1)} kPa
              </span>
              <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
                {soilMoistureMetric!.median.toFixed(1)} %
              </span>
            </div>
          ) : hasSwt ? (
            <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--text)]">
              {representativeSwt!.toFixed(1)} kPa
            </p>
          ) : hasVwc ? (
            <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--text)]">
              {soilMoistureMetric!.median.toFixed(1)} %
            </p>
          ) : (
            <p className="mt-2 text-2xl font-bold text-[var(--text)]">—</p>
          )}
        </div>

        {/* Soil temperature */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('environment.soil.temperature', { defaultValue: 'Soil temperature' })}
          </p>
          <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--text)]">
            {formatValue(soilTemperatureMetric?.median, '°C', 1)}
          </p>
        </div>
      </div>
    </div>
  );
};
