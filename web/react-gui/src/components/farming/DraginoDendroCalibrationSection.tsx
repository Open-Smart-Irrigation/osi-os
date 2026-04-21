import React, { useEffect, useMemo, useState } from 'react';
import { lsn50API } from '../../services/api';
import type { Device } from '../../types/farming';

function formatNumericInput(value: number | null | undefined): string {
  if (value == null) return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : '';
}

function formatStemChangeUm(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return `${rounded > 0 ? '+' : ''}${rounded} µm`;
}

function formatDendroModeUsed(value: unknown): string | null {
  if (value === 'ratio_mod3') return 'Ratio MOD3';
  if (value === 'legacy_single_adc') return 'Legacy ADC';
  return null;
}

function isRatioDendroMode(value: unknown): boolean {
  return value === 'ratio_mod3';
}

function formatDendroRangeState(saturationSide: string | null | undefined): string {
  if (saturationSide === 'low') return 'Below retracted';
  if (saturationSide === 'high') return 'Above extended';
  return 'In range';
}

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

function parseOptionalNumericInput(label: string, value: string, options?: { positive?: boolean }): number | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (options?.positive && parsed <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
  return parsed;
}

type StatusTone = 'success' | 'warn' | 'muted';

type CalibrationStatus = {
  label: 'Calibrated' | 'Calibration required' | 'Legacy mode forced' | 'Awaiting baseline' | 'Out of range';
  detail: string;
  tone: StatusTone;
};

function getStatusClasses(tone: StatusTone): string {
  if (tone === 'success') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  }
  if (tone === 'warn') {
    return 'border-amber-200 bg-amber-50 text-amber-900';
  }
  return 'border-[var(--border)] bg-[var(--card)] text-[var(--text)]';
}

function getCalibrationStatus({
  dendroNeedsCalibration,
  forceLegacy,
  baselinePending,
  saturated,
  hasStroke,
  hasRetractedRatio,
  hasExtendedRatio,
}: {
  dendroNeedsCalibration: boolean;
  forceLegacy: boolean;
  baselinePending: boolean;
  saturated: boolean;
  hasStroke: boolean;
  hasRetractedRatio: boolean;
  hasExtendedRatio: boolean;
}): CalibrationStatus {
  if (forceLegacy) {
    return {
      label: 'Legacy mode forced',
      detail: 'This device is configured to stay on the legacy single-ADC dendrometer path.',
      tone: 'muted',
    };
  }
  if (dendroNeedsCalibration || !hasStroke || !hasRetractedRatio || !hasExtendedRatio) {
    return {
      label: 'Calibration required',
      detail: 'Save the stroke plus both ratio endpoints so ratio-mode telemetry can produce calibrated displacement.',
      tone: 'warn',
    };
  }
  if (saturated) {
    return {
      label: 'Out of range',
      detail: 'The current raw position is outside the saved calibration endpoints. Review the stored ratio range.',
      tone: 'warn',
    };
  }
  if (baselinePending) {
    return {
      label: 'Awaiting baseline',
      detail: 'Calibration is saved; the next valid uplink will establish the stem-change baseline.',
      tone: 'muted',
    };
  }
  return {
    label: 'Calibrated',
    detail: 'Stroke and ratio endpoints are present, and ratio-mode readings are ready to use.',
    tone: 'success',
  };
}

type StepCardProps = {
  step: number;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
};

const StepCard: React.FC<StepCardProps> = ({ step, title, description, children, className = '' }) => (
  <div className={`rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 ${className}`}>
    <div className="mb-3 flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--secondary-bg)] text-xs font-bold text-[var(--text)]">
        {step}
      </span>
      <div>
        <p className="text-sm font-semibold text-[var(--text)]">{title}</p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{description}</p>
      </div>
    </div>
    {children}
  </div>
);

interface DraginoDendroCalibrationSectionProps {
  device: Device;
  dendroNeedsCalibration: boolean;
  onUpdate: () => void;
}

export const DraginoDendroCalibrationSection: React.FC<DraginoDendroCalibrationSectionProps> = ({
  device,
  dendroNeedsCalibration,
  onUpdate,
}) => {
  const persistedForceLegacy = device.dendro_force_legacy === 1;
  const persistedStrokeMm = formatNumericInput(device.dendro_stroke_mm);
  const persistedRatioAtRetracted = formatNumericInput(device.dendro_ratio_at_retracted ?? device.dendro_ratio_zero);
  const persistedRatioAtExtended = formatNumericInput(device.dendro_ratio_at_extended ?? device.dendro_ratio_span);
  const [busy, setBusy] = useState<'dendro-config' | 'dendro-baseline-reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dendroForceLegacyInput, setDendroForceLegacyInput] = useState(persistedForceLegacy);
  const [dendroStrokeMmInput, setDendroStrokeMmInput] = useState(persistedStrokeMm);
  const [dendroRatioAtRetractedInput, setDendroRatioAtRetractedInput] = useState(
    persistedRatioAtRetracted,
  );
  const [dendroRatioAtExtendedInput, setDendroRatioAtExtendedInput] = useState(
    persistedRatioAtExtended,
  );

  const dendroData = device.latest_data ?? {};
  const liveDendroSource = formatDendroModeUsed(dendroData.dendro_mode_used);
  const liveShowRatio = isRatioDendroMode(dendroData.dendro_mode_used);
  const liveStemChange = formatStemChangeUm(dendroData.dendro_stem_change_um);
  const liveRangeState = formatDendroRangeState(dendroData.dendro_saturation_side);
  const showLegacyBaselineReset = device.dendro_enabled === 1
    && (dendroData.dendro_mode_used === 'legacy_single_adc' || persistedForceLegacy);
  const ratioCaptureAvailable = dendroData.dendro_ratio != null;
  const persistedHasStroke = persistedStrokeMm.trim() !== '';
  const persistedHasRetractedRatio = persistedRatioAtRetracted.trim() !== '';
  const persistedHasExtendedRatio = persistedRatioAtExtended.trim() !== '';
  const awaitingBaseline = device.dendro_baseline_pending === 1
    || (device.dendro_enabled === 1
      && dendroData.dendro_valid === 1
      && dendroData.dendro_position_raw_mm != null
      && dendroData.dendro_stem_change_um == null);
  const saturated = dendroData.dendro_saturated === 1;
  const draftDiffersFromSaved = dendroForceLegacyInput !== persistedForceLegacy
    || dendroStrokeMmInput !== persistedStrokeMm
    || dendroRatioAtRetractedInput !== persistedRatioAtRetracted
    || dendroRatioAtExtendedInput !== persistedRatioAtExtended;

  useEffect(() => {
    setDendroForceLegacyInput(persistedForceLegacy);
    setDendroStrokeMmInput(persistedStrokeMm);
    setDendroRatioAtRetractedInput(persistedRatioAtRetracted);
    setDendroRatioAtExtendedInput(persistedRatioAtExtended);
    setError(null);
  }, [
    device.deveui,
    persistedForceLegacy,
    persistedStrokeMm,
    persistedRatioAtExtended,
    persistedRatioAtRetracted,
  ]);

  const status = useMemo(
    () => getCalibrationStatus({
      dendroNeedsCalibration,
      forceLegacy: persistedForceLegacy,
      baselinePending: awaitingBaseline,
      saturated,
      hasStroke: persistedHasStroke,
      hasRetractedRatio: persistedHasRetractedRatio,
      hasExtendedRatio: persistedHasExtendedRatio,
    }),
    [
      awaitingBaseline,
      dendroNeedsCalibration,
      persistedForceLegacy,
      persistedHasExtendedRatio,
      persistedHasRetractedRatio,
      persistedHasStroke,
      saturated,
    ],
  );

  const telemetryItems = [
    liveStemChange ? { label: 'Stem change', value: liveStemChange } : null,
    dendroData.dendro_position_raw_mm != null
      ? { label: 'Raw position', value: `${dendroData.dendro_position_raw_mm.toFixed(2)} mm` }
      : null,
    dendroData.adc_ch0v != null ? { label: 'CH0', value: `${dendroData.adc_ch0v.toFixed(3)} V` } : null,
    liveShowRatio && dendroData.adc_ch1v != null ? { label: 'CH1', value: `${dendroData.adc_ch1v.toFixed(3)} V` } : null,
    liveShowRatio && dendroData.dendro_ratio != null ? { label: 'Current ratio', value: dendroData.dendro_ratio.toFixed(4) } : null,
    liveDendroSource ? { label: 'Source', value: liveDendroSource } : null,
    liveShowRatio ? { label: 'Range state', value: liveRangeState } : null,
  ].filter((item): item is { label: string; value: string } => item != null);

  const applyDendroConfig = async () => {
    let strokeMm: number | null;
    let ratioAtRetracted: number | null;
    let ratioAtExtended: number | null;

    try {
      strokeMm = parseOptionalNumericInput('Stroke (mm)', dendroStrokeMmInput, { positive: true });
      ratioAtRetracted = parseOptionalNumericInput('Retracted ratio', dendroRatioAtRetractedInput);
      ratioAtExtended = parseOptionalNumericInput('Extended ratio', dendroRatioAtExtendedInput);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid dendrometer calibration values');
      setInfo(null);
      return;
    }

    if (ratioAtRetracted !== null && ratioAtExtended !== null && ratioAtRetracted === ratioAtExtended) {
      setError('Retracted and extended ratios must differ.');
      setInfo(null);
      return;
    }

    setBusy('dendro-config');
    setError(null);
    setInfo(null);
    try {
      await lsn50API.setDendroConfig(device.deveui, {
        dendroForceLegacy: dendroForceLegacyInput,
        dendroStrokeMm: strokeMm,
        dendroRatioAtRetracted: ratioAtRetracted,
        dendroRatioAtExtended: ratioAtExtended,
      });
      setInfo(
        dendroForceLegacyInput
          ? 'Dendrometer calibration saved. Legacy ADC is forced for this device.'
          : 'Dendrometer calibration saved. Ratio MOD3 will be used when the uplink provides valid CH0 and CH1 in MOD3.',
      );
      onUpdate();
    } catch {
      setError('Failed to save dendrometer calibration');
    } finally {
      setBusy(null);
    }
  };

  const resetDendroBaseline = async () => {
    if (!window.confirm('Clear the stored stem-change baseline for this legacy dendrometer? The next valid uplink will establish a new zero point.')) {
      return;
    }

    setBusy('dendro-baseline-reset');
    setError(null);
    setInfo(null);
    try {
      await lsn50API.resetDendroBaseline(device.deveui);
      setInfo('Legacy stem baseline cleared. The next valid uplink will establish a new zero point.');
      onUpdate();
    } catch {
      setError('Failed to reset the dendrometer stem baseline');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border p-3 ${getStatusClasses(status.tone)}`}>
        <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Calibration status</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/70 px-2.5 py-1 text-sm font-semibold text-inherit">
            {status.label}
          </span>
        </div>
        <p className="mt-2 text-sm">{status.detail}</p>
      </div>

      <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-3">
        <input
          type="checkbox"
          checked={dendroForceLegacyInput}
          disabled={busy === 'dendro-config'}
          onChange={(event) => setDendroForceLegacyInput(event.target.checked)}
          className={`h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]`}
        />
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">Force legacy mode</p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">Use the legacy single-ADC path instead of ratio MOD3 for this device.</p>
        </div>
      </label>

      {draftDiffersFromSaved && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-tertiary)]">
          Draft changes are local to this form until you save calibration.
        </p>
      )}

      {telemetryItems.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Live telemetry</p>
          <div className="mt-2 grid gap-x-4 gap-y-2 md:grid-cols-2">
            {telemetryItems.map((item) => (
              <div key={item.label} className="flex items-baseline justify-between gap-3 border-b border-[var(--border)]/50 py-1 last:border-b-0">
                <span className="text-xs text-[var(--text-tertiary)]">{item.label}</span>
                <span className="text-xs font-semibold text-[var(--text)]">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <StepCard
          step={1}
          title="Set the dendrometer stroke"
          description="Enter the full mechanical stroke in millimeters. Leave it blank only if you want to clear the saved value."
        >
          <label className="block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`lsn50-dendro-stroke-${device.deveui}`}>
            Stroke (mm)
          </label>
          <input
            id={`lsn50-dendro-stroke-${device.deveui}`}
            type="number"
            step="0.001"
            min="0"
            inputMode="decimal"
            value={dendroStrokeMmInput}
            disabled={busy === 'dendro-config'}
            onChange={(event) => setDendroStrokeMmInput(event.target.value)}
            placeholder="25"
            className={`mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
          />
        </StepCard>

        <StepCard
          step={2}
          title="Capture the retracted endpoint"
          description="Move the sensor to the 0 mm position, then capture or enter the matching live ratio."
        >
          <label className="block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`lsn50-dendro-retracted-${device.deveui}`}>
            Retracted ratio (0 mm)
          </label>
          <input
            id={`lsn50-dendro-retracted-${device.deveui}`}
            type="number"
            step="0.000001"
            inputMode="decimal"
            value={dendroRatioAtRetractedInput}
            disabled={busy === 'dendro-config'}
            onChange={(event) => setDendroRatioAtRetractedInput(event.target.value)}
            placeholder="0.420000"
            className={`mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
          />
          <button
            type="button"
            disabled={busy === 'dendro-config' || !ratioCaptureAvailable}
            onClick={() => setDendroRatioAtRetractedInput(dendroData.dendro_ratio != null ? String(dendroData.dendro_ratio) : '')}
            className={`mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_VISIBLE_RING}`}
          >
            Capture current ratio
          </button>
        </StepCard>

        <StepCard
          step={3}
          title="Capture the extended endpoint"
          description="Move the sensor to full extension, then capture or enter the ratio for that endpoint."
        >
          <label className="block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`lsn50-dendro-extended-${device.deveui}`}>
            Extended ratio (full stroke)
          </label>
          <input
            id={`lsn50-dendro-extended-${device.deveui}`}
            type="number"
            step="0.000001"
            inputMode="decimal"
            value={dendroRatioAtExtendedInput}
            disabled={busy === 'dendro-config'}
            onChange={(event) => setDendroRatioAtExtendedInput(event.target.value)}
            placeholder="0.860000"
            className={`mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
          />
          <button
            type="button"
            disabled={busy === 'dendro-config' || !ratioCaptureAvailable}
            onClick={() => setDendroRatioAtExtendedInput(dendroData.dendro_ratio != null ? String(dendroData.dendro_ratio) : '')}
            className={`mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_VISIBLE_RING}`}
          >
            Capture current ratio
          </button>
        </StepCard>

        <StepCard
          step={4}
          title="Save calibration"
          description="Save the stroke and endpoint ratios together. Leave numeric fields blank if you want to clear stored values."
        >
          <p className="text-xs text-[var(--text-tertiary)]">
            Ratio mode uses retracted and extended endpoints to convert CH0 and CH1 into calibrated displacement.
          </p>
          <button
            type="button"
            onClick={() => void applyDendroConfig()}
            disabled={busy !== null}
            className={`mt-3 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
          >
            {busy === 'dendro-config' ? 'Saving dendrometer calibration…' : 'Save dendrometer calibration'}
          </button>
          {info && <p className="mt-2 text-xs text-[var(--text-tertiary)]">{info}</p>}
          {error && <p className="mt-2 text-xs text-[var(--error-text)]">{error}</p>}
        </StepCard>
      </div>

      {showLegacyBaselineReset && (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Legacy baseline reset</p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            Clear the stored stem-change zero for this legacy dendrometer. The next valid uplink will establish a new baseline.
          </p>
          <button
            type="button"
            onClick={() => void resetDendroBaseline()}
            disabled={busy !== null}
            className={`mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--card)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
          >
            {busy === 'dendro-baseline-reset' ? 'Resetting stem baseline…' : 'Reset stem baseline'}
          </button>
        </div>
      )}
    </div>
  );
};
