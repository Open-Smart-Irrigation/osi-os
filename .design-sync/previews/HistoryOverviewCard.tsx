import React from 'react';
import { HistoryOverviewCard } from 'open-smart-irrigation';

// Mobile history overview cards — the tappable per-card tiles on
// /history/zones/:id. Fixtures mirror what the edge summary endpoint
// produces for a Pi zone with soil, dendro and irrigation sources.

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const soilCard = {
  cardId: 'soil-zone-12',
  cardType: 'soil',
  scope: 'zone',
  title: 'Soil moisture',
  subtitle: 'Soil water tension across sensor depths',
  defaultView: 'soil-profile',
  views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  defaultRange: '24h',
  sourceDeviceCount: 2,
  sourceLabels: ['Soil North', 'Soil South'],
  sourceDevices: [
    { name: 'Soil North', typeId: 'KIWI_SENSOR', role: 'soil', sourceKey: 'soil-north' },
    { name: 'Soil South', typeId: 'KIWI_SENSOR', role: 'soil', sourceKey: 'soil-south' },
  ],
  metadata: {
    lastSeenAt: minutesAgo(4),
    coveragePct: 96,
    coverageConfidence: 'configured',
    syncState: 'synced',
  },
  availability: { available: true, reasons: [] },
  ordering: { pinned: true, score: 0.92, recentRank: 1, manualOrder: null, criticalAlert: false },
} as any;

const dendroCard = {
  cardId: 'dendro-zone-12',
  cardType: 'dendro',
  scope: 'zone',
  title: 'Dendrometer',
  subtitle: 'Stem diameter growth and daily shrinkage',
  defaultView: 'growth-timeline',
  views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  defaultRange: '7d',
  sourceDeviceCount: 1,
  sourceLabels: ['Dendro 1'],
  sourceDevices: [{ name: 'Dendro 1', typeId: 'DRAGINO_LSN50', role: 'dendro', sourceKey: 'dendro-1' }],
  metadata: {
    lastSeenAt: minutesAgo(12),
    coveragePct: 88,
    coverageConfidence: 'derived',
    syncState: 'local',
  },
  availability: { available: true, reasons: [] },
  ordering: { pinned: false, score: 0.71, recentRank: 2, manualOrder: null, criticalAlert: false },
} as any;

const irrigationCard = {
  cardId: 'irrigation-zone-12',
  cardType: 'irrigation',
  scope: 'zone',
  title: 'Irrigation',
  subtitle: 'Valve events and schedule activity',
  defaultView: 'event-timeline',
  views: ['event-timeline', 'calendar', 'advanced'],
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  defaultRange: '7d',
  sourceDeviceCount: 1,
  sourceLabels: ['Valve East'],
  sourceDevices: [{ name: 'Valve East', typeId: 'STREGA_VALVE', role: 'irrigation', sourceKey: 'valve-east' }],
  metadata: {
    lastSeenAt: minutesAgo(95),
    coveragePct: null,
    coverageConfidence: 'unknown',
    syncState: 'stale',
  },
  availability: { available: true, reasons: [] },
  ordering: { pinned: false, score: 0.55, recentRank: null, manualOrder: null, criticalAlert: true },
} as any;

function Phone({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 380 }}>{children}</div>;
}

export function PinnedSoilCard() {
  return (
    <Phone>
      <HistoryOverviewCard zoneId={12} card={soilCard} onTogglePinned={() => {}} />
    </Phone>
  );
}

export function DendroCardLocalSync() {
  return (
    <Phone>
      <HistoryOverviewCard zoneId={12} card={dendroCard} onTogglePinned={() => {}} />
    </Phone>
  );
}

export function IrrigationCardWithAlert() {
  // Critical alert + stale mirror + unknown coverage; no pin handler, so the
  // pin button is absent (read-only overview embed).
  return (
    <Phone>
      <HistoryOverviewCard zoneId={12} card={irrigationCard} />
    </Phone>
  );
}
