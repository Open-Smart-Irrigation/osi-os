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

export function axisQuantityLabel(channelKey: string, unit: string | null, aggregation?: string): string {
  const key = canonicalize(channelKey);
  const display = (aggregation ? rainfallLabel(key, aggregation) : null) ?? DISPLAY_NAMES.get(key) ?? key;
  const quantity = display.replace(SENSOR_SUFFIX, '').trim() || display;
  const u = prettyUnit(unit);
  return u ? `${quantity} (${u})` : quantity;
}

/** The Data view's applied aggregation levels (`aggregation.applied` of a series response). */
export type AnalysisAggregationLevel = 'raw' | '15m' | 'hourly' | 'daily' | 'weekly';

const RAINFALL_AMOUNT_KEYS = new Set(['rain_mm_delta']);

/**
 * What a rain amount point means at an aggregation: a raw sample is what one report
 * collected, a bucket is a summed amount. Null for any other channel. English, like
 * the gateway's catalogue names it replaces (osi-history-helper RAW_SERIES_LABELS).
 */
export function rainfallLabel(channelKey: string, aggregation: string): string | null {
  if (!RAINFALL_AMOUNT_KEYS.has(canonicalize(channelKey))) return null;
  return aggregation === 'raw' ? 'Rainfall this interval' : 'Rainfall amount';
}

type RainfallNameEntry = Pick<AnalysisCatalogEntry, 'channelKey' | 'deviceName' | 'displayName' | 'sourceKind'>;

/** A catalogue display name with a device rain amount named for the applied aggregation. */
export function presentRainfallName(entry: RainfallNameEntry, aggregation: string | undefined): string {
  const label = aggregation && entry.sourceKind === 'device' ? rainfallLabel(entry.channelKey, aggregation) : null;
  if (!label) return entry.displayName;
  return [entry.deviceName, label].filter(Boolean).join(' - ');
}
