export type DeviceLocationPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';
export type DeviceLocationSupportReason =
  | 'available'
  | 'unsupported'
  | 'insecure_context'
  | 'permissions_policy_blocked'
  | 'permission_denied';

export interface DeviceLocationSupport {
  available: boolean;
  reason: DeviceLocationSupportReason;
  message: string;
  permissionState: DeviceLocationPermissionState;
  isNativeApp: boolean;
  canOpenSettings: boolean;
}

export interface DeviceLocationCapture {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAt: string;
  source: 'browser' | 'native-app';
}

type AndroidBridge = {
  isNativeApp?: () => boolean;
  openAppSettings?: () => void;
  requestDeviceLocation?: (requestId: string) => void;
};

type NativeDeviceLocationPayload = {
  latitude?: number;
  longitude?: number;
  accuracyM?: number | null;
  capturedAt?: string;
  source?: string;
};

type NativeDeviceLocationEvent = {
  requestId?: string;
  ok?: boolean;
  payload?: NativeDeviceLocationPayload;
  error?: {
    code?: string;
    message?: string;
  };
};

const NATIVE_LOCATION_EVENT = 'osi-native-device-location';

function getAndroidBridge(): AndroidBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { AndroidBridge?: AndroidBridge }).AndroidBridge;
  return candidate ?? null;
}

function isIosNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & {
    webkit?: { messageHandlers?: Record<string, { postMessage?: (message?: unknown) => void }> };
  }).webkit?.messageHandlers?.openAppSettings);
}

function isNativeApp(): boolean {
  const bridge = getAndroidBridge();
  if (bridge?.isNativeApp) {
    try {
      return Boolean(bridge.isNativeApp());
    } catch {
      return false;
    }
  }
  return isIosNativeApp();
}

function hasNativeLocationBridge(): boolean {
  const bridge = getAndroidBridge();
  if (bridge?.requestDeviceLocation) {
    return true;
  }

  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & {
    webkit?: { messageHandlers?: Record<string, { postMessage?: (message?: unknown) => void }> };
  }).webkit?.messageHandlers?.requestDeviceLocation);
}

function canUseGeolocationApi(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

function isSecureLocationContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const hostname = window.location.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function allowsGeolocationByPolicy(): boolean {
  if (typeof document === 'undefined') return true;
  const policyHost = (document as Document & {
    permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
    featurePolicy?: { allowsFeature?: (feature: string) => boolean };
  });
  const policy = policyHost.permissionsPolicy ?? policyHost.featurePolicy;
  if (!policy?.allowsFeature) return true;
  try {
    return policy.allowsFeature('geolocation');
  } catch {
    return true;
  }
}

async function getPermissionState(): Promise<DeviceLocationPermissionState> {
  if (typeof navigator === 'undefined') return 'unknown';
  const permissions = (navigator as Navigator & {
    permissions?: {
      query?: (descriptor: PermissionDescriptor) => Promise<{ state?: string }>;
    };
  }).permissions;

  if (!permissions?.query) return 'unknown';

  try {
    const result = await permissions.query({ name: 'geolocation' } as PermissionDescriptor);
    if (result?.state === 'granted' || result?.state === 'prompt' || result?.state === 'denied') {
      return result.state;
    }
  } catch {
    // Some browsers expose navigator.permissions but do not support geolocation queries.
  }

  return 'unknown';
}

function createSupport(
  reason: DeviceLocationSupportReason,
  permissionState: DeviceLocationPermissionState
): DeviceLocationSupport {
  const nativeApp = isNativeApp();
  if (reason === 'available') {
    return {
      available: true,
      reason,
      permissionState,
      isNativeApp: nativeApp,
      canOpenSettings: nativeApp,
      message: 'Use your phone or browser location to fill latitude and longitude.',
    };
  }

  if (reason === 'permission_denied') {
    return {
      available: false,
      reason,
      permissionState,
      isNativeApp: nativeApp,
      canOpenSettings: nativeApp,
      message: nativeApp
        ? 'Location permission is currently denied. Enable it in the app settings and try again.'
        : 'Location permission is currently denied. Enable it in your browser settings and try again.',
    };
  }

  if (reason === 'insecure_context') {
    return {
      available: false,
      reason,
      permissionState,
      isNativeApp: nativeApp,
      canOpenSettings: false,
      message: 'Device GPS needs a secure context. Open this page over HTTPS or use the mobile app.',
    };
  }

  if (reason === 'permissions_policy_blocked') {
    return {
      available: false,
      reason,
      permissionState,
      isNativeApp: nativeApp,
      canOpenSettings: false,
      message: 'This page is blocked from using location by browser policy.',
    };
  }

  return {
    available: false,
    reason,
    permissionState,
    isNativeApp: nativeApp,
    canOpenSettings: false,
    message: 'This browser or app does not expose device geolocation.',
  };
}

export async function getDeviceLocationSupport(): Promise<DeviceLocationSupport> {
  if (hasNativeLocationBridge()) {
    return {
      available: true,
      reason: 'available',
      permissionState: 'unknown',
      isNativeApp: true,
      canOpenSettings: true,
      message: 'Uses the mobile app location service to fill latitude and longitude.',
    };
  }

  if (!canUseGeolocationApi()) {
    return createSupport('unsupported', 'unknown');
  }

  if (!isSecureLocationContext()) {
    return createSupport('insecure_context', 'unknown');
  }

  if (!allowsGeolocationByPolicy()) {
    return createSupport('permissions_policy_blocked', 'unknown');
  }

  const permissionState = await getPermissionState();
  if (permissionState === 'denied') {
    return createSupport('permission_denied', permissionState);
  }

  return createSupport('available', permissionState);
}

function requestPosition(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function requestNativeDeviceLocation(): Promise<DeviceLocationCapture> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Native device location is unavailable.'));
      return;
    }

    const requestId = `native-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = (listener: EventListener, timeoutId: number) => {
      window.removeEventListener(NATIVE_LOCATION_EVENT, listener);
      window.clearTimeout(timeoutId);
    };

    const listener: EventListener = (event) => {
      const detail = (event as CustomEvent<NativeDeviceLocationEvent>).detail;
      if (!detail || detail.requestId !== requestId) return;
      cleanup(listener, timeoutId);

      if (!detail.ok) {
        const nativeError = new Error(detail.error?.message || 'Unable to get device location.');
        (nativeError as Error & { code?: string }).code = detail.error?.code;
        reject(nativeError);
        return;
      }

      const payload = detail.payload ?? {};
      if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude)) {
        reject(new Error('Native device location returned invalid coordinates.'));
        return;
      }

      resolve({
        latitude: Number(payload.latitude),
        longitude: Number(payload.longitude),
        accuracyM: Number.isFinite(payload.accuracyM as number) ? Number(payload.accuracyM) : null,
        capturedAt: payload.capturedAt ?? new Date().toISOString(),
        source: 'native-app',
      });
    };

    const timeoutId = window.setTimeout(() => {
      cleanup(listener, timeoutId);
      const timeoutError = new Error('Timed out while waiting for device location.');
      (timeoutError as Error & { code?: string }).code = 'timeout';
      reject(timeoutError);
    }, 20000);

    window.addEventListener(NATIVE_LOCATION_EVENT, listener);

    try {
      const bridge = getAndroidBridge();
      if (bridge?.requestDeviceLocation) {
        bridge.requestDeviceLocation(requestId);
        return;
      }

      const iosHandler = (window as Window & {
        webkit?: { messageHandlers?: Record<string, { postMessage?: (message?: unknown) => void }> };
      }).webkit?.messageHandlers?.requestDeviceLocation;

      if (iosHandler?.postMessage) {
        iosHandler.postMessage({ requestId });
        return;
      }

      cleanup(listener, timeoutId);
      reject(new Error('Native device location is unavailable.'));
    } catch (error) {
      cleanup(listener, timeoutId);
      reject(error instanceof Error ? error : new Error('Native device location request failed.'));
    }
  });
}

export async function requestDeviceLocation(): Promise<DeviceLocationCapture> {
  if (hasNativeLocationBridge()) {
    return requestNativeDeviceLocation();
  }

  const support = await getDeviceLocationSupport();
  if (!support.available) {
    throw new Error(support.message);
  }

  try {
    const position = await requestPosition({
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000,
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
      capturedAt: new Date().toISOString(),
      source: support.isNativeApp ? 'native-app' : 'browser',
    };
  } catch (error) {
    const geoError = error as GeolocationPositionError;
    if (geoError?.code !== geoError?.PERMISSION_DENIED) {
      const fallback = await requestPosition({
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000,
      });
      return {
        latitude: fallback.coords.latitude,
        longitude: fallback.coords.longitude,
        accuracyM: Number.isFinite(fallback.coords.accuracy) ? fallback.coords.accuracy : null,
        capturedAt: new Date().toISOString(),
        source: support.isNativeApp ? 'native-app' : 'browser',
      };
    }
    throw error;
  }
}

export function getDeviceLocationErrorMessage(error: unknown): string {
  const geoError = error as (Partial<GeolocationPositionError> & { code?: string }) | null | undefined;
  if (geoError?.code === 'permission_denied') {
    return isNativeApp()
      ? 'Location permission was denied. Enable it in the app settings and try again.'
      : 'Location permission was denied. Enable it in your browser settings and try again.';
  }
  if (geoError?.code === 'position_unavailable') {
    return 'Device location is unavailable right now. Try again outdoors or near a window.';
  }
  if (geoError?.code === 'timeout') {
    return 'Timed out while waiting for device location. Check that location services are enabled and try again.';
  }
  if (geoError?.code === 1) {
    return isNativeApp()
      ? 'Location permission was denied. Enable it in the app settings and try again.'
      : 'Location permission was denied. Enable it in your browser settings and try again.';
  }
  if (geoError?.code === 2) {
    return 'Device location is unavailable right now. Try again outdoors or near a window.';
  }
  if (geoError?.code === 3) {
    return 'Timed out while waiting for device location. Check that location services are enabled and try again.';
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unable to get device location.';
}

export function openNativeLocationSettings(): boolean {
  const bridge = getAndroidBridge();
  if (bridge?.openAppSettings) {
    try {
      bridge.openAppSettings();
      return true;
    } catch {
      return false;
    }
  }

  const iosHandler = (window as Window & {
    webkit?: { messageHandlers?: Record<string, { postMessage?: (message?: unknown) => void }> };
  }).webkit?.messageHandlers?.openAppSettings;

  if (iosHandler?.postMessage) {
    try {
      iosHandler.postMessage(null);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
