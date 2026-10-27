import type {
  DendroStressThreshold,
  IrrigationPolicy,
  IrrigationPolicyCondition,
  IrrigationPolicyDeliverySetting,
  IrrigationPolicyExecution,
  IrrigationPolicyKind,
  IrrigationPolicyPending,
  IrrigationPolicyRuntime,
  IrrigationPolicyRuntimeValve,
  IrrigationPolicySchedule,
  IrrigationPolicySourceChoice,
  IrrigationPolicySourceRef,
  IrrigationPolicyView,
} from '../types/farming';

export const SWT_PRESETS = [
  { value: 20, key: 'wet' },
  { value: 30, key: 'moist' },
  { value: 50, key: 'dry' },
] as const;

export type PolicyConditionDraft =
  | { kind: 'SWT'; threshold: number | ''; sources: IrrigationPolicySourceRef[] }
  | { kind: 'VWC'; threshold: number | ''; sources: IrrigationPolicySourceRef[] }
  | { kind: 'DENDRO'; minimumStress: string; responseMode: string };

export interface PolicyScheduleDraft {
  scheduleUuid?: string | null;
  expectedSyncVersion?: number | null;
  deviceEui?: string;
  kind?: 'WEEKLY' | 'ONCE';
  weekdaysMask?: number | null;
  startTime?: string | null;
  fireAt?: string | null;
  durationMinutes?: number;
  timezone?: string | null;
  enabled?: boolean;
  execution?: IrrigationPolicyExecution | null;
  label?: string | null;
  detach?: boolean;
}

export interface PolicyEditDraft {
  policyUuid?: string | null;
  expectedPolicyVersion?: number | null;
  zoneUuid?: string | null;
  condition?: PolicyConditionDraft;
  timezone?: string | null;
  enabled?: boolean;
  observationWindowMinutes?: number;
  minIntervalMinutes?: number;
  maxDailyMinutes?: number;
  deliverySettings?: Record<string, { deliveryIntervalMinutes: number }>;
  schedules?: PolicyScheduleDraft[];
}

type AnyRecord = Record<string, unknown>;

const record = (value: unknown): AnyRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
);

const stringOrNull = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

const numberOrNull = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const stringOrNumberOrNull = (value: unknown): string | number | null => (
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null
);

const objectOrNull = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

function canonicalEui(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function sourceRef(value: unknown): IrrigationPolicySourceRef | null {
  const item = record(value);
  const deviceEui = canonicalEui(item.device_eui ?? item.deviceEui);
  const channel = String(item.channel ?? '').trim();
  return deviceEui && channel ? { deviceEui, channel } : null;
}

function sourceRefs(value: unknown): IrrigationPolicySourceRef[] {
  return Array.isArray(value) ? value.map(sourceRef).filter((item): item is IrrigationPolicySourceRef => item !== null) : [];
}

export function conditionDraftFromPolicy(value: unknown): PolicyConditionDraft {
  const condition = record(value);
  const kind = String(condition.kind ?? '').toUpperCase() as IrrigationPolicyKind;
  if (kind === 'VWC') {
    const threshold = condition.threshold_percent == null && condition.thresholdPercent == null
      ? ''
      : numberOrNull(condition.threshold_percent ?? condition.thresholdPercent);
    return { kind: 'VWC', threshold: threshold === null ? '' : threshold, sources: sourceRefs(condition.sources) };
  }
  if (kind === 'DENDRO') {
    return {
      kind: 'DENDRO',
      minimumStress: String(condition.minimum_stress ?? condition.minimumStress ?? 'moderate'),
      responseMode: String(condition.response_mode ?? condition.responseMode ?? 'fixed'),
    };
  }
  const threshold = numberOrNull(condition.threshold_kpa ?? condition.thresholdKpa);
  return { kind: 'SWT', threshold: threshold === null ? '' : threshold, sources: sourceRefs(condition.sources) };
}

export function buildCondition(draft: PolicyConditionDraft): Record<string, unknown> {
  if (draft.kind === 'VWC') {
    return {
      kind: 'VWC',
      threshold_percent: draft.threshold === '' ? null : draft.threshold,
      sources: draft.sources.map(source => ({ device_eui: canonicalEui(source.deviceEui), channel: source.channel })),
    };
  }
  if (draft.kind === 'DENDRO') {
    return { kind: 'DENDRO', minimum_stress: draft.minimumStress, response_mode: draft.responseMode };
  }
  return {
    kind: 'SWT',
    threshold_kpa: draft.threshold === '' ? null : draft.threshold,
    sources: draft.sources.map(source => ({ device_eui: canonicalEui(source.deviceEui), channel: source.channel })),
  };
}

function normaliseDeliverySettings(value: unknown): Record<string, IrrigationPolicyDeliverySetting> {
  const result: Record<string, IrrigationPolicyDeliverySetting> = {};
  for (const [rawEui, rawSetting] of Object.entries(record(value))) {
    const setting = record(rawSetting);
    const eui = canonicalEui(rawEui);
    const interval = Number(setting.delivery_interval_minutes ?? setting.deliveryIntervalMinutes);
    if (eui && Number.isInteger(interval)) result[eui] = { deliveryIntervalMinutes: interval };
  }
  return result;
}

function normaliseCondition(value: unknown): IrrigationPolicyCondition {
  const draft = conditionDraftFromPolicy(value);
  if (draft.kind === 'VWC') return { kind: 'VWC', thresholdPercent: draft.threshold === '' ? null : draft.threshold, sources: draft.sources };
  if (draft.kind === 'DENDRO') return { kind: 'DENDRO', minimumStress: draft.minimumStress as DendroStressThreshold, responseMode: draft.responseMode };
  return { kind: 'SWT', thresholdKpa: draft.threshold === '' ? null : draft.threshold, sources: draft.sources };
}

function normalisePolicy(value: unknown): IrrigationPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const item = record(value);
  const policyUuid = stringOrNull(item.policy_uuid ?? item.policyUuid);
  const zoneUuid = stringOrNull(item.zone_uuid ?? item.zoneUuid);
  if (!policyUuid || !zoneUuid) return null;
  const deliverySettings = normaliseDeliverySettings(item.delivery_settings ?? item.deliverySettings);
  return {
    policyUuid,
    zoneUuid,
    condition: normaliseCondition(item.condition),
    timezone: stringOrNull(item.timezone),
    enabled: item.enabled !== false && Number(item.enabled) !== 0,
    observationWindowMinutes: Number(item.observation_window_minutes ?? item.observationWindowMinutes ?? 60),
    minIntervalMinutes: Number(item.min_interval_minutes ?? item.minIntervalMinutes ?? 60),
    maxDailyMinutes: Number(item.max_daily_minutes ?? item.maxDailyMinutes ?? 240),
    deliverySettings,
    effectiveFrom: stringOrNull(item.effective_from ?? item.effectiveFrom),
    syncVersion: Number(item.sync_version ?? item.syncVersion ?? 0),
    createdAt: stringOrNull(item.created_at ?? item.createdAt),
    updatedAt: stringOrNull(item.updated_at ?? item.updatedAt),
  };
}

function normaliseSchedule(value: unknown): IrrigationPolicySchedule | null {
  const item = record(value);
  const scheduleUuid = stringOrNull(item.schedule_uuid ?? item.scheduleUuid);
  const deviceEui = canonicalEui(item.device_eui ?? item.deviceEui);
  if (!scheduleUuid || !deviceEui) return null;
  const kind = String(item.kind ?? 'WEEKLY').toUpperCase() === 'ONCE' ? 'ONCE' : 'WEEKLY';
  const conditionPolicyUuid = stringOrNull(item.condition_policy_uuid ?? item.conditionPolicyUuid);
  const rawExecution = String(item.execution ?? '').toLowerCase();
  const execution: IrrigationPolicyExecution | null = rawExecution === 'always' || rawExecution === 'conditional'
    ? rawExecution
    : conditionPolicyUuid ? 'conditional' : null;
  return {
    scheduleUuid,
    expectedSyncVersion: item.expected_sync_version == null ? null : Number(item.expected_sync_version),
    syncVersion: item.sync_version == null ? null : Number(item.sync_version),
    deviceEui,
    kind,
    weekdaysMask: item.weekdays_mask == null && item.weekdaysMask == null ? null : Number(item.weekdays_mask ?? item.weekdaysMask),
    startTime: stringOrNull(item.start_time ?? item.startTime),
    fireAt: stringOrNull(item.fire_at ?? item.fireAt),
    durationMinutes: Number(item.duration_minutes ?? item.durationMinutes ?? 0),
    timezone: stringOrNull(item.timezone),
    enabled: item.enabled !== false && Number(item.enabled) !== 0,
    execution,
    label: item.label == null ? null : String(item.label),
    conditionPolicyUuid,
    effectiveFrom: stringOrNull(item.effective_from ?? item.effectiveFrom),
    deletedAt: stringOrNull(item.deleted_at ?? item.deletedAt),
  };
}

function normaliseChoice(value: unknown): IrrigationPolicySourceChoice | null {
  const item = record(value);
  const kind = String(item.kind ?? '').toUpperCase() as IrrigationPolicyKind;
  if (!['SWT', 'VWC', 'DENDRO'].includes(kind)) return null;
  if (kind === 'DENDRO') {
    return {
      kind,
      eligible: item.eligible === true,
      state: stringOrNull(item.state),
      reason: stringOrNull(item.reason),
      name: stringOrNull(item.name ?? item.device_name ?? item.deviceName),
      depthCm: numberOrNull(item.depth_cm ?? item.depthCm),
      sources: sourceRefs(item.sources),
    };
  }
  const source = sourceRef(item);
  if (!source) return null;
  return {
    ...source,
    kind: kind === 'VWC' ? 'VWC' : 'SWT',
    typeId: stringOrNull(item.type_id ?? item.typeId),
    eligible: item.eligible === true,
    reason: stringOrNull(item.reason),
    name: stringOrNull(item.name ?? item.device_name ?? item.deviceName),
    depthCm: numberOrNull(item.depth_cm ?? item.depthCm),
  };
}

function normaliseRuntime(value: unknown, root: AnyRecord): IrrigationPolicyRuntime {
  const runtime = record(value);
  const sourceChoicesValue = runtime.source_choices ?? runtime.sourceChoices ?? root.source_choices ?? root.sourceChoices;
  const sourceChoices: Record<IrrigationPolicyKind, IrrigationPolicySourceChoice[]> = { SWT: [], VWC: [], DENDRO: [] };
  for (const kind of ['SWT', 'VWC', 'DENDRO'] as const) {
    const list = record(sourceChoicesValue)[kind] ?? record(sourceChoicesValue)[kind.toLowerCase()];
    sourceChoices[kind] = Array.isArray(list) ? list.map(normaliseChoice).filter((item): item is IrrigationPolicySourceChoice => item !== null) : [];
  }
  const eligibleRaw = runtime.eligible_sources ?? runtime.eligibleSources ?? root.eligible_sources ?? root.eligibleSources;
  const valvesRaw = runtime.valves ?? root.valves;
  const valves: IrrigationPolicyRuntimeValve[] = Array.isArray(valvesRaw)
    ? valvesRaw.map(item => {
      const value = record(item);
      const control = record(value.control);
      const rawUpdate = objectOrNull(value.update)
        ?? objectOrNull(value.readiness)
        ?? objectOrNull(control.readiness);
      const rawIncident = objectOrNull(value.incident) ?? objectOrNull(control.incident);
      const rawClock = objectOrNull(value.clock) ?? objectOrNull(control.clock);
      const localSnapshot = Object.prototype.hasOwnProperty.call(value, 'control')
        || Object.prototype.hasOwnProperty.call(value, 'readiness');
      const incident = rawIncident ? {
        ...rawIncident,
        retry_pending: rawIncident.retry_pending === true || rawIncident.retry_revision != null,
      } : null;
      return {
        ...value,
        deviceEui: canonicalEui(value.device_eui ?? value.deviceEui),
        availability: stringOrNull(value.availability ?? control.availability)
          ?? (localSnapshot ? 'fresh' : null),
        update: rawUpdate ? {
          state: String(rawUpdate.state ?? 'UNKNOWN'),
          ready: rawUpdate.ready === true,
          reason: stringOrNull(rawUpdate.reason),
        } : null,
        incident,
        clock: rawClock,
      };
    }).filter(item => item.deviceEui)
    : [];
  const clock = runtime.clock && typeof runtime.clock === 'object' ? runtime.clock as IrrigationPolicyRuntime['clock'] : null;
  return {
    availability: String(runtime.availability ?? root.availability ?? 'unavailable') as IrrigationPolicyRuntime['availability'],
    projectionRevision: stringOrNumberOrNull(runtime.projection_revision ?? runtime.projectionRevision),
    asOf: stringOrNull(runtime.as_of ?? runtime.asOf),
    validUntil: stringOrNull(runtime.valid_until ?? runtime.validUntil),
    clock,
    eligibleSources: Array.isArray(eligibleRaw) ? eligibleRaw.map(normaliseChoice).filter((item): item is IrrigationPolicySourceChoice => item !== null) : [],
    sourceChoices,
    qualification: objectOrNull(runtime.qualification) ?? objectOrNull(root.qualification),
    valves,
    nextCheck: stringOrNull(runtime.next_check ?? runtime.nextCheck ?? root.next_check ?? root.nextCheck),
    lastResult: objectOrNull(runtime.last_result) ?? objectOrNull(root.last_result),
    legacyProcessTimezone: stringOrNull(runtime.legacy_process_timezone ?? runtime.legacyProcessTimezone ?? root.legacy_process_timezone ?? root.legacyProcessTimezone),
    // R17-M1 / D18: the VWC gate is off unless the gateway reports it on (absent = off).
    vwcConditionEnabled: (runtime.vwc_condition_enabled ?? runtime.vwcConditionEnabled ?? root.vwc_condition_enabled ?? root.vwcConditionEnabled) === true,
    inactiveReason: stringOrNull(runtime.inactive_reason ?? runtime.inactiveReason ?? root.inactive_reason ?? root.inactiveReason),
  };
}

export function normalisePolicyView(value: unknown): IrrigationPolicyView {
  const root = record(value);
  const zoneRaw = record(root.zone);
  const schedulesRaw = Array.isArray(root.schedules) ? root.schedules : [];
  const schedules = schedulesRaw.map(normaliseSchedule).filter((item): item is IrrigationPolicySchedule => item !== null);
  const pendingRaw = record(root.pending);
  const pending: IrrigationPolicyPending = {
    policyEdit: objectOrNull(pendingRaw.policy_edit ?? pendingRaw.policyEdit),
    actions: Array.isArray(pendingRaw.actions) ? pendingRaw.actions.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [],
  };
  return {
    zone: {
      id: zoneRaw.id == null ? null : Number(zoneRaw.id),
      zoneUuid: stringOrNull(zoneRaw.zone_uuid ?? zoneRaw.zoneUuid),
      name: String(zoneRaw.name ?? ''),
      timezone: stringOrNull(zoneRaw.timezone),
    },
    policy: normalisePolicy(root.policy),
    schedules,
    pending,
    runtime: normaliseRuntime(root.runtime, root),
  };
}

function conditionPayload(condition: PolicyConditionDraft): Record<string, unknown> {
  return buildCondition(condition);
}

function schedulePayload(schedule: PolicyScheduleDraft): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (schedule.scheduleUuid !== undefined) result.schedule_uuid = schedule.scheduleUuid;
  if (schedule.expectedSyncVersion !== undefined) result.expected_sync_version = schedule.expectedSyncVersion;
  if (schedule.deviceEui !== undefined) result.device_eui = canonicalEui(schedule.deviceEui);
  if (schedule.kind !== undefined) result.kind = schedule.kind;
  if (schedule.weekdaysMask !== undefined) result.weekdays_mask = schedule.weekdaysMask;
  if (schedule.startTime !== undefined) result.start_time = schedule.startTime;
  if (schedule.fireAt !== undefined) result.fire_at = schedule.fireAt;
  if (schedule.durationMinutes !== undefined) result.duration_minutes = schedule.durationMinutes;
  if (schedule.timezone !== undefined) result.timezone = schedule.timezone;
  if (schedule.enabled !== undefined) result.enabled = schedule.enabled;
  if (schedule.execution !== undefined) result.execution = schedule.execution;
  if (schedule.label !== undefined) result.label = schedule.label;
  if (schedule.detach !== undefined) result.detach = schedule.detach;
  return result;
}

export function toPolicyPayload(draft: PolicyEditDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    policy_uuid: draft.policyUuid ?? null,
    expected_policy_version: draft.expectedPolicyVersion ?? null,
    zone_uuid: draft.zoneUuid ?? null,
  };
  if (draft.condition !== undefined) payload.condition = conditionPayload(draft.condition);
  if (draft.timezone !== undefined) payload.timezone = draft.timezone;
  if (draft.enabled !== undefined) payload.enabled = draft.enabled;
  if (draft.observationWindowMinutes !== undefined) payload.observation_window_minutes = draft.observationWindowMinutes;
  if (draft.minIntervalMinutes !== undefined) payload.min_interval_minutes = draft.minIntervalMinutes;
  if (draft.maxDailyMinutes !== undefined) payload.max_daily_minutes = draft.maxDailyMinutes;
  if (draft.deliverySettings !== undefined) {
    payload.delivery_settings = Object.fromEntries(Object.entries(draft.deliverySettings).map(([eui, setting]) => [
      canonicalEui(eui), { delivery_interval_minutes: setting.deliveryIntervalMinutes },
    ]));
  }
  if (draft.schedules !== undefined) payload.schedules = draft.schedules.map(schedulePayload);
  return payload;
}

export function isConditionalSchedule(schedule: Pick<IrrigationPolicySchedule, 'kind' | 'execution' | 'conditionPolicyUuid'> | Partial<PolicyScheduleDraft>): boolean {
  const item = schedule as Record<string, unknown>;
  const kind = String(item.kind ?? '').toUpperCase();
  const execution = String(item.execution ?? '').toLowerCase();
  const policyUuid = item.conditionPolicyUuid ?? item.condition_policy_uuid;
  return kind === 'WEEKLY' && execution === 'conditional' && typeof policyUuid === 'string' && policyUuid.trim().length > 0;
}

function zoneOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return (asIfUtc - instant.getTime()) / 60_000;
}

function localWallTimeToIso(date: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  try {
    const firstOffset = zoneOffsetMinutes(timeZone, new Date(naiveUtc));
    const firstCandidate = naiveUtc - firstOffset * 60_000;
    const secondOffset = zoneOffsetMinutes(timeZone, new Date(firstCandidate));
    return new Date(naiveUtc - (secondOffset === firstOffset ? firstOffset : secondOffset) * 60_000).toISOString();
  } catch {
    return null;
  }
}

export interface LegacySixAmPreview {
  instant: string;
  legacyTime: '06:00';
  zoneDate: string;
  zoneTime: string;
}

/** Translate the legacy process-time 06:00 trigger into the policy timezone. */
export function legacySixAmPreview(
  date: string,
  legacyProcessTimezone: string | null | undefined,
  policyTimezone: string | null | undefined,
): LegacySixAmPreview | null {
  if (!legacyProcessTimezone || !policyTimezone) return null;
  const instant = localWallTimeToIso(date, '06:00', legacyProcessTimezone);
  if (!instant) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: policyTimezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(instant)).reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return {
      instant,
      legacyTime: '06:00',
      zoneDate: `${parts.year}-${parts.month}-${parts.day}`,
      zoneTime: `${parts.hour}:${parts.minute}`,
    };
  } catch {
    return null;
  }
}
