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
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Clear token but don't redirect - let page handle error display
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
};

export default api;
