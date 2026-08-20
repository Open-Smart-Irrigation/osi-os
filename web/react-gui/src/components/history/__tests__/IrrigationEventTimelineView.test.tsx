import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IrrigationEventTimelineView } from '../visualizations/IrrigationEventTimelineView';
import type { HistoryCardDataResponse, HistoryEvent } from '../../../history/types';

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.irrigationTimeline.title': 'Irrigation event timeline',
    'history.irrigationTimeline.emptyTitle': 'No irrigation events',
    'history.irrigationTimeline.emptyBody': 'Irrigation actions and response windows will appear here when history data is available.',
    'history.irrigationTimeline.eventsCount': '{{count}} events',
    'history.irrigationTimeline.eventLabel.irrigation': 'Irrigation event',
    'history.irrigationTimeline.eventLabel.scheduled': 'Trigger-based irrigation',
    'history.irrigationTimeline.eventLabel.manualOverride': 'Manual override',
    'history.irrigationTimeline.eventLabel.possibleIneffective': 'Possible ineffective irrigation',
    'history.irrigationTimeline.eventLabel.responseWindow': 'Response window',
    'history.irrigationTimeline.eventLabel.onValveSchedule': 'Scheduled (on valve)',
    'history.irrigationTimeline.eventLabel.oneTime': 'One-time open',
    'history.irrigationTimeline.eventLabel.unexplained': 'Opened on valve',
    'history.irrigationTimeline.detail.duration': 'Duration: {{value}}',
    'history.irrigationTimeline.detail.responseWindow': 'Response window: {{value}}',
    'history.irrigationTimeline.detail.observedResponse': 'Observed response: {{value}}',
    'history.irrigationTimeline.severity.info': 'Info',
    'history.irrigationTimeline.severity.warning': 'Warning',
    'history.irrigationTimeline.severity.critical': 'Critical',
    'history.irrigationTimeline.severity.success': 'Success',
    'history.irrigationTimeline.severity.unknown': 'Info',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest }),
}));

function baseData(events: Partial<HistoryEvent>[]): HistoryCardDataResponse<'irrigation'> {
  return {
    cardId: 'zone-1:irrigation:zone-valves',
    cardType: 'irrigation',
    view: 'event-timeline',
    range: { label: '24h', from: '2026-05-30T00:00:00Z', to: '2026-05-31T00:00:00Z', timezone: 'UTC' },
    aggregation: {
      level: 'hourly',
      bucketSizeSeconds: 3600,
      coveragePct: 80,
      coverageConfidence: 'configured',
      pointCount: events.length,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    series: [],
    profiles: [],
    events: events as HistoryEvent[],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: null, syncState: 'local' },
    advancedFields: {},
  };
}

describe('IrrigationEventTimelineView trigger-based label mapping', () => {
  // The history events API does not yet deliver an actuation `trigger` field on
  // HistoryEvent (only valve_actuation_expectations.trigger / the separate
  // /api/irrigation/recent-actuations endpoint does, as IrrigationTrigger in
  // services/api.ts). This mapping reads event.metadata.trigger so the label is
  // ready the moment the history payload starts carrying it; until then it is a
  // no-op and the existing clue-based fallback governs, as verified below.
  it.each([
    ['on_valve_schedule', 'Scheduled (on valve)'],
    ['one_time', 'One-time open'],
    ['unexplained', 'Opened on valve'],
    ['trigger_based', 'Trigger-based irrigation'],
  ])('maps metadata.trigger=%s to %s', (trigger, expectedLabel) => {
    render(
      <IrrigationEventTimelineView
        data={baseData([
          {
            id: 'evt-1',
            type: 'irrigation',
            t: '2026-05-31T06:00:00Z',
            label: 'raw_unsafe_label', // contains "raw" -> not a safe explicit label
            severity: 'info',
            metadata: { trigger },
          },
        ])}
      />,
    );

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it('falls back to the existing clue-based label when trigger is absent (null-safe)', () => {
    render(
      <IrrigationEventTimelineView
        data={baseData([
          {
            id: 'evt-2',
            type: 'irrigation',
            t: '2026-05-31T06:00:00Z',
            label: 'raw_unsafe_label',
            severity: 'success',
            metadata: { source: 'manual override' },
          },
        ])}
      />,
    );

    expect(screen.getByText('Manual override')).toBeInTheDocument();
  });

  it('falls back to the existing clue-based label when trigger is an unrecognised value', () => {
    // 'cloud_command' is a real IrrigationTrigger value (services/api.ts) but has no
    // dedicated history-timeline label, so it must fall through to the pre-existing
    // clue-based heuristic rather than being swallowed by the new mapping.
    render(
      <IrrigationEventTimelineView
        data={baseData([
          {
            id: 'evt-3',
            type: 'irrigation',
            t: '2026-05-31T06:00:00Z',
            label: 'raw_unsafe_label',
            severity: 'info',
            metadata: { trigger: 'cloud_command', source: 'manual override' },
          },
        ])}
      />,
    );

    expect(screen.getByText('Manual override')).toBeInTheDocument();
  });
});
