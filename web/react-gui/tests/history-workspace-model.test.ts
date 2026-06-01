import assert from 'node:assert/strict';
import test from 'node:test';

import { maxPanelsByPlatform } from '../src/history/platformLimits.ts';
import { orderHistoryCards } from '../src/history/useHistoryCards.ts';
import {
  migrateHistoryWorkspace,
  resolveWorkspacePanels,
  updateWorkspaceSelectedCards,
} from '../src/history/workspaceModel.ts';
import type { HistoryCardSummary } from '../src/history/types.ts';

function card(cardId: string, overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId,
    cardType: 'soil',
    scope: 'zone',
    title: cardId,
    subtitle: '',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart'],
    supportedRanges: ['24h', '7d'],
    defaultRange: '24h',
    metadata: {
      coverageConfidence: 'configured',
    },
    availability: {
      available: true,
      reasons: [],
    },
    ordering: {
      pinned: false,
      score: 0,
      recentRank: null,
      manualOrder: null,
      criticalAlert: false,
    },
    ...overrides,
  };
}

test('orders pinned cards first while ranking critical alerts only among unpinned cards', () => {
  const ordered = orderHistoryCards([
    card('new-card', { ordering: { pinned: false, score: 0, recentRank: null, criticalAlert: false } }),
    card('critical-unpinned', { ordering: { pinned: false, score: 10, recentRank: 99, criticalAlert: true } }),
    card('high-use-unpinned', { ordering: { pinned: false, score: 95, recentRank: null, criticalAlert: false } }),
    card('pinned-normal', { ordering: { pinned: true, score: 1, recentRank: 10, manualOrder: 0, criticalAlert: false } }),
  ]);

  assert.deepEqual(ordered.map((summary) => summary.cardId), [
    'pinned-normal',
    'critical-unpinned',
    'high-use-unpinned',
    'new-card',
  ]);
});

test('migrates older workspace payloads to the edge schema with the Slice 1 panel cap', () => {
  const workspace = migrateHistoryWorkspace(
    {
      selectedCards: ['soil-zone-1'],
      dateRange: { label: '7d' },
      layout: 'grid',
    },
    {
      platform: 'edge',
      farmId: 7,
      hubId: '0011223344556677',
      zoneId: 12,
      zoneUuid: 'zone-uuid',
    },
  );

  assert.equal(workspace.schemaVersion, 1);
  assert.equal(workspace.farmId, 7);
  assert.equal(workspace.hubId, '0011223344556677');
  assert.equal(workspace.zoneId, 12);
  assert.equal(workspace.zoneUuid, 'zone-uuid');
  assert.equal(workspace.layout, 'stacked');
  assert.deepEqual(workspace.panelOrder, ['soil-zone-1']);
  assert.equal(workspace.dateRange.mode, 'relative');
  assert.equal(workspace.dateRange.label, '7d');
  assert.equal(workspace.limits.platform, 'edge');
  assert.equal(workspace.limits.maxPanels, maxPanelsByPlatform.edge);
});

test('resolves dangling workspace card IDs as unavailable panels and caps edge comparison panels', () => {
  const workspace = migrateHistoryWorkspace(
    {
      selectedCards: ['missing-card', 'soil-1', 'soil-2', 'soil-3', 'soil-4'],
      panelOrder: ['missing-card', 'soil-1', 'soil-2', 'soil-3', 'soil-4'],
      layout: 'stacked',
    },
    { platform: 'edge', farmId: null, hubId: null, zoneId: 12, zoneUuid: 'zone-uuid' },
  );
  const resolved = resolveWorkspacePanels(workspace, [
    card('soil-1'),
    card('soil-2'),
    card('soil-3'),
    card('soil-4'),
  ]);

  assert.equal(resolved.panels.length, maxPanelsByPlatform.edge);
  assert.equal(resolved.droppedPanelCount, 1);
  assert.deepEqual(
    resolved.panels.map((panel) => ({ cardId: panel.cardId, available: panel.available })),
    [
      { cardId: 'missing-card', available: false },
      { cardId: 'soil-1', available: true },
      { cardId: 'soil-2', available: true },
      { cardId: 'soil-3', available: true },
    ],
  );
});

test('does not add comparison cards beyond the edge panel cap', () => {
  const workspace = migrateHistoryWorkspace(
    {
      selectedCards: ['soil-1', 'soil-2', 'soil-3', 'soil-4'],
      panelOrder: ['soil-1', 'soil-2', 'soil-3', 'soil-4'],
      layout: 'stacked',
    },
    { platform: 'edge', farmId: null, hubId: null, zoneId: 12, zoneUuid: 'zone-uuid' },
  );

  const result = updateWorkspaceSelectedCards(workspace, 'soil-5', true);

  assert.deepEqual(result.workspace.selectedCards, ['soil-1', 'soil-2', 'soil-3', 'soil-4']);
  assert.equal(result.capped, true);
  assert.equal(result.maxPanels, maxPanelsByPlatform.edge);
});
