import type { ReactNode } from 'react';
import { AuthProvider } from './contexts/AuthContext';
import { ScopeProvider } from './contexts/ScopeContext';

/**
 * The application's provider composition, shared by App and by the tests
 * that exercise auth/session behaviour through the real providers.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ScopeProvider>{children}</ScopeProvider>
    </AuthProvider>
  );
}
