import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ScopeProvider } from './contexts/ScopeContext';
import { PrivateRoute } from './components/PrivateRoute';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { FarmingDashboard } from './pages/FarmingDashboard';
import { JournalPage } from './pages/JournalPage';
import { HistoryDashboard } from './pages/HistoryDashboard';
import { HistoryCardDetailPage } from './pages/HistoryCardDetailPage';
import { AccountLink } from './pages/AccountLink';
import { SettingsPage } from './pages/SettingsPage';
import { GatewayRestartBanner } from './components/GatewayRestartBanner';
import { AdminOnly } from './components/AdminOnly';
import { UsersPage } from './pages/admin/UsersPage';
import { GrantsPage } from './pages/admin/GrantsPage';
import { WritableOnly } from './components/WritableOnly';

const AnalysisRoute = lazy(() =>
  import('./pages/AnalysisRoute').then((module) => ({ default: module.AnalysisRoute })),
);

function App() {
  return (
    <AuthProvider>
      <ScopeProvider>
        <GatewayRestartBanner />
        <HashRouter>
          <Routes>
          {/* Public Routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Protected Routes */}
          <Route
            path="/dashboard"
            element={
              <PrivateRoute>
                <FarmingDashboard />
              </PrivateRoute>
            }
          />

          <Route
            path="/account-link"
            element={
              <PrivateRoute>
                <AccountLink />
              </PrivateRoute>
            }
          />

          <Route
            path="/support-requests"
            element={
              <PrivateRoute>
                <Navigate to="/settings" replace />
              </PrivateRoute>
            }
          />

          <Route
            path="/settings"
            element={
              <PrivateRoute>
                <WritableOnly><SettingsPage /></WritableOnly>
              </PrivateRoute>
            }
          />

          <Route path="/admin/users" element={<PrivateRoute><AdminOnly><UsersPage /></AdminOnly></PrivateRoute>} />
          <Route path="/admin/grants" element={<PrivateRoute><AdminOnly><GrantsPage /></AdminOnly></PrivateRoute>} />

          <Route
            path="/history"
            element={
              <PrivateRoute>
                <HistoryDashboard />
              </PrivateRoute>
            }
          />

          <Route
            path="/analysis"
            element={
              <PrivateRoute>
                <Suspense fallback={<div className="p-6 text-sm text-[var(--text-secondary)]">Loading analysis...</div>}>
                  <AnalysisRoute />
                </Suspense>
              </PrivateRoute>
            }
          />

          <Route
            path="/history/zones/:zoneId"
            element={
              <PrivateRoute>
                <HistoryCardDetailPage />
              </PrivateRoute>
            }
          />

          <Route
            path="/history/zones/:zoneId/cards/:cardId"
            element={
              <PrivateRoute>
                <HistoryCardDetailPage />
              </PrivateRoute>
            }
          />

          <Route
            path="/history/gateways/:gatewayEui/cards/:cardId"
            element={
              <PrivateRoute>
                <HistoryCardDetailPage />
              </PrivateRoute>
            }
          />

          {/* Default redirect */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/journal"
            element={
              <PrivateRoute>
                <JournalPage />
              </PrivateRoute>
            }
          />

          {/* Unknown routes (incl. /journal until the field-journal feature
              lands) fall back to the dashboard instead of a blank screen */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </HashRouter>
      </ScopeProvider>
    </AuthProvider>
  );
}

export default App;
