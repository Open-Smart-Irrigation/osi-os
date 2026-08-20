import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StregaGeneration, ValveSummary } from '../../../types/farming';
import { valvesAPI } from '../../../services/api';

export interface ValveSettingsDialogProps {
  valve: ValveSummary;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

type FlowSource = 'measured' | 'estimated';

export const ValveSettingsDialog: React.FC<ValveSettingsDialogProps> = ({ valve, open, onClose, onChanged }) => {
  const { t } = useTranslation('valves');
  const [generation, setGeneration] = useState<StregaGeneration>(valve.stregaGeneration);
  const [flowRateInput, setFlowRateInput] = useState(valve.flowRateLpm !== null ? String(valve.flowRateLpm) : '');
  const [flowSource, setFlowSource] = useState<FlowSource>(valve.flowRateSource === 'measured' ? 'measured' : 'estimated');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setGeneration(valve.stregaGeneration);
      setFlowRateInput(valve.flowRateLpm !== null ? String(valve.flowRateLpm) : '');
      setFlowSource(valve.flowRateSource === 'measured' ? 'measured' : 'estimated');
      setError(null);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text)]">{t('settingsDialog.title')}</h2>

        <div className="mt-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]" htmlFor={`valve-generation-${valve.deviceEui}`}>
            {t('settingsDialog.generation')}
          </label>
          <select
            id={`valve-generation-${valve.deviceEui}`}
            value={generation}
            disabled={busy}
            onChange={(event) => setGeneration(event.target.value as StregaGeneration)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
          >
            <option value="GEN1">GEN1</option>
            <option value="GEN2">{t('settingsDialog.gen2Untested')}</option>
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
              className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
            />
            <button
              type="button"
              onClick={() => setFlowRateInput('')}
              disabled={busy || trimmed === ''}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
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
            <div className="mt-1 flex gap-4">
              <label className="flex items-center gap-2 text-sm text-[var(--text)]">
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
              <label className="flex items-center gap-2 text-sm text-[var(--text)]">
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

        {error && <p className="mt-3 text-sm text-[var(--warn-text)]">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--secondary-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!isFlowRateValid || busy}
            className="flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
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
