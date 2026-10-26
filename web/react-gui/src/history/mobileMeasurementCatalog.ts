import { reconcileMobileSelection, selectMobileTensionSources } from '@osi/history-uplot';
import type { AnalysisCatalogResponse, AnalysisCatalogEntry } from '../analysis/types';
import type { MobileTensionSource } from '@osi/history-uplot';

function numericZoneId(zoneId: string): number | null {
  if (!zoneId.trim()) return null;
  const parsed = Number(zoneId);
  return Number.isFinite(parsed) ? parsed : null;
}

function isEligibleCatalogEntry(entry: AnalysisCatalogEntry, zoneId: number): boolean {
  return entry.zoneId !== null
    && Number.isFinite(entry.zoneId)
    && entry.zoneId === zoneId
    && entry.cardType === 'soil'
    && /^swt_[123]$/.test(entry.channelKey)
    && entry.unit === 'kPa'
    && entry.availability === 'available'
    && entry.legacy !== true;
}

export function normalizeMobileTensionCatalog(
  response: AnalysisCatalogResponse,
  zoneId: string,
): MobileTensionSource[] {
  const numeric = numericZoneId(zoneId);
  if (numeric === null) return [];
  return response.channels
    .filter((entry) => isEligibleCatalogEntry(entry, numeric))
    .map((entry) => ({
      seriesId: entry.seriesId,
      sourceKey: entry.sourceKey,
      channelKey: entry.channelKey,
      label: entry.displayName,
      unit: 'kPa' as const,
      zoneId: String(entry.zoneId),
      deviceName: entry.deviceName ?? undefined,
      depthCm: entry.depthCm,
      available: entry.availability === 'available',
      legacy: entry.legacy === true,
      status: entry.configurationState ?? 'unknown',
      measurementKind: 'soil' as const,
    }));
}

export function initialMobileTensionSelection(
  sources: readonly MobileTensionSource[],
  zoneId: string,
  savedIds: readonly string[] | undefined,
): { selectedIds: string[]; unavailableIds: string[] } {
  if (savedIds === undefined) {
    return { selectedIds: selectMobileTensionSources(sources, zoneId).map((source) => source.seriesId), unavailableIds: [] };
  }
  return reconcileMobileSelection(savedIds, sources, zoneId);
}
