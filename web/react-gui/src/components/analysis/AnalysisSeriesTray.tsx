import { useMemo, useState } from 'react';
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
  return groups;
}

function availabilityReasonKey(availability: AnalysisCatalogEntry['availability']) {
  if (availability === 'unsupported') return 'analysis.tray.reason.unsupported';
  return null;
}

function channelLabel(channel: AnalysisCatalogEntry): string {
  const prefix = channel.deviceName ? `${channel.deviceName}: ` : '';
  if (prefix && channel.displayName.startsWith(prefix)) {
    return channel.displayName.slice(prefix.length);
  }
  return channel.displayName;
}

export function AnalysisSeriesTray({ channels, selectedIds, onAdd, onRemove }: AnalysisSeriesTrayProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const [query, setQuery] = useState('');
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
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('analysis.tray.title')}</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {selectedIds.length}
        </span>
      </div>
      <input
        type="search"
        role="searchbox"
        placeholder={t('analysis.tray.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
      />
      <div className="flex flex-col gap-3 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col">
            <div className="mb-1 px-1 text-xs font-medium text-slate-700">{group.zoneName}</div>
            {group.devices.map((deviceGroup) => (
              <div key={deviceGroup.key} className="mb-2 last:mb-0">
                {deviceGroup.deviceName ? (
                  <div className="mb-1 px-1 text-xs font-semibold text-slate-800">{deviceGroup.deviceName}</div>
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
                            'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-1',
                            disabled
                              ? 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-400'
                              : isSelected
                                ? 'border-teal-300 bg-teal-50 text-slate-900'
                                : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50',
                          ].join(' ')}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{channelLabel(c)}</span>
                            <span className="block truncate text-xs text-slate-500">{c.cardType}</span>
                            {disabled && reasonKey ? (
                              <span className="block truncate text-xs text-slate-500">{t(reasonKey)}</span>
                            ) : null}
                          </span>
                          {c.unit ? (
                            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                              {c.unit}
                            </span>
                          ) : null}
                          <span className="w-4 shrink-0 text-teal-600" aria-hidden>
                            {isSelected ? '✓' : ''}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
