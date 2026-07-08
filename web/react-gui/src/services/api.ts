import axios from 'axios';
import { notifyAuthExpired } from './authEvents';
import type {
  AnalysisCatalogResponse,
  AnalysisSeriesRequest,
  AnalysisSeriesResponse,
  AnalysisViewRequest,
  AnalysisViewResponse,
} from '../analysis/types';
import {
  adaptEdgeSavedViewResponse,
  adaptEdgeViewsResponse,
  toEdgeAnalysisViewPayload,
} from '../analysis/edgeAnalysisApi';
import { resolveAnalysisRangeForRequest } from '../analysis/range';
import type {
  HistoryCardSummaryResponse,
  HistoryCardDataResponse,
  HistoryAdvancedResponse,
  HistoryCardSummary,
  HistoryCardType,
  HistoryCardScope,
  HistoryViewMode,
  HistoryRangeLabel,
  HistoryAggregationLevel,
  HistoryCardAvailability,
  HistoryCardOrdering,
  HistoryCardMetadata,
  CoverageConfidence,
  HistoryRangeSelection,
  HistoryCardDataRequest,
  HistoryCardPreference,
  HistoryWorkspace,
  HistoryWorkspaceListResponse,
  HistoryWorkspaceRecord,
} from '../history/types';
import { migrateHistoryWorkspace } from '../history/workspaceModel';
import type { RainDay } from '../utils/rain';
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
  SupportDiagnosticsPreview,
  SupportRequest,
  SupportRequestCreateRequest,
  SupportRequestCreateResponse,
} from '../types/farming';

type ApiErrorPayload = {
  detail?: string;
  error?: string;
  message?: string;
};

export interface SystemFeatureFlags {
  historyUxEnabled: boolean;
  historyComparisonEnabled: boolean;
  historyWorkspacesEnabled: boolean;
  historyAdvancedOverlaysEnabled: boolean;
  historyCloudAiEnabled: boolean;
}

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
    trigger_metric: sched?.trigger_metric ?? sched?.triggerMetric ?? 'SWT_WM1',
    triggerMetric: sched?.triggerMetric ?? sched?.trigger_metric ?? 'SWT_WM1',
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
          .map(([key, value]) => [String(key), Number(value)] as [string, number])
          .filter(([, value]) => Number.isFinite(value) && value > 0)
      )
    : undefined;
  const configuredFlag = device?.soil_moisture_probe_depths_configured;
  const soilMoistureProbeDepthsConfigured = configuredFlag === true || configuredFlag === 1
    ? true
    : configuredFlag === false || configuredFlag === 0
      ? false
      : undefined;
  const rawActiveActuation = device?.activeValveActuation ?? device?.active_valve_actuation ?? null;
  const activeValveActuation = rawActiveActuation && typeof rawActiveActuation === 'object' && !Array.isArray(rawActiveActuation)
    ? {
        ...rawActiveActuation,
        expectationId: rawActiveActuation.expectationId ?? rawActiveActuation.expectation_id ?? null,
        expectation_id: rawActiveActuation.expectation_id ?? rawActiveActuation.expectationId ?? null,
        reconciliationState: rawActiveActuation.reconciliationState ?? rawActiveActuation.reconciliation_state ?? null,
        reconciliation_state: rawActiveActuation.reconciliation_state ?? rawActiveActuation.reconciliationState ?? null,
        commandedAt: rawActiveActuation.commandedAt ?? rawActiveActuation.commanded_at ?? null,
        commanded_at: rawActiveActuation.commanded_at ?? rawActiveActuation.commandedAt ?? null,
        expectedCloseAt: rawActiveActuation.expectedCloseAt ?? rawActiveActuation.expected_close_at ?? null,
        expected_close_at: rawActiveActuation.expected_close_at ?? rawActiveActuation.expectedCloseAt ?? null,
      }
    : null;
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
    activeValveActuation,
    active_valve_actuation: activeValveActuation,
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

  cancelIrrigation: async (deveui: string, reason: string = 'operator_cancel'): Promise<void> => {
    await api.post(`/api/valve/${deveui}/cancel`, { reason });
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
    measuredFlowRateLpm: z.measuredFlowRateLpm ?? z.measured_flow_rate_lpm ?? null,
    measurementMethod: z.measurementMethod ?? z.measurement_method ?? null,
    irrigationCalibrationUpdatedAt: z.irrigationCalibrationUpdatedAt ?? z.irrigation_calibration_updated_at ?? null,
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

  updateCalibration: async (zoneId: number, payload: {
    measuredFlowRateLpm: number;
    measurementMethod: string | null;
  }): Promise<void> => {
    await api.post(`/api/irrigation-zones/${zoneId}/calibration`, payload);
  },

  setZoneLocation: async (zoneId: number, payload: {
    latitude: number;
    longitude: number;
  }): Promise<void> => {
    await api.put(`/api/irrigation-zones/${zoneId}/location`, payload);
  },

  disableAllSchedules: async (): Promise<{ disabledSchedules: number }> => {
    const response = await api.post<{ disabledSchedules?: number }>('/api/irrigation-zones/schedules/disable-all');
    return { disabledSchedules: Number(response.data?.disabledSchedules ?? 0) };
  },
};

export interface DendroHistoryPoint {
  t: string;           // ISO timestamp
  position_raw_mm?: number | null;
  position_mm: number | null;
  delta_mm: number | null;
  stem_change_um: number | null;
  adc_v: number | null;
  adc_ch0v?: number | null;
  adc_ch1v?: number | null;
  dendro_ratio?: number | null;
  dendro_mode_used?: DendroModeUsed | string | null;
  saturated?: number | null;
  saturation_side?: string | null;
  valid: number;       // 1 = valid
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function normaliseSystemFeatureFlags(row: any): SystemFeatureFlags {
  const source = row?.features ?? row ?? {};
  return {
    historyUxEnabled: asBoolean(source?.historyUxEnabled ?? source?.history_ux_enabled),
    historyComparisonEnabled: asBoolean(source?.historyComparisonEnabled ?? source?.history_comparison_enabled),
    historyWorkspacesEnabled: asBoolean(source?.historyWorkspacesEnabled ?? source?.history_workspaces_enabled),
    historyAdvancedOverlaysEnabled: asBoolean(
      source?.historyAdvancedOverlaysEnabled ?? source?.history_advanced_overlays_enabled,
    ),
    historyCloudAiEnabled: asBoolean(source?.historyCloudAiEnabled ?? source?.history_cloud_ai_enabled),
  };
}

function toCoverageConfidence(value: unknown): CoverageConfidence {
  return value === 'configured' || value === 'derived' || value === 'unknown'
    ? value
    : 'unknown';
}

function normaliseHistoryCardAvailability(row: any): HistoryCardAvailability {
  return {
    available: row?.available !== false,
    reasons: Array.isArray(row?.reasons) ? row.reasons.map(String) : [],
  };
}

function normaliseHistoryCardOrdering(row: any): HistoryCardOrdering {
  return {
    pinned: asBoolean(row?.pinned),
    score: Number(row?.score ?? 0),
    recentRank: row?.recentRank ?? row?.recent_rank ?? null,
    manualOrder: row?.manualOrder ?? row?.manual_order ?? null,
    criticalAlert: row?.criticalAlert ?? row?.critical_alert ?? undefined,
  };
}

function normaliseHistoryCardMetadata(row: any): HistoryCardMetadata {
  return {
    ...row,
    lastSeenAt: row?.lastSeenAt ?? row?.last_seen_at ?? null,
    coveragePct: row?.coveragePct ?? row?.coverage_pct ?? null,
    coverageConfidence: toCoverageConfidence(row?.coverageConfidence ?? row?.coverage_confidence),
    syncState: row?.syncState ?? row?.sync_state,
    calibrationStatus: row?.calibrationStatus ?? row?.calibration_status ?? null,
  };
}

function normaliseHistoryCardSummary(row: any): HistoryCardSummary {
  const cardType = String(row?.cardType ?? row?.card_type ?? 'soil') as HistoryCardType;
  const rawSourceDevices = Array.isArray(row?.sourceDevices ?? row?.source_devices)
    ? (row.sourceDevices ?? row.source_devices)
    : [];
  const rawSourceLabels = Array.isArray(row?.sourceLabels ?? row?.source_labels)
    ? (row.sourceLabels ?? row.source_labels)
    : [];
  const sourceDeviceCountRaw = row?.sourceDeviceCount ?? row?.source_device_count;
  const sourceDeviceCount = typeof sourceDeviceCountRaw === 'number'
    ? sourceDeviceCountRaw
    : Number.parseInt(String(sourceDeviceCountRaw ?? ''), 10);
  return {
    cardId: String(row?.cardId ?? row?.card_id ?? ''),
    cardType,
    scope: String(row?.scope ?? 'zone') as HistoryCardScope,
    title: String(row?.title ?? cardType),
    subtitle: String(row?.subtitle ?? ''),
    defaultView: String(row?.defaultView ?? row?.default_view ?? 'line-chart') as HistoryViewMode,
    views: Array.isArray(row?.views) ? row.views.map(String) as HistoryViewMode[] : [],
    supportedRanges: Array.isArray(row?.supportedRanges ?? row?.supported_ranges)
      ? (row.supportedRanges ?? row.supported_ranges).map(String) as HistoryRangeLabel[]
      : [],
    defaultRange: String(row?.defaultRange ?? row?.default_range ?? '24h') as HistoryRangeLabel,
    sourceDeviceCount: Number.isFinite(sourceDeviceCount) ? sourceDeviceCount : undefined,
    sourceLabel: row?.sourceLabel ?? row?.source_label ?? null,
    sourceLabels: rawSourceLabels.map(String).filter((label: string) => label.trim().length > 0),
    sourceDevices: rawSourceDevices.map((device: any) => ({
      name: typeof device?.name === 'string' && device.name.trim() ? device.name.trim() : null,
      typeId: typeof (device?.typeId ?? device?.type_id) === 'string'
        ? String(device.typeId ?? device.type_id).trim() || null
        : null,
      role: typeof device?.role === 'string' && device.role.trim() ? device.role.trim() : null,
      sourceKey: typeof (device?.sourceKey ?? device?.source_key) === 'string'
        ? String(device.sourceKey ?? device.source_key).trim() || null
        : null,
    })),
    metadata: normaliseHistoryCardMetadata(row?.metadata ?? {}),
    availability: normaliseHistoryCardAvailability(row?.availability ?? {}),
    ordering: normaliseHistoryCardOrdering(row?.ordering ?? {}),
  };
}

function normaliseHistoryCardSummaryResponse(row: any): HistoryCardSummaryResponse {
  const rawCards = Array.isArray(row?.cards) ? row.cards : [];
  return {
    zoneId: row?.zoneId ?? row?.zone_id,
    zoneUuid: row?.zoneUuid ?? row?.zone_uuid,
    gatewayEui: row?.gatewayEui ?? row?.gateway_eui,
    generatedAt: String(row?.generatedAt ?? row?.generated_at ?? ''),
    cards: rawCards.map(normaliseHistoryCardSummary),
  };
}

function normaliseHistoryRangeSelection(row: any): HistoryRangeSelection {
  return {
    label: String(row?.label ?? 'custom') as HistoryRangeLabel,
    from: row?.from ?? null,
    to: row?.to ?? null,
    timezone: String(row?.timezone ?? 'UTC'),
  };
}

function normaliseHistoryCardDataResponse(row: any): HistoryCardDataResponse {
  const aggregation = row?.aggregation ?? {};
  const limits = row?.limits ?? {};
  const freshness = row?.freshness ?? {};

  return {
    cardId: String(row?.cardId ?? row?.card_id ?? ''),
    cardType: String(row?.cardType ?? row?.card_type ?? 'soil') as HistoryCardType,
    view: String(row?.view ?? 'line-chart') as HistoryViewMode,
    range: normaliseHistoryRangeSelection(row?.range ?? {}),
    aggregation: {
      level: String(aggregation?.level ?? 'auto') as HistoryAggregationLevel,
      bucketSizeSeconds: aggregation?.bucketSizeSeconds ?? aggregation?.bucket_size_seconds ?? null,
      coveragePct: aggregation?.coveragePct ?? aggregation?.coverage_pct ?? null,
      coverageConfidence: toCoverageConfidence(aggregation?.coverageConfidence ?? aggregation?.coverage_confidence),
      pointCount: Number(aggregation?.pointCount ?? aggregation?.point_count ?? 0),
      dominantStatusMethod: aggregation?.dominantStatusMethod ?? aggregation?.dominant_status_method ?? null,
    },
    limits: {
      maxPointsPerSeries: Number(limits?.maxPointsPerSeries ?? limits?.max_points_per_series ?? 0),
      maxEvents: Number(limits?.maxEvents ?? limits?.max_events ?? 0),
      maxInterpretations: Number(limits?.maxInterpretations ?? limits?.max_interpretations ?? 0),
      truncated: asBoolean(limits?.truncated),
    },
    series: Array.isArray(row?.series) ? row.series : [],
    profiles: Array.isArray(row?.profiles) ? row.profiles : [],
    events: Array.isArray(row?.events) ? row.events : [],
    calendar: row?.calendar ?? null,
    interpretations: Array.isArray(row?.interpretations) ? row.interpretations : [],
    freshness: {
      dataAsOf: freshness?.dataAsOf ?? freshness?.data_as_of ?? null,
      syncState: freshness?.syncState ?? freshness?.sync_state ?? 'unknown',
    },
    advancedFields: row?.advancedFields ?? row?.advanced_fields ?? {},
  };
}

function normaliseHistoryAdvancedResponse(row: any): HistoryAdvancedResponse {
  const aggregation = row?.aggregation ?? {};
  const freshness = row?.freshness ?? {};
  return {
    generatedAt: String(row?.generatedAt ?? row?.generated_at ?? ''),
    cardId: String(row?.cardId ?? row?.card_id ?? ''),
    cardType: String(row?.cardType ?? row?.card_type ?? 'soil') as HistoryCardType,
    range: normaliseHistoryRangeSelection(row?.range ?? {}),
    aggregation: {
      level: String(aggregation?.level ?? 'auto') as HistoryAggregationLevel,
      bucketSizeSeconds: aggregation?.bucketSizeSeconds ?? aggregation?.bucket_size_seconds ?? null,
      coveragePct: aggregation?.coveragePct ?? aggregation?.coverage_pct ?? null,
      coverageConfidence: toCoverageConfidence(aggregation?.coverageConfidence ?? aggregation?.coverage_confidence),
      pointCount: Number(aggregation?.pointCount ?? aggregation?.point_count ?? 0),
      dominantStatusMethod: aggregation?.dominantStatusMethod ?? aggregation?.dominant_status_method ?? null,
    },
    freshness: {
      dataAsOf: freshness?.dataAsOf ?? freshness?.data_as_of ?? null,
      syncState: freshness?.syncState ?? freshness?.sync_state ?? 'unknown',
    },
    placeholder: row?.placeholder && typeof row.placeholder === 'object' ? row.placeholder : {},
    advancedFields: row?.advancedFields ?? row?.advanced_fields ?? {},
  };
}

function normaliseHistoryCardPreference(row: any): HistoryCardPreference {
  return {
    cardId: String(row?.cardId ?? row?.card_id ?? ''),
    scope: String(row?.scope ?? row?.scope_type ?? 'zone') as HistoryCardScope,
    pinned: asBoolean(row?.pinned),
    manualOrder: row?.manualOrder ?? row?.manual_order ?? null,
    openCount: Number(row?.openCount ?? row?.open_count ?? 0),
    lastOpenedAt: row?.lastOpenedAt ?? row?.last_opened_at ?? null,
    lastViewMode: (row?.lastViewMode ?? row?.last_view_mode ?? null) as HistoryViewMode | null,
    hidden: asBoolean(row?.hidden),
    updatedAt: String(row?.updatedAt ?? row?.updated_at ?? ''),
  };
}

function parseHistoryWorkspacePayload(raw: any): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normaliseHistoryWorkspaceRecord(row: any): HistoryWorkspaceRecord {
  const rawWorkspace = parseHistoryWorkspacePayload(row?.workspace ?? row?.workspace_json ?? {});
  const rawWorkspaceRecord = rawWorkspace && typeof rawWorkspace === 'object' && !Array.isArray(rawWorkspace)
    ? rawWorkspace as Record<string, any>
    : {};
  const zoneId = row?.zoneId ?? row?.zone_id ?? null;
  const workspace = migrateHistoryWorkspace(rawWorkspace, {
    platform: 'edge',
    farmId: rawWorkspaceRecord.farmId ?? rawWorkspaceRecord.farm_id ?? null,
    hubId: rawWorkspaceRecord.hubId ?? rawWorkspaceRecord.hub_id ?? null,
    zoneId: zoneId === null || zoneId === undefined ? null : Number(zoneId),
    zoneUuid: rawWorkspaceRecord.zoneUuid ?? rawWorkspaceRecord.zone_uuid ?? null,
  });

  return {
    id: Number(row?.id ?? 0),
    userId: Number(row?.userId ?? row?.user_id ?? 0),
    ownerUserUuid: row?.ownerUserUuid ?? row?.owner_user_uuid ?? null,
    zoneId: zoneId === null || zoneId === undefined ? null : Number(zoneId),
    name: String(row?.name ?? ''),
    isDefault: asBoolean(row?.isDefault ?? row?.is_default),
    workspace,
    createdAt: String(row?.createdAt ?? row?.created_at ?? ''),
    updatedAt: String(row?.updatedAt ?? row?.updated_at ?? ''),
  };
}

function normaliseHistoryWorkspaceListResponse(row: any): HistoryWorkspaceListResponse {
  const rows = Array.isArray(row?.workspaces) ? row.workspaces : [];
  return {
    generatedAt: String(row?.generatedAt ?? row?.generated_at ?? ''),
    workspaces: rows.map(normaliseHistoryWorkspaceRecord),
  };
}

function buildHistoryCardDataParams(request: HistoryCardDataRequest): URLSearchParams {
  const params = new URLSearchParams({
    view: request.view,
    range: request.range.label,
    timezone: request.range.timezone,
    aggregation: request.aggregation,
  });
  if (request.range.from) params.set('from', request.range.from);
  if (request.range.to) params.set('to', request.range.to);
  if (request.overlays.length > 0) params.set('overlays', request.overlays.join(','));
  if (request.sourceKey) params.set('sourceKey', request.sourceKey);
  return params;
}

function normaliseDendroHistoryPoint(row: any): DendroHistoryPoint {
  return {
    t: String(row?.t ?? row?.recorded_at ?? ''),
    position_raw_mm: toNullableNumber(row?.position_raw_mm ?? row?.dendro_position_raw_mm),
    position_mm: toNullableNumber(row?.position_mm ?? row?.dendro_position_mm),
    delta_mm: toNullableNumber(row?.delta_mm ?? row?.dendro_delta_mm),
    stem_change_um: toNullableNumber(row?.stem_change_um ?? row?.dendro_stem_change_um),
    adc_v: toNullableNumber(row?.adc_v ?? row?.adc_ch0v),
    adc_ch0v: toNullableNumber(row?.adc_ch0v ?? row?.adc_v),
    adc_ch1v: toNullableNumber(row?.adc_ch1v),
    dendro_ratio: toNullableNumber(row?.dendro_ratio),
    dendro_mode_used: normaliseDendroModeUsed(row?.dendro_mode_used),
    saturated: toNullableNumber(row?.saturated ?? row?.dendro_saturated),
    saturation_side: row?.saturation_side ?? row?.dendro_saturation_side ?? null,
    valid: Number(row?.valid ?? row?.dendro_valid ?? 0),
  };
}

function normaliseDendroReading(row: any): DendroReading {
  return {
    id: toNullableNumber(row?.id),
    deveui: String(row?.deveui ?? '').trim().toUpperCase(),
    position_um: toNullableNumber(row?.position_um),
    position_raw_um: toNullableNumber(row?.position_raw_um),
    adc_v: toNullableNumber(row?.adc_v),
    adc_ch0v: toNullableNumber(row?.adc_ch0v ?? row?.adc_v),
    adc_ch1v: toNullableNumber(row?.adc_ch1v),
    dendro_ratio: toNullableNumber(row?.dendro_ratio),
    dendro_mode_used: normaliseDendroModeUsed(row?.dendro_mode_used),
    bat_v: toNullableNumber(row?.bat_v),
    is_valid: Number(row?.is_valid ?? 0),
    is_outlier: Number(row?.is_outlier ?? 0),
    dendro_saturated: toNullableNumber(row?.dendro_saturated),
    dendro_saturation_side: row?.dendro_saturation_side ?? null,
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
  setChameleonEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
    await api.put(`/api/devices/${deveui}/chameleon`, { enabled });
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
    dendroRatioAtRetracted?: number | null;
    dendroRatioAtExtended?: number | null;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/dendro-config`, payload);
  },
  resetDendroBaseline: async (deveui: string): Promise<void> => {
    await api.post(`/api/devices/${deveui}/dendro-baseline/reset`);
  },
  refreshChameleonCalibration: async (deveui: string): Promise<{
    status: 'calibrated' | 'pending' | 'unknown';
    source?: string;
    sensor_id?: string;
  }> => {
    const res = await api.post(`/api/devices/${deveui}/chameleon/refresh-calibration`);
    return res.data;
  },
  setChameleonDepth: async (deveui: string, payload: {
    chameleonSwt1DepthCm?: number | null;
    chameleonSwt2DepthCm?: number | null;
    chameleonSwt3DepthCm?: number | null;
  }): Promise<void> => {
    await api.put(`/api/devices/${deveui}/chameleon/depth`, payload);
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

export const valveAPI = {
  getTodayLiters: async (deveui: string): Promise<{ liters: number | null; source: string }> => {
    const resp = await api.get<{ liters: number | null; source: string }>(
      `/api/v1/devices/${deveui}/today-liters`
    );
    return resp.data;
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
  // Daily rainfall totals bucketed by local calendar day on the edge.
  // tzOffsetMin: minutes east of UTC (use localTzOffsetMinutes()).
  getDailyRainHistory: async (deveui: string, days: number, tzOffsetMin: number): Promise<RainDay[]> => {
    const response = await api.get<unknown>(
      `/api/devices/${deveui}/rain-history`,
      { params: { days, tz_offset_min: tzOffsetMin } }
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.flatMap((row): RainDay[] => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      const day = String(record.day ?? '');
      const totalMm = Number(record.total_mm);
      const samples = Number(record.samples);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(totalMm)) return [];
      return [{ day, total_mm: totalMm, samples: Number.isFinite(samples) ? samples : 0 }];
    });
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
  getFeatures: async (): Promise<SystemFeatureFlags> => {
    const res = await api.get('/api/system/features');
    return normaliseSystemFeatureFlags(res.data);
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

export const analysisAPI = {
  getChannels: async (): Promise<AnalysisCatalogResponse> => {
    const response = await api.get<AnalysisCatalogResponse>('/api/analysis/channels');
    return response.data;
  },

  getSeries: async (request: AnalysisSeriesRequest): Promise<AnalysisSeriesResponse> => {
    const response = await api.post<AnalysisSeriesResponse>('/api/analysis/series', {
      ...request,
      range: resolveAnalysisRangeForRequest(request.range),
    });
    return response.data;
  },

  listViews: async (): Promise<AnalysisViewResponse[]> => {
    const response = await api.get<unknown>('/api/analysis/views');
    return adaptEdgeViewsResponse(response.data);
  },

  saveView: async (request: AnalysisViewRequest): Promise<AnalysisViewResponse> => {
    const response = await api.post<unknown>('/api/analysis/views', toEdgeAnalysisViewPayload(request));
    return adaptEdgeSavedViewResponse(response.data);
  },
};

export const historyAPI = {
  getZoneCards: async (zoneId: number): Promise<HistoryCardSummaryResponse> => {
    const response = await api.get(`/api/history/zones/${zoneId}/cards`);
    return normaliseHistoryCardSummaryResponse(response.data);
  },

  getGatewayCards: async (gatewayEui: string): Promise<HistoryCardSummaryResponse> => {
    const response = await api.get(`/api/history/gateways/${encodeURIComponent(gatewayEui)}/cards`);
    return normaliseHistoryCardSummaryResponse(response.data);
  },

  setZoneCardPreference: async (
    zoneId: number,
    cardId: string,
    payload: Partial<Pick<HistoryCardPreference, 'pinned' | 'manualOrder' | 'lastViewMode' | 'hidden'>>,
  ): Promise<HistoryCardPreference> => {
    const response = await api.put(
      `/api/history/zones/${zoneId}/cards/${encodeURIComponent(cardId)}/preferences`,
      payload,
    );
    return normaliseHistoryCardPreference(response.data);
  },

  markZoneCardOpened: async (
    zoneId: number,
    cardId: string,
    payload: Partial<Pick<HistoryCardPreference, 'lastViewMode'>> = {},
  ): Promise<HistoryCardPreference> => {
    const response = await api.post(
      `/api/history/zones/${zoneId}/cards/${encodeURIComponent(cardId)}/opened`,
      payload,
    );
    return normaliseHistoryCardPreference(response.data);
  },

  getZoneCardData: async (
    zoneId: number,
    cardId: string,
    request: HistoryCardDataRequest,
  ): Promise<HistoryCardDataResponse> => {
    const params = buildHistoryCardDataParams(request);
    const response = await api.get(`/api/history/zones/${zoneId}/cards/${encodeURIComponent(cardId)}/data`, { params });
    return normaliseHistoryCardDataResponse(response.data);
  },

  getZoneCardAdvanced: async (
    zoneId: number,
    cardId: string,
    request: HistoryCardDataRequest,
  ): Promise<HistoryAdvancedResponse> => {
    const params = buildHistoryCardDataParams(request);
    const response = await api.get(`/api/history/zones/${zoneId}/cards/${encodeURIComponent(cardId)}/advanced`, { params });
    return normaliseHistoryAdvancedResponse(response.data);
  },

  getGatewayCardData: async (
    gatewayEui: string,
    cardId: string,
    request: HistoryCardDataRequest,
  ): Promise<HistoryCardDataResponse> => {
    const params = buildHistoryCardDataParams(request);
    const response = await api.get(
      `/api/history/gateways/${encodeURIComponent(gatewayEui)}/cards/${encodeURIComponent(cardId)}/data`,
      { params },
    );
    return normaliseHistoryCardDataResponse(response.data);
  },

  getGatewayCardAdvanced: async (
    gatewayEui: string,
    cardId: string,
    request: HistoryCardDataRequest,
  ): Promise<HistoryAdvancedResponse> => {
    const params = buildHistoryCardDataParams(request);
    const response = await api.get(
      `/api/history/gateways/${encodeURIComponent(gatewayEui)}/cards/${encodeURIComponent(cardId)}/advanced`,
      { params },
    );
    return normaliseHistoryAdvancedResponse(response.data);
  },

  getWorkspaces: async (): Promise<HistoryWorkspaceListResponse> => {
    const response = await api.get('/api/history/workspaces');
    return normaliseHistoryWorkspaceListResponse(response.data);
  },

  createWorkspace: async (payload: {
    name: string;
    zoneId: number | null;
    workspace: HistoryWorkspace;
    isDefault?: boolean;
  }): Promise<HistoryWorkspaceRecord> => {
    const response = await api.post('/api/history/workspaces', payload);
    return normaliseHistoryWorkspaceRecord(response.data);
  },

  updateWorkspace: async (
    workspaceId: number,
    payload: Partial<{
      name: string;
      zoneId: number | null;
      workspace: HistoryWorkspace;
      isDefault: boolean;
    }>,
  ): Promise<HistoryWorkspaceRecord> => {
    const response = await api.put(`/api/history/workspaces/${workspaceId}`, payload);
    return normaliseHistoryWorkspaceRecord(response.data);
  },

  deleteWorkspace: async (workspaceId: number): Promise<void> => {
    await api.delete(`/api/history/workspaces/${workspaceId}`);
  },
};

export type ZoneExportGranularity = 'raw' | 'hourly' | 'daily';

export const zoneExportAPI = {
  download: async (
    zoneId: number,
    opts: { from: string; to: string; granularity: ZoneExportGranularity; channels?: string[] },
  ): Promise<void> => {
    const params: Record<string, string> = {
      from: opts.from,
      to: opts.to,
      granularity: opts.granularity,
    };
    if (opts.channels?.length) params.channels = opts.channels.join(',');
    const response = await api.get(`/api/history/zones/${zoneId}/export.csv`, {
      params,
      responseType: 'blob',
    });
    const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `zone-${zoneId}-${opts.from}_${opts.to}-${opts.granularity}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};

export type IrrigationActuationStatus =
  | 'PENDING_OPEN'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'COMMAND_FAILED'
  | 'OPEN_TIMEOUT'
  | 'CLOSE_TIMEOUT'
  | 'UNKNOWN';

export interface IrrigationActuation {
  expectationId: string;
  deviceEui: string;
  deviceName: string | null;
  zoneId: number;
  zoneName: string | null;
  commandId: string | null;
  commandedAt: string;
  commandedDurationSeconds: number;
  expectedCloseAt: string;
  observedOpenAt: string | null;
  observedCloseAt: string | null;
  estimatedGrossLiters: number | null;
  flowRateLpm: number | null;
  reconciliationState: string;
  cancelReason: string | null;
  commandResult: string | null;
  commandResultDetail: string | null;
  commandAppliedAt: string | null;
  status: IrrigationActuationStatus;
}

export interface IrrigationActuationsResponse {
  generatedAt: string;
  actuations: IrrigationActuation[];
}

export const irrigationOutcomesAPI = {
  recentActuations: (): Promise<IrrigationActuationsResponse> =>
    api.get<IrrigationActuationsResponse>('/api/irrigation/recent-actuations').then(r => r.data),
};

export const supportRequestsAPI = {
  list: async (): Promise<SupportRequest[]> =>
    api.get<SupportRequest[]>('/api/improvement-requests').then((r) => r.data),
  diagnosticsPreview: async (route?: string): Promise<SupportDiagnosticsPreview> =>
    api.get<SupportDiagnosticsPreview>('/api/improvement-requests/diagnostics-preview', { params: { route } }).then((r) => r.data),
  create: async (request: SupportRequestCreateRequest): Promise<SupportRequestCreateResponse> =>
    api.post<SupportRequestCreateResponse>('/api/improvement-requests', request).then((r) => r.data),
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
