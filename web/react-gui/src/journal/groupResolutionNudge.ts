import type { PlotGroup } from '../types/journal';

function folded(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en');
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

export function matchingActiveHarvestGroups(
  activityCode: string,
  selectedPlotUuids: readonly string[],
  groups: readonly PlotGroup[],
): PlotGroup[] {
  if (activityCode !== 'harvest' || selectedPlotUuids.length === 0) return [];

  return groups
    .filter((group) => group.resolved_at === null && group.deleted_at === null)
    .filter((group) => sameSet(group.members, selectedPlotUuids))
    .sort((left, right) => {
      const leftLabel = folded(left.label);
      const rightLabel = folded(right.label);
      return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1
        : left.group_uuid < right.group_uuid ? -1 : left.group_uuid > right.group_uuid ? 1 : 0;
    });
}
