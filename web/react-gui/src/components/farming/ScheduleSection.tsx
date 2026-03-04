import React, { useEffect, useMemo, useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';
import type { IrrigationZone } from '../../types/farming';
import { useTranslation } from 'react-i18next';

type TriggerMetric = 'SWT_WM1' | 'SWT_WM2' | 'SWT_AVG';

interface ScheduleSectionProps {
  zoneId: number;
  zoneName: string;
  /**
   * Call this after saving if the parent already has a refresh function.
   * Optional: if not provided, this component will still refresh by refetching zones itself.
   */
  onScheduleSaved?: () => void;
}

export const ScheduleSection: React.FC<ScheduleSectionProps> = ({
  zoneId,
  zoneName,
  onScheduleSaved,
}) => {
  const { t } = useTranslation('devices');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [triggerMetric, setTriggerMetric] = useState<TriggerMetric>('SWT_WM1');
  const [thresholdKpa, setThresholdKpa] = useState<number>(30);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [durationMinutes, setDurationMinutes] = useState<number>(20);

  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');

  // Load current schedule from GET /api/irrigation-zones (zone.schedule is already included by your backend)
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      setSuccess('');

      try {
        const zones = await irrigationZonesAPI.getAll();
        const z = zones.find((x: any) => Number(x.id) === Number(zoneId)) as IrrigationZone | undefined;

        if (!cancelled && z && (z as any).schedule) {
          const s: any = (z as any).schedule;
          if (s.trigger_metric) setTriggerMetric(s.trigger_metric as TriggerMetric);
          if (typeof s.threshold_kpa === 'number') setThresholdKpa(s.threshold_kpa);
          if (typeof s.duration_minutes === 'number') setDurationMinutes(s.duration_minutes);
          if (s.duration_minutes === null || s.duration_minutes === undefined) setDurationMinutes(20);
          if (typeof s.enabled === 'boolean') setEnabled(s.enabled);
          if (s.enabled === 0 || s.enabled === 1) setEnabled(Boolean(s.enabled));
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.response?.data?.message || t('schedule.loadFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [zoneId]);

  const metricLabel = useMemo(() => {
    switch (triggerMetric) {
      case 'SWT_WM1':
        return t('schedule.soilWaterTension1');
      case 'SWT_WM2':
        return t('schedule.soilWaterTension2');
      case 'SWT_AVG':
        return t('schedule.average');
      default:
        return triggerMetric;
    }
  }, [triggerMetric, t]);

  const saveSchedule = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const durationRaw = Number.isFinite(durationMinutes) ? Math.round(durationMinutes) : 20;
      const durationPayload = Math.min(240, Math.max(1, durationRaw));
      const payload = {
        trigger_metric: triggerMetric,
        threshold_kpa: thresholdKpa,
        enabled,
        duration_minutes: durationPayload,
      };
      // Use a dedicated API call (see note below)
      // PUT /api/irrigation-zones/:id/schedule
      await irrigationZonesAPI.updateSchedule(zoneId, payload);

      setSuccess(t('schedule.saved'));
      if (onScheduleSaved) onScheduleSaved();
    } catch (err: any) {
      setError(err?.response?.data?.message || t('schedule.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    Number.isFinite(thresholdKpa) && thresholdKpa > 0 && thresholdKpa <= 300 && !!triggerMetric;

  return (
    <div className="bg-[var(--card)] rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between gap-4 mb-3">
        <h4 className="text-[var(--text)] text-lg font-bold">{t('schedule.irrigationSchedule')}</h4>

        <div className="flex items-center gap-2">
          <span className="text-[var(--text-secondary)] text-sm font-semibold">{t('schedule.enabled')}</span>
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={`px-3 py-1 rounded-lg text-sm font-bold border-2 transition-colors ${
              enabled
                ? 'bg-[var(--toggle-on)] border-[var(--toggle-on)] text-white'
                : 'bg-[var(--toggle-off)] border-[var(--toggle-off)] text-[var(--text-secondary)]'
            }`}
            aria-pressed={enabled}
          >
            {enabled ? t('schedule.on') : t('schedule.off')}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-3 bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success-text)] px-3 py-2 rounded-lg text-sm">
          {success}
        </div>
      )}

      {loading ? (
        <div className="text-[var(--text-tertiary)] text-sm">{t('schedule.loadingSchedule')}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Metric Selector */}
            <div>
              <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">
                {t('schedule.triggerMetric')}
              </label>
              <select
                value={triggerMetric}
                onChange={(e) => setTriggerMetric(e.target.value as TriggerMetric)}
                className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              >
                <option value="SWT_WM1">{t('schedule.soilWaterTension1')}</option>
                <option value="SWT_WM2">{t('schedule.soilWaterTension2')}</option>
                <option value="SWT_AVG">{t('schedule.average')}</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Threshold Input */}
              <div>
                <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">
                  {t('schedule.thresholdKpa')}
                </label>
                <input
                  type="number"
                  value={thresholdKpa}
                  onChange={(e) => setThresholdKpa(Number(e.target.value))}
                  min="1"
                  max="300"
                  step="1"
                  className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
                />
                <div className="mt-1 text-[var(--text-tertiary)] text-xs">
                  {t('schedule.triggerHint', { metric: metricLabel, threshold: Number.isFinite(thresholdKpa) ? thresholdKpa : '…' })}
                </div>
              </div>

              {/* Duration Input */}
              <div>
                <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">
                  {t('schedule.duration')}
                </label>
                <input
                  type="number"
                  value={durationMinutes}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === '') {
                      setDurationMinutes((prev) => (Number.isFinite(prev) ? prev : 20));
                      return;
                    }
                    const next = Number(value);
                    if (Number.isFinite(next)) {
                      setDurationMinutes(next);
                    } else {
                      setDurationMinutes((prev) => (Number.isFinite(prev) ? prev : 20));
                    }
                  }}
                  min="1"
                  max="240"
                  step="1"
                  className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button
              type="button"
              disabled={!canSave || saving}
              onClick={saveSchedule}
              className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)] text-white font-bold text-sm px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              {saving ? t('schedule.saving') : t('schedule.saveSchedule')}
            </button>

            <button
              type="button"
              disabled={saving}
              onClick={() => {
                // reload from backend
                setLoading(true);
                setError('');
                setSuccess('');
                irrigationZonesAPI
                  .getAll()
                  .then((zones) => {
                    const z = zones.find((x: any) => Number(x.id) === Number(zoneId)) as any;
                    if (z?.schedule) {
                      setTriggerMetric(z.schedule.trigger_metric as TriggerMetric);
                      setThresholdKpa(Number(z.schedule.threshold_kpa));
                      setEnabled(Boolean(z.schedule.enabled));
                      if (typeof z.schedule.duration_minutes === 'number') {
                        setDurationMinutes(z.schedule.duration_minutes);
                      } else {
                        setDurationMinutes(20);
                      }
                    }
                  })
                  .catch((err: any) => setError(err?.response?.data?.message || t('schedule.reloadFailed')))
                  .finally(() => setLoading(false));
              }}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-sm px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {t('schedule.reload')}
            </button>
          </div>
        </>
      )}

      <div className="mt-3 text-[var(--text-tertiary)] text-xs">
        {t('schedule.backendNote')}
      </div>
    </div>
  );
};
