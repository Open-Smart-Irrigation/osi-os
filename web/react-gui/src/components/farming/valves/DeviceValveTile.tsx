import React, { useEffect, useMemo, useState } from 'react';
import { mutate } from 'swr';
import { useTranslation } from 'react-i18next';
import type { Device, ValveSummary } from '../../../types/farming';
import { devicesAPI, valvesAPI } from '../../../services/api';
import { deriveValveGlyphState } from './valveState';
import { ValveTile } from './ValveTile';
import { ValveOpenDialog } from './ValveOpenDialog';
import { ValveScheduleDialog } from './ValveScheduleDialog';
import { ValveSettingsDialog } from './ValveSettingsDialog';
import { ValveServiceDialog } from './ValveServiceDialog';

// Same SWR key ValveControlPanel/FarmingDashboard both fetch under -- revalidating it here
// after a tile-driven action refreshes every subscriber on the key (the top panel included,
// wherever it happens to be mounted), matching how ValveControlPanel's own `refresh()`
// already behaves for its grid.
const VALVES_LIST_SWR_KEY = '/api/valves';

export interface DeviceValveTileProps {
  device: Device;
  // The valve-list row for this device (from GET /api/valves) -- already fetched once at
  // FarmingDashboard level and threaded down as `valvesByEui`, unlike the OSI Server cloud's
  // `DeviceValveTile` (which owns its own `useSWR` fetch because its caller has no such map
  // to hand it). `undefined`/`null` means "not loaded yet" -- renders a loading placeholder,
  // never a fabricated empty tile.
  valve: ValveSummary | null | undefined;
  onUpdate: () => void;
  onRemove?: () => void;
  // Zone-scoped detach vs. farm-level unclaim -- see IrrigationZoneCard's own wiring. Absent
  // (the unassigned-devices grid) falls back to `devicesAPI.remove` below, matching the
  // pre-C2 StregaValveCard's own default behavior there.
  removeDevice?: (deviceEui: string) => Promise<void>;
}

type DialogKind = 'open' | 'schedule' | 'settings' | 'service' | null;

/**
 * C2 final fix wave ("one ValveTile everywhere"): the STREGA_VALVE placement inside a zone
 * card or the unassigned-devices grid now renders the SAME `ValveTile` the top-level
 * `ValveControlPanel` grid uses, instead of the retired `StregaValveCard` (+ `ValveCancelButton`).
 * Ported from the OSI Server cloud's `DeviceValveTile.tsx`/`ValveTileConnected.tsx` pair,
 * collapsed into one component here: the edge's `ValveControlPanel` inlines its own
 * open/cancel/schedule-status/delete wiring rather than delegating to a shared "connected"
 * component, so there is no second caller yet that would justify splitting this the same way
 * the cloud did.
 *
 * `removeDevice`/`onRemove` carry the same per-placement removal split #171/C2 call for:
 * zone-scoped detach (`IrrigationZoneCard` injects `removeDevice`, and this tile shows
 * "Remove from zone" copy) vs. farm-level unclaim (the unassigned grid passes no
 * `removeDevice`, so this falls back to `devicesAPI.remove` with the ordinary "Delete valve"
 * copy) -- see `ValveTile`'s own `deleteMenuLabel`/`deleteConfirm*` props.
 */
export const DeviceValveTile: React.FC<DeviceValveTileProps> = ({ device, valve, onUpdate, onRemove, removeDevice }) => {
  const { t } = useTranslation('valves');
  const { t: tc } = useTranslation('common');

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dialogKind, setDialogKind] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Same conditional 1s ticker ValveControlPanel runs, scoped to this one tile.
  const isLive = useMemo(() => {
    if (!valve) return false;
    const state = deriveValveGlyphState(valve, nowMs).state;
    return state === 'open' || state === 'pending';
  }, [valve, nowMs]);

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [isLive]);

  const closeDialog = () => setDialogKind(null);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      void mutate(VALVES_LIST_SWR_KEY);
      onUpdate();
    } catch {
      setActionError(t('actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSubmit = async (minutes: number) => {
    if (!valve) return;
    await devicesAPI.controlValve(valve.deviceEui, { action: 'OPEN_FOR_DURATION', duration_seconds: minutes * 60 });
    // The open command already succeeded at this point -- a failure saving the "remember
    // this duration" preference is not worth surfacing as an open failure (matches
    // ValveControlPanel.handleOpenSubmit's identical rule).
    try {
      await valvesAPI.updateSettings(valve.deviceEui, { defaultOpenMinutes: minutes });
    } catch (err) {
      console.warn('Failed to save the default open-minutes preference', err);
    }
    void mutate(VALVES_LIST_SWR_KEY);
    onUpdate();
  };

  const handleDelete = () => runAction(async () => {
    if (!valve) return;
    await (removeDevice ?? devicesAPI.remove)(valve.deviceEui);
    onRemove?.();
  });

  if (!valve) {
    return <p className="text-sm text-[var(--text-tertiary)]">{tc('loading')}</p>;
  }

  return (
    <div className="space-y-2">
      {actionError && (
        <p className="rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-xs text-[var(--warn-text)]">
          {actionError}
        </p>
      )}
      <ValveTile
        valve={valve}
        nowMs={nowMs}
        busy={busy}
        batteryPercent={device.latest_data?.bat_pct}
        batteryVoltage={device.latest_data?.bat_v}
        onOpen={() => setDialogKind('open')}
        onSchedule={() => setDialogKind('schedule')}
        onSettings={() => setDialogKind('settings')}
        onService={() => setDialogKind('service')}
        onCancel={() => runAction(() => devicesAPI.cancelIrrigation(valve.deviceEui))}
        onSkipToday={() => runAction(() => valvesAPI.setSchedulerStatus(valve.deviceEui, 'SKIP_TODAY'))}
        onPause={() => runAction(() => valvesAPI.setSchedulerStatus(valve.deviceEui, 'DEACTIVATED'))}
        onResume={() => runAction(() => valvesAPI.setSchedulerStatus(valve.deviceEui, 'ACTIVE'))}
        onResend={() => runAction(() => valvesAPI.resendPlan(valve.deviceEui))}
        onDelete={handleDelete}
        deleteMenuLabel={removeDevice ? t('removeFromZoneMenuItem') : undefined}
        deleteConfirmTitle={removeDevice ? t('removeFromZoneConfirmTitle') : undefined}
        deleteConfirmBody={removeDevice ? t('removeFromZoneConfirmBody') : undefined}
        deleteConfirmButton={removeDevice ? t('removeFromZoneConfirmButton') : undefined}
      />

      <ValveOpenDialog
        valve={valve}
        open={dialogKind === 'open'}
        onClose={closeDialog}
        onSubmit={handleOpenSubmit}
      />
      <ValveScheduleDialog
        valve={valve}
        open={dialogKind === 'schedule'}
        onClose={closeDialog}
        onChanged={() => { void mutate(VALVES_LIST_SWR_KEY); onUpdate(); }}
      />
      <ValveSettingsDialog
        valve={valve}
        open={dialogKind === 'settings'}
        onClose={closeDialog}
        onChanged={() => { void mutate(VALVES_LIST_SWR_KEY); onUpdate(); }}
      />
      {/* E1: subordinate to the tile, no independent entry point -- reached only via
          ValveTile's overflow menu (see onService above). */}
      <ValveServiceDialog
        valve={valve}
        open={dialogKind === 'service'}
        onClose={closeDialog}
        onChanged={() => { void mutate(VALVES_LIST_SWR_KEY); onUpdate(); }}
      />
    </div>
  );
};

export default DeviceValveTile;
