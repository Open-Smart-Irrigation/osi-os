import React from 'react';
import { ScheduleSection } from 'open-smart-irrigation';

// The shim's canned zones cover an SWT schedule (zone 12) and no schedule
// (zone 13). Add zone 14 with a dendrometer schedule so the DENDRO form —
// sensitivity + response-mode selects — gets a story too. threshold_kpa 2
// encodes "moderate" sensitivity (see DENDRO_STRESS_FROM_NUM in the source).
(window as any).__dsApiRoutes ??= [];
(window as any).__dsApiRoutes.push([
  /^\/api\/irrigation-zones$/,
  [
    {
      id: 12, name: 'Orchard — Zone B', device_count: 2,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: new Date().toISOString(),
      schedule: {
        irrigation_zone_id: 12, trigger_metric: 'SWT_1', threshold_kpa: 30,
        enabled: true, duration_minutes: 20, response_mode: null,
      },
    },
    {
      id: 13, name: 'Vineyard — Zone C', device_count: 0,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: new Date().toISOString(),
      schedule: null,
    },
    {
      id: 14, name: 'Cherry Block — Zone D', device_count: 3,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: new Date().toISOString(),
      schedule: {
        irrigation_zone_id: 14, trigger_metric: 'DENDRO', threshold_kpa: 2,
        enabled: true, duration_minutes: 25, responseMode: 'proportional',
      },
    },
  ],
]);

// The section mounts collapsed (internal useState). Click its chevron toggle
// after mount — same pattern as IrrigationZoneCard's AutoExpand.
function AutoExpand({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const clickCollapsedToggles = () => {
      const spans = ref.current?.querySelectorAll('button span[style*="rotate(-90deg)"]') ?? [];
      spans.forEach((s) => (s as HTMLElement).closest('button')?.click());
    };
    clickCollapsedToggles();
    const t = setTimeout(clickCollapsedToggles, 50);
    return () => clearTimeout(t);
  }, []);
  return <div ref={ref}>{children}</div>;
}

// In the app the section sits at the bottom of a zone card — give it the same
// card surround so the top border divider reads correctly.
function CardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '4px 20px 20px',
        maxWidth: 680,
      }}
    >
      {children}
    </div>
  );
}

/** Zone 12's saved soil-moisture schedule: Sensor 1, 30 kPa, 20 min, enabled. */
export function SwtSchedule() {
  return (
    <CardFrame>
      <AutoExpand>
        <ScheduleSection zoneId={12} zoneName="Orchard — Zone B" />
      </AutoExpand>
    </CardFrame>
  );
}

/** Zone 14's dendrometer schedule: moderate sensitivity, proportional response. */
export function DendroSchedule() {
  return (
    <CardFrame>
      <AutoExpand>
        <ScheduleSection zoneId={14} zoneName="Cherry Block — Zone D" />
      </AutoExpand>
    </CardFrame>
  );
}

/** Default mount state: the section header collapsed to a single toggle row. */
export function CollapsedDefault() {
  return (
    <CardFrame>
      <ScheduleSection zoneId={13} zoneName="Vineyard — Zone C" />
    </CardFrame>
  );
}
