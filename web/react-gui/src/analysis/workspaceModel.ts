import type { AnalysisRange, AnalysisSelector, AnalysisViewJson, AnalysisWorkspaceMode, TimelineLayout } from './types';

export interface AnalysisWorkspaceState {
  schemaVersion: 1;
  selectors: AnalysisSelector[];
  range: AnalysisRange;
  mode: AnalysisWorkspaceMode;
  layout: TimelineLayout;
  toggles: { normalize: boolean };
  labelOverrides: Record<string, string>;
  axisLabelOverrides: Record<string, string>;
}

const MODES: AnalysisWorkspaceMode[] = ['timeline', 'correlation'];
export const LAYOUTS: TimelineLayout[] = ['stacked', 'overlaid', 'small-multiples'];
const LEGACY_MODE_OVERLAY = 'over' + 'lay';
const LEGACY_MODE_SMALL_MULTIPLES = 'small' + '-multiples';
const LEGACY_MODE_BUILDER = 'build' + 'er';
const LEGACY_MULTI_AXIS_TOGGLE = 'multiAxis' + 'Overlay';

export function createDefaultWorkspace(): AnalysisWorkspaceState {
  return {
    schemaVersion: 1,
    selectors: [],
    range: { mode: 'relative', label: '7d', from: null, to: null },
    mode: 'timeline',
    layout: 'stacked',
    toggles: { normalize: false },
    labelOverrides: {},
    axisLabelOverrides: {},
  };
}

export function addSeries(state: AnalysisWorkspaceState, seriesId: string): AnalysisWorkspaceState {
  if (state.selectors.some((s) => s.seriesId === seriesId)) return state;
  return { ...state, selectors: [...state.selectors, { seriesId }] };
}

export function removeSeries(state: AnalysisWorkspaceState, seriesId: string): AnalysisWorkspaceState {
  const labelOverrides = { ...state.labelOverrides };
  delete labelOverrides[seriesId];
  return { ...state, selectors: state.selectors.filter((s) => s.seriesId !== seriesId), labelOverrides };
}

export function setMode(state: AnalysisWorkspaceState, mode: AnalysisWorkspaceMode): AnalysisWorkspaceState {
  return { ...state, mode };
}

export function setLayout(state: AnalysisWorkspaceState, layout: TimelineLayout): AnalysisWorkspaceState {
  return { ...state, layout };
}

export function setRange(state: AnalysisWorkspaceState, range: AnalysisRange): AnalysisWorkspaceState {
  return { ...state, range };
}

export function setToggle(
  state: AnalysisWorkspaceState,
  key: 'normalize',
  value: boolean,
): AnalysisWorkspaceState {
  return { ...state, toggles: { [key]: value } };
}

export function setLabelOverride(
  state: AnalysisWorkspaceState,
  seriesId: string,
  label: string,
): AnalysisWorkspaceState {
  return { ...state, labelOverrides: { ...state.labelOverrides, [seriesId]: label } };
}

export function clearLabelOverride(state: AnalysisWorkspaceState, seriesId: string): AnalysisWorkspaceState {
  const labelOverrides = { ...state.labelOverrides };
  delete labelOverrides[seriesId];
  return { ...state, labelOverrides };
}

export function setAxisLabelOverride(state: AnalysisWorkspaceState, channelKey: string, label: string): AnalysisWorkspaceState {
  return { ...state, axisLabelOverrides: { ...state.axisLabelOverrides, [channelKey]: label } };
}

export function clearAxisLabelOverride(state: AnalysisWorkspaceState, channelKey: string): AnalysisWorkspaceState {
  const axisLabelOverrides = { ...state.axisLabelOverrides };
  delete axisLabelOverrides[channelKey];
  return { ...state, axisLabelOverrides };
}

export function toViewJson(state: AnalysisWorkspaceState): AnalysisViewJson {
  return {
    schemaVersion: state.schemaVersion,
    selectors: state.selectors,
    range: state.range,
    mode: state.mode,
    layout: state.layout,
    toggles: { normalize: state.toggles.normalize },
    labelOverrides: state.labelOverrides,
    axisLabelOverrides: state.axisLabelOverrides,
  };
}

export function fromViewJson(json: AnalysisViewJson): AnalysisWorkspaceState {
  const defaults = createDefaultWorkspace();
  const view = json ?? ({} as AnalysisViewJson);
  const { mode, layout } = migrateModeAndLayout(view);
  return {
    schemaVersion: 1,
    selectors: Array.isArray(view.selectors) ? view.selectors : [],
    range: view.range ?? defaults.range,
    mode,
    layout,
    toggles: {
      normalize: Boolean(view.toggles?.normalize),
    },
    labelOverrides: view.labelOverrides ?? {},
    axisLabelOverrides: view.axisLabelOverrides ?? {},
  };
}

function migrateModeAndLayout(json: AnalysisViewJson): Pick<AnalysisWorkspaceState, 'mode' | 'layout'> {
  if (json.mode === LEGACY_MODE_OVERLAY) {
    return { mode: 'timeline', layout: 'overlaid' };
  }
  if (json.mode === LEGACY_MODE_SMALL_MULTIPLES) {
    return { mode: 'timeline', layout: 'small-multiples' };
  }
  if (json.mode === LEGACY_MODE_BUILDER) {
    const toggles = json.toggles as Record<string, unknown> | undefined;
    return {
      mode: 'timeline',
      layout: toggles?.[LEGACY_MULTI_AXIS_TOGGLE] ? 'overlaid' : 'stacked',
    };
  }
  if (isWorkspaceMode(json.mode)) {
    return {
      mode: json.mode,
      layout: isTimelineLayout(json.layout) ? json.layout : 'stacked',
    };
  }
  return { mode: 'timeline', layout: 'stacked' };
}

function isWorkspaceMode(mode: unknown): mode is AnalysisWorkspaceMode {
  return typeof mode === 'string' && MODES.includes(mode as AnalysisWorkspaceMode);
}

function isTimelineLayout(layout: unknown): layout is TimelineLayout {
  return typeof layout === 'string' && LAYOUTS.includes(layout as TimelineLayout);
}
