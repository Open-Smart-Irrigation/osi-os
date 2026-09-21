import React from 'react';
import { useTranslation } from 'react-i18next';

import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import { EditableName } from './shared/EditableName';
import { DeviceRemoveConfirm, deviceRemoveButtonLabel } from './DeviceRemoveConfirm';
import { useDeviceRemoval, type DeviceRemoveContext } from './useDeviceRemoval';
import { formatSwtValue, kpaToPf } from '../../utils/swt';

// Larger than the device's slowest plausible TX interval -- must match
// Sdi12SettingsModal.tsx's SDI12_IDENTIFY_TIMEOUT_MINUTES. Client-derived
// only; the devices.sdi12_probe_status CHECK constraint has no such value.
const SDI12_IDENTIFY_TIMEOUT_MINUTES = 15;

interface Sdi12SoilCardProps {
  device: Device;
  onOpenSettings?: () => void;
  onRemove?: () => void;
  onUpdate?: () => void;
  readOnly?: boolean;
  /** Required: 'zone' detaches from the zone only, 'farm' unlinks from the account. */
  removeContext: DeviceRemoveContext;
}

type SoilChannel = 'vwc' | 'soil_vic' | 'soil_temp' | 'soil_ec' | 'swt';

const CHANNELS: Array<{ kind: SoilChannel; unit: string; decimals: number }> = [
  { kind: 'vwc', unit: '%', decimals: 1 },
  { kind: 'soil_vic', unit: '', decimals: 3 },
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
    case 'soil_vic': return 'VIC';
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
  onRemove,
  onUpdate,
  readOnly = false,
  removeContext,
}) => {
  const { t } = useTranslation('devices');

  const handleRename = async (nextName: string) => {
    await devicesAPI.rename(device.deveui, nextName);
    onUpdate?.();
  };
  const removal = useDeviceRemoval({ deveui: device.deveui, removeContext, onRemove });
  const data = device.latest_data ?? {};
  const status = device.sdi12_probe_status ?? 'unknown';
  const statusLabel = status === 'pending_identify' ? 'identifying' : status;
  const profile = device.sdi12_probe_profile || 'No probe profile';
  const pendingMinutesAgo = status === 'pending_identify' ? minutesSince(device.updated_at) : null;
  const pendingNoResponse = pendingMinutesAgo != null && pendingMinutesAgo > SDI12_IDENTIFY_TIMEOUT_MINUTES;
  const deployment = device.sdi12_recipe_deployment;
  const deploymentLabel = deployment?.status === 'observed_compatible'
    ? t('sdi12.active')
    : deployment ? t('sdi12.deploymentStatus', { status: deployment.status }) : null;

  const configuredSensors = device.sdi12_channel_layout_json?.sensors ?? [];
  const rows = configuredSensors.length > 0
    ? [...configuredSensors]
      .sort((left, right) => left.depth_cm - right.depth_cm)
      .map((sensor) => ({
        index: sensor.channel,
        depthCm: sensor.depth_cm,
        values: [
          { kind: 'vwc' as const, value: finiteValue(data[`vwc_${sensor.channel}` as keyof typeof data]) },
          ...(sensor.type === 'TRISCAN'
            ? [{ kind: 'soil_vic' as const, value: finiteValue(data[`soil_vic_${sensor.channel}` as keyof typeof data]) }]
            : []),
        ],
      }))
    : Array.from({ length: 10 }, (_, offset) => {
      const index = offset + 1;
      const values = CHANNELS.map(({ kind }) => ({
        kind,
        value: finiteValue(data[`${kind}_${index}` as keyof typeof data]),
      })).filter(({ value }) => value != null) as Array<{ kind: SoilChannel; value: number | null }>;
      return { index, depthCm: null, values };
    }).filter(({ values }) => values.length > 0);
  const minutesAgo = minutesSince(device.last_seen);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <EditableName
          name={device.name}
          canEdit={!readOnly}
          onSave={handleRename}
          renameLabel={t('rename.device')}
          inputLabel={t('rename.deviceInputLabel')}
          headingClassName="text-base font-semibold text-[var(--text)] truncate leading-tight"
        />
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
              className="touch-target p-1.5 rounded-md text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)] transition-colors"
            >
              ⚙
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={removal.openConfirm}
              disabled={removal.isRemoving}
              className="touch-target p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
              title={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
            >
              ✕
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

      {removal.error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-text)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-3 text-sm">
          {removal.error}
        </div>
      )}

      {!readOnly && removal.showConfirm && (
        <DeviceRemoveConfirm
          removeContext={removeContext}
          isRemoving={removal.isRemoving}
          onConfirm={() => void removal.confirmRemove()}
          onCancel={removal.cancelConfirm}
        />
      )}

      {status === 'pending_identify' && (
        <p className="mb-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
          {pendingNoResponse ? t('sdi12.noResponse') : 'Detecting probe (pending)'}
        </p>
      )}

      {device.sdi12_layout_status === 'invalid' && (
        <p className="mb-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
          The saved Sentek channel layout is invalid. Open device settings and save a valid layout before relying on soil readings.
        </p>
      )}

      {deploymentLabel && (
        <p className={`mb-3 rounded-lg px-3 py-2 text-sm ${deployment?.status === 'degraded'
          ? 'bg-[var(--error-bg)] text-[var(--error-text)]'
          : 'bg-[var(--secondary-bg)] text-[var(--text-secondary)]'}`}>
          {deploymentLabel}{deployment?.last_error_code ? ` (${deployment.last_error_code})` : ''}
        </p>
      )}

      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map(({ index, depthCm, values }) => (
            <div key={index} className="rounded-lg bg-[var(--card)] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-1">
                Depth {depthCm == null ? depthLabel(device, index) : `${depthCm} cm`}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text)]">
                {values.map(({ kind, value }) => (
                  <span key={kind}>
                    <span className="text-[var(--text-tertiary)]">{channelLabel(kind)}: </span>
                    <span className="tabular-nums">{value == null ? '—' : formatChannelValue(kind, value)}</span>
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
