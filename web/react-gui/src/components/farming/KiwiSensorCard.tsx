import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';

interface KiwiSensorCardProps {
  device: Device;
  onRemove?: () => void;
}

export const KiwiSensorCard: React.FC<KiwiSensorCardProps> = ({ device, onRemove }) => {
  const { swt_wm1, swt_wm2, light_lux } = device.latest_data;
  const lastSeen = new Date(device.last_seen);
  const now = new Date();
  const minutesAgo = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60));
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Determine if soil is too dry (< 30 kPa)
  const isToDry = swt_wm1 !== undefined && swt_wm1 < 30;

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      if (onRemove) {
        onRemove();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove device');
      setIsRemoving(false);
    }
  };

  return (
    <div
      className={`rounded-xl p-6 border-2 shadow-lg transition-all ${
        isToDry
          ? 'bg-red-500/20 border-red-500'
          : 'bg-slate-700 border-slate-600 hover:border-farm-blue'
      }`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-white mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-slate-300 text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="bg-farm-blue text-white px-3 py-1 rounded-lg text-sm font-semibold">
            KIWI SENSOR
          </div>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
            className="bg-red-600 hover:bg-red-700 disabled:bg-slate-600 text-white px-3 py-1 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500 text-red-200 px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="bg-yellow-500/20 border-2 border-yellow-500 text-yellow-200 px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">Remove this device?</p>
          <p className="text-sm mb-3">This will unlink the device from your account.</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-red-600 hover:bg-red-700 disabled:bg-slate-600 text-white font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isRemoving ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  Removing...
                </>
              ) : (
                'Yes, Remove'
              )}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isRemoving}
              className="bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700 text-white font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isToDry && (
        <div className="bg-red-600 text-white px-4 py-3 rounded-lg mb-4 flex items-center gap-3">
          <span className="text-3xl">⚠️</span>
          <div>
            <p className="font-bold text-lg">TOO DRY!</p>
            <p className="text-sm">Soil needs watering</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {/* Soil Water Tension 1 */}
        <div className="bg-slate-800 rounded-lg p-4">
          <p className="text-slate-400 text-sm font-semibold mb-1">
            SOIL WATER TENSION 1
          </p>
          <p className="text-4xl font-bold text-white">
            {swt_wm1 !== undefined ? `${swt_wm1.toFixed(1)} kPa` : 'N/A'}
          </p>
        </div>

        {/* Soil Water Tension 2 */}
        {swt_wm2 !== undefined && (
          <div className="bg-slate-800 rounded-lg p-4">
            <p className="text-slate-400 text-sm font-semibold mb-1">
              SOIL WATER TENSION 2
            </p>
            <p className="text-4xl font-bold text-white">
              {swt_wm2.toFixed(1)} kPa
            </p>
          </div>
        )}

        {/* Light */}
        {light_lux !== undefined && (
          <div className="bg-slate-800 rounded-lg p-4">
            <p className="text-slate-400 text-sm font-semibold mb-1">
              LIGHT INTENSITY
            </p>
            <p className="text-4xl font-bold text-farm-yellow">
              {light_lux.toFixed(0)} lux
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 pt-4 border-t border-slate-600">
        <p className="text-slate-400 text-sm">
          Last seen: <span className="text-white font-semibold">{minutesAgo} minutes ago</span>
        </p>
      </div>
    </div>
  );
};
