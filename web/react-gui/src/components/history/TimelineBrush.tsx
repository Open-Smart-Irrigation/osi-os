import React, { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createDefaultTimeViewport,
  panTimeViewport,
  zoomTimeViewport,
  type HistoryTimeViewport,
} from '../../history/useTimeViewport';
import type { HistoryRangeLabel } from '../../history/types';

interface TimelineBrushProps {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  ariaLabel: string;
  keyboardHelp?: string;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatRangeLabel(t: HistoryTranslate, range: HistoryRangeLabel): string {
  return t(`history.metadata.range.${range}`);
}

function formatBrushLabel(t: HistoryTranslate, viewport: HistoryTimeViewport): string {
  const from = viewport.range.from ? new Date(viewport.range.from).toLocaleString() : '';
  const to = viewport.range.to ? new Date(viewport.range.to).toLocaleString() : '';
  return from && to ? `${from} - ${to}` : formatRangeLabel(t, viewport.range.label);
}

export const TimelineBrush: React.FC<TimelineBrushProps> = ({
  viewport,
  defaultRange,
  onViewportChange,
  ariaLabel,
  keyboardHelp,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const lastTapAt = useRef<number>(0);
  const keyboardHelpId = useId();

  const reset = () => {
    onViewportChange(createDefaultTimeViewport(defaultRange, new Date(), viewport.range.timezone));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onViewportChange(panTimeViewport(viewport, event.key === 'ArrowLeft' ? 'left' : 'right'));
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      onViewportChange(zoomTimeViewport(viewport, -1));
      return;
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      onViewportChange(zoomTimeViewport(viewport, 1));
      return;
    }

    if (event.key === 'Home' || event.key === 'Enter') {
      event.preventDefault();
      reset();
    }
  };

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      aria-describedby={keyboardHelp ? keyboardHelpId : undefined}
      tabIndex={0}
      onWheel={(event) => {
        event.preventDefault();
        onViewportChange(zoomTimeViewport(viewport, event.deltaY));
      }}
      onKeyDown={handleKeyDown}
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
        <span>{formatBrushLabel(t, viewport)}</span>
        <span>{formatRangeLabel(t, viewport.range.label)}</span>
      </div>
      {keyboardHelp && (
        <p id={keyboardHelpId} className="sr-only">
          {keyboardHelp}
        </p>
      )}
    </div>
  );
};
