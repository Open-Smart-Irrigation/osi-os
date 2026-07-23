import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchScopeProfile } from '../services/api';
import type { ScopeProfile } from '../services/api';
import { useAuth } from './AuthContext';

interface ScopeValue {
  loading: boolean;
  isScoped: boolean;
  role: ScopeProfile['role'];
  canWrite: boolean;
  isAdmin: boolean;
  isZoneVisible: (zoneUuid: string) => boolean;
  isPlotVisible: (plotUuid: string) => boolean;
  profile: ScopeProfile | null;
}

const ScopeContext = createContext<ScopeValue | null>(null);

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<ScopeProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchScopeProfile()
      .then((nextProfile) => {
        if (!cancelled) {
          setProfile(nextProfile);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const value = useMemo<ScopeValue>(() => {
    const isScoped = Boolean(profile?.features?.scoped_access);
    const role = profile?.role ?? 'admin';
    const zoneUuids = profile?.zone_uuids ?? null;
    const plotUuids = profile?.plot_uuids ?? null;

    return {
      loading,
      isScoped,
      role,
      canWrite: role !== 'viewer',
      isAdmin: role === 'admin',
      isZoneVisible: (zoneUuid) =>
        !isScoped || zoneUuids === null || zoneUuids.includes(zoneUuid),
      isPlotVisible: (plotUuid) =>
        !isScoped || plotUuids === null || plotUuids.includes(plotUuid),
      profile,
    };
  }, [loading, profile]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext);
  if (!value) {
    throw new Error('useScope outside ScopeProvider');
  }
  return value;
}
