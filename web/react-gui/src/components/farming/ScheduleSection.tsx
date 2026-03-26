import React, { useEffect, useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';
import type { IrrigationZone, SchedulerType, DendroStressThreshold, TriggerMetric } from '../../types/farming';
import { useTranslation } from 'react-i18next';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode dendrometer stress threshold to/from threshold_kpa slot */
const DENDRO_STRESS_VALUES: Record<DendroStressThreshold, number> = {
  mild: 1, moderate: 2, significant: 3, severe: 4,
};
const DENDRO_STRESS_FROM_NUM: Record<number, DendroStressThreshold> = {
  1: 'mild', 2: 'moderate', 3: 'significant', 4: 'severe',
};

/** User-facing sensitivity labels — no internal metric names */
const DENDRO_STRESS_LABELS: Record<DendroStressThreshold, string> = {
  mild:        'Low sensitivity — irrigate at first signs of stress',
  moderate:    'Medium sensitivity — irrigate at moderate stress (recommended)',
  significant: 'High sensitivity — irrigate only under significant stress',
  severe:      'Conservative — irrigate only at severe stress',
};

const RESPONSE_MODE_LABELS: Record<string, string> = {
  proportional: 'Proportional — scale duration with stress level',
  fixed:        'Fixed — always irrigate for base duration',
  aggressive:   'Aggressive — extend duration strongly at high stress',
};

function schedulerTypeFromMetric(metric: string): SchedulerType {
  if (metric === 'DENDRO') return 'DENDRO';
  if (metric === 'VWC') return 'VWC';
  return 'SWT';
}

function defaultMetricForType(type: SchedulerType, currentMetric: TriggerMetric): TriggerMetric {
  if (type === 'DENDRO') return 'DENDRO';
  if (type === 'VWC') return 'VWC';
  if (currentMetric === 'SWT_WM1' || currentMetric === 'SWT_WM2' || currentMetric === 'SWT_WM3' || currentMetric === 'SWT_AVG') return currentMetric;
  return 'SWT_WM1';
}

// ── Scheduler type tab button ─────────────────────────────────────────────────
const TypeTab: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active, onClick, children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap ${
      active
        ? 'bg-[var(--primary)] border-[var(--primary)] text-white'
        : 'bg-[var(--surface)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)]'
    }`}
  >
    {children}
  </button>
);

// ── Sub-forms ─────────────────────────────────────────────────────────────────
interface SwtFormProps {
  metric: TriggerMetric;
  threshold: number;
  duration: number;
  onMetric: (v: TriggerMetric) => void;
  onThreshold: (v: number) => void;
  onDuration: (v: number) => void;
}
const SwtForm: React.FC<SwtFormProps> = ({ metric, threshold, duration, onMetric, onThreshold, onDuration }) => {
  const metricLabel =
    metric === 'SWT_WM1' ? 'Sensor 1' :
    metric === 'SWT_WM2' ? 'Sensor 2' :
    metric === 'SWT_WM3' ? 'Sensor 3' : 'Mean of all sensors';
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Sensor</label>
        <select
          value={metric}
          onChange={e => onMetric(e.target.value as TriggerMetric)}
          className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
        >
          <option value="SWT_WM1">Sensor 1</option>
          <option value="SWT_WM2">Sensor 2</option>
          <option value="SWT_WM3">Sensor 3</option>
          <option value="SWT_AVG">Mean (all sensors)</option>
        </select>
      </div>
      <div>
        <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Threshold (kPa)</label>
        <input
          type="number"
          value={threshold}
          onChange={e => onThreshold(Number(e.target.value))}
          min="1" max="300" step="1"
          className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
        />
        <p className="mt-1 text-[var(--text-tertiary)] text-xs">
          Irrigate when {metricLabel} exceeds {threshold} kPa
        </p>
      </div>
      <div>
        <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Duration (min)</label>
        <input
          type="number"
          value={duration}
          onChange={e => onDuration(Number(e.target.value))}
          min="1" max="240" step="1"
          className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
        />
      </div>
    </div>
  );
};

interface VwcFormProps {
  threshold: number;
  duration: number;
  onThreshold: (v: number) => void;
  onDuration: (v: number) => void;
}
const VwcForm: React.FC<VwcFormProps> = ({ threshold, duration, onThreshold, onDuration }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
    <div>
      <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Threshold (%)</label>
      <input
        type="number"
        value={threshold}
        onChange={e => onThreshold(Number(e.target.value))}
        min="1" max="100" step="1"
        className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
      />
      <p className="mt-1 text-[var(--text-tertiary)] text-xs">
        Irrigate when VWC drops below {threshold}%
      </p>
    </div>
    <div>
      <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Duration (min)</label>
      <input
        type="number"
        value={duration}
        onChange={e => onDuration(Number(e.target.value))}
        min="1" max="240" step="1"
        className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
      />
    </div>
  </div>
);

interface DendroFormProps {
  stressThreshold: DendroStressThreshold;
  duration: number;
  responseMode: string;
  onStress: (v: DendroStressThreshold) => void;
  onDuration: (v: number) => void;
  onResponseMode: (v: string) => void;
  onAdvanced: () => void;
}
const DendroForm: React.FC<DendroFormProps> = ({
  stressThreshold, duration, responseMode,
  onStress, onDuration, onResponseMode, onAdvanced,
}) => (
  <div className="flex flex-col gap-4">
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="sm:col-span-1">
        <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Trigger sensitivity</label>
        <select
          value={stressThreshold}
          onChange={e => onStress(e.target.value as DendroStressThreshold)}
          className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)] text-sm"
        >
          {(Object.keys(DENDRO_STRESS_LABELS) as DendroStressThreshold[]).map(k => (
            <option key={k} value={k}>{DENDRO_STRESS_LABELS[k]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Base duration (min)</label>
        <input
          type="number"
          value={duration}
          onChange={e => onDuration(Number(e.target.value))}
          min="1" max="240" step="1"
          className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
        />
      </div>
      <div>
        <label className="block text-[var(--text-secondary)] text-sm font-semibold mb-2">Response mode</label>
        <select
          value={responseMode}
          onChange={e => onResponseMode(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)] text-sm"
        >
          {Object.entries(RESPONSE_MODE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>
    </div>
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onAdvanced}
        className="text-xs text-[var(--primary)] hover:underline"
      >
        Advanced settings →
      </button>
    </div>
  </div>
);

// ── Main component ────────────────────────────────────────────────────────────
interface ScheduleSectionProps {
  zoneId: number;
  zoneName: string;
  onScheduleSaved?: () => void;
  onAdvancedOpen?: () => void;
}

export const ScheduleSection: React.FC<ScheduleSectionProps> = ({
  zoneId, onScheduleSaved, onAdvancedOpen,
}) => {
  const { t } = useTranslation('devices');
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const [enabled, setEnabled]               = useState(true);
  const [schedulerType, setSchedulerType]   = useState<SchedulerType>('SWT');
  const [triggerMetric, setTriggerMetric]   = useState<TriggerMetric>('SWT_WM1');
  const [threshold, setThreshold]           = useState(30);
  const [duration, setDuration]             = useState(20);
  const [stressThreshold, setStressThreshold] = useState<DendroStressThreshold>('moderate');
  const [responseMode, setResponseMode]     = useState('proportional');

  // ── Load ──────────────────────────────────────────────────────────────────
  const applySchedule = (s: any) => {
    if (!s) return;
    const metric: TriggerMetric = s.trigger_metric ?? s.triggerMetric ?? 'SWT_WM1';
    const type = schedulerTypeFromMetric(metric);
    setSchedulerType(type);
    setTriggerMetric(metric);
    if (type === 'DENDRO') {
      const kpa = s.threshold_kpa ?? s.thresholdKpa;
      setStressThreshold(DENDRO_STRESS_FROM_NUM[Number(kpa)] ?? 'moderate');
      setThreshold(2);
    } else {
      const kpa = s.threshold_kpa ?? s.thresholdKpa;
      setThreshold(typeof kpa === 'number' ? kpa : 30);
    }
    const mins = s.duration_minutes ?? s.durationMinutes;
    if (typeof mins === 'number') setDuration(mins);
    if (typeof s.enabled === 'boolean') setEnabled(s.enabled);
    else if (s.enabled === 0 || s.enabled === 1) setEnabled(Boolean(s.enabled));
    if (s.responseMode) setResponseMode(s.responseMode);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setSuccess('');
    irrigationZonesAPI.getAll().then((zones: any[]) => {
      if (cancelled) return;
      const z = zones.find((x: any) => Number(x.id) === Number(zoneId)) as IrrigationZone | undefined;
      if (z?.schedule) applySchedule(z.schedule);
    }).catch((err: any) => {
      if (!cancelled) setError(err?.response?.data?.message || t('schedule.loadFailed'));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [zoneId]);

  // ── Scheduler type switch ─────────────────────────────────────────────────
  const handleTypeChange = (type: SchedulerType) => {
    setSchedulerType(type);
    setTriggerMetric(defaultMetricForType(type, triggerMetric));
    if (type === 'VWC') setThreshold(prev => prev > 100 ? 30 : prev);
    if (type === 'SWT') setThreshold(prev => prev <= 100 ? 30 : prev);
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveSchedule = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const thresholdPayload = schedulerType === 'DENDRO'
        ? DENDRO_STRESS_VALUES[stressThreshold]
        : Math.min(schedulerType === 'VWC' ? 100 : 300, Math.max(1, Math.round(threshold)));
      const payload = {
        trigger_metric: triggerMetric,
        threshold_kpa: thresholdPayload,
        enabled,
        duration_minutes: Math.min(240, Math.max(1, Math.round(duration))),
        response_mode: schedulerType === 'DENDRO' ? responseMode : undefined,
      };
      await irrigationZonesAPI.updateSchedule(zoneId, payload);
      setSuccess(t('schedule.saved'));
      if (onScheduleSaved) onScheduleSaved();
    } catch (err: any) {
      setError(err?.response?.data?.message || t('schedule.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const canSave = schedulerType === 'DENDRO'
    ? true
    : Number.isFinite(threshold) && threshold > 0;

  const reload = () => {
    setLoading(true);
    setError('');
    setSuccess('');
    irrigationZonesAPI.getAll().then((zones: any[]) => {
      const z = zones.find((x: any) => Number(x.id) === Number(zoneId)) as any;
      if (z?.schedule) applySchedule(z.schedule);
    }).catch((err: any) => setError(err?.response?.data?.message || t('schedule.reloadFailed')))
      .finally(() => setLoading(false));
  };

  return (
    <div className="bg-[var(--card)] rounded-lg p-4 mb-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <h4 className="text-[var(--text)] text-lg font-bold">{t('schedule.irrigationSchedule')}</h4>
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-secondary)] text-sm font-semibold">{t('schedule.enabled')}</span>
          <button
            type="button"
            onClick={() => setEnabled(v => !v)}
            className={`px-3 py-1 rounded-lg text-sm font-bold border-2 transition-colors ${
              enabled
                ? 'bg-[var(--toggle-on)] border-[var(--toggle-on)] text-white'
                : 'bg-[var(--toggle-off)] border-[var(--toggle-off)] text-[var(--text-secondary)]'
            }`}
          >
            {enabled ? t('schedule.on') : t('schedule.off')}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">{error}</div>
      )}
      {success && (
        <div className="mb-3 bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success-text)] px-3 py-2 rounded-lg text-sm">{success}</div>
      )}

      {loading ? (
        <div className="text-[var(--text-tertiary)] text-sm">{t('schedule.loadingSchedule')}</div>
      ) : (
        <>
          {/* Scheduler type selector */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              Trigger method
            </p>
            <div className="flex flex-wrap gap-2">
              <TypeTab active={schedulerType === 'SWT'} onClick={() => handleTypeChange('SWT')}>
                Soil moisture SWT
              </TypeTab>
              <TypeTab active={schedulerType === 'VWC'} onClick={() => handleTypeChange('VWC')}>
                Soil moisture VWC
              </TypeTab>
              <TypeTab active={schedulerType === 'DENDRO'} onClick={() => handleTypeChange('DENDRO')}>
                Dendrometer
              </TypeTab>
            </div>
          </div>

          {/* Conditional form */}
          {schedulerType === 'SWT' && (
            <SwtForm
              metric={triggerMetric}
              threshold={threshold}
              duration={duration}
              onMetric={setTriggerMetric}
              onThreshold={setThreshold}
              onDuration={setDuration}
            />
          )}
          {schedulerType === 'VWC' && (
            <VwcForm
              threshold={threshold}
              duration={duration}
              onThreshold={setThreshold}
              onDuration={setDuration}
            />
          )}
          {schedulerType === 'DENDRO' && (
            <DendroForm
              stressThreshold={stressThreshold}
              duration={duration}
              responseMode={responseMode}
              onStress={setStressThreshold}
              onDuration={setDuration}
              onResponseMode={setResponseMode}
              onAdvanced={onAdvancedOpen ?? (() => {})}
            />
          )}

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
              onClick={reload}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-sm px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {t('schedule.reload')}
            </button>
          </div>
        </>
      )}

    </div>
  );
};
