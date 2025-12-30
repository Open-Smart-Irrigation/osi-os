import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export const Register: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { register } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    // Validate password length
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);

    try {
      await register({ username, password });
      setSuccess(true);
      setTimeout(() => {
        navigate('/login');
      }, 2000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
        <div className="max-w-md w-full bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-8 text-center">
          <div className="text-6xl mb-4">✓</div>
          <h2 className="text-3xl font-bold text-[var(--success-text)] mb-4">Success!</h2>
          <p className="text-[var(--text)] text-lg">
            Account created successfully. Redirecting to login...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="max-w-md w-full bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-[var(--text)] mb-2 high-contrast-text">
            Create Account
          </h1>
          <p className="text-[var(--text-secondary)] text-lg">Register for Open Smart irrigation</p>
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
              placeholder="Choose a username"
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
              placeholder="Choose a password"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-[var(--text)] text-lg font-semibold mb-2">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              placeholder="Re-enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-white font-bold text-xl py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
          >
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <Link
            to="/login"
            className="text-[var(--primary)] hover:text-[var(--primary-hover)] text-lg font-semibold underline"
          >
            Already have an account? Sign in
          </Link>
        </div>
      </div>
    </div>
  );
};
