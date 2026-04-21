import React, { useEffect, useRef, useState } from 'react';
import type { Device, Lsn50Mode } from '../../types/farming';
import { lsn50API } from '../../services/api';
import { DraginoDendroCalibrationSection } from './DraginoDendroCalibrationSection';

const SENSOR_OPTIONS: Array<{
  key: 'temp_enabled' | 'dendro_enabled' | 'rain_gauge_enabled' | 'flow_meter_enabled';
  label: string;
  toggle: (deveui: string, enabled: boolean) => Promise<void>;
}> = [
  { key: 'temp_enabled', label: 'Temperature', toggle: (id, enabled) => lsn50API.setTempEnabled(id, enabled) },
  { key: 'dendro_enabled', label: 'Dendrometer', toggle: (id, enabled) => lsn50API.setDendroEnabled(id, enabled) },
  { key: 'rain_gauge_enabled', label: 'Rain Gauge', toggle: (id, enabled) => lsn50API.setRainGaugeEnabled(id, enabled) },
  { key: 'flow_meter_enabled', label: 'Flow Meter', toggle: (id, enabled) => lsn50API.setFlowMeterEnabled(id, enabled) },
];

const LSN50_MODE_OPTIONS: Array<{ value: Lsn50Mode; description: string }> = [
  { value: 'MOD1', description: 'Default OSI mode with temperature probe and ADC support.' },
  { value: 'MOD2', description: 'Distance mode.' },
  { value: 'MOD3', description: 'Three ADC channels plus I2C mode.' },
  { value: 'MOD4', description: 'Three DS18B20 temperature channels mode.' },
  { value: 'MOD5', description: 'Weight mode.' },
  { value: 'MOD6', description: 'Counting mode.' },
  { value: 'MOD7', description: 'Three digital interrupt channels mode.' },
  { value: 'MOD8', description: 'Three ADC channels plus one DS18B20 mode.' },
  { value: 'MOD9', description: 'Rain gauge and flow counter mode.' },
];

const LSN50_INTERRUPT_MODE_OPTIONS = [
  { value: 0, label: 'Disabled' },
  { value: 1, label: 'Rising or falling edge' },
  { value: 2, label: 'Falling edge only' },
  { value: 3, label: 'Rising edge only' },
];

const MAX_LSN50_INTERVAL_MINUTES = Math.floor(0xffffff / 60);
const MAX_LSN50_5V_WARMUP_MS = 65535;

function requiresMod9Counter(
  key: 'temp_enabled' | 'dendro_enabled' | 'rain_gauge_enabled' | 'flow_meter_enabled',
): boolean {
  return key === 'rain_gauge_enabled' || key === 'flow_meter_enabled';
}

function normaliseLsn50Mode(value: unknown): Lsn50Mode | null {
  const raw = String(value ?? '').trim().toUpperCase();
  return raw === 'MOD1' || raw === 'MOD2' || raw === 'MOD3' || raw === 'MOD4' || raw === 'MOD5' || raw === 'MOD6' || raw === 'MOD7' || raw === 'MOD8' || raw === 'MOD9'
    ? raw
    : null;
}

function getCurrentLsn50Mode(device: Device): Lsn50Mode | null {
  const observed = normaliseLsn50Mode(device.latest_data?.lsn50_mode_label);
  if (observed) return observed;
  const configured = Number(device.device_mode ?? 0);
  return configured >= 1 && configured <= 9 ? (`MOD${configured}` as Lsn50Mode) : null;
}

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      [
        'button:not([disabled])',
        '[href]',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(', '),
    ),
  ).filter((element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden'));
}

type SettingsSectionProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
};

const SettingsSection: React.FC<SettingsSectionProps> = ({ title, description, children, className = '' }) => (
  <section className={`rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 ${className}`}>
    <div className="mb-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{title}</p>
      {description && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{description}</p>}
    </div>
    {children}
  </section>
);

interface DraginoSettingsModalProps {
  device: Device;
  dendroNeedsCalibration: boolean;
  onUpdate: () => void;
  onClose: () => void;
}

export const DraginoSettingsModal: React.FC<DraginoSettingsModalProps> = ({
  device,
  dendroNeedsCalibration,
  onUpdate,
  onClose,
}) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<Lsn50Mode>(getCurrentLsn50Mode(device) ?? 'MOD1');
  const [pendingMode, setPendingMode] = useState<Lsn50Mode | null>(null);
  const [modeInfo, setModeInfo] = useState<string | null>(null);
  const [intervalMinutesInput, setIntervalMinutesInput] = useState('');
  const [intervalInfo, setIntervalInfo] = useState<string | null>(null);
  const [interruptModeInput, setInterruptModeInput] = useState('0');
  const [warmupMillisecondsInput, setWarmupMillisecondsInput] = useState('');
  const [externalSensorInfo, setExternalSensorInfo] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const currentMode = getCurrentLsn50Mode(device);
  const observedAt = device.latest_data?.lsn50_mode_observed_at ?? null;
  const observedAtDate = observedAt ? new Date(observedAt) : null;
  const observedAtLabel = observedAtDate && !Number.isNaN(observedAtDate.getTime())
    ? observedAtDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const selectedModeDescription = LSN50_MODE_OPTIONS.find((option) => option.value === selectedMode)?.description ?? '';
  const counterModeReady = currentMode === 'MOD9' || pendingMode === 'MOD9';
  const titleId = `dragino-settings-title-${device.deveui}`;
  const modeSelectId = `lsn50-mode-${device.deveui}`;
  const interruptModeSelectId = `lsn50-interrupt-mode-${device.deveui}`;
  const advancedSettingsId = `dragino-advanced-settings-${device.deveui}`;

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreFocus = () => {
      openerRef.current?.focus();
    };
    const focusTarget = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = activeElement ? focusable.indexOf(activeElement) : -1;
      const lastIndex = focusable.length - 1;
      let nextIndex = currentIndex;

      if (event.shiftKey) {
        nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
      } else {
        nextIndex = currentIndex === -1 || currentIndex >= lastIndex ? 0 : currentIndex + 1;
      }

      if (nextIndex !== currentIndex) {
        event.preventDefault();
        focusable[nextIndex]?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.cancelAnimationFrame(focusTarget);
      restoreFocus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!pendingMode) {
      setSelectedMode(currentMode ?? 'MOD1');
    }
  }, [currentMode, pendingMode]);

  useEffect(() => {
    if (pendingMode && currentMode === pendingMode) {
      setModeInfo(`Mode ${pendingMode} confirmed on the latest uplink.`);
      setPendingMode(null);
    }
  }, [currentMode, pendingMode]);

  const toggle = async (option: typeof SENSOR_OPTIONS[number]) => {
    const current = device[option.key] === 1;
    if (!current && requiresMod9Counter(option.key) && !counterModeReady) {
      setError('Rain gauge and flow meter require MOD9. Apply MOD9 before enabling these counters.');
      return;
    }
    setBusy(option.key);
    setError(null);
    try {
      await option.toggle(device.deveui, !current);
      onUpdate();
    } catch {
      setError(`Failed to update ${option.label}`);
    } finally {
      setBusy(null);
    }
  };

  const applyMode = async () => {
    if (selectedMode === currentMode && !pendingMode) {
      setModeInfo(`LSN50 is already using ${selectedMode}.`);
      return;
    }
    if (
      selectedMode !== 'MOD1' &&
      (device.dendro_enabled === 1 || device.temp_enabled === 1) &&
      !window.confirm('Switching away from MOD1 can change the telemetry OSI receives from this node. Continue?')
    ) {
      return;
    }

    setBusy('mode');
    setError(null);
    setModeInfo(null);
    try {
      await lsn50API.setMode(device.deveui, selectedMode);
      setPendingMode(selectedMode);
      setModeInfo(`Mode change requested; waiting for the next uplink to confirm ${selectedMode}.`);
      onUpdate();
    } catch {
      setPendingMode(null);
      setError('Failed to change LSN50 mode');
    } finally {
      setBusy(null);
    }
  };

  const applyInterval = async () => {
    const parsed = Number(intervalMinutesInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LSN50_INTERVAL_MINUTES) {
      setError(`Enter a whole number of minutes between 1 and ${MAX_LSN50_INTERVAL_MINUTES}.`);
      setIntervalInfo(null);
      return;
    }

    setBusy('interval');
    setError(null);
    setIntervalInfo(null);
    try {
      await lsn50API.setUplinkInterval(device.deveui, parsed);
      setIntervalMinutesInput(String(parsed));
      setIntervalInfo(`Uplink interval change requested for ${parsed} minute${parsed === 1 ? '' : 's'}. The device applies this after it receives the downlink.`);
      onUpdate();
    } catch {
      setError('Failed to change LSN50 uplink interval');
    } finally {
      setBusy(null);
    }
  };

  const applyInterruptMode = async () => {
    const parsed = Number(interruptModeInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
      setError('Interrupt mode must be between 0 and 3.');
      setExternalSensorInfo(null);
      return;
    }

    setBusy('interrupt');
    setError(null);
    setExternalSensorInfo(null);
    try {
      await lsn50API.setInterruptMode(device.deveui, parsed);
      setExternalSensorInfo(`Interrupt mode ${parsed} requested. This affects external interrupt-driven sensor inputs.`);
      onUpdate();
    } catch {
      setError('Failed to change the LSN50 interrupt mode');
    } finally {
      setBusy(null);
    }
  };

  const applyFiveVoltWarmup = async () => {
    const parsed = Number(warmupMillisecondsInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_LSN50_5V_WARMUP_MS) {
      setError(`Enter a warm-up time between 0 and ${MAX_LSN50_5V_WARMUP_MS} ms.`);
      setExternalSensorInfo(null);
      return;
    }

    setBusy('warmup');
    setError(null);
    setExternalSensorInfo(null);
    try {
      await lsn50API.setFiveVoltWarmup(device.deveui, parsed);
      setExternalSensorInfo(`5V warm-up request queued for ${parsed} ms.`);
      onUpdate();
    } catch {
      setError('Failed to change the 5V warm-up time');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-bold text-[var(--text)]">Device settings</h2>
            <p className="mt-1 truncate text-sm text-[var(--text-tertiary)]">{device.name}</p>
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            className={`rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] ${FOCUS_VISIBLE_RING}`}
          >
            Close
          </button>
        </div>

        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto p-5">
          <p className="mb-4 px-1 text-xs text-[var(--text-tertiary)]">
            Sensor toggles apply immediately. Mode, interval, advanced device settings, and dendrometer calibration only save when you press their action buttons.
          </p>

          <SettingsSection title="Active sensors">
            {SENSOR_OPTIONS.map((option) => {
              const enabled = device[option.key] === 1;
              const loading = busy === option.key;
              const requiresMod9 = requiresMod9Counter(option.key) && !counterModeReady;
              const disabled = loading || (requiresMod9 && !enabled);
              return (
                <label
                  key={option.key}
                  className={`flex select-none items-center gap-3 rounded-lg px-1 py-2 ${
                    disabled ? 'cursor-not-allowed opacity-90' : 'cursor-pointer hover:bg-[var(--card)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={disabled}
                    onChange={() => void toggle(option)}
                    className={`h-4 w-4 rounded border-[var(--border)] text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card)]`}
                  />
                  <span className="flex-1 text-sm text-[var(--text)]">{option.label}</span>
                  {requiresMod9 && !enabled && (
                    <span className="text-xs font-semibold uppercase tracking-wide text-[var(--warn-text)]">Requires MOD9</span>
                  )}
                  {loading && <span className="text-xs text-[var(--text-tertiary)]">…</span>}
                </label>
              );
            })}
          </SettingsSection>

          <SettingsSection
            title="Mode & uplink"
            description="Choose the device mode and cadence together so the mode constraints and reporting interval stay aligned."
            className="mt-3"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <label htmlFor={modeSelectId} className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                      LSN50 mode
                    </label>
                    <p className="text-sm font-semibold text-[var(--text)]">{currentMode ?? 'Unknown'}</p>
                  </div>
                  {observedAtLabel && (
                    <span className="text-xs text-[var(--text-tertiary)]">
                      Seen {observedAtLabel}
                    </span>
                  )}
                </div>
                <select
                  id={modeSelectId}
                  value={selectedMode}
                  disabled={busy === 'mode'}
                  onChange={(event) => setSelectedMode(event.target.value as Lsn50Mode)}
                  className={`mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
                >
                  {LSN50_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.value}</option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-[var(--text-tertiary)]">{selectedModeDescription}</p>
                {!counterModeReady && (
                  <p className="mt-2 text-xs text-[var(--warn-text)]">Rain gauge and flow meter can only be enabled after MOD9 is active.</p>
                )}
                <button
                  type="button"
                  onClick={() => void applyMode()}
                  disabled={busy !== null}
                  className={`mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
                >
                  {busy === 'mode' ? 'Applying mode…' : 'Apply mode'}
                </button>
                {modeInfo && <p className="mt-2 text-xs text-[var(--text-tertiary)]">{modeInfo}</p>}
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]" htmlFor={`lsn50-interval-${device.deveui}`}>
                  Uplink interval (minutes)
                </label>
                <input
                  id={`lsn50-interval-${device.deveui}`}
                  type="number"
                  min={1}
                  max={MAX_LSN50_INTERVAL_MINUTES}
                  step={1}
                  inputMode="numeric"
                  value={intervalMinutesInput}
                  disabled={busy === 'interval'}
                  onChange={(event) => setIntervalMinutesInput(event.target.value)}
                  placeholder="60"
                  className={`mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
                />
                <p className="mt-2 text-xs text-[var(--text-tertiary)]">Minimum 1 minute. Maximum {MAX_LSN50_INTERVAL_MINUTES} minutes.</p>
                <button
                  type="button"
                  onClick={() => void applyInterval()}
                  disabled={busy !== null}
                  className={`mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
                >
                  {busy === 'interval' ? 'Applying interval…' : 'Apply uplink interval'}
                </button>
                {intervalInfo && <p className="mt-2 text-xs text-[var(--text-tertiary)]">{intervalInfo}</p>}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="External sensor behavior"
            description="Lower-emphasis controls for external sensor inputs and non-default integrations."
            className="mt-3 bg-[var(--surface)]"
          >
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              aria-expanded={showAdvanced}
              aria-controls={advancedSettingsId}
              className={`flex w-full items-center justify-between rounded-lg bg-[var(--card)] px-3 py-2 text-left text-sm font-semibold text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
            >
              <span>Advanced device settings</span>
              <span className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {showAdvanced && (
              <div id={advancedSettingsId} className="mt-3 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                <div>
                  <label htmlFor={interruptModeSelectId} className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]">
                    Interrupt trigger mode
                  </label>
                  <select
                    id={interruptModeSelectId}
                    value={interruptModeInput}
                    disabled={busy === 'interrupt'}
                    onChange={(event) => setInterruptModeInput(event.target.value)}
                    className={`w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
                  >
                    {LSN50_INTERRUPT_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void applyInterruptMode()}
                    disabled={busy !== null}
                    className={`mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
                  >
                    {busy === 'interrupt' ? 'Applying interrupt mode…' : 'Apply interrupt mode'}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]" htmlFor={`lsn50-warmup-${device.deveui}`}>
                    5V warm-up time (ms)
                  </label>
                  <input
                    id={`lsn50-warmup-${device.deveui}`}
                    type="number"
                    min={0}
                    max={MAX_LSN50_5V_WARMUP_MS}
                    step={1}
                    inputMode="numeric"
                    value={warmupMillisecondsInput}
                    disabled={busy === 'warmup'}
                    onChange={(event) => setWarmupMillisecondsInput(event.target.value)}
                    placeholder="1000"
                    className={`w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`}
                  />
                  <p className="mt-2 text-xs text-[var(--text-tertiary)]">Useful for probes that need sensor power to settle before sampling.</p>
                  <button
                    type="button"
                    onClick={() => void applyFiveVoltWarmup()}
                    disabled={busy !== null}
                    className={`mt-2 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_VISIBLE_RING}`}
                  >
                    {busy === 'warmup' ? 'Applying 5V warm-up…' : 'Apply 5V warm-up'}
                  </button>
                </div>
                <p className="text-xs text-[var(--warn-text)]">These controls are intended for external sensors and non-default LSN50 integrations.</p>
                {externalSensorInfo && <p className="text-xs text-[var(--text-tertiary)]">{externalSensorInfo}</p>}
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title="Dendrometer calibration"
            description="Step through ratio-mode calibration here. Leave the numeric fields blank if you want to clear saved calibration values."
            className="mt-3"
          >
            <DraginoDendroCalibrationSection
              device={device}
              dendroNeedsCalibration={dendroNeedsCalibration}
              onUpdate={onUpdate}
            />
          </SettingsSection>

          {error && <p className="mt-3 px-1 text-xs text-[var(--error-text)]">{error}</p>}
        </div>
      </div>
    </div>
  );
};
