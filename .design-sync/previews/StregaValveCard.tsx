import React from 'react';
import { StregaValveCard } from 'open-smart-irrigation';

// STREGA LoRaWAN valve card. On mount the card GETs
// /api/v1/devices/<eui>/today-liters (silently blank on 404) — answered here
// per-EUI so the "Today: N L" line renders with its Measured/Estimated tag.
// Actuation fixtures modeled on ValveCard.test.tsx.
const LITERS_BY_EUI: Record<string, { liters: number | null; source: string }> = {
  '70B3D5E75E014E2C': { liters: null, source: 'unknown' },          // ClosedIdle
  '70B3D5E75E0152A8': { liters: 320, source: 'measured_flow_meter' }, // OpenRunning
  '70B3D5E75E0163B1': { liters: null, source: 'unknown' },          // OpenQueued
  '70B3D5E75E0177D9': { liters: 180, source: 'estimated_duration_flow_rate' }, // Completed
};
(window as any).__dsApiRoutes ??= [];
(window as any).__dsApiRoutes.push([
  /^\/api\/v1\/devices\/([0-9A-Fa-f]+)\/today-liters$/,
  (m: RegExpMatchArray) => LITERS_BY_EUI[m[1].toUpperCase()] ?? { liters: null, source: 'unknown' },
]);

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(now + m * 60_000).toISOString();
const TIME_ZONE = 'Europe/Zurich';

// Shape-complete IrrigationActuation row (services/api.ts).
const actuation = (over: Record<string, unknown>) => ({
  expectationId: 'exp-01HZX4M8',
  deviceEui: '',
  deviceName: null,
  zoneId: 12,
  zoneName: 'Orchard — Zone B',
  commandId: 'cmd-01HZX4M8',
  commandedAt: minutesAgo(5),
  commandedDurationSeconds: 900,
  expectedCloseAt: minutesAhead(10),
  observedOpenAt: null,
  observedCloseAt: null,
  estimatedGrossLiters: null,
  flowRateLpm: 12,
  reconciliationState: 'PENDING_OBSERVATION',
  cancelReason: null,
  commandResult: null,
  commandResultDetail: null,
  commandAppliedAt: null,
  status: 'PENDING_OPEN',
  ...over,
});

const closedIdle = {
  deveui: '70B3D5E75E014E2C',
  name: 'Valve — Row 1 Solenoid',
  type_id: 'STREGA_VALVE',
  last_seen: minutesAgo(22),
  current_state: 'CLOSED',
  target_state: 'CLOSED',
  strega_model: 'STANDARD',
  latest_data: { bat_pct: 84 },
} as any;

// Valve observed open, mid-irrigation: blue "closes at" badge, measured
// today-liters, and the cancel column beside the open control.
const openRunning = {
  deveui: '70B3D5E75E0152A8',
  name: 'Valve — Row 2 Solenoid',
  type_id: 'STREGA_VALVE',
  last_seen: minutesAgo(1),
  current_state: 'OPEN',
  target_state: 'OPEN',
  strega_model: 'STANDARD',
  active_valve_actuation: {
    expectation_id: 'exp-01HZX4M8',
    reconciliation_state: 'OBSERVED_RUNNING',
    commanded_at: minutesAgo(5),
    expected_close_at: minutesAhead(10),
  },
  latest_data: { bat_pct: 71 },
} as any;
const openRunningRows = [
  actuation({
    deviceEui: openRunning.deveui,
    status: 'RUNNING',
    reconciliationState: 'OBSERVED_RUNNING',
    observedOpenAt: minutesAgo(4),
    estimatedGrossLiters: 60,
  }),
];

// Open command queued as a downlink, valve uplink not yet observed: amber
// badge with the expected wait, target state line, cancel available.
const openQueued = {
  deveui: '70B3D5E75E0163B1',
  name: 'Valve — Motorized Main',
  type_id: 'STREGA_VALVE',
  last_seen: minutesAgo(3),
  current_state: 'CLOSED',
  target_state: 'OPEN',
  strega_model: 'MOTORIZED',
  active_valve_actuation: {
    expectation_id: 'exp-01HZX7Q2',
    reconciliation_state: 'PENDING_OBSERVATION',
    commanded_at: minutesAgo(1),
    expected_close_at: minutesAhead(9),
  },
  latest_data: { bat_pct: 93 },
} as any;
const openQueuedRows = [
  actuation({
    expectationId: 'exp-01HZX7Q2',
    deviceEui: openQueued.deveui,
    commandedAt: minutesAgo(1),
    commandedDurationSeconds: 600,
    expectedCloseAt: minutesAhead(9),
  }),
];

// Cycle finished earlier today: green "Closed at" badge and the estimated
// water total (no flow meter on this line).
const completed = {
  deveui: '70B3D5E75E0177D9',
  name: 'Valve — Row 3 Solenoid',
  type_id: 'STREGA_VALVE',
  last_seen: minutesAgo(12),
  current_state: 'CLOSED',
  target_state: 'CLOSED',
  strega_model: 'STANDARD',
  latest_data: { bat_pct: 66 },
} as any;
const completedRows = [
  actuation({
    expectationId: 'exp-01HZWPK5',
    deviceEui: completed.deveui,
    status: 'COMPLETED',
    reconciliationState: 'OBSERVED_CLOSED',
    commandedAt: minutesAgo(55),
    expectedCloseAt: minutesAgo(40),
    observedOpenAt: minutesAgo(54),
    observedCloseAt: minutesAgo(40),
    estimatedGrossLiters: 180,
  }),
];

export function ClosedIdle() {
  return (
    <div style={{ maxWidth: 400 }}>
      <StregaValveCard device={closedIdle} onUpdate={() => {}} timeZone={TIME_ZONE} />
    </div>
  );
}

export function OpenRunning() {
  return (
    <div style={{ maxWidth: 400 }}>
      <StregaValveCard
        device={openRunning}
        onUpdate={() => {}}
        irrigationActuations={openRunningRows as any}
        timeZone={TIME_ZONE}
      />
    </div>
  );
}

export function OpenQueued() {
  return (
    <div style={{ maxWidth: 400 }}>
      <StregaValveCard
        device={openQueued}
        onUpdate={() => {}}
        irrigationActuations={openQueuedRows as any}
        timeZone={TIME_ZONE}
      />
    </div>
  );
}

export function CompletedRecently() {
  return (
    <div style={{ maxWidth: 400 }}>
      <StregaValveCard
        device={completed}
        onUpdate={() => {}}
        irrigationActuations={completedRows as any}
        timeZone={TIME_ZONE}
      />
    </div>
  );
}
