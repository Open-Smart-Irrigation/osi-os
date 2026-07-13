import React from 'react';
import { HistoryRangeSegmentedControl } from 'open-smart-irrigation';

// Mobile range picker for the history detail page. Stories sweep the active
// segment across the option set and show the disabled state a card with a
// short retention window produces. Held in state so taps switch segments.

const ALL_RANGES = ['12h', '24h', '7d', '30d', 'season'] as const;

function Interactive({
  initial,
  supported = ALL_RANGES as readonly string[],
}: {
  initial: string;
  supported?: readonly string[];
}) {
  const [range, setRange] = React.useState<any>(initial);
  return (
    <div style={{ maxWidth: 400 }}>
      <HistoryRangeSegmentedControl
        activeRange={range}
        supportedRanges={supported as any}
        onRangeChange={setRange}
      />
    </div>
  );
}

export function DaySelected() {
  return <Interactive initial="24h" />;
}

export function WeekSelected() {
  return <Interactive initial="7d" />;
}

export function SeasonSelected() {
  return <Interactive initial="season" />;
}

export function ShortRetentionCard() {
  // Gateway-status cards only keep 30 days of samples — season is not
  // supported and renders disabled.
  return <Interactive initial="12h" supported={['12h', '24h', '7d', '30d']} />;
}
