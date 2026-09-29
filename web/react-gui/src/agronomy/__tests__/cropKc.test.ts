import { describe, expect, it } from 'vitest';
import { CROP_OPTION_GROUPS, cropById, kcRamp, normalizeStage, resolveKc, stageFamily, stageLengths } from '../cropKc';

describe('cropKc', () => {
  it('groups the 136 crops into 15 FAO groups with variants under their default', () => {
    expect(CROP_OPTION_GROUPS).toHaveLength(15);
    const total = CROP_OPTION_GROUPS.reduce((n, g) => n + g.crops.reduce((m, c) => m + 1 + c.variants.length, 0), 0);
    expect(total).toBe(136);
    const grapes = CROP_OPTION_GROUPS.find((g) => g.group.id === 'grapes_berries')!.crops.find((c) => c.crop.id === 'grapevine')!;
    expect(grapes.variants.map((v) => v.id)).toEqual(['grapes_table']);
  });
  it('maps legacy stages and uses two label families', () => {
    expect(normalizeStage('veraison')).toBe('mid_season');
    expect(normalizeStage('default')).toBeNull();
    expect(stageFamily('grapevine')).toBe('woody');
    expect(stageFamily('citrus_50_cover')).toBe('woody');
    expect(stageFamily('maize')).toBe('annual');
    expect(stageFamily('banana')).toBe('annual');
    expect(stageFamily('other')).toBe('annual');
  });
  it('resolves grapevine at veraison to the wine row', () => {
    expect(resolveKc({ cropType: 'grapevine', phenologicalStage: 'veraison' })).toEqual({ kc: 0.7, kcSource: 'fao56_crop', cropId: 'grapevine', stage: 'mid_season', kcStageDay: null, stageOverrun: null });
    expect(cropById('pear')?.kc_mid).toBe(0.95);
  });
  it('takes the FAO-56 table values for the ramp stages: development kc_mid, late season kc_end', () => {
    const late = (cropType: string) => resolveKc({ cropType, phenologicalStage: 'late_season' }).kc;
    expect(['maize', 'grapevine', 'apple', 'potato', 'alfalfa'].map(late)).toEqual([0.35, 0.45, 0.7, 0.75, 1.15]);
    expect(resolveKc({ cropType: 'soybean', phenologicalStage: 'development' }).kc).toBe(1.15);
  });
  it('reproduces FAO-56 Example 28 through kcRamp (day 40 = 0.77, day 95 = 0.56)', () => {
    expect(kcRamp(0.15, 1.19, 14, 25)).toBe(0.77);
    expect(kcRamp(1.19, 0.35, 14, 20)).toBe(0.56);
  });
  it('gives the default Table 11 lengths: own row, promoted proposal, swapped default, partial row, none, unknown', () => {
    expect(stageLengths('maize')).toEqual({ initial: 30, development: 40, mid_season: 50, late_season: 30 });
    expect(stageLengths('garlic')).toEqual({ initial: 15, development: 25, mid_season: 70, late_season: 40 });
    expect(stageLengths('sugar_beet')).toEqual({ initial: 50, development: 40, mid_season: 50, late_season: 40 });
    expect(stageLengths('grass')).toEqual({ initial: 10, development: 20, mid_season: null, late_season: null });
    expect(stageLengths('conifer')).toEqual({ initial: null, development: null, mid_season: null, late_season: null });
    expect(stageLengths('other')).toBeNull();
  });
  it('counts calendar days across the spring clock change and ignores an impossible start date', () => {
    // 20 March to 9 April 2026 spans the 29 March switch: still d = 20, day 21 of 40.
    expect(resolveKc({ cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-03-20', date: '2026-04-09' }))
      .toEqual({ kc: 0.77, kcSource: 'fao56_curve', cropId: 'maize', stage: 'development', kcStageDay: 21, stageOverrun: false });
    expect(resolveKc({ cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-02-30', date: '2026-04-09' }))
      .toEqual({ kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'development', kcStageDay: null, stageOverrun: null });
  });
  it('keeps the table value for a stage without a length (grass late season, conifer)', () => {
    expect(resolveKc({ cropType: 'grass', phenologicalStage: 'late_season', stageStartedOn: '2026-05-01', date: '2026-05-11' }).kc).toBe(1);
    expect(resolveKc({ cropType: 'conifer', phenologicalStage: 'development', stageStartedOn: '2026-05-01', date: '2026-05-11' }))
      .toEqual({ kc: 1, kcSource: 'fao56_crop', cropId: 'conifer', stage: 'development', kcStageDay: null, stageOverrun: null });
  });
});
