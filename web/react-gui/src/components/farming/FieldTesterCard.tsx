import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';
import { useGatewayModules } from '../../hooks/useGatewayModules';
import { DeviceCardFooter } from './shared/DeviceCardFooter';
import { EditableName } from './shared/EditableName';
import { DeviceRemoveConfirm, deviceRemoveButtonLabel } from './DeviceRemoveConfirm';
import { useDeviceRemoval, type DeviceRemoveContext } from './useDeviceRemoval';

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

interface FieldTesterCardProps {
  device: Device;
  onRemove?: () => void;
  onUpdate?: () => void;
  readOnly?: boolean;
  /** Required: 'zone' detaches from the zone only, 'farm' unlinks from the account. */
  removeContext: DeviceRemoveContext;
}

/**
 * RAK10701 field tester (RAK10701_FIELD_TESTER): a handheld unit walked around
 * a farm to log LoRaWAN coverage, not a farming sensor. It has no telemetry
 * channels this dashboard understands, so unlike every other device card here
 * it renders no sensor readings -- identity, a link to the network map it
 * feeds (NetworkPage, route /network), and the shared remove flow are the
 * whole card.
 *
 * No last-seen line and no online/offline state: verified on real hardware
 * that the edge backend never gives a field tester's uplinks a `last_seen`
 * (they are captured into the radio store, not `device_data`, which is where
 * `GET /api/devices` derives `last_seen` from). A card that claimed recency
 * here would always read "never seen" for a tester that is in fact sending
 * every ~30 s. The network-map link is shown only when the gateway's Network
 * module is switched on, matching DashboardHeader's own gate.
 *
 * This card exists so the type renders *something*: before it, FarmingDashboard
 * and IrrigationZoneCard filtered the unassigned/zone device grids by an
 * explicit type_id allowlist that never included RAK10701_FIELD_TESTER, so a
 * registered field tester made the "Unassigned Devices" section show its
 * dashed box and subtitle with nothing inside -- visible on real hardware, and
 * with no way to see or remove the device from the dashboard.
 */
export const FieldTesterCard: React.FC<FieldTesterCardProps> = ({
  device,
  onRemove,
  onUpdate,
  readOnly = false,
  removeContext,
}) => {
  const { t } = useTranslation('devices');
  const modules = useGatewayModules();

  const handleRename = async (nextName: string) => {
    await devicesAPI.rename(device.deveui, nextName);
    onUpdate?.();
  };

  const removal = useDeviceRemoval({ deveui: device.deveui, removeContext, onRemove });

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-colors hover:border-[var(--focus)]">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <EditableName
          name={device.name}
          canEdit={!readOnly}
          onSave={handleRename}
          renameLabel={t('rename.device')}
          inputLabel={t('rename.deviceInputLabel')}
          headingClassName="text-base font-semibold text-[var(--text)] truncate leading-tight"
        />
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="bg-[var(--info-bg)] text-[var(--info-text)] px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
            {t('fieldTester.badge')}
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={removal.openConfirm}
              disabled={removal.isRemoving}
              aria-label={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
              title={deviceRemoveButtonLabel(removeContext, removal.isRemoving, t)}
              className={`touch-target p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_VISIBLE_RING}`}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] font-mono mb-3 truncate">{device.deveui}</p>

      {removal.error && (
        <div className="mb-4 rounded-lg border border-[var(--error-text)] bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
          {removal.error}
        </div>
      )}

      {!readOnly && removal.showConfirm && (
        <DeviceRemoveConfirm
          removeContext={removeContext}
          isRemoving={removal.isRemoving}
          onConfirm={() => void removal.confirmRemove()}
          onCancel={removal.cancelConfirm}
        />
      )}

      {modules?.network === true && (
        <div className="rounded-lg bg-[var(--card)] p-3">
          <Link
            to="/network"
            className={`flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:border-[var(--focus)] hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
          >
            {t('fieldTester.openCoverageMap')}
          </Link>
        </div>
      )}

      {/* No battery/sensor telemetry and no last-seen: the field tester has no
          channels this dashboard understands, and the edge never gives it a
          `last_seen` (its uplinks land in the radio store, not `device_data`).
          The footer states that plainly instead of claiming a recency this
          card cannot know. */}
      <DeviceCardFooter lastSeenLabel={t('fieldTester.readingsOnMap')} />
    </div>
  );
};
