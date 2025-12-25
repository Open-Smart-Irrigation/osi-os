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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-2xl shadow-2xl border-2 border-slate-700 max-w-lg w-full p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-white high-contrast-text">Add Device</h2>
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
          {/* Device Type */}
          <div>
            <label className="block text-white text-lg font-semibold mb-2">
              Device Type
            </label>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as DeviceType)}
              className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
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
            <label htmlFor="name" className="block text-white text-lg font-semibold mb-2">
              Device Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g., North Field, Main Valve"
              className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
            />
          </div>

          {/* DevEUI */}
          <div>
            <label htmlFor="deveui" className="block text-white text-lg font-semibold mb-2">
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
              className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg font-mono focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
            />
            <p className="text-slate-400 text-sm mt-1">
              Enter exactly 16 hexadecimal characters (0-9, A-F)
            </p>
          </div>

          {/* Buttons */}
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
              {loading ? 'Adding...' : 'Add Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
