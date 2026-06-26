import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';

const CrossZoneAnalysisPage = lazy(() =>
  import('./CrossZoneAnalysisPage').then((module) => ({ default: module.CrossZoneAnalysisPage })),
);

export function AnalysisRoute() {
  if (!isDesktopBrowser()) {
    return <Navigate to="/history" replace />;
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--text-secondary)]">Loading analysis...</div>}>
      <CrossZoneAnalysisPage />
    </Suspense>
  );
}
