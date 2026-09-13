import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { devicesAPI } from '../../services/api';

/**
 * The regression this file exists to prevent: the ✕ on a device card rendered
 * *inside an irrigation zone* used to call `devicesAPI.remove(deveui)`
 * (`DELETE /api/devices/:deveui`, which nulls `user_id` and
 * `irrigation_zone_id` for the whole account) before invoking the caller's
 * `onRemove`. So "unassign from this zone" silently unlinked the device from
 * the account, while the confirm dialog promised it only left the zone.
 *
 * `StregaValveCard` was fixed for this in PR #193 (review finding C-1,
 * 2026-09-01) with a per-card guard; the other five cards still carried the bug
 * three weeks later. This hook generalises that fix so the guard cannot be
 * forgotten by a new card type: the delete call lives here, once, gated on
 * `removeContext`.
 *
 * - `'zone'` — do NOT delete anything. `onRemove` is the parent's zone detach
 *   (`IrrigationZoneCard.handleRemoveDevice` → `irrigationZonesAPI.removeDevice`).
 *   Device history (`device_data`) and the account link stay untouched.
 * - `'farm'` — the unassigned-devices grid, where the device is already
 *   zone-less and the account unlink is what the operator asked for.
 *
 * `removeContext` is deliberately required at every call site, with no default:
 * `npm run typecheck` then refuses the omission that caused this bug.
 */
export type DeviceRemoveContext = 'zone' | 'farm';

export interface DeviceRemovalOptions {
  deveui: string;
  removeContext: DeviceRemoveContext;
  onRemove?: () => void;
}

export interface DeviceRemoval {
  showConfirm: boolean;
  openConfirm: () => void;
  cancelConfirm: () => void;
  isRemoving: boolean;
  error: string | null;
  clearError: () => void;
  confirmRemove: () => Promise<void>;
}

export function useDeviceRemoval({ deveui, removeContext, onRemove }: DeviceRemovalOptions): DeviceRemoval {
  const { t } = useTranslation('devices');
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openConfirm = useCallback(() => setShowConfirm(true), []);
  const cancelConfirm = useCallback(() => setShowConfirm(false), []);
  const clearError = useCallback(() => setError(null), []);

  const confirmRemove = useCallback(async () => {
    setIsRemoving(true);
    setError(null);
    try {
      if (removeContext === 'farm') {
        await devicesAPI.remove(deveui);
      }
      onRemove?.();
      if (removeContext === 'zone') {
        // A zone detach leaves the card mounted in several layouts; close the
        // panel so a failed-then-retried detach cannot strand it open.
        setShowConfirm(false);
        setIsRemoving(false);
      }
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { message?: string } } } | null)?.response?.data?.message;
      setError(message || t(removeContext === 'zone' ? 'deviceRemoval.failedZone' : 'deviceRemoval.failedFarm'));
      setIsRemoving(false);
    }
  }, [deveui, onRemove, removeContext, t]);

  return { showConfirm, openConfirm, cancelConfirm, isRemoving, error, clearError, confirmRemove };
}
