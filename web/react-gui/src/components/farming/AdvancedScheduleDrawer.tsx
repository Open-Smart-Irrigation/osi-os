import React, { useState, useEffect } from 'react';
import type { IrrigationZone, ZoneRecommendation } from '../../types/farming';
import { dendroAnalyticsAPI, irrigationZonesAPI } from '../../services/api';

interface Props {
  isOpen: boolean;
  zone: IrrigationZone;
  onClose: () => void;
  onSaved?: () => void;
}

type DrawerTab = 'scheduling' | 'analysis';

const TAB_LABELS: { id: DrawerTab; label: string }[] = [
  { id: 'scheduling', label: 'Advanced Scheduling' },
  { id: 'analysis',   label: 'Advanced Analysis' },
];

const CALIBRATION_KEYS = [
  { value: 'default',   label: 'Default (generic thresholds)' },
  { value: 'apple',     label: 'Apple' },
  { value: 'grapevine', label: 'Grapevine' },
  { value: 'olive',     label: 'Olive' },
];

const PHENOLOGICAL_STAGES = [
  { value: 'default',   label: 'Default' },
  { value: 'dormancy',  label: 'Dormancy' },
  { value: 'budbreak',  label: 'Bud break / flowering' },
  { value: 'fruitset',  label: 'Fruit set' },
  { value: 'veraison',  label: 'Veraison / ripening' },
  { value: 'harvest',   label: 'Harvest / post-harvest' },
];

const RESPONSE_MODES = [
  { value: 'proportional', label: 'Proportional — scale with stress level' },
  { value: 'fixed',        label: 'Fixed — always use base duration' },
  { value: 'aggressive',   label: 'Aggressive — extend strongly at high stress' },
];

/** Decode threshold_kpa (1–4) back to a human-readable stress label for DENDRO mode */
const DENDRO_STRESS_LABEL: Record<number, string> = {
  1: 'Low — first signs of stress',
  2: 'Medium — moderate stress (recommended)',
  3: 'High — significant stress',
  4: 'Conservative — severe stress only',
};

const Field: React.FC<{ label: string; value: string | number | null | undefined; mono?: boolean }> = ({
  label, value, mono = false,
}) => (
  <div className="flex justify-between items-start gap-2 py-1.5 border-b border-[var(--border)] last:border-0">
    <span className="text-[var(--text-secondary)] text-xs">{label}</span>
    <span className={`text-[var(--text)] text-xs text-right ${mono ? 'font-mono' : 'font-medium'}`}>
      {value ?? <span className="text-[var(--text-tertiary)]">—</span>}
    </span>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mb-5">
    <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">{title}</p>
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1">
      {children}
    </div>
  </div>
);

// ── Scheduling tab ─────────────────────────────────────────────────────────────

const SchedulingTab: React.FC<{ zone: IrrigationZone; onSaved?: () => void }> = ({ zone, onSaved }) => {
  const sched = zone.schedule;
  const isDendro = (sched?.triggerMetric ?? sched?.trigger_metric) === 'DENDRO';

  // Phenology & calibration — saved via updateConfig
  const [phenoStage, setPhenoStage] = useState(zone.phenologicalStage ?? 'default');
  const [calibKey, setCalibKey]     = useState(zone.calibrationKey ?? 'default');
  const [configSaving, setConfigSaving] = useState(false);

  // Schedule params — duration + response mode, saved via updateSchedule
  const [duration, setDuration]         = useState<number>(sched?.durationMinutes ?? sched?.duration_minutes ?? 20);
  const [responseMode, setResponseMode] = useState<string>(sched?.responseMode ?? sched?.response_mode ?? 'proportional');
  const [schedSaving, setSchedSaving]   = useState(false);
  const [schedError, setSchedError]     = useState('');
  const [schedSuccess, setSchedSuccess] = useState('');

  useEffect(() => {
    setPhenoStage(zone.phenologicalStage ?? 'default');
    setCalibKey(zone.calibrationKey ?? 'default');
    setDuration(sched?.durationMinutes ?? sched?.duration_minutes ?? 20);
    setResponseMode(sched?.responseMode ?? sched?.response_mode ?? 'proportional');
  }, [zone]);

  const handleConfigSave = async (field: 'phenologicalStage' | 'calibrationKey', value: string) => {
    setConfigSaving(true);
    try {
      await irrigationZonesAPI.updateConfig(zone.id, { [field]: value });
      onSaved?.();
    } catch {
      // silently ignore — next open will show current value
    } finally {
      setConfigSaving(false);
    }
  };

  const handleScheduleSave = async () => {
    if (!sched) return;
    setSchedSaving(true);
    setSchedError('');
    setSchedSuccess('');
    try {
      const metric = sched.triggerMetric ?? sched.trigger_metric ?? 'DENDRO';
      const kpa    = sched.thresholdKpa  ?? sched.threshold_kpa  ?? 2;
      await irrigationZonesAPI.updateSchedule(zone.id, {
        trigger_metric:   metric as any,
        threshold_kpa:    typeof kpa === 'number' ? kpa : Number(kpa),
        enabled:          sched.enabled ?? true,
        duration_minutes: Math.min(240, Math.max(1, Math.round(duration))),
        response_mode:    responseMode,
      });
      setSchedSuccess('Saved.');
      onSaved?.();
    } catch {
      setSchedError('Failed to save. Please try again.');
    } finally {
      setSchedSaving(false);
    }
  };

  const thresholdKpa = sched?.thresholdKpa ?? sched?.threshold_kpa;
  const stressLabel  = isDendro && thresholdKpa != null
    ? (DENDRO_STRESS_LABEL[Number(thresholdKpa)] ?? `Level ${thresholdKpa}`)
    : null;
  const lastTriggered = sched?.lastTriggeredAt ?? (sched as any)?.last_triggered_at;

  return (
    <div>
      {/* ── Phenology ── */}
      <Section title="Phenology">
        <div className="py-2 space-y-2">
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">Phenological stage</p>
            <select
              value={phenoStage}
              disabled={configSaving}
              onChange={e => { setPhenoStage(e.target.value); handleConfigSave('phenologicalStage', e.target.value); }}
              className="w-full bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-1.5 text-xs"
            >
              {PHENOLOGICAL_STAGES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">Dendro calibration</p>
            <select
              value={calibKey}
              disabled={configSaving}
              onChange={e => { setCalibKey(e.target.value); handleConfigSave('calibrationKey', e.target.value); }}
              className="w-full bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-1.5 text-xs"
            >
              {CALIBRATION_KEYS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <p className="text-xs text-[var(--text-tertiary)] pt-1">
            Phenological stage adjusts stress thresholds for the current growth phase.
            Calibration key selects species-specific absolute TWD thresholds.
          </p>
        </div>
      </Section>

      {/* ── Schedule parameters ── */}
      <Section title="Schedule parameters">
        {stressLabel && <Field label="Stress trigger level" value={stressLabel} />}

        {/* Duration — editable */}
        <div className="flex justify-between items-center gap-2 py-1.5 border-b border-[var(--border)]">
          <span className="text-[var(--text-secondary)] text-xs">Base duration</span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              min={1} max={240}
              className="w-16 text-xs bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded px-2 py-0.5 text-right"
            />
            <span className="text-xs text-[var(--text-tertiary)]">min</span>
          </div>
        </div>

        {/* Response mode — editable */}
        <div className="flex justify-between items-center gap-2 py-1.5 border-b border-[var(--border)]">
          <span className="text-[var(--text-secondary)] text-xs shrink-0">Response mode</span>
          <select
            value={responseMode}
            onChange={e => setResponseMode(e.target.value)}
            className="text-xs bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded px-2 py-0.5 max-w-[180px]"
          >
            {RESPONSE_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <Field
          label="Last triggered"
          value={lastTriggered ? new Date(lastTriggered).toLocaleString() : 'Never'}
        />

        {/* Save button */}
        <div className="pt-2 pb-1 flex items-center gap-2">
          <button
            onClick={handleScheduleSave}
            disabled={schedSaving || !sched}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            {schedSaving ? 'Saving…' : 'Save parameters'}
          </button>
          {schedSuccess && <span className="text-xs text-green-600">{schedSuccess}</span>}
          {schedError   && <span className="text-xs text-red-600">{schedError}</span>}
        </div>
      </Section>

      {/* ── Rain suppression ── */}
      <Section title="Rain suppression">
        <Field label="Status" value={zone.schedule ? 'Controlled by weather integration' : 'No schedule set'} />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          Suppression lifts once the rain event is cleared from the rolling weather window.
          Tree recovery is verified before resuming any irrigation increase.
        </p>
      </Section>

      {/* ── Recovery verification ── */}
      <Section title="Recovery verification">
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          After an irrigation event, a 24 h recovery hold checks whether the pre-dawn tree
          water deficit (TWD-night) has decreased before issuing the next irrigation increase.
          Prevents over-irrigation after emergency events.
        </p>
      </Section>

      {/* ── Zone aggregation ── */}
      <Section title="Zone aggregation">
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          Zone stress is computed as the median (MAD-cleaned) across all monitored trees.
          Outlier trees (IQR × 1.5) are excluded from the recommendation but remain visible
          per-tree. Low-confidence days (QA flags: rain spike, flat-line, signal gap) are
          excluded from aggregation.
        </p>
      </Section>
    </div>
  );
};

// ── Analysis tab ───────────────────────────────────────────────────────────────

const AnalysisTab: React.FC<{
  zone: IrrigationZone;
  recommendations: ZoneRecommendation[];
  loading: boolean;
  onSaved?: () => void;
}> = ({ zone, recommendations, loading, onSaved }) => {
  const latest = recommendations[0];

  const [timezone, setTimezone]   = useState(zone.timezone ?? 'UTC');
  const [tzSaving, setTzSaving]   = useState(false);
  const [tzError, setTzError]     = useState('');
  const [tzSuccess, setTzSuccess] = useState('');

  useEffect(() => {
    setTimezone(zone.timezone ?? 'UTC');
  }, [zone]);

  const handleTimezoneSave = async () => {
    setTzSaving(true);
    setTzError('');
    setTzSuccess('');
    try {
      await irrigationZonesAPI.updateConfig(zone.id, { timezone });
      setTzSuccess('Saved.');
      onSaved?.();
    } catch {
      setTzError('Failed to save.');
    } finally {
      setTzSaving(false);
    }
  };

  return (
    <div>
      {/* ── Extraction windows ── */}
      <Section title="Extraction windows">
        {/* Timezone — inline editable */}
        <div className="py-1.5 border-b border-[var(--border)]">
          <p className="text-xs text-[var(--text-secondary)] mb-1">Timezone</p>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder="e.g. Europe/Rome"
              className="flex-1 text-xs font-mono bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded px-2 py-1"
            />
            <button
              onClick={handleTimezoneSave}
              disabled={tzSaving}
              className="text-xs bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50 text-white font-semibold px-2.5 py-1 rounded-lg transition-colors shrink-0"
            >
              {tzSaving ? '…' : 'Save'}
            </button>
          </div>
          {tzSuccess && <span className="text-xs text-green-600 mt-0.5 block">{tzSuccess}</span>}
          {tzError   && <span className="text-xs text-red-600 mt-0.5 block">{tzError}</span>}
        </div>

        <Field label="d_max window (pre-dawn)" value="23:00 – 07:00 local" />
        <Field label="d_min window (midday)"   value="10:00 – 16:00 local" />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          IANA timezone (e.g. Europe/Rome). Used to align nightly min/max extraction windows.
        </p>
      </Section>

      {/* ── TWD method ── */}
      <Section title="TWD method">
        <Field label="Method" value="Stepwise envelope (Peters et al. 2025)" />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          The rolling-window envelope tracks the maximum pre-dawn stem diameter within the
          computation window (365 days). TWD-night = envelopeRef − d_max. TWD-day =
          envelopeRef − d_min. Absolute thresholds (µm) are used; species-specific
          calibration applies via the calibration key above.
        </p>
      </Section>

      {/* ── SD-VPD correlation ── */}
      <Section title="SD-VPD correlation">
        <Field label="Baseline R²" value={zone.schedule ? 'Available after ≥14 baseline days' : '—'} />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          Stem diameter daily amplitude (SDA = d_max − d_min) is correlated with maximum
          daily VPD to detect anomalous stress response. Low correlation may indicate sensor
          issues or extreme atmospheric demand.
        </p>
      </Section>

      {/* ── Latest reasoning trace ── */}
      {loading && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-3 text-xs text-[var(--text-tertiary)]">
          Loading recommendations…
        </div>
      )}

      {!loading && latest && (
        <Section title="Latest reasoning trace">
          <p className="text-xs text-[var(--text)] py-2 leading-relaxed font-mono whitespace-pre-wrap break-words">
            {latest.action_reasoning}
          </p>
          <Field label="Computed at"          value={new Date(latest.computed_at).toLocaleString()} />
          <Field label="Usable trees"         value={latest.usable_tree_count} />
          <Field label="Low-confidence trees" value={latest.low_confidence_tree_count} />
          <Field label="Outlier-filtered"     value={latest.outlier_filtered_tree_count} />
          <Field
            label="Zone confidence"
            value={latest.zone_confidence_score != null
              ? `${(latest.zone_confidence_score * 100).toFixed(0)}%`
              : '—'}
          />
        </Section>
      )}

      {!loading && !latest && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-3 text-xs text-[var(--text-tertiary)]">
          No zone recommendations computed yet. Run dendro compute or wait for the daily 08:00 UTC job.
        </div>
      )}
    </div>
  );
};

// ── Root component ─────────────────────────────────────────────────────────────

export const AdvancedScheduleDrawer: React.FC<Props> = ({
  isOpen, zone, onClose, onSaved,
}) => {
  const [tab, setTab] = useState<DrawerTab>('scheduling');
  const [recommendations, setRecommendations] = useState<ZoneRecommendation[]>([]);
  const [recLoading, setRecLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setRecLoading(true);
    dendroAnalyticsAPI.getZoneRecommendations(zone.id, 7)
      .then(setRecommendations)
      .catch(() => setRecommendations([]))
      .finally(() => setRecLoading(false));
  }, [isOpen, zone.id]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Drawer panel */}
      <div className="relative bg-[var(--card)] border-l border-[var(--border)] w-full max-w-md h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-bold text-[var(--text)]">Advanced — {zone.name}</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text)] text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)]">
          {TAB_LABELS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
                tab === id
                  ? 'text-[var(--primary)] border-b-2 border-[var(--primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'scheduling' && <SchedulingTab zone={zone} onSaved={onSaved} />}
          {tab === 'analysis'   && (
            <AnalysisTab
              zone={zone}
              recommendations={recommendations}
              loading={recLoading}
              onSaved={onSaved}
            />
          )}
        </div>
      </div>
    </div>
  );
};
