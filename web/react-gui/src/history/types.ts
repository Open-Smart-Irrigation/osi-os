export type HistoryCardType = 'soil' | 'dendro' | 'environment' | 'irrigation' | 'gateway';
export type HistoryCardScope = 'zone' | 'gateway';
export type HistoryRangeLabel = '12h' | '24h' | '7d' | '30d' | 'season' | 'custom';
export type HistoryAggregationLevel = 'auto' | 'raw' | '15m' | 'hourly' | 'daily' | 'weekly';
export type HistorySyncState = 'local' | 'synced' | 'stale' | 'degraded' | 'unknown';
export type HistoryPlatform = 'edge' | 'cloud';
export type AdvancedFieldAvailability =
  | 'collected'
  | 'not_collected_at_time'
  | 'unknown_now'
  | 'unsupported';
export type CoverageConfidence = 'configured' | 'derived' | 'unknown';

export type SoilHistoryViewMode =
  | 'soil-profile'
  | 'line-chart'
  | 'calendar'
  | 'irrigation-response'
  | 'advanced';
export type DendroHistoryViewMode =
  | 'growth-timeline'
  | 'line-chart'
  | 'stress-events'
  | 'calendar'
  | 'advanced';
export type EnvironmentHistoryViewMode =
  | 'line-chart'
  | 'daily-min-max'
  | 'calendar'
  | 'stress-events'
  | 'advanced';
export type IrrigationHistoryViewMode =
  | 'event-timeline'
  | 'calendar'
  | 'irrigation-response'
  | 'advanced';
export type GatewayHistoryViewMode =
  | 'status-overview'
  | 'connectivity-timeline'
  | 'advanced';

export type HistoryViewMode =
  | SoilHistoryViewMode
  | DendroHistoryViewMode
  | EnvironmentHistoryViewMode
  | IrrigationHistoryViewMode
  | GatewayHistoryViewMode;

export type HistoryViewModeByCardType = {
  soil: SoilHistoryViewMode;
  dendro: DendroHistoryViewMode;
  environment: EnvironmentHistoryViewMode;
  irrigation: IrrigationHistoryViewMode;
  gateway: GatewayHistoryViewMode;
};

export type HistoryOverlayId =
  | 'irrigation-events'
  | 'rain-events'
  | 'forecast-boundary'
  | 'data-gaps'
  | 'threshold-lines'
  | 'soil-depths'
  | 'environment-variables'
  | 'soil-tension-dendro-shrinkage'
  | 'temperature-stem-growth'
  | 'battery-voltage-signal-strength'
  | 'normalized-multi-variable'
  | 'measured-model-prediction'
  | 'cross-card-anomaly';

export type HistoryCalendarState =
  | 'dry_stress'
  | 'optimal'
  | 'wet_excess'
  | 'mixed'
  | 'normal_growth'
  | 'reduced_growth'
  | 'high_shrinkage_stress'
  | 'incomplete_night_recovery'
  | 'normal'
  | 'heat_stress'
  | 'cold_stress'
  | 'high_humidity'
  | 'rain_day'
  | 'no_irrigation'
  | 'irrigation_event'
  | 'high_irrigation_frequency'
  | 'possible_ineffective_irrigation'
  | 'manual_override'
  | 'offline'
  | 'no_data';

export const WorkspaceSchemaVersion = 1;
export type WorkspaceSchemaVersion = typeof WorkspaceSchemaVersion;

export interface HistoryCardDefinition<TCardType extends HistoryCardType = HistoryCardType> {
  cardType: TCardType;
  scope: HistoryCardScope;
  displayName: string;
  titleKey: string;
  defaultView: HistoryViewModeByCardType[TCardType];
  views: readonly HistoryViewModeByCardType[TCardType][];
  defaultRange: HistoryRangeLabel;
  supportedRanges: readonly HistoryRangeLabel[];
  standardOverlays: readonly HistoryOverlayId[];
  advancedOverlays: readonly HistoryOverlayId[];
  requiredCapabilities: readonly string[];
  availabilityRules: readonly string[];
  metadataFields: readonly string[];
  calendarStates: readonly HistoryCalendarState[];
  interpretationRuleIds: readonly string[];
}

export interface HistoryMetricStatus {
  status: string;
  latest?: number | string | null;
  unit?: string | null;
}

export interface HistoryAdvancedField {
  field: string;
  value: string | number | boolean | null;
  unit: string | null;
  availability: AdvancedFieldAvailability;
}

export interface HistoryCardAvailability {
  available: boolean;
  reasons: string[];
}

export interface HistoryCardOrdering {
  pinned: boolean;
  score: number;
  recentRank: number | null;
  manualOrder?: number | null;
  criticalAlert?: boolean;
}

export interface HistoryCardMetadata {
  lastSeenAt?: string | null;
  battery?: HistoryMetricStatus;
  signal?: HistoryMetricStatus;
  coveragePct?: number | null;
  coverageConfidence: CoverageConfidence;
  syncState?: HistorySyncState;
  calibrationStatus?: string | null;
  [key: string]: unknown;
}

export interface HistoryCardSummary<TCardType extends HistoryCardType = HistoryCardType> {
  cardId: string;
  cardType: TCardType;
  scope: HistoryCardScope;
  title: string;
  subtitle: string;
  defaultView: HistoryViewModeByCardType[TCardType];
  views: HistoryViewModeByCardType[TCardType][];
  supportedRanges: HistoryRangeLabel[];
  defaultRange: HistoryRangeLabel;
  metadata: HistoryCardMetadata;
  availability: HistoryCardAvailability;
  ordering: HistoryCardOrdering;
}

export interface HistoryCardSummaryResponse {
  zoneId?: number;
  zoneUuid?: string;
  gatewayEui?: string;
  generatedAt: string;
  cards: HistoryCardSummary[];
}

export interface HistoryRangeSelection {
  label: HistoryRangeLabel;
  from: string | null;
  to: string | null;
  timezone: string;
}

export interface HistoryAggregationMetadata {
  level: HistoryAggregationLevel;
  bucketSizeSeconds: number | null;
  coveragePct: number | null;
  coverageConfidence: CoverageConfidence;
  pointCount: number;
  dominantStatusMethod?: string | null;
}

export interface HistoryResponseLimits {
  maxPointsPerSeries: number;
  maxEvents: number;
  maxInterpretations: number;
  truncated: boolean;
}

export interface HistorySeriesPoint {
  t: string;
  bucketStart?: string;
  bucketEnd?: string;
  value: number | null;
  min?: number | null;
  max?: number | null;
  mean?: number | null;
  median?: number | null;
  latest?: number | null;
  dominantStatus?: string | null;
  dominantStatusMethod?: string | null;
  coveragePct?: number | null;
  coverageConfidence: CoverageConfidence;
  count?: number;
  unit?: string | null;
  quality?: 'ok' | 'partial' | 'gap' | 'estimated' | 'unknown';
}

export interface HistorySeries {
  id: string;
  label: string;
  unit: string | null;
  points: HistorySeriesPoint[];
}

export interface HistoryProfilePoint {
  id: string;
  label: string;
  depthCm?: number | null;
  value: number | null;
  unit: string | null;
  status?: string | null;
}

export interface HistoryEvent {
  id: string;
  type: string;
  t: string;
  end?: string | null;
  label: string;
  severity: 'info' | 'warning' | 'critical' | 'success' | 'unknown';
  metadata: Record<string, unknown>;
}

export interface HistoryCalendarDay {
  date: string;
  state: HistoryCalendarState;
  coveragePct: number | null;
  coverageConfidence: CoverageConfidence;
  summary?: {
    key: string;
    params?: Record<string, unknown>;
  };
  metrics?: Record<string, number | string | null>;
  markers?: HistoryCalendarMarker[];
}

export interface HistoryCalendar {
  timezone: string;
  days: HistoryCalendarDay[];
}

export interface HistoryCalendarMarker {
  type: string;
  severity: 'info' | 'warning' | 'critical' | 'success' | 'unknown';
  labelKey: string;
  params?: Record<string, unknown>;
}

export interface HistoryInterpretationEvidence {
  seriesId?: string;
  from?: string;
  to?: string;
  type?: string;
  status?: string | null;
  since?: string | null;
  coveragePct?: number | null;
  coverageConfidence?: CoverageConfidence;
}

export interface HistoryInterpretation {
  id: string;
  ruleId?: string;
  source:
    | 'local-rule'
    | 'forecast'
    | 'prediction-model'
    | 'ai'
    | 'satellite'
    | 'weather-adjusted';
  severity: 'info' | 'warning' | 'critical' | 'success' | 'unknown';
  titleKey?: string;
  bodyKey?: string;
  params?: Record<string, unknown>;
  title?: string;
  body?: string;
  evidence: HistoryInterpretationEvidence[];
  confidence: number | null;
  modelRunId?: string;
  forecastBoundary?: string;
  actualVsPredictedDelta?: number;
  recommendation?: string;
}

export interface HistoryFreshness {
  dataAsOf: string | null;
  syncState: HistorySyncState;
}

export interface HistoryAdvancedPlaceholder {
  schemaVersion?: number;
  cardType?: HistoryCardType | string;
  placeholder?: boolean;
  generatedAt?: string;
  availableFields?: string[];
  sourceDevices?: Array<Record<string, unknown>>;
  sections?: Array<Record<string, unknown>>;
}

export interface HistoryCardDataResponse<TCardType extends HistoryCardType = HistoryCardType> {
  cardId: string;
  cardType: TCardType;
  view: HistoryViewModeByCardType[TCardType];
  range: HistoryRangeSelection;
  aggregation: HistoryAggregationMetadata;
  limits: HistoryResponseLimits;
  series: HistorySeries[];
  profiles: HistoryProfilePoint[];
  events: HistoryEvent[];
  calendar: HistoryCalendar | null;
  interpretations: HistoryInterpretation[];
  freshness: HistoryFreshness;
  advancedFields: Record<string, HistoryAdvancedField>;
}

export interface HistoryAdvancedResponse<TCardType extends HistoryCardType = HistoryCardType> {
  generatedAt: string;
  cardId: string;
  cardType: TCardType;
  range: HistoryRangeSelection;
  freshness: HistoryFreshness;
  aggregation: HistoryAggregationMetadata;
  placeholder: HistoryAdvancedPlaceholder;
  advancedFields: Record<string, HistoryAdvancedField>;
}

export interface HistoryCardDataRequest {
  view: HistoryViewMode;
  range: HistoryRangeSelection;
  aggregation: HistoryAggregationLevel;
  overlays: readonly HistoryOverlayId[];
}

export interface HistoryWorkspaceRange {
  mode: 'relative' | 'absolute';
  label: HistoryRangeLabel;
  from: string | null;
  to: string | null;
}

export interface HistoryWorkspaceLimits {
  maxPanels: number;
  platform: HistoryPlatform;
}

export interface HistoryWorkspaceInspector {
  selectedTimestamp: string | null;
  open: boolean;
}

export interface HistoryAdvancedOverlaySettings {
  normalize?: boolean;
  rawUnits?: boolean;
  separateYAxes?: boolean;
  correlationMode?: boolean;
}

export interface HistoryWorkspace {
  schemaVersion: WorkspaceSchemaVersion;
  farmId: number | null;
  hubId: string | null;
  zoneId: number | null;
  zoneUuid: string | null;
  selectedCards: string[];
  panelOrder: string[];
  collapsedPanels: string[];
  dateRange: HistoryWorkspaceRange;
  aggregation: HistoryAggregationLevel;
  viewModesByCard: Record<string, HistoryViewMode>;
  enabledOverlays: Record<string, HistoryOverlayId[]>;
  advancedOverlaySettings: Record<string, HistoryAdvancedOverlaySettings>;
  limits: HistoryWorkspaceLimits;
  inspector: HistoryWorkspaceInspector;
  pinnedCards: string[];
  layout: 'stacked' | 'single';
  [futureField: string]: unknown;
}

export { HistoryI18nKeys } from './i18nKeys.ts';
