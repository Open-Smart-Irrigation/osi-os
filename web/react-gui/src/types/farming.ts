// The specific supported hardware types
export type DeviceType = 'KIWI_SENSOR' | 'STREGA_VALVE' | 'DRAGINO_LSN50' | 'TEKTELIC_CLOVER' | 'SENSECAP_S2120';
export type Lsn50Mode = 'MOD1' | 'MOD2' | 'MOD3' | 'MOD4' | 'MOD5' | 'MOD6' | 'MOD7' | 'MOD8' | 'MOD9';
export type StregaModel = 'STANDARD' | 'MOTORIZED';
export type DendroModeUsed = 'legacy_single_adc' | 'ratio_mod3';

export interface Device {
  deveui: string;       // Unique LoRaWAN ID
  name: string;         // User-given name (e.g., "North Field")
  type_id: DeviceType;
  last_seen?: string | null;    // ISO Date string
  soilMoistureProbeDepths?: Record<string, number>;
  soilMoistureProbeDepthsConfigured?: boolean;
  soil_moisture_probe_depths_json?: Record<string, number> | null;
  soil_moisture_probe_depths_configured?: number | boolean | null;

  // Specific data payload matching Node-RED output
  latest_data: {
    swt_wm1?: number;           // Legacy Kiwi SWT channel 1 alias (kPa)
    swt_wm2?: number;           // Legacy Kiwi SWT channel 2 alias (kPa)
    swt_1?: number | null;      // Canonical SWT channel 1 (kPa)
    swt_2?: number | null;      // Canonical SWT channel 2 (kPa)
    swt_3?: number | null;      // Canonical SWT channel 3 (kPa)
    light_lux?: number;         // Light intensity
    ambient_temperature?: number;
    relative_humidity?: number;
    ext_temperature_c?: number; // DS18B20 probe temperature (°C) — LSN50
    bat_v?: number;             // Battery voltage (V) — LSN50
    adc_ch0v?: number;          // ADC CH0 raw voltage (V) — LSN50 analog input
    adc_ch1v?: number | null;   // ADC CH1 reference voltage (V) — LSN50 MOD3 ratio path
    // Dendrometer (OPKON SLPS linear potentiometer via LSN50 ADC)
    dendro_position_raw_mm?: number | null; // Unclamped engineering position in mm
    dendro_position_mm?: number | null; // Calculated trunk position (mm), 0–25 range
    dendro_valid?: number | null;       // 1 = valid reading, 0 = out-of-range/error
    dendro_delta_mm?: number | null;    // Change from previous reading (mm); null on first uplink
    dendro_stem_change_um?: number | null; // Comparable stem change relative to the device baseline (µm)
    dendro_ratio?: number | null;       // MOD3 ratio (ADC_CH0V / ADC_CH1V) when available
    dendro_mode_used?: DendroModeUsed | string | null;
    dendro_saturated?: number | null;
    dendro_saturation_side?: string | null;
    lsn50_mode_code?: number | null;
    lsn50_mode_label?: Lsn50Mode | string | null;
    lsn50_mode_observed_at?: string | null;
    // MOD9: rain gauge (Davis 6466M, 0.2 mm/tip) + flow meter (GWF Unico2, 1 pulse = 1 L)
    rain_count_cumulative?: number | null;
    rain_tips_delta?: number | null;
    rain_mm_delta?: number | null;
    rain_mm_per_hour?: number | null;
    rain_mm_per_10min?: number | null;
    rain_mm_today?: number | null;
    rain_delta_status?: string | null;
    flow_count_cumulative?: number | null;
    flow_pulses_delta?: number | null;
    flow_liters_delta?: number | null;
    flow_liters_per_min?: number | null;
    flow_liters_per_10min?: number | null;
    flow_liters_today?: number | null;
    flow_delta_status?: string | null;
    counter_interval_seconds?: number | null;
    // Chameleon SWT array readings via LSN50
    chameleon_reading_id?: number | null;
    chameleon_payload_b64?: string | null;
    chameleon_payload_version?: number | null;
    chameleon_status_flags?: number | null;
    chameleon_i2c_missing?: number | null;
    chameleon_timeout?: number | null;
    chameleon_temp_fault?: number | null;
    chameleon_id_fault?: number | null;
    chameleon_ch1_open?: number | null;
    chameleon_ch2_open?: number | null;
    chameleon_ch3_open?: number | null;
    chameleon_temp_c?: number | null;
    chameleon_r1_ohm_comp?: number | null;
    chameleon_r2_ohm_comp?: number | null;
    chameleon_r3_ohm_comp?: number | null;
    chameleon_r1_ohm_raw?: number | null;
    chameleon_r2_ohm_raw?: number | null;
    chameleon_r3_ohm_raw?: number | null;
    chameleon_array_id?: string | null;
    // SenseCAP S2120 weather station fields
    barometric_pressure_hpa?: number | null;
    wind_speed_mps?: number | null;
    wind_direction_deg?: number | null;
    wind_gust_mps?: number | null;
    uv_index?: number | null;
    rain_gauge_cumulative_mm?: number | null;
    bat_pct?: number | null;
  };

  // Only for Valves
  target_state?: 'OPEN' | 'CLOSED';
  current_state?: 'OPEN' | 'CLOSED';

  // Per-device opt-in flags for optional LSN50 sensors
  dendro_enabled?: number;      // 0 = disabled (default), 1 = OPKON dendrometer on ADC
  temp_enabled?: number;        // 0 = disabled (default), 1 = DS18B20 probe on temp input
  rain_gauge_enabled?: number;  // 0 = disabled (default), 1 = rain gauge on count1 (MOD9)
  flow_meter_enabled?: number;  // 0 = disabled (default), 1 = flow meter on count2 (MOD9)
  chameleon_enabled?: number;   // 0 = disabled (default), 1 = Chameleon SWT array on I2C
  is_reference_tree?: number;   // 0 = monitored/irrigated, 1 = control/reference tree
  device_mode?: number | null;  // Requested/configured LSN50 mode on the edge
  dendro_force_legacy?: number | null;
  dendro_stroke_mm?: number | null;
  dendro_ratio_at_retracted?: number | null;
  dendro_ratio_at_extended?: number | null;
  dendro_ratio_zero?: number | null;
  dendro_ratio_span?: number | null;
  dendro_invert_direction?: number | null;
  dendro_baseline_pending?: number | null;
  chameleon_swt1_depth_cm?: number | null;
  chameleon_swt2_depth_cm?: number | null;
  chameleon_swt3_depth_cm?: number | null;
  chameleon_swt1_a?: number | null;
  chameleon_swt1_b?: number | null;
  chameleon_swt1_c?: number | null;
  chameleon_swt2_a?: number | null;
  chameleon_swt2_b?: number | null;
  chameleon_swt2_c?: number | null;
  chameleon_swt3_a?: number | null;
  chameleon_swt3_b?: number | null;
  chameleon_swt3_c?: number | null;
  strega_model?: StregaModel | string | null;

  // Irrigation zone assignment
  irrigation_zone_id?: number | null;
  // Multi-zone assignment — populated for SENSECAP_S2120 only
  zone_ids?: number[] | null;
  zone_names?: string[] | null;
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
  triggerMetric?: TriggerMetric;
  threshold_kpa: number;
  thresholdKpa?: number;
  enabled: boolean;
  duration_minutes?: number;
  durationMinutes?: number;
  last_triggered_at?: string | null;
  lastTriggeredAt?: string | null;
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
  deviceCount?: number;
  created_at: string;
  createdAt?: string;
  updated_at: string;
  updatedAt?: string;

  // Returned by GET /api/irrigation-zones (your Node-RED flow adds this)
  schedule: IrrigationSchedule | null;

  // Zone metadata (available after DB migration + Node-RED config endpoint)
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  gatewayDeviceEui?: string | null;
  gateway_device_eui?: string | null;
  phenological_stage?: string | null;
  crop_type?: string | null;
  variety?: string | null;
  soil_type?: string | null;
  irrigation_method?: string | null;
  area_m2?: number | null;
  irrigation_efficiency_pct?: number | null;
  scheduling_mode?: 'local' | 'server_preferred' | null;
  notes?: string | null;
  calibration_key?: string | null;
  prediction_card_enabled?: boolean | null;

  // Compat aliases (server uses camelCase)
  phenologicalStage?: string | null;
  calibrationKey?: string | null;
  cropType?: string | null;
  soilType?: string | null;
  irrigationMethod?: string | null;
  areaM2?: number | null;
  irrigationEfficiencyPct?: number | null;
  schedulingMode?: 'local' | 'server_preferred' | null;
  varietyCompat?: string | null;
  predictionCardEnabled?: boolean | null;
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
  vpd_source: string | null;              // 'local_sensor' | 'openagri' | 'open_meteo' | 'unavailable'
  // zone quality metadata
  usable_tree_count: number;
  low_confidence_tree_count: number;
  outlier_filtered_tree_count: number;
  zone_confidence_score: number | null;
}

// ── Zone Environment Summary ──────────────────────────────────────────────────

export interface ZoneEnvironmentSummary {
  zoneId: number;
  zoneName: string;
  generatedAt: string;
  location: EnvironmentLocation;
  water: WaterEnvironment;
  local: LocalEnvironment;
  online: OnlineEnvironment;
  agronomic: AgronomicEnvironment;
  forecast: ForecastEnvironment;
  display?: DisplayStatus | null;
  drift?: RecommendationDrift | null;
}

export interface DisplayStatus {
  mode: 'shared_server' | 'shared_server_stale' | 'local_fallback' | 'unlinked_local' | 'cloud_local' | string;
  schedulingMode: 'local' | 'server_preferred' | string;
  sourceLabel: string;
  sharedGeneratedAt: string | null;
  sharedObservedAt: string | null;
  lastReceivedAt: string | null;
  fallbackReason: string | null;
}

export interface RecommendationDrift {
  active: boolean;
  severity: 'low' | 'medium' | 'high' | string;
  reason: string;
  localActionCode: string | null;
  serverActionCode: string | null;
  waterNeededDeltaMm: number | null;
  next24hRainDeltaMm: number | null;
  balanceDeltaMm: number | null;
  canSwitchScheduling: boolean;
}

export interface WaterEnvironment {
  available: boolean;
  observedAt: string | null;
  areaM2: number | null;
  irrigationEfficiencyPct: number | null;
  rainTodayMm: number | null;
  irrigationTodayLiters: number | null;
  irrigationTodayNetMm: number | null;
  waterNeededTodayMm: number | null;
  balanceTodayMm: number | null;
  next24hRainMm: number | null;
  action: WaterAction | null;
  daily: WaterDay[];
  sensorHealth: SensorHealth;
}

export interface WaterAction {
  code: string;
  source: string;
  reasoning: string;
  recommendationDate: string | null;
}

export interface WaterDay {
  date: string;
  rainMm: number | null;
  irrigationLiters: number | null;
  irrigationNetMm: number | null;
  totalWaterMm: number | null;
}

export interface SensorHealth {
  sensorCount: number;
  freshSensorCount: number;
  staleSensorCount: number;
  rainGaugePresent: boolean;
  flowMeterPresent: boolean;
  warnings: string[];
}

export interface EnvironmentLocation {
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  source: 'zone' | 'gateway' | 'unavailable';
}

export interface LocalEnvironment {
  available: boolean;
  observedAt: string | null;
  sensorCount: number;
  freshSensorCount: number;
  staleSensorCount: number;
  metrics: LocalMetric[];
  devices: LocalSensorDevice[];
}

export interface LocalMetric {
  key: string;
  label: string;
  unit: string;
  mean: number;
  median: number;
  min: number;
  max: number;
  sampleCount: number;
}

export interface LocalSensorDevice {
  deviceEui: string;
  name: string;
  type: string;
  observedAt: string;
  metrics: Record<string, number>;
}

export interface OnlineEnvironment {
  available: boolean;
  source: 'openagri' | 'open_meteo' | 'unavailable';
  cacheStatus: 'live' | 'stale' | 'miss';
  observedAt: string | null;
  expiresAt: string | null;
  current: OnlineWeather | null;
}

export interface OnlineWeather {
  description: string | null;
  weatherCode: number | null;
  airTemperatureC: number | null;
  relativeHumidityPct: number | null;
  pressureHpa: number | null;
  windSpeedMps: number | null;
  windDirectionDeg: number | null;
  cloudCoverPct: number | null;
  rainMm: number | null;
  precipitationProbabilityPct: number | null;
}

export interface AgronomicEnvironment {
  preferredSource: string;
  current: AgronomicCurrent | null;
}

export interface AgronomicCurrent {
  thermodynamicSource: string;
  evapotranspirationSource: string;
  cropCoefficientSource: string;
  airTemperatureC: number | null;
  relativeHumidityPct: number | null;
  vpdKpa: number | null;
  dewPointC: number | null;
  heatIndexC: number | null;
  thi: number | null;
  referenceEt0MmDay: number | null;
  cropCoefficientKc: number | null;
  etcMmDay: number | null;
}

export interface ForecastEnvironment {
  available: boolean;
  source: 'openagri' | 'open_meteo' | 'unavailable';
  cacheStatus: 'live' | 'stale' | 'miss';
  observedAt: string | null;
  expiresAt: string | null;
  rainFocus: RainFocus | null;
}

export interface RainFocus {
  totalNext24hMm: number;
  totalNext72hMm: number;
  maxHourlyRainMm: number;
  maxHourlyRainAt: string | null;
  nextRainEta: string | null;
  rainHoursNext24h: number;
  daily: DailyForecast[];
  hourly: HourlyForecast[];
}

export interface DailyForecast {
  date: string;
  description: string | null;
  weatherCode: number | null;
  maxTempC: number | null;
  minTempC: number | null;
  rainMm: number | null;
  rainProbabilityPct: number | null;
  windSpeedMps: number | null;
  et0MmDay: number | null;
  etcMmDay: number | null;
}

export interface HourlyForecast {
  time: string;
  rainMm: number | null;
  rainProbabilityPct: number | null;
  tempC: number | null;
  windSpeedMps: number | null;
}

/** One raw dendrometer reading from dendrometer_readings table */
export interface DendroReading {
  id: number | null;
  deveui: string;
  position_um: number | null;
  position_raw_um?: number | null;
  adc_v: number | null;
  adc_ch0v?: number | null;
  adc_ch1v?: number | null;
  dendro_ratio?: number | null;
  dendro_mode_used?: DendroModeUsed | string | null;
  bat_v: number | null;
  is_valid: number;
  is_outlier: number;
  dendro_saturated?: number | null;
  dendro_saturation_side?: string | null;
  recorded_at: string;
}
