import React, { useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';

interface CreateZoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onZoneCreated: () => void;
}

export const CreateZoneModal: React.FC<CreateZoneModalProps> = ({
  isOpen,
  onClose,
  onZoneCreated,
}) => {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Zone name is required');
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.create({ name: name.trim() });
      setName('');
      onZoneCreated();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create zone');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--card)] rounded-2xl shadow-2xl border-2 border-[var(--border)] max-w-lg w-full p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-[var(--text)] high-contrast-text">
            Create Irrigation Zone
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text)] text-3xl leading-none"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="zone-name" className="block text-[var(--text)] text-lg font-semibold mb-2">
              Zone Name
            </label>
            <input
              id="zone-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., Garden A, North Field, Orchard 1"
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
            />
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-lg py-4 touch-target rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {loading ? 'Creating...' : 'Create Zone'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
