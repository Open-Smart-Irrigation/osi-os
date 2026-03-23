// The specific supported hardware types
export type DeviceType = 'KIWI_SENSOR' | 'STREGA_VALVE' | 'DRAGINO_LSN50';

export interface Device {
  deveui: string;       // Unique LoRaWAN ID
  name: string;         // User-given name (e.g., "North Field")
  type_id: DeviceType;
  last_seen: string;    // ISO Date string

  // Specific data payload matching Node-RED output
  latest_data: {
    swt_wm1?: number;           // Soil Water Tension 1 (kPa) - 0 to 200
    swt_wm2?: number;           // Soil Water Tension 2 (kPa)
    light_lux?: number;         // Light intensity
    ambient_temperature?: number;
    relative_humidity?: number;
    ext_temperature_c?: number; // DS18B20 probe temperature (°C) — LSN50
    bat_v?: number;             // Battery voltage (V) — LSN50
    adc_ch0v?: number;          // ADC CH0 raw voltage (V) — LSN50 analog input
    // Dendrometer (OPKON SLPS linear potentiometer via LSN50 ADC)
    dendro_position_mm?: number | null; // Calculated trunk position (mm), 0–25 range
    dendro_valid?: number | null;       // 1 = valid reading, 0 = out-of-range/error
    dendro_delta_mm?: number | null;    // Change from previous reading (mm); null on first uplink
  };

  // Only for Valves
  target_state?: 'OPEN' | 'CLOSED';
  current_state?: 'OPEN' | 'CLOSED';

  // Per-device opt-in flags for optional LSN50 sensors
  dendro_enabled?: number;      // 0 = disabled (default), 1 = OPKON dendrometer on ADC
  temp_enabled?: number;        // 0 = disabled (default), 1 = DS18B20 probe on temp input
  is_reference_tree?: number;   // 0 = monitored/irrigated, 1 = control/reference tree

  // Irrigation zone assignment
  irrigation_zone_id?: number | null;
}

export interface User {
  username: string;
  token: string;
}

export interface DeviceCatalogItem {
  id: DeviceType;
  name: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface RegisterResponse {
  success: boolean;
}

export interface AddDeviceRequest {
  deveui: string;
  name: string;
  type_id: DeviceType;
  appkey?: string;
}

export interface ValveActionRequest {
  action: 'OPEN' | 'CLOSE';
}

// ---- Irrigation schedule types ----
export type TriggerMetric =
  | 'SWT_WM1' | 'SWT_WM2' | 'SWT_WM3' | 'SWT_AVG'  // Soil Water Tension (kPa)
  | 'VWC'                                             // Volumetric Water Content (%)
  | 'DENDRO';                                         // Dendrometer stress-based

export type SchedulerType = 'SWT' | 'VWC' | 'DENDRO';

/** Dendrometer stress threshold (threshold_kpa encodes this for DENDRO trigger) */
export type DendroStressThreshold = 'mild' | 'moderate' | 'significant' | 'severe';

export interface IrrigationSchedule {
  irrigation_zone_id: number;
  trigger_metric: TriggerMetric;
  threshold_kpa: number;
  enabled: boolean;
  duration_minutes?: number;
  last_triggered_at?: string | null;
}

export interface UpdateIrrigationScheduleRequest {
  trigger_metric: TriggerMetric;
  threshold_kpa: number;
  enabled: boolean;
  duration_minutes?: number;
}

// ---- Irrigation zone types ----
export interface IrrigationZone {
  id: number;
  name: string;
  device_count: number;
  created_at: string;
  updated_at: string;

  // Returned by GET /api/irrigation-zones (your Node-RED flow adds this)
  schedule: IrrigationSchedule | null;
}

export interface CreateZoneRequest {
  name: string;
}

// ---- Dendrometer analytics types ----

export type StressLevel = 'none' | 'mild' | 'moderate' | 'significant' | 'severe';
export type IrrigationAction = 'decrease_10' | 'maintain' | 'increase_10' | 'increase_20' | 'emergency_irrigate';
export type DataQuality = 'good' | 'unreliable' | 'insufficient';

/** One computed day of dendrometer indicators for a single device */
export interface DendroDaily {
  id: number;
  deveui: string;
  date: string;                      // YYYY-MM-DD
  d_max_um: number | null;
  d_min_um: number | null;
  mds_um: number | null;             // Maximum Daily Shrinkage
  tgr_um: number | null;             // Trunk Growth Rate (vs yesterday's D_max)
  tgr_smoothed_um: number | null;    // 3-day smoothed TGR
  twd_um: number | null;             // Tree Water Deficit (30-day peak − today D_max)
  dr_um: number | null;              // Daily Recovery (today D_max − yesterday D_min)
  recovery_delta_um: number | null;  // 7-day avg DR − 7-day avg MDS
  signal_intensity: number | null;   // MDS_tree / MDS_reference
  stress_level: StressLevel;
  data_quality: DataQuality;
  valid_readings_count: number;
  computed_at: string;
}

/** Zone-level daily irrigation recommendation */
export interface ZoneRecommendation {
  id: number;
  zone_id: number;
  date: string;
  zone_stress_summary: StressLevel;
  rainfall_mm: number;
  water_delivered_liters: number;
  irrigation_action: IrrigationAction;
  action_reasoning: string;
  computed_at: string;
}

/** One raw dendrometer reading from dendrometer_readings table */
export interface DendroReading {
  id: number;
  deveui: string;
  position_um: number;
  adc_v: number;
  bat_v: number | null;
  is_valid: number;
  is_outlier: number;
  recorded_at: string;
}
