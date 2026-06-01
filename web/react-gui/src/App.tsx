import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { PrivateRoute } from './components/PrivateRoute';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { FarmingDashboard } from './pages/FarmingDashboard';
import { HistoryDashboard } from './pages/HistoryDashboard';
import { HistoryCardDetailPage } from './pages/HistoryCardDetailPage';
import { AccountLink } from './pages/AccountLink';

function App() {
  return (
    <AuthProvider>
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
            path="/history"
            element={
              <PrivateRoute>
                <HistoryDashboard />
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
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
