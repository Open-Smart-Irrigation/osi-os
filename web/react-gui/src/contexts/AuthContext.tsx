import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { authAPI } from '../services/api';
import { AUTH_EXPIRED_EVENT } from '../services/authEvents';
import {
  AUTH_TOKEN_STORAGE_KEY,
  AUTH_USERNAME_STORAGE_KEY,
  AuthOperationSupersededError,
  adoptStoredAuthSession,
  beginAuthOperation,
  beginAuthSession,
  endAuthSession,
  getAuthSession,
  isLatestAuthOperation,
  sessionIdentityOf,
  subscribeAuthSession,
  type AuthSessionSnapshot,
  type SessionIdentity,
} from '../services/authSession';
import type { LoginRequest, RegisterRequest } from '../types/farming';

/** Who the session belongs to. `principalId` stays null until U02. */
export interface AuthPrincipalSnapshot {
  readonly principalId: string | null;
  readonly username: string | null;
}

interface AuthContextType {
  isAuthenticated: boolean;
  token: string | null;
  username: string | null;
  login: (credentials: LoginRequest) => Promise<void>;
  register: (credentials: RegisterRequest) => Promise<void>;
  logout: () => void;
  loading: boolean;
  /** Advances on login, logout, a session-ending 401 and any cross-tab token change. */
  sessionEpoch: number;
  principal: AuthPrincipalSnapshot;
  sessionIdentity: SessionIdentity;
  /** Pass as `authSession` on requests that are queued or sent later. */
  sessionSnapshot: AuthSessionSnapshot;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const session = useSyncExternalStore(subscribeAuthSession, getAuthSession);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    endAuthSession();
  }, []);

  useEffect(() => {
    // Storage may have changed while no provider was mounted.
    adoptStoredAuthSession({ force: false });
    setLoading(false);
  }, []);

  useEffect(() => {
    // A 401 for the current session already ended it in services/api.ts;
    // this only covers an expiry signalled while a session is still open.
    const handleAuthExpired = () => {
      if (getAuthSession().token) logout();
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    };
  }, [logout]);

  useEffect(() => {
    // Another tab logged in, logged out or cleared storage. Without an
    // immutable principal (U02) any token change is a new session.
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (event.key === null || event.key === AUTH_TOKEN_STORAGE_KEY) {
        adoptStoredAuthSession({ force: true });
      } else if (event.key === AUTH_USERNAME_STORAGE_KEY) {
        adoptStoredAuthSession({ force: false });
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const login = useCallback(async (credentials: LoginRequest) => {
    const operation = beginAuthOperation();
    const response = await authAPI.login(credentials);
    if (!isLatestAuthOperation(operation)) throw new AuthOperationSupersededError();
    beginAuthSession(response.token, credentials.username);
  }, []);

  const register = useCallback(async (credentials: RegisterRequest) => {
    await authAPI.register(credentials);
  }, []);

  const value = useMemo<AuthContextType>(() => ({
    isAuthenticated: !!session.token,
    token: session.token,
    username: session.username,
    login,
    register,
    logout,
    loading,
    sessionEpoch: session.sessionEpoch,
    principal: { principalId: session.principalId, username: session.username },
    sessionIdentity: sessionIdentityOf(session),
    sessionSnapshot: session,
  }), [loading, login, logout, register, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
