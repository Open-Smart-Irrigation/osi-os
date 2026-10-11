import type {Device} from '../../src/types/farming';
import type {SimulatorState, ActiveCommand} from './state';
import type {SimulationClock} from './clock';
import type {IrrigationActuation} from '../../src/services/api';
import {iso} from '../fixtures';

export type IrrigationDomainPort = {
  state: SimulatorState;
  clock: SimulationClock;
  mode: 'presentation' | 'public';
  now(): number;
  devices: Device[];
  zones: Array<{id: number; name: string; measured_flow_rate_lpm?: number | null}>;
  defaultOpenMinutes(eui: string): number;
  setDefaultOpenMinutes(eui: string, value: number): void;
  outcomes: IrrigationActuation[];
  flowRateForValve(valve: Device): number;
  flowDeviceForZone(zoneId: number | null): Device | undefined;
  markFlowStarted(command: ActiveCommand, at: number): void;
  afterActuationClosed(command: ActiveCommand, valve: Device | undefined, outcome: IrrigationActuation | undefined): void;
  startActuation(eui: string, duration: number, trigger: IrrigationActuation['trigger'], openDelayMs: number, autoClose: boolean, planId?: string): boolean;
  close(status: 'COMPLETED' | 'CANCELLED', eui: string): void;
  integrateFlow(command: ActiveCommand, until: number): void;
  finishServiceAction(eui: string, action: string): void;
  recordPendingMutation(): void;
  cancelTimedCloseHold(eui: string): void;
};

export function startValveActuation(host: IrrigationDomainPort, eui: string, duration: number, trigger: IrrigationActuation['trigger'], openDelayMs: number, autoClose: boolean, planId?: string): boolean {
  const valve = host.devices.find(device => device.deveui === eui && device.type_id === 'STREGA_VALVE');
  if (!valve || host.state.activeCommands.has(eui) || host.state.timedCloseHolds.has(eui)) return false;
  const id = `demo-command-${++host.state.commandId}`;
  const generation = host.clock.invalidate(`actuation:${eui}`);
  const zone = host.zones.find(item => item.id === valve.irrigation_zone_id);
  const rate = host.flowRateForValve(valve);
  const flowDevice = valve.irrigation_zone_id == null ? undefined : host.flowDeviceForZone(valve.irrigation_zone_id);
  const command: ActiveCommand = {expectation_id: id, reconciliation_state: 'PENDING_OBSERVATION', commanded_at: iso(host.now()),
    expected_close_at: iso(host.now() + openDelayMs + duration * 1000), duration_seconds: duration, trigger: trigger ?? 'unexplained', device_eui: eui,
    zone_id: valve.irrigation_zone_id ?? null, flow_device_eui: flowDevice?.deveui ?? null, flow_rate_lpm: rate,
    generation, open_delay_ms: openDelayMs};
  host.state.activeCommands.set(eui, command);
  valve.target_state = 'OPEN';
  host.outcomes.unshift({expectationId: id, deviceEui: valve.deveui, deviceName: valve.name, zoneId: valve.irrigation_zone_id ?? null,
    zoneName: zone?.name ?? null, commandId: id, commandedAt: command.commanded_at, commandedDurationSeconds: duration,
    expectedCloseAt: command.expected_close_at, observedOpenAt: null, observedCloseAt: null, estimatedGrossLiters: null,
    flowRateLpm: null, reconciliationState: 'PENDING_OBSERVATION', cancelReason: null, trigger, commandResult: null,
    commandResultDetail: planId ?? null, commandAppliedAt: null, status: 'PENDING_OPEN'});
  host.clock.schedule(host.now() + openDelayMs, () => {
    const current = host.state.activeCommands.get(eui);
    if (!current || current.expectation_id !== id) return;
    current.reconciliation_state = 'OBSERVED_RUNNING'; current.opened_at = iso(host.now());
    host.markFlowStarted(current, host.now());
    valve.current_state = 'OPEN'; valve.last_seen = iso(host.now());
    (valve as Device & Record<string, unknown>).valve_opening_percent = 100;
    const outcome = host.outcomes.find(entry => entry.expectationId === id);
    if (outcome) Object.assign(outcome, {status: 'RUNNING', reconciliationState: 'OBSERVED_RUNNING', observedOpenAt: iso(host.now()), commandResult: 'ACK', commandAppliedAt: iso(host.now())});
  }, {id: `ack:${id}`, priority: 3, meaningful: true, entity: `actuation:${eui}`, generation});
  if (autoClose) host.clock.schedule(host.now() + openDelayMs + duration * 1000, () => {
    if (host.state.activeCommands.get(eui)?.expectation_id === id) host.close('COMPLETED', eui);
  }, {id: `closure:${id}`, priority: 1, meaningful: true, entity: `actuation:${eui}`, generation});
  return true;
}

export function closeValveActuation(host: IrrigationDomainPort, status: 'COMPLETED' | 'CANCELLED', eui?: string) {
  const command = eui ? host.state.activeCommands.get(eui) : host.state.activeCommands.values().next().value as ActiveCommand | undefined;
  if (!command) return;
  const valve = host.devices.find(device => device.deveui === command.device_eui);
  if (valve?.current_state === 'OPEN') host.integrateFlow(command, host.now());
  if (valve) { valve.current_state = 'CLOSED'; valve.target_state = 'CLOSED'; valve.last_seen = iso(host.now()); (valve as Device & Record<string, unknown>).valve_opening_percent = 0; }
  const outcome = host.outcomes.find(entry => entry.expectationId === command.expectation_id);
  const finalStatus = outcome?.status === 'CANCELLED' ? 'CANCELLED' : status;
  if (outcome) Object.assign(outcome, {status: finalStatus, reconciliationState: finalStatus, observedCloseAt: iso(host.now())});
  host.clock.invalidate(`actuation:${command.device_eui}`);
  host.afterActuationClosed(command, valve, outcome);
  host.state.activeCommands.delete(command.device_eui);
}

export function cancelTimedCloseHold(host: IrrigationDomainPort, eui: string) {
  host.clock.invalidate(`timed-close-hold:${eui}`);
  host.state.timedCloseHolds.delete(eui);
}

export function updateValveSettings(host: IrrigationDomainPort, eui: string, body: Record<string, unknown>, fail: IrrigationRouteHost['fail']) {
  const valve = deviceValve(host.devices, eui, fail) as Device & Record<string, unknown>;
  const allowed = new Set(['strega_generation', 'flow_rate_lpm', 'flow_rate_source', 'default_open_minutes']);
  if (Object.keys(body).some(key => !allowed.has(key))) return fail(501, 'unsupported');
  if (body.strega_generation !== undefined && !['GEN1', 'GEN2'].includes(String(body.strega_generation))) return fail();
  if (body.flow_rate_lpm !== undefined && body.flow_rate_lpm !== null && (!Number.isFinite(Number(body.flow_rate_lpm)) || Number(body.flow_rate_lpm) <= 0 || Number(body.flow_rate_lpm) > 10000)) return fail();
  if (body.flow_rate_source !== undefined && !['measured', 'estimated'].includes(String(body.flow_rate_source))) return fail();
  if (body.default_open_minutes !== undefined && (!Number.isInteger(Number(body.default_open_minutes)) || Number(body.default_open_minutes) < 1 || Number(body.default_open_minutes) > 255)) return fail();
  if (body.strega_generation !== undefined) valve.strega_generation = body.strega_generation;
  if (body.flow_rate_lpm !== undefined) {
    valve.flow_rate_lpm = body.flow_rate_lpm;
    if (body.flow_rate_lpm === null) valve.flow_rate_source = null;
  }
  if (body.flow_rate_source !== undefined) valve.flow_rate_source = body.flow_rate_source;
  const defaultOpenMinutes = body.default_open_minutes === undefined ? host.defaultOpenMinutes(eui) : Number(body.default_open_minutes);
  if (body.default_open_minutes !== undefined) host.setDefaultOpenMinutes(eui, defaultOpenMinutes);
  return {ok: true, settings: {strega_generation: valve.strega_generation ?? 'GEN1', flow_rate_lpm: valve.flow_rate_lpm ?? null,
    flow_rate_source: valve.flow_rate_source ?? null, default_open_minutes: defaultOpenMinutes}};
}

export function commandValve(host: IrrigationDomainPort, eui: string, body: Record<string, unknown>, fail: IrrigationRouteHost['fail']) {
  const valve = deviceValve(host.devices, eui, fail);
  if (body.action === 'CLOSE') {
    host.cancelTimedCloseHold(eui);
    const command = host.state.activeCommands.get(eui);
    if (command && host.mode === 'public') host.clock.schedule(host.now() + 2000, () => host.close('CANCELLED', eui), {id: `manual-close:${command.expectation_id}:${host.now()}`, meaningful: true, priority: 1, entity: `actuation:${eui}`, generation: command.generation});
    else if (command) host.close('CANCELLED', eui);
    else if (valve.current_state === 'OPEN') { valve.current_state = 'CLOSED'; valve.target_state = 'CLOSED'; }
    return {status: 'acknowledged'};
  }
  const duration = Number(body.duration_seconds);
  if (body.action !== 'OPEN_FOR_DURATION' || !Number.isInteger(duration) || duration < 60 || duration > 15300) return fail();
  if (host.state.activeCommands.has(eui) || host.state.timedCloseHolds.has(eui)) return fail(409, 'busy');
  host.startActuation(eui, duration, 'manual', host.mode === 'public' ? 2000 : 0, true);
  return {status: 'queued'};
}

export function cancelValveCommand(host: IrrigationDomainPort, eui: string, body: Record<string, unknown>, fail: IrrigationRouteHost['fail']) {
  const command = host.state.activeCommands.get(eui);
  if (!command) return host.mode === 'public' ? fail(404, 'no_active_actuation', {error: 'no_active_actuation', message: 'No active valve actuation'}) : {};
  const outcome = host.outcomes.find(item => item.expectationId === command.expectation_id);
  if (command.reconciliation_state === 'PENDING_OBSERVATION') {
    host.clock.invalidate(`actuation:${eui}`);
    const valve = host.devices.find(device => device.deveui === eui);
    if (valve) valve.target_state = 'CLOSED';
    if (outcome) Object.assign(outcome, {status: 'CANCELLED', reconciliationState: 'CANCELLED', cancelReason: body.reason ?? 'operator_cancel'});
    host.state.activeCommands.delete(eui);
  } else if (command.reconciliation_state === 'OBSERVED_RUNNING') {
    command.reconciliation_state = 'CANCELLED';
    if (outcome) Object.assign(outcome, {status: 'CANCELLED', reconciliationState: 'CANCELLED', cancelReason: body.reason ?? 'operator_cancel'});
  }
  return {};
}

export function executeStregaServiceCommand(host: IrrigationDomainPort, eui: string, action: string, body: Record<string, unknown>, fail: IrrigationRouteHost['fail']) {
  if (host.mode !== 'public') return fail(501, 'unsupported');
  const valve = deviceValve(host.devices, eui, fail) as Device & Record<string, unknown>;
  const assignConfig = (target: Device & Record<string, unknown>, patch: Record<string, unknown>) => {
    const changed = Object.entries(patch).some(([field, value]) => {
      const current = target[field];
      return !Object.is(current, value) && JSON.stringify(current) !== JSON.stringify(value);
    });
    if (changed) Object.assign(target, patch);
    return changed;
  };
  const enqueue = (key: string, apply: (current: Device & Record<string, unknown>) => boolean) => {
    const entity = `service:${eui}:${key}`, generation = host.clock.invalidate(entity);
    host.clock.schedule(host.now() + 2000, () => {
      const current = host.devices.find(row => row.deveui === eui);
      if (!current) return;
      if (apply(current as Device & Record<string, unknown>)) host.recordPendingMutation();
    }, {id: `${key}:${eui}:${host.now()}:${generation}`, meaningful: true, priority: 3, entity, generation});
    host.state.serviceActions.unshift({device_eui: eui, action: key, status: 'PENDING', commanded_at: iso(host.now()), acknowledged_at: null});
    return {status: 'queued'};
  };
  if (action === 'interval') {
    const shared = body.minutes === undefined ? undefined : Number(body.minutes);
    const closed = Number(body.closedMinutes ?? shared ?? valve.strega_uplink_interval_closed_minutes ?? 1);
    const opened = Number(body.openedMinutes ?? shared ?? valve.strega_uplink_interval_opened_minutes ?? 1);
    if (body.minutes !== undefined && (!Number.isInteger(shared) || shared! < 1 || shared! > 255) ||
      !Number.isInteger(closed) || closed < 1 || closed > 255 || !Number.isInteger(opened) || opened < 1 || opened > 255 ||
      body.tamperDisabled !== undefined && typeof body.tamperDisabled !== 'boolean') return fail();
    return enqueue(action, current => {
      const patch: Record<string, unknown> = {strega_uplink_interval_closed_minutes: closed, strega_uplink_interval_opened_minutes: opened};
      if (body.tamperDisabled !== undefined) patch.strega_tamper_disabled = body.tamperDisabled;
      const changed = assignConfig(current, patch);
      host.finishServiceAction(eui, action);
      return changed;
    });
  }
  if (action === 'model') {
    if (!['STANDARD', 'MOTORIZED'].includes(String(body.model))) return fail();
    return enqueue(action, current => {
      const changed = assignConfig(current, {strega_model: String(body.model)});
      host.finishServiceAction(eui, action);
      return changed;
    });
  }
  if (action === 'magnet') {
    if (typeof body.enabled !== 'boolean') return fail();
    return enqueue(action, current => {
      const changed = assignConfig(current, {strega_magnet_enabled: body.enabled});
      host.finishServiceAction(eui, action);
      return changed;
    });
  }
  if (action === 'timed-action') {
    const amount = Number(body.amount), unit = String(body.unit), direction = String(body.action);
    const secondsPerUnit: Record<string, number> = {seconds: 1, minutes: 60, hours: 3600};
    if (!Number.isInteger(amount) || amount < 1 || amount > 255 || !(unit in secondsPerUnit) || !['OPEN', 'CLOSE'].includes(direction)) return fail();
    const priorPercentage = Math.max(0, Math.min(100, Number(valve.valve_opening_percent ?? (valve.current_state === 'OPEN' ? 100 : 0))));
    const duration = amount * secondsPerUnit[unit]!;
    if (direction === 'OPEN') {
      if (host.state.activeCommands.has(eui) || host.state.timedCloseHolds.has(eui)) return fail(409, 'busy');
      host.startActuation(eui, duration, 'service_action', 2000, true);
    } else {
      host.cancelTimedCloseHold(eui);
      const holdEntity = `timed-close-hold:${eui}`;
      const holdGeneration = host.clock.invalidate(holdEntity);
      const operation: {priorPercentage: number; generation: number; phase: 'PENDING_CLOSE' | 'HOLD'} = {priorPercentage, generation: holdGeneration, phase: 'PENDING_CLOSE'};
      host.state.timedCloseHolds.set(eui, operation);
      host.clock.schedule(host.now() + 2000, () => {
        const pending = host.state.timedCloseHolds.get(eui);
        if (pending !== operation || pending.phase !== 'PENDING_CLOSE') return;
        const active = host.state.activeCommands.get(eui);
        if (active) host.close('CANCELLED', eui);
        valve.current_state = 'CLOSED'; valve.target_state = 'CLOSED'; valve.valve_opening_percent = 0;
        operation.phase = 'HOLD';
        host.clock.schedule(host.now() + duration * 1000, () => {
          const hold = host.state.timedCloseHolds.get(eui);
          if (hold !== operation || hold.phase !== 'HOLD' || hold.generation !== holdGeneration) return;
          host.state.timedCloseHolds.delete(eui);
          if (hold.priorPercentage > 0 && !host.state.activeCommands.has(eui) && host.startActuation(eui, 0, 'service_action', 0, false)) {
            const command = host.state.activeCommands.get(eui)!;
            const commandGeneration = command.generation;
            host.clock.schedule(host.now(), () => {
              if (host.state.activeCommands.get(eui)?.expectation_id === command.expectation_id && valve.current_state === 'OPEN') {
                valve.valve_opening_percent = hold.priorPercentage;
              }
            }, {id: `timed-return-position:${eui}:${host.now()}:${commandGeneration}`, priority: 4, meaningful: true,
              entity: `actuation:${eui}`, generation: commandGeneration});
          }
        }, {id: `timed-return:${eui}:${host.now()}:${holdGeneration}`, priority: 3, meaningful: true, entity: holdEntity, generation: holdGeneration});
      }, {id: `timed-close:${eui}:${host.now()}:${holdGeneration}`, priority: 1, meaningful: true, entity: holdEntity, generation: holdGeneration});
    }
    host.state.serviceActions.unshift({device_eui: eui, action, state: direction, amount, unit, status: 'SENT', commanded_at: iso(host.now())});
    return {status: 'queued'};
  }
  if (action === 'partial-opening') {
    const percentage = Number(body.percentage), direction = String(body.action);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100 || !['OPEN', 'CLOSE'].includes(direction)) return fail();
    if (host.state.timedCloseHolds.has(eui)) return fail(409, 'busy');
    if (direction === 'OPEN' && !host.state.activeCommands.has(eui)) host.startActuation(eui, 0, 'service_action', 2000, false);
    const generation = host.clock.generation(`actuation:${eui}`);
    host.clock.schedule(host.now() + 2000, () => {
      const active = host.state.activeCommands.get(eui);
      if (active && valve.current_state === 'OPEN') host.integrateFlow(active, host.now());
      const current = Number(valve.valve_opening_percent ?? (valve.current_state === 'OPEN' ? 100 : 0));
      const next = direction === 'OPEN' ? percentage : Math.max(0, current - percentage);
      valve.valve_opening_percent = next; valve.current_state = next > 0 ? 'OPEN' : 'CLOSED'; valve.target_state = valve.current_state;
      if (next === 0 && host.state.activeCommands.has(eui)) host.close('COMPLETED', eui);
      host.state.serviceActions.unshift({device_eui: eui, action, state: direction, percentage, resulting_percentage: next, status: 'SENT', commanded_at: iso(host.now())});
    }, {id: `partial:${eui}:${host.now()}`, priority: 3, meaningful: true, entity: `actuation:${eui}`, generation});
    return {status: 'queued'};
  }
  if (action === 'flushing') {
    const percentage = Number(body.percentage), returnPosition = String(body.returnPosition);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100 || !['OPEN', 'CLOSE'].includes(returnPosition)) return fail();
    if (host.state.timedCloseHolds.has(eui)) return fail(409, 'busy');
    if (!host.state.activeCommands.has(eui)) host.startActuation(eui, 5, 'service_action', 2000, false);
    const generation = host.clock.generation(`actuation:${eui}`);
    host.clock.schedule(host.now() + 2000, () => {
      const active = host.state.activeCommands.get(eui);
      if (active && valve.current_state === 'OPEN') host.integrateFlow(active, host.now());
      valve.current_state = 'OPEN'; valve.target_state = 'OPEN'; valve.valve_opening_percent = percentage;
      host.clock.schedule(host.now() + 5000, () => {
        const running = host.state.activeCommands.get(eui);
        if (running && valve.current_state === 'OPEN') host.integrateFlow(running, host.now());
        const next = returnPosition === 'OPEN' ? 100 : 0;
        valve.valve_opening_percent = next; valve.current_state = next > 0 ? 'OPEN' : 'CLOSED'; valve.target_state = valve.current_state;
        if (next === 0 && host.state.activeCommands.has(eui)) host.close('COMPLETED', eui);
        if (next > 0 && !host.state.activeCommands.has(eui)) host.startActuation(eui, 0, 'service_action', 0, false);
        host.state.serviceActions.unshift({device_eui: eui, action, percentage, return_position: returnPosition, status: 'SENT', commanded_at: iso(host.now())});
      }, {id: `flush-end:${eui}:${host.now()}`, priority: 1, meaningful: true, entity: `actuation:${eui}`, generation});
    }, {id: `flush-start:${eui}:${host.now()}`, priority: 3, meaningful: true, entity: `actuation:${eui}`, generation});
    return {status: 'queued'};
  }
  return fail(501, 'unsupported');
}

export type IrrigationRouteHost = {
  devices: Device[];
  defaultOpenMinutes: number;
  fail(status?: number, code?: string, data?: unknown): never;
  valveSettings(eui: string, body: Record<string, unknown>): unknown;
  valveCommand(eui: string, body: Record<string, unknown>): unknown;
  cancelValve(eui: string, body: Record<string, unknown>): unknown;
  serviceCommand(eui: string, action: string, body: Record<string, unknown>): unknown;
};

export function handleIrrigationRoute(host: IrrigationRouteHost, method: string, path: string, body: Record<string, unknown>): {handled: true; value: unknown} | null {
  let match = path.match(/^\/api\/valves\/([^/]+)\/settings$/);
  if (match && method === 'PUT') return {handled: true, value: host.valveSettings(match[1]!.toUpperCase(), body)};
  match = path.match(/^\/api\/valve\/([^/]+)\/cancel$/);
  if (match && method === 'POST') return {handled: true, value: host.cancelValve(match[1]!.toUpperCase(), body)};
  match = path.match(/^\/api\/valve\/([^/]+)$/);
  if (match && method === 'POST') return {handled: true, value: host.valveCommand(match[1]!.toUpperCase(), body)};
  match = path.match(/^\/api\/devices\/([^/]+)\/strega\/(interval|model|timed-action|magnet|partial-opening|flushing)$/);
  if (match && method === 'PUT') return {handled: true, value: host.serviceCommand(match[1]!.toUpperCase(), match[2]!, body)};
  return null;
}

export function deviceValve(devices: Device[], eui: string, fail: IrrigationRouteHost['fail']): Device {
  const device = devices.find(row => row.deveui === eui && row.type_id === 'STREGA_VALVE');
  if (!device) return fail(404, 'missing');
  return device;
}
