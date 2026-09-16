import React, { useRef, useState, useEffect } from 'react';
import type { DeviceRemoveContext } from './useDeviceRemoval';
import type { Device, StregaModel, ValveSummary } from '../../types/farming';
import { devicesAPI, stregaAPI, valveAPI, type IrrigationActuation } from '../../services/api';
import { useDismissOnPointerDown } from '../../hooks/useDismissOnPointerDown';
import { useTranslation } from 'react-i18next';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import ValveCancelButton from './ValveCancelButton';

interface StregaValveCardProps {
  device: Device;
  onUpdate: () => void;
  onRemove?: () => void;
  todayLiters?: { value: number; source: 'measured_flow_meter' | 'estimated_duration_flow_rate' | 'unknown' };
  irrigationActuations?: IrrigationActuation[];
  timeZone?: string | null;
  // Per-placement remove copy (EDGE-2 operator ruling): the zone-card slot's ✕ only
  // detaches the valve from this zone (the caller's onRemove does the actual
  // irrigationZonesAPI.removeDevice call) while the device stays registered on the
  // farm; the unassigned-grid slot's ✕ fully removes the device (this card's own
  // devicesAPI.remove call below, unconditionally). Both share the same confirm title
  // and buttons -- only the explanatory subtitle differs. Required with no default:
  // typecheck then refuses a call site that does not state which one it means.
  /** Required: 'zone' detaches from the zone only, 'farm' unlinks from the account. */
  removeContext: DeviceRemoveContext;
  // The valve-list row for this device (from GET /api/valves) — the single source of
  // truth for STREGA generation and the enclosure temperature/humidity reading. `device`
  // (from GET /api/devices) carries neither reliably: it has no strega_generation field
  // at all, and its latest_data.ambient_temperature/relative_humidity come from the
  // newest row overall rather than the newest row that actually carried a reading, which
  // disagreed with the valve tile the moment a state-only uplink landed. Absent (still
  // loading, or a valve missing from the list) means "we don't know" — render nothing.
  valve?: ValveSummary | null;
  readOnly?: boolean;
}

const MAX_STREGA_INTERVAL_MINUTES = 255;
const MAX_STREGA_TIMED_ACTION_AMOUNT = 255;

type RecognizedStregaModel = StregaModel | 'UNKNOWN';
type TimedActionUnit = 'seconds' | 'minutes' | 'hours';

function getApiMessage(error: any, fallback: string): string {
  return error?.response?.data?.message || error?.response?.data?.error || fallback;
}

export function normaliseStregaModel(value: unknown): StregaModel | null {
  const raw = String(value ?? '').trim().toUpperCase();
  return raw === 'STANDARD' || raw === 'MOTORIZED' ? raw : null;
}

export function getRecognizedStregaModel(device: Device): RecognizedStregaModel {
  const explicit = normaliseStregaModel(device.strega_model);
  if (explicit) return explicit;
  const name = String(device.name || '').toLowerCase();
  if (name.includes('motor')) return 'MOTORIZED';
  if (name.includes('solenoid') || name.includes('lite') || name.includes('standard')) return 'STANDARD';
  return 'UNKNOWN';
}

// Honesty fix (polish scan 2026-09-17, Cat 6 "valve state language"): `current_state` is set
// only from a decoded uplink -- a physical confirmation from the valve. `target_state` is set
// the instant a downlink command is queued -- a network write, not a report from the valve.
// This used to fall back to target_state when current_state was unset, so a valve that had
// only been *sent* an open command (and never actually reported it) rendered as a headline
// OPEN. A valve that has never reported must read as UNKNOWN, never as a guessed OPEN/CLOSED --
// see the same observed-vs-commanded model already used by ValveTile/deriveValveGlyphState.
export function getDisplayedStregaState(device: Device): 'OPEN' | 'CLOSED' | 'UNKNOWN' {
  if (device.current_state === 'OPEN' || device.current_state === 'CLOSED') {
    return device.current_state;
  }
  return 'UNKNOWN';
}

export function shouldShowStregaTargetState(device: Device): boolean {
  return Boolean(device.target_state && device.target_state !== device.current_state);
}

export type StregaTargetIntent = 'pending' | 'acknowledged' | 'failed' | 'expired';

// `target_state` is only ever reset by an explicit cancel (osi-valve-control/cancel.js) --
// a normal self-closing OPEN_FOR_DURATION never resets it, so a valve that opened and closed
// on schedule keeps target_state=OPEN forever with current_state=CLOSED. Once that happens the
// latest actuation row for the device is COMPLETED (or CANCELLED), and neither of those has
// any live intent left to report -- the same rule valveState.ts/ValveTile follow (an inactive
// actuation renders no residual state).
const RESOLVED_ACTUATION_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

// Mirrors the two backend sites that decide when a row becomes a timeout in the first place --
// conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json's "STREGA Reconciliation
// Monitor" (RECONCILIATION_GRACE_SEC) and its "Compute derived per-row status" node (GRACE_MS),
// both 1800s (one Class-A uplink cycle each leg). An OPEN_TIMEOUT/CLOSE_TIMEOUT row cannot even
// exist before that grace has elapsed since expectedCloseAt, so a device reporting on any
// normal cadence already has last_seen past a *bare* expectedCloseAt the moment the row first
// appears -- comparing without the same grace made 'expired' disappear instantly, hiding the
// one case that matters most: an otherwise-alive valve that silently missed a command.
const RECONCILIATION_GRACE_MS = 1800 * 1000;

/**
 * True once the device has reported again (any uplink, tracked via `last_seen`) at least
 * `graceMs` after the moment a failed/timed-out actuation gave up on hearing from it. A
 * fresher report means we now know more about the valve than we did at that moment, so the
 * old failure/timeout no longer describes the present -- it must not stick around forever.
 */
function hasNewerDeviceObservationThan(device: Device, terminalAtIso: string | null | undefined, graceMs = 0): boolean {
  const terminalAt = toEpochMs(terminalAtIso);
  const lastSeen = toEpochMs(device.last_seen);
  return terminalAt !== null && lastSeen !== null && lastSeen > terminalAt + graceMs;
}

/**
 * Classifies an unconfirmed command target using the same reconciliation signals
 * `hasActiveValveActuation`/`getStregaActuationFeedback` already read (the actuation
 * expectation's reconciliation state, then the latest command-ACK-path status for this
 * device), so the intent word shown next to "Target: …" always agrees with the actuation
 * badge rendered just below it. Returns null -- render no intent line at all -- whenever the
 * commanded target is not actually backed by a live, unresolved actuation: never guesses
 * 'pending' just because nothing else matched.
 */
export function getStregaTargetIntent(device: Device, rows: IrrigationActuation[] = []): StregaTargetIntent | null {
  const active = device.activeValveActuation ?? device.active_valve_actuation ?? null;
  const activeState = String(active?.reconciliationState ?? active?.reconciliation_state ?? '').trim().toUpperCase();
  if (activeState === 'OBSERVED_RUNNING') return 'acknowledged';
  if (activeState === 'PENDING_OBSERVATION') return 'pending';

  const row = latestActuationForDevice(device.deveui, rows);
  if (!row) return null;
  if (RESOLVED_ACTUATION_STATUSES.has(row.status)) return null;
  if (row.status === 'RUNNING') return 'acknowledged';
  if (row.status === 'PENDING_OPEN') return 'pending';

  if (row.status === 'COMMAND_FAILED') {
    // A command failure is an immediate ACK-path rejection, not a wait-and-see timeout -- no
    // grace component here, unlike the branch below.
    return hasNewerDeviceObservationThan(device, row.commandAppliedAt ?? row.commandedAt) ? null : 'failed';
  }
  if (row.status === 'OPEN_TIMEOUT' || row.status === 'CLOSE_TIMEOUT') {
    return hasNewerDeviceObservationThan(device, row.expectedCloseAt ?? row.commandedAt, RECONCILIATION_GRACE_MS)
      ? null
      : 'expired';
  }

  // UNKNOWN, or any future status this function does not yet recognise -- silence, not a guess.
  return null;
}

type ValveFeedbackTone = 'queued' | 'running' | 'closed';

interface ValveActuationFeedback {
  tone: ValveFeedbackTone;
  label: string;
  detail: string | null;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const defaultTranslate: Translate = (_key, options) => {
  const fallback = typeof options?.defaultValue === 'string' ? options.defaultValue : '';
  return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name) => String(options?.[name] ?? ''));
};

function normalizeDeviceEui(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase();
}

function formatTimeOnly(iso: string | null | undefined, timeZone?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

function latestActuationForDevice(deviceEui: string, rows: IrrigationActuation[]): IrrigationActuation | null {
  const normalized = normalizeDeviceEui(deviceEui);
  if (!normalized) return null;
  return rows
    .filter((row) => normalizeDeviceEui(row.deviceEui) === normalized)
    .sort((a, b) => Date.parse(b.commandedAt) - Date.parse(a.commandedAt))[0] ?? null;
}

function approximateCommandWindowMinutes(row: IrrigationActuation): number {
  if (Number.isFinite(row.commandedDurationSeconds) && row.commandedDurationSeconds > 0) {
    return Math.max(1, Math.round(row.commandedDurationSeconds / 60));
  }
  const commanded = Date.parse(row.commandedAt);
  const expectedClose = Date.parse(row.expectedCloseAt);
  if (Number.isFinite(commanded) && Number.isFinite(expectedClose) && expectedClose > commanded) {
    return Math.max(1, Math.round((expectedClose - commanded) / 60_000));
  }
  return 1;
}

export function getStregaActuationFeedback(
  deviceEui: string,
  rows: IrrigationActuation[] = [],
  timeZone?: string | null,
  t: Translate = defaultTranslate,
): ValveActuationFeedback | null {
  const row = latestActuationForDevice(deviceEui, rows);
  if (!row) return null;

  if (row.observedCloseAt || row.status === 'COMPLETED') {
    const closedAt = formatTimeOnly(row.observedCloseAt, timeZone);
    return {
      tone: 'closed',
      label: t('stregaValve.actuationFeedback.closed', { defaultValue: 'Closed' }),
      detail: closedAt
        ? t('stregaValve.actuationFeedback.closedAt', { defaultValue: 'Closed at {{time}}', time: closedAt })
        : null,
    };
  }

  if (row.observedOpenAt || row.status === 'RUNNING') {
    const closeAt = formatTimeOnly(row.expectedCloseAt, timeZone);
    return {
      tone: 'running',
      label: closeAt
        ? t('stregaValve.actuationFeedback.openClosesAt', { defaultValue: 'OPEN — closes at {{time}}', time: closeAt })
        : t('stregaValve.actuationFeedback.open', { defaultValue: 'OPEN' }),
      detail: null,
    };
  }

  if (row.status === 'PENDING_OPEN' || row.reconciliationState === 'PENDING_OBSERVATION') {
    return {
      tone: 'queued',
      label: t('stregaValve.actuationFeedback.openQueued', { defaultValue: 'Open queued' }),
      detail: t('stregaValve.actuationFeedback.waitingForUplink', {
        defaultValue: 'waiting for valve uplink (≈ {{minutes}} min)',
        minutes: approximateCommandWindowMinutes(row),
      }),
    };
  }

  return null;
}

const FEEDBACK_STYLES: Record<ValveFeedbackTone, string> = {
  queued: 'border-amber-300 bg-amber-50 text-amber-900',
  running: 'border-blue-300 bg-blue-50 text-blue-900',
  closed: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};

const ValveActuationBadge: React.FC<{ feedback: ValveActuationFeedback }> = ({ feedback }) => (
  <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${FEEDBACK_STYLES[feedback.tone]}`}>
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-semibold">{feedback.label}</span>
      {feedback.detail && <span className="text-current opacity-85">{feedback.detail}</span>}
    </div>
  </div>
);

const ACTIVE_VALVE_ACTUATION_STATES = new Set(['PENDING_OBSERVATION', 'OBSERVED_RUNNING']);

export function hasActiveValveActuation(device: Device): boolean {
  const active = device.activeValveActuation ?? device.active_valve_actuation ?? null;
  const state = String(active?.reconciliationState ?? active?.reconciliation_state ?? '').trim().toUpperCase();
  return ACTIVE_VALVE_ACTUATION_STATES.has(state);
}

const ConfigPanel: React.FC<{
  device: Device;
  onUpdate: () => void;
  onClose: () => void;
}> = ({ device, onUpdate, onClose }) => {
  const { t } = useTranslation('devices');
  const ref = useRef<HTMLDivElement>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [closedIntervalInput, setClosedIntervalInput] = useState('');
  const [openedIntervalInput, setOpenedIntervalInput] = useState('2');
  const [tamperDisabled, setTamperDisabled] = useState(false);
  const [modelInput, setModelInput] = useState<StregaModel>(normaliseStregaModel(device.strega_model) ?? 'STANDARD');
  const [timedAction, setTimedAction] = useState<'OPEN' | 'CLOSE'>('OPEN');
  const [timedUnit, setTimedUnit] = useState<TimedActionUnit>('minutes');
  const [timedAmountInput, setTimedAmountInput] = useState('');
  const [magnetEnabled, setMagnetEnabled] = useState(false);
  const [partialAction, setPartialAction] = useState<'OPEN' | 'CLOSE'>('OPEN');
  const [partialPercentageInput, setPartialPercentageInput] = useState('');
  const [flushReturnPosition, setFlushReturnPosition] = useState<'OPEN' | 'CLOSE'>('OPEN');
  const [flushPercentageInput, setFlushPercentageInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const recognizedModel = getRecognizedStregaModel(device);
  const isMotorized = recognizedModel === 'MOTORIZED';
  // Translated (fresh review C2): these two option labels used to be raw English strings
  // in a module-scope constant, so fr/de-CH/etc. always showed "Standard / Solenoid" and
  // "Motorized valve" in the dropdown regardless of locale.
  const stregaModeOptions: Array<{ value: StregaModel; label: string }> = [
    { value: 'STANDARD', label: t('stregaValve.modelStandard', { defaultValue: 'Standard / Solenoid' }) },
    { value: 'MOTORIZED', label: t('stregaValve.modelMotorized', { defaultValue: 'Motorized valve' }) },
  ];

  useDismissOnPointerDown(ref, onClose);

  const applyInterval = async () => {
    const closedMinutes = Number(closedIntervalInput);
    const openedMinutes = Number(openedIntervalInput);
    if (!Number.isInteger(closedMinutes) || closedMinutes < 1 || closedMinutes > MAX_STREGA_INTERVAL_MINUTES) {
      setError(t('stregaValve.invalidInterval'));
      setInfo(null);
      return;
    }
    if (!Number.isInteger(openedMinutes) || openedMinutes < 1 || openedMinutes > MAX_STREGA_INTERVAL_MINUTES) {
      setError(t('stregaValve.invalidOpenInterval'));
      setInfo(null);
      return;
    }

    setBusyAction('interval');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setUplinkInterval(device.deveui, {
        closedMinutes,
        openedMinutes,
        tamperDisabled,
      });
      setInfo(t('stregaValve.intervalPending', {
        closed: closedMinutes,
        opened: openedMinutes,
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedToSetInterval')));
    } finally {
      setBusyAction(null);
    }
  };

  const applyModel = async () => {
    setBusyAction('model');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setModel(device.deveui, modelInput);
      setInfo(t('stregaValve.modelPending', {
        model: modelInput === 'MOTORIZED' ? 'motorized' : 'standard',
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedToSetModel')));
    } finally {
      setBusyAction(null);
    }
  };

  const applyTimedAction = async () => {
    const amount = Number(timedAmountInput);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_STREGA_TIMED_ACTION_AMOUNT) {
      setError(t('stregaValve.invalidTimedAction'));
      setInfo(null);
      return;
    }

    setBusyAction('timed');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setTimedAction(device.deveui, {
        action: timedAction,
        unit: timedUnit,
        amount,
      });
      setInfo(t('stregaValve.timedActionPending', {
        action: timedAction === 'OPEN' ? 'Open' : 'Close',
        amount,
        unit: timedUnit,
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedTimedAction')));
    } finally {
      setBusyAction(null);
    }
  };

  const applyMagnetMode = async () => {
    setBusyAction('magnet');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setMagnetEnabled(device.deveui, magnetEnabled);
      setInfo(t('stregaValve.magnetPending', {
        state: magnetEnabled ? 'enabled' : 'disabled',
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedMagnet')));
    } finally {
      setBusyAction(null);
    }
  };

  const applyPartialOpening = async () => {
    const percentage = Number(partialPercentageInput);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
      setError(t('stregaValve.invalidPercentage'));
      setInfo(null);
      return;
    }

    setBusyAction('partial');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setPartialOpening(device.deveui, {
        action: partialAction,
        percentage,
      });
      setInfo(t('stregaValve.partialPending', {
        action: partialAction === 'OPEN' ? 'open' : 'close',
        percentage,
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedPartial')));
    } finally {
      setBusyAction(null);
    }
  };

  const applyFlushing = async () => {
    const percentage = Number(flushPercentageInput);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
      setError(t('stregaValve.invalidPercentage'));
      setInfo(null);
      return;
    }

    setBusyAction('flush');
    setError(null);
    setInfo(null);
    try {
      await stregaAPI.setFlushing(device.deveui, {
        returnPosition: flushReturnPosition,
        percentage,
      });
      setInfo(t('stregaValve.flushPending', {
        percentage,
        state: flushReturnPosition === 'OPEN' ? 'open' : 'closed',
      }));
      onUpdate();
    } catch (err: any) {
      setError(getApiMessage(err, t('stregaValve.failedFlush')));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 w-[360px] max-w-[calc(100vw-2rem)]"
    >
      <p className="text-[var(--text-tertiary)] text-xs font-semibold mb-2 px-1">{t('stregaValve.settings', { defaultValue: 'STREGA SETTINGS' })}</p>

      <div className="px-1 space-y-4">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.quickAction', { defaultValue: 'Quick timed action' })}</p>
          <p className="text-[var(--text-tertiary)] text-xs mt-1">
            {t('stregaValve.quickActionNote')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
            <select
              value={timedAction}
              disabled={busyAction === 'timed'}
              onChange={(event) => setTimedAction(event.target.value as 'OPEN' | 'CLOSE')}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              {/* M-3: action verbs ("Open"/"Close" the valve now), not the status-word keys
                  (stregaValve.open/closed = "OUVERTE"/"FERMÉE" in fr) -- this dropdown picks
                  an action to queue, not a state to display. */}
              <option value="OPEN">{t('stregaValve.actionOpen')}</option>
              <option value="CLOSE">{t('stregaValve.actionClose')}</option>
            </select>
            <input
              type="number"
              min={1}
              max={MAX_STREGA_TIMED_ACTION_AMOUNT}
              step={1}
              inputMode="numeric"
              value={timedAmountInput}
              disabled={busyAction === 'timed'}
              onChange={(event) => setTimedAmountInput(event.target.value)}
              placeholder="10"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <select
              value={timedUnit}
              disabled={busyAction === 'timed'}
              onChange={(event) => setTimedUnit(event.target.value as TimedActionUnit)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              <option value="seconds">{t('stregaValve.seconds')}</option>
              <option value="minutes">{t('stregaValve.minutes')}</option>
              <option value="hours">{t('stregaValve.hours')}</option>
            </select>
          </div>
          <button
            type="button"
            onClick={applyTimedAction}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'timed'
              ? t('stregaValve.applyingTimedAction')
              : t('stregaValve.applyTimedAction')}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.intervalHeading', { defaultValue: 'Uplink intervals' })}</p>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <input
              id={`strega-closed-interval-${device.deveui}`}
              type="number"
              min={1}
              max={MAX_STREGA_INTERVAL_MINUTES}
              step={1}
              inputMode="numeric"
              value={closedIntervalInput}
              disabled={busyAction === 'interval'}
              onChange={(event) => setClosedIntervalInput(event.target.value)}
              placeholder={t('stregaValve.closedBoxInterval')}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <input
              type="number"
              min={1}
              max={MAX_STREGA_INTERVAL_MINUTES}
              step={1}
              inputMode="numeric"
              value={openedIntervalInput}
              disabled={busyAction === 'interval'}
              onChange={(event) => setOpenedIntervalInput(event.target.value)}
              placeholder={t('stregaValve.openedBoxInterval')}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            />
          </div>
          <label className="mt-3 flex items-center gap-3 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={tamperDisabled}
              disabled={busyAction === 'interval'}
              onChange={(event) => setTamperDisabled(event.target.checked)}
              className="w-4 h-4 accent-[var(--primary)]"
            />
            <span>{t('stregaValve.disableTamper')}</span>
          </label>
          <button
            type="button"
            onClick={applyInterval}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'interval'
              ? t('stregaValve.applyingInterval')
              : t('stregaValve.applyInterval')}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.modelHeading', { defaultValue: 'Model recognition' })}</p>
              <p className="text-[var(--text-tertiary)] text-xs mt-1">
                {t('stregaValve.modelDetected', {
                  model: recognizedModel === 'UNKNOWN' ? 'unknown' : recognizedModel.toLowerCase(),
                })}
              </p>
            </div>
            <select
              value={modelInput}
              disabled={busyAction === 'model'}
              onChange={(event) => setModelInput(event.target.value as StregaModel)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
            >
              {stregaModeOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={applyModel}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'model'
              ? t('stregaValve.applyingModel')
              : t('stregaValve.applyModel')}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.maintenance')}</p>
          <p className="text-[var(--text-tertiary)] text-xs mt-1">
            {t('stregaValve.magnetNote')}
          </p>
          <label className="mt-3 flex items-center gap-3 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={magnetEnabled}
              disabled={busyAction === 'magnet'}
              onChange={(event) => setMagnetEnabled(event.target.checked)}
              className="w-4 h-4 accent-[var(--primary)]"
            />
            <span>{t('stregaValve.enableMagnet', { defaultValue: 'Enable external magnet control' })}</span>
          </label>
          <button
            type="button"
            onClick={applyMagnetMode}
            disabled={busyAction !== null}
            className="mt-3 w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyAction === 'magnet'
              ? t('stregaValve.applyingMagnet')
              : t('stregaValve.applyMagnet')}
          </button>
        </section>

        {isMotorized ? (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 space-y-3">
            <div>
              <p className="text-[var(--text)] text-sm font-semibold">{t('stregaValve.motorizedHeading', { defaultValue: 'Motorized valve controls' })}</p>
              <p className="text-[var(--text-tertiary)] text-xs mt-1">
                {t('stregaValve.motorizedNote', { defaultValue: 'Partial opening and anti-sediment flushing are only supported for motorized valves.' })}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={partialAction}
                disabled={busyAction === 'partial'}
                onChange={(event) => setPartialAction(event.target.value as 'OPEN' | 'CLOSE')}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              >
                <option value="OPEN">{t('stregaValve.partialOpen')}</option>
                <option value="CLOSE">{t('stregaValve.partialClose')}</option>
              </select>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={partialPercentageInput}
                disabled={busyAction === 'partial'}
                onChange={(event) => setPartialPercentageInput(event.target.value)}
                placeholder="50"
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <button
              type="button"
              onClick={applyPartialOpening}
              disabled={busyAction !== null}
              className="w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyAction === 'partial'
                ? t('stregaValve.applyingPartial')
                : t('stregaValve.applyPartial')}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={flushReturnPosition}
                disabled={busyAction === 'flush'}
                onChange={(event) => setFlushReturnPosition(event.target.value as 'OPEN' | 'CLOSE')}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              >
                <option value="OPEN">{t('stregaValve.returnOpen')}</option>
                <option value="CLOSE">{t('stregaValve.returnClosed')}</option>
              </select>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={flushPercentageInput}
                disabled={busyAction === 'flush'}
                onChange={(event) => setFlushPercentageInput(event.target.value)}
                placeholder="30"
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <button
              type="button"
              onClick={applyFlushing}
              disabled={busyAction !== null}
              className="w-full rounded-lg bg-[var(--secondary-bg)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyAction === 'flush'
                ? t('stregaValve.applyingFlush')
                : t('stregaValve.applyFlush')}
            </button>
          </section>
        ) : (
          <p className="text-[var(--text-tertiary)] text-xs px-1">
            {t('stregaValve.motorizedLocked', { defaultValue: 'Set the valve model to motorized to unlock partial opening and flushing commands.' })}
          </p>
        )}
      </div>
      {info && <p className="text-[var(--text-tertiary)] text-xs mt-3 px-1">{info}</p>}
      {error && <p className="text-[var(--error-text)] text-xs mt-2 px-1">{error}</p>}
    </div>
  );
};

export const StregaValveCard: React.FC<StregaValveCardProps> = ({
  device,
  onUpdate,
  onRemove,
  todayLiters,
  irrigationActuations = [],
  timeZone,
  removeContext,
  valve,
  readOnly = false,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const { t: tv } = useTranslation('valves');
  const [loading, setLoading] = useState<'OPEN' | null>(null);
  // One tap must not move water. The Valve control panel already requires an explicit
  // confirm (ValveOpenDialog); this card went straight to controlValve, so the same valve
  // was laxer here than there. osi-os#171.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [openDurationMin, setOpenDurationMin] = useState('5');
  const [fetchedLiters, setFetchedLiters] = useState<{
    value: number;
    source: 'measured_flow_meter' | 'estimated_duration_flow_rate' | 'unknown';
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    valveAPI.getTodayLiters(device.deveui).then(({ liters, source }) => {
      if (!cancelled && liters !== null) {
        setFetchedLiters({
          value: liters,
          source: source as 'measured_flow_meter' | 'estimated_duration_flow_rate' | 'unknown',
        });
      }
    }).catch(() => { /* non-critical — display remains blank */ });
    return () => { cancelled = true; };
  }, [device.deveui, onUpdate]);
  const lastSeenStr = device.last_seen ?? null;
  const lastSeen = lastSeenStr ? new Date(lastSeenStr) : null;
  const minutesAgo = lastSeen
    ? Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60))
    : null;

  const displayedState = getDisplayedStregaState(device);
  const isOpen = displayedState === 'OPEN';
  const isUnknown = displayedState === 'UNKNOWN';
  const actuationFeedback = getStregaActuationFeedback(device.deveui, irrigationActuations, timeZone, t as Translate);
  const hasActiveActuation = hasActiveValveActuation(device);
  // The intent line only makes sense while there is a commanded target to explain; once it's
  // shown, classify it with the same ACK-path vocabulary as the actuation badge below it.
  const targetIntent = shouldShowStregaTargetState(device)
    ? getStregaTargetIntent(device, irrigationActuations)
    : null;

  // Sourced from the `valve` prop (GET /api/valves), not `device` — see the prop's
  // doc comment above for why. R1 review caught the card and the tile reading two
  // different row-selection strategies for the same columns and disagreeing on screen.
  const enclosureTemp = valve?.enclosureTemperatureC ?? null;
  const enclosureHumidity = valve?.enclosureHumidityPct ?? null;
  const enclosureIsGen2 = valve?.stregaGeneration === 'GEN2';
  const enclosurePair = [
    enclosureTemp != null ? tv('format.temperature', { value: enclosureTemp, defaultValue: '{{value}} °C' }) : null,
    enclosureHumidity != null ? tv('format.humidity', { value: enclosureHumidity, defaultValue: '{{value}} % RH' }) : null,
  ].filter(Boolean).join(' · ');

  const handleOpen = async () => {
    const durationMinutes = Number(openDurationMin);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 255) {
      setError(t('stregaValve.invalidOpenDuration'));
      return;
    }

    setLoading('OPEN');
    setError(null);
    try {
      await devicesAPI.controlValve(device.deveui, {
        action: 'OPEN_FOR_DURATION',
        duration_seconds: durationMinutes * 60,
      });
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || t('stregaValve.failedToOpen'));
    } finally {
      setLoading(null);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      // C-1 fix: the zone-card placement (removeContext="zone") must only detach the
      // valve from this zone -- that's the caller's onRemove (IrrigationZoneCard's
      // handleRemoveDevice -> irrigationZonesAPI.removeDevice). Calling devicesAPI.remove
      // unconditionally here unclaimed the device from the whole farm even from the zone
      // card, contradicting stregaValve.removeSubtitleZone's "it only leaves this zone".
      // Only the unassigned-grid placement (the default, 'farm') actually deletes the
      // device.
      if (removeContext === 'farm') {
        await devicesAPI.remove(device.deveui);
      }
      onRemove?.();
    } catch (err: any) {
      setError(err.response?.data?.message || t('stregaValve.failedToRemove'));
      setIsRemoving(false);
    }
  };

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--focus)] rounded-xl p-4 shadow-sm transition-colors">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">
          {device.name}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0 relative">
          <span className="bg-violet-100 text-violet-800 px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
            {t('stregaValve.badge')}
          </span>
          {!readOnly && <button
            onClick={() => setShowConfig(v => !v)}
            className={`p-1.5 rounded-md transition-colors ${
              showConfig
                ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--card)] hover:text-[var(--text)]'
            }`}
            title={t('stregaValve.settings')}
          >
            ⚙
          </button>}
          {!readOnly && showConfig && (
            <ConfigPanel
              device={device}
              onUpdate={onUpdate}
              onClose={() => setShowConfig(false)}
            />
          )}
          {!readOnly && <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving || loading !== null}
            className="p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('stregaValve.removeDeviceTitle')}
          >
            ✕
          </button>}
        </div>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] font-mono mb-3 truncate">{device.deveui}</p>

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {!readOnly && showConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">{t('stregaValve.removeConfirm')}</p>
          <p className="text-sm mb-3">
            {removeContext === 'zone' ? t('stregaValve.removeSubtitleZone') : t('stregaValve.removeSubtitle')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
            >
              {isRemoving ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  {t('stregaValve.removing')}
                </>
              ) : (
                t('stregaValve.yesRemove')
              )}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="bg-[var(--card)] rounded-lg p-3 mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-2">{t('stregaValve.status')}</p>
        <div className="flex items-center gap-2">
          <div
            className={`w-3 h-3 rounded-full shrink-0 ${
              isOpen ? 'bg-[var(--toggle-on)] animate-pulse' : 'bg-[var(--toggle-off)]'
            }`}
          />
          <p
            className={`text-2xl font-bold tabular-nums ${
              isOpen ? 'text-[var(--toggle-on)]' : isUnknown ? 'text-[var(--warn-text)]' : 'text-[var(--text-tertiary)]'
            }`}
          >
            {/* Honesty fix (polish scan Cat 6): a valve that has never reported its state
                reads as "Never seen", never as a guessed OPEN/CLOSED. */}
            {isOpen ? t('stregaValve.open') : isUnknown ? t('stregaValve.neverSeen') : t('stregaValve.closed')}
          </p>
        </div>
        {targetIntent && (
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {/* Copy repair (fresh review C2): interpolate the already-localized OPEN/CLOSED
                word, not the raw device.target_state enum -- fr previously rendered the
                English "Cible : OPEN" here regardless of locale. */}
            {t('stregaValve.target', { state: device.target_state === 'OPEN' ? t('stregaValve.open') : t('stregaValve.closed') })}
            {' · '}
            {/* Same ACK-path vocabulary as the actuation badge below: pending / acknowledged
                / failed / expired -- a commanded target is always shown as an intent, never
                as a fact the valve itself reported. */}
            {t(`stregaValve.targetIntent.${targetIntent}`)}
          </p>
        )}
        {actuationFeedback && <ValveActuationBadge feedback={actuationFeedback} />}
        {valve != null && (
          <dl className="mt-2 flex gap-2.5 text-[13px]">
            <dt className="min-w-[62px] text-[var(--text-tertiary)]">{tv('card.enclosureLabel', { defaultValue: 'Enclosure' })}</dt>
            <dd className="m-0 tabular-nums text-[var(--text)]">
              {enclosureIsGen2
                ? <span className="italic text-[var(--text-tertiary)]">{tv('card.enclosureNotMeasured', { defaultValue: 'not measured on Gen2' })}</span>
                : enclosureTemp == null && enclosureHumidity == null
                  ? <span className="italic text-[var(--text-tertiary)]">{tv('card.enclosureNoReading', { defaultValue: 'no reading yet' })}</span>
                  : enclosurePair}
            </dd>
          </dl>
        )}
      </div>

      {(fetchedLiters ?? todayLiters) && (
        <div className="text-sm text-[var(--text)] mb-3 px-1">
          {t('stregaValve.todayLiters', { liters: (fetchedLiters ?? todayLiters)!.value, defaultValue: 'Today: {{liters}} L' })}
          {(fetchedLiters ?? todayLiters)!.source === 'measured_flow_meter' && (
            <span className="ml-1 text-xs uppercase tracking-wide text-[var(--toggle-on)]">{t('stregaValve.measured', { defaultValue: 'Measured' })}</span>
          )}
          {(fetchedLiters ?? todayLiters)!.source === 'estimated_duration_flow_rate' && (
            <span className="ml-1 text-xs uppercase tracking-wide text-amber-700">{t('stregaValve.estimated', { defaultValue: 'Estimated' })}</span>
          )}
        </div>
      )}

      {!readOnly && <div className={`grid gap-3 ${hasActiveActuation ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div>
          <label htmlFor={`strega-duration-${device.deveui}`} className="text-xs text-[var(--text-secondary)]">
            {t('stregaValve.durationMin', { defaultValue: 'Duration (min)' })}
          </label>
          <input
            id={`strega-duration-${device.deveui}`}
            type="number"
            min={1}
            max={255}
            step={1}
            inputMode="numeric"
            value={openDurationMin}
            disabled={loading !== null}
            onChange={(event) => setOpenDurationMin(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          />
          <button
            onClick={() => { if (!confirmOpen) { setConfirmOpen(true); return; } setConfirmOpen(false); void handleOpen(); }}
            disabled={loading !== null}
            className={`mt-1 w-full ${confirmOpen ? 'bg-[var(--warn-border)]' : 'bg-[var(--primary)] hover:bg-[var(--primary-hover)]'} disabled:bg-[var(--border)] text-[var(--on-primary)] font-bold text-base py-3 touch-target rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] flex items-center justify-center gap-2`}
          >
            {loading === 'OPEN' ? (
              <>
                <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
                {t('stregaValve.opening')}
              </>
            ) : (
              confirmOpen
                ? t('stregaValve.confirmOpen', { minutes: openDurationMin, defaultValue: 'Confirm — open for {{minutes}} min' })
                // Copy repair (fresh review C2): a verb form, not the OPEN/OUVERTE status
                // word -- fr previously rendered "OUVERTE 5 min" (an adjective, not an
                // instruction to act).
                : t('stregaValve.openFor', { minutes: openDurationMin, defaultValue: 'Open {{minutes}} min' })
            )}
          </button>
        </div>
        {hasActiveActuation && (
          <div className="flex items-end">
            <ValveCancelButton
              device={device}
              onUpdate={onUpdate}
              onError={(message) => setError(message)}
            />
          </div>
        )}
      </div>}

      <DeviceCardFooter
        lastSeenLabel={minutesAgo !== null
          ? t('stregaValve.lastSeen', { minutes: minutesAgo })
          : t('stregaValve.neverSeen', { defaultValue: 'Never seen' })}
        batteryPercent={device.latest_data?.bat_pct}
      />
    </div>
  );
};
