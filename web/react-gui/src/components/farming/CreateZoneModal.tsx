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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl shadow-2xl border-2 border-slate-700 max-w-lg w-full p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-white high-contrast-text">
            Create Irrigation Zone
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-3xl leading-none"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/20 border border-red-500 text-red-200 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="zone-name" className="block text-white text-lg font-semibold mb-2">
              Zone Name
            </label>
            <input
              id="zone-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., Garden A, North Field, Orchard 1"
              className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
            />
          </div>

          <div className="flex gap-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-600 hover:bg-slate-500 text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-farm-green hover:bg-green-600 disabled:bg-slate-600 text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed"
            >
              {loading ? 'Creating...' : 'Create Zone'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
