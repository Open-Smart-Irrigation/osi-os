import { HistoryI18nKeys } from './i18nKeys.ts';
import type { HistoryCardDefinition, HistoryCardType } from './types.ts';

export const soilCardDefinition = {
  cardType: 'soil',
  scope: 'zone',
  displayName: 'Soil',
  titleKey: HistoryI18nKeys.cards.soil.title,
  defaultView: 'soil-profile',
  views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
  defaultRange: '24h',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['irrigation-events', 'rain-events', 'data-gaps', 'threshold-lines', 'soil-depths'],
  advancedOverlays: [
    'soil-dendro-shrinkage',
    'temperature-stem-growth',
    'normalized-multi-variable',
    'measured-model-prediction',
    'cross-card-anomaly',
  ],
  requiredCapabilities: ['soil-water-tension'],
  availabilityRules: ['zone-has-soil-source'],
  metadataFields: ['lastSeenAt', 'battery', 'signal', 'coveragePct', 'calibrationStatus'],
  calendarStates: ['optimal', 'dry', 'wet', 'irrigated', 'unknown'],
  interpretationRuleIds: ['root-zone-dry', 'irrigation-response'],
} as const satisfies HistoryCardDefinition<'soil'>;

export const dendroCardDefinition = {
  cardType: 'dendro',
  scope: 'zone',
  displayName: 'Dendro',
  titleKey: HistoryI18nKeys.cards.dendro.title,
  defaultView: 'growth-timeline',
  views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
  defaultRange: '7d',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['rain-events', 'data-gaps', 'threshold-lines'],
  advancedOverlays: [
    'soil-dendro-shrinkage',
    'temperature-stem-growth',
    'normalized-multi-variable',
    'measured-model-prediction',
    'cross-card-anomaly',
  ],
  requiredCapabilities: ['dendrometer'],
  availabilityRules: ['zone-has-dendro-source'],
  metadataFields: ['lastSeenAt', 'battery', 'signal', 'coveragePct'],
  calendarStates: ['optimal', 'stress', 'irrigated', 'unknown'],
  interpretationRuleIds: ['dendro-stress', 'growth-trend'],
} as const satisfies HistoryCardDefinition<'dendro'>;

export const environmentCardDefinition = {
  cardType: 'environment',
  scope: 'zone',
  displayName: 'Environment',
  titleKey: HistoryI18nKeys.cards.environment.title,
  defaultView: 'line-chart',
  views: ['line-chart', 'daily-min-max', 'calendar', 'stress-events', 'advanced'],
  defaultRange: '24h',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['forecast-boundary', 'data-gaps', 'threshold-lines', 'environment-variables'],
  advancedOverlays: [
    'temperature-stem-growth',
    'normalized-multi-variable',
    'measured-model-prediction',
    'cross-card-anomaly',
  ],
  requiredCapabilities: ['ambient-weather'],
  availabilityRules: ['zone-has-environment-source'],
  metadataFields: ['lastSeenAt', 'battery', 'signal', 'coveragePct'],
  calendarStates: ['optimal', 'stress', 'offline', 'unknown'],
  interpretationRuleIds: ['environment-stress', 'daily-min-max'],
} as const satisfies HistoryCardDefinition<'environment'>;

export const irrigationCardDefinition = {
  cardType: 'irrigation',
  scope: 'zone',
  displayName: 'Irrigation',
  titleKey: HistoryI18nKeys.cards.irrigation.title,
  defaultView: 'event-timeline',
  views: ['event-timeline', 'calendar', 'irrigation-response', 'advanced'],
  defaultRange: '7d',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['data-gaps', 'threshold-lines'],
  advancedOverlays: ['normalized-multi-variable', 'measured-model-prediction', 'cross-card-anomaly'],
  requiredCapabilities: ['irrigation-events'],
  availabilityRules: ['zone-has-irrigation-state'],
  metadataFields: ['lastSeenAt', 'coveragePct'],
  calendarStates: ['irrigated', 'dry', 'wet', 'unknown'],
  interpretationRuleIds: ['irrigation-response', 'irrigation-rhythm'],
} as const satisfies HistoryCardDefinition<'irrigation'>;

export const gatewayCardDefinition = {
  cardType: 'gateway',
  scope: 'gateway',
  displayName: 'Gateway',
  titleKey: HistoryI18nKeys.cards.gateway.title,
  defaultView: 'status-overview',
  views: ['status-overview', 'connectivity-timeline', 'local-storage-sync', 'power-state', 'advanced'],
  defaultRange: '24h',
  supportedRanges: ['12h', '24h', '7d', '30d'],
  standardOverlays: ['data-gaps'],
  advancedOverlays: ['battery-signal-strength', 'normalized-multi-variable', 'cross-card-anomaly'],
  requiredCapabilities: ['gateway-status'],
  availabilityRules: ['gateway-known'],
  metadataFields: ['lastSeenAt', 'coveragePct', 'syncState'],
  calendarStates: ['optimal', 'offline', 'unknown'],
  interpretationRuleIds: ['gateway-sync-state', 'gateway-power-state'],
} as const satisfies HistoryCardDefinition<'gateway'>;

export const historyCardDefinitions = [
  soilCardDefinition,
  dendroCardDefinition,
  environmentCardDefinition,
  irrigationCardDefinition,
  gatewayCardDefinition,
] as const;

export const historyCardDefinitionsByType = {
  soil: soilCardDefinition,
  dendro: dendroCardDefinition,
  environment: environmentCardDefinition,
  irrigation: irrigationCardDefinition,
  gateway: gatewayCardDefinition,
} as const satisfies Record<HistoryCardType, HistoryCardDefinition>;
