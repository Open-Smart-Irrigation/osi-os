import { canonicalize } from '../channels/registry';
import { kpaToPf, type SwtUnit } from '../utils/swt';
import type { AnalysisCatalogEntry, AnalysisSeries } from './types';

const SWT_CHANNELS = new Set(['swt_1', 'swt_2', 'swt_3']);

function isCanonicalSwt(channelKey: string, cardType: string, unit: string | null): boolean {
  return cardType === 'soil' && unit === 'kPa' && SWT_CHANNELS.has(canonicalize(channelKey));
}

/** Projects canonical soil-tension display data while leaving API identities and stored values intact. */
export function presentSwtCatalog(entries: AnalysisCatalogEntry[], unit: SwtUnit): AnalysisCatalogEntry[] {
  if (unit === 'kPa') return entries;
  return entries.map((entry) => (
    isCanonicalSwt(entry.channelKey, entry.cardType, entry.unit) ? { ...entry, unit } : entry
  ));
}

/** Projects SWT points for charts, statistics, correlation and selected-series exports. */
export function presentSwtSeries(series: AnalysisSeries[], unit: SwtUnit): AnalysisSeries[] {
  if (unit === 'kPa') return series;
  return series.map((item) => {
    if (!isCanonicalSwt(item.resolved.channelKey, item.resolved.cardType, item.unit)) return item;
    return {
      ...item,
      unit,
      points: item.points.map((point) => ({ ...point, value: kpaToPf(point.value) })),
    };
  });
}
