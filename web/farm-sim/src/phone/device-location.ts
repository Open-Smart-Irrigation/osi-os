import i18n from '@osi-demo/i18n';
import {gameNotice} from './copy';
import type {DeviceLocationCapture, DeviceLocationSupport} from '../../../react-gui/src/services/deviceLocation';

export type {
  DeviceLocationCapture,
  DeviceLocationPermissionState,
  DeviceLocationSupport,
  DeviceLocationSupportReason,
} from '../../../react-gui/src/services/deviceLocation';

const refusal = () => gameNotice(i18n, 'game_refused');

export async function getDeviceLocationSupport(): Promise<DeviceLocationSupport> {
  return {
    available: false,
    reason: 'unsupported',
    permissionState: 'unknown',
    isNativeApp: false,
    canOpenSettings: false,
    message: refusal(),
  };
}

export async function requestDeviceLocation(): Promise<DeviceLocationCapture> {
  throw new Error(refusal());
}

export function getDeviceLocationErrorMessage(_error: unknown): string {
  return refusal();
}

export function openNativeLocationSettings(): boolean {
  return false;
}
