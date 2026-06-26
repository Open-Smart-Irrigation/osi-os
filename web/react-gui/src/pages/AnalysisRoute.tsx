import { Navigate } from 'react-router-dom';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';
import { CrossZoneAnalysisPage } from './CrossZoneAnalysisPage';

export function AnalysisRoute() {
  if (!isDesktopBrowser()) {
    return <Navigate to="/history" replace />;
  }

  return <CrossZoneAnalysisPage />;
}
