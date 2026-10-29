import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { IrrigationZone, ZoneRecommendation } from '../../types/farming';
import { dendroAnalyticsAPI, irrigationZonesAPI } from '../../services/api';
import { STAGES, normalizeStage } from '../../agronomy/cropKc';
import { stageOptionLabel } from '../../agronomy/stageLabels';
import { HelpTip } from './shared/HelpTip';

interface Props {
  isOpen: boolean;
  zone: IrrigationZone;
  onClose: () => void;
  onSaved?: () => void;
  onEditSchedule?: () => void;
  onEditPolicy?: () => void;
}

type DrawerTab = 'scheduling' | 'analysis';

const TAB_LABELS = [
  { id: 'scheduling', key: 'advancedSchedule.tabScheduling' },
  { id: 'analysis',   key: 'advancedSchedule.tabAnalysis' },
] as const;

const CALIBRATION_KEYS = [
  { value: 'default', key: 'zoneConfig.calibration.default' },
  { value: 'apple', key: 'zoneConfig.calibration.apple' },
  { value: 'grapevine', key: 'zoneConfig.calibration.grapevine' },
  { value: 'olive', key: 'zoneConfig.calibration.olive' },
] as const;

const RESPONSE_MODES = [
  { value: 'proportional', key: 'advancedSchedule.responseModeOption.proportional' },
  { value: 'fixed', key: 'advancedSchedule.responseModeOption.fixed' },
  { value: 'aggressive', key: 'advancedSchedule.responseModeOption.aggressive' },
] as const;

/** Stable backend codes map to translated display strings; unknown stress retains its numeric level. */
const DENDRO_STRESS_KEY = {
  1: 'advancedSchedule.stressLevel.low',
  2: 'advancedSchedule.stressLevel.medium',
  3: 'advancedSchedule.stressLevel.high',
  4: 'advancedSchedule.stressLevel.conservative',
} as const;

const SD_VPD_STATUS_KEY = {
  coupled: 'advancedSchedule.sdVpdStatus.coupled',
  decoupled: 'advancedSchedule.sdVpdStatus.decoupled',
  insufficient_data: 'advancedSchedule.sdVpdStatus.insufficient_data',
} as const;

function formatR2(value: number | null | undefined, insufficientData: string): string {
  return value != null ? value.toFixed(3) : insufficientData;
}

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

const SchedulingTab: React.FC<{ zone: IrrigationZone; onSaved?: () => void; onEditSchedule?: () => void; onEditPolicy?: () => void }> = ({ zone, onSaved, onEditSchedule, onEditPolicy }) => {
  const { t } = useTranslation('devices');
  const { t: valveT } = useTranslation('valves');
  const sched = zone.schedule;
  const isDendro = (sched?.triggerMetric ?? sched?.trigger_metric) === 'DENDRO';

  // Phenology & calibration — saved via updateConfig
  const [phenoStage, setPhenoStage] = useState<string>(normalizeStage(zone.phenologicalStage) ?? '');
  const [calibKey, setCalibKey]     = useState(zone.calibrationKey ?? 'default');
  const [configSaving, setConfigSaving] = useState(false);

  // Schedule params — duration + response mode, saved via updateSchedule

  useEffect(() => {
    setPhenoStage(normalizeStage(zone.phenologicalStage) ?? '');
    setCalibKey(zone.calibrationKey ?? 'default');
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


  const thresholdKpa = sched?.thresholdKpa ?? sched?.threshold_kpa;
  const stressLabel  = isDendro && thresholdKpa != null
    ? t(DENDRO_STRESS_KEY[Number(thresholdKpa) as keyof typeof DENDRO_STRESS_KEY] ?? 'advancedSchedule.stressLevelOther', { level: thresholdKpa })
    : null;
  const lastTriggered = sched?.lastTriggeredAt ?? (sched as any)?.last_triggered_at;

  return (
    <div>
      {/* ── Phenology ── */}
      <Section title={t('advancedSchedule.sectionPhenology', 'Phenology')}>
        <div className="py-2 space-y-2">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <p className="text-xs text-[var(--text-secondary)]">{t('zoneConfig.phenologicalStage', { defaultValue: 'Phenological stage' })}</p>
              <HelpTip label={t('zoneConfig.stageHelpLabel', { defaultValue: 'About growth stages' })}>
                {t('zoneConfig.stageHelp', {
                  defaultValue: 'FAO-56 growth stages set the crop coefficient Kc: initial until about 10 % ground cover, development until full cover, mid-season until maturity starts, late season until harvest or leaf fall. Dormancy (Kc 0.25) is for deciduous crops and annual rest periods; evergreens such as citrus, olive, coffee and banana keep their late-season Kc instead.',
                })}
              </HelpTip>
            </div>
            <select
              aria-label={t('zoneConfig.phenologicalStage', { defaultValue: 'Phenological stage' })}
              value={phenoStage}
              disabled={configSaving}
              onChange={e => { setPhenoStage(e.target.value); handleConfigSave('phenologicalStage', e.target.value || 'default'); }}
              className="w-full bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-1.5 text-xs"
            >
              <option value="">{t('zoneConfig.stage.unset', { defaultValue: 'Not set' })}</option>
              {STAGES.map(stage => (
                <option key={stage} value={stage}>{stageOptionLabel(t, zone.cropType, stage)}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{t('zoneConfig.dendroCalibration')}</p>
            <select
              value={calibKey}
              disabled={configSaving}
              onChange={e => { setCalibKey(e.target.value); handleConfigSave('calibrationKey', e.target.value); }}
              className="w-full bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-1.5 text-xs"
            >
              {CALIBRATION_KEYS.map(o => <option key={o.value} value={o.value}>{t(o.key)}</option>)}
            </select>
          </div>
          <p className="text-xs text-[var(--text-tertiary)] pt-1">
            {t('advancedSchedule.phenologyDescription')}
          </p>
        </div>
      </Section>

      {/* ── Schedule parameters ── */}
      <Section title={t('advancedSchedule.sectionScheduleParameters', 'Schedule parameters')}>
        {stressLabel && <Field label={t('advancedSchedule.stressTriggerLevel')} value={stressLabel} />}

        {/* Duration — editable */}
        <div className="flex justify-between items-center gap-2 py-1.5 border-b border-[var(--border)]">
          <span className="text-[var(--text-secondary)] text-xs">{t('advancedSchedule.baseDuration')}</span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={sched?.durationMinutes ?? sched?.duration_minutes ?? 20}
              readOnly
              min={1} max={240}
              className="w-16 text-xs bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded px-2 py-0.5 text-right"
            />
            <span className="text-xs text-[var(--text-tertiary)]">min</span>
          </div>
        </div>

        {/* Response mode — editable */}
        <div className="flex justify-between items-center gap-2 py-1.5 border-b border-[var(--border)]">
          <span className="text-[var(--text-secondary)] text-xs shrink-0">{t('schedule.responseMode')}</span>
          <select
            value={sched?.responseMode ?? sched?.response_mode ?? 'proportional'}
            onChange={() => {}}
            disabled
            className="text-xs bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded px-2 py-0.5 max-w-[180px]"
          >
            {RESPONSE_MODES.map(o => <option key={o.value} value={o.value}>{t(o.key)}</option>)}
          </select>
        </div>

        <Field
          label={t('advancedSchedule.lastTriggered')}
          value={lastTriggered ? new Date(lastTriggered).toLocaleString() : t('advancedSchedule.never')}
        />

        {/* Save button */}
        <div className="pt-2 pb-1 flex flex-wrap items-center gap-2">
          {sched && <button
            onClick={onEditSchedule}
            disabled={!onEditSchedule}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50 text-[var(--on-primary)] text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            {valveT('irrigationPreference.editSchedule')}
          </button>}
          {onEditPolicy && <button
            onClick={onEditPolicy}
            className="border border-[var(--primary)] text-[var(--primary)] hover:bg-[var(--secondary-bg)] text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            {valveT('irrigationPolicy.openEditor', { defaultValue: 'Configure conditional irrigation' })}
          </button>}
        </div>
      </Section>

      {/* ── Rain suppression ── */}
      <Section title={t('advancedSchedule.sectionRainSuppression', 'Rain suppression')}>
        <Field label={t('advancedSchedule.status')} value={zone.schedule ? t('advancedSchedule.weatherControlled') : t('advancedSchedule.noSchedule')} />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          {t('advancedSchedule.rainSuppressionDescription')}
        </p>
      </Section>

      {/* ── Recovery verification ── */}
      <Section title={t('advancedSchedule.sectionRecoveryVerification', 'Recovery verification')}>
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          {t('advancedSchedule.recoveryDescription')}
        </p>
      </Section>

      {/* ── Zone aggregation ── */}
      <Section title={t('advancedSchedule.sectionZoneAggregation', 'Zone aggregation')}>
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          {t('advancedSchedule.aggregationDescription')}
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
  const { t } = useTranslation('devices');
  const latest = recommendations[0];
  const diagnostics = latest?.diagnostics ?? null;
  const sdVpdSummary = diagnostics?.sdVpdSummary ?? null;
  const vpdOverrideSummary = diagnostics?.vpdOverrideSummary ?? null;

  const [timezone, setTimezone]   = useState(zone.timezone ?? 'UTC');
  const [tzSaving, setTzSaving]   = useState(false);
  const [tzStatus, setTzStatus] = useState<'saved' | 'failed' | null>(null);

  useEffect(() => {
    setTimezone(zone.timezone ?? 'UTC');
  }, [zone]);

  const handleTimezoneSave = async () => {
    setTzSaving(true);
    setTzStatus(null);
    try {
      await irrigationZonesAPI.updateConfig(zone.id, { timezone });
      setTzStatus('saved');
      onSaved?.();
    } catch {
      setTzStatus('failed');
    } finally {
      setTzSaving(false);
    }
  };

  return (
    <div>
      {/* ── Extraction windows ── */}
      <Section title={t('advancedSchedule.sectionExtractionWindows', 'Extraction windows')}>
        {/* Timezone — inline editable */}
        <div className="py-1.5 border-b border-[var(--border)]">
          <p className="text-xs text-[var(--text-secondary)] mb-1">{t('zoneConfig.timezone')}</p>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder={t('advancedSchedule.timezoneExample')}
              className="flex-1 text-xs font-mono bg-[var(--card)] border border-[var(--border)] text-[var(--text)] rounded px-2 py-1"
            />
            <button
              onClick={handleTimezoneSave}
              disabled={tzSaving}
              className="text-xs bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50 text-[var(--on-primary)] font-semibold px-2.5 py-1 rounded-lg transition-colors shrink-0"
            >
              {tzSaving ? '…' : t('zoneConfig.save')}
            </button>
          </div>
          {tzStatus === 'saved' && <span className="text-xs text-green-600 mt-0.5 block">{t('schedule.saved')}</span>}
          {tzStatus === 'failed' && <span className="text-xs text-red-600 mt-0.5 block">{t('advancedSchedule.timezoneSaveFailed')}</span>}
        </div>

        <Field label={t('advancedSchedule.dmaxWindow')} value={t('advancedSchedule.localWindow', { start: '23:00', end: '07:00' })} />
        <Field label={t('advancedSchedule.dminWindow')} value={t('advancedSchedule.localWindow', { start: '10:00', end: '16:00' })} />
      </Section>

      {/* ── TWD method ── */}
      <Section title={t('advancedSchedule.sectionTwdMethod', 'TWD method')}>
        <Field label={t('advancedSchedule.method')} value={t('advancedSchedule.stepwiseEnvelope')} />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          {t('advancedSchedule.twdDescription')}
        </p>
      </Section>

      {/* ── SD-VPD correlation ── */}
      <Section title={t('advancedSchedule.sectionSdVpdCorrelation', 'SD-VPD correlation')}>
        <Field
          label={t('advancedSchedule.baselineR2')}
          value={sdVpdSummary ? formatR2(sdVpdSummary.baselineR2, t('advancedSchedule.insufficientData')) : t('advancedSchedule.diagnosticsUnavailable')}
        />
        <Field
          label={t('advancedSchedule.rolling14DayR2')}
          value={sdVpdSummary ? formatR2(sdVpdSummary.rolling14dR2, t('advancedSchedule.insufficientData')) : t('advancedSchedule.diagnosticsUnavailable')}
        />
        <Field
          label={t('advancedSchedule.sdVpdStatusLabel')}
          value={sdVpdSummary
            ? SD_VPD_STATUS_KEY[sdVpdSummary.status] ? t(SD_VPD_STATUS_KEY[sdVpdSummary.status]) : undefined
            : t('advancedSchedule.diagnosticsUnavailable')}
        />
        <Field
          label={t('advancedSchedule.vpdOverrides')}
          value={vpdOverrideSummary
            ? t('advancedSchedule.vpdOverrideCounts', { downgraded: vpdOverrideSummary.downgradedTreeCount, upgraded: vpdOverrideSummary.upgradedTreeCount })
            : t('advancedSchedule.diagnosticsUnavailable')}
        />
        <p className="text-xs text-[var(--text-tertiary)] py-2">
          {t('advancedSchedule.sdVpdDescription')}
        </p>
      </Section>

      {/* ── Latest reasoning trace ── */}
      {loading && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-3 text-xs text-[var(--text-tertiary)]">
          {t('advancedSchedule.loadingRecommendations')}
        </div>
      )}

      {!loading && latest && (
        <Section title={t('advancedSchedule.sectionLatestReasoningTrace', 'Latest reasoning trace')}>
          <p className="text-xs text-[var(--text)] py-2 leading-relaxed font-mono whitespace-pre-wrap break-words">
            {latest.action_reasoning}
          </p>
          <Field label={t('advancedSchedule.computedAt')} value={new Date(latest.computed_at).toLocaleString()} />
          <Field label={t('advancedSchedule.usableTrees')} value={latest.usable_tree_count} />
          <Field label={t('advancedSchedule.lowConfidenceTrees')} value={latest.low_confidence_tree_count} />
          <Field label={t('advancedSchedule.outlierFiltered')} value={latest.outlier_filtered_tree_count} />
          <Field
            label={t('advancedSchedule.zoneConfidence')}
            value={latest.zone_confidence_score != null
              ? `${(latest.zone_confidence_score * 100).toFixed(0)}%`
              : '—'}
          />
        </Section>
      )}

      {!loading && !latest && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-3 text-xs text-[var(--text-tertiary)]">
          {t('advancedSchedule.noRecommendations')}
        </div>
      )}
    </div>
  );
};

// ── Root component ─────────────────────────────────────────────────────────────

export const AdvancedScheduleDrawer: React.FC<Props> = ({
  isOpen, zone, onClose, onSaved, onEditSchedule, onEditPolicy,
}) => {
  const { t } = useTranslation('devices');
  const { t: valveT } = useTranslation('valves');
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
          <h2 className="text-lg font-bold text-[var(--text)]">{valveT('irrigationPreference.advanced')} — {zone.name}</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text)] text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)]">
          {TAB_LABELS.map(({ id, key }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
                tab === id
                  ? 'text-[var(--primary)] border-b-2 border-[var(--primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'scheduling' && <SchedulingTab zone={zone} onSaved={onSaved} onEditSchedule={onEditSchedule} onEditPolicy={onEditPolicy} />}
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
