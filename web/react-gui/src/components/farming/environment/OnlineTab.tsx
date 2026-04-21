import React from 'react';
import { useTranslation } from 'react-i18next';
import type { OnlineEnvironment, EnvironmentLocation } from '../../../types/farming';
import { toCompassDirection } from '../../../utils/wind';
import { WeatherIcon } from './WeatherIcon';

interface Props {
  online: OnlineEnvironment;
  location: EnvironmentLocation;
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmtTime(isoStr: string | null): string {
  if (!isoStr) return 'â€”';
  return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// â”€â”€ Cache / source badges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function CacheBadge({ status }: { status: 'live' | 'stale' | 'miss' }) {
  const { t } = useTranslation('devices');
  const cfg = {
    live:  { cls: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
    stale: { cls: 'bg-amber-100 text-amber-800',     dot: 'bg-amber-500' },
    miss:  { cls: 'bg-red-100 text-red-700',         dot: 'bg-red-500' },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {t(`environment.cache.${status}`, { defaultValue: status })}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const { t } = useTranslation('devices');
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)]">
      {t(`environment.source.${source}`, { defaultValue: source })}
    </span>
  );
}

// â”€â”€ Metric row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MetricRow: React.FC<{ icon: string; label: string; value: string; color?: string }> = ({
  icon, label, value, color,
}) => (
  <div className="flex items-center justify-between py-1.5 border-b border-[var(--border)] last:border-0">
    <span className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span>{icon}</span>
      {label}
    </span>
    <span className="text-sm font-semibold tabular-nums" style={color ? { color } : undefined}>
      {value}
    </span>
  </div>
);

// â”€â”€ Unavailable state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const UnavailableState: React.FC<{ location: EnvironmentLocation }> = ({ location }) => {
  const { t } = useTranslation('devices');
  const msg = location.source === 'unavailable'
    ? t('environment.online.noLocation', { defaultValue: 'Set zone coordinates to enable online weather' })
    : t('environment.online.unavailable', { defaultValue: 'No online weather available for this zone' });
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)] text-center">
      {msg}
    </div>
  );
};

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const OnlineTab: React.FC<Props> = ({ online, location }) => {
  const { t } = useTranslation('devices');

  if (!online.available || !online.current) {
    return <UnavailableState location={location} />;
  }

  const c = online.current;

  return (
    <div className="flex flex-col gap-4">
      {/* Hero row */}
      <div className="flex items-center gap-4 bg-[var(--card)] rounded-xl p-4 border border-[var(--border)]">
        <WeatherIcon code={c.weatherCode} description={c.description} size={72} />
        <div className="flex flex-col gap-1 min-w-0">
          {c.description && (
            <p className="text-base font-semibold text-[var(--text)] capitalize">{c.description}</p>
          )}
          {c.airTemperatureC != null && (
            <p className="text-3xl font-bold tabular-nums" style={{ color: '#f97316' }}>
              {c.airTemperatureC.toFixed(1)} Â°C
            </p>
          )}
          {c.relativeHumidityPct != null && (
            <p className="text-sm text-[var(--text-secondary)]">
              {c.relativeHumidityPct.toFixed(0)}% RH
            </p>
          )}
        </div>
      </div>

      {/* Metrics list */}
      <div className="bg-[var(--card)] rounded-xl px-3 border border-[var(--border)]">
        {c.pressureHpa != null && (
          <MetricRow icon="â—‰" label="Pressure" value={`${c.pressureHpa.toFixed(0)} hPa`} />
        )}
        {c.windSpeedMps != null && (
          <MetricRow
            icon="ðŸŒ¬"
            label="Wind"
            value={
              c.windDirectionDeg != null
                ? `${c.windSpeedMps.toFixed(1)} m/s ${toCompassDirection(c.windDirectionDeg) ?? ''}`
                : `${c.windSpeedMps.toFixed(1)} m/s`
            }
            color="#6366f1"
          />
        )}
        {c.cloudCoverPct != null && (
          <MetricRow icon="â˜" label="Cloud cover" value={`${c.cloudCoverPct.toFixed(0)}%`} />
        )}
        {c.rainMm != null && (
          <MetricRow icon="ðŸŒ§" label="Rain" value={`${c.rainMm.toFixed(1)} mm`} color="#3b82f6" />
        )}
        {c.precipitationProbabilityPct != null && (
          <MetricRow
            icon="ðŸ’§"
            label="Precip. probability"
            value={`${c.precipitationProbabilityPct.toFixed(0)}%`}
            color={c.precipitationProbabilityPct > 50 ? '#3b82f6' : undefined}
          />
        )}
      </div>

      {/* Footer: cache status, source, expiry */}
      <div className="flex items-center gap-2 flex-wrap">
        <CacheBadge status={online.cacheStatus} />
        <SourceBadge source={online.source} />
        {online.expiresAt && (
          <span className="text-xs text-[var(--text-tertiary)] ml-auto">
            {t('environment.online.updatesAt', {
              time: fmtTime(online.expiresAt),
              defaultValue: `Updates at ${fmtTime(online.expiresAt)}`,
            })}
          </span>
        )}
      </div>
    </div>
  );
};
