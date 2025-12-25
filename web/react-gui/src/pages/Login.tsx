import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 px-4">
      <div className="max-w-md w-full bg-slate-800 rounded-2xl shadow-2xl border border-slate-700 p-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2 high-contrast-text">
            Open Smart irrigation
          </h1>
          <p className="text-slate-300 text-lg">Sign in to your account</p>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/20 border-2 border-red-500 text-red-200 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="username" className="block text-white text-lg font-semibold mb-2">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
              placeholder="Enter your username"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-white text-lg font-semibold mb-2">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-farm-green hover:bg-green-600 disabled:bg-slate-600 text-white font-bold text-xl py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed"
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <Link
            to="/register"
            className="text-farm-green hover:text-green-400 text-lg font-semibold underline"
          >
            No account? Register here
          </Link>
        </div>
      </div>
    </div>
  );
};
