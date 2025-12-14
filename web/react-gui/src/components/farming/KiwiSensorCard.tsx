import React from 'react';
import type { Device } from '../../types/farming';

interface KiwiSensorCardProps {
  device: Device;
}

export const KiwiSensorCard: React.FC<KiwiSensorCardProps> = ({ device }) => {
  const { swt_wm1, swt_wm2, light_lux } = device.latest_data;
  const lastSeen = new Date(device.last_seen);
  const now = new Date();
  const minutesAgo = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60));

  // Determine if soil is too dry (< 30 kPa)
  const isToDry = swt_wm1 !== undefined && swt_wm1 < 30;

  return (
    <div
      className={`rounded-xl p-6 border-2 shadow-lg transition-all ${
        isToDry
          ? 'bg-red-500/20 border-red-500'
          : 'bg-slate-700 border-slate-600 hover:border-farm-blue'
      }`}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-2xl font-bold text-white mb-1 high-contrast-text">
            {device.name}
          </h3>
          <p className="text-slate-300 text-sm">{device.deveui}</p>
        </div>
        <div className="bg-farm-blue text-white px-3 py-1 rounded-lg text-sm font-semibold">
          KIWI SENSOR
        </div>
      </div>

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
