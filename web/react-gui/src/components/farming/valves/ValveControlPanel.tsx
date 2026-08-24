import React, { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import { devicesAPI, valvesAPI } from '../../../services/api';
import type { ValveSummary } from '../../../types/farming';
import { deriveValveGlyphState } from './valveState';
import { ValveTile } from './ValveTile';
import { ValveOpenDialog } from './ValveOpenDialog';
import { ValveScheduleDialog } from './ValveScheduleDialog';
import { ValveScheduleOverview } from './ValveScheduleOverview';
import { ValveSettingsDialog } from './ValveSettingsDialog';
import { ValveServiceDialog } from './ValveServiceDialog';

export interface ValveControlPanelProps {
  onUpdate: () => void;
}

type DialogKind = 'open' | 'schedule' | 'settings' | 'service' | null;

const valvesFetcher = () => valvesAPI.list();

export const ValveControlPanel: React.FC<ValveControlPanelProps> = ({ onUpdate }) => {
  const { t } = useTranslation('valves');
  const { t: tc } = useTranslation('common');

  const { data: valves, error, mutate } = useSWR<ValveSummary[]>('/api/valves', valvesFetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dialogEui, setDialogEui] = useState<string | null>(null);
  const [dialogKind, setDialogKind] = useState<DialogKind>(null);
  const [actionBusyEui, setActionBusyEui] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const hasLiveValve = useMemo(
    () => (valves ?? []).some((v) => {
      const state = deriveValveGlyphState(v, nowMs).state;
      return state === 'open' || state === 'pending';
    }),
    [valves, nowMs],
  );

  useEffect(() => {
    if (!hasLiveValve) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasLiveValve]);

  const selectedValve = useMemo(
    () => (valves ?? []).find((v) => v.deviceEui === dialogEui) ?? null,
    [valves, dialogEui],
  );

  const closeDialog = () => {
    setDialogEui(null);
    setDialogKind(null);
  };

  const refresh = async () => {
    await mutate();
    onUpdate();
  };

  const handleOpenSubmit = async (minutes: number) => {
    if (!selectedValve) return;
    await devicesAPI.controlValve(selectedValve.deviceEui, { action: 'OPEN_FOR_DURATION', duration_seconds: minutes * 60 });
    // The open command already succeeded at this point — a failure saving the "remember this
    // duration" preference is not worth surfacing as an open failure (which would keep the
    // dialog open and imply the valve didn't actually open).
    try {
      await valvesAPI.updateSettings(selectedValve.deviceEui, { defaultOpenMinutes: minutes });
    } catch (err) {
      console.warn('Failed to save the default open-minutes preference', err);
    }
    await refresh();
  };

  const runAction = async (eui: string, action: () => Promise<unknown>) => {
    setActionBusyEui(eui);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch {
      setActionError(t('actionFailed'));
    } finally {
      setActionBusyEui(null);
    }
  };

  const dialogs = selectedValve && (
    <>
      <ValveOpenDialog
        key={`open-${selectedValve.deviceEui}`}
        valve={selectedValve}
        open={dialogKind === 'open'}
        onClose={closeDialog}
        onSubmit={handleOpenSubmit}
      />
      <ValveScheduleDialog
        key={`schedule-${selectedValve.deviceEui}`}
        valve={selectedValve}
        open={dialogKind === 'schedule'}
        onClose={closeDialog}
        onChanged={refresh}
      />
      <ValveSettingsDialog
        key={`settings-${selectedValve.deviceEui}`}
        valve={selectedValve}
        open={dialogKind === 'settings'}
        onClose={closeDialog}
        onChanged={refresh}
      />
      {/* E1: subordinate to the panel, no independent entry point -- reached only via
          ValveTile's overflow menu (see onService below). */}
      <ValveServiceDialog
        key={`service-${selectedValve.deviceEui}`}
        valve={selectedValve}
        open={dialogKind === 'service'}
        onClose={closeDialog}
        onChanged={refresh}
      />
    </>
  );

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--text)]">{t('title')}</h2>
          <p className="text-xs text-[var(--text-tertiary)]">{t('subtitle')}</p>
        </div>
      </div>

      {actionError && (
        <p className="mt-3 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-xs text-[var(--warn-text)]">
          {actionError}
        </p>
      )}

      {!valves && !error && (
        <p className="mt-4 text-sm text-[var(--text-tertiary)]">{tc('loading')}</p>
      )}

      {error && (
        <div className="mt-4 flex items-center gap-3 text-sm text-[var(--warn-text)]">
          <span>{t('loadFailed')}</span>
          <button
            type="button"
            onClick={() => mutate()}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)]"
          >
            {tc('retry')}
          </button>
        </div>
      )}

      {valves && valves.length === 0 && (
        <p className="mt-4 text-sm text-[var(--text-tertiary)]">{t('empty')}</p>
      )}

      {valves && valves.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {valves.map((valve) => (
            <ValveTile
              key={valve.deviceEui}
              valve={valve}
              nowMs={nowMs}
              busy={actionBusyEui === valve.deviceEui}
              onOpen={() => { setDialogEui(valve.deviceEui); setDialogKind('open'); }}
              onSchedule={() => { setDialogEui(valve.deviceEui); setDialogKind('schedule'); }}
              onSettings={() => { setDialogEui(valve.deviceEui); setDialogKind('settings'); }}
              onService={() => { setDialogEui(valve.deviceEui); setDialogKind('service'); }}
              onCancel={() => runAction(valve.deviceEui, () => devicesAPI.cancelIrrigation(valve.deviceEui))}
              onSkipToday={() => runAction(valve.deviceEui, () => valvesAPI.setSchedulerStatus(valve.deviceEui, 'SKIP_TODAY'))}
              onPause={() => runAction(valve.deviceEui, () => valvesAPI.setSchedulerStatus(valve.deviceEui, 'DEACTIVATED'))}
              onResume={() => runAction(valve.deviceEui, () => valvesAPI.setSchedulerStatus(valve.deviceEui, 'ACTIVE'))}
              onResend={() => runAction(valve.deviceEui, () => valvesAPI.resendPlan(valve.deviceEui))}
              onDelete={() => runAction(valve.deviceEui, () => devicesAPI.remove(valve.deviceEui))}
            />
          ))}
        </div>
      )}

      {/* Saved schedules are a plan for the whole holding, not a per-valve detail: the farmer
          should see every valve's programme at once rather than opening each tile in turn.
          Rows deep-link into the per-valve dialog for editing. */}
      {valves && valves.length > 0 && (
        <ValveScheduleOverview
          valves={valves}
          onOpenValve={(valve) => { setDialogEui(valve.deviceEui); setDialogKind('schedule'); }}
        />
      )}

      {dialogs}
    </section>
  );
};

export default ValveControlPanel;
