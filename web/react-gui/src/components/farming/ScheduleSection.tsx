import React, { useEffect, useMemo, useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';
import type { IrrigationZone } from '../../types/farming';

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
          setError(err?.response?.data?.message || 'Failed to load schedule');
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
        return 'Soil Water Tension 1';
      case 'SWT_WM2':
        return 'Soil Water Tension 2';
      case 'SWT_AVG':
        return 'Average (WM1 + WM2)';
      default:
        return triggerMetric;
    }
  }, [triggerMetric]);

  const saveSchedule = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const durationRaw = Number.isFinite(durationMinutes) ? Math.round(durationMinutes) : 20;
      const durationPayload = Math.min(240, Math.max(1, durationRaw));
      if (import.meta.env?.DEV && !Number.isFinite(durationMinutes)) {
        console.warn('[ScheduleSection] duration_minutes is not a finite number, defaulting to 20.');
      }
      const payload = {
        trigger_metric: triggerMetric,
        threshold_kpa: thresholdKpa,
        enabled,
        duration_minutes: durationPayload,
      };
      if (
        import.meta.env?.DEV &&
        (payload.duration_minutes === undefined ||
          payload.duration_minutes === null ||
          Number.isNaN(payload.duration_minutes))
      ) {
        console.error('[ScheduleSection] duration_minutes missing from save payload', payload);
      }
      console.log('[ScheduleSection] Save payload', {
        durationMinutes,
        durationPayload,
        payload,
      });
      // Use a dedicated API call (see note below)
      // PUT /api/irrigation-zones/:id/schedule
      await irrigationZonesAPI.updateSchedule(zoneId, payload);

      setSuccess('Saved.');
      if (onScheduleSaved) onScheduleSaved();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    Number.isFinite(thresholdKpa) && thresholdKpa > 0 && thresholdKpa <= 300 && !!triggerMetric;

  return (
    <div className="bg-slate-800 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between gap-4 mb-3">
        <h4 className="text-white text-lg font-bold">Irrigation Schedule</h4>

        <div className="flex items-center gap-2">
          <span className="text-slate-300 text-sm font-semibold">Enabled</span>
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={`px-3 py-1 rounded-lg text-sm font-bold border-2 transition-colors ${
              enabled
                ? 'bg-green-600/20 border-green-600 text-green-200'
                : 'bg-slate-700 border-slate-600 text-slate-200'
            }`}
            aria-pressed={enabled}
          >
            {enabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 bg-red-500/20 border border-red-500 text-red-200 px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-3 bg-green-500/20 border border-green-500 text-green-200 px-3 py-2 rounded-lg text-sm">
          {success}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400 text-sm">Loading schedule...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Metric Selector */}
            <div>
              <label className="block text-slate-300 text-sm font-semibold mb-2">
                Trigger Metric
              </label>
              <select
                value={triggerMetric}
                onChange={(e) => setTriggerMetric(e.target.value as TriggerMetric)}
                className="w-full px-3 py-2 bg-slate-700 border-2 border-slate-600 rounded-lg text-white focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
              >
                <option value="SWT_WM1">Soil Water Tension 1</option>
                <option value="SWT_WM2">Soil Water Tension 2</option>
                <option value="SWT_AVG">Average (WM1 + WM2)</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Threshold Input */}
              <div>
                <label className="block text-slate-300 text-sm font-semibold mb-2">
                  Threshold (kPa)
                </label>
                <input
                  type="number"
                  value={thresholdKpa}
                  onChange={(e) => setThresholdKpa(Number(e.target.value))}
                  min="1"
                  max="300"
                  step="1"
                  className="w-full px-3 py-2 bg-slate-700 border-2 border-slate-600 rounded-lg text-white focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
                />
                <div className="mt-1 text-slate-400 text-xs">
                  Trigger if {metricLabel} ≥ {Number.isFinite(thresholdKpa) ? thresholdKpa : '…'} kPa (once/day, 06:00).
                </div>
              </div>

              {/* Duration Input */}
              <div>
                <label className="block text-slate-300 text-sm font-semibold mb-2">
                  Irrigation duration (min)
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
                  className="w-full px-3 py-2 bg-slate-700 border-2 border-slate-600 rounded-lg text-white focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button
              type="button"
              disabled={!canSave || saving}
              onClick={saveSchedule}
              className="bg-farm-green hover:bg-green-600 disabled:bg-slate-600 text-white font-bold text-sm px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save schedule'}
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
                  .catch((err: any) => setError(err?.response?.data?.message || 'Failed to reload schedule'))
                  .finally(() => setLoading(false));
              }}
              className="bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              Reload
            </button>
          </div>
        </>
      )}

      <div className="mt-3 text-slate-400 text-xs">
        Scheduler logic (backend): trigger if metric_kpa ≥ threshold_kpa, only once per day, fixed 06:00.
      </div>
    </div>
  );
};
