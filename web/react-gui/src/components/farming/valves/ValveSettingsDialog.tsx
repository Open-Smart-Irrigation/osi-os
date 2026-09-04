import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StregaGeneration, ValveSummary } from '../../../types/farming';
import { devicesAPI, valvesAPI } from '../../../services/api';

export interface ValveSettingsDialogProps {
  valve: ValveSummary;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

type FlowSource = 'measured' | 'estimated';

export const ValveSettingsDialog: React.FC<ValveSettingsDialogProps> = ({ valve, open, onClose, onChanged }) => {
  const { t } = useTranslation('valves');
  const { t: tc } = useTranslation('common');
  const [generation, setGeneration] = useState<StregaGeneration>(valve.stregaGeneration);
  const [flowRateInput, setFlowRateInput] = useState(valve.flowRateLpm !== null ? String(valve.flowRateLpm) : '');
  const [flowSource, setFlowSource] = useState<FlowSource>(valve.flowRateSource === 'measured' ? 'measured' : 'estimated');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeDone, setCloseDone] = useState(false);

  useEffect(() => {
    if (open) {
      setGeneration(valve.stregaGeneration);
      setFlowRateInput(valve.flowRateLpm !== null ? String(valve.flowRateLpm) : '');
      setFlowSource(valve.flowRateSource === 'measured' ? 'measured' : 'estimated');
      setError(null);
      setConfirmClose(false);
      setCloseDone(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, valve.deviceEui]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = flowRateInput.trim();
  const parsedFlowRate = trimmed === '' ? null : Number(trimmed);
  const isFlowRateValid = parsedFlowRate === null || (Number.isFinite(parsedFlowRate) && parsedFlowRate > 0);
  const titleId = `valve-settings-title-${valve.deviceEui}`;

  const handleSave = async () => {
    if (!isFlowRateValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await valvesAPI.updateSettings(valve.deviceEui, {
        stregaGeneration: generation,
        flowRateLpm: parsedFlowRate,
        ...(parsedFlowRate !== null ? { flowRateSource: flowSource } : {}),
      });
      onChanged();
      onClose();
    } catch {
      setError(t('settingsDialog.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Manual override. STREGA's normal path is OPEN_FOR_DURATION and the valve closes itself
  // when the timer elapses -- a bare CLOSE is deliberately NOT part of routine irrigation.
  // This exists for the stuck-open case: if the scheduler is emptied mid-cycle, the valve keeps
  // its own timer and stays open until the next scheduler event, and nothing else can shut it.
  // The dashboard's Cancel action does not help there -- it flushes the ChirpStack queue and
  // marks local state, it never sends a close downlink. Hence: settings-only, two-step.
  const handleClose = async () => {
    setBusy(true);
    setError(null);
    try {
      await devicesAPI.controlValve(valve.deviceEui, { action: 'CLOSE' });
      setCloseDone(true);
      setConfirmClose(false);
      onChanged();
    } catch {
      setError(t('settingsDialog.closeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">{t('settingsDialog.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={tc('close')}
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--secondary-bg)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            &times;
          </button>
        </div>

        <div className="mt-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]" htmlFor={`valve-generation-${valve.deviceEui}`}>
            {t('settingsDialog.generation')}
          </label>
          <select
            id={`valve-generation-${valve.deviceEui}`}
            value={generation}
            disabled={busy}
            onChange={(event) => setGeneration(event.target.value as StregaGeneration)}
            className="mt-1 min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
          >
            <option value="GEN1">{t('settingsDialog.gen1')}</option>
            <option value="GEN2">{t('settingsDialog.gen2')}</option>
          </select>
        </div>

        <div className="mt-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]" htmlFor={`valve-flow-rate-${valve.deviceEui}`}>
            {t('settingsDialog.flowRate')}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`valve-flow-rate-${valve.deviceEui}`}
              type="number"
              min={0}
              step="0.1"
              inputMode="decimal"
              value={flowRateInput}
              disabled={busy}
              onChange={(event) => setFlowRateInput(event.target.value)}
              className="min-h-[44px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <button
              type="button"
              onClick={() => setFlowRateInput('')}
              disabled={busy || trimmed === ''}
              className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('settingsDialog.clear')}
            </button>
          </div>
          {!isFlowRateValid && (
            <p className="mt-1 text-xs text-[var(--warn-text)]">{t('settingsDialog.flowRateHint')}</p>
          )}
        </div>

        {parsedFlowRate !== null && (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('settingsDialog.flowSource')}</p>
            <div className="mt-1 flex gap-2">
              <label className="flex min-h-[44px] items-center gap-2 px-1 text-sm text-[var(--text)] sm:min-h-0 sm:px-0">
                <input
                  type="radio"
                  name={`valve-flow-source-${valve.deviceEui}`}
                  checked={flowSource === 'measured'}
                  disabled={busy}
                  onChange={() => setFlowSource('measured')}
                  className="h-4 w-4"
                />
                {t('settingsDialog.measured')}
              </label>
              <label className="flex min-h-[44px] items-center gap-2 px-1 text-sm text-[var(--text)] sm:min-h-0 sm:px-0">
                <input
                  type="radio"
                  name={`valve-flow-source-${valve.deviceEui}`}
                  checked={flowSource === 'estimated'}
                  disabled={busy}
                  onChange={() => setFlowSource('estimated')}
                  className="h-4 w-4"
                />
                {t('settingsDialog.estimated')}
              </label>
            </div>
          </div>
        )}

        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="text-sm font-semibold text-[var(--text)]">{t('settingsDialog.overrideTitle')}</p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('settingsDialog.overrideHint')}</p>
          {closeDone ? (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('settingsDialog.closeSent')}</p>
          ) : confirmClose ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleClose()}
                disabled={busy}
                className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--warn-border)] px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy && <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />}
                {t('settingsDialog.closeConfirm')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                disabled={busy}
                className="min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {tc('cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClose(true)}
              disabled={busy}
              className="mt-2 min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('settingsDialog.closeValve')}
            </button>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-[var(--warn-text)]">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!isFlowRateValid || busy}
            className="flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />}
            {t('settingsDialog.save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ValveSettingsDialog;
