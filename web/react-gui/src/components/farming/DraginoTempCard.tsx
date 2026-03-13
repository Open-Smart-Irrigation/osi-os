import React, { useState } from 'react';
import type { Device } from '../../types/farming';
import { devicesAPI } from '../../services/api';

interface DraginoTempCardProps {
  device: Device;
  onRemove?: () => void;
}

export const DraginoTempCard: React.FC<DraginoTempCardProps> = ({ device, onRemove }) => {
  const { ext_temperature_c, bat_v, adc_ch0v } = device.latest_data;
  const lastSeen = new Date(device.last_seen);
  const minutesAgo = Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60));
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    setIsRemoving(true);
    setError(null);
    try {
      await devicesAPI.remove(device.deveui);
      if (onRemove) onRemove();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove device');
      setIsRemoving(false);
    }
  };

  // Battery level indicator colour
  const batColour =
    bat_v === undefined ? 'var(--text-tertiary)' :
    bat_v >= 3.2 ? '#22c55e' :
    bat_v >= 2.9 ? '#f59e0b' :
    '#ef4444';

  return (
    <div className="rounded-xl p-6 border-2 shadow-lg transition-all bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">{device.deveui}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="bg-[var(--primary)] text-white px-3 py-1 rounded-lg text-sm font-semibold">
            LSN50
          </div>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={isRemoving}
            className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] px-3 py-1 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            title="Remove device"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">Remove this device?</p>
          <p className="text-sm mb-3">This will unlink the device from your account.</p>
          <div className="flex gap-2">
            <button
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
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
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {/* Temperature */}
        <div className="bg-[var(--card)] rounded-lg p-4">
          <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">TEMPERATURE (DS18B20)</p>
          <p className="text-4xl font-bold text-[var(--text)]">
            {ext_temperature_c !== undefined && ext_temperature_c !== null
              ? `${ext_temperature_c.toFixed(1)} °C`
              : 'N/A'}
          </p>
        </div>

        {/* Battery */}
        {bat_v !== undefined && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">BATTERY</p>
            <p className="text-4xl font-bold" style={{ color: batColour }}>
              {bat_v.toFixed(2)} V
            </p>
          </div>
        )}

        {/* ADC — only shown when non-zero (i.e. something is connected) */}
        {adc_ch0v !== undefined && adc_ch0v !== null && adc_ch0v > 0.01 && (
          <div className="bg-[var(--card)] rounded-lg p-4">
            <p className="text-[var(--text-tertiary)] text-sm font-semibold mb-1">ADC INPUT</p>
            <p className="text-4xl font-bold text-[var(--text)]">
              {adc_ch0v.toFixed(3)} V
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <p className="text-[var(--text-tertiary)] text-sm">
          Last seen: <span className="text-[var(--text)] font-semibold">{minutesAgo} minutes ago</span>
        </p>
      </div>
    </div>
  );
};
