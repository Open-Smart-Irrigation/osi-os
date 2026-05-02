import React, { useEffect, useState } from 'react';
import { lsn50API, type ChameleonConfigPayload } from '../../services/api';
import type { Device } from '../../types/farming';

type ChannelNumber = 1 | 2 | 3;

type ChannelInput = {
  depthCm: string;
  a: string;
  b: string;
  c: string;
};

type ChannelConfig = {
  number: ChannelNumber;
  label: string;
  depthKey: keyof Device;
  coefficientKeys: {
    a: keyof Device;
    b: keyof Device;
    c: keyof Device;
  };
  defaults: {
    a: number;
    b: number;
    c: number;
  };
};

const CHANNELS: ChannelConfig[] = [
  {
    number: 1,
    label: 'SWT1',
    depthKey: 'chameleon_swt1_depth_cm',
    coefficientKeys: {
      a: 'chameleon_swt1_a',
      b: 'chameleon_swt1_b',
      c: 'chameleon_swt1_c',
    },
    defaults: { a: 10.71, b: 0.13, c: 7.18 },
  },
  {
    number: 2,
    label: 'SWT2',
    depthKey: 'chameleon_swt2_depth_cm',
    coefficientKeys: {
      a: 'chameleon_swt2_a',
      b: 'chameleon_swt2_b',
      c: 'chameleon_swt2_c',
    },
    defaults: { a: 10.40, b: 0.13, c: 7.31 },
  },
  {
    number: 3,
    label: 'SWT3',
    depthKey: 'chameleon_swt3_depth_cm',
    coefficientKeys: {
      a: 'chameleon_swt3_a',
      b: 'chameleon_swt3_b',
      c: 'chameleon_swt3_c',
    },
    defaults: { a: 10.33, b: 0.12, c: 7.21 },
  },
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
      a: formatNumericInput(device[channel.coefficientKeys.a]),
      b: formatNumericInput(device[channel.coefficientKeys.b]),
      c: formatNumericInput(device[channel.coefficientKeys.c]),
    };
    return acc;
  }, {} as Record<ChannelNumber, ChannelInput>);
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

  useEffect(() => {
    setInputs(buildInitialInputs(device));
    setError(null);
    setInfo(null);
  }, [
    device.deveui,
    device.chameleon_swt1_depth_cm,
    device.chameleon_swt2_depth_cm,
    device.chameleon_swt3_depth_cm,
    device.chameleon_swt1_a,
    device.chameleon_swt1_b,
    device.chameleon_swt1_c,
    device.chameleon_swt2_a,
    device.chameleon_swt2_b,
    device.chameleon_swt2_c,
    device.chameleon_swt3_a,
    device.chameleon_swt3_b,
    device.chameleon_swt3_c,
  ]);

  const updateInput = (channelNumber: ChannelNumber, field: keyof ChannelInput, value: string) => {
    setInputs((current) => ({
      ...current,
      [channelNumber]: {
        ...current[channelNumber],
        [field]: value,
      },
    }));
  };

  const restoreWorkbookDefaults = () => {
    setInputs((current) => {
      const next = { ...current };
      for (const channel of CHANNELS) {
        next[channel.number] = {
          ...next[channel.number],
          a: String(channel.defaults.a),
          b: String(channel.defaults.b),
          c: String(channel.defaults.c),
        };
      }
      return next;
    });
    setError(null);
    setInfo('Workbook defaults restored in the form. Save calibration to apply them.');
  };

  const saveChameleonCalibration = async () => {
    let payload: ChameleonConfigPayload;
    try {
      payload = {
        chameleonSwt1DepthCm: parseOptionalNumericInput('SWT1 depth', inputs[1].depthCm, { positive: true, decimals: 2 }),
        chameleonSwt2DepthCm: parseOptionalNumericInput('SWT2 depth', inputs[2].depthCm, { positive: true, decimals: 2 }),
        chameleonSwt3DepthCm: parseOptionalNumericInput('SWT3 depth', inputs[3].depthCm, { positive: true, decimals: 2 }),
        chameleonSwt1A: parseOptionalNumericInput('SWT1 coefficient a', inputs[1].a, { decimals: 6 }),
        chameleonSwt1B: parseOptionalNumericInput('SWT1 coefficient b', inputs[1].b, { decimals: 6 }),
        chameleonSwt1C: parseOptionalNumericInput('SWT1 coefficient c', inputs[1].c, { decimals: 6 }),
        chameleonSwt2A: parseOptionalNumericInput('SWT2 coefficient a', inputs[2].a, { decimals: 6 }),
        chameleonSwt2B: parseOptionalNumericInput('SWT2 coefficient b', inputs[2].b, { decimals: 6 }),
        chameleonSwt2C: parseOptionalNumericInput('SWT2 coefficient c', inputs[2].c, { decimals: 6 }),
        chameleonSwt3A: parseOptionalNumericInput('SWT3 coefficient a', inputs[3].a, { decimals: 6 }),
        chameleonSwt3B: parseOptionalNumericInput('SWT3 coefficient b', inputs[3].b, { decimals: 6 }),
        chameleonSwt3C: parseOptionalNumericInput('SWT3 coefficient c', inputs[3].c, { decimals: 6 }),
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid Chameleon calibration values');
      setInfo(null);
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await lsn50API.setChameleonConfig(device.deveui, payload);
      setInfo('Chameleon calibration saved.');
      onUpdate();
    } catch {
      setError('Failed to save Chameleon calibration');
    } finally {
      setBusy(false);
    }
  };

  const liveSwt1 = formatLiveMetric(device.latest_data?.swt_1, 'kPa', 1);
  const liveSwt2 = formatLiveMetric(device.latest_data?.swt_2, 'kPa', 1);
  const liveSwt3 = formatLiveMetric(device.latest_data?.swt_3, 'kPa', 1);
  const liveResistance1 = formatLiveMetric(device.latest_data?.chameleon_r1_ohm_comp, 'ohm', 0);
  const liveResistance2 = formatLiveMetric(device.latest_data?.chameleon_r2_ohm_comp, 'ohm', 0);
  const liveResistance3 = formatLiveMetric(device.latest_data?.chameleon_r3_ohm_comp, 'ohm', 0);

  const liveByChannel: Record<ChannelNumber, Array<{ label: string; value: string }>> = {
    1: [
      liveSwt1 ? { label: 'SWT', value: liveSwt1 } : null,
      liveResistance1 ? { label: 'Compensated R', value: liveResistance1 } : null,
    ].filter((item): item is { label: string; value: string } => item != null),
    2: [
      liveSwt2 ? { label: 'SWT', value: liveSwt2 } : null,
      liveResistance2 ? { label: 'Compensated R', value: liveResistance2 } : null,
    ].filter((item): item is { label: string; value: string } => item != null),
    3: [
      liveSwt3 ? { label: 'SWT', value: liveSwt3 } : null,
      liveResistance3 ? { label: 'Compensated R', value: liveResistance3 } : null,
    ].filter((item): item is { label: string; value: string } => item != null),
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        {CHANNELS.map((channel) => {
          const channelInput = inputs[channel.number];
          const liveItems = liveByChannel[channel.number];
          return (
            <div key={channel.number} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--text)]">{channel.label}</p>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">Depth and calibration coefficients</p>
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
                <label className="block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`chameleon-${device.deveui}-${channel.label}-depth`}>
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

                {(['a', 'b', 'c'] as const).map((field) => (
                  <div key={field}>
                    <label className="block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`chameleon-${device.deveui}-${channel.label}-${field}`}>
                      Coefficient {field}
                    </label>
                    <input
                      id={`chameleon-${device.deveui}-${channel.label}-${field}`}
                      type="number"
                      step="0.000001"
                      inputMode="decimal"
                      value={channelInput[field]}
                      disabled={busy}
                      onChange={(event) => updateInput(channel.number, field, event.target.value)}
                      placeholder={String(channel.defaults[field])}
                      className={`mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={restoreWorkbookDefaults}
          disabled={busy}
          className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
        >
          Restore workbook defaults
        </button>
        <button
          type="button"
          onClick={() => void saveChameleonCalibration()}
          disabled={busy}
          className={`rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
        >
          {busy ? 'Saving Chameleon calibration...' : 'Save Chameleon calibration'}
        </button>
      </div>

      {info && <p className="text-xs text-[var(--text-tertiary)]">{info}</p>}
      {error && <p className="text-xs text-[var(--error-text)]">{error}</p>}
    </div>
  );
};
