import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';
import { environmentAPI } from '../../../services/api';
import { LocalTab } from './LocalTab';
import { OnlineTab } from './OnlineTab';
import { AgronomicTab } from './AgronomicTab';
import { ForecastTab } from './ForecastTab';

interface Props {
  zone: IrrigationZone;
}

type Tab = 'local' | 'online' | 'agronomic' | 'forecast';

// ── Cloud icon (inline SVG, no external dep) ──────────────────────────────────

const CloudIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="16" height="16" viewBox="0 0 24 24" fill="none"
    className={className}
    aria-hidden="true"
  >
    <path
      d="M18 10.5A6 6 0 0 0 6.34 9.12 4 4 0 1 0 5 17h13a4 4 0 0 0 0-8Z"
      fill="currentColor" opacity="0.9"
    />
  </svg>
);

// ── Cache/location badge for the header ───────────────────────────────────────

function LocationSourceBadge({ source }: { source: string }) {
  const { t } = useTranslation('devices');
  if (source === 'unavailable') return null;
  const label = t(`environment.location.${source}`, { defaultValue: source });
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold
      bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)]">
      📍 {label}
    </span>
  );
}

function OnlineCacheBadge({ data }: { data: ZoneEnvironmentSummary }) {
  if (!data.online.available) return null;
  const cfg = {
    live:  { cls: 'bg-emerald-100 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', label: 'Live' },
    stale: { cls: 'bg-amber-100 text-amber-700 border-amber-200',       dot: 'bg-amber-500',   label: 'Stale' },
    miss:  { cls: 'bg-red-100 text-red-600 border-red-200',             dot: 'bg-red-400',     label: 'No data' },
  }[data.online.cacheStatus];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Rain forecast badge for Forecast tab label ────────────────────────────────

function RainBadge({ data }: { data: ZoneEnvironmentSummary }) {
  const next24 = data.forecast.rainFocus?.totalNext24hMm ?? 0;
  if (next24 < 0.5) return null;
  return (
    <span className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold
      bg-blue-100 text-blue-700 border border-blue-200">
      {next24.toFixed(0)} mm
    </span>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export const EnvironmentCard: React.FC<Props> = ({ zone }) => {
  const { t } = useTranslation('devices');
  const [collapsed, setCollapsed]   = useState(false);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [data, setData]             = useState<ZoneEnvironmentSummary | null>(null);
  const [activeTab, setActiveTab]   = useState<Tab>('local');

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const summary = await environmentAPI.getSummary(zone.id);
        if (cancelled) return;
        setData(summary);
        // Smart default tab: prefer local if available, else online, else agronomic
        setActiveTab(prev => {
          if (prev !== 'local') return prev; // don't override user's tab choice after first load
          if (summary.local.available && summary.local.metrics.length > 0) return 'local';
          if (summary.online.available) return 'online';
          return 'agronomic';
        });
      } catch (e: any) {
        if (!cancelled) setError(e?.response?.data?.message ?? e?.message ?? 'Failed to load environment data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = setInterval(() => void load(), 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [zone.id]);

  // Resolved zone metadata (handle snake_case / camelCase aliases)
  const cropType         = zone.cropType         ?? zone.crop_type         ?? null;
  const phenologicalStage= zone.phenologicalStage ?? zone.phenological_stage ?? null;

  const TABS: { id: Tab; labelKey: string; fallback: string; available: boolean }[] = [
    {
      id: 'local',
      labelKey: 'environment.tabs.local',
      fallback: 'Local',
      available: true,
    },
    {
      id: 'online',
      labelKey: 'environment.tabs.online',
      fallback: 'Online',
      available: data?.online.available ?? true,
    },
    {
      id: 'agronomic',
      labelKey: 'environment.tabs.agronomic',
      fallback: 'Agronomic',
      available: true,
    },
    {
      id: 'forecast',
      labelKey: 'environment.tabs.forecast',
      fallback: 'Forecast',
      available: data?.forecast.available ?? true,
    },
  ];

  return (
    <div className="mt-6 border-t border-[var(--border)] pt-5">
      {/* Section header */}
      <button
        className="w-full flex items-center justify-between text-left group"
        onClick={() => setCollapsed(c => !c)}
      >
        <div className="flex items-center gap-2">
          <CloudIcon className="text-[var(--text-tertiary)] group-hover:text-[var(--text)] transition-colors" />
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] group-hover:text-[var(--text)] transition-colors">
            {t('environment.sectionTitle', { defaultValue: 'Environment' })}
          </span>
          {data && (
            <div className="flex items-center gap-1.5 ml-1">
              <LocationSourceBadge source={data.location.source} />
              <OnlineCacheBadge data={data} />
            </div>
          )}
        </div>
        <span
          className="text-[var(--text-tertiary)] text-sm transition-transform duration-200"
          style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        >
          ▾
        </span>
      </button>

      {!collapsed && (
        <div className="mt-3 flex flex-col gap-3">
          {/* Loading state */}
          {loading && !data && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)] py-2">
              <div className="animate-spin h-4 w-4 border-2 border-[var(--primary)] border-t-transparent rounded-full" />
              Loading environment data…
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Content */}
          {data && (
            <>
              {/* Tab bar */}
              <div className="flex items-center gap-0 border-b border-[var(--border)]">
                {TABS.map(tab => {
                  const isActive = activeTab === tab.id;
                  const isDimmed = !tab.available;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`relative flex items-center px-3.5 py-2 text-sm font-medium transition-colors
                        ${isActive
                          ? 'text-[var(--primary)]'
                          : isDimmed
                            ? 'text-[var(--text-tertiary)] opacity-50'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
                        }`}
                    >
                      {t(tab.labelKey, { defaultValue: tab.fallback })}
                      {tab.id === 'forecast' && <RainBadge data={data} />}
                      {isActive && (
                        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--primary)] rounded-t" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Tab content */}
              <div className="pt-1">
                {activeTab === 'local' && (
                  <LocalTab local={data.local} />
                )}
                {activeTab === 'online' && (
                  <OnlineTab online={data.online} location={data.location} />
                )}
                {activeTab === 'agronomic' && (
                  <AgronomicTab
                    agronomic={data.agronomic}
                    cropType={cropType}
                    phenologicalStage={phenologicalStage}
                  />
                )}
                {activeTab === 'forecast' && (
                  <ForecastTab forecast={data.forecast} location={data.location} />
                )}
              </div>

              {/* Footer */}
              <p className="text-[10px] text-[var(--text-tertiary)] pt-1">
                Generated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {t(`environment.location.${data.location.source}`, {
                  defaultValue: data.location.source,
                })}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
