export type DeviceLocationPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';
export type DeviceLocationSupportReason = 'available' | 'unsupported' | 'insecure_context' | 'permissions_policy_blocked' | 'permission_denied';
export interface DeviceLocationSupport { available: boolean; reason: DeviceLocationSupportReason; message: string; permissionState: DeviceLocationPermissionState; isNativeApp: boolean; canOpenSettings: boolean; }
export interface DeviceLocationCapture { latitude: number; longitude: number; accuracyM: number | null; capturedAt: string; source: 'browser' | 'native-app'; }

const FARM_POSITION = {latitude: 0.3476, longitude: 32.5825};
const support: DeviceLocationSupport = {available: true, reason: 'available', permissionState: 'granted',
  isNativeApp: false, canOpenSettings: false, message: 'Use the fictional demonstration farm location.'};

export async function getDeviceLocationSupport(): Promise<DeviceLocationSupport> { return {...support}; }
export async function requestDeviceLocation(): Promise<DeviceLocationCapture> {
  return {...FARM_POSITION, accuracyM: 8, capturedAt: new Date().toISOString(), source: 'browser'};
}
export function getDeviceLocationErrorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Unable to select the fictional demonstration farm location.'; }
export function openNativeLocationSettings(): boolean { return false; }
