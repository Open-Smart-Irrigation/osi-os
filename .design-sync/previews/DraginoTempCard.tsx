import React from 'react';
import { DraginoTempCard } from 'open-smart-irrigation';

// Dragino LSN50 multi-role card. The card's primary axis is which optional
// modules are enabled on the node (DS18B20 probe, OPKON dendrometer,
// Chameleon SWT array, MOD9 rain gauge + flow meter) — each cell shows one
// realistic field configuration. Fixtures modeled on DraginoTempCard.test.tsx.
const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const base = {
  type_id: 'DRAGINO_LSN50',
  dendro_enabled: 0,
  temp_enabled: 0,
  rain_gauge_enabled: 0,
  flow_meter_enabled: 0,
  chameleon_enabled: 0,
};

// DS18B20 soil-temperature probe install.
const temperatureProbe = {
  ...base,
  deveui: 'A84041B2C1867F04',
  name: 'Soil Temp — Row 2',
  last_seen: minutesAgo(6),
  temp_enabled: 1,
  latest_data: {
    ext_temperature_c: 23.9,
    bat_v: 3.58,
  },
} as any;

// Calibrated dendrometer reporting stem change against its baseline.
const dendroStemChange = {
  ...base,
  deveui: 'A84041A75D5E7CFB',
  name: 'Dendro — Apple 12',
  last_seen: minutesAgo(11),
  dendro_enabled: 1,
  dendro_stroke_mm: 11,
  latest_data: {
    dendro_valid: 1,
    dendro_position_raw_mm: 6.42,
    dendro_position_mm: 6.42,
    dendro_stem_change_um: -42,
    dendro_mode_used: 'ratio_mod3',
    dendro_ratio: 0.584,
    bat_v: 3.41,
  },
} as any;

// Recalibrated device waiting for its first valid uplink to set the new zero.
const dendroAwaitingBaseline = {
  ...base,
  deveui: 'A84041A75D5E81D0',
  name: 'Dendro — Apple 17',
  last_seen: minutesAgo(25),
  dendro_enabled: 1,
  dendro_baseline_pending: 1,
  dendro_stroke_mm: 11,
  latest_data: {
    dendro_valid: 1,
    dendro_position_raw_mm: 5.87,
    dendro_position_mm: 5.87,
    dendro_stem_change_um: null,
    dendro_mode_used: 'ratio_mod3',
    dendro_ratio: 0.534,
    bat_v: 3.52,
  },
} as any;

// Chameleon SWT array on I2C: three channels at staggered depths.
const chameleonArray = {
  ...base,
  deveui: 'A84041C9E186A2B7',
  name: 'Chameleon — Kaba Block',
  last_seen: minutesAgo(14),
  chameleon_enabled: 1,
  chameleon_swt1_depth_cm: 15,
  chameleon_swt2_depth_cm: 30,
  chameleon_swt3_depth_cm: 60,
  latest_data: {
    swt_1: 24.3,
    swt_2: 31.9,
    swt_3: 45.2,
    chameleon_i2c_missing: 0,
    chameleon_timeout: 0,
    bat_v: 3.49,
  },
} as any;

// MOD9 counter node: Davis rain gauge on count1 + GWF flow meter on count2.
const rainAndFlow = {
  ...base,
  deveui: 'A84041D4F1868E19',
  name: 'Pump House Counter',
  last_seen: minutesAgo(2),
  rain_gauge_enabled: 1,
  flow_meter_enabled: 1,
  latest_data: {
    rain_mm_today: 6.2,
    rain_mm_delta: 0.8,
    rain_mm_per_10min: 0.4,
    rain_delta_status: null,
    flow_liters_today: 340,
    flow_liters_delta: 45,
    flow_liters_per_10min: 22,
    flow_delta_status: null,
    counter_interval_seconds: 1200,
    bat_v: 3.62,
  },
} as any;

// Dendrometer hardware fault (out-of-range ADC) with a battery near cutoff —
// the stem-change tile switches to the error surface and the battery tile
// turns red.
const dendroSensorError = {
  ...base,
  deveui: 'A84041A75D5E90AA',
  name: 'Dendro — Apple 03',
  last_seen: minutesAgo(95),
  dendro_enabled: 1,
  dendro_stroke_mm: 11,
  latest_data: {
    dendro_valid: 0,
    dendro_position_raw_mm: null,
    dendro_position_mm: null,
    dendro_stem_change_um: null,
    bat_v: 2.81,
  },
} as any;

export function TemperatureProbe() {
  return (
    <div style={{ maxWidth: 400 }}>
      <DraginoTempCard device={temperatureProbe} onUpdate={() => {}} />
    </div>
  );
}

export function DendrometerStemChange() {
  return (
    <div style={{ maxWidth: 400 }}>
      <DraginoTempCard device={dendroStemChange} onUpdate={() => {}} />
    </div>
  );
}

export function DendroAwaitingBaseline() {
  return (
    <div style={{ maxWidth: 400 }}>
      <DraginoTempCard device={dendroAwaitingBaseline} onUpdate={() => {}} />
    </div>
  );
}

export function ChameleonArray() {
  return (
    <div style={{ maxWidth: 400 }}>
      <DraginoTempCard device={chameleonArray} onUpdate={() => {}} />
    </div>
  );
}

export function RainAndFlow() {
  return (
    <div style={{ maxWidth: 400 }}>
      <DraginoTempCard device={rainAndFlow} onUpdate={() => {}} />
    </div>
  );
}

export function DendroSensorError() {
  return (
    <div style={{ maxWidth: 400 }}>
      <DraginoTempCard device={dendroSensorError} onUpdate={() => {}} />
    </div>
  );
}
