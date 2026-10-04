import { createContext, useContext, type ReactNode } from 'react';
import { SWRConfig, type SWRConfiguration } from 'swr';
import {
  serializeSessionIdentity,
  type AuthSessionSnapshot,
  type SessionBoundRequest,
} from '../services/authSession';
import { useAuth } from './AuthContext';

// SWRConfig calls `provider` once per mount, so every keyed remount below
// starts with its own empty Map.
const SESSION_SWR_CONFIG: SWRConfiguration = { provider: () => new Map() };

const SessionRequestContext = createContext<AuthSessionSnapshot | null>(null);

function SessionEpochScope({
  snapshot,
  children,
}: {
  snapshot: AuthSessionSnapshot;
  children: ReactNode;
}) {
  return (
    <SessionRequestContext.Provider value={snapshot}>
      <SWRConfig value={SESSION_SWR_CONFIG}>{children}</SWRConfig>
    </SessionRequestContext.Provider>
  );
}

/**
 * Private client data is owned by one authentication epoch (#378).
 *
 * The subtree is keyed by the session identity, so a login, logout, 401 or
 * cross-tab token change unmounts every descendant of the previous epoch and
 * mounts a fresh tree with a new SWR cache. A response for the old epoch can
 * only settle into the old, unreachable cache or into unmounted state.
 * Everything that calls SWR must render inside this boundary and use the
 * scoped `useSWRConfig().mutate`, never SWR's process-global `mutate`.
 */
export function AuthSessionDataBoundary({ children }: { children: ReactNode }) {
  const { sessionIdentity, sessionSnapshot } = useAuth();
  return (
    <SessionEpochScope key={serializeSessionIdentity(sessionIdentity)} snapshot={sessionSnapshot}>
      {children}
    </SessionEpochScope>
  );
}

/**
 * The session the calling component was mounted for, or null outside a
 * boundary. Pass it to requests that are queued or sent after an await so
 * they are refused instead of going out under a later session.
 */
export function useSessionRequestSnapshot(): AuthSessionSnapshot | null {
  return useContext(SessionRequestContext);
}

/** Axios config fragment binding a request to the caller's session. */
export function sessionBoundRequest(snapshot: AuthSessionSnapshot | null): SessionBoundRequest | undefined {
  return snapshot ? { authSession: snapshot } : undefined;
}
