import { HistoryI18nKeys } from './i18nKeys.ts';
import type { HistoryCardDefinition, HistoryCardType } from './types.ts';

export const soilCardDefinition = {
  cardType: 'soil',
  scope: 'zone',
  displayName: 'Soil',
  titleKey: HistoryI18nKeys.card.soil.title,
  defaultView: 'soil-profile',
  views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
  defaultRange: '24h',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['irrigation-events', 'rain-events', 'data-gaps', 'threshold-lines', 'soil-depths'],
  advancedOverlays: [
    'soil-tension-dendro-shrinkage',
    'temperature-stem-growth',
    'normalized-multi-variable',
    'measured-model-prediction',
    'cross-card-anomaly',
  ],
  requiredCapabilities: ['soil-water-tension'],
  availabilityRules: ['zone-has-soil-source'],
  metadataFields: ['lastSeenAt', 'battery', 'signal', 'coveragePct', 'coverageConfidence', 'calibrationStatus'],
  calendarStates: ['dry_stress', 'optimal', 'wet_excess', 'mixed', 'no_data'],
  interpretationRuleIds: ['root-zone-dry', 'irrigation-response'],
} as const satisfies HistoryCardDefinition<'soil'>;

export const dendroCardDefinition = {
  cardType: 'dendro',
  scope: 'zone',
  displayName: 'Dendro',
  titleKey: HistoryI18nKeys.card.dendro.title,
  defaultView: 'growth-timeline',
  views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
  defaultRange: '7d',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['rain-events', 'data-gaps', 'threshold-lines'],
  advancedOverlays: [
    'soil-tension-dendro-shrinkage',
    'temperature-stem-growth',
    'normalized-multi-variable',
    'measured-model-prediction',
    'cross-card-anomaly',
  ],
  requiredCapabilities: ['dendrometer'],
  availabilityRules: ['zone-has-dendro-source'],
  metadataFields: ['lastSeenAt', 'battery', 'signal', 'coveragePct', 'coverageConfidence'],
  calendarStates: [
    'normal_growth',
    'reduced_growth',
    'high_shrinkage_stress',
    'incomplete_night_recovery',
    'no_data',
  ],
  interpretationRuleIds: ['dendro-stress', 'growth-trend'],
} as const satisfies HistoryCardDefinition<'dendro'>;

export const environmentCardDefinition = {
  cardType: 'environment',
  scope: 'zone',
  displayName: 'Environment',
  titleKey: HistoryI18nKeys.card.environment.title,
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
  metadataFields: ['lastSeenAt', 'battery', 'signal', 'coveragePct', 'coverageConfidence'],
  calendarStates: ['normal', 'heat_stress', 'cold_stress', 'high_humidity', 'rain_day', 'no_data'],
  interpretationRuleIds: ['environment-stress', 'daily-min-max'],
} as const satisfies HistoryCardDefinition<'environment'>;

export const irrigationCardDefinition = {
  cardType: 'irrigation',
  scope: 'zone',
  displayName: 'Irrigation',
  titleKey: HistoryI18nKeys.card.irrigation.title,
  defaultView: 'event-timeline',
  views: ['event-timeline', 'calendar', 'irrigation-response', 'advanced'],
  defaultRange: '7d',
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  standardOverlays: ['data-gaps', 'threshold-lines'],
  advancedOverlays: ['normalized-multi-variable', 'measured-model-prediction', 'cross-card-anomaly'],
  requiredCapabilities: ['irrigation-events'],
  availabilityRules: ['zone-has-irrigation-state'],
  metadataFields: ['lastSeenAt', 'coveragePct', 'coverageConfidence'],
  calendarStates: [
    'no_irrigation',
    'irrigation_event',
    'high_irrigation_frequency',
    'possible_ineffective_irrigation',
    'manual_override',
  ],
  interpretationRuleIds: ['irrigation-response', 'irrigation-rhythm'],
} as const satisfies HistoryCardDefinition<'irrigation'>;

export const gatewayCardDefinition = {
  cardType: 'gateway',
  scope: 'gateway',
  displayName: 'Gateway',
  titleKey: HistoryI18nKeys.card.gateway.title,
  defaultView: 'status-overview',
  views: ['status-overview', 'connectivity-timeline', 'advanced'],
  defaultRange: '24h',
  supportedRanges: ['12h', '24h', '7d', '30d'],
  standardOverlays: ['data-gaps'],
  advancedOverlays: [
    'battery-voltage-signal-strength',
    'normalized-multi-variable',
    'cross-card-anomaly',
  ],
  requiredCapabilities: ['gateway-status'],
  availabilityRules: ['gateway-known'],
  metadataFields: ['lastSeenAt', 'coveragePct', 'coverageConfidence', 'syncState'],
  calendarStates: ['normal', 'offline', 'no_data'],
  interpretationRuleIds: ['gateway-sync-state'],
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
