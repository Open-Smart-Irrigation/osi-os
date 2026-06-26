import { canonicalize } from '../channels/registry';
import manifest from '../channels/channels.json';
import type { AnalysisCatalogEntry } from './types';

export type ChannelMeta = Map<string, { displayName: string; unit: string | null }>;

const UNIT_GLYPHS: Record<string, string> = { C: '°C', um: 'µm' };

const SENSOR_SUFFIX = /\s*(?:[–-]\s*sensor\s*\d+|\(\s*s\d+\s*\))\s*$/i;

const DISPLAY_NAMES: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of (manifest as Array<{ key: string; displayName?: string }>)) {
    map.set(entry.key, entry.displayName ?? entry.key);
  }
  return map;
})();

export function prettyUnit(unit: string | null): string {
  if (!unit) return '';
  return UNIT_GLYPHS[unit] ?? unit;
}

export function channelMetaFromCatalog(channels: AnalysisCatalogEntry[]): ChannelMeta {
  const meta: ChannelMeta = new Map();
  for (const c of channels) {
    const channelKey = canonicalize(c.channelKey);
    if (!meta.has(channelKey)) meta.set(channelKey, { displayName: c.displayName, unit: c.unit });
  }
  return meta;
}

export function axisLabel(channelKey: string, meta: ChannelMeta): string {
  const canonicalKey = canonicalize(channelKey);
  const entry = meta.get(canonicalKey);
  if (!entry) return canonicalKey;
  const unit = prettyUnit(entry.unit);
  return unit ? `${entry.displayName} (${unit})` : entry.displayName;
}

export function axisQuantityLabel(channelKey: string, unit: string | null): string {
  const key = canonicalize(channelKey);
  const display = DISPLAY_NAMES.get(key) ?? key;
  const quantity = display.replace(SENSOR_SUFFIX, '').trim() || display;
  const u = prettyUnit(unit);
  return u ? `${quantity} (${u})` : quantity;
}
