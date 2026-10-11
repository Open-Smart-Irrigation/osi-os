import type {Device} from '../../types/farming';
import {devicesAPI} from '../../services/api';
import {EditableName} from './shared/EditableName';
import {DeviceCardFooter} from './shared/DeviceCardFooter';
import {DeviceRemoveConfirm, deviceRemoveButtonLabel} from './DeviceRemoveConfirm';
import {useDeviceRemoval, type DeviceRemoveContext} from './useDeviceRemoval';

function formatReportedChannelState(value: unknown): string {
  if (value === 'open') return 'Open';
  if (value === 'close') return 'Closed';
  return 'Unavailable';
}

export function Uc512DeviceCard({device, onRemove, onUpdate, readOnly = false, removeContext}: {
  device: Device; onRemove?: () => void; onUpdate?: () => void; readOnly?: boolean; removeContext: DeviceRemoveContext;
}) {
  const removal = useDeviceRemoval({deveui: device.deveui, removeContext, onRemove});
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
    <EditableName name={device.name} canEdit={!readOnly} onSave={async name => { await devicesAPI.rename(device.deveui, name); onUpdate?.(); }}
      renameLabel="Rename device" inputLabel="Device name" headingClassName="text-base font-semibold text-[var(--text)]" />
    <p className="mt-2 text-sm text-[var(--text-secondary)]">Milesight UC512 · fictional device</p>
    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
      <dt className="text-[var(--text-tertiary)]">Device ID</dt><dd className="break-all text-[var(--text)]">{device.deveui}</dd>
      <dt className="text-[var(--text-tertiary)]">Battery</dt><dd className="text-[var(--text)]">{device.latest_data.bat_pct == null ? '—' : `${device.latest_data.bat_pct}%`}</dd>
      <dt className="text-[var(--text-tertiary)]">Valve 1 state</dt><dd className="text-[var(--text)]">{formatReportedChannelState((device.latest_data as Record<string, unknown>).valve_1_state)}</dd>
      <dt className="text-[var(--text-tertiary)]">Valve 2 state</dt><dd className="text-[var(--text)]">{formatReportedChannelState((device.latest_data as Record<string, unknown>).valve_2_state)}</dd>
    </dl>
    <p className="mt-3 text-xs text-[var(--text-tertiary)]">This card has no valve controls.</p>
    <div className="mt-3 flex items-center justify-between">
      <DeviceCardFooter lastSeenLabel={device.last_seen ?? 'Unavailable'} batteryPercent={device.latest_data.bat_pct} batteryVoltage={device.latest_data.bat_v} />
      {!readOnly && <button type="button" aria-label={deviceRemoveButtonLabel(removeContext, removal.isRemoving, key => key)} onClick={removal.openConfirm}
        className="touch-target rounded-md border border-[var(--error-border)] px-3 py-2 text-sm text-[var(--error-text)]">Remove</button>}
    </div>
    {removal.error && <p role="alert" className="mt-2 text-sm text-[var(--error-text)]">{removal.error}</p>}
    {!readOnly && removal.showConfirm && <DeviceRemoveConfirm removeContext={removeContext} isRemoving={removal.isRemoving}
      onConfirm={() => void removal.confirmRemove()} onCancel={removal.cancelConfirm} />}
  </section>;
}
