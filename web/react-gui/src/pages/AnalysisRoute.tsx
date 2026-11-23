import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { EXPANDED_DATA_VIEWS_ENABLED } from '../history/expandedDataViews';
import { useDesktopData } from '../history/useDesktopData';

const CrossZoneAnalysisPage = lazy(() =>
  import('./CrossZoneAnalysisPage').then((module) => ({ default: module.CrossZoneAnalysisPage })),
);

export function AnalysisRoute() {
  if (!useDesktopData()) {
    return <Navigate to="/history" replace />;
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--text-secondary)]">Loading analysis...</div>}>
      <CrossZoneAnalysisPage expandedViewsEnabled={EXPANDED_DATA_VIEWS_ENABLED} />
    </Suspense>
  );
}
