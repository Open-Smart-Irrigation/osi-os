import React from 'react';
import { TimelineBrush } from 'open-smart-irrigation';

// Interactive time-viewport brush that sits under every history card. Each
// story holds the viewport in state so wheel/keyboard/double-click behave —
// the same wiring HistoryCardFrame uses. Labels mirror the app's i18n copy.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fixed anchor so the printed date range is stable across captures.
const NOW = Date.parse('2026-07-12T18:00:00Z');

type Viewport = {
  range: {
    mode: 'relative' | 'absolute';
    label: string;
    from: string;
    to: string;
    timezone: string;
  };
  aggregation: string;
};

const relativeViewport = (label: string, spanMs: number, aggregation: string): Viewport => ({
  range: {
    mode: 'relative',
    label,
    from: new Date(NOW - spanMs).toISOString(),
    to: new Date(NOW).toISOString(),
    timezone: 'Europe/Zurich',
  },
  aggregation,
});

function Interactive({ initial, defaultRange }: { initial: Viewport; defaultRange: string }) {
  const [viewport, setViewport] = React.useState<any>(initial);
  return (
    <div style={{ maxWidth: 640 }}>
      <TimelineBrush
        viewport={viewport}
        defaultRange={defaultRange as any}
        onViewportChange={setViewport}
        ariaLabel="Timeline viewport"
        keyboardHelp="Use arrow keys to pan, plus or minus to zoom, and Home or Enter to reset."
      />
    </div>
  );
}

export function WeekViewport() {
  return <Interactive initial={relativeViewport('7d', 7 * DAY, 'hourly')} defaultRange="7d" />;
}

export function DayViewport() {
  return <Interactive initial={relativeViewport('24h', DAY, 'raw')} defaultRange="24h" />;
}

export function ZoomedCustomWindow() {
  // A 36 h window the user zoomed into — label switches to "custom" and the
  // brush shows the absolute from/to timestamps.
  const initial: Viewport = {
    range: {
      mode: 'absolute',
      label: 'custom',
      from: new Date(Date.parse('2026-07-09T06:00:00Z')).toISOString(),
      to: new Date(Date.parse('2026-07-10T18:00:00Z')).toISOString(),
      timezone: 'Europe/Zurich',
    },
    aggregation: 'auto',
  };
  return <Interactive initial={initial} defaultRange="24h" />;
}
