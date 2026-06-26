export type AnalysisAvailabilityValue = 'available' | 'unsupported';

export interface AnalysisCatalogEntry {
  seriesId: string;
  hubEui: string | null;
  zoneId: number;
  zoneName: string;
  cardType: string;
  sourceKey: string;
  channelKey: string;
  displayName: string;
  unit: string | null;
  availability: AnalysisAvailabilityValue;
  deviceName: string | null;
  depthCm: number | null;
}

export interface AnalysisCatalogResponse {
  generatedAt: string;
  channels: AnalysisCatalogEntry[];
}

export interface AnalysisSelector {
  seriesId: string;
}

export interface AnalysisRange {
  mode: string;
  label: string;
  from: string | null;
  to: string | null;
}

export interface AnalysisSeriesRequest {
  selectors: AnalysisSelector[];
  range: AnalysisRange;
  aggregation: string;
}

export interface AnalysisPoint {
  t: string;
  value: number | null;
  count: number;
  quality: string;
}

export interface AnalysisResolved {
  hubEui: string | null;
  zoneId: number;
  cardType: string;
  sourceKey: string;
  channelKey: string;
}

export interface AnalysisSeries {
  seriesId: string;
  resolved: AnalysisResolved;
  label: string;
  unit: string | null;
  coveragePct: number | null;
  points: AnalysisPoint[];
  truncated: boolean;
}

export interface AnalysisDropped {
  seriesId: string | null;
  reason: string;
}

export interface AnalysisGridDto {
  stepSeconds: number;
  from: string;
  to: string;
  bucketCount: number;
}

export interface AnalysisAggregation {
  requested: string;
  applied: string;
  bucketSizeSeconds?: number;
}

export interface AnalysisRangeResolved {
  label?: string;
  from: string;
  to: string;
  timezone?: string;
}

export interface AnalysisSeriesResponse {
  generatedAt?: string;
  range: AnalysisRangeResolved;
  aggregation: AnalysisAggregation;
  grid?: AnalysisGridDto;
  series: AnalysisSeries[];
  dropped: AnalysisDropped[];
}

export type AnalysisWorkspaceMode = 'timeline' | 'correlation';
export type TimelineLayout = 'stacked' | 'overlaid' | 'small-multiples';
type LegacyMultiAxisToggleKey = `multiAxis${'Overlay'}`;

export interface AnalysisViewJson {
  schemaVersion: number;
  selectors: AnalysisSelector[];
  range: AnalysisRange;
  mode: AnalysisWorkspaceMode | string;
  layout?: TimelineLayout;
  toggles?: { normalize?: boolean } & Partial<Record<LegacyMultiAxisToggleKey, boolean>>;
  labelOverrides?: Record<string, string>;
  axisLabelOverrides?: Record<string, string>;
}

export interface AnalysisViewRequest {
  name: string;
  viewJson: AnalysisViewJson;
  isDefault: boolean;
}

export interface AnalysisViewResponse {
  id: number;
  name: string;
  viewJson: AnalysisViewJson;
  schemaVersion: number;
  isDefault: boolean;
  updatedAt: string;
}
