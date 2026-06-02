import React from 'react';
import { useTranslation } from 'react-i18next';
import { useVisualizationGestures } from '../../../history/useVisualizationGestures';
import type { HistoryRangeLabel, HistoryViewMode } from '../../../history/types';
import type { HistoryTimeViewport, HistoryVisualWindow } from '../../../history/useTimeViewport';

interface InspectSelection {
  timestamp: string;
}

interface HistoryVisualizationSurfaceProps {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  activeView?: HistoryViewMode;
  isZoomed?: boolean;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  onInspect?: (selection: InspectSelection) => void;
  onVisualWindow?: (window: HistoryVisualWindow) => void;
  onCardSwipe?: (delta: -1 | 1) => void;
  onViewSwipe?: (delta: -1 | 1) => void;
  onMonthSwipe?: (delta: -1 | 1) => void;
  rangeLabel?: string;
  aggregationLabel?: string;
  className?: string;
  children: React.ReactNode;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryVisualizationSurface: React.FC<HistoryVisualizationSurfaceProps> = ({
  viewport,
  defaultRange,
  activeView,
  isZoomed,
  onViewportChange,
  onInspect,
  onVisualWindow,
  onCardSwipe,
  onViewSwipe,
  onMonthSwipe,
  className = '',
  children,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const helpId = React.useId();
  const gestureProps = useVisualizationGestures({
    viewport,
    defaultRange,
    activeView,
    isZoomed,
    onViewportChange,
    onInspect,
    onVisualWindow,
    onCardSwipe,
    onViewSwipe,
    onMonthSwipe,
  });

  return (
    <div
      ref={gestureProps.ref}
      data-testid="history-visualization-surface"
      data-history-visualization-surface="true"
      role="region"
      aria-label={t('history.detail.visualizationLabel')}
      aria-describedby={helpId}
      className={`relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)] outline-none focus:ring-2 focus:ring-[var(--primary)] ${className}`}
      onDoubleClick={gestureProps.onDoubleClick}
      style={gestureProps.style}
      tabIndex={0}
    >
      <p id={helpId} className="sr-only">
        {t('history.detail.visualizationHelp')}
      </p>
      {children}
    </div>
  );
};
