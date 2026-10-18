import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { sensorAPI, type SensorHistoryPoint } from '../../services/api';
import {
  hasRainData,
  summarizeRainDays,
  summarizeRainIntervals,
  type RainHistory,
  type RainHistoryDay,
} from '../../utils/rain';

interface Props {
  deveui: string;
  deviceName: string;
  onClose: () => void;
}

type RainWindow =
  | { label: string; mode: 'interval'; hours: number }
  | { label: string; mode: 'daily'; days: number };

// Bar-chart row for the daily view: total_mm is null for no-data days so
// recharts omits the bar instead of drawing a misleading 0.0 mm bar.
type RainChartDay = RainHistoryDay;

const TIME_WINDOWS: RainWindow[] = [
  { label: '12 h', mode: 'interval', hours: 12 },
  { label: '24 h', mode: 'interval', hours: 24 },
  { label: '7 d', mode: 'daily', days: 7 },
  { label: '30 d', mode: 'daily', days: 30 },
  { label: '90 d', mode: 'daily', days: 90 },
];

const DEFAULT_WINDOW_INDEX = 1; // '24 h'
const RAIN_COLOR = '#2563eb';

function fmtIntervalTick(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' })
    : iso;
}

// A farm day key is already the farm's calendar date: format it as that
// date, never re-read in the browser's zone.
function fmtDayTick(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' })
    : day;
}

function fmtMm(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(1)} mm` : '—';
}

const IntervalTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{fmtIntervalTick(label)}</p>
      <p className="font-bold text-[var(--text)]">{fmtMm(payload[0]?.value ?? null)}</p>
    </div>
  );
};

// A day without samples is a "no data" day (station offline / no valid
// uplinks that day) — never present it as a measured "0.0 mm" day.
// samples > 0 with total_mm === 0 is a genuine measured-dry day. The current
// day is labelled "so far": it ends at the request time.
const DailyTooltip = ({ active, payload, label, soFarLabel }: any) => {
  if (!active || !payload?.length) return null;
  const row: RainChartDay | undefined = payload[0]?.payload;
  const noData = !row || row.total_mm === null;
  const amount = noData ? 'no data' : fmtMm(row.total_mm);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{fmtDayTick(label)}</p>
      <p className="font-bold text-[var(--text)]">
        {row?.so_far ? `${amount} · ${soFarLabel}` : amount}
      </p>
    </div>
  );
};

export const RainMonitor: React.FC<Props> = ({ deveui, deviceName, onClose }) => {
  const { t } = useTranslation('devices');
  const [windowIndex, setWindowIndex] = useState(DEFAULT_WINDOW_INDEX);
  const [intervalData, setIntervalData] = useState<SensorHistoryPoint[]>([]);
  const [dailyHistory, setDailyHistory] = useState<RainHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedWindow = TIME_WINDOWS[windowIndex];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const selected = TIME_WINDOWS[windowIndex];
    const request =
      selected.mode === 'interval'
        ? sensorAPI.getHistory(deveui, 'rain_mm_delta', selected.hours).then((rows) => {
            if (!cancelled) {
              setIntervalData(rows);
              setDailyHistory(null);
            }
          })
        : sensorAPI.getDailyRainHistory(deveui, selected.days).then((history) => {
            if (!cancelled) {
              setDailyHistory(history);
              setIntervalData([]);
            }
          });
    request
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error && err.message ? err.message : 'Failed to load');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deveui, windowIndex]);

  // The gateway lists every farm day of the window; the browser neither
  // fills nor re-buckets them.
  const historyDays = useMemo(
    () => (selectedWindow.mode === 'daily' && dailyHistory ? dailyHistory.days : []),
    [dailyHistory, selectedWindow],
  );
  const dailySummary = useMemo(() => summarizeRainDays(historyDays), [historyDays]);
  // Bar chart input: no-data days get a null bar value so recharts omits the
  // bar entirely, instead of drawing a misleading 0.0 mm bar
  // indistinguishable from a genuinely measured dry day.
  const chartDays = useMemo<RainChartDay[]>(
    () => historyDays.map((entry) => ({ ...entry, total_mm: hasRainData(entry) ? entry.total_mm : null })),
    [historyDays],
  );
  // An older gateway answers without a timezone; it bucketed in UTC.
  const farmTimezone = dailyHistory?.timezone ?? 'UTC';
  const timezoneNeedsCheck =
    dailyHistory?.timezoneBasis === 'abbreviation' || dailyHistory?.timezoneBasis === 'invalid';
  const intervalSummary = useMemo(() => summarizeRainIntervals(intervalData), [intervalData]);
  const intervalTicks = useMemo(() => {
    if (!intervalData.length) return [];
    const step = Math.max(1, Math.floor(intervalData.length / 8));
    return intervalData.filter((_, index) => index % step === 0).map((point) => point.t);
  }, [intervalData]);

  const hasData =
    selectedWindow.mode === 'interval'
      ? intervalData.some((point) => point.value != null)
      : historyDays.some(hasRainData);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-[var(--bg)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-[var(--header-bg)] px-6 py-4">
          <div>
            <h2 className="high-contrast-text text-2xl font-bold text-[var(--header-text)]">Rainfall</h2>
            <p className="mt-0.5 text-sm text-[var(--header-subtext)]">{deviceName} · {deveui}</p>
          </div>
          <button onClick={onClose} className="touch-target px-2 text-3xl font-light leading-none text-[var(--header-text)] hover:text-[var(--text-secondary)]">×</button>
        </div>

        <div className="flex flex-wrap gap-2 px-6 pt-4">
          {TIME_WINDOWS.map((option, index) => (
            <button
              key={option.label}
              onClick={() => setWindowIndex(index)}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                windowIndex === index
                  ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                  : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--border)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {!loading && !error && hasData && (
          <div className="grid grid-cols-3 gap-3 px-6 pt-4">
            {selectedWindow.mode === 'interval' ? (
              <>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WINDOW TOTAL</p>
                  <p className="text-xl font-bold text-[var(--text)]">{fmtMm(intervalSummary.totalMm)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">PEAK INTERVAL</p>
                  <p className="text-xl font-bold text-[var(--text)]">{fmtMm(intervalSummary.peakMm)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WET INTERVALS</p>
                  <p className="text-xl font-bold text-[var(--text)]">{String(intervalSummary.wetIntervals)}</p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WINDOW TOTAL</p>
                  <p className="text-xl font-bold text-[var(--text)]">{fmtMm(dailySummary.totalMm)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">RAINY DAYS</p>
                  <p className="text-xl font-bold text-[var(--text)]">{String(dailySummary.rainyDays)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WETTEST DAY</p>
                  <p className="text-xl font-bold text-[var(--text)]">
                    {dailySummary.wettestDay ? fmtMm(dailySummary.wettestDay.total_mm) : '—'}
                  </p>
                  {dailySummary.wettestDay && (
                    <p className="text-xs text-[var(--text-tertiary)]">{fmtDayTick(dailySummary.wettestDay.day)}</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-1 flex-col gap-6 px-6 py-4">
          {loading && (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--primary)] border-t-transparent" />
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-[var(--error-bg)] p-4 text-center text-[var(--error-text)]">{error}</div>
          )}
          {!loading && !error && !hasData && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-lg text-[var(--text-tertiary)]">
                {selectedWindow.mode === 'interval'
                  ? `No rainfall recorded in the last ${selectedWindow.hours} hours.`
                  : 'No rainfall recorded in this window.'}
              </p>
            </div>
          )}
          {!loading && !error && hasData && selectedWindow.mode === 'interval' && (
            <>
              <div>
                <h3 className="mb-3 font-bold text-[var(--text)]">Rainfall per interval (mm)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={intervalData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      ticks={intervalTicks}
                      tickFormatter={fmtIntervalTick}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 'auto']}
                      tickFormatter={(value: number) => value.toFixed(1)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip content={<IntervalTooltip />} />
                    <Bar dataKey="value" fill={RAIN_COLOR} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
                {intervalData.length} readings · last {selectedWindow.hours} h
              </p>
            </>
          )}
          {!loading && !error && hasData && selectedWindow.mode === 'daily' && (
            <>
              <div>
                <h3 className="mb-3 font-bold text-[var(--text)]">Daily rainfall (mm)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={chartDays} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="day"
                      tickFormatter={fmtDayTick}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 'auto']}
                      tickFormatter={(value: number) => value.toFixed(1)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip content={<DailyTooltip soFarLabel={t('rainMonitor.soFar', { defaultValue: 'so far' })} />} />
                    <Bar dataKey="total_mm" fill={RAIN_COLOR} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
                {t('rainMonitor.dailyFooter', {
                  days: historyDays.length,
                  timezone: farmTimezone,
                  defaultValue: '{{days}} days · daily totals ({{timezone}})',
                })}
              </p>
              {timezoneNeedsCheck && (
                <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
                  {t('rainMonitor.timezoneCheck', { defaultValue: 'Check the zone time zone in its settings.' })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
