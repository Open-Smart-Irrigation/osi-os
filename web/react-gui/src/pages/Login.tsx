import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import osiLogo from '../assets/osi_logo.png';

export const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login({ username, password });
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="max-w-md w-full bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-8">
        <div className="text-center mb-8">
          <img src={osiLogo} alt="OSI OS Logo" className="mx-auto mb-4 h-20 w-20" />
          <h1 className="text-4xl font-bold text-[var(--text)] mb-2 high-contrast-text">
            OSI OS v0.4.0 (Alpha)
          </h1>
          <p className="text-[var(--text-secondary)] text-lg">Sign in to your account</p>
        </div>

        {error && (
          <div className="mb-6 bg-[var(--error-bg)] border-2 border-[var(--error-bg)] text-[var(--error-text)] px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="username" className="block text-[var(--text)] text-lg font-semibold mb-2">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              placeholder="Enter your username"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-[var(--text)] text-lg font-semibold mb-2">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-white font-bold text-xl py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <Link
            to="/register"
            className="text-[var(--primary)] hover:text-[var(--primary-hover)] text-lg font-semibold underline"
          >
            No account? Register here
          </Link>
        </div>
      </div>
    </div>
  );
};
