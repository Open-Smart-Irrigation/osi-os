import React, { useEffect, useState } from 'react';
import { lsn50API } from '../../services/api';
import type { Device } from '../../types/farming';

type ChannelNumber = 1 | 2 | 3;

type ChannelInput = {
  depthCm: string;
};

type ChannelConfig = {
  number: ChannelNumber;
  label: string;
  depthKey: keyof Device;
};

const CHANNELS: ChannelConfig[] = [
  { number: 1, label: 'SWT1', depthKey: 'chameleon_swt1_depth_cm' },
  { number: 2, label: 'SWT2', depthKey: 'chameleon_swt2_depth_cm' },
  { number: 3, label: 'SWT3', depthKey: 'chameleon_swt3_depth_cm' },
];

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

function formatNumericInput(value: unknown): string {
  if (value == null) return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : '';
}

function formatLiveMetric(value: unknown, unit: string, decimals: number): string | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return `${numeric.toFixed(decimals)} ${unit}`;
}

function parseOptionalNumericInput(
  label: string,
  value: string,
  options: { positive?: boolean; decimals: 2 | 6 },
): number | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (options.positive && parsed <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
  if (options.decimals === 2) {
    return Math.round(parsed * 100) / 100;
  }
  return Math.round(parsed * 1000000) / 1000000;
}

function buildInitialInputs(device: Device): Record<ChannelNumber, ChannelInput> {
  return CHANNELS.reduce((acc, channel) => {
    acc[channel.number] = {
      depthCm: formatNumericInput(device[channel.depthKey]),
    };
    return acc;
  }, {} as Record<ChannelNumber, ChannelInput>);
}

interface ChameleonHardwareInfoProps {
  arrayId: string | null;
  status: 'calibrated' | 'pending' | 'unknown' | null;
  source: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}

function ChameleonHardwareInfo({
  arrayId,
  status,
  source,
  onRefresh,
  refreshing,
}: ChameleonHardwareInfoProps) {
  const shortId = arrayId ? arrayId.substring(2, 4) + arrayId.substring(14, 16) : null;
  const badge =
    status === 'calibrated'
      ? { label: 'Calibrated' + (source ? ` via ${source}` : ''), color: 'var(--success)' }
      : status === 'pending'
        ? { label: 'Pending sync…', color: 'var(--warning)' }
        : status === 'unknown'
          ? { label: 'Calibration unavailable', color: 'var(--text-tertiary)' }
          : { label: 'No reading yet', color: 'var(--text-tertiary)' };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex items-center gap-2 text-xs">
        {shortId && (
          <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[var(--text-secondary)]">
            {shortId}
          </span>
        )}
        {arrayId && (
          <span className="font-mono text-[var(--text-tertiary)]">{arrayId}</span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span
          className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{ backgroundColor: badge.color + '20', color: badge.color }}
        >
          {badge.label}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || !arrayId}
          className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
        >
          {refreshing ? 'Refreshing…' : 'Refresh calibration'}
        </button>
      </div>
    </div>
  );
}

interface DraginoChameleonSwtSectionProps {
  device: Device;
  onUpdate: () => void;
}

export const DraginoChameleonSwtSection: React.FC<DraginoChameleonSwtSectionProps> = ({
  device,
  onUpdate,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<ChannelNumber, ChannelInput>>(() => buildInitialInputs(device));
  const [refreshing, setRefreshing] = useState(false);
  const [calibStatus, setCalibStatus] = useState<'calibrated' | 'pending' | 'unknown' | null>(null);
  const [calibSource, setCalibSource] = useState<string | null>(null);
  const [arrayId, setArrayId] = useState<string | null>(null);

  useEffect(() => {
    setInputs(buildInitialInputs(device));
    setError(null);
    setInfo(null);
  }, [
    device.deveui,
    device.chameleon_swt1_depth_cm,
    device.chameleon_swt2_depth_cm,
    device.chameleon_swt3_depth_cm,
  ]);

  useEffect(() => {
    const latest = device.latest_data;
    setCalibStatus(device.calibration_status ?? null);
    setArrayId(latest?.chameleon_array_id ?? null);
  }, [device.calibration_status, device.latest_data?.chameleon_array_id]);

  const updateInput = (channelNumber: ChannelNumber, field: keyof ChannelInput, value: string) => {
    setInputs((current) => ({
      ...current,
      [channelNumber]: {
        ...current[channelNumber],
        [field]: value,
      },
    }));
  };

  const saveDepths = async () => {
    let payload: { chameleonSwt1DepthCm?: number | null; chameleonSwt2DepthCm?: number | null; chameleonSwt3DepthCm?: number | null };
    try {
      payload = {
        chameleonSwt1DepthCm: parseOptionalNumericInput('SWT1 depth', inputs[1].depthCm, { positive: true, decimals: 2 }),
        chameleonSwt2DepthCm: parseOptionalNumericInput('SWT2 depth', inputs[2].depthCm, { positive: true, decimals: 2 }),
        chameleonSwt3DepthCm: parseOptionalNumericInput('SWT3 depth', inputs[3].depthCm, { positive: true, decimals: 2 }),
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid depth values');
      setInfo(null);
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await lsn50API.setChameleonDepth(device.deveui, payload);
      setInfo('Chameleon depths saved.');
      onUpdate();
    } catch {
      setError('Failed to save Chameleon depths');
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await lsn50API.refreshChameleonCalibration(device.deveui);
      setCalibStatus(result.status);
      setCalibSource(result.source ?? null);
      setInfo(result.status === 'calibrated' ? 'Calibration refreshed.' : 'Calibration not found.');
    } catch {
      setError('Failed to refresh calibration');
    } finally {
      setRefreshing(false);
    }
  };

  const liveSwt1 = formatLiveMetric(device.latest_data?.swt_1, 'kPa', 1);
  const liveSwt2 = formatLiveMetric(device.latest_data?.swt_2, 'kPa', 1);
  const liveSwt3 = formatLiveMetric(device.latest_data?.swt_3, 'kPa', 1);

  const liveByChannel: Record<ChannelNumber, Array<{ label: string; value: string }>> = {
    1: [liveSwt1 ? { label: 'SWT', value: liveSwt1 } : null].filter(
      (item): item is { label: string; value: string } => item != null,
    ),
    2: [liveSwt2 ? { label: 'SWT', value: liveSwt2 } : null].filter(
      (item): item is { label: string; value: string } => item != null,
    ),
    3: [liveSwt3 ? { label: 'SWT', value: liveSwt3 } : null].filter(
      (item): item is { label: string; value: string } => item != null,
    ),
  };

  return (
    <div className="space-y-3">
      <ChameleonHardwareInfo
        arrayId={arrayId}
        status={calibStatus}
        source={calibSource}
        onRefresh={() => void handleRefresh()}
        refreshing={refreshing}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        {CHANNELS.map((channel) => {
          const channelInput = inputs[channel.number];
          const liveItems = liveByChannel[channel.number];
          return (
            <div key={channel.number} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--text)]">{channel.label}</p>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">Depth</p>
                </div>
              </div>

              {liveItems.length > 0 && (
                <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  {liveItems.map((item) => (
                    <div key={item.label} className="flex items-baseline justify-between gap-2 py-0.5">
                      <span className="text-xs text-[var(--text-tertiary)]">{item.label}</span>
                      <span className="text-xs font-semibold text-[var(--text)]">{item.value}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 space-y-2">
                <label
                  className="block text-xs font-semibold text-[var(--text-secondary)]"
                  htmlFor={`chameleon-${device.deveui}-${channel.label}-depth`}
                >
                  Depth (cm)
                </label>
                <input
                  id={`chameleon-${device.deveui}-${channel.label}-depth`}
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={channelInput.depthCm}
                  disabled={busy}
                  onChange={(event) => updateInput(channel.number, 'depthCm', event.target.value)}
                  placeholder="30"
                  className={`w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void saveDepths()}
          disabled={busy}
          className={`rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
        >
          {busy ? 'Saving Chameleon depths...' : 'Save Chameleon depths'}
        </button>
      </div>

      {info && <p className="text-xs text-[var(--text-tertiary)]">{info}</p>}
      {error && <p className="text-xs text-[var(--error-text)]">{error}</p>}
    </div>
  );
};
