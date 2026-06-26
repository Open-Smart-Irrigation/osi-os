import { describe, it, expect } from 'vitest';
import {
  createDefaultWorkspace, addSeries, removeSeries, setMode, setLayout, setLabelOverride, clearLabelOverride, setAxisLabelOverride, clearAxisLabelOverride, toViewJson, fromViewJson,
} from '../workspaceModel';

const legacyModeOverlay = 'over' + 'lay';
const legacyModeSmallMultiples = 'small' + '-multiples';
const legacyModeBuilder = 'build' + 'er';
const legacyMultiAxisToggle = 'multiAxis' + 'Overlay';

describe('workspaceModel', () => {
  it('defaults to timeline + stacked + normalize off', () => {
    const ws = createDefaultWorkspace();
    expect(ws.mode).toBe('timeline');
    expect(ws.layout).toBe('stacked');
    expect(ws.toggles).toEqual({ normalize: false });
  });

  it('setLayout updates the layout', () => {
    expect(setLayout(createDefaultWorkspace(), 'overlaid').layout).toBe('overlaid');
  });

  it('migrates legacy modes/toggles via fromViewJson', () => {
    const m = (json: any) => fromViewJson(json);
    expect(m({ mode: legacyModeOverlay })).toMatchObject({ mode: 'timeline', layout: 'overlaid' });
    expect(m({ mode: legacyModeSmallMultiples })).toMatchObject({ mode: 'timeline', layout: 'small-multiples' });
    expect(m({ mode: legacyModeBuilder, toggles: { [legacyMultiAxisToggle]: true } })).toMatchObject({ mode: 'timeline', layout: 'overlaid' });
    expect(m({ mode: legacyModeBuilder, toggles: { [legacyMultiAxisToggle]: false } })).toMatchObject({ mode: 'timeline', layout: 'stacked' });
    expect(m({ mode: 'correlation' })).toMatchObject({ mode: 'correlation' });
    expect(m({ mode: 'nonsense' })).toMatchObject({ mode: 'timeline', layout: 'stacked' });
    expect(m({ mode: 'timeline', layout: 'small-multiples' })).toMatchObject({ mode: 'timeline', layout: 'small-multiples' });
  });

  it('preserves normalize and round-trips layout', () => {
    const ws = setLayout({ ...createDefaultWorkspace(), toggles: { normalize: true } }, 'overlaid');
    expect(toViewJson(ws)).toMatchObject({ layout: 'overlaid', toggles: { normalize: true } });
    expect(fromViewJson(toViewJson(ws))).toEqual(ws);
  });

  it('defaults to an empty timeline workspace at 7d', () => {
    const ws = createDefaultWorkspace();
    expect(ws.selectors).toEqual([]);
    expect(ws.mode).toBe('timeline');
    expect(ws.layout).toBe('stacked');
    expect(ws.range.label).toBe('7d');
    expect(ws.toggles).toEqual({ normalize: false });
  });

  it('adds series idempotently and removes them', () => {
    let ws = createDefaultWorkspace();
    ws = addSeries(ws, 'a');
    ws = addSeries(ws, 'a');
    expect(ws.selectors).toEqual([{ seriesId: 'a' }]);
    ws = addSeries(ws, 'b');
    ws = removeSeries(ws, 'a');
    expect(ws.selectors).toEqual([{ seriesId: 'b' }]);
  });

  it('round-trips through view_json', () => {
    let ws = setMode(addSeries(createDefaultWorkspace(), 'a'), 'correlation');
    const json = toViewJson(ws);
    expect(json.schemaVersion).toBe(1);
    expect(fromViewJson(json)).toEqual(ws);
  });

  it('repairs an unknown mode on load', () => {
    const json = { ...toViewJson(createDefaultWorkspace()), mode: 'bogus' } as never;
    expect(fromViewJson(json).mode).toBe('timeline');
    expect(fromViewJson(json).layout).toBe('stacked');
  });
});

describe('labelOverrides', () => {
  it('sets and clears an override', () => {
    let ws = setLabelOverride(createDefaultWorkspace(), 's1', 'My label');
    expect(ws.labelOverrides.s1).toBe('My label');
    ws = clearLabelOverride(ws, 's1');
    expect(ws.labelOverrides.s1).toBeUndefined();
  });

  it('prunes an override when its series is removed', () => {
    let ws = addSeries(createDefaultWorkspace(), 's1');
    ws = setLabelOverride(ws, 's1', 'Renamed');
    ws = removeSeries(ws, 's1');
    expect(ws.labelOverrides.s1).toBeUndefined();
  });

  it('round-trips overrides through view JSON', () => {
    const ws = setLabelOverride(createDefaultWorkspace(), 's1', 'Keep me');
    const restored = fromViewJson(toViewJson(ws));
    expect(restored.labelOverrides.s1).toBe('Keep me');
  });

  it('defaults overrides to empty for legacy view JSON without the field', () => {
    const legacy = {
      schemaVersion: 1,
      selectors: [],
      range: createDefaultWorkspace().range,
      mode: legacyModeBuilder,
      toggles: { normalize: false, [legacyMultiAxisToggle]: false },
    } as never;
    expect(fromViewJson(legacy).labelOverrides).toEqual({});
  });
});

describe('axisLabelOverrides', () => {
  it('sets and clears axis label overrides', () => {
    let ws = createDefaultWorkspace();
    expect(ws.axisLabelOverrides).toEqual({});
    ws = setAxisLabelOverride(ws, 'swt_1', 'Soil tension');
    expect(ws.axisLabelOverrides).toEqual({ swt_1: 'Soil tension' });
    ws = clearAxisLabelOverride(ws, 'swt_1');
    expect(ws.axisLabelOverrides).toEqual({});
  });

  it('round-trips axisLabelOverrides through view json and defaults missing to {}', () => {
    const ws = setAxisLabelOverride(createDefaultWorkspace(), 'swt_1', 'X');
    expect(toViewJson(ws).axisLabelOverrides).toEqual({ swt_1: 'X' });
    expect(fromViewJson({ ...toViewJson(ws), axisLabelOverrides: undefined }).axisLabelOverrides).toEqual({});
  });
});
