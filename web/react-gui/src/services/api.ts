import axios from 'axios';
import { notifyAuthExpired } from './authEvents';
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
  ZoneRecommendationDiagnostics,
  SdVpdStatus,
  DendroReading,
  DendroModeUsed,
  Lsn50Mode,
  StregaModel,
  ZoneEnvironmentSummary,
} from '../types/farming';

type ApiErrorPayload = {
  detail?: string;
  error?: string;
  message?: string;
};

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError<ApiErrorPayload>(error)) {
    return error.response?.data?.detail
      || error.response?.data?.message
      || error.response?.data?.error
      || error.message
      || fallback;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

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
      localStorage.removeItem('username');
      notifyAuthExpired();
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

function normaliseSchedule(sched: any): IrrigationSchedule {
  return {
    ...sched,
    irrigation_zone_id: Number(sched?.irrigation_zone_id ?? sched?.irrigationZoneId ?? 0),
    trigger_metric: sched?.trigger_metric ?? sched?.triggerMetric ?? 'SWT_1',
    triggerMetric: sched?.triggerMetric ?? sched?.trigger_metric ?? 'SWT_1',
    threshold_kpa: Number(sched?.threshold_kpa ?? sched?.thresholdKpa ?? 0),
    thresholdKpa: Number(sched?.thresholdKpa ?? sched?.threshold_kpa ?? 0),
    duration_minutes: sched?.duration_minutes ?? sched?.durationMinutes ?? undefined,
    durationMinutes: sched?.durationMinutes ?? sched?.duration_minutes ?? undefined,
    last_triggered_at: sched?.last_triggered_at ?? sched?.lastTriggeredAt ?? null,
    lastTriggeredAt: sched?.lastTriggeredAt ?? sched?.last_triggered_at ?? null,
    response_mode: sched?.response_mode ?? sched?.responseMode ?? 'proportional',
    responseMode: sched?.responseMode ?? sched?.response_mode ?? 'proportional',
  };
}

function normaliseDevice(device: any): Device {
  const rawDepths = device?.soil_moisture_probe_depths_json;
  const soilMoistureProbeDepths = rawDepths && typeof rawDepths === 'object' && !Array.isArray(rawDepths)
    ? Object.fromEntries(
        Object.entries(rawDepths)
          .map(([key, value]) => [String(key), Number(value)])
          .filter(([, value]) => Number.isFinite(value) && value > 0)
      )
    : undefined;
  const configuredFlag = device?.soil_moisture_probe_depths_configured;
  const soilMoistureProbeDepthsConfigured = configuredFlag === true || configuredFlag === 1
    ? true
    : configuredFlag === false || configuredFlag === 0
      ? false
      : undefined;
  return {
    ...device,
    deveui: String(device?.deveui ?? '').trim().toUpperCase(),
    latest_data: device?.latest_data ?? {},
    last_seen: device?.last_seen ?? null,
    irrigation_zone_id: device?.irrigation_zone_id ?? null,
    zone_ids: Array.isArray(device?.zone_ids) ? device.zone_ids : null,
    zone_names: Array.isArray(device?.zone_names) ? device.zone_names : null,
    soilMoistureProbeDepths,
    soilMoistureProbeDepthsConfigured,
  };
}

function normaliseDendroModeUsed(value: unknown): DendroModeUsed | string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return raw === 'legacy_single_adc' || raw === 'ratio_mod3' ? raw : raw;
}

// Devices API
export const devicesAPI = {
  getAll: async (): Promise<Device[]> => {
    const response = await api.get<Device[]>('/api/devices');
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normaliseDevice);
  },

  add: async (device: AddDeviceRequest): Promise<Device> => {
    const response = await api.post<Device>('/api/devices', device);
    return normaliseDevice(response.data);
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
    deviceCount:       z.deviceCount       ?? z.device_count ?? 0,
    createdAt:         z.createdAt         ?? z.created_at,
    updatedAt:         z.updatedAt         ?? z.updated_at,
    // Camelise new metadata fields from Pi snake_case API
    cropType:          z.cropType          ?? z.crop_type          ?? null,
    variety:           z.variety                                   ?? null,
    soilType:          z.soilType          ?? z.soil_type          ?? null,
    irrigationMethod:  z.irrigationMethod  ?? z.irrigation_method  ?? null,
    areaM2:            z.areaM2            ?? z.area_m2            ?? null,
    irrigationEfficiencyPct: z.irrigationEfficiencyPct ?? z.irrigation_efficiency_pct ?? null,
    schedulingMode:    z.schedulingMode    ?? z.scheduling_mode    ?? 'local',
    notes:             z.notes                                     ?? null,
    timezone:          z.timezone                                  ?? null,
    phenologicalStage: z.phenologicalStage ?? z.phenological_stage ?? null,
    calibrationKey:    z.calibrationKey    ?? z.calibration_key    ?? null,
    predictionCardEnabled: z.predictionCardEnabled ?? z.prediction_card_enabled ?? false,
    gatewayDeviceEui:  z.gatewayDeviceEui  ?? z.gateway_device_eui ?? null,
    varietyCompat:     z.varietyCompat      ?? z.variety_compat       ?? z.variety ?? null,
    schedule: sched ? normaliseSchedule(sched) : null,
  } as IrrigationZone;
}

function normaliseSdVpdStatus(raw: unknown): SdVpdStatus {
  return raw === 'coupled' || raw === 'decoupled' || raw === 'insufficient_data'
    ? raw
    : 'insufficient_data';
}

function parseRecommendationDiagnostics(raw: string | null): ZoneRecommendationDiagnostics | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const overrideSummary = parsed?.vpd_override_summary ?? {};
    const sdVpdSummary = parsed?.sd_vpd_summary ?? {};
    return {
      vpdOverrideSummary: {
        downgradedTreeCount: Number(overrideSummary.downgraded_tree_count ?? 0),
        upgradedTreeCount: Number(overrideSummary.upgraded_tree_count ?? 0),
      },
      sdVpdSummary: {
        baselineR2: sdVpdSummary.baseline_r2 ?? null,
        rolling14dR2: sdVpdSummary.rolling_14d_r2 ?? null,
        status: normaliseSdVpdStatus(sdVpdSummary.status),
        comparableTreeCount: Number(sdVpdSummary.comparable_tree_count ?? 0),
        decoupledTreeCount: Number(sdVpdSummary.decoupled_tree_count ?? 0),
      },
    };
  } catch {
    return null;
  }
}

// Irrigation Zones API
export const irrigationZonesAPI = {
  getAll: async (): Promise<IrrigationZone[]> => {
    const response = await api.get<any[]>('/api/irrigation-zones');
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normaliseZone);
  },

  create: async (zone: CreateZoneRequest): Promise<IrrigationZone> => {
    const response = await api.post<IrrigationZone>('/api/irrigation-zones', zone);
    return normaliseZone(response.data);
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
    return normaliseSchedule(response.data);
  },

  // Update zone configuration metadata
  updateConfig: async (zoneId: number, payload: {
    cropType?: string | null;
    variety?: string | null;
    soilType?: string | null;
    irrigationMethod?: string | null;
    areaM2?: number | null;
    irrigationEfficiencyPct?: number | null;
    schedulingMode?: 'local' | 'server_preferred' | null;
    notes?: string | null;
    timezone?: string | null;
    phenologicalStage?: string | null;
    calibrationKey?: string | null;
    predictionCardEnabled?: boolean;
  }): Promise<IrrigationZone> => {
    const response = await api.put<IrrigationZone>(
      `/api/irrigation-zones/${zoneId}/config`,
      payload
    );
    return normaliseZone(response.data);
  },

  setZoneLocation: async (zoneId: number, payload: {
    latitude: number;
    longitude: number;
  }): Promise<void> => {
    await api.put(`/api/irrigation-zones/${zoneId}/location`, payload);
  },
};

export interface DendroHistoryPoint {
  t: string;           // ISO timestamp
  position_mm: number | null;
  delta_mm: number | null;
  adc_v: number | null;
  adc_ch0v?: number | null;
  adc_ch1v?: number | null;
  dendro_ratio?: number | null;
  dendro_mode_used?: DendroModeUsed | string | null;
  valid: number;       // 1 = valid
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normaliseDendroHistoryPoint(row: any): DendroHistoryPoint {
  return {
    t: String(row?.t ?? row?.recorded_at ?? ''),
    position_mm: toNullableNumber(row?.position_mm ?? row?.dendro_position_mm),
    delta_mm: toNullableNumber(row?.delta_mm ?? row?.dendro_delta_mm),
    adc_v: toNullableNumber(row?.adc_v ?? row?.adc_ch0v),
    adc_ch0v: toNullableNumber(row?.adc_ch0v ?? row?.adc_v),
    adc_ch1v: toNullableNumber(row?.adc_ch1v),
    dendro_ratio: toNullableNumber(row?.dendro_ratio),
    dendro_mode_used: normaliseDendroModeUsed(row?.dendro_mode_used),
    valid: Number(row?.valid ?? row?.dendro_valid ?? 0),
  };
}

function normaliseDendroReading(row: any): DendroReading {
  return {
    id: toNullableNumber(row?.id),
    deveui: String(row?.deveui ?? '').trim().toUpperCase(),
    position_um: toNullableNumber(row?.position_um),
    adc_v: toNullableNumber(row?.adc_v),
    adc_ch0v: toNullableNumber(row?.adc_ch0v ?? row?.adc_v),
    adc_ch1v: toNullableNumber(row?.adc_ch1v),
    dendro_ratio: toNullableNumber(row?.dendro_ratio),
    dendro_mode_used: normaliseDendroModeUsed(row?.dendro_mode_used),
    bat_v: toNullableNumber(row?.bat_v),
    is_valid: Number(row?.is_valid ?? 0),
    is_outlier: Number(row?.is_outlier ?? 0),
    recorded_at: String(row?.recorded_at ?? ''),
  };
}

export const lsn50API = {
  setDendroEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/dendro`, { enabled });
  },
  setTempEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/temp`, { enabled });
  },
  setRainGaugeEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/rain-gauge`, { enabled });
  },
  setFlowMeterEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/flow-meter`, { enabled });
  },
  setMode: async (deveui: string, mode: Lsn50Mode): Promise<void> => {
    await api.put(`/api/devices/${deveui}/lsn50/mode`, { mode });
  },
  setUplinkInterval: async (deveui: string, minutes: number): Promise<void> => {
    await api.put(`/api/devices/${deveui}/lsn50/interval`, { minutes });
  },
  setInterruptMode: async (deveui: string, mode: number): Promise<void> => {
    await api.put(`/api/devices/${deveui}/lsn50/interrupt-mode`, { mode });
  },
  setFiveVoltWarmup: async (deveui: string, milliseconds: number): Promise<void> => {
    await api.put(`/api/devices/${deveui}/lsn50/5v-warmup`, { milliseconds });
  },
  setDendroConfig: async (deveui: string, payload: {
    dendroForceLegacy?: boolean | null;
    dendroStrokeMm?: number | null;
    dendroRatioZero?: number | null;
    dendroRatioSpan?: number | null;
    dendroInvertDirection?: boolean | null;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/dendro-config`, payload);
  },
};

export const kiwiAPI = {
  setUplinkInterval: async (deveui: string, minutes: number): Promise<void> => {
    await api.put(`/api/devices/${deveui}/kiwi/interval`, { minutes });
  },
  enableTemperatureHumidity: async (deveui: string, minutes: number): Promise<void> => {
    await api.post(`/api/devices/${deveui}/kiwi/temperature-humidity/enable`, { minutes });
  },
};

export const deviceMetadataAPI = {
  setSoilMoistureDepths: async (
    deveui: string,
    soilMoistureProbeDepths: Record<string, number>
  ): Promise<Device> => {
    const response = await api.put<Device>(`/api/devices/${deveui}/soil-moisture-depths`, {
      soilMoistureProbeDepths,
    });
    return normaliseDevice(response.data);
  },
};

export const stregaAPI = {
  setUplinkInterval: async (deveui: string, payload: {
    minutes?: number;
    closedMinutes?: number;
    openedMinutes?: number;
    tamperDisabled?: boolean;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/strega/interval`, payload);
  },
  setModel: async (deveui: string, model: StregaModel): Promise<void> => {
    await api.put(`/api/devices/${deveui}/strega/model`, { model });
  },
  setTimedAction: async (deveui: string, payload: {
    action: 'OPEN' | 'CLOSE';
    unit: 'seconds' | 'minutes' | 'hours';
    amount: number;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/strega/timed-action`, payload);
  },
  setMagnetEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/strega/magnet`, { enabled });
  },
  setPartialOpening: async (deveui: string, payload: {
    action: 'OPEN' | 'CLOSE';
    percentage: number;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/strega/partial-opening`, payload);
  },
  setFlushing: async (deveui: string, payload: {
    returnPosition: 'OPEN' | 'CLOSE';
    percentage: number;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/strega/flushing`, payload);
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
  const recommendationJson = typeof row.recommendation_json === 'string' ? row.recommendation_json : null;
  return {
    id: row.id,
    zone_id: row.zone_id,
    date: row.date,
    zone_stress_summary: row.zone_stress_summary ?? 'none',
    rainfall_mm: row.rainfall_mm ?? 0,
    water_delivered_liters: row.water_delivered_liters ?? 0,
    irrigation_action: row.irrigation_action ?? 'maintain',
    action_reasoning: row.action_reasoning ?? '',
    recommendation_json: recommendationJson,
    diagnostics: parseRecommendationDiagnostics(recommendationJson),
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
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normaliseDendroDaily);
  },
  getZoneRecommendations: async (zoneId: number, days = 14): Promise<ZoneRecommendation[]> => {
    const response = await api.get<any[]>(`/api/irrigation-zones/${zoneId}/recommendations`, { params: { days } });
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normaliseZoneRecommendation);
  },
  getRawReadings: async (deveui: string, from: string, to: string): Promise<DendroReading[]> => {
    const response = await api.get<any[]>(`/api/dendrometer/${deveui}/readings`, { params: { from, to } });
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normaliseDendroReading);
  },
  setReferenceTree: async (deveui: string, isRef: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/reference-tree`, { is_reference_tree: isRef ? 1 : 0 });
  },
};

export const dendroAPI = {
  getHistory: async (deveui: string, hours = 24): Promise<DendroHistoryPoint[]> => {
    const response = await api.get<any[]>(
      `/api/devices/${deveui}/dendro-history`,
      { params: { hours } }
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(normaliseDendroHistoryPoint);
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
  serverUrl?: string | null;
}

export interface AccountLinkResult {
  success: boolean;
  serverUsername: string;
  claimedDevices: string[];
  skippedDevices: string[];
}

export interface ForceSyncResult {
  success: boolean;
  forcedAt: string;
  refresh: {
    attempted: boolean;
    succeeded: boolean;
    statusCode?: number | null;
    syncTokenExpiresAt?: number | null;
    error?: string | null;
  };
  bootstrap: {
    attempted: boolean;
    succeeded: boolean;
    applied: number;
    skipped: number;
    statusCode?: number | null;
    error?: string | null;
  };
  outbox: {
    attempted: boolean;
    succeeded: boolean;
    beforeCount: number;
    deliveredCount: number;
    afterCount: number;
    applied: number;
    skipped: number;
    statusCode?: number | null;
    error?: string | null;
  };
  pendingCommands: {
    attempted: boolean;
    succeeded: boolean;
    fetchedCount: number;
    queuedCount: number;
    appliesAfterResponse: boolean;
    applyPhase: 'NO_PENDING_COMMANDS' | 'QUEUED_LOCAL_APPLY';
    statusCode?: number | null;
    error?: string | null;
  };
  lastError: {
    source: string;
    message: string;
    statusCode?: number | null;
  } | null;
}

export const accountLinkAPI = {
  getStatus: () => api.get<AccountLinkStatus>('/api/account-link/status').then(r => r.data),
  link: (req: AccountLinkRequest) =>
    api.post<AccountLinkResult>('/api/account-link', req).then(r => r.data),
  unlink: () => api.delete('/api/account-link'),
  forceSync: () => api.post<ForceSyncResult>('/api/sync/force').then(r => r.data),
};

export const environmentAPI = {
  getSummary: (zoneId: number): Promise<ZoneEnvironmentSummary> =>
    api.get<ZoneEnvironmentSummary>(`/api/irrigation-zones/${zoneId}/environment-summary`).then(r => r.data),
};

export const s2120API = {
  getZoneAssignments: async (deveui: string): Promise<Array<{ zone_id: number; zone_name: string }>> => {
    const response = await api.get(`/api/devices/${deveui}/zone-assignments`);
    return response.data;
  },
  setZoneAssignments: async (deveui: string, zoneIds: number[]): Promise<void> => {
    await api.put(`/api/devices/${deveui}/zone-assignments`, { zone_ids: zoneIds });
  },
};

export default api;
