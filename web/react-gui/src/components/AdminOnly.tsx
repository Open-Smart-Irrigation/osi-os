import React from 'react';
import { Navigate } from 'react-router-dom';
import { useScope } from '../contexts/ScopeContext';

export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { loading, isAdmin } = useScope();

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
