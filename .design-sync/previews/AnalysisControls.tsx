import React from 'react';
import { AnalysisControls } from 'open-smart-irrigation';

// Control strip of the cross-zone analysis workspace: range presets, the
// timeline/correlation mode switch, timeline layout picker, the normalize
// toggle, and the custom date-range editor. Held in state so every segment
// actually switches.

type ControlsState = {
  rangeLabel: string;
  range?: { mode: string; label: string; from: string | null; to: string | null };
  mode: 'timeline' | 'correlation';
  layout: 'stacked' | 'overlaid' | 'small-multiples';
  normalize: boolean;
};

function Interactive({ initial }: { initial: ControlsState }) {
  const [state, setState] = React.useState<ControlsState>(initial);
  return (
    <div style={{ maxWidth: 900 }}>
      <AnalysisControls
        rangeLabel={state.rangeLabel}
        range={state.range as any}
        mode={state.mode}
        layout={state.layout}
        toggles={{ normalize: state.normalize }}
        onRangeChange={(range: any) =>
          setState((s) =>
            typeof range === 'string'
              ? { ...s, rangeLabel: range, range: undefined }
              : { ...s, rangeLabel: range.label, range },
          )
        }
        onModeChange={(mode: any) => setState((s) => ({ ...s, mode }))}
        onLayoutChange={(layout: any) => setState((s) => ({ ...s, layout }))}
        onToggle={(_key: any, value: boolean) => setState((s) => ({ ...s, normalize: value }))}
      />
    </div>
  );
}

export function TimelineStacked() {
  return (
    <Interactive
      initial={{ rangeLabel: '24h', mode: 'timeline', layout: 'stacked', normalize: false }}
    />
  );
}

export function OverlaidNormalizedWeek() {
  return (
    <Interactive
      initial={{ rangeLabel: '7d', mode: 'timeline', layout: 'overlaid', normalize: true }}
    />
  );
}

export function CorrelationMode() {
  // Correlation hides the layout picker and the normalize toggle.
  return (
    <Interactive
      initial={{ rangeLabel: '30d', mode: 'correlation', layout: 'stacked', normalize: false }}
    />
  );
}

export function CustomRangeOpen() {
  return (
    <Interactive
      initial={{
        rangeLabel: 'custom',
        range: {
          mode: 'custom',
          label: 'custom',
          from: '2026-07-05T06:00:00.000Z',
          to: '2026-07-12T18:00:00.000Z',
        },
        mode: 'timeline',
        layout: 'stacked',
        normalize: false,
      }}
    />
  );
}
