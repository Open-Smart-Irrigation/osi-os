import type { ReactNode } from 'react';
import { HashRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { AuthSessionDataBoundary } from './contexts/AuthSessionDataBoundary';
import { ScopeProvider } from './contexts/ScopeContext';

/**
 * The application's provider composition, shared by App and by the tests
 * that exercise auth/session behaviour through the real providers.
 *
 * The router sits outside the session boundary: it holds no private data,
 * and a navigation started by a component of the ending session (the login
 * page after a successful sign-in) must reach the router that stays mounted.
 * Everything that can hold private data — the scope profile, banners, every
 * route and every SWR hook — renders inside AuthSessionDataBoundary.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <HashRouter>
        <AuthSessionDataBoundary>
          <ScopeProvider>{children}</ScopeProvider>
        </AuthSessionDataBoundary>
      </HashRouter>
    </AuthProvider>
  );
}
