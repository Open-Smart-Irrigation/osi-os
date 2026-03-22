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

// Irrigation Zones API
export const irrigationZonesAPI = {
  getAll: async (): Promise<IrrigationZone[]> => {
    const response = await api.get<IrrigationZone[]>('/api/irrigation-zones');
    return response.data;
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

export const dendroAnalyticsAPI = {
  getDailyIndicators: async (deveui: string, days = 7): Promise<DendroDaily[]> => {
    const response = await api.get<DendroDaily[]>(`/api/dendrometer/${deveui}/daily`, { params: { days } });
    return response.data;
  },
  getZoneRecommendations: async (zoneId: number, days = 14): Promise<ZoneRecommendation[]> => {
    const response = await api.get<ZoneRecommendation[]>(`/api/irrigation-zones/${zoneId}/recommendations`, { params: { days } });
    return response.data;
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
