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
  dendro_enabled?: number; // 0 = disabled (default), 1 = OPKON dendrometer on ADC
  temp_enabled?: number;   // 0 = disabled (default), 1 = DS18B20 probe on temp input

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
}

export interface ValveActionRequest {
  action: 'OPEN' | 'CLOSE';
}

// ---- Irrigation schedule types ----
export type TriggerMetric = 'SWT_WM1' | 'SWT_WM2' | 'SWT_AVG';

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
