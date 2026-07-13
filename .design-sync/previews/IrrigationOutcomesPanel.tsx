import React from 'react';
import { IrrigationOutcomesPanel } from 'open-smart-irrigation';

// Realistic actuation history: a reconciled STREGA valve run, one currently
// running, and yesterday's open-timeout failure. Every IrrigationActuation
// field is present (services/api.ts).
const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

const actuations = [
  {
    expectationId: 'exp-01J0Z4K7Q2-z12',
    deviceEui: 'A84041FFFE12B3C4',
    deviceName: 'Main line valve',
    zoneId: 12,
    zoneName: 'Orchard — Zone B',
    commandId: 'cmd-7f3a91',
    commandedAt: iso(95),
    commandedDurationSeconds: 1200,
    expectedCloseAt: iso(75),
    observedOpenAt: iso(94),
    observedCloseAt: iso(74),
    estimatedGrossLiters: 320,
    flowRateLpm: 16,
    reconciliationState: 'RECONCILED',
    cancelReason: null,
    commandResult: 'SUCCESS',
    commandResultDetail: null,
    commandAppliedAt: iso(94),
    status: 'COMPLETED',
  },
  {
    expectationId: 'exp-01J0Z5N2XA-z12',
    deviceEui: 'A84041FFFE12B3C4',
    deviceName: 'Main line valve',
    zoneId: 12,
    zoneName: 'Orchard — Zone B',
    commandId: 'cmd-80c24d',
    commandedAt: iso(9),
    commandedDurationSeconds: 1800,
    expectedCloseAt: iso(-21),
    observedOpenAt: iso(8),
    observedCloseAt: null,
    estimatedGrossLiters: null,
    flowRateLpm: 16,
    reconciliationState: 'OPEN_CONFIRMED',
    cancelReason: null,
    commandResult: 'SUCCESS',
    commandResultDetail: null,
    commandAppliedAt: iso(8),
    status: 'RUNNING',
  },
  {
    expectationId: 'exp-01J0WX9T5M-z13',
    deviceEui: 'A84041FFFE0A77D1',
    deviceName: 'Vineyard valve',
    zoneId: 13,
    zoneName: 'Vineyard — Zone C',
    commandId: 'cmd-5b19e7',
    commandedAt: iso(26 * 60),
    commandedDurationSeconds: 900,
    expectedCloseAt: iso(26 * 60 - 15),
    observedOpenAt: null,
    observedCloseAt: null,
    estimatedGrossLiters: null,
    flowRateLpm: null,
    reconciliationState: 'TIMED_OUT',
    cancelReason: null,
    commandResult: 'TIMEOUT',
    commandResultDetail: 'No open confirmation within 120 s — LoRa downlink may not have reached the valve.',
    commandAppliedAt: null,
    status: 'OPEN_TIMEOUT',
  },
] as any[];

// The default shim answers /api/irrigation/recent-actuations with an empty
// list; override it for the uncontrolled (fetch-on-mount) story.
(window as any).__dsApiRoutes ??= [];
(window as any).__dsApiRoutes.push([
  /^\/api\/irrigation\/recent-actuations$/,
  () => ({ generatedAt: new Date(now - 30_000).toISOString(), actuations }),
]);

// Zone context gives the depth metric (area + efficiency) and the timezone —
// mirrors the env-summary fixture for zone 12.
const zoneContexts = new Map<number, any>([
  [12, { timeZone: 'Europe/Zurich', areaM2: 1200, irrigationEfficiencyPct: 85 }],
]);

const controlledResponse = {
  generatedAt: new Date(now - 30_000).toISOString(),
  actuations,
} as any;

// Advanced view is an internal preference behind the ⚙ popover. Drive real
// clicks: open the settings popover, tick "Advanced view", close the popover
// again (it would occlude the first row's status badge), then reset the
// persisted preference so other cells (and reloads) stay on the compact view.
function AutoAdvanced({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const gear = () => ref.current?.querySelector('button[aria-label*="settings" i]') as HTMLElement | null;
    gear()?.click();
    const t1 = setTimeout(() => {
      const box = ref.current?.querySelector('input[type="checkbox"]') as HTMLElement | null;
      box?.click();
      try {
        window.localStorage.setItem('osi.recentIrrigations.advancedView', 'false');
      } catch { /* storage unavailable */ }
    }, 60);
    const t2 = setTimeout(() => gear()?.click(), 120);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  return <div ref={ref}>{children}</div>;
}

/** Compact list as the dashboard shows it: fetch-on-mount, zone/time/duration/depth. */
export function RecentActuations() {
  return (
    <div style={{ maxWidth: 640 }}>
      <IrrigationOutcomesPanel pollIntervalMs={0} zoneContexts={zoneContexts} />
    </div>
  );
}

/** Advanced view via the ⚙ popover: status badges, confirmations, failure detail. */
export function AdvancedView() {
  return (
    <div style={{ maxWidth: 640 }}>
      <AutoAdvanced>
        <IrrigationOutcomesPanel response={controlledResponse} zoneContexts={zoneContexts} />
      </AutoAdvanced>
    </div>
  );
}

/** Nothing recorded yet — the quiet empty state. */
export function Empty() {
  return (
    <div style={{ maxWidth: 640 }}>
      <IrrigationOutcomesPanel
        response={{ generatedAt: new Date(now - 30_000).toISOString(), actuations: [] } as any}
      />
    </div>
  );
}
