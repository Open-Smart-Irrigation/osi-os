import React from 'react';
import { LoRainGaugeCard } from 'open-smart-irrigation';

// Aquascope LoRain tipping-bucket rain gauge card. Static from props; the
// rainfall history monitor opens on click only. Fixtures modeled on
// LoRainGaugeCard.test.tsx — 0.2 mm per bucket tip, 10-minute uplinks.
const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const activeRain = {
  deveui: '70B3D57ED0068A22',
  name: 'Rain Gauge — Orchard',
  type_id: 'AQUASCOPE_LORAIN',
  last_seen: minutesAgo(3),
  latest_data: {
    rain_mm_delta: 1.2,
    rain_tips_delta: 6,
    rain_mm_today: 8.4,
    rain_mm_per_10min: 1.2,
    rain_mm_per_hour: 7.2,
    counter_interval_seconds: 600,
    rain_delta_status: null,
    ambient_temperature: 16.4,
    bat_v: 3.6,
  },
} as any;

const dryDay = {
  deveui: '70B3D57ED0069135',
  name: 'Rain Gauge — Vineyard',
  type_id: 'AQUASCOPE_LORAIN',
  last_seen: minutesAgo(7),
  latest_data: {
    rain_mm_delta: 0,
    rain_tips_delta: 0,
    rain_mm_today: 0,
    rain_mm_per_10min: 0,
    rain_mm_per_hour: 0,
    counter_interval_seconds: 600,
    rain_delta_status: null,
    ambient_temperature: 27.8,
    bat_v: 3.4,
  },
} as any;

// First uplink after provisioning: no deltas computable yet, so every tile
// shows its em-dash / waiting fallback — the honest day-one look. The rain
// keys must be OMITTED, not null: formatNumber does Number(value), and
// Number(null) is a finite 0 that would render as a misleading "0.0 mm".
const firstUplink = {
  deveui: '70B3D57ED006B4C9',
  name: 'Rain Gauge — New',
  type_id: 'AQUASCOPE_LORAIN',
  last_seen: minutesAgo(1),
  latest_data: {
    rain_delta_status: 'no_rain_sensor',
    ambient_temperature: 21.3,
    bat_v: 3.7,
  },
} as any;

export function ActiveRain() {
  return (
    <div style={{ maxWidth: 440 }}>
      <LoRainGaugeCard device={activeRain} />
    </div>
  );
}

export function DryDay() {
  return (
    <div style={{ maxWidth: 440 }}>
      <LoRainGaugeCard device={dryDay} />
    </div>
  );
}

export function FirstUplink() {
  return (
    <div style={{ maxWidth: 440 }}>
      <LoRainGaugeCard device={firstUplink} />
    </div>
  );
}
