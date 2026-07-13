import React from 'react';
import { IrrigationZoneCard } from 'open-smart-irrigation';

// Realistic zone + device fixtures modeled on the app's own test data
// (IrrigationZoneCardData.test.tsx). Environment/recommendation fetches 404
// in a static preview — the card renders its fallback states for those
// sections, which is the honest offline look.
const zone = {
  id: 12,
  name: 'Orchard — Zone B',
  device_count: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  schedule: null,
  crop_type: 'apple',
  soil_type: 'loam',
  area_m2: 1200,
} as any;

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const kiwiSensor = {
  deveui: 'A840416A21867E9B',
  name: 'Soil North',
  type_id: 'KIWI_SENSOR',
  last_seen: minutesAgo(5),
  latest_data: {
    swt_1: 22.4,
    swt_2: 31.8,
    ambient_temperature: 24.6,
    relative_humidity: 58,
    light_lux: 41200,
  },
} as any;

const dendroDevice = {
  deveui: 'A84041A75D5E7CFB',
  name: 'Dendro 1',
  type_id: 'DRAGINO_LSN50',
  last_seen: minutesAgo(12),
  dendro_enabled: 1,
  latest_data: {
    ext_temperature_c: 23.9,
    bat_v: 3.58,
  },
} as any;

// The card mounts collapsed (internal useState, no prop). Drive real clicks
// on its chevron toggles after mount so the preview shows the expanded card —
// the same DOM a user sees, not a reimplementation.
function AutoExpand({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const clickCollapsedToggles = () => {
      const spans = ref.current?.querySelectorAll('button span[style*="rotate(-90deg)"]') ?? [];
      let clicked = false;
      spans.forEach((s) => {
        const btn = (s as HTMLElement).closest('button');
        if (btn) {
          btn.click();
          clicked = true;
        }
      });
      return clicked;
    };
    clickCollapsedToggles();
    // second pass: the devices toggle only exists once the zone is expanded
    const t = setTimeout(clickCollapsedToggles, 50);
    return () => clearTimeout(t);
  }, []);
  return <div ref={ref}>{children}</div>;
}

export function ZoneWithDevices() {
  return (
    <div style={{ maxWidth: 900 }}>
      <AutoExpand>
      <IrrigationZoneCard
        zone={zone}
        devices={[kiwiSensor, dendroDevice]}
        unassignedDevices={[]}
        onUpdate={() => {}}
        allZones={[
          { id: 12, name: 'Orchard — Zone B' },
          { id: 13, name: 'Vineyard — Zone C' },
        ]}
      />
      </AutoExpand>
    </div>
  );
}

export function EmptyZone() {
  return (
    <div style={{ maxWidth: 900 }}>
      <AutoExpand>
      <IrrigationZoneCard
        zone={{ ...zone, id: 13, name: 'Vineyard — Zone C', device_count: 0 }}
        devices={[]}
        unassignedDevices={[kiwiSensor]}
        onUpdate={() => {}}
      />
      </AutoExpand>
    </div>
  );
}
