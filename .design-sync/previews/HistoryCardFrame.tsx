import React from 'react';
import { HistoryCardFrame } from 'open-smart-irrigation';

// Desktop history card frame: header with type/coverage/sync badges, view-mode
// buttons, timeline brush, and the selected visualization. The frame fetches
// /api/history/zones/:id/cards/:cardId/data itself, so we answer with a
// shape-complete HistoryCardDataResponse (profiles + calendar populated).

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// The calendar view fades any day after "today", and the capture harness may
// freeze the clock — so derive the month from new Date() instead of pinning
// one. The month containing (now - 15 days) is always fully in the past.
function calendarDays() {
  const anchor = new Date(Date.now() - 15 * 86_400_000);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const dayCount = new Date(year, month + 1, 0).getDate();
  const iso = (d: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // dry spell relieved by irrigation, one rainy stretch, one sensor outage
  const pattern = ['optimal', 'optimal', 'dry_stress', 'dry_stress', 'optimal', 'wet_excess', 'optimal'];
  const days = [] as Array<Record<string, unknown>>;
  for (let d = 1; d <= dayCount; d += 1) {
    const state = d === 9 ? 'no_data' : pattern[d % pattern.length];
    const markers: Array<Record<string, unknown>> = [];
    if (state === 'dry_stress' && d % 4 === 0) {
      markers.push({ type: 'irrigation', severity: 'info', labelKey: 'history.calendar.marker.irrigation.irrigation_event' });
    }
    if (state === 'wet_excess') {
      markers.push({ type: 'rain', severity: 'info', labelKey: 'history.calendar.marker.rain' });
    }
    if (state === 'no_data') {
      markers.push({ type: 'sensor_gap', severity: 'warning', labelKey: 'history.calendar.marker.sensor_gap' });
    }
    days.push({
      date: iso(d),
      state,
      coveragePct: state === 'no_data' ? 12 : 98 - (d % 5),
      coverageConfidence: state === 'no_data' ? 'derived' : 'configured',
      metrics: { sampleCount: state === 'no_data' ? 11 : 96 - (d % 5) },
      markers,
    });
  }
  return days;
}

const soilCardData = () => ({
  cardId: 'soil-zone-12',
  cardType: 'soil',
  view: 'soil-profile',
  range: {
    label: '24h',
    from: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    to: new Date().toISOString(),
    timezone: 'Europe/Zurich',
  },
  aggregation: {
    level: 'raw',
    bucketSizeSeconds: null,
    coveragePct: 96,
    coverageConfidence: 'configured',
    pointCount: 96,
    source: null,
    dominantStatusMethod: null,
  },
  limits: { maxPointsPerSeries: 2000, maxEvents: 200, maxInterpretations: 20, truncated: false },
  series: [],
  profiles: [
    { id: 'profile-15', label: 'Soil North', depthCm: 15, value: 22.4, unit: 'kPa', status: 'optimal' },
    { id: 'profile-30', label: 'Soil North', depthCm: 30, value: 18.9, unit: 'kPa', status: 'optimal' },
    { id: 'profile-60', label: 'Soil South', depthCm: 60, value: 34.2, unit: 'kPa', status: 'dry_stress' },
  ],
  events: [],
  calendar: {
    timezone: 'Europe/Zurich',
    days: calendarDays(),
  },
  interpretations: [],
  freshness: { dataAsOf: minutesAgo(4), syncState: 'synced' },
  advancedFields: {},
});

(window as any).__dsApiRoutes ??= [];
(window as any).__dsApiRoutes.push([
  /^\/api\/history\/zones\/\d+\/cards\/soil-zone-12\/data$/,
  () => soilCardData(),
]);

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

const unavailableDendroCard = {
  cardId: 'dendro-zone-13',
  cardType: 'dendro',
  scope: 'zone',
  title: 'Dendrometer',
  subtitle: 'Stem diameter growth and daily shrinkage',
  defaultView: 'growth-timeline',
  views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
  supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
  defaultRange: '7d',
  sourceDeviceCount: 0,
  sourceLabels: [],
  sourceDevices: [],
  metadata: { lastSeenAt: null, coveragePct: null, coverageConfidence: 'unknown', syncState: 'unknown' },
  availability: { available: false, reasons: ['zone-has-dendro-source'] },
  ordering: { pinned: false, score: 0.1, recentRank: null, manualOrder: null, criticalAlert: false },
} as any;

const zoneScope = { type: 'zone', zoneId: 12 } as any;

export function SoilCardProfileView() {
  return (
    <div style={{ maxWidth: 900 }}>
      <HistoryCardFrame card={soilCard} scope={zoneScope} />
    </div>
  );
}

export function SoilCardCalendarView() {
  return (
    <div style={{ maxWidth: 900 }}>
      <HistoryCardFrame
        card={soilCard}
        scope={zoneScope}
        selectedView={'calendar' as any}
        onViewModeChange={() => {}}
      />
    </div>
  );
}

export function UnavailableDendroCard() {
  // Zone has no dendrometer source: warning banner, no data fetch, and the
  // default view falls back to its placeholder body.
  return (
    <div style={{ maxWidth: 900 }}>
      <HistoryCardFrame card={unavailableDendroCard} scope={{ type: 'zone', zoneId: 13 } as any} />
    </div>
  );
}

export function EmptyFrame() {
  // No card selected in the workspace yet.
  return (
    <div style={{ maxWidth: 900 }}>
      <HistoryCardFrame card={null} scope={null} />
    </div>
  );
}
