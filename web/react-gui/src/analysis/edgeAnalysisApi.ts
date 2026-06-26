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
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireEdgeAnalysisView(raw: unknown, message: string): EdgeAnalysisView {
  if (
    !isRecord(raw)
    || raw.id === undefined
    || raw.name === undefined
    || !Array.isArray(raw.selectors)
  ) {
    throw new Error(message);
  }

  return raw as EdgeAnalysisView;
}

export function adaptEdgeAnalysisView(raw: EdgeAnalysisView): AnalysisViewResponse {
  const view = requireEdgeAnalysisView(raw, 'Invalid analysis view response');
  const schemaVersion = Number(view.schemaVersion ?? 1);
  const viewJson: AnalysisViewJson = {
    schemaVersion,
    selectors: Array.isArray(view.selectors) ? view.selectors : [],
    range: view.range ?? DEFAULT_RANGE,
    mode: view.mode ?? 'timeline',
    layout: view.layout ?? 'stacked',
    toggles: view.toggles ?? {},
    labelOverrides: view.labelOverrides ?? {},
    axisLabelOverrides: view.axisLabelOverrides ?? {},
  };

  return {
    id: Number(view.id ?? 0),
    name: String(view.name ?? ''),
    viewJson,
    schemaVersion,
    isDefault: view.isDefault === true || view.is_default === true,
    updatedAt: String(view.updatedAt ?? view.updated_at ?? view.createdAt ?? view.created_at ?? ''),
  };
}

export function adaptEdgeViewsResponse(payload: unknown): AnalysisViewResponse[] {
  let rawViews: unknown[];
  if (Array.isArray(payload)) {
    rawViews = payload;
  } else if (isRecord(payload) && 'views' in payload) {
    if (!Array.isArray(payload.views)) {
      throw new Error('Invalid analysis views response');
    }
    rawViews = payload.views;
  } else {
    throw new Error('Invalid analysis views response');
  }

  return rawViews.map((view) => adaptEdgeAnalysisView(view as EdgeAnalysisView));
}

export function adaptEdgeSavedViewResponse(payload: unknown): AnalysisViewResponse {
  const raw = isRecord(payload) && 'view' in payload ? payload.view : payload;
  const view = requireEdgeAnalysisView(raw, 'Invalid analysis saved view response');
  return adaptEdgeAnalysisView(view);
}

export function toEdgeAnalysisViewPayload(request: AnalysisViewRequest): Record<string, unknown> {
  return {
    ...request.viewJson,
    name: request.name,
    isDefault: request.isDefault,
  };
}
