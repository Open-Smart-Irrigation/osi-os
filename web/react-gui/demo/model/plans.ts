export type ValvePlan = {
  schedule_uuid: string;
  device_eui: string;
  kind: 'WEEKLY' | 'ONCE';
  label: string | null;
  weekdays_mask: number | null;
  start_time: string | null;
  fire_at: string | null;
  duration_minutes: number;
  timezone: string;
  enabled: boolean;
  once_state: 'PENDING' | 'FIRED' | 'SKIPPED' | null;
  dispatch_state: 'PENDING' | 'ATTEMPTED' | 'SENT' | 'UNKNOWN' | 'SKIPPED' | null;
  dispatch_command_id: string | null;
  dispatch_created_at: string | null;
  dispatch_attempted_at: string | null;
  deleted_at: string | null;
  generation: number;
};

export type PlanError = {code: string; weekday?: number | null; conflicts?: string[]; labels?: Array<string | null>; count?: number};
export type CompiledWindow = {onH: number; onM: number; offH: number; offM: number; scheduleUuid: string; label: string | null; startMin: number; endMin: number};
export type CompiledPlans = {days: CompiledWindow[][]; errors: PlanError[]};
type PlanPushLedgerRow = {purpose: 'WEEKDAY_PLAN' | 'DAYMASK_PLAN' | 'CLOCK_SYNC' | 'SCHEDULER_STATUS'; weekday: number | null; daymask: number | null; plan_hash: string | null; state: 'QUEUED' | 'ACKED' | 'SUPERSEDED'; queued_at: string; acked_at: string | null; generation: number};

export function parseHHMM(value: unknown): {h: number; m: number} | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? {h: Number(match[1]), m: Number(match[2])} : null;
}

export function validatePlan(body: Record<string, unknown>): {ok: true; value: Partial<ValvePlan>} | {ok: false; status: number; error: string; message: string} {
  const kind = String(body.kind ?? '').toUpperCase();
  const duration = Number(body.duration_minutes);
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') return {ok: false, status: 422, error: 'invalid_label', message: 'label must be a string'};
  const label = body.label == null ? null : String(body.label).slice(0, 80);
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  if (kind === 'WEEKLY') {
    const mask = Number(body.weekdays_mask);
    if (!Number.isInteger(mask) || mask < 1 || mask > 127) return {ok: false, status: 422, error: 'invalid_weekdays', message: 'weekdays_mask must be 1..127'};
    const hm = parseHHMM(body.start_time);
    if (!hm) return {ok: false, status: 422, error: 'invalid_start_time', message: 'start_time must be HH:MM'};
    if (!Number.isInteger(duration) || duration < 1 || duration > 1439) return {ok: false, status: 422, error: 'invalid_duration', message: 'duration_minutes must be 1..1439'};
    return {ok: true, value: {kind, weekdays_mask: mask, start_time: `${String(hm.h).padStart(2, '0')}:${String(hm.m).padStart(2, '0')}`, fire_at: null, duration_minutes: duration, label, enabled, once_state: null}};
  }
  if (kind === 'ONCE') {
    if (typeof body.fire_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(body.fire_at) || !Number.isFinite(Date.parse(body.fire_at))) return {ok: false, status: 422, error: 'invalid_fire_at', message: 'fire_at must be an ISO instant'};
    if (!Number.isInteger(duration) || duration < 1 || duration > 255) return {ok: false, status: 422, error: 'invalid_duration', message: 'duration_minutes must be 1..255 for one-time opens'};
    return {ok: true, value: {kind, weekdays_mask: null, start_time: null, fire_at: new Date(Date.parse(body.fire_at)).toISOString(), duration_minutes: duration, label, enabled, once_state: 'PENDING', dispatch_state: null}};
  }
  return {ok: false, status: 422, error: 'invalid_kind', message: 'kind must be WEEKLY or ONCE'};
}

export function compilePlans(plans: ValvePlan[]): CompiledPlans {
  const days: CompiledWindow[][] = Array.from({length: 7}, () => []);
  const errors: PlanError[] = [];
  for (const plan of plans) {
    if (plan.kind !== 'WEEKLY' || !plan.enabled || plan.deleted_at) continue;
    const hm = parseHHMM(plan.start_time);
    if (!hm) { errors.push({code: 'invalid_start_time', weekday: null, conflicts: [plan.schedule_uuid]}); continue; }
    const startMin = hm.h * 60 + hm.m;
    const endMin = startMin + plan.duration_minutes;
    const end = endMin % 1440;
    const window = {onH: hm.h, onM: hm.m, offH: Math.floor(end / 60), offM: end % 60, scheduleUuid: plan.schedule_uuid, label: plan.label, startMin, endMin};
    for (let day = 0; day < 7; day++) if (((plan.weekdays_mask ?? 0) >> day) & 1) days[day]!.push({...window});
  }
  for (let day = 0; day < 7; day++) {
    const windows = days[day]!;
    windows.sort((a, b) => a.startMin - b.startMin);
    if (windows.length > 4) errors.push({code: 'too_many_windows', weekday: day, count: windows.length, conflicts: windows.map(window => window.scheduleUuid)});
    for (let index = 1; index < windows.length; index++) if (windows[index]!.startMin < windows[index - 1]!.endMin) {
      errors.push({code: 'overlap', weekday: day, conflicts: [windows[index - 1]!.scheduleUuid, windows[index]!.scheduleUuid]});
    }
  }
  for (let day = 0; day < 7; day++) {
    const previous = days[(day + 6) % 7]!;
    for (const spill of previous) if (spill.endMin > 1440) {
      for (const current of days[day]!) if (current.startMin < spill.endMin - 1440) errors.push({code: 'overlap', weekday: day, conflicts: [spill.scheduleUuid, current.scheduleUuid]});
    }
  }
  return {days, errors};
}

const weekdays: Record<string, number> = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};
export function localParts(at: number, timezone: string) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}); }
  catch (error) { if (!(error instanceof RangeError)) throw error; formatter = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}); }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return {year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), weekday: weekdays[parts.weekday!]!};
}
function offsetMinutes(at: number, timezone: string) {
  const p = localParts(at, timezone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at) / 60000);
}
export function resolveLocalInstant(y: number, mo: number, d: number, h: number, m: number, timezone: string): number {
  const wanted = h * 60 + m;
  const roundTrips = (candidate: number) => { const p = localParts(candidate, timezone); return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === m; };
  const naive = Date.UTC(y, mo - 1, d, h, m);
  const offset = offsetMinutes(Date.UTC(y, mo - 1, d, 12), timezone);
  const first = naive - offset * 60000;
  if (roundTrips(first)) return first;
  const second = naive - offsetMinutes(first, timezone) * 60000;
  if (roundTrips(second)) return second;
  for (let probe = Math.min(first, second), n = 0; n < 120; n++, probe += 60000) {
    const p = localParts(probe, timezone);
    if (p.year > y || p.year === y && (p.month > mo || p.month === mo && (p.day > d || p.day === d && p.hour * 60 + p.minute >= wanted))) return probe;
  }
  return second;
}
function nextLocalMidnight(from: number, timezone: string): number {
  const current = localParts(from, timezone);
  const tomorrow = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return resolveLocalInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 0, 0, timezone);
}

export function rescheduleSkipTodayRollover(host: PlanDomainPort, eui: string) {
  const runtime = host.planRuntime(eui), entity = `skip-today:${eui}`;
  const generation = host.clock.invalidate(entity);
  if (runtime.schedulerStatus !== 'SKIP_TODAY' || !runtime.skipTodayDate) return;
  const valve = host.devices.find(device => device.deveui === eui);
  if (!valve) return;
  const timezone = host.zones.find(zone => zone.id === valve.irrigation_zone_id)?.timezone ?? host.state.settings.gatewayTimezone ?? 'UTC';
  if (localDate(host.now(), timezone) > runtime.skipTodayDate) {
    runtime.schedulerStatus = 'ACTIVE'; runtime.skipTodayDate = null;
    return;
  }
  const at = nextLocalMidnight(host.now(), timezone);
  host.clock.schedule(at, () => {
    const current = host.planRuntime(eui);
    if (current.schedulerStatus !== 'SKIP_TODAY' || !current.skipTodayDate) return;
    const liveValve = host.devices.find(device => device.deveui === eui);
    if (!liveValve) return;
    const liveTimezone = host.zones.find(zone => zone.id === liveValve.irrigation_zone_id)?.timezone ?? host.state.settings.gatewayTimezone ?? 'UTC';
    if (localDate(host.now(), liveTimezone) > current.skipTodayDate) {
      current.schedulerStatus = 'ACTIVE'; current.skipTodayDate = null;
      return;
    }
    rescheduleSkipTodayRollover(host, eui);
  }, {id: `skip-today-rollover:${eui}:${at}:${generation}`, meaningful: true, priority: 5, entity, generation});
}
export function nextLocalOccurrence(from: number, timezone: string, weekday: number, hour: number, minute: number): number | null {
  const current = localParts(from, timezone);
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(current.year, current.month - 1, current.day + offset));
    if (day.getUTCDay() !== weekday) continue;
    const candidate = resolveLocalInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timezone);
    if (candidate >= from) return candidate;
  }
  return null;
}

export function nextPlanRun(plans: ValvePlan[], now: number, fallbackTimezone: string) {
  let best: {atDate: number; at: string; kind: ValvePlan['kind']; minutes: number; scheduleUuid: string} | null = null;
  for (const plan of plans) {
    if (!plan.enabled || plan.deleted_at) continue;
    let at: number | null = null;
    if (plan.kind === 'ONCE') {
      const due = Date.parse(plan.fire_at ?? '');
      if (plan.once_state === 'PENDING' && Number.isFinite(due) && due >= now) at = due;
    } else {
      const hm = parseHHMM(plan.start_time);
      if (!hm) continue;
      const timezone = plan.timezone || fallbackTimezone || 'UTC';
      for (let day = 0; day < 7; day++) if (((plan.weekdays_mask ?? 0) >> day) & 1) {
        const candidate = nextLocalOccurrence(now, timezone, day, hm.h, hm.m);
        if (candidate !== null && (at === null || candidate < at)) at = candidate;
      }
    }
    if (at !== null && (!best || at < best.atDate)) best = {atDate: at, at: new Date(at).toISOString(), kind: plan.kind, minutes: plan.duration_minutes, scheduleUuid: plan.schedule_uuid};
  }
  if (!best) return null;
  const {atDate: _atDate, ...result} = best;
  return result;
}

export function localDate(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function recordSkippedPlan(host: PlanDomainPort, plan: ValvePlan, reason: string) {
  const valve = host.devices.find(device => device.deveui === plan.device_eui);
  if (!valve) return;
  const id = `demo-plan-skip:${plan.schedule_uuid}:${host.now()}`;
  host.outcomes.unshift({expectationId: id, deviceEui: valve.deveui, deviceName: valve.name,
    zoneId: valve.irrigation_zone_id ?? null, zoneName: host.zones.find(zone => zone.id === valve.irrigation_zone_id)?.name ?? null,
    commandId: id, commandedAt: iso(host.now()), commandedDurationSeconds: plan.duration_minutes * 60,
    expectedCloseAt: iso(host.now()), observedOpenAt: null, observedCloseAt: null, estimatedGrossLiters: 0,
    flowRateLpm: null, reconciliationState: 'CANCELLED', cancelReason: reason, trigger: 'on_valve_schedule',
    commandResult: null, commandResultDetail: `SKIPPED:${reason}`, commandAppliedAt: null, status: 'CANCELLED'});
}

function compiledWeeklyEnd(plan: ValvePlan, timezone: string, startAt: number): number {
  const hm = parseHHMM(plan.start_time);
  if (!hm) return startAt + plan.duration_minutes * 60_000;
  const local = localParts(startAt, timezone);
  const wallEnd = new Date(Date.UTC(local.year, local.month - 1, local.day, hm.h, hm.m + plan.duration_minutes));
  return resolveLocalInstant(wallEnd.getUTCFullYear(), wallEnd.getUTCMonth() + 1, wallEnd.getUTCDate(), wallEnd.getUTCHours(), wallEnd.getUTCMinutes(), timezone);
}

export function scheduleValvePlan(host: PlanDomainPort, plan: ValvePlan) {
  const entity = `plan:${plan.schedule_uuid}`;
  const generation = host.clock.invalidate(entity);
  if (!plan.enabled || plan.deleted_at) return;
  if (plan.kind === 'ONCE' && plan.once_state !== 'PENDING') return;
  const timezone = plan.timezone || host.state.settings.gatewayTimezone || 'UTC';
  let at: number | null = null;
  if (plan.kind === 'ONCE') at = Date.parse(plan.fire_at ?? '');
  else {
    const next = nextPlanRun([plan], host.now() + 1, timezone);
    at = next ? Date.parse(next.at) : null;
  }
  if (plan.kind === 'ONCE' && at !== null && at < host.now()) {
    if (host.now() - at > 10 * 60_000) {
      plan.once_state = 'SKIPPED'; plan.dispatch_state = 'SKIPPED'; plan.dispatch_command_id = `missed:${plan.schedule_uuid}`;
      plan.dispatch_created_at = iso(host.now()); plan.dispatch_attempted_at = null;
      recordSkippedPlan(host, plan, 'one_time_missed');
      return;
    }
    at = host.now();
  }
  if (at === null || !Number.isFinite(at) || at < host.now()) return;
  host.clock.schedule(at, () => {
    const current = planRows(host, plan.device_eui).find(row => row.schedule_uuid === plan.schedule_uuid);
    if (!current || !current.enabled || current.deleted_at || current.generation !== plan.generation) return;
    if (current.kind === 'ONCE') {
      if (current.once_state !== 'PENDING') return;
      if (host.now() - Date.parse(current.fire_at ?? '') > 10 * 60_000) {
        current.once_state = 'SKIPPED'; current.dispatch_state = 'SKIPPED'; current.dispatch_command_id = `missed:${current.schedule_uuid}`;
        current.dispatch_created_at = iso(host.now()); current.dispatch_attempted_at = null; recordSkippedPlan(host, current, 'one_time_missed'); return;
      }
      if (host.startActuation(current.device_eui, current.duration_minutes * 60, 'on_valve_schedule', 2000, true, current.schedule_uuid)) {
        current.once_state = 'FIRED'; current.dispatch_state = 'SENT'; current.dispatch_command_id = `once:${current.schedule_uuid}`;
        current.dispatch_created_at = iso(host.now()); current.dispatch_attempted_at = iso(host.now());
      } else {
        current.once_state = 'SKIPPED'; current.dispatch_state = 'SKIPPED'; current.dispatch_command_id = `skipped:busy:${current.schedule_uuid}`;
        current.dispatch_created_at = iso(host.now()); current.dispatch_attempted_at = null; recordSkippedPlan(host, current, 'busy');
      }
      return;
    }
    const runtime = host.planRuntime(current.device_eui);
    const weekday = localParts(host.now(), timezone).weekday;
    const valve = host.devices.find(device => device.deveui === current.device_eui);
    const statusTimezone = host.zones.find(zone => zone.id === valve?.irrigation_zone_id)?.timezone ?? host.state.settings.gatewayTimezone ?? 'UTC';
    const today = localDate(host.now(), statusTimezone);
    if (runtime.schedulerStatus === 'DEACTIVATED' || runtime.schedulerStatus === 'SKIP_TODAY' && runtime.skipTodayDate === today) {
      recordSkippedPlan(host, current, 'scheduler_inactive');
    } else if (runtime.deliveredGenerationByDay[weekday]! < runtime.planGenerationByDay[weekday]!) {
      recordSkippedPlan(host, current, 'plan_not_delivered');
    } else {
      const closeAt = compiledWeeklyEnd(current, timezone, host.now());
      const durationSeconds = Math.max(0, (closeAt - host.now()) / 1000);
      if (!host.startActuation(current.device_eui, durationSeconds, 'on_valve_schedule', 0, false, current.schedule_uuid)) recordSkippedPlan(host, current, 'busy');
      else {
        const command = host.state.activeCommands.get(current.device_eui)!;
        host.clock.schedule(closeAt, () => {
          if (host.state.activeCommands.get(current.device_eui)?.expectation_id === command.expectation_id) host.close('COMPLETED', current.device_eui);
        }, {id: `weekly-close:${current.schedule_uuid}:${closeAt}`, priority: 1, meaningful: true,
          entity: `actuation:${current.device_eui}`, generation: command.generation});
      }
    }
    scheduleValvePlan(host, current);
  }, {id: `plan-start:${plan.schedule_uuid}:${at}:${generation}`, priority: 6, meaningful: true, entity, generation});
}

export type PlanRouteHost = {
  planSnapshot(eui: string): unknown;
  createPlan(eui: string, body: Record<string, unknown>): unknown;
  updatePlan(eui: string, scheduleId: string, body: Record<string, unknown>): unknown;
  deletePlan(eui: string, scheduleId: string): unknown;
  resendPlan(eui: string): unknown;
  setSchedulerStatus(eui: string, status: unknown): unknown;
};

export type PlanDomainPort = {
  state: SimulatorState;
  clock: SimulationClock;
  now(): number;
  devices: Device[];
  zones: IrrigationZone[];
  fail(status?: number, code?: string, data?: unknown): never;
  outcomes: IrrigationActuation[];
  startActuation(eui: string, duration: number, trigger: IrrigationActuation['trigger'], openDelayMs: number, autoClose: boolean, planId?: string): boolean;
  close(status: 'COMPLETED' | 'CANCELLED', eui: string): void;
  planRuntime(eui: string): NonNullable<ReturnType<SimulatorState['valveSettings']['get']>>;
  planSnapshot(eui: string): {schedules: Array<Record<string, unknown>>} & Record<string, unknown>;
};

function sha1(value: string): string {
  const bytes = Array.from(new TextEncoder().encode(value));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000), low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const rotate = (word: number, bits: number) => (word << bits) | (word >>> (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(80);
    for (let i = 0; i < 16; i++) words[i] = ((bytes[offset + i * 4]! << 24) | (bytes[offset + i * 4 + 1]! << 16) | (bytes[offset + i * 4 + 2]! << 8) | bytes[offset + i * 4 + 3]!) >>> 0;
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rotate(a, 5) + f + e + k + words[i]!) >>> 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(word => word.toString(16).padStart(8, '0')).join('');
}

function compiledDayHash(windows: CompiledWindow[]): string {
  const canonical = windows.map(window => [window.onH, window.onM, window.offH, window.offM].join(':')).sort().join('|');
  return sha1(canonical);
}

function daysInMask(mask: number): number[] {
  if (mask === 0x80) return Array.from({length: 7}, (_, day) => day);
  return Array.from({length: 7}, (_, day) => day).filter(day => (mask & (1 << day)) !== 0);
}

function currentPlanPushSlots(runtime: NonNullable<ReturnType<SimulatorState['valveSettings']['get']>>) {
  const slots = new Map<string, {hash: string; state: 'QUEUED' | 'ACKED'}>();
  for (const row of [...runtime.planPushes].reverse()) {
    if ((row.state !== 'QUEUED' && row.state !== 'ACKED') || !row.plan_hash) continue;
    if (row.purpose === 'WEEKDAY_PLAN' && row.weekday !== null) {
      const key = `WEEKDAY_PLAN:${row.weekday}`;
      if (!slots.has(key)) slots.set(key, {hash: row.plan_hash, state: row.state});
    } else if (row.purpose === 'DAYMASK_PLAN' && row.daymask !== null) {
      for (const weekday of daysInMask(row.daymask)) {
        const key = `GEN2DAY:${weekday}`;
        if (!slots.has(key)) slots.set(key, {hash: row.plan_hash, state: row.state});
      }
    }
  }
  return slots;
}

function currentPushHashes(runtime: NonNullable<ReturnType<SimulatorState['valveSettings']['get']>>) {
  const hashes: Record<string, string> = {};
  for (const [key, slot] of currentPlanPushSlots(runtime)) hashes[key] = slot.hash;
  return hashes;
}

function planPushesToQueue(generation: string, compiled: CompiledWindow[][], hashes: Record<string, string>, force: boolean) {
  if (generation === 'GEN2') {
    const groups = new Map<string, {daymask: number; windows: CompiledWindow[]}>();
    compiled.forEach((windows, weekday) => {
      const hash = compiledDayHash(windows), group = groups.get(hash) ?? {daymask: 0, windows: windows.slice()};
      group.daymask |= 1 << weekday; groups.set(hash, group);
    });
    return [...groups.entries()].flatMap(([hash, group]) => {
      const weekdays = group.daymask === 0x7f ? [0, 1, 2, 3, 4, 5, 6] : Array.from({length: 7}, (_, day) => day).filter(day => (group.daymask & (1 << day)) !== 0);
      if (!force && weekdays.every(day => hashes[`GEN2DAY:${day}`] === hash)) return [];
      return [{purpose: 'DAYMASK_PLAN' as const, weekday: null, daymask: group.daymask === 0x7f ? 0x80 : group.daymask, plan_hash: hash}];
    });
  }
  return compiled.flatMap((windows, weekday) => {
    const hash = compiledDayHash(windows);
    return !force && hashes[`WEEKDAY_PLAN:${weekday}`] === hash ? [] : [{purpose: 'WEEKDAY_PLAN' as const, weekday, daymask: null, plan_hash: hash}];
  });
}

function latestPlanPushRows(runtime: NonNullable<ReturnType<SimulatorState['valveSettings']['get']>>) {
  return runtime.planPushes.filter(row => (row.purpose === 'WEEKDAY_PLAN' || row.purpose === 'DAYMASK_PLAN') && row.state !== 'SUPERSEDED').slice().reverse()
    .map(({purpose, weekday, daymask, state, plan_hash, queued_at, acked_at}) => ({purpose, weekday, daymask, state, plan_hash, queued_at, acked_at, error: null}));
}

export function planPushSummary(runtime: NonNullable<ReturnType<SimulatorState['valveSettings']['get']>>) {
  const states = new Map<number, string>();
  for (const row of runtime.planPushes.slice().reverse()) {
    if (row.state === 'SUPERSEDED') continue;
    if (row.purpose === 'WEEKDAY_PLAN' && row.weekday !== null && !states.has(row.weekday)) states.set(row.weekday, row.state);
    if (row.purpose === 'DAYMASK_PLAN' && row.daymask !== null) for (const day of daysInMask(row.daymask)) if (!states.has(day)) states.set(day, row.state);
  }
  return {queued: [...states.values()].filter(state => state === 'QUEUED').length,
    acked: [...states.values()].filter(state => state === 'ACKED').length, failed: 0,
    last_plan_queued_at: runtime.lastPlanQueuedAt, last_plan_acked_at: runtime.lastPlanAckedAt};
}

export function queuePlanDelivery(host: PlanDomainPort, eui: string, force = false): number {
  const runtime = host.planRuntime(eui);
  const valve = host.devices.find(device => device.deveui === eui)!;
  const generationName = String((valve as Device & {strega_generation?: string}).strega_generation ?? 'GEN1');
  const current = compilePlans(planRows(host, eui).filter(plan => !plan.deleted_at));
  const currentSlots = currentPlanPushSlots(runtime);
  const pushes = planPushesToQueue(generationName, current.days, currentPushHashes(runtime), force);
  const needsClock = force || !runtime.clockSyncQueued;
  const planGeneration = ++runtime.planGeneration;
  const nowIso = new Date(host.now()).toISOString();
  const pendingRows: PlanPushLedgerRow[] = pushes.map(push => ({...push, state: 'QUEUED', queued_at: nowIso, acked_at: null, generation: planGeneration}));
  const touchedDays = new Set<number>();
  for (const push of pushes) {
    if (push.purpose === 'WEEKDAY_PLAN' && push.weekday !== null) touchedDays.add(push.weekday);
    if (push.purpose === 'DAYMASK_PLAN' && push.daymask !== null) {
      for (const day of daysInMask(push.daymask)) touchedDays.add(day);
    }
  }
  for (const day of touchedDays) runtime.planGenerationByDay[day] = planGeneration;
  for (let day = 0; day < 7; day++) {
    if (touchedDays.has(day)) continue;
    const key = generationName === 'GEN2' ? `GEN2DAY:${day}` : `WEEKDAY_PLAN:${day}`;
    const prior = currentSlots.get(key);
    if (prior?.state === 'ACKED' && prior.hash === compiledDayHash(current.days[day]!)) {
      runtime.planGenerationByDay[day] = planGeneration;
      runtime.deliveredGenerationByDay[day] = planGeneration;
    }
  }
  if (generationName === 'GEN2') {
    for (const row of runtime.planPushes) if (row.purpose === 'WEEKDAY_PLAN' && row.state === 'QUEUED') row.state = 'SUPERSEDED';
  } else {
    for (const row of runtime.planPushes) if (row.purpose === 'DAYMASK_PLAN' && row.state === 'QUEUED') row.state = 'SUPERSEDED';
  }
  for (const push of pushes) {
    const pushMask = push.purpose === 'WEEKDAY_PLAN' && push.weekday !== null ? 1 << push.weekday : push.purpose === 'DAYMASK_PLAN' && push.daymask !== null ? (push.daymask === 0x80 ? 0x7f : push.daymask) : 0;
    for (const prior of runtime.planPushes) {
      if (prior.state !== 'QUEUED' || (prior.purpose !== 'WEEKDAY_PLAN' && prior.purpose !== 'DAYMASK_PLAN')) continue;
      const priorMask = prior.purpose === 'WEEKDAY_PLAN' && prior.weekday !== null ? 1 << prior.weekday : prior.daymask === null ? 0 : daysInMask(prior.daymask).reduce((mask, day) => mask | (1 << day), 0);
      if ((priorMask & pushMask) !== 0) prior.state = 'SUPERSEDED';
    }
  }
  if (needsClock) pendingRows.push({purpose: 'CLOCK_SYNC', weekday: null, daymask: null, plan_hash: null, state: 'QUEUED' as const, queued_at: nowIso, acked_at: null, generation: planGeneration});
  runtime.clockSyncQueued = runtime.clockSyncQueued || needsClock;
  runtime.lastPlanQueuedAt = pushes.length ? nowIso : runtime.lastPlanQueuedAt;
  runtime.planPushes.push(...pendingRows);
  for (const plan of planRows(host, eui)) {
    if (plan.kind !== 'WEEKLY' || !plan.enabled || plan.deleted_at) continue;
    plan.generation = planGeneration;
    scheduleValvePlan(host, plan);
  }
  if (pendingRows.length === 0) runtime.deliveredGeneration = planGeneration;
  if (pushes.length > 0) {
    const entity = `plan-delivery:${eui}:${planGeneration}`, clockGeneration = host.clock.generation(entity);
    host.clock.schedule(host.now() + 2000, () => {
      const currentRuntime = host.planRuntime(eui);
      const acknowledgedAt = new Date(host.now()).toISOString();
      for (const row of pendingRows) if (row.generation === planGeneration && row.state === 'QUEUED') row.state = 'ACKED', row.acked_at = acknowledgedAt;
      if (currentRuntime.planGeneration === planGeneration) currentRuntime.deliveredGeneration = planGeneration;
      for (const day of touchedDays) if (currentRuntime.planGenerationByDay[day] === planGeneration) currentRuntime.deliveredGenerationByDay[day] = planGeneration;
      currentRuntime.lastPlanAckedAt = new Date(host.now()).toISOString();
      currentRuntime.pushAcked = planPushSummary(currentRuntime).acked;
      currentRuntime.pushQueued = planPushSummary(currentRuntime).queued;
    }, {id: `plan-ack:${eui}:${planGeneration}:${clockGeneration}`, meaningful: true, priority: 3, entity, generation: clockGeneration});
  }
  runtime.pushQueued = planPushSummary(runtime).queued;
  return pushes.length + Number(needsClock);
}

function queueSchedulerStatus(host: PlanDomainPort, eui: string) {
  const runtime = host.planRuntime(eui), generation = runtime.planGeneration;
  const row: PlanPushLedgerRow = {purpose: 'SCHEDULER_STATUS', weekday: null, daymask: null, plan_hash: null, state: 'QUEUED',
    queued_at: new Date(host.now()).toISOString(), acked_at: null, generation};
  runtime.planPushes.push(row);
  const entity = `scheduler-status:${eui}`, clockGeneration = host.clock.invalidate(entity);
  host.clock.schedule(host.now() + 2000, () => {
    if (runtime.planPushes.includes(row)) row.state = 'ACKED', row.acked_at = new Date(host.now()).toISOString();
  }, {id: `scheduler-status-ack:${eui}:${clockGeneration}`, meaningful: true, priority: 3, entity, generation: clockGeneration});
}

export function planPushState(host: PlanDomainPort, eui: string) {
  return latestPlanPushRows(host.planRuntime(eui));
}

function planRows(host: PlanDomainPort, eui: string) { return host.state.schedules.get(eui) ?? []; }

function labelizePlanError(error: Record<string, unknown>, plans: ValvePlan[]) {
  const ids = Array.isArray(error.conflicts) ? error.conflicts as string[] : [];
  return {...error, labels: ids.map(id => plans.find(plan => plan.schedule_uuid === id)?.label ?? null)};
}

function planConflict(host: PlanDomainPort, details: unknown[]): never {
  return host.fail(422, 'plan_conflict', {error: 'plan_conflict', details});
}

export function createValvePlan(host: PlanDomainPort, eui: string, body: Record<string, unknown>) {
  const valve = deviceValve(host.devices, eui, host.fail);
  const checked = validatePlan(body);
  if (!checked.ok) return host.fail(checked.status, checked.error, {error: checked.error, message: checked.message});
  const id = `00000000-0000-4000-8000-${String(++host.state.commandId).padStart(12, '0')}`;
  const timezone = host.zones.find(zone => zone.id === valve.irrigation_zone_id)?.timezone ?? host.state.settings.gatewayTimezone ?? 'UTC';
  const plan = {schedule_uuid: id, device_eui: eui, timezone, deleted_at: null, generation: 1, dispatch_state: null,
    dispatch_command_id: null, dispatch_created_at: null, dispatch_attempted_at: null, ...checked.value} as ValvePlan;
  const existing = planRows(host, eui).filter(row => !row.deleted_at);
  const candidate = [...existing, plan];
  if (plan.kind === 'WEEKLY') {
    const conflicts = compilePlans(candidate).errors;
    if (conflicts.length) return planConflict(host, conflicts.map(error => labelizePlanError(error, candidate)));
  }
  host.state.schedules.set(eui, [...planRows(host, eui), plan]);
  const pushesQueued = plan.kind === 'WEEKLY' ? queuePlanDelivery(host, eui) : 0;
  if (plan.kind !== 'WEEKLY') scheduleValvePlan(host, plan);
  return {schedule: host.planSnapshot(eui).schedules.find(row => row.schedule_uuid === id), pushes_queued: pushesQueued};
}

export function updateValvePlan(host: PlanDomainPort, eui: string, id: string, body: Record<string, unknown>) {
  deviceValve(host.devices, eui, host.fail);
  const rows = planRows(host, eui), current = rows.find(plan => plan.schedule_uuid === id && !plan.deleted_at);
  if (!current) return host.fail(404, 'not_found', {error: 'not_found', message: 'Schedule not found'});
  const checked = validatePlan({...current, ...body, kind: current.kind});
  if (!checked.ok) return host.fail(checked.status, checked.error, {error: checked.error, message: checked.message});
  const candidate = rows.map(plan => plan.schedule_uuid === id ? {...plan, ...checked.value, generation: plan.generation + 1} : plan);
  if (current.kind === 'WEEKLY') {
    const conflicts = compilePlans(candidate.filter(plan => !plan.deleted_at)).errors;
    if (conflicts.length) return planConflict(host, conflicts.map(error => labelizePlanError(error, candidate)));
  }
  const updated = candidate.find(plan => plan.schedule_uuid === id)!;
  if (updated.kind === 'ONCE') {
    updated.once_state = current.once_state;
    updated.dispatch_state = current.dispatch_state;
    updated.dispatch_command_id = current.dispatch_command_id;
    updated.dispatch_created_at = current.dispatch_created_at;
    updated.dispatch_attempted_at = current.dispatch_attempted_at;
  }
  host.clock.invalidate(`plan:${id}`);
  host.state.schedules.set(eui, candidate);
  const pushesQueued = updated.kind === 'WEEKLY' ? queuePlanDelivery(host, eui) : 0;
  if (updated.kind !== 'WEEKLY') scheduleValvePlan(host, updated);
  return {ok: true, pushes_queued: pushesQueued};
}

export function deleteValvePlan(host: PlanDomainPort, eui: string, id: string) {
  deviceValve(host.devices, eui, host.fail);
  const rows = planRows(host, eui), current = rows.find(plan => plan.schedule_uuid === id && !plan.deleted_at);
  if (!current) return host.fail(404, 'not_found', {error: 'not_found', message: 'Schedule not found'});
  host.clock.invalidate(`plan:${id}`);
  host.state.schedules.set(eui, rows.filter(plan => plan.schedule_uuid !== id));
  const pushesQueued = current.kind === 'WEEKLY' ? queuePlanDelivery(host, eui) : 0;
  return {ok: true, pushes_queued: pushesQueued};
}

export function resendValvePlan(host: PlanDomainPort, eui: string) {
  deviceValve(host.devices, eui, host.fail);
  return {ok: true, pushes_queued: queuePlanDelivery(host, eui, true)};
}

export function setValveSchedulerStatus(host: PlanDomainPort, eui: string, statusValue: unknown) {
  deviceValve(host.devices, eui, host.fail);
  const status = String(statusValue ?? '').toUpperCase();
  if (!['ACTIVE', 'SKIP_TODAY', 'DEACTIVATED'].includes(status)) return host.fail(422, 'invalid_status', {error: 'invalid_status', message: 'status must be ACTIVE, SKIP_TODAY or DEACTIVATED'});
  const runtime = host.planRuntime(eui);
  runtime.schedulerStatus = status as typeof runtime.schedulerStatus;
  runtime.skipTodayDate = status === 'SKIP_TODAY' ? localDate(host.now(), host.zones.find(zone => zone.id === host.devices.find(device => device.deveui === eui)?.irrigation_zone_id)?.timezone ?? host.state.settings.gatewayTimezone) : null;
  rescheduleSkipTodayRollover(host, eui);
  queueSchedulerStatus(host, eui);
  return {ok: true, status};
}

export function handlePlanRoute(host: PlanRouteHost, method: string, path: string, body: Record<string, unknown>): {handled: true; value: unknown} | null {
  let match = path.match(/^\/api\/valves\/([^/]+)\/schedules$/);
  if (match) {
    const eui = match[1]!.toUpperCase();
    if (method === 'GET') return {handled: true, value: host.planSnapshot(eui)};
    if (method === 'POST') return {handled: true, value: host.createPlan(eui, body)};
  }
  match = path.match(/^\/api\/valves\/([^/]+)\/schedules\/([0-9a-f-]{36})$/i);
  if (match) {
    const eui = match[1]!.toUpperCase(), scheduleId = match[2]!;
    if (method === 'PUT') return {handled: true, value: host.updatePlan(eui, scheduleId, body)};
    if (method === 'DELETE') return {handled: true, value: host.deletePlan(eui, scheduleId)};
  }
  match = path.match(/^\/api\/valves\/([^/]+)\/plan\/resend$/);
  if (match && method === 'POST') return {handled: true, value: host.resendPlan(match[1]!.toUpperCase())};
  match = path.match(/^\/api\/valves\/([^/]+)\/scheduler-status$/);
  if (match && method === 'POST') return {handled: true, value: host.setSchedulerStatus(match[1]!.toUpperCase(), body.status)};
  return null;
}
import type {Device, IrrigationZone} from '../../src/types/farming';
import type {IrrigationActuation} from '../../src/services/api';
import type {SimulatorState} from './state';
import type {SimulationClock} from './clock';
import {deviceValve} from './irrigation';
import {iso} from '../fixtures';
