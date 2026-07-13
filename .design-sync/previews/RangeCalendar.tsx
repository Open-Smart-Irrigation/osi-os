import React from 'react';
import { RangeCalendar } from 'open-smart-irrigation';

// Fixed "today" keeps the future-day dimming stable in screenshots.
const TODAY = '2026-07-13';

type Range = { from: string | null; to: string | null };

// Controlled component — hold real state so day clicks work in the live preview.
function Stateful({ initial }: { initial: Range }) {
  const [value, setValue] = React.useState<Range>(initial);
  return (
    <div style={{ maxWidth: 320 }}>
      <RangeCalendar value={value} onChange={setValue} todayIso={TODAY} />
    </div>
  );
}

/** A week-long export range: endpoints solid, days between shaded, future days dimmed. */
export function SelectedRange() {
  return <Stateful initial={{ from: '2026-07-06', to: '2026-07-12' }} />;
}

/** First endpoint picked, waiting for the second click. */
export function StartDatePicked() {
  return <Stateful initial={{ from: '2026-07-08', to: null }} />;
}

/** Untouched calendar: current month, nothing selected, future days disabled. */
export function NoSelection() {
  return <Stateful initial={{ from: null, to: null }} />;
}
