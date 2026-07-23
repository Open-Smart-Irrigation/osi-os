import React from 'react';
import { Navigate } from 'react-router-dom';
import { useScope } from '../contexts/ScopeContext';

export function WritableOnly({ children }: { children: React.ReactNode }) {
  const { loading, canWrite } = useScope();

  if (loading) return null;
  if (!canWrite) return <Navigate to="/" replace />;
  return <>{children}</>;
}
