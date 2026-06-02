import React from 'react';
import { useTranslation } from 'react-i18next';
import { useVisualizationGestures } from '../../../history/useVisualizationGestures';
import type { HistoryRangeLabel } from '../../../history/types';
import type { HistoryTimeViewport } from '../../../history/useTimeViewport';

interface InspectSelection {
  timestamp: string;
}

interface HistoryVisualizationSurfaceProps {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  onInspect?: (selection: InspectSelection) => void;
  rangeLabel?: string;
  aggregationLabel?: string;
  className?: string;
  children: React.ReactNode;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryVisualizationSurface: React.FC<HistoryVisualizationSurfaceProps> = ({
  viewport,
  defaultRange,
  onViewportChange,
  onInspect,
  className = '',
  children,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const helpId = React.useId();
  const gestureProps = useVisualizationGestures({
    viewport,
    defaultRange,
    onViewportChange,
    onInspect,
  });

  return (
    <div
      data-testid="history-visualization-surface"
      data-history-visualization-surface="true"
      role="region"
      aria-label={t('history.detail.visualizationLabel')}
      aria-describedby={helpId}
      className={`min-h-[18rem] rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 outline-none focus:ring-2 focus:ring-[var(--primary)] ${className}`}
      onPointerDown={gestureProps.onPointerDown}
      onPointerMove={gestureProps.onPointerMove}
      onPointerUp={gestureProps.onPointerUp}
      onPointerCancel={gestureProps.onPointerCancel}
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
