import React from 'react';
import { SenseCapWeatherCard } from 'open-smart-irrigation';

// SenseCAP S2120 all-in-one weather station card. Fully static from props —
// the monitors (wind rose, rain history) only open on click, so no API routes
// are needed. Fixtures modeled on SenseCapWeatherCard.test.tsx.
const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const zones = [
  { id: 12, name: 'Orchard — Zone B' },
  { id: 13, name: 'Vineyard — Zone C' },
];

const fairWeather = {
  deveui: '2CF7F1C044300A1B',
  name: 'Weather Station — Orchard',
  type_id: 'SENSECAP_S2120',
  last_seen: minutesAgo(4),
  zone_ids: [12, 13],
  zone_names: ['Orchard — Zone B', 'Vineyard — Zone C'],
  latest_data: {
    ambient_temperature: 24.6,
    relative_humidity: 58,
    wind_speed_mps: 3.2,
    wind_gust_mps: 5.8,
    wind_direction_deg: 225,
    rain_mm_today: 0.0,
    rain_mm_delta: 0,
    rain_mm_per_10min: 0,
    rain_mm_per_hour: 0,
    barometric_pressure_hpa: 1018,
    light_lux: 41200,
    uv_index: 6.2,
    bat_pct: 88,
    counter_interval_seconds: 600,
    rain_delta_status: null,
  },
} as any;

const stormy = {
  deveui: '2CF7F1C0443017D4',
  name: 'Weather Station — Hilltop',
  type_id: 'SENSECAP_S2120',
  last_seen: minutesAgo(9),
  zone_ids: [13],
  zone_names: ['Vineyard — Zone C'],
  latest_data: {
    ambient_temperature: 14.8,
    relative_humidity: 96,
    wind_speed_mps: 9.4,
    wind_gust_mps: 17.1,
    wind_direction_deg: 292,
    rain_mm_today: 23.6,
    rain_mm_delta: 2.4,
    rain_mm_per_10min: 1.6,
    rain_mm_per_hour: 9.8,
    barometric_pressure_hpa: 989,
    light_lux: 3200,
    uv_index: 0.4,
    bat_pct: 14,
    counter_interval_seconds: 600,
    rain_delta_status: null,
  },
} as any;

// Freshly provisioned station: joined but no uplink decoded yet. Every metric
// renders its em-dash fallback and the footer shows no battery — the honest
// day-one look.
const awaitingFirstUplink = {
  deveui: '2CF7F1C04430221E',
  name: 'Weather Station — New',
  type_id: 'SENSECAP_S2120',
  last_seen: null,
  zone_ids: [],
  zone_names: [],
  latest_data: {},
} as any;

export function FullWeather() {
  return (
    <div style={{ maxWidth: 440 }}>
      <SenseCapWeatherCard device={fairWeather} onUpdate={() => {}} allZones={zones} />
    </div>
  );
}

export function StormyLowBattery() {
  return (
    <div style={{ maxWidth: 440 }}>
      <SenseCapWeatherCard device={stormy} onUpdate={() => {}} allZones={zones} />
    </div>
  );
}

export function AwaitingFirstUplink() {
  return (
    <div style={{ maxWidth: 440 }}>
      <SenseCapWeatherCard device={awaitingFirstUplink} onUpdate={() => {}} allZones={zones} />
    </div>
  );
}
