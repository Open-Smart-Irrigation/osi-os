import React from 'react';
import { useScope } from '../contexts/ScopeContext';

interface CanWriteProps {
  zoneUuid?: string;
  children: React.ReactNode;
}

export function CanWrite({ zoneUuid, children }: CanWriteProps) {
  const { loading, canWrite, zoneWritable } = useScope();
  if (loading || !canWrite) return null;
  // Write-only scoping (W1): this is a WRITE-scope check, not a read-visibility
  // check. zoneWritable already returns true when the flag is off.
  if (zoneUuid && !zoneWritable(zoneUuid)) return null;
  return <>{children}</>;
}
