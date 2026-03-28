// The specific supported hardware types
export type DeviceType = 'KIWI_SENSOR' | 'STREGA_VALVE' | 'DRAGINO_LSN50';
export type Lsn50Mode = 'MOD1' | 'MOD2' | 'MOD3' | 'MOD4' | 'MOD5' | 'MOD6' | 'MOD7' | 'MOD8' | 'MOD9';
export type StregaModel = 'STANDARD' | 'MOTORIZED';

export interface Device {
  deveui: string;       // Unique LoRaWAN ID
  name: string;         // User-given name (e.g., "North Field")
  type_id: DeviceType;
  last_seen?: string | null;    // ISO Date string

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
    lsn50_mode_code?: number | null;
    lsn50_mode_label?: Lsn50Mode | string | null;
    lsn50_mode_observed_at?: string | null;
  };

  // Only for Valves
  target_state?: 'OPEN' | 'CLOSED';
  current_state?: 'OPEN' | 'CLOSED';

  // Per-device opt-in flags for optional LSN50 sensors
  dendro_enabled?: number;      // 0 = disabled (default), 1 = OPKON dendrometer on ADC
  temp_enabled?: number;        // 0 = disabled (default), 1 = DS18B20 probe on temp input
  is_reference_tree?: number;   // 0 = monitored/irrigated, 1 = control/reference tree
  device_mode?: number | null;  // Requested/configured LSN50 mode on the edge
  strega_model?: StregaModel | string | null;

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
  | 'SWT_1' | 'SWT_2' | 'SWT_3' | 'SWT_AVG'         // Soil Water Tension (kPa) — v4 names
  | 'SWT_WM1' | 'SWT_WM2' | 'SWT_WM3'               // Legacy SWT names (backward compat)
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
  response_mode?: string | null;
  responseMode?: string | null;
}

export interface UpdateIrrigationScheduleRequest {
  trigger_metric: TriggerMetric;
  threshold_kpa: number;
  enabled: boolean;
  duration_minutes?: number;
  response_mode?: string;
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

  // Zone metadata (available after DB migration + Node-RED config endpoint)
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  phenological_stage?: string | null;
  crop_type?: string | null;
  variety?: string | null;
  soil_type?: string | null;
  irrigation_method?: string | null;
  notes?: string | null;
  calibration_key?: string | null;

  // Compat aliases (server uses camelCase)
  phenologicalStage?: string | null;
  calibrationKey?: string | null;
  cropType?: string | null;
  soilType?: string | null;
  irrigationMethod?: string | null;
  variety_compat?: string | null;
}

export interface CreateZoneRequest {
  name: string;
}

// ---- Dendrometer analytics types ----

export type StressLevel = 'none' | 'mild' | 'moderate' | 'significant' | 'severe';
export type IrrigationAction =
  | 'decrease_20'
  | 'decrease_10'
  | 'maintain'
  | 'maintain_rain_suppression'
  | 'maintain_recovery_hold'
  | 'increase_10'
  | 'increase_20'
  | 'emergency_irrigate';
export type DataQuality = 'good' | 'reduced' | 'unreliable' | 'insufficient';

/** One computed day of dendrometer indicators for a single device */
export interface DendroDaily {
  id: number;
  deveui: string;
  date: string;                            // YYYY-MM-DD
  // v3 fields
  d_max_um: number | null;
  d_min_um: number | null;
  mds_um: number | null;                   // Maximum Daily Shrinkage
  tgr_um: number | null;                   // Trunk Growth Rate (vs yesterday's D_max)
  tgr_smoothed_um: number | null;          // 3-day smoothed TGR
  twd_um: number | null;                   // Tree Water Deficit (30-day peak − today D_max)
  dr_um: number | null;                    // Daily Recovery (today D_max − yesterday D_min)
  recovery_delta_um: number | null;        // 5-day avg DR − avg MDS
  signal_intensity: number | null;         // MDS_tree / MDS_reference (v3)
  // v4 fields
  twd_night_um: number | null;             // Pre-dawn TWD (D_max_running − D_max)
  twd_day_um: number | null;               // Midday TWD (D_max_running − D_min)
  twd_norm_night: number | null;           // TWDnorm pre-dawn (TWD_night / MDS_max_reference)
  twd_norm_day: number | null;             // TWDnorm midday
  mds_norm: number | null;                 // MDSnorm (MDS / MDS_max_reference)
  recovery_ratio: number | null;           // DR / MDS (1.0 = full recovery)
  recovery_ratio_smoothed: number | null;  // 3-day smoothed Recovery Ratio
  r_delta_5day: number | null;             // 5-day avg(DR) − avg(MDS)
  delta_twd_smoothed: number | null;       // 3-day smoothed ΔTWD
  d_max_running_um: number | null;         // All-time zero-growth peak D_max (TWD reference)
  d_max_time: string | null;               // Local time of D_max (HH:MM)
  d_min_time: string | null;               // Local time of D_min (HH:MM)
  twd_episode_active: number;              // 0 or 1
  twd_episode_start: string | null;        // YYYY-MM-DD when current episode began
  twd_episode_max_um: number | null;       // Peak TWD in current episode (µm)
  // v5 canonical fields
  envelope_ref_um: number | null;
  twd_method: string | null;
  confidence_score: number | null;
  qa_flags_json: string | null;
  low_confidence_day: number;
  tree_state_v5: StressLevel;
  // Baseline info (JOINed from dendro_baselines)
  baseline_complete: number;               // 0 = collecting, 1 = established
  baseline_days: number | null;            // Days counted toward 14-day baseline
  mds_max_reference_um: number | null;     // 90th-pct MDS from baseline period (µm)
  // meta
  stress_level: StressLevel;
  data_quality: DataQuality;
  valid_readings_count: number;
  computed_at: string;
}

/** Zone-level daily irrigation recommendation */
export type SdVpdStatus = 'coupled' | 'decoupled' | 'insufficient_data';

export interface ZoneRecommendationDiagnostics {
  vpdOverrideSummary: {
    downgradedTreeCount: number;
    upgradedTreeCount: number;
  };
  sdVpdSummary: {
    baselineR2: number | null;
    rolling14dR2: number | null;
    status: SdVpdStatus;
    comparableTreeCount: number;
    decoupledTreeCount: number;
  };
}

export interface ZoneRecommendation {
  id: number;
  zone_id: number;
  date: string;
  zone_stress_summary: StressLevel;
  rainfall_mm: number;
  water_delivered_liters: number;
  irrigation_action: IrrigationAction;
  action_reasoning: string;
  recommendation_json: string | null;
  diagnostics: ZoneRecommendationDiagnostics | null;
  computed_at: string;
  // v4 fields
  rain_suppression_active: number;        // 0 or 1
  recovery_verification_active: number;   // 0 or 1
  vpd_max_kpa: number | null;
  vpd_source: string | null;              // 'local_sensor' | 'open_meteo' | 'unavailable'
  // zone quality metadata
  usable_tree_count: number;
  low_confidence_tree_count: number;
  outlier_filtered_tree_count: number;
  zone_confidence_score: number | null;
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
