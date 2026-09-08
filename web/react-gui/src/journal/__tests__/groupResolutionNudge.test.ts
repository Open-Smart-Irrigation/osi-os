import { describe, expect, it } from 'vitest';

import type { PlotGroup } from '../../types/journal';
import { matchingActiveHarvestGroups } from '../groupResolutionNudge';

const timestamp = '2026-07-18T00:00:00.000Z';

function group(overrides: Partial<PlotGroup> = {}): PlotGroup {
  return {
    contract_version: 1,
    group_uuid: 'group-1',
    label: 'North block',
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_by_principal_uuid: 'author',
    created_at: timestamp,
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 7,
    deleted_at: null,
    members: ['plot-a', 'plot-b'],
    ...overrides,
  };
}

describe('matchingActiveHarvestGroups', () => {
  it('matches harvest groups by an exact de-duplicated plot set without mutating inputs', () => {
    const groups = [group({ members: ['plot-b', 'plot-a', 'plot-a'] })];
    const selected = ['plot-a', 'plot-b', 'plot-a'];
    const originalGroups = structuredClone(groups);
    const originalSelected = [...selected];

    expect(matchingActiveHarvestGroups('harvest', selected, groups)).toEqual(groups);
    expect(groups).toEqual(originalGroups);
    expect(selected).toEqual(originalSelected);
  });

  it('does not match partial or extra selected plot sets', () => {
    const groups = [group()];

    expect(matchingActiveHarvestGroups('harvest', ['plot-a'], groups)).toEqual([]);
    expect(matchingActiveHarvestGroups('harvest', ['plot-a', 'plot-b', 'plot-c'], groups)).toEqual([]);
  });

  it('rejects an empty selected plot set even when a group has no members', () => {
    expect(matchingActiveHarvestGroups('harvest', [], [group({ members: [] })])).toEqual([]);
  });

  it('requires the exact harvest activity and ignores resolved or deleted groups', () => {
    const groups = [
      group({ group_uuid: 'active' }),
      group({ group_uuid: 'resolved', resolved_at: timestamp }),
      group({ group_uuid: 'deleted', deleted_at: timestamp }),
    ];

    expect(matchingActiveHarvestGroups('Harvest', ['plot-a', 'plot-b'], groups)).toEqual([]);
    expect(matchingActiveHarvestGroups('irrigation', ['plot-a', 'plot-b'], groups)).toEqual([]);
    expect(matchingActiveHarvestGroups('harvest', ['plot-a', 'plot-b'], groups).map((item) => item.group_uuid))
      .toEqual(['active']);
  });

  it('sorts matches by case-folded label and group UUID', () => {
    const groups = [
      group({ group_uuid: 'z-group', label: 'beta' }),
      group({ group_uuid: 'b-group', label: 'ALPHA' }),
      group({ group_uuid: 'a-group', label: 'alpha' }),
    ];
    const originalGroups = structuredClone(groups);

    expect(matchingActiveHarvestGroups('harvest', ['plot-a', 'plot-b'], groups)
      .map((item) => item.group_uuid))
      .toEqual(['a-group', 'b-group', 'z-group']);
    expect(groups).toEqual(originalGroups);
  });

  it('normalizes composed and decomposed Unicode labels before the UUID tie-break', () => {
    const groups = [
      group({ group_uuid: 'z-group', label: '\u00c9clair' }),
      group({ group_uuid: 'a-group', label: 'E\u0301CLAIR' }),
    ];

    expect(matchingActiveHarvestGroups('harvest', ['plot-a', 'plot-b'], groups)
      .map((item) => item.group_uuid))
      .toEqual(['a-group', 'z-group']);
  });

  it('orders empty matching labels by group UUID without mutating the input', () => {
    const groups = [
      group({ group_uuid: 'z-group', label: '' }),
      group({ group_uuid: 'a-group', label: '' }),
    ];
    const originalGroups = structuredClone(groups);

    expect(matchingActiveHarvestGroups('harvest', ['plot-a', 'plot-b'], groups)
      .map((item) => item.group_uuid))
      .toEqual(['a-group', 'z-group']);
    expect(groups).toEqual(originalGroups);
  });
});
