import React, { useState } from 'react';
import useSWR from 'swr';
import { devicesAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { KiwiSensorCard } from '../components/farming/KiwiSensorCard';
import { StregaValveCard } from '../components/farming/StregaValveCard';
import { AddDeviceModal } from '../components/farming/AddDeviceModal';
import type { Device } from '../types/farming';

const fetcher = () => devicesAPI.getAll();

export const FarmingDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Fetch devices with SWR - polls every 10 seconds
  const { data: devices, error, mutate } = useSWR<Device[]>('/api/devices', fetcher, {
    refreshInterval: 10000, // 10 seconds
    revalidateOnFocus: true,
  });

  const handleDeviceAdded = () => {
    mutate(); // Refresh the devices list
  };

  const handleDeviceUpdate = () => {
    mutate(); // Refresh after valve control
  };

  const kiwiSensors = devices?.filter((d) => d.type_id === 'KIWI_SENSOR') || [];
  const stregaValves = devices?.filter((d) => d.type_id === 'STREGA_VALVE') || [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Header */}
      <header className="bg-gradient-to-r from-blue-700 to-blue-600 shadow-xl">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-4xl font-bold text-white high-contrast-text">
                Open Smart irrigation Dashboard
              </h1>
              <p className="text-blue-100 text-lg mt-1">
                Welcome, {username}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="bg-farm-green hover:bg-green-600 text-white font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors shadow-lg flex items-center gap-2"
              >
                <span className="text-2xl">+</span>
                Add Device
              </button>
              <button
                onClick={logout}
                className="bg-slate-600 hover:bg-slate-500 text-white font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Loading State */}
        {!devices && !error && (
          <div className="text-center py-12">
            <div className="inline-block animate-spin h-12 w-12 border-4 border-white border-t-transparent rounded-full mb-4" />
            <p className="text-white text-xl">Loading devices...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-500/20 border-2 border-red-500 text-red-200 px-6 py-4 rounded-lg text-center">
            <p className="text-xl font-bold mb-2">Failed to load devices</p>
            <p>{error.message}</p>
            <button
              onClick={() => mutate()}
              className="mt-4 bg-red-600 hover:bg-red-700 text-white font-bold px-6 py-2 rounded-lg"
            >
              Retry
            </button>
          </div>
        )}

        {/* Devices Grid */}
        {devices && devices.length === 0 && (
          <div className="text-center py-12 bg-slate-800 rounded-xl border-2 border-slate-700">
            <p className="text-white text-2xl font-bold mb-4">No devices yet</p>
            <p className="text-slate-400 text-lg mb-6">
              Add your first device to get started
            </p>
            <button
              onClick={() => setIsAddModalOpen(true)}
              className="bg-farm-green hover:bg-green-600 text-white font-bold text-lg px-8 py-4 touch-target rounded-lg transition-colors shadow-lg"
            >
              Add Device
            </button>
          </div>
        )}

        {devices && devices.length > 0 && (
          <>
            {/* Kiwi Sensors Section */}
            {kiwiSensors.length > 0 && (
              <div className="mb-8">
                <h2 className="text-3xl font-bold text-white mb-4 high-contrast-text">
                  Soil Sensors
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {kiwiSensors.map((device) => (
                    <KiwiSensorCard key={device.deveui} device={device} />
                  ))}
                </div>
              </div>
            )}

            {/* Strega Valves Section */}
            {stregaValves.length > 0 && (
              <div>
                <h2 className="text-3xl font-bold text-white mb-4 high-contrast-text">
                  Smart Valves
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {stregaValves.map((device) => (
                    <StregaValveCard
                      key={device.deveui}
                      device={device}
                      onUpdate={handleDeviceUpdate}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Last Update Info */}
        {devices && (
          <div className="mt-8 text-center text-slate-400 text-sm">
            <p>Auto-refreshing every 10 seconds</p>
          </div>
        )}
      </main>

      {/* Add Device Modal */}
      <AddDeviceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onDeviceAdded={handleDeviceAdded}
      />
    </div>
  );
};
