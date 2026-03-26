import axios from 'axios';
import type {
  Device,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  DeviceCatalogItem,
  AddDeviceRequest,
  ValveActionRequest,
  IrrigationZone,
  CreateZoneRequest,
  UpdateIrrigationScheduleRequest,
  IrrigationSchedule,
  DendroDaily,
  ZoneRecommendation,
  DendroReading,
} from '../types/farming';

// Create axios instance with base configuration
const api = axios.create({
  baseURL: '/', // Vite proxy will forward to localhost:1880
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to attach Authorization token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      if (!config.headers) {
        config.headers = {} as any;
      }
      config.headers['Authorization'] = `Bearer ${token}`;
    } else {
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle auth errors
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('auth_token');
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authAPI = {
  login: async (credentials: LoginRequest): Promise<LoginResponse> => {
    const response = await api.post<LoginResponse>('/auth/login', credentials);
    return response.data;
  },

  register: async (credentials: RegisterRequest): Promise<RegisterResponse> => {
    const response = await api.post<RegisterResponse>('/auth/register', credentials);
    return response.data;
  },
};

// Devices API
export const devicesAPI = {
  getAll: async (): Promise<Device[]> => {
    const response = await api.get<Device[]>('/api/devices');
    return response.data;
  },

  add: async (device: AddDeviceRequest): Promise<Device> => {
    const response = await api.post<Device>('/api/devices', device);
    return response.data;
  },

  getCatalog: async (): Promise<DeviceCatalogItem[]> => {
    const response = await api.get<DeviceCatalogItem[]>('/api/catalog');
    return response.data;
  },

  controlValve: async (deveui: string, action: ValveActionRequest): Promise<void> => {
    await api.post(`/api/valve/${deveui}`, action);
  },

  remove: async (deveui: string): Promise<void> => {
    await api.delete(`/api/devices/${deveui}`);
  },
};

function normaliseZone(z: any): IrrigationZone {
  const sched = z.schedule;
  return {
    ...z,
    // Camelise new metadata fields from Pi snake_case API
    cropType:          z.cropType          ?? z.crop_type          ?? null,
    variety:           z.variety                                   ?? null,
    soilType:          z.soilType          ?? z.soil_type          ?? null,
    irrigationMethod:  z.irrigationMethod  ?? z.irrigation_method  ?? null,
    notes:             z.notes                                     ?? null,
    timezone:          z.timezone                                  ?? null,
    phenologicalStage: z.phenologicalStage ?? z.phenological_stage ?? null,
    calibrationKey:    z.calibrationKey    ?? z.calibration_key    ?? null,
    schedule: sched ? {
      ...sched,
      triggerMetric:   sched.triggerMetric   ?? sched.trigger_metric   ?? null,
      thresholdKpa:    sched.thresholdKpa    ?? sched.threshold_kpa    ?? null,
      durationMinutes: sched.durationMinutes ?? sched.duration_minutes ?? null,
      lastTriggeredAt: sched.lastTriggeredAt ?? sched.last_triggered_at ?? null,
      responseMode:    sched.responseMode    ?? sched.response_mode    ?? 'proportional',
    } : null,
  } as IrrigationZone;
}

// Irrigation Zones API
export const irrigationZonesAPI = {
  getAll: async (): Promise<IrrigationZone[]> => {
    const response = await api.get<any[]>('/api/irrigation-zones');
    return response.data.map(normaliseZone);
  },

  create: async (zone: CreateZoneRequest): Promise<IrrigationZone> => {
    const response = await api.post<IrrigationZone>('/api/irrigation-zones', zone);
    return response.data;
  },

  delete: async (zoneId: number): Promise<void> => {
    await api.delete(`/api/irrigation-zones/${zoneId}`);
  },

  assignDevice: async (zoneId: number, deveui: string): Promise<void> => {
    await api.put(`/api/irrigation-zones/${zoneId}/devices/${deveui}`);
  },

  removeDevice: async (zoneId: number, deveui: string): Promise<void> => {
    await api.delete(`/api/irrigation-zones/${zoneId}/devices/${deveui}`);
  },

  // Save/update schedule for a zone
  updateSchedule: async (
    zoneId: number,
    body: UpdateIrrigationScheduleRequest
  ): Promise<IrrigationSchedule> => {
    const response = await api.put<IrrigationSchedule>(
      `/api/irrigation-zones/${zoneId}/schedule`,
      body
    );
    return response.data;
  },

  // Update zone configuration metadata
  updateConfig: async (zoneId: number, payload: {
    cropType?: string | null;
    variety?: string | null;
    soilType?: string | null;
    irrigationMethod?: string | null;
    notes?: string | null;
    timezone?: string | null;
    phenologicalStage?: string | null;
    calibrationKey?: string | null;
  }): Promise<IrrigationZone> => {
    const response = await api.put<IrrigationZone>(
      `/api/irrigation-zones/${zoneId}/config`,
      payload
    );
    return response.data;
  },
};

export interface DendroHistoryPoint {
  t: string;           // ISO timestamp
  position_mm: number;
  delta_mm: number | null;
  adc_v: number;
  valid: number;       // 1 = valid
}

export const lsn50API = {
  setDendroEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/dendro`, { enabled });
  },
  setTempEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/temp`, { enabled });
  },
};

function normaliseDendroDaily(row: any): DendroDaily {
  return {
    id: row.id,
    deveui: row.deveui,
    date: row.date,
    d_max_um: row.d_max_um ?? null,
    d_min_um: row.d_min_um ?? null,
    mds_um: row.mds_um ?? null,
    tgr_um: row.tgr_um ?? null,
    tgr_smoothed_um: row.tgr_smoothed_um ?? null,
    twd_um: row.twd_um ?? null,
    dr_um: row.dr_um ?? null,
    recovery_delta_um: row.recovery_delta_um ?? null,
    signal_intensity: row.signal_intensity ?? null,
    twd_night_um: row.twd_night_um ?? null,
    twd_day_um: row.twd_day_um ?? null,
    twd_norm_night: row.twd_norm_night ?? null,
    twd_norm_day: row.twd_norm_day ?? null,
    mds_norm: row.mds_norm ?? null,
    recovery_ratio: row.recovery_ratio ?? null,
    recovery_ratio_smoothed: row.recovery_ratio_smoothed ?? null,
    r_delta_5day: row.r_delta_5day ?? null,
    delta_twd_smoothed: row.delta_twd_smoothed ?? null,
    d_max_running_um: row.d_max_running_um ?? null,
    d_max_time: row.d_max_time ?? null,
    d_min_time: row.d_min_time ?? null,
    twd_episode_active: row.twd_episode_active ?? 0,
    twd_episode_start: row.twd_episode_start ?? null,
    twd_episode_max_um: row.twd_episode_max_um ?? null,
    envelope_ref_um: row.envelope_ref_um ?? null,
    twd_method: row.twd_method ?? null,
    confidence_score: row.confidence_score ?? null,
    qa_flags_json: row.qa_flags_json ?? null,
    low_confidence_day: row.low_confidence_day ?? 0,
    tree_state_v5: row.tree_state_v5 ?? row.stress_level ?? 'none',
    baseline_complete: row.baseline_complete ?? 0,
    baseline_days: row.baseline_days ?? null,
    mds_max_reference_um: row.mds_max_reference_um ?? null,
    stress_level: row.stress_level ?? 'none',
    data_quality: row.data_quality ?? 'insufficient',
    valid_readings_count: row.valid_readings_count ?? 0,
    computed_at: row.computed_at,
  };
}

function normaliseZoneRecommendation(row: any): ZoneRecommendation {
  return {
    id: row.id,
    zone_id: row.zone_id,
    date: row.date,
    zone_stress_summary: row.zone_stress_summary ?? 'none',
    rainfall_mm: row.rainfall_mm ?? 0,
    water_delivered_liters: row.water_delivered_liters ?? 0,
    irrigation_action: row.irrigation_action ?? 'maintain',
    action_reasoning: row.action_reasoning ?? '',
    computed_at: row.computed_at,
    rain_suppression_active: row.rain_suppression_active ?? 0,
    recovery_verification_active: row.recovery_verification_active ?? 0,
    vpd_max_kpa: row.vpd_max_kpa ?? null,
    vpd_source: row.vpd_source ?? null,
    usable_tree_count: row.usable_tree_count ?? 0,
    low_confidence_tree_count: row.low_confidence_tree_count ?? 0,
    outlier_filtered_tree_count: row.outlier_filtered_tree_count ?? 0,
    zone_confidence_score: row.zone_confidence_score ?? null,
  };
}

export const dendroAnalyticsAPI = {
  getDailyIndicators: async (deveui: string, days = 7): Promise<DendroDaily[]> => {
    const response = await api.get<any[]>(`/api/dendrometer/${deveui}/daily`, { params: { days } });
    return response.data.map(normaliseDendroDaily);
  },
  getZoneRecommendations: async (zoneId: number, days = 14): Promise<ZoneRecommendation[]> => {
    const response = await api.get<any[]>(`/api/irrigation-zones/${zoneId}/recommendations`, { params: { days } });
    return response.data.map(normaliseZoneRecommendation);
  },
  getRawReadings: async (deveui: string, from: string, to: string): Promise<DendroReading[]> => {
    const response = await api.get<DendroReading[]>(`/api/dendrometer/${deveui}/readings`, { params: { from, to } });
    return response.data;
  },
  setReferenceTree: async (deveui: string, isRef: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/reference-tree`, { is_reference_tree: isRef ? 1 : 0 });
  },
};

export const dendroAPI = {
  getHistory: async (deveui: string, hours = 24): Promise<DendroHistoryPoint[]> => {
    const response = await api.get<DendroHistoryPoint[]>(
      `/api/devices/${deveui}/dendro-history`,
      { params: { hours } }
    );
    return response.data;
  },
};

export interface SensorHistoryPoint {
  t: string;      // ISO timestamp
  value: number | null;
}

export const sensorAPI = {
  getHistory: async (deveui: string, field: string, hours = 24): Promise<SensorHistoryPoint[]> => {
    const response = await api.get<SensorHistoryPoint[]>(
      `/api/devices/${deveui}/sensor-history`,
      { params: { field, hours } }
    );
    return response.data;
  },
};

export interface SystemStats {
  cpu_temp_c: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_free_mb: number;
  mem_percent: number;
  load_1: number;
  load_5: number;
  load_15: number;
  cpu_count: number;
  fan_available: boolean;
  fan_mode: 'pwm' | 'cooling' | 'none';
  fan_value: number | null;
  fan_max: number | null;
}

export const systemAPI = {
  getStats: async (): Promise<SystemStats> => {
    const res = await api.get<SystemStats>('/api/system/stats');
    return res.data;
  },
  reboot: async (): Promise<void> => {
    await api.post('/api/system/reboot');
  },
  setFan: async (speed: number): Promise<void> => {
    await api.post('/api/system/fan', { speed });
  },
};

export interface AccountLinkRequest {
  serverUrl: string;
  action: 'login' | 'register';
  username: string;
  email?: string;
  password: string;
}

export interface AccountLinkStatus {
  linked: boolean;
  serverUsername: string | null;
  linkedAt: string | null;
}

export interface AccountLinkResult {
  success: boolean;
  serverUsername: string;
  claimedDevices: string[];
  skippedDevices: string[];
}

export const accountLinkAPI = {
  getStatus: () => api.get<AccountLinkStatus>('/api/account-link/status').then(r => r.data),
  link: (req: AccountLinkRequest) => api.post<AccountLinkResult>('/api/account-link', req).then(r => r.data),
  unlink: () => api.delete('/api/account-link'),
};

export default api;
