import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AgronomicEnvironment } from '../../../types/farming';
import { getCropKc, getCropEntry } from '../cropKc';

interface Props {
  agronomic: AgronomicEnvironment;
  cropType?: string | null;
  phenologicalStage?: string | null;
}

// ── VPD colour scale ──────────────────────────────────────────────────────────
// Based on common crop stress thresholds

function vpdConfig(vpd: number): { color: string; label: string; bg: string; border: string } {
  if (vpd < 0.3)  return { color: '#0ea5e9', label: 'Saturated', bg: 'bg-sky-100',    border: 'border-sky-300' };
  if (vpd < 0.8)  return { color: '#22c55e', label: 'Low',       bg: 'bg-green-100',  border: 'border-green-300' };
  if (vpd < 1.5)  return { color: '#f59e0b', label: 'Moderate',  bg: 'bg-amber-100',  border: 'border-amber-300' };
  if (vpd < 2.5)  return { color: '#f97316', label: 'High',      bg: 'bg-orange-100', border: 'border-orange-300' };
  return              { color: '#ef4444', label: 'Stress risk', bg: 'bg-red-100',    border: 'border-red-300' };
}

// ── THI colour scale ──────────────────────────────────────────────────────────
// Temperature-Humidity Index thresholds

function thiConfig(thi: number): { color: string; label: string } {
  if (thi < 68)  return { color: '#22c55e', label: 'Normal' };
  if (thi < 72)  return { color: '#f59e0b', label: 'Alert' };
  if (thi < 80)  return { color: '#f97316', label: 'Danger' };
  return             { color: '#ef4444', label: 'Emergency' };
}

// ── Source label ─────────────────────────────────────────────────────────────

function SourceLabel({ source }: { source: string }) {
  const { t } = useTranslation('devices');
  const label = t(`environment.source.${source}`, { defaultValue: source.replace('_', ' ') });
  return <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wide">{label}</span>;
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
    <span className="text-xs text-[var(--text-tertiary)] uppercase tracking-wide font-medium">{label}</span>
    <span className="text-xl font-bold tabular-nums" style={color ? { color } : undefined}>
      {value != null ? `${value}${unit ? ` ${unit}` : ''}` : '—'}
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
  const { t } = useTranslation('devices');

  // Resolve Kc: server value first, then FAO lookup
  let kc: number | null = serverKc;
  let kcSource = serverKcSource;
  let etc: number | null = serverEtc;

  const faoKc = getCropKc(cropType, phenologicalStage);
  if (kc == null && faoKc != null) {
    kc = faoKc;
    kcSource = 'fao56_estimate';
  }

  // Client-side ETc if server didn't provide it
  if (etc == null && et0 != null && kc != null) {
    etc = et0 * kc;
  }

  const cropEntry = getCropEntry(cropType);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
        Evapotranspiration
      </p>
      <div className="grid grid-cols-3 gap-2">
        <StatCell
          label={t('environment.agronomic.et0', { defaultValue: 'Reference ET₀' })}
          value={et0 != null ? et0.toFixed(2) : null}
          unit="mm/day"
          color="#0ea5e9"
        />
        <div className="bg-[var(--card)] rounded-xl p-3 border border-[var(--border)] flex flex-col gap-1">
          <span className="text-xs text-[var(--text-tertiary)] uppercase tracking-wide font-medium">
            {t('environment.agronomic.kc', { defaultValue: 'Crop coeff. Kc' })}
          </span>
          <span className="text-xl font-bold tabular-nums" style={{ color: '#8b5cf6' }}>
            {kc != null ? kc.toFixed(2) : '—'}
          </span>
          {kcSource === 'fao56_estimate' && cropEntry ? (
            <span className="text-[10px] text-[var(--text-tertiary)]">
              FAO-56 · {cropEntry.label}
            </span>
          ) : kcSource ? (
            <SourceLabel source={kcSource} />
          ) : null}
        </div>
        <StatCell
          label={t('environment.agronomic.etc', { defaultValue: 'Crop ET' })}
          value={etc != null ? etc.toFixed(2) : null}
          unit="mm/day"
          color="#16a34a"
        />
      </div>
      {kcSource === 'fao56_estimate' && cropEntry && (
        <p className="text-xs text-[var(--text-tertiary)]">
          Kc is an FAO-56 estimate for {cropEntry.label} at the{' '}
          <span className="font-medium">{phenologicalStage ?? 'default'}</span> stage
          (ini={cropEntry.kc_ini}, mid={cropEntry.kc_mid}, end={cropEntry.kc_end}).
          The server will use a measured value once available.
        </p>
      )}
    </div>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

export const AgronomicTab: React.FC<Props> = ({ agronomic, cropType, phenologicalStage }) => {
  const { t } = useTranslation('devices');

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
        <div className={`rounded-xl border-2 p-4 ${vpdCfg.bg} ${vpdCfg.border}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: vpdCfg.color }}>
                {t('environment.agronomic.vpd', { defaultValue: 'VPD' })}
              </p>
              <p className="text-3xl font-bold tabular-nums" style={{ color: vpdCfg.color }}>
                {a.vpdKpa.toFixed(2)} kPa
              </p>
            </div>
            <div className="text-right">
              <span
                className="text-sm font-bold rounded-lg px-3 py-1"
                style={{ color: vpdCfg.color, background: 'rgba(255,255,255,0.6)' }}
              >
                {vpdCfg.label}
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
          Conditions
        </p>
        <div className="grid grid-cols-2 gap-2">
          <StatCell
            label="Air Temperature"
            value={a.airTemperatureC != null ? a.airTemperatureC.toFixed(1) : null}
            unit="°C"
            color="#f97316"
            source={a.thermodynamicSource ?? undefined}
          />
          <StatCell
            label="Humidity"
            value={a.relativeHumidityPct != null ? a.relativeHumidityPct.toFixed(0) : null}
            unit="%"
            color="#06b6d4"
            source={a.thermodynamicSource ?? undefined}
          />
          <StatCell
            label={t('environment.agronomic.dewPoint', { defaultValue: 'Dew point' })}
            value={a.dewPointC != null ? a.dewPointC.toFixed(1) : null}
            unit="°C"
            color="#38bdf8"
          />
          <StatCell
            label={t('environment.agronomic.heatIndex', { defaultValue: 'Heat index' })}
            value={a.heatIndexC != null ? a.heatIndexC.toFixed(1) : null}
            unit="°C"
            color="#fb923c"
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
          <span className="font-bold tabular-nums" style={{ color: thiCfg.color }}>
            {a.thi.toFixed(0)}
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{ color: thiCfg.color, background: thiCfg.color + '1a' }}
          >
            {thiCfg.label}
          </span>
        </div>
      )}
    </div>
  );
};
