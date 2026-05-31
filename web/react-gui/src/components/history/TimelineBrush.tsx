import React, { useRef } from 'react';
import { createDefaultTimeViewport, zoomTimeViewport, type HistoryTimeViewport } from '../../history/useTimeViewport';
import type { HistoryRangeLabel } from '../../history/types';

interface TimelineBrushProps {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  ariaLabel: string;
}

function formatBrushLabel(viewport: HistoryTimeViewport): string {
  const from = viewport.range.from ? new Date(viewport.range.from).toLocaleString() : '';
  const to = viewport.range.to ? new Date(viewport.range.to).toLocaleString() : '';
  return from && to ? `${from} - ${to}` : viewport.range.label;
}

export const TimelineBrush: React.FC<TimelineBrushProps> = ({
  viewport,
  defaultRange,
  onViewportChange,
  ariaLabel,
}) => {
  const lastTapAt = useRef<number>(0);

  const reset = () => {
    onViewportChange(createDefaultTimeViewport(defaultRange, new Date(), viewport.range.timezone));
  };

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      onWheel={(event) => {
        event.preventDefault();
        onViewportChange(zoomTimeViewport(viewport, event.deltaY));
      }}
      onDoubleClick={reset}
      onTouchEnd={() => {
        const now = Date.now();
        if (now - lastTapAt.current <= 300) {
          reset();
        }
        lastTapAt.current = now;
      }}
      className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 outline-none focus:ring-2 focus:ring-[var(--primary)]"
    >
      <div className="h-2 overflow-hidden rounded-full bg-[var(--border)]">
        <div className="h-full w-2/3 rounded-full bg-[var(--primary)]" />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--text-tertiary)]">
        <span>{formatBrushLabel(viewport)}</span>
        <span>{viewport.range.label}</span>
      </div>
    </div>
  );
};
