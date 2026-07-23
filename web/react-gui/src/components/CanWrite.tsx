import React from 'react';
import { useScope } from '../contexts/ScopeContext';

interface CanWriteProps {
  zoneUuid?: string;
  children: React.ReactNode;
}

export function CanWrite({ zoneUuid, children }: CanWriteProps) {
  const { loading, canWrite, isZoneVisible, isScoped } = useScope();
  if (loading || !canWrite) return null;
  if (isScoped && zoneUuid && !isZoneVisible(zoneUuid)) return null;
  return <>{children}</>;
}
