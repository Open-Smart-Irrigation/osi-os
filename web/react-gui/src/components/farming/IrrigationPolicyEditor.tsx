import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Device,
  IrrigationPolicyDendroAvailability,
  IrrigationPolicyCondition,
  IrrigationPolicySchedule,
  IrrigationPolicySourceChoice,
  IrrigationPolicyView,
  IrrigationZone,
} from '../../types/farming';
import { irrigationPolicyAPI, systemSettingsAPI } from '../../services/api';
import {
  buildCondition,
  conditionDraftFromPolicy,
  isConditionalSchedule,
  legacySixAmPreview,
  type PolicyConditionDraft,
  type PolicyEditDraft,
  type PolicyScheduleDraft,
} from '../../utils/irrigationPolicy';
import { SwtPreference } from './shared/SwtPreference';
import { ValveControlHelp } from './shared/ValveControlHelp';

export interface IrrigationPolicyEditorProps {
  zone: IrrigationZone;
  devices: Device[];
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  initialDeviceEui?: string | null;
}

type ConditionKind = 'SWT' | 'VWC' | 'DENDRO';
type TimingMode = 'every-day' | 'selected-days';
type Translate = (key: string, options?: Record<string, unknown>) => string;
type ScheduleRowDraft = {
  key: string;
  scheduleUuid: string | null;
  expectedSyncVersion: number | null;
  deviceEui: string;
  days: number[];
  startTime: string;
  durationMinutes: number;
  enabled: boolean;
  execution: 'conditional';
  label: string | null;
};

const DEFAULT_CONDITIONS: Record<ConditionKind, PolicyConditionDraft> = {
  SWT: { kind: 'SWT', threshold: 30, sources: [] },
  VWC: { kind: 'VWC', threshold: '', sources: [] },
  DENDRO: { kind: 'DENDRO', minimumStress: 'moderate', responseMode: 'fixed' },
};

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALL_DAYS = 127;

function canonicalEui(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase();
}

function isValidIanaTimezone(value: string | null | undefined): value is string {
  if (!value || !value.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown, fallback: string): string {
  const value = error as { response?: { data?: { message?: unknown; detail?: unknown; affected_ids?: unknown } }; message?: unknown } | null;
  const message = value?.response?.data?.message ?? value?.response?.data?.detail ?? value?.message;
  const affected = value?.response?.data?.affected_ids;
  const suffix = Array.isArray(affected) && affected.length > 0
    ? ` (${affected.map(item => String(item)).join(', ')})`
    : '';
  return typeof message === 'string' && message ? `${message}${suffix}` : fallback;
}

function sourceKey(source: { deviceEui: string; channel: string }): string {
  return `${canonicalEui(source.deviceEui)}:${source.channel}`;
}

function sourceLabel(source: Extract<IrrigationPolicySourceChoice, { deviceEui: string }>, devices: Device[], unavailable: boolean, tr: Translate): string {
  const device = devices.find(item => canonicalEui(item.deveui) === canonicalEui(source.deviceEui));
  const name = source.name ?? device?.name ?? source.deviceEui;
  const channelKey = source.channel.toLowerCase();
  const configuredDepth = device?.soilMoistureProbeDepths?.[channelKey]
    ?? device?.soil_moisture_probe_depths_json?.[channelKey]
    ?? (channelKey.startsWith('swt_') ? device?.soil_moisture_probe_depths_json?.[channelKey.replace('swt_', 'swt_wm')] : undefined);
  const depthCm = source.depthCm ?? configuredDepth ?? null;
  const depth = depthCm == null ? '' : ` · ${depthCm} cm`;
  const suffix = unavailable ? ` · ${tr('irrigationPolicy.unavailable', { defaultValue: 'unavailable' })}` : '';
  return `${name} · ${source.channel}${depth}${suffix}`;
}

function conditionKind(condition: IrrigationPolicyCondition | null | undefined): ConditionKind {
  return condition?.kind === 'VWC' || condition?.kind === 'DENDRO' ? condition.kind : 'SWT';
}

function daysFromMask(mask: number | null | undefined): number[] {
  const value = Number(mask ?? 0);
  return DAY_LABELS.map((_, day) => day).filter(day => (value & (1 << day)) !== 0);
}

function maskFromDays(days: number[]): number {
  return days.reduce((mask, day) => mask | (1 << day), 0);
}

function scheduleRowFromSchedule(schedule: IrrigationPolicySchedule, index: number): ScheduleRowDraft {
  return {
    key: schedule.scheduleUuid || `existing-${index}`,
    scheduleUuid: schedule.scheduleUuid,
    expectedSyncVersion: schedule.syncVersion ?? null,
    deviceEui: canonicalEui(schedule.deviceEui),
    days: daysFromMask(schedule.weekdaysMask ?? ALL_DAYS),
    startTime: schedule.startTime ?? '06:00',
    durationMinutes: schedule.durationMinutes,
    enabled: schedule.enabled,
    execution: 'conditional',
    label: schedule.label ?? null,
  };
}

function newScheduleRow(deviceEui: string, key: string): ScheduleRowDraft {
  return {
    key,
    scheduleUuid: null,
    expectedSyncVersion: null,
    deviceEui: canonicalEui(deviceEui),
    days: daysFromMask(ALL_DAYS),
    startTime: '06:00',
    durationMinutes: 20,
    enabled: true,
    execution: 'conditional',
    label: null,
  };
}

function draftFromView(view: IrrigationPolicyView): {
  conditions: Record<ConditionKind, PolicyConditionDraft>;
  activeKind: ConditionKind;
  selectedValveEuis: string[];
  scheduleRows: ScheduleRowDraft[];
  startTime: string;
  timingMode: TimingMode;
} {
  const condition = view.policy?.condition ?? null;
  const activeKind = conditionKind(condition);
  const conditions = { ...DEFAULT_CONDITIONS };
  if (condition) conditions[activeKind] = conditionDraftFromPolicy(condition);
  const schedules = view.schedules.filter(schedule => isConditionalSchedule(schedule) && !schedule.deletedAt);
  const scheduleRows = schedules.map(scheduleRowFromSchedule);
  const selectedValveEuis = [...new Set(scheduleRows.map(row => row.deviceEui))];
  const first = schedules[0];
  const firstStartTime = first?.startTime ?? '06:00';
  const distinctTimes = schedules.some(schedule => (schedule.startTime ?? '06:00') !== firstStartTime);
  return {
    conditions,
    activeKind,
    selectedValveEuis,
    scheduleRows,
    startTime: firstStartTime,
    timingMode: schedules.length > 0 && (distinctTimes || schedules.some(schedule => (schedule.weekdaysMask ?? ALL_DAYS) !== ALL_DAYS)) ? 'selected-days' : 'every-day',
  };
}

export const IrrigationPolicyEditor: React.FC<IrrigationPolicyEditorProps> = ({
  zone,
  devices,
  open,
  onClose,
  onSaved,
  initialDeviceEui,
}) => {
  const { t } = useTranslation('valves');
  const tr = t as unknown as Translate;
  const [view, setView] = useState<IrrigationPolicyView | null>(null);
  const [activeKind, setActiveKind] = useState<ConditionKind>('SWT');
  const [conditions, setConditions] = useState<Record<ConditionKind, PolicyConditionDraft>>(DEFAULT_CONDITIONS);
  const [selectedValveEuis, setSelectedValveEuis] = useState<string[]>([]);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRowDraft[]>([]);
  const [timingMode, setTimingMode] = useState<TimingMode>('every-day');
  const [startTime, setStartTime] = useState('06:00');
  const [enabled, setEnabled] = useState(true);
  const [observationWindow, setObservationWindow] = useState(60);
  const [minInterval, setMinInterval] = useState(60);
  const [maxDaily, setMaxDaily] = useState(240);
  const [deliveryIntervals, setDeliveryIntervals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retryingValve, setRetryingValve] = useState<string | null>(null);
  const [policyTimezone, setPolicyTimezone] = useState<string | null>(null);
  const [gatewayTimezone, setGatewayTimezone] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ kind: 'pause' | 'retry'; status: number; deviceEui?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSuccess(null);
    setActionFeedback(null);
    setGatewayTimezone(null);
    irrigationPolicyAPI.get(zone.zoneUuid ?? zone.zone_uuid ?? zone.id)
      .then(nextView => {
        if (cancelled) return;
        const draft = draftFromView(nextView);
        const initialEui = canonicalEui(initialDeviceEui);
        if (initialEui && !draft.selectedValveEuis.includes(initialEui)) {
          draft.selectedValveEuis.push(initialEui);
          draft.scheduleRows.push(newScheduleRow(initialEui, `new:${initialEui}`));
        }
        setView(nextView);
        setConditions(draft.conditions);
        setActiveKind(draft.activeKind);
        setSelectedValveEuis(draft.selectedValveEuis);
        setScheduleRows(draft.scheduleRows);
        setTimingMode(draft.timingMode);
        setStartTime(draft.startTime);
        setEnabled(nextView.policy?.enabled ?? true);
        setObservationWindow(nextView.policy?.observationWindowMinutes ?? 60);
        setMinInterval(nextView.policy?.minIntervalMinutes ?? 60);
        setMaxDaily(nextView.policy?.maxDailyMinutes ?? 240);
        setDeliveryIntervals(Object.fromEntries(Object.entries(nextView.policy?.deliverySettings ?? {}).map(([eui, setting]) => [eui, setting.deliveryIntervalMinutes])));
        const authoritativeTimezone = [nextView.policy?.timezone, nextView.zone.timezone, zone.timezone]
          .find(isValidIanaTimezone) ?? null;
        setPolicyTimezone(authoritativeTimezone);
        if (!authoritativeTimezone) {
          systemSettingsAPI.get().then(settings => {
            if (!cancelled && isValidIanaTimezone(settings.gatewayTimezone)) {
              setGatewayTimezone(settings.gatewayTimezone);
              setPolicyTimezone(settings.gatewayTimezone);
            }
          }).catch(() => { /* an explicit timezone field remains required */ });
        }
      })
      .catch(nextError => { if (!cancelled) setError(errorText(nextError, tr('irrigationPolicy.loadFailed', { defaultValue: 'Could not load irrigation policy.' }))); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialDeviceEui, open, tr, zone.id, zone.zoneUuid, zone.zone_uuid]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  const currentCondition = conditions[activeKind];
  const currentChoices = view?.runtime.sourceChoices[activeKind] ?? [];
  const currentSources = currentCondition.kind === 'DENDRO' ? [] : currentCondition.sources;
  const sensorChoices = currentChoices.filter((choice): choice is Extract<IrrigationPolicySourceChoice, { deviceEui: string }> => choice.kind !== 'DENDRO');
  const sourceOptions = useMemo(() => {
    const options = [...sensorChoices];
    for (const selected of currentSources) {
      if (!options.some(option => sourceKey(option) === sourceKey(selected))) {
        options.push({
          ...selected,
          kind: activeKind === 'VWC' ? 'VWC' : 'SWT',
          eligible: false,
          reason: 'selected_source_unavailable',
        });
      }
    }
    return options;
  }, [activeKind, currentSources, sensorChoices]);
  const dendroAvailability = currentChoices.find(choice => choice.kind === 'DENDRO') as IrrigationPolicyDendroAvailability | undefined;

  const valves = useMemo(() => {
    const fromDevices = devices.filter(device => device.type_id === 'STREGA_VALVE').map(device => ({
      deviceEui: canonicalEui(device.deveui),
      name: device.name,
    }));
    const known = new Set(fromDevices.map(item => item.deviceEui));
    for (const eui of selectedValveEuis) if (!known.has(eui)) fromDevices.push({ deviceEui: eui, name: eui });
    for (const item of view?.runtime.valves ?? []) if (item.deviceEui && !known.has(item.deviceEui)) fromDevices.push({ deviceEui: item.deviceEui, name: item.deviceEui });
    return fromDevices;
  }, [devices, selectedValveEuis, view?.runtime.valves]);

  const rowsForValve = (eui: string) => scheduleRows.filter(row => row.deviceEui === canonicalEui(eui));
  const validTiming = selectedValveEuis.every(eui => {
    const rows = rowsForValve(eui);
    return rows.length > 0 && rows.every(row => row.days.length > 0 && /^\d{2}:\d{2}$/.test(row.startTime)
      && Number.isInteger(row.durationMinutes) && row.durationMinutes >= 1 && row.durationMinutes <= 240);
  });
  const conditionValid = currentCondition.kind === 'DENDRO'
    ? Boolean(currentCondition.minimumStress && currentCondition.responseMode)
    : typeof currentCondition.threshold === 'number'
      && Number.isFinite(currentCondition.threshold)
      && currentCondition.threshold >= 0
      && currentSources.length > 0;
  const policyTimezoneValid = isValidIanaTimezone(policyTimezone);
  const canSave = !loading && !saving && policyTimezoneValid && conditionValid && selectedValveEuis.length > 0 && validTiming;

  const setCondition = (next: PolicyConditionDraft) => setConditions(previous => ({ ...previous, [activeKind]: next }));
  const setSource = (value: string) => {
    if (currentCondition.kind === 'DENDRO') return;
    const match = sourceOptions.find(option => sourceKey(option) === value);
    if (!match || currentSources.some(source => sourceKey(source) === value) || currentSources.length >= 32) return;
    setCondition({ ...currentCondition, sources: [...currentSources, { deviceEui: match.deviceEui, channel: match.channel }] });
  };
  const removeSource = (value: string) => {
    if (currentCondition.kind === 'DENDRO') return;
    setCondition({ ...currentCondition, sources: currentSources.filter(source => sourceKey(source) !== value) });
  };
  const renderSourcePicker = (id: string, ariaLabel: string) => (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-[var(--text-secondary)]">{tr('irrigationPolicy.source', { defaultValue: 'Source' })}</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {currentSources.map(source => {
          const option = sourceOptions.find(candidate => sourceKey(candidate) === sourceKey(source));
          if (!option) return null;
          const key = sourceKey(source);
          return <span key={key} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--text-secondary)]">
            <span>{sourceLabel(option, devices, !option.eligible, tr)}</span>
            {option.reason && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{option.reason}</ValveControlHelp>}
            <button type="button" aria-label={`${tr('irrigationPolicy.removeSource', { defaultValue: 'Remove source' })} ${source.channel}`} onClick={() => removeSource(key)} className="touch-target rounded-md text-base text-[var(--text-secondary)] hover:bg-[var(--secondary-bg)]">×</button>
          </span>;
        })}
      </div>
      <select id={id} aria-label={ariaLabel} value="" onChange={event => setSource(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--text)]">
        <option value="">{tr('irrigationPolicy.addSource', { defaultValue: 'Add a source' })}</option>
        {sourceOptions.filter(option => !currentSources.some(source => sourceKey(source) === sourceKey(option))).map(option => <option key={sourceKey(option)} value={sourceKey(option)}>{sourceLabel(option, devices, !option.eligible, tr)}</option>)}
      </select>
    </div>
  );

  const save = async ({ convertToAlways = false } = {}) => {
    if (!view || !policyTimezoneValid || !canSave) return;
    const timezone = policyTimezone;
    if (!isValidIanaTimezone(timezone)) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    setActionFeedback(null);
    const existing = scheduleRows.filter(row => row.scheduleUuid !== null);
    if (convertToAlways && existing.length === 0) {
      setSaving(false);
      return;
    }
    const targetRows = convertToAlways
      ? existing
      : scheduleRows.filter(row => selectedValveEuis.includes(row.deviceEui));
    const targetValveEuis = [...new Set(targetRows.map(row => row.deviceEui))];
    const useEveryDayDraft = !convertToAlways && timingMode === 'every-day';
    const canonicalSchedules = new Map(view.schedules.map(schedule => [schedule.scheduleUuid, schedule]));
    const baselinePolicy = view.policy;
    const isNewPolicy = !baselinePolicy;
    const includeAllPolicyFields = isNewPolicy;
    const baselineTimezone = baselinePolicy?.timezone ?? view.zone.timezone ?? zone.timezone ?? gatewayTimezone;
    const timezoneChanged = !isNewPolicy && timezone !== baselineTimezone;
    const activeRows: PolicyScheduleDraft[] = targetRows.flatMap(row => {
      const weekdaysMask = useEveryDayDraft ? ALL_DAYS : maskFromDays(row.days);
      const rowStartTime = useEveryDayDraft ? startTime : row.startTime;
      const execution = convertToAlways ? 'always' : 'conditional';
      const canonical = row.scheduleUuid ? canonicalSchedules.get(row.scheduleUuid) : undefined;
      const fullRow: PolicyScheduleDraft = {
        scheduleUuid: row.scheduleUuid,
        expectedSyncVersion: row.expectedSyncVersion,
        deviceEui: row.deviceEui,
        kind: 'WEEKLY',
        weekdaysMask,
        startTime: rowStartTime,
        durationMinutes: row.durationMinutes,
        enabled: row.enabled,
        execution,
        label: row.label,
        detach: false,
      };
      if (convertToAlways) {
        return [{
          scheduleUuid: row.scheduleUuid,
          expectedSyncVersion: row.expectedSyncVersion,
          execution: 'always',
          ...(timezoneChanged ? { startTime: rowStartTime } : {}),
        }];
      }
      if (!canonical) return [fullRow];

      const patch: PolicyScheduleDraft = {
        scheduleUuid: row.scheduleUuid,
        expectedSyncVersion: row.expectedSyncVersion,
      };
      const canonicalExecution = canonical.execution ?? (canonical.conditionPolicyUuid ? 'conditional' : null);
      if (canonicalEui(canonical.deviceEui) !== row.deviceEui) patch.deviceEui = row.deviceEui;
      if ((canonical.weekdaysMask ?? ALL_DAYS) !== weekdaysMask) patch.weekdaysMask = weekdaysMask;
      if (timezoneChanged) patch.startTime = rowStartTime;
      if ((canonical.startTime ?? null) !== rowStartTime) patch.startTime = rowStartTime;
      if (canonical.durationMinutes !== row.durationMinutes) patch.durationMinutes = row.durationMinutes;
      if (canonical.enabled !== row.enabled) patch.enabled = row.enabled;
      if (canonicalExecution !== execution) patch.execution = execution;
      if ((canonical.label ?? null) !== (row.label ?? null)) patch.label = row.label;
      return Object.keys(patch).length > 2 ? [patch] : [];
    });
    const detachedRows: PolicyScheduleDraft[] = convertToAlways ? [] : scheduleRows
      .filter(row => row.scheduleUuid !== null && !selectedValveEuis.includes(row.deviceEui))
      .map(row => ({ scheduleUuid: row.scheduleUuid, expectedSyncVersion: row.expectedSyncVersion, detach: true }));
    const savedEnabled = convertToAlways ? false : enabled;
    const pauseForcedDisabled = actionFeedback?.kind === 'pause';
    const baselineCondition = baselinePolicy ? conditionDraftFromPolicy(baselinePolicy.condition) : null;
    const conditionChanged = includeAllPolicyFields || (!convertToAlways && (
      !baselineCondition
      || JSON.stringify(buildCondition(currentCondition)) !== JSON.stringify(buildCondition(baselineCondition))
    ));
    const canonicalValveEuis = new Set(view.schedules
      .filter(schedule => isConditionalSchedule(schedule) && !schedule.deletedAt)
      .map(schedule => canonicalEui(schedule.deviceEui)));
    const selectedValveSet = new Set(targetValveEuis);
    const membershipChanged = canonicalValveEuis.size !== selectedValveSet.size
      || [...canonicalValveEuis].some(eui => !selectedValveSet.has(eui));
    const deliveryChanged = includeAllPolicyFields || membershipChanged || targetValveEuis.some(eui => (
      deliveryIntervals[eui] ?? 10
    ) !== (baselinePolicy?.deliverySettings[eui]?.deliveryIntervalMinutes ?? 10));
    const draft: PolicyEditDraft = {
      policyUuid: view.policy?.policyUuid ?? null,
      expectedPolicyVersion: view.policy?.syncVersion ?? null,
      zoneUuid: view.zone.zoneUuid ?? zone.zoneUuid ?? zone.zone_uuid ?? null,
    };
    if (conditionChanged) draft.condition = currentCondition;
    if (includeAllPolicyFields || timezone !== baselineTimezone) draft.timezone = timezone;
    if (includeAllPolicyFields || pauseForcedDisabled || savedEnabled !== baselinePolicy?.enabled) draft.enabled = savedEnabled;
    if (includeAllPolicyFields || observationWindow !== baselinePolicy?.observationWindowMinutes) draft.observationWindowMinutes = observationWindow;
    if (includeAllPolicyFields || minInterval !== baselinePolicy?.minIntervalMinutes) draft.minIntervalMinutes = minInterval;
    if (includeAllPolicyFields || maxDaily !== baselinePolicy?.maxDailyMinutes) draft.maxDailyMinutes = maxDaily;
    if (deliveryChanged) {
      draft.deliverySettings = Object.fromEntries(targetValveEuis.map(eui => [eui, { deliveryIntervalMinutes: deliveryIntervals[eui] ?? 10 }]));
    }
    const scheduleEdits = [...activeRows, ...detachedRows];
    if (scheduleEdits.length > 0) draft.schedules = scheduleEdits;
    try {
      const nextView = await irrigationPolicyAPI.save(zone.zoneUuid ?? zone.zone_uuid ?? zone.id, draft);
      const nextDraft = draftFromView(nextView);
      setView(nextView);
      setSelectedValveEuis(nextDraft.selectedValveEuis);
      setScheduleRows(nextDraft.scheduleRows);
      setTimingMode(nextDraft.timingMode);
      setStartTime(nextDraft.startTime);
      setEnabled(savedEnabled);
      setSuccess(nextView.httpStatus === 202
        ? tr('irrigationPolicy.updating', { defaultValue: 'Updating valve' })
        : tr('irrigationPolicy.saved', { defaultValue: 'Irrigation policy saved.' }));
      onSaved?.();
      if (convertToAlways) onClose();
    } catch (saveError) {
      setError(errorText(saveError, tr('irrigationPolicy.saveFailed', { defaultValue: 'The policy could not be saved. Check the affected fields and try again.' })));
    } finally {
      setSaving(false);
    }
  };

  const retryValve = async (deviceEui: string) => {
    setRetryingValve(deviceEui);
    setError(null);
    setSuccess(null);
    try {
      const action = await irrigationPolicyAPI.retryValve(
        zone.zoneUuid ?? zone.zone_uuid ?? zone.id,
        deviceEui,
      );
      setActionFeedback({ kind: 'retry', status: action.status, deviceEui: action.deviceEui });
      onSaved?.();
      try {
        await irrigationPolicyAPI.get(zone.zoneUuid ?? zone.zone_uuid ?? zone.id).then(setView);
        setSuccess(action.status === 202
          ? tr('irrigationPolicy.retryQueued', { defaultValue: 'Valve update retry queued.' })
          : tr('irrigationPolicy.saved', { defaultValue: 'Irrigation policy saved.' }));
      } catch {
        setSuccess(tr('irrigationPolicy.actionRefreshUnavailable', { defaultValue: 'Action completed, but the current policy state could not be refreshed.' }));
      }
    } catch (retryError) {
      setError(errorText(retryError, tr('irrigationPolicy.actionFailed', { defaultValue: 'Action failed.' })));
    } finally {
      setRetryingValve(null);
    }
  };

  const pausePolicy = async () => {
    if (!view?.policy) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const action = await irrigationPolicyAPI.pause(
        zone.zoneUuid ?? zone.zone_uuid ?? zone.id,
        { expected_policy_version: view.policy.syncVersion },
      );
      setActionFeedback({ kind: 'pause', status: action.status });
      setEnabled(false);
      onSaved?.();
      try {
        const refreshed = await irrigationPolicyAPI.get(zone.zoneUuid ?? zone.zone_uuid ?? zone.id);
        setView(refreshed);
        setEnabled(refreshed.policy?.enabled ?? false);
        setSuccess(action.status === 202
          ? tr('irrigationPolicy.updating', { defaultValue: 'Updating valve' })
          : tr('irrigationPolicy.paused', { defaultValue: 'Policy paused.' }));
      } catch {
        setSuccess(tr('irrigationPolicy.actionRefreshUnavailable', { defaultValue: 'Action completed, but the current policy state could not be refreshed.' }));
      }
    } catch (pauseError) {
      setError(errorText(pauseError, tr('irrigationPolicy.actionFailed', { defaultValue: 'Action failed.' })));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const titleId = `irrigation-policy-title-${zone.id}`;
  const runtimeTrusted = Boolean(view && view.runtime.availability === 'fresh' && view.runtime.clock?.trusted === true);
  const previewDates = runtimeTrusted
    ? ['2026-01-15', '2026-07-15'].map(date => legacySixAmPreview(date, view?.runtime.legacyProcessTimezone, policyTimezone)).filter(Boolean)
    : [];
  const runtimeUnavailable = view && !runtimeTrusted;
  const qualification = view?.runtime.qualification;
  const lastResult = view?.runtime.lastResult;
  const lastDecision = lastResult && typeof lastResult.decision === 'string' ? lastResult.decision : null;
  const lastReason = lastResult && typeof (lastResult.decision_reason ?? lastResult.reason) === 'string'
    ? String(lastResult.decision_reason ?? lastResult.reason)
    : null;
  const conditionalSchedules = view?.schedules.filter(schedule => isConditionalSchedule(schedule) && !schedule.deletedAt) ?? [];
  const selectedPolicyRows = scheduleRows.filter(row => selectedValveEuis.includes(row.deviceEui));
  const newPolicyTimes = timingMode === 'every-day'
    ? `${tr('irrigationPolicy.everyDay', { defaultValue: 'Every day' })} ${startTime}`
    : selectedPolicyRows.length > 0
      ? selectedPolicyRows.map(row => `${row.deviceEui} ${row.startTime}`).join(' · ')
    : `${tr('irrigationPolicy.everyDay', { defaultValue: 'Every day' })} ${startTime}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">{tr('irrigationPolicy.title', { defaultValue: 'Conditional irrigation' })}</h2>
            <p className="text-xs text-[var(--text-tertiary)]">{zone.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={tr('close', { defaultValue: 'Close' })} className="flex h-11 w-11 items-center justify-center rounded-lg text-xl text-[var(--text-tertiary)] hover:bg-[var(--secondary-bg)]">&times;</button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {loading && <p className="text-sm text-[var(--text-tertiary)]">{tr('irrigationPolicy.loading', { defaultValue: 'Loading policy…' })}</p>}
          {error && <p role="alert" className="mb-4 rounded-lg border border-[var(--error-text)] bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">{error}</p>}
          {success && <p role="status" className="mb-4 rounded-lg border border-[var(--success-border)] bg-[var(--success-bg)] px-3 py-2 text-sm text-[var(--success-text)]">{success}</p>}

          {!loading && view && (
            <>
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{tr('irrigationPolicy.condition', { defaultValue: 'Condition' })}</h3>
                  <ValveControlHelp label={tr('irrigationPolicy.conditionHelpLabel', { defaultValue: 'About conditions' })}>{tr('irrigationPolicy.conditionHelp', { defaultValue: 'The gateway evaluates this condition at the selected schedule times.' })}</ValveControlHelp>
                </div>
                {view.runtime.inactiveReason === 'vwc_condition_disabled' && (
                  <p role="status" className="mb-3 rounded-lg border border-[var(--warning-border,var(--border))] bg-[var(--warning-bg,var(--card))] px-3 py-2 text-sm text-[var(--text-secondary)]">
                    {tr('irrigationPolicy.vwcDisabled', { defaultValue: 'VWC conditions are turned off on this gateway. This policy does not irrigate until they are turned on.' })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(['SWT', 'VWC', 'DENDRO'] as ConditionKind[])
                    // R17-M1 / D18: VWC is offered only while the gateway's VWC gate is on, or to
                    // show an existing VWC policy (which then reads as inactive above).
                    .filter(kind => kind !== 'VWC' || view.runtime.vwcConditionEnabled === true || view.policy?.condition?.kind === 'VWC')
                    .map(kind => (
                    <button key={kind} type="button" onClick={() => setActiveKind(kind)} aria-pressed={activeKind === kind} className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-semibold ${activeKind === kind ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--on-primary)]' : 'border-[var(--border)] bg-[var(--card)] text-[var(--text-secondary)]'}`}>
                      {kind === 'SWT' ? tr('irrigationPolicy.swt', { defaultValue: 'SWT' }) : kind === 'VWC' ? tr('irrigationPolicy.vwc', { defaultValue: 'VWC' }) : tr('irrigationPolicy.dendro', { defaultValue: 'Dendrometer' })}
                    </button>
                  ))}
                </div>

                {currentCondition.kind === 'SWT' && (
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <div>
                      <SwtPreference value={typeof currentCondition.threshold === 'number' ? currentCondition.threshold : 30} onChange={threshold => setCondition({ ...currentCondition, threshold })} />
                    </div>
                    {renderSourcePicker('policy-swt-source', tr('irrigationPolicy.swtSource', { defaultValue: 'SWT source' }))}
                  </div>
                )}

                {currentCondition.kind === 'VWC' && (
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <div>
                      <label htmlFor="policy-vwc-threshold" className="block text-sm font-semibold text-[var(--text-secondary)]">{tr('irrigationPolicy.vwcThreshold', { defaultValue: 'VWC threshold (%)' })}</label>
                      <input id="policy-vwc-threshold" aria-label={tr('irrigationPolicy.vwcThreshold', { defaultValue: 'VWC threshold (%)' })} type="number" min="0" max="100" step="any" value={currentCondition.threshold} onChange={event => setCondition({ ...currentCondition, threshold: event.target.value === '' ? '' : Number(event.target.value) })} className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--text)]" />
                    </div>
                    {renderSourcePicker('policy-vwc-source', tr('irrigationPolicy.vwcSource', { defaultValue: 'VWC source' }))}
                  </div>
                )}

                {currentCondition.kind === 'DENDRO' && (
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <label className="text-sm font-semibold text-[var(--text-secondary)]">{tr('irrigationPolicy.minimumStress', { defaultValue: 'Minimum stress' })}
                      <select value={currentCondition.minimumStress} onChange={event => setCondition({ ...currentCondition, minimumStress: event.target.value })} className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm font-normal text-[var(--text)]">
                        {['mild', 'moderate', 'significant', 'severe'].map(value => <option key={value} value={value}>{tr(`irrigationPolicy.stress.${value}`, { defaultValue: value })}</option>)}
                      </select>
                    </label>
                    <label className="text-sm font-semibold text-[var(--text-secondary)]">{tr('irrigationPolicy.responseMode', { defaultValue: 'Response mode' })}
                      <select value={currentCondition.responseMode} onChange={event => setCondition({ ...currentCondition, responseMode: event.target.value })} className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm font-normal text-[var(--text)]">
                        <option value="fixed">{tr('irrigationPolicy.fixed', { defaultValue: 'Fixed' })}</option>
                        <option value="proportional">{tr('irrigationPolicy.proportional', { defaultValue: 'Proportional' })}</option>
                      </select>
                    </label>
                  </div>
                )}
                {currentCondition.kind === 'DENDRO' && dendroAvailability && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span>{tr('irrigationPolicy.dendroAvailability', { defaultValue: 'Dendrometer availability' })}: {dendroAvailability.eligible ? tr('irrigationPolicy.available', { defaultValue: 'available' }) : tr('irrigationPolicy.unavailable', { defaultValue: 'unavailable' })}</span>
                    {dendroAvailability.reason && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{dendroAvailability.reason}</ValveControlHelp>}
                  </div>
                )}
              </section>

              <section className="mt-6 border-t border-[var(--border)] pt-5">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{tr('irrigationPolicy.timing', { defaultValue: 'Timing and valves' })}</h3>
                  <ValveControlHelp label={tr('irrigationPolicy.timingHelpLabel', { defaultValue: 'About timing' })}>{tr('irrigationPolicy.timingHelp', { defaultValue: 'Conditions are evaluated at the selected schedule times. Without a selected schedule time, choose a fixed daily time.' })}</ValveControlHelp>
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--text)]"><input type="radio" name={`policy-timing-${zone.id}`} checked={timingMode === 'every-day'} onChange={() => setTimingMode('every-day')} />{tr('irrigationPolicy.everyDay', { defaultValue: 'Every day' })}</label>
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--text)]"><input type="radio" name={`policy-timing-${zone.id}`} checked={timingMode === 'selected-days'} onChange={() => setTimingMode('selected-days')} />{tr('irrigationPolicy.selectedDays', { defaultValue: 'Selected days' })}</label>
                  {timingMode === 'every-day' && <label className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--text-secondary)]">{tr('irrigationPolicy.startTime', { defaultValue: 'Start time' })}<input aria-label={tr('irrigationPolicy.startTime', { defaultValue: 'Start time' })} type="time" value={startTime} onChange={event => setStartTime(event.target.value)} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--text)]" /></label>}
                </div>
                <div className="mt-3 space-y-3">
                  {scheduleRows.filter(row => selectedValveEuis.includes(row.deviceEui)).map(row => {
                    const valve = valves.find(item => item.deviceEui === row.deviceEui);
                    const rowLabel = `${valve?.name || row.deviceEui} ${row.scheduleUuid || tr('irrigationPolicy.newRow', { defaultValue: 'new row' })}`;
                    return <div key={row.key} className="rounded-lg border border-[var(--border)] p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                        <span>{rowLabel}</span>
                        {timingMode === 'selected-days' && <label className="inline-flex min-h-11 items-center gap-2 font-normal">{tr('irrigationPolicy.startTime', { defaultValue: 'Start time' })}<input aria-label={`${rowLabel} ${tr('irrigationPolicy.startTime', { defaultValue: 'Start time' })}`} type="time" value={row.startTime} onChange={event => setScheduleRows(previous => previous.map(candidate => candidate.key === row.key ? { ...candidate, startTime: event.target.value } : candidate))} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--text)]" /></label>}
                      </div>
                      {timingMode === 'selected-days' && <div className="flex flex-wrap gap-2">{DAY_LABELS.map((label, day) => <label key={label} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border)] px-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" aria-label={`${rowLabel} ${tr(`weekdays.${day}`, { defaultValue: label })}`} checked={row.days.includes(day)} onChange={() => setScheduleRows(previous => previous.map(candidate => candidate.key === row.key ? { ...candidate, days: row.days.includes(day) ? row.days.filter(item => item !== day) : [...row.days, day].sort() } : candidate))} />{tr(`weekdays.${day}`, { defaultValue: label })}</label>)}</div>}
                      <label className="mt-2 flex max-w-xs items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.duration', { defaultValue: 'Duration (min)' })}<input aria-label={`${rowLabel} ${tr('irrigationPolicy.duration', { defaultValue: 'Duration (min)' })}`} type="number" min="1" max="240" value={row.durationMinutes} onChange={event => setScheduleRows(previous => previous.map(candidate => candidate.key === row.key ? { ...candidate, durationMinutes: Number(event.target.value) } : candidate))} className="min-h-11 w-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-right text-sm text-[var(--text)]" /></label>
                    </div>;
                  })}
                </div>
                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {valves.map(valve => {
                    const selected = selectedValveEuis.includes(valve.deviceEui);
                    const runtimeValve = view.runtime.valves.find(item => canonicalEui(item.deviceEui) === valve.deviceEui);
                    const valveAvailability = runtimeValve?.availability ?? view.runtime.availability;
                    const valveRuntimeFresh = valveAvailability === 'fresh';
                    const updateState = valveRuntimeFresh ? (runtimeValve?.update?.state ?? null) : null;
                    const incidentState = valveRuntimeFresh && runtimeValve?.incident && typeof runtimeValve.incident.state === 'string' ? runtimeValve.incident.state : null;
                    const clockTrusted = valveRuntimeFresh && runtimeValve?.clock && typeof runtimeValve.clock.trusted === 'boolean' ? runtimeValve.clock.trusted : null;
                    const retryPending = valveRuntimeFresh && runtimeValve?.incident && runtimeValve.incident.retry_pending === true;
                    const retryable = updateState === 'FAILED' || Boolean(incidentState && !retryPending);
                    const updating = valveRuntimeFresh && (view.httpStatus === 202 || runtimeValve?.update?.ready === false || updateState === 'PENDING');
                    const valveUnavailable = !devices.some(device => canonicalEui(device.deveui) === valve.deviceEui) && !runtimeValve;
                    const valveAvailabilityReason = runtimeValve && typeof runtimeValve.reason === 'string'
                      ? runtimeValve.reason
                      : `${valveAvailability} runtime evidence is not current.`;
                    return <div key={valve.deviceEui} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--text)]"><input type="checkbox" aria-label={valve.name || valve.deviceEui} checked={selected} onChange={() => {
                        if (selected) {
                          setSelectedValveEuis(previous => previous.filter(item => item !== valve.deviceEui));
                        } else {
                          setSelectedValveEuis(previous => [...previous, valve.deviceEui]);
                          if (rowsForValve(valve.deviceEui).length === 0) setScheduleRows(previous => [...previous, newScheduleRow(valve.deviceEui, `new:${valve.deviceEui}:${previous.length}`)]);
                        }
                      }} />{valve.name || valve.deviceEui}</label>
                      <p className="mt-1 text-xs text-[var(--text-tertiary)]">{valve.deviceEui}{valveUnavailable ? ` · ${tr('irrigationPolicy.unavailable', { defaultValue: 'unavailable' })}` : updating ? ` · ${tr('irrigationPolicy.updating', { defaultValue: 'Updating valve' })}` : ''}</p>
                      {!valveRuntimeFresh && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-secondary)]"><span>{tr('irrigationPolicy.runtimeValveStatus', { defaultValue: 'Valve runtime' })}: {valveAvailability}</span><ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{valveAvailabilityReason}</ValveControlHelp></div>}
                      {valveRuntimeFresh && runtimeValve?.update && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-secondary)]"><span>{tr('irrigationPolicy.runtimeValveStatus', { defaultValue: 'Update' })}: {runtimeValve.update.state}</span>{runtimeValve.update.reason && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{runtimeValve.update.reason}</ValveControlHelp>}</div>}
                      {incidentState && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--warn-text)]"><span>{tr('irrigationPolicy.runtimeIncident', { defaultValue: 'Incident' })}: {incidentState}</span>{typeof runtimeValve?.incident?.reason === 'string' && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{runtimeValve.incident.reason}</ValveControlHelp>}</div>}
                      {clockTrusted !== null && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-tertiary)]"><span>{tr('irrigationPolicy.runtimeClock', { defaultValue: 'Valve clock' })}: {clockTrusted ? tr('irrigationPolicy.trusted', { defaultValue: 'trusted' }) : tr('irrigationPolicy.unavailable', { defaultValue: 'unavailable' })}</span>{typeof runtimeValve?.clock?.reason === 'string' && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{runtimeValve.clock.reason}</ValveControlHelp>}</div>}
                      {retryable && <div className="mt-2 flex items-center gap-2"><ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{tr('irrigationPolicy.runtimeHelp', { defaultValue: 'Ready means the gateway acknowledged the clear-program update. It does not prove physical delivery.' })}</ValveControlHelp><button type="button" disabled={saving || retryingValve === valve.deviceEui} onClick={() => retryValve(valve.deviceEui)} className="min-h-11 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] disabled:opacity-50">{retryingValve === valve.deviceEui ? tr('irrigationPolicy.saving', { defaultValue: 'Saving…' }) : tr('irrigationPolicy.retry', { defaultValue: 'Retry update' })}</button></div>}
                    </div>;
                  })}
                </div>
              </section>

              <details className="mt-6 border-t border-[var(--border)] pt-5">
                <summary className="cursor-pointer text-sm font-semibold text-[var(--text)]">{tr('irrigationPolicy.advanced', { defaultValue: 'Advanced settings' })}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.observationWindow', { defaultValue: 'Observation window (min)' })}<input type="number" min="1" max="1440" value={observationWindow} onChange={event => setObservationWindow(Number(event.target.value))} className="mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--text)]" /></label>
                  <label className="text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.minimumGap', { defaultValue: 'Minimum gap (min)' })}<input type="number" min="0" max="1440" value={minInterval} onChange={event => setMinInterval(Number(event.target.value))} className="mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--text)]" /></label>
                  <label className="text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.dailyBudget', { defaultValue: 'Daily budget (min)' })}<input type="number" min="1" max="1440" value={maxDaily} onChange={event => setMaxDaily(Number(event.target.value))} className="mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--text)]" /></label>
                </div>
                {selectedValveEuis.map(eui => <label key={eui} className="mt-3 flex max-w-sm items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">{eui} {tr('irrigationPolicy.deliveryInterval', { defaultValue: 'Delivery interval (min)' })}<input type="number" min="1" max="60" value={deliveryIntervals[eui] ?? 10} onChange={event => setDeliveryIntervals(previous => ({ ...previous, [eui]: Number(event.target.value) }))} className="min-h-11 w-20 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-right text-sm text-[var(--text)]" /></label>)}
              </details>

              <section className="mt-6 border-t border-[var(--border)] pt-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label htmlFor="policy-timezone" className="text-sm font-semibold text-[var(--text-secondary)]">{tr('irrigationPolicy.timezone', { defaultValue: 'Policy timezone' })}
                    <input id="policy-timezone" aria-label={tr('irrigationPolicy.timezone', { defaultValue: 'Policy timezone' })} value={policyTimezone ?? ''} readOnly={Boolean(view.policy?.timezone || view.zone.timezone || zone.timezone || gatewayTimezone)} onChange={event => setPolicyTimezone(event.target.value.trim() || null)} placeholder="Area/Location" className="mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm font-normal text-[var(--text)]" />
                  </label>
                  {!policyTimezoneValid && <p role="alert" className="self-end text-sm text-[var(--error-text)]">{tr('irrigationPolicy.timezoneRequired', { defaultValue: 'Enter a valid IANA timezone before saving.' })}</p>}
                </div>
                {gatewayTimezone && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{tr('irrigationPolicy.gatewayTimezone', { defaultValue: 'Gateway timezone' })}: {gatewayTimezone}</p>}
              </section>

              <section className="mt-6 border-t border-[var(--border)] pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{tr('irrigationPolicy.runtimeStatus', { defaultValue: 'Runtime status' })}</h3>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">{runtimeUnavailable ? (view.runtime.availability === 'fresh' ? tr('irrigationPolicy.runtime.clock_untrusted', { defaultValue: 'Runtime clock is not trusted.' }) : tr(`irrigationPolicy.runtime.${view.runtime.availability}`, { defaultValue: 'Runtime is currently unavailable.' })) : tr('irrigationPolicy.runtimeFresh', { defaultValue: 'Runtime is fresh.' })}</p>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">{view.runtime.nextCheck ? `${tr('irrigationPolicy.nextCheck', { defaultValue: 'Next check' })}: ${view.runtime.nextCheck}` : tr('irrigationPolicy.noNextCheck', { defaultValue: 'No next check is scheduled.' })}</p>
                {runtimeTrusted && qualification && typeof qualification.qualified === 'boolean' && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-tertiary)]"><span>{tr('irrigationPolicy.qualification', { defaultValue: 'Qualification' })}: {qualification.qualified ? tr('irrigationPolicy.available', { defaultValue: 'available' }) : tr('irrigationPolicy.unavailable', { defaultValue: 'unavailable' })}</span>{typeof qualification.reason === 'string' && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{qualification.reason}</ValveControlHelp>}</div>}
                {(lastDecision || lastReason) && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-tertiary)]"><span>{tr('irrigationPolicy.lastResult', { defaultValue: 'Last check' })}: {lastDecision ?? tr('irrigationPolicy.unknown', { defaultValue: 'unknown' })}</span>{lastReason && <ValveControlHelp label={tr('irrigationPolicy.runtimeHelpLabel', { defaultValue: 'About valve status' })}>{lastReason}</ValveControlHelp>}</div>}
                {runtimeTrusted && view.runtime.legacyProcessTimezone && policyTimezone && previewDates.length > 0 && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{tr('irrigationPolicy.legacyPreview', { defaultValue: 'Legacy 06:00 preview' })}: {previewDates.map(item => `${item?.zoneDate} ${item?.zoneTime}`).join(' · ')}</p>}
                {(!runtimeTrusted || !view.runtime.legacyProcessTimezone || previewDates.length === 0) && <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-tertiary)]"><span>{tr('irrigationPolicy.legacyPreview', { defaultValue: 'Legacy 06:00 preview' })}: {tr('irrigationPolicy.unavailable', { defaultValue: 'unavailable' })}</span><ValveControlHelp label={tr('irrigationPolicy.conversionHelpLabel', { defaultValue: 'About conversion' })}>{tr('irrigationPolicy.previewUnavailable', { defaultValue: 'Legacy time preview unavailable until the gateway supplies fresh trusted process-time metadata.' })}</ValveControlHelp></div>}
                {view.pending.policyEdit && <p className="mt-2 text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.pendingEdit', { defaultValue: 'Pending policy edit' })}: {typeof view.pending.policyEdit.state === 'string' ? view.pending.policyEdit.state : tr('irrigationPolicy.pending', { defaultValue: 'queued' })}</p>}
                {view.pending.actions.length > 0 && <p className="mt-1 text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.pendingActions', { defaultValue: 'Pending actions' })}: {view.pending.actions.map(action => typeof action.state === 'string' ? action.state : 'queued').join(', ')}</p>}
                {actionFeedback && <p role="status" className="mt-1 text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.actionStatus', { defaultValue: 'Action status' })}: {actionFeedback.kind} · {actionFeedback.status}{actionFeedback.deviceEui ? ` · ${actionFeedback.deviceEui}` : ''}</p>}
              </section>

              <section className="mt-6 border-t border-[var(--border)] pt-5">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{tr('irrigationPolicy.conversionPreview', { defaultValue: 'Conversion preview' })}</h3>
                  <ValveControlHelp label={tr('irrigationPolicy.conversionHelpLabel', { defaultValue: 'About conversion' })}>
                    {tr('irrigationPolicy.conversionHelp', { defaultValue: 'The old 06:00 process-time run is shown in the policy timezone. Dendrometer hold or below-threshold days become skipped checks; they no longer water automatically.' })}
                    {currentCondition.kind === 'DENDRO' && ` ${tr('irrigationPolicy.dendroBehavior', { defaultValue: 'Response mode' })}: ${currentCondition.responseMode}.`}
                  </ValveControlHelp>
                </div>
                <p className="text-xs text-[var(--text-secondary)]">{tr('irrigationPolicy.newPolicyTimes', { defaultValue: 'New policy checks' })}: {newPolicyTimes || tr('irrigationPolicy.noNextCheck', { defaultValue: 'No next check is scheduled.' })}{policyTimezone ? ` · ${policyTimezone}` : ''}</p>
              </section>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <label className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--text-secondary)]"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{tr('irrigationPolicy.enabled', { defaultValue: 'Enabled' })}</label>
                <button type="button" disabled={!canSave} onClick={() => save()} className="min-h-11 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-[var(--on-primary)] disabled:cursor-not-allowed disabled:opacity-50">{saving ? tr('irrigationPolicy.saving', { defaultValue: 'Saving…' }) : tr('irrigationPolicy.save', { defaultValue: 'Save policy' })}</button>
                {view.policy && conditionalSchedules.length > 0 && <button type="button" disabled={saving || !canSave} onClick={() => save({ convertToAlways: true })} className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50">{tr('irrigationPolicy.convertToAlways', { defaultValue: 'Convert to Always' })}</button>}
                {view.policy && <button type="button" disabled={saving} onClick={pausePolicy} className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)] disabled:opacity-50">{tr('irrigationPolicy.pause', { defaultValue: 'Pause' })}</button>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default IrrigationPolicyEditor;
