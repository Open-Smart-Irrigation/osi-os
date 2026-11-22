import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AgronomicEnvironment } from '../../../types/farming';
import { cropById, resolveKc } from '../../../agronomy/cropKc';
import { STAGE_FALLBACK } from '../../../agronomy/stageLabels';
import { formatWeatherValue } from '../../../utils/forecastFormat';
import { HelpTip } from '../shared/HelpTip';

interface Props {
  agronomic: AgronomicEnvironment;
  cropType?: string | null;
  phenologicalStage?: string | null;
}

// ── VPD colour scale ──────────────────────────────────────────────────────────
// Based on common crop stress thresholds

function vpdConfig(vpd: number) {
  if (vpd < 0.3) return { tone: 'info', label: 'saturated' } as const;
  if (vpd < 0.8) return { tone: 'success', label: 'low' } as const;
  if (vpd < 1.5) return { tone: 'warn', label: 'moderate' } as const;
  if (vpd < 2.5) return { tone: 'error', label: 'high' } as const;
  return { tone: 'error', label: 'stressRisk' } as const;
}

function thiConfig(thi: number) {
  if (thi < 68) return { tone: 'success', label: 'normal' } as const;
  if (thi < 72) return { tone: 'warn', label: 'alert' } as const;
  if (thi < 80) return { tone: 'error', label: 'danger' } as const;
  return { tone: 'error', label: 'emergency' } as const;
}

// ── Source label ─────────────────────────────────────────────────────────────

function SourceLabel({ source }: { source: string }) {
  const { t } = useTranslation('devices');
  const label = t(`environment.source.${source}`, { defaultValue: source.replace('_', ' ') });
  return <span className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wide">{label}</span>;
}

// ── Stat cell ─────────────────────────────────────────────────────────────────

const StatCell: React.FC<{
  label: string;
  value: string | null;
  unit?: string;
  color?: string;
  source?: string;
}> = ({ label, value, unit, color, source }) => (
  <div className="bg-[var(--card)] rounded-xl p-3 border border-[var(--border)] flex flex-col gap-1">
    <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wide font-medium">{label}</span>
    <span className="text-xl font-bold tabular-nums" style={color ? { color } : undefined}>
      {value != null ? `${value}${unit ? `\u00a0${unit}` : ''}` : '—'}
    </span>
    {source && <SourceLabel source={source} />}
  </div>
);

// ── ET section ────────────────────────────────────────────────────────────────

interface ETSectionProps {
  et0: number | null;
  serverKc: number | null;
  serverKcSource: string;
  serverEtc: number | null;
  cropType: string | null | undefined;
  phenologicalStage: string | null | undefined;
}

const ETSection: React.FC<ETSectionProps> = ({
  et0, serverKc, serverKcSource, serverEtc, cropType, phenologicalStage,
}) => {
  const { t, i18n } = useTranslation('devices');

  // Server value first, then the FAO-56 resolver (the edge helper's twin).
  const resolved = resolveKc({ cropType, phenologicalStage });
  const kc = serverKc ?? resolved.kc;
  const serverProvided = serverKc != null;
  const etc = serverEtc ?? (et0 != null ? et0 * kc : null);
  const crop = cropById(cropType);
  const stageLabel = resolved.stage
    ? t(`zoneConfig.stage.${resolved.stage}`, { defaultValue: STAGE_FALLBACK[resolved.stage] })
    : t('environment.water.stageNotSet', { defaultValue: 'stage not set' });

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
        {t('environment.agronomic.evapotranspiration', { defaultValue: 'Evapotranspiration' })}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <StatCell
          label={t('environment.agronomic.et0', { defaultValue: 'Reference ET₀' })}
          value={et0 != null ? formatWeatherValue(et0, i18n.language, 2) : null}
          unit="mm/day"
          color="var(--info-text)"
        />
        <div className="bg-[var(--card)] rounded-xl p-3 border border-[var(--border)] flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wide font-medium">
              {t('environment.agronomic.kc', { defaultValue: 'Crop coeff. Kc' })}
            </span>
            {crop && (
              <HelpTip label={t('environment.agronomic.kcHelpLabel', { defaultValue: 'About the crop coefficient' })}>
                {t('environment.agronomic.kcHelp', {
                  crop: crop.label,
                  ini: formatWeatherValue(crop.kc_ini, i18n.language, 2),
                  mid: formatWeatherValue(crop.kc_mid, i18n.language, 2),
                  end: formatWeatherValue(crop.kc_end, i18n.language, 2),
                  stage: stageLabel,
                  defaultValue: 'FAO-56 Kc for {{crop}}: initial {{ini}}, mid-season {{mid}}, end {{end}}. Current stage: {{stage}}.',
                })}
              </HelpTip>
            )}
          </div>
          <span className="text-xl font-bold tabular-nums" style={{ color: 'var(--info-text)' }}>
            {formatWeatherValue(kc, i18n.language, 2)}
          </span>
          {serverProvided ? (
            serverKcSource ? <SourceLabel source={serverKcSource} /> : null
          ) : (
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {t(`environment.water.kcSource.${resolved.kcSource}`, {
                crop: crop?.label ?? '',
                stage: stageLabel,
                defaultValue: resolved.kcSource,
              })}
            </span>
          )}
        </div>
        <StatCell
          label={t('environment.agronomic.etc', { defaultValue: 'Crop ET' })}
          value={etc != null ? formatWeatherValue(etc, i18n.language, 2) : null}
          unit="mm/day"
          color="var(--success-text)"
        />
      </div>
    </div>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

export const AgronomicTab: React.FC<Props> = ({ agronomic, cropType, phenologicalStage }) => {
  const { t, i18n } = useTranslation('devices');

  if (!agronomic.current) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)] text-center">
        {t('environment.agronomic.noData', { defaultValue: 'No agronomic data available' })}
      </div>
    );
  }

  const a = agronomic.current;

  // VPD
  const vpdCfg = a.vpdKpa != null ? vpdConfig(a.vpdKpa) : null;

  // THI
  const thiCfg = a.thi != null ? thiConfig(a.thi) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* VPD highlight */}
      {a.vpdKpa != null && vpdCfg && (
        <div
          className="rounded-xl border-2 p-4"
          style={{
            background: `var(--${vpdCfg.tone}-bg)`,
            borderColor: vpdCfg.tone === 'error' ? 'var(--danger-fg)' : `var(--${vpdCfg.tone}-border)`,
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: `var(--${vpdCfg.tone}-text)` }}>
                {t('environment.agronomic.vpd', { defaultValue: 'VPD' })}
              </p>
              <p className="text-3xl font-bold tabular-nums" style={{ color: `var(--${vpdCfg.tone}-text)` }}>
                {formatWeatherValue(a.vpdKpa, i18n.language, 2, 'kPa')}
              </p>
            </div>
            <div className="text-right">
              <span
                className="text-sm font-bold rounded-lg px-3 py-1"
                style={{ color: `var(--${vpdCfg.tone}-text)`, background: `var(--${vpdCfg.tone}-bg)` }}
              >
                {t(`environment.agronomic.vpdStatus.${vpdCfg.label}`)}
              </span>
              {a.thermodynamicSource && (
                <div className="mt-1">
                  <SourceLabel source={a.thermodynamicSource} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Thermodynamic 2×2 grid */}
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] mb-2">
          {t('environment.agronomic.conditions', { defaultValue: 'Conditions' })}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <StatCell
            label={t('environment.metrics.air_temperature_c', { defaultValue: 'Air temperature' })}
            value={a.airTemperatureC != null ? formatWeatherValue(a.airTemperatureC, i18n.language, 1) : null}
            unit="°C"
            color="var(--warn-text)"
            source={a.thermodynamicSource ?? undefined}
          />
          <StatCell
            label={t('environment.metrics.relative_humidity_pct', { defaultValue: 'Humidity' })}
            value={a.relativeHumidityPct != null ? formatWeatherValue(a.relativeHumidityPct, i18n.language, 0) : null}
            unit="%"
            color="var(--info-text)"
            source={a.thermodynamicSource ?? undefined}
          />
          <StatCell
            label={t('environment.agronomic.dewPoint', { defaultValue: 'Dew point' })}
            value={a.dewPointC != null ? formatWeatherValue(a.dewPointC, i18n.language, 1) : null}
            unit="°C"
            color="var(--info-text)"
          />
          <StatCell
            label={t('environment.agronomic.heatIndex', { defaultValue: 'Heat index' })}
            value={a.heatIndexC != null ? formatWeatherValue(a.heatIndexC, i18n.language, 1) : null}
            unit="°C"
            color="var(--warn-text)"
          />
        </div>
      </div>

      {/* ET section */}
      <ETSection
        et0={a.referenceEt0MmDay}
        serverKc={a.cropCoefficientKc}
        serverKcSource={a.cropCoefficientSource ?? ''}
        serverEtc={a.etcMmDay}
        cropType={cropType}
        phenologicalStage={phenologicalStage}
      />

      {/* THI row (optional) */}
      {a.thi != null && thiCfg && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-[var(--text-secondary)]">
            {t('environment.agronomic.thi', { defaultValue: 'THI' })}
          </span>
          <span className="font-bold tabular-nums" style={{ color: `var(--${thiCfg.tone}-text)` }}>
            {formatWeatherValue(a.thi, i18n.language, 0)}
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{ color: `var(--${thiCfg.tone}-text)`, background: `var(--${thiCfg.tone}-bg)` }}
          >
            {t(`environment.agronomic.thiStatus.${thiCfg.label}`)}
          </span>
        </div>
      )}
    </div>
  );
};
