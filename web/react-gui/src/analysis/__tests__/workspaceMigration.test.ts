// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  analysisSeriesIdFromParts,
  loadWorkspace,
  migrateWorkspaceSeriesIds,
  saveWorkspace,
} from '../analysisWorkspaceStorage';
import { createDefaultWorkspace, toViewJson, type AnalysisWorkspaceState } from '../workspaceModel';
import type { AnalysisCatalogEntry, AnalysisViewJson } from '../types';

const STORAGE_KEY = 'osi.analysis.workspace.v1';
const AMBIENT_TEMPERATURE_SERIES_ID = 'cc81c4a1a6b64701';
const LEGACY_TEMPERATURE_SERIES_ID = 'fd2788f352c12785';
const SWT_WM1_LEGACY_SERIES_ID = '7bfe1748241382a0';
const SWT_1_CANONICAL_SERIES_ID = '3904384b9657fb21';

function catalogEntry(overrides: Partial<AnalysisCatalogEntry> = {}): AnalysisCatalogEntry {
  const zoneId = overrides.zoneId ?? 7;
  const cardType = overrides.cardType ?? 'environment';
  const sourceKey = overrides.sourceKey ?? 'microclimate';
  const channelKey = overrides.channelKey ?? 'ambient_temperature';
  return {
    seriesId: overrides.seriesId ?? analysisSeriesIdFromParts(zoneId, cardType, sourceKey, channelKey),
    hubEui: null,
    zoneId,
    zoneName: overrides.zoneName ?? 'North',
    cardType,
    sourceKey,
    channelKey,
    displayName: overrides.displayName ?? 'Ambient temperature',
    unit: overrides.unit ?? 'C',
    availability: overrides.availability ?? 'available',
    deviceName: null,
    depthCm: null,
  };
}

beforeEach(() => localStorage.clear());

describe('analysisSeriesIdFromParts', () => {
  it('matches the backend sha-256 series id formula', () => {
    expect(analysisSeriesIdFromParts(7, 'environment', 'microclimate', 'ambient_temperature')).toBe(AMBIENT_TEMPERATURE_SERIES_ID);
    expect(analysisSeriesIdFromParts(12, 'soil', 'root-zone', 'swt_wm1')).toBe(SWT_WM1_LEGACY_SERIES_ID);
  });
});

describe('migrateWorkspaceSeriesIds', () => {
  it('migrates legacy selector ids and matching label override keys to canonical series ids', () => {
    const canonical = catalogEntry();
    const workspace: AnalysisWorkspaceState = {
      ...createDefaultWorkspace(),
      selectors: [{ seriesId: LEGACY_TEMPERATURE_SERIES_ID }],
      labelOverrides: { [LEGACY_TEMPERATURE_SERIES_ID]: 'Greenhouse air' },
    };

    const migrated = migrateWorkspaceSeriesIds(workspace, [canonical]);

    expect(migrated).not.toBe(workspace);
    expect(migrated.selectors).toEqual([{ seriesId: canonical.seriesId }]);
    expect(migrated.labelOverrides).toEqual({ [canonical.seriesId]: 'Greenhouse air' });
  });

  it('migrates selectors for workspaces loaded without labelOverrides without creating bogus overrides', () => {
    const canonical = catalogEntry({
      zoneId: 12,
      cardType: 'soil',
      sourceKey: 'root-zone',
      channelKey: 'swt_1',
      seriesId: SWT_1_CANONICAL_SERIES_ID,
      displayName: 'SWT 1',
      unit: 'kPa',
    });
    const stored: AnalysisViewJson = {
      schemaVersion: 1,
      selectors: [{ seriesId: SWT_WM1_LEGACY_SERIES_ID }],
      range: { mode: 'relative', label: '7d', from: null, to: null },
      mode: 'timeline',
      layout: 'stacked',
      toggles: { normalize: false },
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const loaded = loadWorkspace();
    expect(loaded).not.toBeNull();

    const migrated = migrateWorkspaceSeriesIds(loaded!, [canonical]);

    expect(migrated.selectors).toEqual([{ seriesId: canonical.seriesId }]);
    expect(migrated.labelOverrides).toEqual({});
  });

  it('saves migrated canonical selectors and label override keys back to localStorage', () => {
    const canonical = catalogEntry();
    const workspace: AnalysisWorkspaceState = {
      ...createDefaultWorkspace(),
      selectors: [{ seriesId: LEGACY_TEMPERATURE_SERIES_ID }],
      labelOverrides: { [LEGACY_TEMPERATURE_SERIES_ID]: 'Greenhouse air' },
    };

    saveWorkspace(migrateWorkspaceSeriesIds(workspace, [canonical]));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      ...toViewJson(createDefaultWorkspace()),
      selectors: [{ seriesId: canonical.seriesId }],
      labelOverrides: { [canonical.seriesId]: 'Greenhouse air' },
    });
  });

  it('deduplicates selectors when legacy and canonical ids resolve to the same series', () => {
    const canonical = catalogEntry();
    const workspace: AnalysisWorkspaceState = {
      ...createDefaultWorkspace(),
      selectors: [{ seriesId: LEGACY_TEMPERATURE_SERIES_ID }, { seriesId: canonical.seriesId }],
      labelOverrides: {},
    };

    const migrated = migrateWorkspaceSeriesIds(workspace, [canonical]);

    expect(migrated.selectors).toEqual([{ seriesId: canonical.seriesId }]);
  });

  it('keeps an existing canonical label override when a legacy override collides into the same series', () => {
    const canonical = catalogEntry();
    const workspace: AnalysisWorkspaceState = {
      ...createDefaultWorkspace(),
      selectors: [{ seriesId: LEGACY_TEMPERATURE_SERIES_ID }],
      labelOverrides: {
        [canonical.seriesId]: 'Canonical label',
        [LEGACY_TEMPERATURE_SERIES_ID]: 'Legacy label',
      },
    };

    const migrated = migrateWorkspaceSeriesIds(workspace, [canonical]);

    expect(migrated.labelOverrides).toEqual({ [canonical.seriesId]: 'Canonical label' });
  });
});
