import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  type HistoryPlatform,
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

const localeRoot = join(import.meta.dirname, '..', 'public', 'locales');

const emittedAdvancedFieldKeys = [
  'batteryPct',
  'batteryVoltage',
  'calibrationStatus',
  'firmwareVersion',
  'gatewayEui',
  'gatewayLatitude',
  'gatewayLocationStatus',
  'gatewayLongitude',
  'logicalSourceKey',
  'pendingCommands',
  'primaryDeveui',
  'rawPayload',
  'rawRowCount',
  'rssi',
  'snr',
  'sourceDeviceCount',
] as const;

const emittedInterpretationKeys = [
  'dataCoverageGap',
  'incompleteNightRecovery',
] as const;

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

test('card definitions expose canonical calendar state vocabularies', () => {
  assert.deepEqual(historyCardDefinitionsByType.soil.calendarStates, [
    'dry_stress',
    'optimal',
    'wet_excess',
    'mixed',
    'no_data',
  ]);
  assert.deepEqual(historyCardDefinitionsByType.dendro.calendarStates, [
    'normal_growth',
    'reduced_growth',
    'high_shrinkage_stress',
    'incomplete_night_recovery',
    'no_data',
  ]);
  assert.deepEqual(historyCardDefinitionsByType.environment.calendarStates, [
    'normal',
    'heat_stress',
    'cold_stress',
    'high_humidity',
    'rain_day',
    'no_data',
  ]);
  assert.deepEqual(historyCardDefinitionsByType.irrigation.calendarStates, [
    'no_irrigation',
    'irrigation_event',
    'high_irrigation_frequency',
    'possible_ineffective_irrigation',
    'manual_override',
  ]);
  assert.deepEqual(historyCardDefinitionsByType.gateway.calendarStates, [
    'normal',
    'offline',
    'no_data',
  ]);
});

test('advanced-only overlays are rejected outside Advanced View', () => {
  assert.deepEqual(historyAdvancedOverlayIds, [
    'soil-tension-dendro-shrinkage',
    'temperature-stem-growth',
    'battery-voltage-signal-strength',
    'normalized-multi-variable',
    'measured-model-prediction',
    'cross-card-anomaly',
  ]);

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
  const edgePlatform: HistoryPlatform = 'edge';
  const cloudPlatform: HistoryPlatform = 'cloud';

  assert.equal(WorkspaceSchemaVersion, 1);
  assert.deepEqual(maxPanelsByPlatform, { edge: 4, cloud: 8 });
  assert.equal(edgePlatform, 'edge');
  assert.equal(cloudPlatform, 'cloud');
  assert.equal(HistoryI18nKeys.card.soil.title, 'history.card.soil.title');
  assert.equal(HistoryI18nKeys.calendar.state.dryStress, 'history.calendar.state.dry_stress');
  assert.equal(HistoryI18nKeys.interpretation.rootZoneDry, 'history.interpretation.rootZoneDry');
  assert.equal(HistoryI18nKeys.workspace.comparisonMode, 'history.workspace.comparisonMode');
});

test('representative fixture matches summary, data, workspace, freshness, and availability contracts', () => {
  assert.deepEqual(Object.keys(fixture.summaries).sort(), [
    'cards',
    'gatewayEui',
    'generatedAt',
    'zoneId',
    'zoneUuid',
  ]);
  assert.equal(fixture.summaries.cards.length, 2);
  assert.equal(fixture.summaries.cards[0].cardType, 'soil');
  assert.equal(fixture.summaries.cards[0].metadata.coverageConfidence, 'configured');
  assert.equal(fixture.summaries.cards[0].sourceDeviceCount, 2);
  assert.deepEqual(fixture.summaries.cards[0].sourceLabels, ['Chameleon 1', 'Chameleon 2']);
  assert.equal(fixture.summaries.cards[0].sourceDevices?.[0]?.name, 'Chameleon 1');
  assert.equal('deveui' in (fixture.summaries.cards[0].sourceDevices?.[0] ?? {}), false);
  assert.equal(fixture.summaries.cards[0].ordering.manualOrder, null);
  assert.equal(fixture.summaries.cards[0].ordering.criticalAlert, false);
  assert.equal('coverageConfidence' in fixture.summaries.cards[0], false);
  assert.equal('advancedFields' in fixture.summaries.cards[0], false);
  assert.equal(fixture.summaries.cards[1].scope, 'gateway');
  assert.equal(fixture.summaries.cards[1].metadata.syncState, 'local');

  assert.equal(fixture.data.range.timezone, 'Europe/Zurich');
  assert.equal(fixture.data.aggregation.coverageConfidence, 'configured');
  assert.equal(fixture.data.freshness.syncState, 'local');
  assert.equal(fixture.data.calendar?.days[0].state, 'dry_stress');
  assert.equal(fixture.data.series[0].points[0].coverageConfidence, 'configured');
  assert.equal(fixture.data.advancedFields.rssi.availability, 'not_collected_at_time');
  assert.equal(Array.isArray(fixture.data.calendar?.days), true);
  assert.equal('states' in (fixture.data.calendar ?? {}), false);

  assert.equal(fixture.workspace.schemaVersion, WorkspaceSchemaVersion);
  assert.equal(fixture.workspace.limits.platform, 'edge');
  assert.equal(fixture.workspace.limits.maxPanels, maxPanelsByPlatform.edge);
  assert.ok(['stacked', 'single'].includes(fixture.workspace.layout));
});

test('history locale files label every emitted advanced field', () => {
  for (const locale of readdirSync(localeRoot)) {
    const history = JSON.parse(readFileSync(join(localeRoot, locale, 'history.json'), 'utf8'));
    const fields = history.history?.advanced?.field ?? {};
    for (const key of emittedAdvancedFieldKeys) {
      assert.equal(typeof fields[key], 'string', `${locale} missing history.advanced.field.${key}`);
    }
  }
});

test('history locale files label emitted interpretation states', () => {
  for (const locale of readdirSync(localeRoot)) {
    const history = JSON.parse(readFileSync(join(localeRoot, locale, 'history.json'), 'utf8'));
    const interpretations = history.history?.interpretation ?? {};
    for (const key of emittedInterpretationKeys) {
      assert.equal(
        typeof interpretations[key]?.title,
        'string',
        `${locale} missing history.interpretation.${key}.title`,
      );
      assert.equal(
        typeof interpretations[key]?.body,
        'string',
        `${locale} missing history.interpretation.${key}.body`,
      );
    }
  }
});
