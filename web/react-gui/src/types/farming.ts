// The specific supported hardware types
export type DeviceType = 'KIWI_SENSOR' | 'STREGA_VALVE';

export interface Device {
  deveui: string;       // Unique LoRaWAN ID
  name: string;         // User-given name (e.g., "North Field")
  type_id: DeviceType;
  last_seen: string;    // ISO Date string

  // Specific data payload matching Node-RED output
  latest_data: {
    swt_wm1?: number;   // Soil Water Tension 1 (kPa) - 0 to 200
    swt_wm2?: number;   // Soil Water Tension 2 (kPa)
    light_lux?: number; // Light intensity
  };

  // Only for Valves
  target_state?: 'OPEN' | 'CLOSED';
  current_state?: 'OPEN' | 'CLOSED';
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
