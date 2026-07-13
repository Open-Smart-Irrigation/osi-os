import React from 'react';
import { KiwiSensorCard } from 'open-smart-irrigation';

// KIWI soil sensor card. Static from props; history monitor opens on click
// only. Fixtures modeled on KiwiSensorCard.test.tsx — SWT in kPa (20–35 is a
// comfortable range, >60 reads dry), probe depths in cm surface in the tile
// labels.
const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const allSensors = {
  deveui: 'A840416A21867E9B',
  name: 'Soil North',
  type_id: 'KIWI_SENSOR',
  last_seen: minutesAgo(5),
  soilMoistureProbeDepths: { swt_1: 30, swt_2: 60 },
  latest_data: {
    swt_1: 22.4,
    swt_2: 31.8,
    light_lux: 41200,
    ambient_temperature: 24.6,
    relative_humidity: 58,
    bat_pct: 92,
  },
} as any;

// Single-channel install: only SWT 1 wired, temperature/humidity reporting
// not enabled — the card hides SWT 2 + light and falls back to N/A for the
// ambient tiles.
const tensionOnly = {
  deveui: 'A840416A2186331C',
  name: 'Soil East — Row 4',
  type_id: 'KIWI_SENSOR',
  last_seen: minutesAgo(18),
  soilMoistureProbeDepths: { swt_1: 45 },
  latest_data: {
    swt_1: 18.2,
    swt_2: null,
    ambient_temperature: null,
    relative_humidity: null,
    bat_pct: 67,
  },
} as any;

const drySoil = {
  deveui: 'A840416A21869F02',
  name: 'Soil South — Slope',
  type_id: 'KIWI_SENSOR',
  last_seen: minutesAgo(41),
  soilMoistureProbeDepths: { swt_1: 30, swt_2: 60 },
  latest_data: {
    swt_1: 78.5,
    swt_2: 85.1,
    light_lux: 68400,
    ambient_temperature: 31.2,
    relative_humidity: 34,
    bat_pct: 11,
  },
} as any;

export function AllSensors() {
  return (
    <div style={{ maxWidth: 400 }}>
      <KiwiSensorCard device={allSensors} onUpdate={() => {}} />
    </div>
  );
}

export function TensionOnly() {
  return (
    <div style={{ maxWidth: 400 }}>
      <KiwiSensorCard device={tensionOnly} onUpdate={() => {}} />
    </div>
  );
}

export function DrySoilLowBattery() {
  return (
    <div style={{ maxWidth: 400 }}>
      <KiwiSensorCard device={drySoil} onUpdate={() => {}} />
    </div>
  );
}
