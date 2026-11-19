import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { useDateFormat, type DateFormatter } from '../../utils/datetime';
import { dendroAPI, type DendroHistoryPoint } from '../../services/api';

interface Props {
  deveui: string;
  deviceName: string;
  strokeMm?: number | null;
  onClose: () => void;
}

const TIME_WINDOWS = [
  { label: '12 h', hours: 12 },
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 168 },
  { label: '30 d', hours: 720 },
  { label: '90 d', hours: 2160 },
];

function fmtTickShort(iso: string, hours: number, format: DateFormatter): string {
  if (hours <= 24) {
    return format.time(iso) ?? '—';
  }
  if (hours <= 168) {
    return format.date(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) ?? '—';
  }
  return format.date(iso) ?? '—';
}

function formatDendroModeUsed(value: unknown): 'dendroCalibration.modeRatio' | 'dendroCalibration.modeLegacy' | null {
  if (value === 'ratio_mod3') return 'dendroCalibration.modeRatio';
  if (value === 'legacy_single_adc') return 'dendroCalibration.modeLegacy';
  return null;
}

function formatStemChangeUm(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded} µm`;
}

type StemHistoryPoint = DendroHistoryPoint & { stem_change_um: number };
type MechanicalHistoryPoint = DendroHistoryPoint & { mechanical_position_mm: number };

function hasStemChange(point: DendroHistoryPoint): point is StemHistoryPoint {
  return point.valid === 1 && point.stem_change_um != null;
}

function getMechanicalPositionMm(point: DendroHistoryPoint): number | null {
  return point.position_raw_mm ?? point.position_mm ?? null;
}

function hasCalibratedPosition(point: DendroHistoryPoint): point is MechanicalHistoryPoint {
  return point.valid === 1 && getMechanicalPositionMm(point) != null;
}

function hasRawDendroSignals(point: DendroHistoryPoint): boolean {
  return point.adc_ch0v != null || point.adc_ch1v != null || point.dendro_ratio != null;
}

const TooltipStemChange = ({ active, payload, label, hours, format }: any) => {
  const { t } = useTranslation('devices');
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as DendroHistoryPoint;
  const sourceLabel = formatDendroModeUsed(point.dendro_mode_used);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{fmtTickShort(label, hours, format)}</p>
      {point.stem_change_um != null && (
        <p className="font-bold text-[var(--text)]">{formatStemChangeUm(point.stem_change_um)}</p>
      )}
      {getMechanicalPositionMm(point) != null && (
        <p className="text-xs text-[var(--text-tertiary)]">{t('dendrometerMonitor.position')}: {getMechanicalPositionMm(point)?.toFixed(2)} mm</p>
      )}
      {point.saturated === 1 && (
        <p className="text-xs text-[var(--warn-text)]">
          {point.saturation_side === 'high' ? t('dendrometerMonitor.aboveRange') : t('dendrometerMonitor.belowRange')}
        </p>
      )}
      {sourceLabel && (
        <p className="text-xs text-[var(--text-tertiary)]">{t('dendrometerMonitor.source')}: {t(sourceLabel)}</p>
      )}
    </div>
  );
};

const MechanicalStat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg bg-[var(--card)] p-3">
    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</p>
    <p className="mt-1 text-base font-semibold text-[var(--text)]">{value}</p>
  </div>
);

export const DendrometerMonitor: React.FC<Props> = ({ deveui, deviceName, strokeMm, onClose }) => {
  const { t } = useTranslation('devices');
  const format = useDateFormat();
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<DendroHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    dendroAPI.getHistory(deveui, hours)
      .then((rows) => {
        if (!cancelled) {
          setData(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deveui, hours]);

  const plottedData = useMemo(() => data.filter(hasStemChange), [data]);
  const mechanicalData = useMemo(
    () => data
      .filter(hasCalibratedPosition)
      .map((point) => ({ ...point, mechanical_position_mm: getMechanicalPositionMm(point)! })),
    [data],
  );

  const posTicks = useMemo(() => {
    if (!plottedData.length) return [];
    const step = Math.max(1, Math.floor(plottedData.length / 8));
    return plottedData.filter((_, i) => i % step === 0).map((d) => d.t);
  }, [plottedData]);

  const stemValues = plottedData.map((point) => point.stem_change_um);
  const minStem = stemValues.length ? Math.min(...stemValues) : null;
  const maxStem = stemValues.length ? Math.max(...stemValues) : null;
  const latestStemPoint = plottedData[plottedData.length - 1] ?? null;
  const latestMechanicalPoint = mechanicalData[mechanicalData.length - 1] ?? null;
  const mechanicalMin = mechanicalData.length ? Math.min(...mechanicalData.map((point) => point.mechanical_position_mm)) : null;
  const mechanicalMax = mechanicalData.length ? Math.max(...mechanicalData.map((point) => point.mechanical_position_mm)) : null;
  const latestSourceLabel = latestMechanicalPoint ? formatDendroModeUsed(latestMechanicalPoint.dendro_mode_used) : null;
  const strokePercent = strokeMm != null && strokeMm > 0 && latestMechanicalPoint
    ? Math.max(0, Math.min(100, (latestMechanicalPoint.mechanical_position_mm / strokeMm) * 100))
    : null;
  const hasRawOnlySamples = data.some((point) => !hasCalibratedPosition(point) && hasRawDendroSignals(point));
  const hasMechanicalOnlySamples = mechanicalData.length > 0 && plottedData.length === 0;
  const latestSaturationLabel = latestMechanicalPoint?.saturated === 1
    ? latestMechanicalPoint.saturation_side === 'high'
      ? t('dendrometerMonitor.aboveRange')
      : t('dendrometerMonitor.belowRange')
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-[var(--bg)] shadow-2xl">
        <div className="shrink-0 bg-[var(--header-bg)] px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="high-contrast-text break-words text-2xl font-bold text-[var(--header-text)]">{t('dendrometerMonitor.title')}</h2>
              <p className="mt-0.5 truncate text-sm text-[var(--header-subtext)]">{deviceName} · {deveui}</p>
            </div>
            <button
              onClick={onClose}
              aria-label={t('monitor.close')}
              className="touch-target shrink-0 px-2 text-3xl font-light leading-none text-[var(--header-text)] hover:text-[var(--text-secondary)]"
            >
              ×
            </button>
          </div>
        </div>

        <div className="shrink-0 px-6 pt-4">
          <div className="flex flex-wrap gap-2">
            {TIME_WINDOWS.map((window) => (
              <button
                key={window.hours}
                onClick={() => setHours(window.hours)}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                  hours === window.hours
                    ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                    : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--border)]'
                }`}
              >
                {t(window.hours <= 24 ? 'monitor.hours' : 'monitor.days', { count: window.hours <= 24 ? window.hours : window.hours / 24 })}
              </button>
            ))}
          </div>
        </div>

        {!loading && !error && plottedData.length > 0 && (
          <div className="grid shrink-0 grid-cols-1 sm:grid-cols-3 gap-3 px-6 pt-4">
            <MechanicalStat
              label={t('monitor.current')}
              value={latestStemPoint ? formatStemChangeUm(latestStemPoint.stem_change_um) : '—'}
            />
            <MechanicalStat
              label={t('monitor.minimum')}
              value={minStem !== null ? formatStemChangeUm(minStem) : '—'}
            />
            <MechanicalStat
              label={t('monitor.maximum')}
              value={maxStem !== null ? formatStemChangeUm(maxStem) : '—'}
            />
          </div>
        )}

        <div className="flex flex-1 flex-col gap-6 px-6 py-4">
          {loading && (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--primary)] border-t-transparent" />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-[var(--error-bg)] p-4 text-center text-[var(--error-text)]">
              {t('monitor.failedToLoad')}
            </div>
          )}

          {!loading && !error && data.length === 0 && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-lg text-[var(--text-tertiary)]">
                {t('dendrometerMonitor.noData', { hours })}
              </p>
            </div>
          )}

          {!loading && !error && data.length > 0 && plottedData.length === 0 && (
            <div className="rounded-lg bg-[var(--card)] p-5 text-center">
              <p className="text-lg text-[var(--text-tertiary)]">
                {hasRawOnlySamples
                  ? t('dendrometerMonitor.rawOnly')
                  : hasMechanicalOnlySamples
                    ? t('dendrometerMonitor.awaitingBaseline')
                    : t('dendrometerMonitor.noCalibratedData', { hours })}
              </p>
            </div>
          )}

          {!loading && !error && plottedData.length > 0 && (
            <div>
              <div className="mb-3">
                <h3 className="font-bold text-[var(--text)]">{t('dendrometerMonitor.stemTitle')}</h3>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {t('dendrometerMonitor.stemDescription')}
                </p>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={plottedData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="stemGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22c55e" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#22c55e" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    ticks={posTicks}
                    tickFormatter={(value) => fmtTickShort(value, hours, format)}
                    tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tickFormatter={(value) => `${Math.round(value)}`}
                    tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip content={<TooltipStemChange format={format} hours={hours} />} />
                  <Area
                    type="monotone"
                    dataKey="stem_change_um"
                    stroke="#22c55e"
                    strokeWidth={2}
                    fill="url(#stemGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#22c55e' }}
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {!loading && !error && mechanicalData.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-[var(--text)]">{t('dendrometerMonitor.mechanicalTitle')}</h3>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                    {t('dendrometerMonitor.mechanicalDescription')}
                  </p>
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('dendrometerMonitor.engineering')}</p>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <MechanicalStat
                  label={t('dendrometerMonitor.currentPosition')}
                  value={latestMechanicalPoint ? `${latestMechanicalPoint.mechanical_position_mm.toFixed(2)} mm` : '—'}
                />
                <MechanicalStat
                  label={t('dendrometerMonitor.windowRange')}
                  value={mechanicalMin !== null && mechanicalMax !== null
                    ? `${mechanicalMin.toFixed(2)} → ${mechanicalMax.toFixed(2)} mm`
                    : '—'}
                />
                {strokePercent != null && (
                  <MechanicalStat
                    label={t('dendrometerMonitor.strokeUsed')}
                    value={t('dendrometerMonitor.strokeValue', { percent: strokePercent.toFixed(0), stroke: strokeMm?.toFixed(1) })}
                  />
                )}
                {latestSourceLabel && (
                  <MechanicalStat
                    label={t('dendrometerMonitor.source')}
                    value={t(latestSourceLabel)}
                  />
                )}
                {latestSaturationLabel && (
                  <MechanicalStat
                    label={t('dendrometerMonitor.rangeState')}
                    value={latestSaturationLabel}
                  />
                )}
              </div>

              {latestSaturationLabel && (
                <p className="mt-4 text-xs text-[var(--warn-text)]">
                  {t('dendrometerMonitor.outsideRange')}
                </p>
              )}
              <p className="mt-4 text-xs text-[var(--text-tertiary)]">
                {t('dendrometerMonitor.calibrationDetails')}
              </p>
            </div>
          )}

          {!loading && !error && data.length > 0 && (
            <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
              {t('monitor.readings', { count: data.length, hours })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
