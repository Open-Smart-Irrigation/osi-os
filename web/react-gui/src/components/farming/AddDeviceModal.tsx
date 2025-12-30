import React, { useState, useEffect } from 'react';
import type { DeviceType, DeviceCatalogItem } from '../../types/farming';
import { devicesAPI } from '../../services/api';

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDeviceAdded: () => void;
}

export const AddDeviceModal: React.FC<AddDeviceModalProps> = ({
  isOpen,
  onClose,
  onDeviceAdded,
}) => {
  const [catalog, setCatalog] = useState<DeviceCatalogItem[]>([]);
  const [selectedType, setSelectedType] = useState<DeviceType>('KIWI_SENSOR');
  const [name, setName] = useState('');
  const [deveui, setDeveui] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadCatalog();
    }
  }, [isOpen]);

  const loadCatalog = async () => {
    try {
      const data = await devicesAPI.getCatalog();
      setCatalog(data);
      if (data.length > 0) {
        setSelectedType(data[0].id);
      }
    } catch (err) {
      console.error('Failed to load catalog:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate DevEUI (16 hex characters)
    const deveuiRegex = /^[0-9A-Fa-f]{16}$/;
    if (!deveuiRegex.test(deveui)) {
      setError('DevEUI must be exactly 16 hexadecimal characters');
      return;
    }

    setLoading(true);
    try {
      await devicesAPI.add({
        deveui,
        name,
        type_id: selectedType,
      });
      // Reset form
      setName('');
      setDeveui('');
      onDeviceAdded();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to add device');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--card)] rounded-2xl shadow-2xl border-2 border-[var(--border)] max-w-lg w-full p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-[var(--text)] high-contrast-text">Add Device</h2>
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
          {/* Device Type */}
          <div>
            <label className="block text-[var(--text)] text-lg font-semibold mb-2">
              Device Type
            </label>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as DeviceType)}
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
            >
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label htmlFor="name" className="block text-[var(--text)] text-lg font-semibold mb-2">
              Device Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., North Field, Main Valve"
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
            />
          </div>

          {/* DevEUI */}
          <div>
            <label htmlFor="deveui" className="block text-[var(--text)] text-lg font-semibold mb-2">
              DevEUI
            </label>
            <input
              id="deveui"
              type="text"
              value={deveui}
              onChange={(e) => setDeveui(e.target.value.toUpperCase())}
              required
              maxLength={16}
              placeholder="16 hex characters"
              className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg font-mono placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
            />
            <p className="text-[var(--text-tertiary)] text-sm mt-1">
              Enter exactly 16 hexadecimal characters (0-9, A-F)
            </p>
          </div>

          {/* Buttons */}
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
              {loading ? 'Adding...' : 'Add Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
