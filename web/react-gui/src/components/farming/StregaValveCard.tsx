import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';

interface StregaValveCardProps {
  device: Device;
  onUpdate: () => void;
  onRemove?: () => void;
}

export const StregaValveCard: React.FC<StregaValveCardProps> = ({ device, onUpdate, onRemove }) => {
  const [loading, setLoading] = useState<'OPEN' | 'CLOSE' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const lastSeen = new Date(device.last_seen);
  const now = new Date();
  const minutesAgo = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60));

  const isOpen = device.current_state === 'OPEN';

  const handleAction = async (action: 'OPEN' | 'CLOSE') => {
    setLoading(action);
    setError(null);
    try {
      await devicesAPI.controlValve(device.deveui, { action });
      onUpdate(); // Refresh devices list
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action.toLowerCase()} valve`);
    } finally {
      setLoading(null);
    }
  };

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
    <div className="bg-slate-700 border-2 border-slate-600 hover:border-farm-green rounded-xl p-6 shadow-lg transition-all">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-white mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-slate-300 text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="bg-farm-green text-white px-3 py-1 rounded-lg text-sm font-semibold">
            STREGA VALVE
          </div>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving || loading !== null}
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

      {/* Status Display */}
      <div className="bg-slate-800 rounded-lg p-6 mb-6">
        <p className="text-slate-400 text-sm font-semibold mb-3">STATUS</p>
        <div className="flex items-center gap-3">
          <div
            className={`w-6 h-6 rounded-full ${
              isOpen ? 'bg-farm-green animate-pulse' : 'bg-slate-500'
            }`}
          />
          <p className={`text-3xl font-bold ${isOpen ? 'text-farm-green' : 'text-slate-400'}`}>
            {isOpen ? 'OPEN' : 'CLOSED'}
          </p>
        </div>
        {device.target_state && device.target_state !== device.current_state && (
          <p className="text-farm-yellow text-sm mt-2">
            Target: {device.target_state}
          </p>
        )}
      </div>

      {/* Control Buttons */}
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => handleAction('OPEN')}
          disabled={loading !== null}
          className="bg-farm-green hover:bg-green-600 disabled:bg-slate-600 text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading === 'OPEN' ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              Opening...
            </>
          ) : (
            'OPEN'
          )}
        </button>
        <button
          onClick={() => handleAction('CLOSE')}
          disabled={loading !== null}
          className="bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700 text-white font-bold text-lg py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading === 'CLOSE' ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              Closing...
            </>
          ) : (
            'CLOSE'
          )}
        </button>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-600">
        <p className="text-slate-400 text-sm">
          Last seen: <span className="text-white font-semibold">{minutesAgo} minutes ago</span>
        </p>
      </div>
    </div>
  );
};
