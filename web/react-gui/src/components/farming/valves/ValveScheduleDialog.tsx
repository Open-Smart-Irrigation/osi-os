import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import type { ValveSchedule, ValveSummary, ValveWeekdayPush, ValvePlanError } from '../../../types/farming';
import { valvesAPI, ValvePlanConflictError } from '../../../services/api';
import { estimateLiters, maskFromWeekdays, weekdaysFromMask, windowEnd } from './valveState';

export interface ValveScheduleDialogProps {
  valve: ValveSummary;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKLY_MAX_MINUTES = 1439;
const ONCE_MAX_MINUTES = 255;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
}

function formatDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
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

/** Converts a local wall-clock date + time in `timeZone` to the UTC ISO instant. */
function zonedTimeToUtcIso(dateStr: string, timeStr: string, timeZone: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dateMatch || !timeMatch) return null;
  const [, y, m, d] = dateMatch;
  const [, hh, mm] = timeMatch;
  const naiveUtc = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0);
  const offset = timeZoneOffsetMinutes(timeZone, new Date(naiveUtc));
  return new Date(naiveUtc - offset * 60_000).toISOString();
}

function describeConflict(details: ValvePlanError[], t: Translate): string {
  const first = details[0];
  if (!first) return t('scheduleDialog.save');
  const weekdayLabel = first.weekday !== null ? t(`weekdays.${first.weekday}`) : '';
  if (first.code === 'too_many_windows') return t('scheduleDialog.conflictTooMany', { weekday: weekdayLabel });
  if (first.code === 'overlap') return t('scheduleDialog.conflictOverlap', { weekday: weekdayLabel });
  return 'That start time is not valid.';
}

function latestPush(rows: ValveWeekdayPush[]): ValveWeekdayPush | null {
  return rows.slice().sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt))[0] ?? null;
}

function pushBadgeLabel(row: ValveWeekdayPush | null, timeZone: string, t: Translate): string | null {
  if (!row) return null;
  if (row.state === 'ACKED') return t('scheduleDialog.push.ACKED', { when: row.ackedAt ? formatClock(row.ackedAt, timeZone) : '' });
  if (row.state === 'FAILED') return t('scheduleDialog.push.FAILED');
  return t('scheduleDialog.push.QUEUED');
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

export const ValveScheduleDialog: React.FC<ValveScheduleDialogProps> = ({ valve, open, onClose, onChanged }) => {
  const { t } = useTranslation('valves');
  // i18next's typed `t` only accepts the literal key union derived from valves.json, so any
  // dynamically-built key (weekday index, push-badge lookups) goes through this permissive alias.
  const td = t as Translate;
  const key = open ? `/api/valves/${valve.deviceEui}/schedules` : null;
  const { data, error, mutate } = useSWR(key, () => valvesAPI.schedules(valve.deviceEui));

  const [weekly, setWeekly] = useState<WeeklyFormState>(EMPTY_WEEKLY);
  const [once, setOnce] = useState<OnceFormState>(EMPTY_ONCE);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);
  const [onceError, setOnceError] = useState<string | null>(null);
  const [savingWeekly, setSavingWeekly] = useState(false);
  const [savingOnce, setSavingOnce] = useState(false);
  const [rowBusyUuid, setRowBusyUuid] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setWeekly(EMPTY_WEEKLY);
      setOnce(EMPTY_ONCE);
      setWeeklyError(null);
      setOnceError(null);
      setRowError(null);
    }
  }, [open, valve.deviceEui]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const titleId = `valve-schedule-title-${valve.deviceEui}`;

  const afterMutation = async () => {
    await mutate();
    onChanged();
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
    try {
      await valvesAPI.createSchedule(valve.deviceEui, {
        kind: 'WEEKLY',
        label: weekly.label.trim() || null,
        weekdaysMask: maskFromWeekdays(weekly.days),
        startTime: weekly.startTime,
        durationMinutes: weeklyDurationNum,
        enabled: true,
      });
      setWeekly(EMPTY_WEEKLY);
      await afterMutation();
    } catch (err) {
      setWeeklyError(err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : 'Failed to save the schedule.');
    } finally {
      setSavingWeekly(false);
    }
  };

  const saveOnce = async () => {
    if (!isOnceValid || savingOnce) return;
    const fireAt = zonedTimeToUtcIso(once.date, once.time, valve.timezone);
    if (!fireAt) return;
    setSavingOnce(true);
    setOnceError(null);
    try {
      await valvesAPI.createSchedule(valve.deviceEui, {
        kind: 'ONCE',
        label: once.label.trim() || null,
        fireAt,
        durationMinutes: onceDurationNum,
        enabled: true,
      });
      setOnce(EMPTY_ONCE);
      await afterMutation();
    } catch (err) {
      setOnceError(err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : 'Failed to save the schedule.');
    } finally {
      setSavingOnce(false);
    }
  };

  const toggleEnabled = async (schedule: ValveSchedule) => {
    setRowBusyUuid(schedule.scheduleUuid);
    setRowError(null);
    try {
      await valvesAPI.updateSchedule(valve.deviceEui, schedule.scheduleUuid, { enabled: !schedule.enabled });
      await afterMutation();
    } catch (err) {
      setRowError(err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : 'Failed to update the schedule.');
    } finally {
      setRowBusyUuid(null);
    }
  };

  const deleteRow = async (schedule: ValveSchedule) => {
    setRowBusyUuid(schedule.scheduleUuid);
    setRowError(null);
    try {
      await valvesAPI.deleteSchedule(valve.deviceEui, schedule.scheduleUuid);
      await afterMutation();
    } catch (err) {
      setRowError(err instanceof ValvePlanConflictError ? describeConflict(err.details, td) : 'Failed to delete the schedule.');
    } finally {
      setRowBusyUuid(null);
    }
  };

  const weeklyLiters = isWeeklyValid ? estimateLiters(valve.flowRateLpm, weeklyDurationNum) : null;
  const weeklyPreview = isWeeklyValid
    ? t('scheduleDialog.preview', {
        days: weekly.days.map((d) => td(`weekdays.${d}`)).join(', '),
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">{t('scheduleDialog.title', { name: valve.name })}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)]"
          >
            {t('cancel')}
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {error && <p className="text-sm text-[var(--warn-text)]">{t('scheduleDialog.title', { name: valve.name })}</p>}

          {data && (
            <>
              <section>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('scheduleDialog.week')}</p>
                <div className="mt-2 grid grid-cols-7 gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const windows = data.compiled.days[d] ?? [];
                    const badge = valve.stregaGeneration === 'GEN1'
                      ? pushBadgeLabel(latestPush(data.pushState.filter((p) => p.weekday === d)), valve.timezone, td)
                      : null;
                    return (
                      <div key={d} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-2">
                        <p className="text-xs font-semibold text-[var(--text-tertiary)]">{td(`weekdays.${d}`)}</p>
                        {windows.length === 0 ? (
                          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('scheduleDialog.noWindows')}</p>
                        ) : (
                          <ul className="mt-1 space-y-0.5">
                            {windows.map((w) => (
                              <li key={w.scheduleUuid} className="text-[11px] leading-tight text-[var(--text)]">
                                {pad(w.onH)}:{pad(w.onM)}–{pad(w.offH)}:{pad(w.offM)}
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">{t('scheduleDialog.windows', { count: windows.length })}</p>
                        {badge && <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">{badge}</p>}
                      </div>
                    );
                  })}
                </div>
                {valve.stregaGeneration === 'GEN2' && (() => {
                  const overall = pushBadgeLabel(latestPush(data.pushState), valve.timezone, td);
                  return overall ? <p className="mt-2 text-xs text-[var(--text-tertiary)]">{overall}</p> : null;
                })()}
              </section>

              <p className="mt-3 text-xs text-[var(--text-tertiary)]">{t('bluetoothNote')}</p>

              <section className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('scheduleDialog.list')}</p>
                {rowError && <p className="mt-1 text-xs text-[var(--warn-text)]">{rowError}</p>}
                {data.schedules.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--text-tertiary)]">{t('noSchedule')}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {data.schedules.map((schedule) => (
                      <li key={schedule.scheduleUuid} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--text)]">
                            {schedule.label ?? (schedule.kind === 'WEEKLY' ? t('scheduleDialog.addWeekly') : t('scheduleDialog.addOnce'))}
                          </p>
                          <p className="truncate text-xs text-[var(--text-tertiary)]">
                            {schedule.kind === 'WEEKLY'
                              ? `${weekdaysFromMask(schedule.weekdaysMask ?? 0).map((d) => td(`weekdays.${d}`)).join(', ')} · ${schedule.startTime}–${windowEnd(schedule.startTime ?? '00:00', schedule.durationMinutes)} · ${schedule.durationMinutes} min`
                              : `${schedule.fireAt ? formatDateTime(schedule.fireAt, valve.timezone) : '—'} · ${schedule.durationMinutes} min`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                            <input
                              type="checkbox"
                              checked={schedule.enabled}
                              disabled={rowBusyUuid === schedule.scheduleUuid}
                              onChange={() => void toggleEnabled(schedule)}
                              className="h-4 w-4"
                            />
                            {t('scheduleDialog.enabled')}
                          </label>
                          <button
                            type="button"
                            onClick={() => void deleteRow(schedule)}
                            disabled={rowBusyUuid === schedule.scheduleUuid}
                            className="text-xs font-semibold text-[var(--warn-text)] underline disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {t('scheduleDialog.delete')}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                  <p className="text-sm font-semibold text-[var(--text)]">{t('scheduleDialog.addWeekly')}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {WEEKDAYS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleWeekday(d)}
                        className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                          weekly.days.includes(d)
                            ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
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
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
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
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
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
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                    />
                  </div>
                  {weeklyPreview && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">
                      {weeklyPreview}{weeklyLiters !== null && ` · ${t('scheduleDialog.previewLiters', { liters: weeklyLiters })}`}
                    </p>
                  )}
                  {weeklyError && <p className="mt-2 text-xs text-[var(--warn-text)]">{weeklyError}</p>}
                  <button
                    type="button"
                    onClick={() => void saveWeekly()}
                    disabled={!isWeeklyValid || savingWeekly}
                    className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingWeekly ? t('scheduleDialog.saving') : t('scheduleDialog.save')}
                  </button>
                </section>

                <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                  <p className="text-sm font-semibold text-[var(--text)]">{t('scheduleDialog.addOnce')}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-date-${valve.deviceEui}`}>{t('scheduleDialog.date')}</label>
                      <input
                        id={`once-date-${valve.deviceEui}`}
                        type="date"
                        value={once.date}
                        onChange={(e) => setOnce((prev) => ({ ...prev, date: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-time-${valve.deviceEui}`}>{t('scheduleDialog.time')}</label>
                      <input
                        id={`once-time-${valve.deviceEui}`}
                        type="time"
                        value={once.time}
                        onChange={(e) => setOnce((prev) => ({ ...prev, time: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
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
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[var(--text-tertiary)]" htmlFor={`once-label-${valve.deviceEui}`}>{t('scheduleDialog.label')}</label>
                      <input
                        id={`once-label-${valve.deviceEui}`}
                        type="text"
                        value={once.label}
                        onChange={(e) => setOnce((prev) => ({ ...prev, label: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-[var(--text-tertiary)]">{t('scheduleDialog.onceNote')}</p>
                  {oncePreview && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">
                      {oncePreview}{onceLiters !== null && ` · ${t('scheduleDialog.previewLiters', { liters: onceLiters })}`}
                    </p>
                  )}
                  {onceError && <p className="mt-2 text-xs text-[var(--warn-text)]">{onceError}</p>}
                  <button
                    type="button"
                    onClick={() => void saveOnce()}
                    disabled={!isOnceValid || savingOnce}
                    className="mt-3 w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingOnce ? t('scheduleDialog.saving') : t('scheduleDialog.save')}
                  </button>
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ValveScheduleDialog;
