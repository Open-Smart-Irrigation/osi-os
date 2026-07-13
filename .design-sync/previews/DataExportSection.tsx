import React from 'react';
import { DataExportSection } from 'open-smart-irrigation';

// Fixed "today" keeps the calendar's future-day dimming stable in screenshots.
const TODAY = '2026-07-13';

// The section lives inside a zone drawer panel — give it the same bordered
// surface and drawer-ish width.
function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
        maxWidth: 380,
      }}
    >
      {children}
    </div>
  );
}

/** Range chosen, Download CSV live, summary line showing the span. */
export function ReadyToDownload() {
  return (
    <PanelFrame>
      <DataExportSection
        zoneId={12}
        todayIso={TODAY}
        initialRange={{ from: '2026-07-01', to: '2026-07-12' }}
      />
    </PanelFrame>
  );
}

/** Zone with preset channels: the "Full export" opt-in checkbox appears. */
export function WithChannelPreset() {
  return (
    <PanelFrame>
      <DataExportSection
        zoneId={12}
        todayIso={TODAY}
        defaultChannels={['swt_1', 'swt_2', 'ambient_temperature']}
        initialRange={{ from: '2026-07-06', to: '2026-07-12' }}
      />
    </PanelFrame>
  );
}

/** Fresh open: no range yet, download disabled, hint text prompting a selection. */
export function NoRangeSelected() {
  return (
    <PanelFrame>
      <DataExportSection zoneId={13} todayIso={TODAY} />
    </PanelFrame>
  );
}
