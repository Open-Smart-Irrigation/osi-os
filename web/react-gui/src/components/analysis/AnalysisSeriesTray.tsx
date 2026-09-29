import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisCatalogEntry } from '../../analysis/types';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface AnalysisSeriesTrayProps {
  channels: AnalysisCatalogEntry[];
  selectedIds: string[];
  onAdd: (seriesId: string) => void;
  onRemove: (seriesId: string) => void;
}

interface ZoneGroup {
  // null = no hub/site on the catalog entry; the label is resolved with i18n at render time.
  key: string;
  site: string | null;
  zoneId: number;
  zoneName: string;
  devices: DeviceGroup[];
}

interface DeviceGroup {
  key: string;
  deviceName: string | null;
  channels: AnalysisCatalogEntry[];
}

// A weather-provider entry's deviceName is the provider location, not a physical
// device; its group always renders after the zone's device groups (see the sort
// below), so a farmer scans on-site sensors before the outside estimate.
function isWeatherProviderGroup(deviceGroup: DeviceGroup): boolean {
  return deviceGroup.channels[0]?.sourceKind === 'weather_provider';
}

function groupChannels(channels: AnalysisCatalogEntry[]): ZoneGroup[] {
  const groups: ZoneGroup[] = [];
  const index = new Map<string, ZoneGroup>();
  const deviceIndex = new Map<string, DeviceGroup>();
  for (const channel of channels) {
    const site = channel.hubEui;
    const key = `${site ?? ''}|${channel.zoneId}`;
    let group = index.get(key);
    if (!group) {
      group = { key, site, zoneId: channel.zoneId, zoneName: channel.zoneName, devices: [] };
      index.set(key, group);
      groups.push(group);
    }
    const deviceName = channel.deviceName ?? null;
    const deviceKey = `${key}|${deviceName ?? `${channel.cardType}:${channel.sourceKey}`}`;
    let deviceGroup = deviceIndex.get(deviceKey);
    if (!deviceGroup) {
      deviceGroup = { key: deviceKey, deviceName, channels: [] };
      deviceIndex.set(deviceKey, deviceGroup);
      group.devices.push(deviceGroup);
    }
    deviceGroup.channels.push(channel);
  }
  // Stable sort: keeps each zone's device groups in encounter order and moves
  // the weather-provider group (if any) after them, regardless of the order
  // its channels arrived in.
  for (const group of groups) {
    group.devices.sort((a, b) => Number(isWeatherProviderGroup(a)) - Number(isWeatherProviderGroup(b)));
  }
  return groups;
}

function availabilityReasonKey(availability: AnalysisCatalogEntry['availability']) {
  if (availability === 'unsupported') return 'analysis.tray.reason.unsupported';
  return null;
}

// The backend joins source and channel as `${deviceName} - ${label}`
// (osi-history-helper/analysis.js); the source is the group heading, so the
// button shows the channel alone.
function channelLabel(channel: AnalysisCatalogEntry): string {
  if (!channel.deviceName) return channel.displayName;
  for (const separator of [' - ', ': ']) {
    const prefix = `${channel.deviceName}${separator}`;
    if (channel.displayName.startsWith(prefix)) return channel.displayName.slice(prefix.length);
  }
  return channel.displayName;
}

export function AnalysisSeriesTray({ channels, selectedIds, onAdd, onRemove }: AnalysisSeriesTrayProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [query, setQuery] = useState('');
  const trayId = useId();
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) =>
      `${c.zoneName} ${c.displayName} ${c.deviceName ?? ''} ${c.hubEui ?? ''} ${c.cardType} ${c.channelKey}`.toLowerCase().includes(q),
    );
  }, [channels, query]);

  const groups = useMemo(() => groupChannels(filtered), [filtered]);

  return (
    <section className="analysis-series-tray flex flex-col gap-1 text-sm" aria-label={t('analysis.tray.label')}>
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('analysis.tray.title')}</h2>
        <span className="rounded-full bg-[var(--card)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
          {selectedIds.length}
        </span>
      </div>
      <input
        type="search"
        role="searchbox"
        placeholder={t('analysis.tray.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
      />
      <div className="flex flex-col gap-3 overflow-y-auto">
        {groups.map((group, groupIndex) => {
          // Named so assistive tech announces the zone as a group, independent
          // of the per-source groups nested inside it.
          const zoneHeadingId = `${trayId}-zone-${groupIndex}`;
          return (
            <div key={group.key} className="flex flex-col" role="group" aria-labelledby={zoneHeadingId}>
              <div id={zoneHeadingId} className="mb-1 px-1 text-xs font-medium text-[var(--text-secondary)]">
                {group.zoneName}
              </div>
              {group.devices.map((deviceGroup, deviceIndex) => {
                // Buttons show the channel alone; the group name carries the source.
                const headingId = `${trayId}-source-${groupIndex}-${deviceIndex}`;
                return (
                  <div
                    key={deviceGroup.key}
                    className="mb-2 last:mb-0"
                    role={deviceGroup.deviceName ? 'group' : undefined}
                    aria-labelledby={deviceGroup.deviceName ? headingId : undefined}
                  >
                    {deviceGroup.deviceName ? (
                      <div id={headingId} className="mb-1 px-1 text-xs font-semibold text-[var(--text)]">
                        {deviceGroup.deviceName}
                      </div>
                    ) : null}
                    <ul className="flex flex-col gap-1">
                      {deviceGroup.channels.map((c) => {
                        const isSelected = selected.has(c.seriesId);
                        const disabled = c.availability !== 'available';
                        const reasonKey = availabilityReasonKey(c.availability);
                        return (
                          <li key={c.seriesId}>
                            <button
                              type="button"
                              disabled={disabled}
                              aria-pressed={isSelected}
                              aria-disabled={disabled}
                              onClick={() => (isSelected ? onRemove(c.seriesId) : onAdd(c.seriesId))}
                              className={[
                                'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-1',
                                disabled
                                  ? 'cursor-not-allowed border-[var(--border)] bg-[var(--surface)] text-[var(--text-disabled)]'
                                  : isSelected
                                    ? 'border-[var(--primary)] bg-[var(--card)] text-[var(--text)]'
                                    : 'border-[var(--border)] bg-[var(--card)] text-[var(--text-secondary)] hover:bg-[var(--secondary-bg)]',
                              ].join(' ')}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{channelLabel(c)}</span>
                                <span className="block truncate text-xs text-[var(--text-tertiary)]">{c.cardType}</span>
                                {disabled && reasonKey ? (
                                  <span className="block truncate text-xs text-[var(--text-tertiary)]">{t(reasonKey)}</span>
                                ) : null}
                              </span>
                              {c.unit ? (
                                <span className="shrink-0 rounded bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                                  {c.unit}
                                </span>
                              ) : null}
                              <span className="w-4 shrink-0 text-[var(--primary)]" aria-hidden>
                                {isSelected ? '✓' : ''}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
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
