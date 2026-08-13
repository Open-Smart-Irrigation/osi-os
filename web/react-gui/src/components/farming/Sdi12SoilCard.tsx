import React from 'react';

import type { Device } from '../../types/farming';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import { formatSwtValue, kpaToPf } from '../../utils/swt';

interface Sdi12SoilCardProps {
  device: Device;
  onOpenSettings?: () => void;
  onRemove?: () => void;
  readOnly?: boolean;
}

type SoilChannel = 'vwc' | 'soil_temp' | 'soil_ec' | 'swt';

const CHANNELS: Array<{ kind: SoilChannel; unit: string; decimals: number }> = [
  { kind: 'vwc', unit: '%', decimals: 1 },
  { kind: 'soil_temp', unit: '°C', decimals: 1 },
  { kind: 'soil_ec', unit: 'µS/cm', decimals: 0 },
  { kind: 'swt', unit: 'kPa', decimals: 1 },
];

function finiteValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function depthLabel(device: Device, index: number): string {
  const depths = device.soil_moisture_probe_depths_json;
  const depth = CHANNELS
    .map(({ kind }) => depths?.[`${kind}_${index}`])
    .find((value) => value != null && Number.isFinite(Number(value)) && Number(value) > 0);
  return depth == null ? `#${index}` : `${Number(depth)} cm`;
}

function channelLabel(kind: SoilChannel): string {
  switch (kind) {
    case 'vwc': return 'VWC';
    case 'soil_temp': return 'Soil temperature';
    case 'soil_ec': return 'Soil EC';
    case 'swt': return 'SWT';
  }
}

function formatChannelValue(kind: SoilChannel, value: number): string {
  if (kind === 'swt') {
    const kpa = formatSwtValue(value, 'kPa');
    const pf = kpaToPf(value);
    const pfLabel = pf == null ? null : formatSwtValue(value, 'pF');
    return [kpa, pfLabel].filter(Boolean).join(' · ');
  }
  const channel = CHANNELS.find(({ kind: candidate }) => candidate === kind);
  return `${formatNumber(value, channel?.decimals ?? 1)} ${channel?.unit ?? ''}`.trim();
}

function minutesSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
}

export const Sdi12SoilCard: React.FC<Sdi12SoilCardProps> = ({
  device,
  onOpenSettings,
  readOnly = false,
}) => {
  const data = device.latest_data ?? {};
  const status = device.sdi12_probe_status ?? 'unknown';
  const statusLabel = status === 'pending_identify' ? 'identifying' : status;
  const profile = device.sdi12_probe_profile || 'No probe profile';
  const rows = Array.from({ length: 8 }, (_, offset) => {
    const index = offset + 1;
    const values = CHANNELS.map(({ kind }) => ({
      kind,
      value: finiteValue(data[`${kind}_${index}` as keyof typeof data]),
    })).filter(({ value }) => value != null) as Array<{ kind: SoilChannel; value: number }>;
    return { index, values };
  }).filter(({ values }) => values.length > 0);
  const minutesAgo = minutesSince(device.last_seen);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">
          {device.name}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
            SDI-12
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="Device settings"
              title="Device settings"
              className="p-1.5 rounded-md text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)] transition-colors"
            >
              ⚙
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] font-mono mb-2 truncate">{device.deveui}</p>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm text-[var(--text-secondary)] truncate">{profile}</span>
        <span className="rounded-full bg-[var(--secondary-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--text-secondary)]">
          {statusLabel}
        </span>
      </div>

      {status === 'pending_identify' && (
        <p className="mb-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
          Detecting probe (pending)
        </p>
      )}

      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map(({ index, values }) => (
            <div key={index} className="rounded-lg bg-[var(--card)] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
                Depth {depthLabel(device, index)}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text)]">
                {values.map(({ kind, value }) => (
                  <span key={kind}>
                    <span className="text-[var(--text-tertiary)]">{channelLabel(kind)}: </span>
                    <span className="tabular-nums">{formatChannelValue(kind, value)}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-[var(--card)] px-3 py-4 text-sm text-[var(--text-tertiary)]">
          No soil readings available.
        </p>
      )}

      <DeviceCardFooter
        lastSeenLabel={minutesAgo !== null ? `Last seen: ${minutesAgo} minutes ago` : 'Never seen'}
        batteryPercent={data.bat_pct}
        batteryVoltage={data.bat_v}
      />
    </div>
  );
};
