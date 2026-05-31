import { historyCardDefinitionsByType } from './cardDefinitions.ts';
import type { HistoryCardType, HistoryOverlayId, HistoryViewMode } from './types.ts';

export const historyStandardOverlayIds = [
  'irrigation-events',
  'rain-events',
  'forecast-boundary',
  'data-gaps',
  'threshold-lines',
  'soil-depths',
  'environment-variables',
] as const satisfies readonly HistoryOverlayId[];

export const historyAdvancedOverlayIds = [
  'soil-dendro-shrinkage',
  'temperature-stem-growth',
  'battery-signal-strength',
  'normalized-multi-variable',
  'measured-model-prediction',
  'cross-card-anomaly',
] as const satisfies readonly HistoryOverlayId[];

export function isAdvancedOverlay(overlayId: HistoryOverlayId): boolean {
  return historyAdvancedOverlayIds.includes(overlayId as (typeof historyAdvancedOverlayIds)[number]);
}

export function canUseOverlay(
  cardType: HistoryCardType,
  viewMode: HistoryViewMode,
  overlayId: HistoryOverlayId,
): boolean {
  const definition = historyCardDefinitionsByType[cardType];

  if (isAdvancedOverlay(overlayId)) {
    return (
      viewMode === 'advanced' &&
      (definition.advancedOverlays as readonly HistoryOverlayId[]).includes(overlayId)
    );
  }

  return (definition.standardOverlays as readonly HistoryOverlayId[]).includes(overlayId);
}
