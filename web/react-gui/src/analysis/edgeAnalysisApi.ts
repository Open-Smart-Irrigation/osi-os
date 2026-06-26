import type {
  AnalysisRange,
  AnalysisViewJson,
  AnalysisViewRequest,
  AnalysisViewResponse,
} from './types';

type EdgeAnalysisView = Partial<AnalysisViewJson> & {
  id?: number;
  name?: string;
  schemaVersion?: number;
  isDefault?: boolean;
  is_default?: boolean;
  updatedAt?: string;
  updated_at?: string;
  createdAt?: string;
  created_at?: string;
};

const DEFAULT_RANGE: AnalysisRange = { mode: 'relative', label: '7d', from: null, to: null };

export function adaptEdgeAnalysisView(raw: EdgeAnalysisView): AnalysisViewResponse {
  const schemaVersion = Number(raw.schemaVersion ?? 1);
  const viewJson: AnalysisViewJson = {
    schemaVersion,
    selectors: Array.isArray(raw.selectors) ? raw.selectors : [],
    range: raw.range ?? DEFAULT_RANGE,
    mode: raw.mode ?? 'timeline',
    layout: raw.layout ?? 'stacked',
    toggles: raw.toggles ?? {},
    labelOverrides: raw.labelOverrides ?? {},
    axisLabelOverrides: raw.axisLabelOverrides ?? {},
  };

  return {
    id: Number(raw.id ?? 0),
    name: String(raw.name ?? ''),
    viewJson,
    schemaVersion,
    isDefault: raw.isDefault === true || raw.is_default === true,
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? ''),
  };
}

export function adaptEdgeViewsResponse(payload: unknown): AnalysisViewResponse[] {
  const rawViews = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { views?: unknown[] } | null)?.views)
      ? (payload as { views: unknown[] }).views
      : [];

  return rawViews.map((view) => adaptEdgeAnalysisView(view as EdgeAnalysisView));
}

export function adaptEdgeSavedViewResponse(payload: unknown): AnalysisViewResponse {
  const raw = (payload as { view?: unknown } | null)?.view ?? payload;
  return adaptEdgeAnalysisView(raw as EdgeAnalysisView);
}

export function toEdgeAnalysisViewPayload(request: AnalysisViewRequest): Record<string, unknown> {
  return {
    ...request.viewJson,
    name: request.name,
    isDefault: request.isDefault,
  };
}
