import assert from 'node:assert/strict';
import test from 'node:test';

import { normaliseSystemFeatureFlags } from '../src/services/api.ts';

test('normalizes documented wrapped history feature flags', () => {
  const flags = normaliseSystemFeatureFlags({
    generatedAt: '2026-05-31T12:00:00Z',
    features: {
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: '1',
      historyAdvancedOverlaysEnabled: 1,
      historyCloudAiEnabled: 'false',
    },
  });

  assert.deepEqual(flags, {
    historyUxEnabled: true,
    historyComparisonEnabled: false,
    historyWorkspacesEnabled: true,
    historyAdvancedOverlaysEnabled: true,
    historyCloudAiEnabled: false,
  });
});

test('keeps legacy top-level history feature flags compatible', () => {
  const flags = normaliseSystemFeatureFlags({
    history_ux_enabled: 1,
    history_comparison_enabled: 0,
    history_workspaces_enabled: 'true',
    history_advanced_overlays_enabled: '0',
    history_cloud_ai_enabled: false,
  });

  assert.equal(flags.historyUxEnabled, true);
  assert.equal(flags.historyComparisonEnabled, false);
  assert.equal(flags.historyWorkspacesEnabled, true);
  assert.equal(flags.historyAdvancedOverlaysEnabled, false);
  assert.equal(flags.historyCloudAiEnabled, false);
});
