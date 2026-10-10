import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GatewayModuleFlags } from '../../hooks/useGatewayModules';
import type { AnalysisCatalogEntry, DeviceSource } from '../../analysis/types';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface AnalysisSeriesTrayProps {
  channels: AnalysisCatalogEntry[];
  sources?: DeviceSource[];
  gatewayModules?: GatewayModuleFlags | null;
  selectedIds: string[];
  onAdd: (seriesId: string) => void;
  onRemove: (seriesId: string) => void;
}

interface SourceGroup {
  key: string;
  name: string | null;
  source: DeviceSource | null;
  channels: AnalysisCatalogEntry[];
  weather: boolean;
}

interface ZoneGroup {
  key: string;
  zoneId: number | null;
  zoneName: string | null;
  devices: SourceGroup[];
}

function isWeatherChannel(channel: AnalysisCatalogEntry): boolean {
  return channel.sourceKind !== 'device';
}

function fallbackSourceKey(channel: AnalysisCatalogEntry): string {
  return `${channel.hubEui ?? ''}|${channel.zoneId ?? 'unassigned'}|${channel.sourceKind}:${channel.cardType}:${channel.sourceKey}`;
}

function sourceGroupName(group: SourceGroup): string | null {
  return group.source?.name ?? group.name;
}

function groupChannels(channels: AnalysisCatalogEntry[], sources: DeviceSource[] | undefined): ZoneGroup[] {
  const groups: ZoneGroup[] = [];
  const zones = new Map<string, ZoneGroup>();
  const sourceById = new Map((sources ?? []).map((source) => [source.id, source]));
  const sourceGroups = new Map<string, SourceGroup>();

  const ensureZone = (zoneId: number | null, zoneName: string | null, hubEui: string | null): ZoneGroup => {
    const key = `${hubEui ?? ''}|${zoneId === null ? 'unassigned' : zoneId}`;
    let group = zones.get(key);
    if (!group) {
      group = { key, zoneId, zoneName, devices: [] };
      zones.set(key, group);
      groups.push(group);
    }
    return group;
  };

  const addChannel = (channel: AnalysisCatalogEntry) => {
    const source = channel.deviceSourceId ? sourceById.get(channel.deviceSourceId) ?? null : null;
    const weather = isWeatherChannel(channel);
    const key = channel.deviceSourceId ?? fallbackSourceKey(channel);
    let sourceGroup = sourceGroups.get(key);
    if (!sourceGroup) {
      sourceGroup = { key, name: channel.deviceName, source, channels: [], weather };
      sourceGroups.set(key, sourceGroup);
      ensureZone(channel.zoneId, channel.zoneName, channel.hubEui).devices.push(sourceGroup);
    }
    sourceGroup.channels.push(channel);
  };

  for (const channel of channels) addChannel(channel);

  // Sources are authoritative for physical-device identity and can exist with
  // no chart channels. Weather groups continue to be derived from channels.
  for (const source of sources ?? []) {
    if (sourceGroups.has(source.id)) continue;
    const sourceGroup: SourceGroup = { key: source.id, name: source.name, source, channels: [], weather: false };
    sourceGroups.set(source.id, sourceGroup);
    ensureZone(source.zoneId, source.zoneName, source.hubEui).devices.push(sourceGroup);
  }
  for (const group of groups) group.devices.sort((left, right) => Number(left.weather) - Number(right.weather));
  return groups;
}

function availabilityReasonKey(availability: AnalysisCatalogEntry['availability']) {
  if (availability === 'unsupported') return 'analysis.tray.reason.unsupported';
  return null;
}

function channelName(channel: AnalysisCatalogEntry): string {
  if (!channel.deviceName) return channel.displayName;
  for (const separator of [' - ', ': ']) {
    const prefix = `${channel.deviceName}${separator}`;
    if (channel.displayName.startsWith(prefix)) return channel.displayName.slice(prefix.length);
  }
  return channel.displayName;
}

function channelLabel(channel: AnalysisCatalogEntry, t: AnalysisTranslate): string {
  const name = channelName(channel);
  return channel.legacy ? `${name} (${t('analysis.legacyEstimate')})` : name;
}

function renderDestination(source: DeviceSource, modules: GatewayModuleFlags | null | undefined, t: AnalysisTranslate) {
  if (source.destination !== 'network') return null;
  if (modules === null || modules === undefined) {
    return <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('analysis.tray.networkLoading')}</p>;
  }
  if (modules.network !== true) {
    return <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('analysis.tray.networkDisabled')}</p>;
  }
  return (
    <Link to="/network" className="mt-1 inline-flex rounded border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:border-[var(--focus)] hover:text-[var(--primary)]">
      {t('analysis.tray.openNetwork')}
    </Link>
  );
}

export function AnalysisSeriesTray({ channels, sources, gatewayModules, selectedIds, onAdd, onRemove }: AnalysisSeriesTrayProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [query, setQuery] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const trayId = useId();
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hasLegacy = useMemo(() => channels.some((c) => c.legacy), [channels]);

  const filtered = useMemo(() => {
    // Legacy estimates are listed on request, or when a saved view selected one.
    const offered = showLegacy ? channels : channels.filter((c) => !c.legacy || selected.has(c.seriesId));
    const q = query.trim().toLowerCase();
    if (!q) return offered;
    return offered.filter((c) => `${c.zoneName ?? ''} ${c.displayName} ${c.deviceName ?? ''} ${c.hubEui ?? ''} ${c.cardType} ${c.channelKey} ${c.deviceSourceId ?? ''}`.toLowerCase().includes(q));
  }, [channels, query, selected, showLegacy]);
  const visibleSources = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sources;
    const sourceIds = new Set(filtered.map((channel) => channel.deviceSourceId).filter(Boolean));
    return sources?.filter((source) => sourceIds.has(source.id) || `${source.name} ${source.typeId} ${source.zoneName ?? ''} ${source.id}`.toLowerCase().includes(q));
  }, [filtered, query, sources]);
  const groups = useMemo(() => groupChannels(filtered, visibleSources), [filtered, visibleSources]);

  return (
    <section className="analysis-series-tray flex flex-col gap-1 text-sm" aria-label={t('analysis.tray.label')}>
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('analysis.tray.title')}</h2>
        <span className="rounded-full bg-[var(--card)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">{selectedIds.length}</span>
      </div>
      <input type="search" role="searchbox" placeholder={t('analysis.tray.search')} value={query} onChange={(e) => setQuery(e.target.value)} className="mb-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]" />
      {hasLegacy ? (
        <label className="analysis-series-tray__legacy-toggle mb-1 flex items-center gap-2 px-1 text-xs text-[var(--text-secondary)]">
          <input type="checkbox" checked={showLegacy} onChange={(e) => setShowLegacy(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
          {t('analysis.tray.showLegacy')}
        </label>
      ) : null}
      <div className="flex flex-col gap-3 overflow-y-auto">
        {groups.map((group, groupIndex) => {
          const zoneHeadingId = `${trayId}-zone-${groupIndex}`;
          const zoneLabel = group.zoneId === null ? t('analysis.tray.unassigned') : (group.zoneName ?? `Zone ${group.zoneId}`);
          return (
            <div key={group.key} className="flex flex-col" role="group" aria-labelledby={zoneHeadingId}>
              <div id={zoneHeadingId} className="mb-1 px-1 text-xs font-medium text-[var(--text-secondary)]">{zoneLabel}</div>
              {group.devices.map((deviceGroup, deviceIndex) => {
                const source = deviceGroup.source;
                const name = sourceGroupName(deviceGroup);
                const headingId = `${trayId}-source-${groupIndex}-${deviceIndex}`;
                const current = deviceGroup.channels.filter((c) => c.configurationState !== 'other_supported');
                const other = deviceGroup.channels.filter((c) => c.configurationState === 'other_supported');
                const renderChannel = (c: AnalysisCatalogEntry) => {
                  const isSelected = selected.has(c.seriesId);
                  const disabled = c.availability !== 'available';
                  const reasonKey = availabilityReasonKey(c.availability);
                  return (
                    <li key={c.seriesId}>
                      <button type="button" disabled={disabled} aria-pressed={isSelected} aria-disabled={disabled} onClick={() => (isSelected ? onRemove(c.seriesId) : onAdd(c.seriesId))} className={[
                        'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-1',
                        disabled ? 'cursor-not-allowed border-[var(--border)] bg-[var(--surface)] text-[var(--text-disabled)]' : isSelected ? 'border-[var(--primary)] bg-[var(--card)] text-[var(--text)]' : 'border-[var(--border)] bg-[var(--card)] text-[var(--text-secondary)] hover:bg-[var(--secondary-bg)]',
                      ].join(' ')}>
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{channelLabel(c, t)}</span><span className="block truncate text-xs text-[var(--text-tertiary)]">{c.cardType}</span>{disabled && reasonKey ? <span className="block truncate text-xs text-[var(--text-tertiary)]">{t(reasonKey)}</span> : null}</span>
                        {c.unit ? <span className="shrink-0 rounded bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">{c.unit}</span> : null}
                        <span className="w-4 shrink-0 text-[var(--primary)]" aria-hidden>{isSelected ? '✓' : ''}</span>
                      </button>
                    </li>
                  );
                };
                return (
                  <div key={deviceGroup.key} className="mb-2 last:mb-0" role={name ? 'group' : undefined} aria-labelledby={name ? headingId : undefined}>
                    {name ? <div id={headingId} className="mb-1 px-1 text-xs font-semibold text-[var(--text)]">{name}</div> : null}
                    {source?.limitation === 'valve_events' ? <p className="mb-1 px-1 text-xs text-[var(--text-tertiary)]">{t('analysis.tray.valveEvents')}</p> : null}
                    {source?.limitation === 'unsupported_type' ? <p className="mb-1 px-1 text-xs text-[var(--text-tertiary)]">{t('analysis.tray.unsupportedType')}</p> : null}
                    {source ? renderDestination(source, gatewayModules, t) : null}
                    {deviceGroup.channels.length === 0 ? <p className="px-1 text-xs text-[var(--text-tertiary)]">{t('analysis.tray.emptySource')}</p> : null}
                    {current.length > 0 ? <ul className="flex flex-col gap-1">{current.map(renderChannel)}</ul> : null}
                    {other.length > 0 ? <details className="mt-1 rounded border border-[var(--border)] px-2 py-1"><summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">{t('analysis.tray.otherSupported')}</summary><p className="py-1 text-xs text-[var(--text-tertiary)]">{t('analysis.tray.otherSupportedHelp')}</p><ul className="flex flex-col gap-1">{other.map(renderChannel)}</ul></details> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
