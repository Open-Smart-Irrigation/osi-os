import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';

interface PrivateRouteProps {
  children: React.ReactNode;
}

export const PrivateRoute: React.FC<PrivateRouteProps> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  const { t } = useTranslation('common');

  if (loading) {
    return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
      <div className="text-[var(--text)] text-xl">{t('loading')}</div>
    </div>
  );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};
