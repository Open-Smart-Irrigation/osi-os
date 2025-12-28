import React, { useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';
import type { Device } from '../../types/farming';

interface AssignDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDeviceAssigned: () => void;
  zoneId: number;
  zoneName: string;
  availableDevices: Device[];
}

export const AssignDeviceModal: React.FC<AssignDeviceModalProps> = ({
  isOpen,
  onClose,
  onDeviceAssigned,
  zoneId,
  zoneName,
  availableDevices,
}) => {
  const [selectedDeveui, setSelectedDeveui] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!selectedDeveui) {
      setError('Please select a device');
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.assignDevice(zoneId, selectedDeveui);
      setSelectedDeveui('');
      onDeviceAssigned();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to assign device');
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
            Assign Device to {zoneName}
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

        {availableDevices.length === 0 ? (
          <div className="bg-yellow-500/20 border border-yellow-500 text-yellow-200 px-4 py-3 rounded-lg">
            <p className="font-bold mb-1">No unassigned devices</p>
            <p className="text-sm">
              All your devices are already assigned to zones. Add more devices or remove them from other zones first.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="device" className="block text-white text-lg font-semibold mb-2">
                Select Device
              </label>
              <select
                id="device"
                value={selectedDeveui}
                onChange={(e) => setSelectedDeveui(e.target.value)}
                required
                className="w-full px-4 py-4 touch-target bg-slate-700 border-2 border-slate-600 rounded-lg text-white text-lg focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
              >
                <option value="">-- Select a device --</option>
                {availableDevices.map((device) => (
                  <option key={device.deveui} value={device.deveui}>
                    {device.name} ({device.type_id})
                  </option>
                ))}
              </select>
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
                {loading ? 'Assigning...' : 'Assign Device'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
