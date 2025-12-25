import axios from 'axios';
import type {
  Device,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  DeviceCatalogItem,
  AddDeviceRequest,
  ValveActionRequest
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
      // Ensure headers object exists
      if (!config.headers) {
        config.headers = {} as any;
      }
      // Set Authorization header
      config.headers['Authorization'] = `Bearer ${token}`;
      console.log('[API] Request to:', config.url, 'with token:', token.substring(0, 20) + '...');
    } else {
      console.log('[API] Request to:', config.url, 'without token (not found in localStorage)');
    }
    return config;
  },
  (error) => {
    console.error('[API] Request interceptor error:', error);
    return Promise.reject(error);
  }
);

// Response interceptor to handle auth errors
api.interceptors.response.use(
  (response) => {
    console.log('[API] Response from:', response.config.url, 'Status:', response.status);
    return response;
  },
  (error) => {
    console.error('[API] Response error:', error.config?.url, 'Status:', error.response?.status);
    if (error.response?.status === 401) {
      // Clear token but don't redirect - let page handle error display
      console.warn('[API] 401 Unauthorized - clearing token from localStorage');
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

export default api;
