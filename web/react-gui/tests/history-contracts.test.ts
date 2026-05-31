import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  historyCardDefinitions,
  historyCardDefinitionsByType,
} from '../src/history/cardDefinitions.ts';
import {
  canUseOverlay,
  historyAdvancedOverlayIds,
} from '../src/history/overlayPolicy.ts';
import { defaultAggregationForRange } from '../src/history/rangeModel.ts';
import {
  HistoryI18nKeys,
  WorkspaceSchemaVersion,
  type HistoryCardDataResponse,
  type HistoryCardSummaryResponse,
  type HistoryWorkspace,
} from '../src/history/types.ts';
import { maxPanelsByPlatform } from '../src/history/platformLimits.ts';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/history-card-response.json'), 'utf8'),
) as {
  summaries: HistoryCardSummaryResponse;
  data: HistoryCardDataResponse;
  workspace: HistoryWorkspace;
};

test('every static card definition has a card-specific default view', () => {
  assert.equal(historyCardDefinitions.length, 5);

  for (const definition of historyCardDefinitions) {
    assert.ok(
      definition.views.includes(definition.defaultView),
      `${definition.cardType} default view must be included in its views`,
    );
  }

  assert.equal(historyCardDefinitionsByType.soil.defaultView, 'soil-profile');
  assert.equal(historyCardDefinitionsByType.dendro.defaultView, 'growth-timeline');
  assert.equal(historyCardDefinitionsByType.environment.defaultView, 'line-chart');
  assert.equal(historyCardDefinitionsByType.irrigation.defaultView, 'event-timeline');
  assert.equal(historyCardDefinitionsByType.gateway.defaultView, 'status-overview');
});

test('gateway is hub-scoped and all other MVP cards are zone-scoped', () => {
  assert.equal(historyCardDefinitionsByType.gateway.scope, 'gateway');

  for (const cardType of ['soil', 'dendro', 'environment', 'irrigation'] as const) {
    assert.equal(historyCardDefinitionsByType[cardType].scope, 'zone');
  }
});

test('advanced-only overlays are rejected outside Advanced View', () => {
  for (const definition of historyCardDefinitions) {
    for (const overlayId of historyAdvancedOverlayIds) {
      assert.equal(canUseOverlay(definition.cardType, definition.defaultView, overlayId), false);
    }

    for (const overlayId of definition.advancedOverlays) {
      assert.equal(canUseOverlay(definition.cardType, 'advanced', overlayId), true);
    }

    for (const overlayId of definition.standardOverlays) {
      assert.equal(
        historyAdvancedOverlayIds.includes(overlayId as (typeof historyAdvancedOverlayIds)[number]),
        false,
      );
    }
  }

  assert.equal(canUseOverlay('soil', 'soil-profile', 'irrigation-events'), true);
});

test('range model chooses the expected default aggregation levels', () => {
  assert.equal(defaultAggregationForRange('12h'), 'raw');
  assert.equal(defaultAggregationForRange('24h'), 'raw');
  assert.equal(defaultAggregationForRange('7d'), 'hourly');
  assert.equal(defaultAggregationForRange('30d'), 'daily');
  assert.equal(defaultAggregationForRange('season'), 'weekly');
  assert.equal(defaultAggregationForRange('custom'), 'auto');
});

test('shared constants expose downstream contract values', () => {
  assert.equal(WorkspaceSchemaVersion, 1);
  assert.deepEqual(maxPanelsByPlatform, { edge: 4, cloud: 8 });
  assert.equal(HistoryI18nKeys.cards.soil.title, 'history.cards.soil.title');
  assert.equal(HistoryI18nKeys.calendar.states.dry, 'history.calendar.states.dry');
  assert.equal(HistoryI18nKeys.interpretation.rootZoneDry, 'history.interpretation.rootZoneDry');
  assert.equal(HistoryI18nKeys.workspace.comparisonMode, 'history.workspace.comparisonMode');
});

test('representative fixture matches summary, data, workspace, freshness, and availability contracts', () => {
  assert.equal(fixture.summaries.cards.length, 2);
  assert.equal(fixture.summaries.cards[0].cardType, 'soil');
  assert.equal(fixture.summaries.cards[0].coverageConfidence, 'configured');
  assert.equal(fixture.summaries.cards[0].advancedFields[0].availability, 'collected');
  assert.equal(fixture.summaries.cards[1].scope, 'gateway');

  assert.equal(fixture.data.range.timezone, 'Europe/Zurich');
  assert.equal(fixture.data.aggregation.coverageConfidence, 'configured');
  assert.equal(fixture.data.freshness.syncState, 'local');
  assert.equal(fixture.data.calendar?.days[0].state, 'optimal');
  assert.equal(fixture.data.series[0].points[0].coverageConfidence, 'configured');
  assert.equal(fixture.data.advancedFields.rssi.availability, 'not_collected_at_time');

  assert.equal(fixture.workspace.schemaVersion, WorkspaceSchemaVersion);
  assert.equal(fixture.workspace.limits.platform, 'edge');
  assert.equal(fixture.workspace.limits.maxPanels, maxPanelsByPlatform.edge);
});
