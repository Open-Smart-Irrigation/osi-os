import React, { createContext, useContext, useState, useEffect } from 'react';
import { authAPI } from '../services/api';
import type { LoginRequest, RegisterRequest } from '../types/farming';

interface AuthContextType {
  isAuthenticated: boolean;
  token: string | null;
  username: string | null;
  login: (credentials: LoginRequest) => Promise<void>;
  register: (credentials: RegisterRequest) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for existing token on mount
    const storedToken = localStorage.getItem('auth_token');
    const storedUsername = localStorage.getItem('username');
    console.log('[Auth] Checking localStorage on mount - token:', storedToken ? storedToken.substring(0, 20) + '...' : 'null');
    if (storedToken) {
      setToken(storedToken);
      setUsername(storedUsername);
      console.log('[Auth] Restored session for user:', storedUsername);
    }
    setLoading(false);
  }, []);

  const login = async (credentials: LoginRequest) => {
    console.log('[Auth] Logging in user:', credentials.username);
    const response = await authAPI.login(credentials);
    console.log('[Auth] Login successful, received token:', response.token ? response.token.substring(0, 20) + '...' : 'null');
    localStorage.setItem('auth_token', response.token);
    localStorage.setItem('username', credentials.username);
    console.log('[Auth] Token saved to localStorage');
    setToken(response.token);
    setUsername(credentials.username);
  };

  const register = async (credentials: RegisterRequest) => {
    await authAPI.register(credentials);
  };

  const logout = () => {
    console.log('[Auth] Logging out user');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('username');
    setToken(null);
    setUsername(null);
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        token,
        username,
        login,
        register,
        logout,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
