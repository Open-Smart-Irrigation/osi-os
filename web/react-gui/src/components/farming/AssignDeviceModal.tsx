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
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--card)] rounded-2xl shadow-2xl border-2 border-[var(--border)] max-w-lg w-full p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-[var(--text)] high-contrast-text">
            Assign Device to {zoneName}
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

        {availableDevices.length === 0 ? (
          <div className="bg-[var(--warn-bg)] border border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg">
            <p className="font-bold mb-1">No unassigned devices</p>
            <p className="text-sm">
              All your devices are already assigned to zones. Add more devices or remove them from other zones first.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="device" className="block text-[var(--text)] text-lg font-semibold mb-2">
                Select Device
              </label>
              <select
                id="device"
                value={selectedDeveui}
                onChange={(e) => setSelectedDeveui(e.target.value)}
                required
                className="w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
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
                className="flex-1 bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-lg py-4 touch-target rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
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
