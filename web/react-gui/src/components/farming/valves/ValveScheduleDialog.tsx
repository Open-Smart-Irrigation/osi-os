import React, { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import type { ValveSchedule, ValveScheduleInput, ValveSummary, ValveWeekdayPush, ValvePlanError } from '../../../types/farming';
import { valvesAPI, ValvePlanConflictError } from '../../../services/api';
import { assertScheduleStartNotHeld, isValveOpenHeldError, scheduleUpdateWhileHeld } from '../../../services/valveCommandHold';
import { formatDateTime as formatDateTimeIn, formatTime } from '../../../utils/datetime';
import { isConditionalSchedule } from '../../../utils/irrigationPolicy';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { estimateLiters, maskFromWeekdays, sortWeekdaysForDisplay, weekdaysFromMask, WEEKDAY_DISPLAY_ORDER, windowEnd } from './valveState';

export interface ValveScheduleDialogProps {
  valve: ValveSummary;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  onOpenPolicyEditor?: (schedule: ValveSchedule) => void;
}

interface DeleteSelection {
  valveEui: string;
  scheduleUuid: string;
  content: string;
}

function deletionContent(schedule: ValveSchedule): string {
  // Compare values, not object identity: an unchanged SWR refresh is still the same selection.
  return JSON.stringify([
    schedule.scheduleUuid, schedule.deviceEui, schedule.kind, schedule.label,
    schedule.weekdaysMask, schedule.startTime, schedule.fireAt, schedule.durationMinutes,
    schedule.timezone, schedule.enabled, schedule.onceState, schedule.dispatchState,
    schedule.dispatchCommandId, schedule.dispatchCreatedAt, schedule.dispatchAttemptedAt,
    schedule.syncVersion, schedule.conditionPolicyUuid, schedule.effectiveFrom, schedule.execution,
  ]);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

// Monday-first display order (Swiss convention). The STREGA mask/index encoding stays
// 0=Sunday-based everywhere else — this constant is for rendering weekday lists only.
const WEEKDAYS = WEEKDAY_DISPLAY_ORDER;
const WEEKLY_MAX_MINUTES = 1439;
const ONCE_MAX_MINUTES = 255;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// Both used to call `new Intl.DateTimeFormat(undefined, …)`, which formats
// against the operating system's locale and ignored the app language
// entirely. `utils/datetime` takes the language explicitly.
function formatClock(iso: string, timeZone: string, language: string | undefined): string {
  return formatTime(iso, language, { timeZone }) ?? '—';
}

function formatDateTime(iso: string, timeZone: string, language: string | undefined): string {
  return formatDateTimeIn(iso, language, { timeZone }) ?? '—';
}

function dispatchStateLabel(state: NonNullable<ValveSchedule['dispatchState']>, translate: Translate): string {
  return translate(`scheduleDialog.dispatchStates.${state}`, { defaultValue: state });
}

/** Offset (in minutes) of `timeZone` from UTC at the given instant: local = UTC + offset. */
function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - at.getTime()) / 60_000;
}

/**
 * Converts a local wall-clock date + time in `timeZone` to the UTC ISO instant.
 *
 * Two-pass: the offset guessed from the naive "as if UTC" instant can be wrong on a DST
 * transition day (the real instant lands on the other side of the transition than the
 * guess did). Recompute the offset at the first candidate and, if it differs, use that
 * second offset instead — the standard two-pass zoned-time conversion.
 */
function zonedTimeToUtcIso(dateStr: string, timeStr: string, timeZone: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dateMatch || !timeMatch) return null;
  const [, y, m, d] = dateMatch;
  const [, hh, mm] = timeMatch;
  const naiveUtc = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0);
  const offset1 = timeZoneOffsetMinutes(timeZone, new Date(naiveUtc));
  const candidate1 = naiveUtc - offset1 * 60_000;
  const offset2 = timeZoneOffsetMinutes(timeZone, new Date(candidate1));
  const finalOffset = offset2 !== offset1 ? offset2 : offset1;
  return new Date(naiveUtc - finalOffset * 60_000).toISOString();
}

// Inverse of zonedTimeToUtcIso: split a UTC instant into the date/time field values a user
// would see in the valve's timezone, so editing a ONCE schedule round-trips instead of
// re-interpreting a UTC wall clock as local time.
function utcIsoToZonedFields(iso: string, timeZone: string): { date: string; time: string } | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const shifted = new Date(at.getTime() + timeZoneOffsetMinutes(timeZone, at) * 60_000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

function describeConflict(details: ValvePlanError[], t: Translate): string {
  if (details.length === 0) return t('scheduleDialog.conflictGeneric');
  return details.map((detail) => {
    const day = detail.weekday;
    const weekday = typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6
      ? t(`weekdays.${day}`)
      : null;
    let message: string;
    if (detail.code === 'too_many_windows' && weekday) {
      message = t('scheduleDialog.conflictTooMany', { weekday });
    } else if (detail.code === 'overlap' && weekday) {
      message = t('scheduleDialog.conflictOverlap', { weekday });
    } else if (detail.code === 'invalid_start_time') {
      message = t('scheduleDialog.conflictInvalidStart');
    } else {
      message = t('scheduleDialog.conflictGeneric');
    }
    const labels = detail.labels.filter((label): label is string => typeof label === 'string' && label.trim().length > 0);
    return labels.length > 0 ? message + ' (' + labels.join(', ') + ')' : message;
  }).join('\n');
}

// The gateway returns push rows newest first in ledger insertion order (store.weekdayPushStates,
// ORDER BY rowid DESC). queuedAt is the gateway's wall clock and can step backwards, so it must
// not be used to re-sort: the first row is the newest.
function latestPush(rows: ValveWeekdayPush[]): ValveWeekdayPush | null {
  return rows[0] ?? null;
}

function pushBadgeLabel(row: ValveWeekdayPush | null, timeZone: string, t: Translate, language: string | undefined): string | null {
  if (!row) return null;
  if (row.state === 'ACKED') return t('scheduleDialog.push.ACKED', { when: row.ackedAt ? formatClock(row.ackedAt, timeZone, language) : '' });
  if (row.state === 'FAILED') return t('scheduleDialog.push.FAILED');
  if (row.state === 'LOST') return t('scheduleDialog.push.LOST');
  return t('scheduleDialog.push.QUEUED');
}

// One-line readable identity of a saved row, shown under the row label and reused verbatim
// by the delete confirmation so both surfaces can never drift apart.
function scheduleSummary(schedule: ValveSchedule, timeZone: string, t: Translate, language: string | undefined): string {
  return schedule.kind === 'WEEKLY'
    ? `${sortWeekdaysForDisplay(weekdaysFromMask(schedule.weekdaysMask ?? 0)).map((d) => t(`weekdays.${d}`)).join(', ')} · ${schedule.startTime ? `${schedule.startTime}–${windowEnd(schedule.startTime, schedule.durationMinutes)}` : '—'} · ${schedule.durationMinutes} min`
    : `${schedule.fireAt ? formatDateTime(schedule.fireAt, timeZone, language) : '—'} · ${schedule.durationMinutes} min`;
}

interface WeeklyFormState {
  days: number[];
  startTime: string;
  duration: string;
  label: string;
}

interface OnceFormState {
  date: string;
  time: string;
  duration: string;
  label: string;
}

const EMPTY_WEEKLY: WeeklyFormState = { days: [], startTime: '06:00', duration: '30', label: '' };
const EMPTY_ONCE: OnceFormState = { date: '', time: '06:00', duration: '15', label: '' };

export const ValveScheduleDialog: React.FC<ValveScheduleDialogProps> = ({ valve, open, onClose, onChanged, onOpenPolicyEditor }) => {
  const { t, i18n } = useTranslation('valves');
  const { t: tc } = useTranslation('common');
  // i18next's typed `t` only accepts the literal key union derived from valves.json, so any
  // dynamically-built key (weekday index, push-badge lookups) goes through this permissive alias.
  const td = t as Translate;
  const key = open ? `/api/valves/${valve.deviceEui}/schedules` : null;
  const { data, error, mutate } = useSWR(key, () => valvesAPI.schedules(valve.deviceEui));

  const [weekly, setWeekly] = useState<WeeklyFormState>(EMPTY_WEEKLY);
  const [once, setOnce] = useState<OnceFormState>(EMPTY_ONCE);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);
  const [onceError, setOnceError] = useState<string | null>(null);
  const [saveSucceeded, setSaveSucceeded] = useState(false);
  const [savingWeekly, setSavingWeekly] = useState(false);
  const [savingOnce, setSavingOnce] = useState(false);
  const [rowBusyUuid, setRowBusyUuid] = useState<string | null>(null);
  const [editingWeeklyUuid, setEditingWeeklyUuid] = useState<string | null>(null);
  const [editingOnceUuid, setEditingOnceUuid] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  // A delete is never sent on the row's first tap: the row opens a confirmation bound to
  // the displayed valve EUI + schedule UUID, and only an explicit confirmation dispatches.
  const [deleteSelection, setDeleteSelection] = useState<DeleteSelection | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Synchronous re-entry guard: a second activation of the confirm control must be
  // ignored even before React rerenders with the disabled button.
  const deleteInFlight = useRef(false);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
  const scheduleCloseRef = useRef<HTMLButtonElement | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const scheduleDialogRef = useRef<HTMLDivElement | null>(null);
  const selectedRow = open && deleteSelection?.valveEui === valve.deviceEui
    ? data?.schedules.find((schedule) => schedule.scheduleUuid === deleteSelection.scheduleUuid)
    : undefined;
  const pendingDelete = selectedRow && !isConditionalSchedule(selectedRow)
    && deletionContent(selectedRow) === deleteSelection?.content ? selectedRow : null;
  const confirmationOpen = pendingDelete !== null;

  // The delete confirmation is a separate nested surface with its own focus owner.
  // Pause the outer trap while it is open so its focusin guard cannot steal focus.
  useModalFocus(scheduleDialogRef, open, onClose, 'self', confirmationOpen);

  useEffect(() => {
    if (deleteSelection && !confirmationOpen) setDeleteSelection(null);
  }, [deleteSelection, confirmationOpen]);

  useEffect(() => {
    if (open) {
      setWeekly(EMPTY_WEEKLY);
      setOnce(EMPTY_ONCE);
      setWeeklyError(null);
      setOnceError(null);
      setSaveSucceeded(false);
      setRowError(null);
      setEditingWeeklyUuid(null);
      setEditingOnceUuid(null);
      setDeleteSelection(null);
      deleteButtonRefs.current.clear();
    }
  }, [open, valve.deviceEui]);

  // Keep keyboard navigation within the two confirmation actions. Remove the trap before
  // returning focus, and only restore a trigger that still belongs to the mounted list.
  useEffect(() => {
    if (!confirmationOpen || !deleteSelection) return;
    const dialog = confirmDialogRef.current;
    if (!dialog) return;
    const trigger = deleteButtonRefs.current.get(deleteSelection.scheduleUuid);
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) confirmCancelRef.current?.focus();
    };
    const loopFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const actions = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (!actions.length) return;
      event.preventDefault();
      const current = actions.indexOf(document.activeElement as HTMLButtonElement);
      const next = current < 0 ? (event.shiftKey ? actions.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + actions.length) % actions.length;
      actions[next]?.focus();
    };
    document.addEventListener('focusin', keepFocusInside);
    document.addEventListener('keydown', loopFocus, true);
    confirmCancelRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      document.removeEventListener('keydown', loopFocus, true);
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
      else if (scheduleCloseRef.current?.isConnected) scheduleCloseRef.current.focus();
    };
  }, [confirmationOpen, deleteSelection]);

  const closeDeleteConfirm = () => setDeleteSelection(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape dismisses the innermost surface only: while a delete confirmation is
        // open it closes the confirmation, never the schedule dialog behind it.
        if (confirmationOpen) closeDeleteConfirm();
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, confirmationOpen]);

  if (!open) return null;

  const titleId = `valve-schedule-title-${valve.deviceEui}`;
  const deleteConfirmTitleId = `valve-schedule-delete-title-${valve.deviceEui}`;
  const deleteConfirmBodyId = `valve-schedule-delete-body-${valve.deviceEui}`;

  const afterMutation = async () => {
    await mutate();
    onChanged();
  };
  const focusSavedSchedule = (scheduleUuid: string) => {
    window.requestAnimationFrame(() => document.getElementById(`valve-schedule-row-${scheduleUuid}`)?.focus());
  };

  const toggleWeekday = (day: number) => {
    setWeekly((prev) => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter((d) => d !== day) : [...prev.days, day].sort(),
    }));
  };

  const weeklyDurationNum = Number(weekly.duration);
  const isWeeklyValid =
    weekly.days.length > 0
    && /^\d{2}:\d{2}$/.test(weekly.startTime)
    && Number.isInteger(weeklyDurationNum) && weeklyDurationNum >= 1 && weeklyDurationNum <= WEEKLY_MAX_MINUTES;

  const onceDurationNum = Number(once.duration);
  const isOnceValid =
    /^\d{4}-\d{2}-\d{2}$/.test(once.date)
    && /^\d{2}:\d{2}$/.test(once.time)
    && Number.isInteger(onceDurationNum) && onceDurationNum >= 1 && onceDurationNum <= ONCE_MAX_MINUTES;

  const saveWeekly = async () => {
    if (!isWeeklyValid || savingWeekly) return;
    setSavingWeekly(true);
    setWeeklyError(null);
    setSaveSucceeded(false);
    try {
      const weeklyFields = {
        label: weekly.label.trim() || null,
        weekdaysMask: maskFromWeekdays(weekly.days),
        startTime: weekly.startTime,
        durationMinutes: weeklyDurationNum,
      };
      if (editingWeeklyUuid) {
        // The server re-validates and re-runs the plan-conflict check against the OTHER
        // schedules with this row swapped in, so an edit that would collide is rejected the
        // same way a create would be — `enabled` is deliberately not sent, so the row keeps
        // whatever the enable toggle last set.
        await valvesAPI.updateSchedule(valve.deviceEui, editingWeeklyUuid, weeklyFields);
        const savedUuid = editingWeeklyUuid;
        setWeekly(EMPTY_WEEKLY);
        setEditingWeeklyUuid(null);
        await afterMutation();
        setSaveSucceeded(true);
        focusSavedSchedule(savedUuid);
      } else {
        const created = await valvesAPI.createSchedule(valve.deviceEui, { kind: 'WEEKLY', ...weeklyFields, enabled: true });
        setWeekly(EMPTY_WEEKLY);
        await afterMutation();
        setSaveSucceeded(true);
        focusSavedSchedule(created.schedule.scheduleUuid);
      }
    } catch (err) {
      setWeeklyError(err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : t('scheduleDialog.saveFailed'));
    } finally {
      setSavingWeekly(false);
    }
  };

  const saveOnce = async () => {
    // A row change and its list refresh settle first, so the form does not edit from a stale row.
    if (!isOnceValid || savingOnce || rowBusyUuid !== null) return;
    const fireAt = zonedTimeToUtcIso(once.date, once.time, valve.timezone);
    if (!fireAt) return;
    setSavingOnce(true);
    setOnceError(null);
    setSaveSucceeded(false);
    try {
      const onceFields: Pick<ValveScheduleInput, 'label' | 'fireAt' | 'durationMinutes' | 'enabled'> = {
        label: once.label.trim() || null,
        fireAt,
        durationMinutes: onceDurationNum,
      };
      const current = editingOnceUuid ? data?.schedules.find((schedule) => schedule.scheduleUuid === editingOnceUuid) : undefined;
      // A one-time irrigation that would start while an earlier open of this valve has no
      // answer yet is a second open by another route: refused here and in the API layer.
      // While the hold lasts, an edit sends both `enabled` and `fireAt` and the body alone
      // decides (services/valveCommandHold.ts scheduleUpdateWhileHeld); the API applies the
      // same rule again. Outside a hold the edit stays a partial update.
      if (editingOnceUuid) {
        const body = scheduleUpdateWhileHeld(valve.deviceEui, onceFields, current);
        if (current) await valvesAPI.updateSchedule(valve.deviceEui, editingOnceUuid, body, current);
        else await valvesAPI.updateSchedule(valve.deviceEui, editingOnceUuid, body);
        const savedUuid = editingOnceUuid;
        setOnce(EMPTY_ONCE);
        setEditingOnceUuid(null);
        await afterMutation();
        setSaveSucceeded(true);
        focusSavedSchedule(savedUuid);
      } else {
        assertScheduleStartNotHeld(valve.deviceEui, { kind: 'ONCE', fireAt, enabled: true });
        const created = await valvesAPI.createSchedule(valve.deviceEui, { kind: 'ONCE', ...onceFields, enabled: true });
        setOnce(EMPTY_ONCE);
        await afterMutation();
        setSaveSucceeded(true);
        focusSavedSchedule(created.schedule.scheduleUuid);
      }
    } catch (err) {
      setOnceError(isValveOpenHeldError(err)
        ? t('commandNoAnswer.open')
        : err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : t('scheduleDialog.saveFailed'));
    } finally {
      setSavingOnce(false);
    }
  };

  const startEdit = (schedule: ValveSchedule) => {
    setRowError(null);
    if (schedule.kind === 'WEEKLY') {
      setEditingOnceUuid(null);
      setOnce(EMPTY_ONCE);
      setWeeklyError(null);
      setEditingWeeklyUuid(schedule.scheduleUuid);
      setWeekly({
        days: weekdaysFromMask(schedule.weekdaysMask ?? 0),
        startTime: schedule.startTime ?? '06:00',
        duration: String(schedule.durationMinutes),
        label: schedule.label ?? '',
      });
      return;
    }
    setEditingWeeklyUuid(null);
    setWeekly(EMPTY_WEEKLY);
    setOnceError(null);
    setEditingOnceUuid(schedule.scheduleUuid);
    const fields = schedule.fireAt ? utcIsoToZonedFields(schedule.fireAt, valve.timezone) : null;
    setOnce({
      date: fields?.date ?? '',
      time: fields?.time ?? '06:00',
      duration: String(schedule.durationMinutes),
      label: schedule.label ?? '',
    });
  };

  const cancelWeeklyEdit = () => {
    setEditingWeeklyUuid(null);
    setWeekly(EMPTY_WEEKLY);
    setWeeklyError(null);
  };

  const cancelOnceEdit = () => {
    setEditingOnceUuid(null);
    setOnce(EMPTY_ONCE);
    setOnceError(null);
  };

  const toggleEnabled = async (schedule: ValveSchedule) => {
    // A form save and its refresh settle first (convenience; the body rule below is the safety).
    if (rowBusyUuid !== null || savingOnce || savingWeekly) return;
    setRowBusyUuid(schedule.scheduleUuid);
    setRowError(null);
    try {
      // While the hold lasts, a one-time toggle sends the start it knows with the new enabled
      // state, so the gateway ends with exactly what was checked: enabling a due start is
      // refused, disabling never is. Weekly toggles are exempt and stay partial.
      if (schedule.kind === 'ONCE') {
        const body = scheduleUpdateWhileHeld(valve.deviceEui, { enabled: !schedule.enabled }, schedule);
        await valvesAPI.updateSchedule(valve.deviceEui, schedule.scheduleUuid, body, schedule);
      } else {
        await valvesAPI.updateSchedule(valve.deviceEui, schedule.scheduleUuid, { enabled: !schedule.enabled });
      }
      await afterMutation();
    } catch (err) {
      setRowError(isValveOpenHeldError(err)
        ? t('commandNoAnswer.open')
        : err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : t('scheduleDialog.updateFailed'));
    } finally {
      setRowBusyUuid(null);
    }
  };

  const deleteRow = async (schedule: ValveSchedule) => {
    setRowBusyUuid(schedule.scheduleUuid);
    setRowError(null);
    try {
      await valvesAPI.deleteSchedule(valve.deviceEui, schedule.scheduleUuid);
      // Otherwise the form stays bound to a schedule_uuid the server has soft-deleted, and
      // saving would 404 against a row the list no longer shows.
      if (editingWeeklyUuid === schedule.scheduleUuid) cancelWeeklyEdit();
      if (editingOnceUuid === schedule.scheduleUuid) cancelOnceEdit();
      await afterMutation();
    } catch (err) {
      setRowError(err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : t('scheduleDialog.deleteFailed'));
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
      setRowBusyUuid(null);
    }
  };

  const confirmDelete = () => {
    if (deleteInFlight.current) return;
    const schedule = pendingDelete;
    if (!schedule) {
      closeDeleteConfirm();
      return;
    }
    deleteInFlight.current = true;
    setDeleting(true);
    closeDeleteConfirm();
    void deleteRow(schedule);
  };

  const weeklyLiters = isWeeklyValid ? estimateLiters(valve.flowRateLpm, weeklyDurationNum) : null;
  const weeklyPreview = isWeeklyValid
    ? t('scheduleDialog.preview', {
        days: sortWeekdaysForDisplay(weekly.days).map((d) => td(`weekdays.${d}`)).join(', '),
        start: weekly.startTime,
        end: windowEnd(weekly.startTime, weeklyDurationNum),
        minutes: weeklyDurationNum,
      })
    : null;

  const onceLiters = isOnceValid ? estimateLiters(valve.flowRateLpm, onceDurationNum) : null;
  const oncePreview = isOnceValid
    ? t('scheduleDialog.preview', {
        days: once.date,
        start: once.time,
        end: windowEnd(once.time, onceDurationNum),
        minutes: onceDurationNum,
      })
    : null;

  const compiledWeekSection = data ? (
              <section>
                {data.schedules.length > 0 && <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('scheduleDialog.week')}</p>}
                <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-7">
                  {WEEKDAYS.map((d) => {
                    const windows = data.compiled.days[d] ?? [];
                    const badge = valve.stregaGeneration === 'GEN1'
                      ? pushBadgeLabel(latestPush(data.pushState.filter((p) => p.weekday === d)), valve.timezone, td, i18n?.language)
                      : null;
                    const dayLabel = td(`weekdays.${d}`);
                    return (
                      <div
                        key={d}
                        role="group"
                        aria-label={dayLabel}
                        className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] p-2"
                      >
                        <div className="flex min-w-0 items-baseline gap-2 sm:block sm:gap-0">
                          <p className="max-w-[40%] shrink-0 truncate text-xs font-semibold text-[var(--text-tertiary)] sm:max-w-none sm:shrink">{dayLabel}</p>
                          {windows.length === 0 ? (
                            <p className="min-w-0 truncate text-xs text-[var(--text-tertiary)] sm:mt-1">{t('scheduleDialog.noWindows')}</p>
                          ) : (
                            <ul className="min-w-0 flex-1 space-y-0.5 sm:mt-1 sm:flex-none">
                              {windows.map((w) => (
                                <li
                                  key={w.scheduleUuid}
                                  className="truncate whitespace-nowrap text-xs leading-tight text-[var(--text)]"
                                  title={`${pad(w.onH)}:${pad(w.onM)}–${pad(w.offH)}:${pad(w.offM)}`}
                                >
                                  {pad(w.onH)}:{pad(w.onM)}–{pad(w.offH)}:{pad(w.offM)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-[var(--text-tertiary)]">{t('scheduleDialog.windows', { count: windows.length })}</p>
                        {badge && <p className="mt-1 truncate text-xs text-[var(--text-tertiary)]">{badge}</p>}
                      </div>
                    );
                  })}
                </div>
                {valve.stregaGeneration === 'GEN2' && (() => {
                  const overall = pushBadgeLabel(latestPush(data.pushState), valve.timezone, td, i18n?.language);
                  return overall ? <p className="mt-2 text-xs text-[var(--text-tertiary)]">{overall}</p> : null;
                })()}
              </section>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={scheduleDialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">{t('scheduleDialog.title', { name: valve.name })}</h2>
          <button
            type="button"
            ref={scheduleCloseRef}
            onClick={onClose}
            aria-label={tc('close')}
            className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--secondary-bg)] hover:text-[var(--text)]"
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {!data && !error && (
            <p className="text-sm text-[var(--text-tertiary)]">{tc('loading')}</p>
          )}

          {error && (
            <div className="flex items-center gap-3 text-sm text-[var(--warn-text)]">
              <span>{t('scheduleDialog.loadFailed')}</span>
              <button
                type="button"
                onClick={() => mutate()}
                className="flex min-h-[44px] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] sm:min-h-0"
              >
                {tc('retry')}
              </button>
            </div>
          )}

          {data && (
            <>
              {data.schedules.length > 0 && compiledWeekSection}

              <p className="mt-3 text-xs text-[var(--text-tertiary)]">{t('bluetoothNote')}</p>

              <section className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('scheduleDialog.list')}</p>
                {saveSucceeded && <p role="status" aria-live="polite" className="mt-2 rounded-md border border-[var(--success-border)] bg-[var(--success-bg)] px-3 py-2 text-sm text-[var(--success-text)]">{t('scheduleDialog.saveSucceeded')}</p>}
                {rowError && <p className="mt-1 whitespace-pre-line text-xs text-[var(--warn-text)]">{rowError}</p>}
                {data.schedules.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--text-tertiary)]">{t('noSchedule')}</p>
                ) : (
                  <ul aria-live="polite" className="mt-2 flex flex-col gap-1.5">
                    {data.schedules.map((schedule) => (
                      <li id={`valve-schedule-row-${schedule.scheduleUuid}`} key={schedule.scheduleUuid} tabIndex={-1} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--text)]">
                            {schedule.label ?? (schedule.kind === 'WEEKLY' ? t('scheduleDialog.addWeekly') : t('scheduleDialog.addOnce'))}
                          </p>
                          <p className="truncate text-xs text-[var(--text-tertiary)]">
                            {scheduleSummary(schedule, valve.timezone, td, i18n?.language)}
                          </p>
                          {schedule.kind === 'ONCE' && schedule.dispatchState && (
                            <p className={`truncate text-xs ${schedule.dispatchState === 'UNKNOWN' ? 'font-semibold text-[var(--warn-text)]' : 'text-[var(--text-tertiary)]'}`}>
                              {td('scheduleDialog.dispatchStatus', { state: dispatchStateLabel(schedule.dispatchState, td), defaultValue: 'Dispatch: {{state}}' })}
                              {schedule.dispatchAttemptedAt ? ` · ${formatDateTime(schedule.dispatchAttemptedAt, valve.timezone, i18n?.language)}` : ''}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {isConditionalSchedule(schedule) ? (
                            <button
                              type="button"
                              onClick={() => onOpenPolicyEditor?.(schedule)}
                              disabled={!onOpenPolicyEditor}
                              className="flex min-h-[44px] items-center px-1.5 text-xs font-semibold text-[var(--primary)] underline disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:px-0"
                            >
                              {t('irrigationPolicy.openEditor', { defaultValue: 'Edit conditional policy' })}
                            </button>
                          ) : (
                            <>
                              <label className="flex min-h-[44px] items-center gap-1.5 px-1.5 text-xs text-[var(--text-secondary)] sm:min-h-0 sm:px-0">
                                <input
                                  type="checkbox"
                                  checked={schedule.enabled}
                                  disabled={rowBusyUuid === schedule.scheduleUuid || savingOnce || savingWeekly}
                                  onChange={() => void toggleEnabled(schedule)}
                                  className="h-4 w-4"
                                />
                                {t('scheduleDialog.enabled')}
                              </label>
                              <button
                                type="button"
                                onClick={() => startEdit(schedule)}
                                disabled={rowBusyUuid === schedule.scheduleUuid}
                                className="flex min-h-[44px] items-center px-1.5 text-xs font-semibold text-[var(--text-secondary)] underline transition-colors hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:px-0"
                              >
                                {t('scheduleDialog.edit')}
                              </button>
                              <button
                                type="button"
                                ref={(el) => {
                                  if (el) deleteButtonRefs.current.set(schedule.scheduleUuid, el);
                                  else deleteButtonRefs.current.delete(schedule.scheduleUuid);
                                }}
                                onClick={() => {
                                  if (deleteInFlight.current) return;
                                  setDeleteSelection({
                                    valveEui: valve.deviceEui,
                                    scheduleUuid: schedule.scheduleUuid,
                                    content: deletionContent(schedule),
                                  });
                                }}
                                disabled={deleting || rowBusyUuid === schedule.scheduleUuid}
                                className="flex min-h-[44px] items-center px-1.5 text-xs font-semibold text-[var(--warn-text)] underline disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:px-0"
                              >
                                {t('scheduleDialog.delete')}
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                  <p className="text-sm font-semibold text-[var(--text)]">
                    {editingWeeklyUuid ? t('scheduleDialog.editWeekly') : t('scheduleDialog.addWeekly')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {WEEKDAYS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleWeekday(d)}
                        className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors sm:min-h-0 sm:min-w-0 sm:px-2.5 ${
                          weekly.days.includes(d)
                            ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--on-primary)]'
                            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]'
                        }`}
                      >
                        {td(`weekdays.${d}`)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`weekly-start-${valve.deviceEui}`}>{t('scheduleDialog.startTime')}</label>
                      <input
                        id={`weekly-start-${valve.deviceEui}`}
                        type="time"
                        value={weekly.startTime}
                        onChange={(e) => setWeekly((prev) => ({ ...prev, startTime: e.target.value }))}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`weekly-duration-${valve.deviceEui}`}>{t('scheduleDialog.duration')}</label>
                      <input
                        id={`weekly-duration-${valve.deviceEui}`}
                        type="number"
                        min={1}
                        max={WEEKLY_MAX_MINUTES}
                        inputMode="numeric"
                        value={weekly.duration}
                        onChange={(e) => setWeekly((prev) => ({ ...prev, duration: e.target.value }))}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                      />
                    </div>
                  </div>
                  <div className="mt-2">
                    <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`weekly-label-${valve.deviceEui}`}>{t('scheduleDialog.label')}</label>
                    <input
                      id={`weekly-label-${valve.deviceEui}`}
                      type="text"
                      value={weekly.label}
                      onChange={(e) => setWeekly((prev) => ({ ...prev, label: e.target.value }))}
                      className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                    />
                  </div>
                  {weeklyPreview && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">
                      {weeklyPreview}{weeklyLiters !== null && ` · ${t('scheduleDialog.previewLiters', { liters: weeklyLiters })}`}
                    </p>
                  )}
                  {weeklyError && <p className="mt-2 whitespace-pre-line text-xs text-[var(--warn-text)]">{weeklyError}</p>}
                  <div className="mt-3 flex gap-2">
                    {editingWeeklyUuid && (
                      <button
                        type="button"
                        onClick={cancelWeeklyEdit}
                        disabled={savingWeekly}
                        className="min-h-[44px] shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t('scheduleDialog.discardEdit')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void saveWeekly()}
                      disabled={!isWeeklyValid || savingWeekly}
                      className="min-h-[44px] w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {savingWeekly
                        ? t('scheduleDialog.saving')
                        : editingWeeklyUuid ? t('scheduleDialog.update') : t('scheduleDialog.save')}
                    </button>
                  </div>
                </section>

                <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                  <p className="text-sm font-semibold text-[var(--text)]">
                    {editingOnceUuid ? t('scheduleDialog.editOnce') : t('scheduleDialog.addOnce')}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-date-${valve.deviceEui}`}>{t('scheduleDialog.date')}</label>
                      <input
                        id={`once-date-${valve.deviceEui}`}
                        type="date"
                        value={once.date}
                        onChange={(e) => setOnce((prev) => ({ ...prev, date: e.target.value }))}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-time-${valve.deviceEui}`}>{t('scheduleDialog.time')}</label>
                      <input
                        id={`once-time-${valve.deviceEui}`}
                        type="time"
                        value={once.time}
                        onChange={(e) => setOnce((prev) => ({ ...prev, time: e.target.value }))}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                      />
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-duration-${valve.deviceEui}`}>{t('scheduleDialog.duration')}</label>
                      <input
                        id={`once-duration-${valve.deviceEui}`}
                        type="number"
                        min={1}
                        max={ONCE_MAX_MINUTES}
                        inputMode="numeric"
                        value={once.duration}
                        onChange={(e) => setOnce((prev) => ({ ...prev, duration: e.target.value }))}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-label-${valve.deviceEui}`}>{t('scheduleDialog.label')}</label>
                      <input
                        id={`once-label-${valve.deviceEui}`}
                        type="text"
                        value={once.label}
                        onChange={(e) => setOnce((prev) => ({ ...prev, label: e.target.value }))}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] sm:min-h-0"
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-[var(--text-tertiary)]">{t('scheduleDialog.onceNote')}</p>
                  {oncePreview && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">
                      {oncePreview}{onceLiters !== null && ` · ${t('scheduleDialog.previewLiters', { liters: onceLiters })}`}
                    </p>
                  )}
                  {onceError && <p className="mt-2 whitespace-pre-line text-xs text-[var(--warn-text)]">{onceError}</p>}
                  <div className="mt-3 flex gap-2">
                    {editingOnceUuid && (
                      <button
                        type="button"
                        onClick={cancelOnceEdit}
                        disabled={savingOnce}
                        className="min-h-[44px] shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t('scheduleDialog.discardEdit')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void saveOnce()}
                      disabled={!isOnceValid || savingOnce || rowBusyUuid !== null}
                      className="min-h-[44px] w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {savingOnce
                        ? t('scheduleDialog.saving')
                        : editingOnceUuid ? t('scheduleDialog.update') : t('scheduleDialog.save')}
                    </button>
                  </div>
                </section>
              </div>
              {data.schedules.length === 0 && (
                <details className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('scheduleDialog.week')}</summary>
                  {compiledWeekSection}
                </details>
              )}
            </>
          )}
        </div>
      </div>

      {pendingDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={(event) => {
            // Dismissing the confirmation by its own backdrop must close only the
            // confirmation; the click never reaches the dialog backdrop underneath.
            event.stopPropagation();
            closeDeleteConfirm();
          }}
        >
          <div
            ref={confirmDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={deleteConfirmTitleId}
            aria-describedby={deleteConfirmBodyId}
            className="w-full max-w-md rounded-xl border border-[var(--warn-border)] bg-[var(--surface)] p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id={deleteConfirmTitleId} className="text-base font-semibold text-[var(--warn-text)]">
              {t('scheduleDialog.deleteConfirmTitle')}
            </h3>
            <p id={deleteConfirmBodyId} className="mt-1 text-sm text-[var(--text)]">
              {t('scheduleDialog.deleteConfirmBody', {
                schedule: pendingDelete.label ?? (pendingDelete.kind === 'WEEKLY' ? t('scheduleDialog.addWeekly') : t('scheduleDialog.addOnce')),
                valve: valve.name,
              })}
            </p>
            <p className="mt-1 break-words text-xs text-[var(--text-tertiary)]">
              {scheduleSummary(pendingDelete, valve.timezone, td, i18n?.language)}
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                ref={confirmCancelRef}
                type="button"
                onClick={closeDeleteConfirm}
                disabled={deleting}
                className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="min-h-[44px] rounded-lg bg-[var(--warn-border)] px-4 py-2 text-sm font-semibold text-[var(--on-warn)] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('scheduleDialog.deleteConfirmButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ValveScheduleDialog;
