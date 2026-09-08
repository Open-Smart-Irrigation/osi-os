import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { fetchScopeProfile } from '../services/api';
import type { ScopeProfile } from '../services/api';
import { useAuth } from './AuthContext';

interface ScopeValue {
  loading: boolean;
  isScoped: boolean;
  role: ScopeProfile['role'];
  canWrite: boolean;
  isAdmin: boolean;
  /**
   * Write-only scoping (W1): zone_uuids from /api/me is the caller's WRITE
   * scope. Reads are account-wide, so there is no read-visibility predicate.
   */
  zoneWritable: (zoneUuid: string) => boolean;
  profile: ScopeProfile | null;
  error: string | null;
  retry: () => void;
}

const CLOSED_SCOPE: ScopeValue = {
  loading: false,
  isScoped: false,
  role: 'viewer',
  canWrite: false,
  isAdmin: false,
  zoneWritable: () => false,
  profile: null,
  error: null,
  retry: () => {},
};

const ScopeContext = createContext<ScopeValue>(CLOSED_SCOPE);

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<ScopeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  const retry = useCallback(() => {
    setProfile(null);
    setError(null);
    setLoading(true);
    setRequestVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setProfile(null);
      setError(null);
      setLoading(false);
      return;
    }

    setProfile(null);
    setError(null);
    setLoading(true);
    const loadProfile = async () => fetchScopeProfile();
    loadProfile()
      .then((nextProfile) => {
        if (!cancelled) {
          setProfile(nextProfile);
          setError(null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null);
          setError('scope_profile_unavailable');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestVersion, token]);

  const value = useMemo<ScopeValue>(() => {
    const resolved = profile !== null && !loading && error === null;
    const isScoped = Boolean(profile?.features?.scoped_access);
    const role = profile?.role ?? 'viewer';
    const zoneUuids = profile?.zone_uuids ?? null;

    return {
      loading,
      isScoped,
      role,
      canWrite: resolved && role !== 'viewer',
      isAdmin: resolved && role === 'admin',
      zoneWritable: (zoneUuid) =>
        resolved && (!isScoped || zoneUuids === null || zoneUuids.includes(zoneUuid)),
      profile,
      error,
      retry,
    };
  }, [error, loading, profile, retry]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeValue {
  return useContext(ScopeContext);
}
