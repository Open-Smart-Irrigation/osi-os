import type {SystemFeatureFlags, SystemStats} from '../../src/services/api';
import type {SimulationClock} from './clock';
import type {SupportInboxEntry} from './support';
import {iso} from '../fixtures';

export interface PublicSystemState {
  fanValue: number;
  restartPending: SystemStats['restartPending'];
  restartGeneration: number;
  supportInbox: SupportInboxEntry[];
  nextSupportRequestId: number;
}

export function createSystemState(): PublicSystemState {
  return {fanValue: 35, restartPending: null, restartGeneration: 0, supportInbox: [], nextSupportRequestId: 1};
}

export function publicSystemFeatures(): SystemFeatureFlags {
  return {historyUxEnabled: true, historyComparisonEnabled: true, historyWorkspacesEnabled: true,
    historyAdvancedOverlaysEnabled: true, historyCloudAiEnabled: false};
}

export function publicSystemStats(state: PublicSystemState, now: number): SystemStats {
  const phase = Math.floor(now / 1000);
  const cpu_temp_c = Number((43 + (phase % 17) * 0.4).toFixed(1));
  const mem_total_mb = 2048;
  const mem_used_mb = 700 + phase % 250;
  const mem_free_mb = mem_total_mb - mem_used_mb;
  return {
    cpu_temp_c, mem_total_mb, mem_used_mb, mem_free_mb,
    mem_percent: Number((mem_used_mb / mem_total_mb * 100).toFixed(1)),
    load_1: Number((0.18 + phase % 13 / 100).toFixed(2)),
    load_5: Number((0.22 + phase % 9 / 100).toFixed(2)),
    load_15: Number((0.2 + phase % 7 / 100).toFixed(2)),
    cpu_count: 4, fan_available: true, fan_mode: 'pwm', fan_value: state.fanValue, fan_max: 255,
    restartPending: state.restartPending ? {...state.restartPending} : null,
  };
}

export function setSimulatedFan(state: PublicSystemState, speed: unknown): void {
  const numeric = Number(speed);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 255) {
    throw Object.assign(new Error('Provide speed: 0-255'), {status: 400, code: 'invalid_fan_speed'});
  }
  state.fanValue = numeric;
}

export function scheduleSimulatedRestart(state: PublicSystemState, clock: SimulationClock, now: number): void {
  const generation = clock.invalidate('system-restart');
  state.restartGeneration = generation;
  state.restartPending = {restartAt: iso(now + 5000), reason: 'simulated'};
  clock.schedule(now + 5000, () => {
    if (state.restartGeneration === generation) state.restartPending = null;
  }, {id: `system-restart:${generation}`, meaningful: true, priority: 2, entity: 'system-restart', generation});
}
