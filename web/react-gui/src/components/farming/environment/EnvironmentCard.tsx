import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../../../types/farming';
import { environmentAPI } from '../../../services/api';
import { LocalTab } from './LocalTab';
import { AgronomicTab } from './AgronomicTab';
import { WaterTab } from './WaterTab';
import { SoilTab } from './SoilTab';
import { WeatherTab } from './WeatherTab';

interface Props {
  zone: IrrigationZone;
  devices: Device[];
}

type Tab = 'water' | 'soil' | 'weather' | 'agronomic' | 'sensors';

const CloudIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path
      d="M18 10.5A6 6 0 0 0 6.34 9.12 4 4 0 1 0 5 17h13a4 4 0 0 0 0-8Z"
      fill="currentColor" opacity="0.9"
    />
  </svg>
);

function LocationSourceBadge({ source }: { source: string }) {
  const { t } = useTranslation('devices');
  if (source === 'unavailable') return null;
  const label = t(`environment.location.${source}`, { defaultValue: source });
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-tertiary)]">
      📍 {label}
    </span>
  );
}

function OnlineCacheBadge({ data }: { data: ZoneEnvironmentSummary }) {
  if (!data.online.available) return null;
  const cfg = {
    live: { cls: 'bg-emerald-100 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', label: 'Live' },
    stale: { cls: 'bg-amber-100 text-amber-700 border-amber-200', dot: 'bg-amber-500', label: 'Stale' },
    miss: { cls: 'bg-red-100 text-red-600 border-red-200', dot: 'bg-red-400', label: 'No data' },
  }[data.online.cacheStatus];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function DisplayBadge({ data }: { data: ZoneEnvironmentSummary }) {
  if (!data.display) return null;
  const label =
    data.display.mode === 'shared_server' ? 'OSI Server' :
    data.display.mode === 'shared_server_stale' ? 'OSI Server stale' :
    data.display.mode === 'local_fallback' ? 'Local fallback' :
    data.display.mode === 'unlinked_local' ? 'Local only' :
    data.display.sourceLabel;
  return (
    <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
      {label}
    </span>
  );
}

export const EnvironmentCard: React.FC<Props> = ({ zone, devices }) => {
  const { t } = useTranslation('devices');
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ZoneEnvironmentSummary | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('water');

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const summary = await environmentAPI.getSummary(zone.id);
        if (cancelled) return;
        setData(summary);
        setActiveTab((previous) => (previous === 'online' || previous === 'forecast' ? 'weather' : previous) || 'water');
      } catch (e: any) {
        if (!cancelled) setError(e?.response?.data?.message ?? e?.message ?? 'Failed to load environment data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = setInterval(() => void load(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [zone.id]);

  const cropType = zone.cropType ?? zone.crop_type ?? null;
  const phenologicalStage = zone.phenologicalStage ?? zone.phenological_stage ?? null;

  const tabs: { id: Tab; label: string; available: boolean }[] = [
    { id: 'water', label: t('environment.tabs.water', { defaultValue: 'Water' }), available: true },
    { id: 'soil', label: t('environment.tabs.soil', { defaultValue: 'Soil' }), available: true },
    { id: 'weather', label: t('environment.tabs.weather', { defaultValue: 'Weather' }), available: (data?.online.available ?? true) || (data?.forecast.available ?? true) },
    { id: 'agronomic', label: t('environment.tabs.agronomic', { defaultValue: 'Agronomy' }), available: true },
    { id: 'sensors', label: t('environment.tabs.sensors', { defaultValue: 'Sensors' }), available: true },
  ];

  return (
    <div className="mt-6 border-t border-[var(--border)] pt-5">
      <button className="group flex w-full items-center justify-between text-left" onClick={() => setCollapsed((value) => !value)}>
        <div className="flex items-center gap-2">
          <CloudIcon className="text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text)]" />
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text)]">
            {t('environment.sectionTitle', { defaultValue: 'Environment' })}
          </span>
          {data && (
            <div className="ml-1 flex items-center gap-1.5">
              <LocationSourceBadge source={data.location.source} />
              <DisplayBadge data={data} />
              <OnlineCacheBadge data={data} />
            </div>
          )}
        </div>
        <span className="text-xl text-[var(--text-tertiary)] transition-transform duration-200" style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
          ▾
        </span>
      </button>

      {!collapsed && (
        <div className="mt-3 flex flex-col gap-3">
          {loading && !data && (
            <div className="flex items-center gap-2 py-2 text-sm text-[var(--text-tertiary)]">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
              Loading environment data…
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
              {error}
            </div>
          )}

          {data && (
            <>
              {data.display?.fallbackReason && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {data.display.fallbackReason}
                </div>
              )}
              <div className="flex items-center gap-0 overflow-x-auto border-b border-[var(--border)]">
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`relative flex items-center px-3.5 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? 'text-[var(--primary)]'
                          : tab.available
                            ? 'text-[var(--text-secondary)] hover:text-[var(--text)]'
                            : 'text-[var(--text-tertiary)] opacity-50'
                      }`}
                    >
                      {tab.label}
                      {isActive && <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t bg-[var(--primary)]" />}
                    </button>
                  );
                })}
              </div>

              <div className="pt-1">
                {activeTab === 'water' && <WaterTab water={data.water} />}
                {activeTab === 'soil' && <SoilTab local={data.local} devices={devices} />}
                {activeTab === 'weather' && <WeatherTab online={data.online} forecast={data.forecast} location={data.location} />}
                {activeTab === 'agronomic' && (
                  <AgronomicTab agronomic={data.agronomic} cropType={cropType} phenologicalStage={phenologicalStage} />
                )}
                {activeTab === 'sensors' && <LocalTab local={data.local} />}
              </div>

              <p className="pt-1 text-[10px] text-[var(--text-tertiary)]">
                Generated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {t(`environment.location.${data.location.source}`, { defaultValue: data.location.source })}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
