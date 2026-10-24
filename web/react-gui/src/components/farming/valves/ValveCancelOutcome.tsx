import { useTranslation } from 'react-i18next';
import { removedCollateral, type ValveCancelCollateralItem, type ValveCancelResult } from '../../../services/valveCancel';

// What a cancel did (owner decisions D04 and D19/Q01 = (a)). A cancel is a whole-queue flush:
// the first line says what happened to the pending open, and the list names the other queued
// items the flush took out of the valve's queue. A plan update removed this way is not sent
// again on its own; the tile shows it as "device may not hold this plan".
export function ValveCancelOutcome({ valveName, result }: { valveName: string; result: ValveCancelResult }) {
  const { t } = useTranslation('valves');
  const removed = removedCollateral(result);
  const showHelp = result.outcome === 'handed_off' || result.outcome === 'already_running';
  // Owner ruling 2026-10-24: nothing is replayed after a cancel. A removed plan change (a clear or
  // a reduction) never reached the valve, so it still runs its previous program.
  const planRemoved = removed.some((item) => item.ownerType === 'push' && (item.purpose === 'WEEKDAY_PLAN' || item.purpose === 'DAYMASK_PLAN'));
  const label = (item: ValveCancelCollateralItem): string => {
    if (item.ownerType === 'push') {
      if (item.purpose === 'WEEKDAY_PLAN' && item.weekday != null) {
        const day = t(`weekdays.${item.weekday}`, { defaultValue: String(item.weekday) });
        return t('cancelCollateral.weekdayPlan', { weekday: day });
      }
      if (item.purpose === 'CLOCK_SYNC') return t('cancelCollateral.clockSync');
      if (item.purpose === 'SCHEDULER_STATUS') return t('cancelCollateral.schedulerStatus');
      return t('cancelCollateral.planGroup');
    }
    if (item.ownerType === 'expectation') return t('cancelCollateral.open');
    return item.fport != null ? t('cancelCollateral.config', { fport: item.fport }) : t('cancelCollateral.configUnknown');
  };
  return (
    <div role="status" className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--text)]">
      <p>
        <span className="font-semibold">{valveName}</span>
        {': '}
        {t(`cancelOutcome.${result.outcome}`)}
      </p>
      {showHelp && <p className="mt-1 text-[var(--text-secondary)]">{t('cancelHelp')}</p>}
      {planRemoved && <p className="mt-1 font-semibold text-[var(--warn-text)]">{t('cancelCollateral.planStillRunning')}</p>}
      {removed.length > 0 && (
        <>
          <p className="mt-1">{t('cancelCollateral.title')}</p>
          <ul className="ml-4 list-disc">
            {removed.map((item) => <li key={`${item.ownerType}:${item.ownerId}`}>{label(item)}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
