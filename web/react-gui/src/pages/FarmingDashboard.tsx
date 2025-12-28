import React, { useState, useMemo } from 'react';
import useSWR from 'swr';
import { devicesAPI, irrigationZonesAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { KiwiSensorCard } from '../components/farming/KiwiSensorCard';
import { StregaValveCard } from '../components/farming/StregaValveCard';
import { IrrigationZoneCard } from '../components/farming/IrrigationZoneCard';
import { AddDeviceModal } from '../components/farming/AddDeviceModal';
import { CreateZoneModal } from '../components/farming/CreateZoneModal';
import type { Device, IrrigationZone } from '../types/farming';

const devicesFetcher = () => devicesAPI.getAll();
const zonesFetcher = () => irrigationZonesAPI.getAll();

export const FarmingDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const [isAddDeviceModalOpen, setIsAddDeviceModalOpen] = useState(false);
  const [isCreateZoneModalOpen, setIsCreateZoneModalOpen] = useState(false);

  // Fetch devices with SWR - polls every 10 seconds
  const { data: devices, error: devicesError, mutate: mutateDevices } = useSWR<Device[]>(
    '/api/devices',
    devicesFetcher,
    {
      refreshInterval: 10000,
      revalidateOnFocus: true,
    }
  );

  // Fetch irrigation zones
  const { data: zones, error: zonesError, mutate: mutateZones } = useSWR<IrrigationZone[]>(
    '/api/irrigation-zones',
    zonesFetcher,
    {
      refreshInterval: 10000,
      revalidateOnFocus: true,
    }
  );

  const handleUpdate = () => {
    mutateDevices();
    mutateZones();
  };

  const handleDeviceAdded = () => {
    mutateDevices();
  };

  const handleZoneCreated = () => {
    mutateZones();
  };

  // Group devices by zone
  const { devicesByZone, unassignedDevices } = useMemo(() => {
    if (!devices || !zones) {
      return { devicesByZone: new Map(), unassignedDevices: [] };
    }

    const byZone = new Map<number, Device[]>();
    const unassigned: Device[] = [];

    devices.forEach((device) => {
      if (device.irrigation_zone_id) {
        const zoneDevices = byZone.get(device.irrigation_zone_id) || [];
        zoneDevices.push(device);
        byZone.set(device.irrigation_zone_id, zoneDevices);
      } else {
        unassigned.push(device);
      }
    });

    return { devicesByZone, unassignedDevices: unassigned };
  }, [devices, zones]);

  const unassignedSensors = unassignedDevices.filter((d) => d.type_id === 'KIWI_SENSOR');
  const unassignedValves = unassignedDevices.filter((d) => d.type_id === 'STREGA_VALVE');

  const isLoading = !devices && !devicesError && !zones && !zonesError;
  const error = devicesError || zonesError;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Header */}
      <header className="bg-gradient-to-r from-blue-700 to-blue-600 shadow-xl">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-4xl font-bold text-white high-contrast-text">
                Open Smart Irrigation Dashboard
              </h1>
              <p className="text-blue-100 text-lg mt-1">Welcome, {username}</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setIsCreateZoneModalOpen(true)}
                className="bg-farm-blue hover:bg-blue-600 text-white font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors shadow-lg flex items-center gap-2"
              >
                <span className="text-2xl">+</span>
                Add Zone
              </button>
              <button
                onClick={() => setIsAddDeviceModalOpen(true)}
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
        {isLoading && (
          <div className="text-center py-12">
            <div className="inline-block animate-spin h-12 w-12 border-4 border-white border-t-transparent rounded-full mb-4" />
            <p className="text-white text-xl">Loading dashboard...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-500/20 border-2 border-red-500 text-red-200 px-6 py-4 rounded-lg text-center">
            <p className="text-xl font-bold mb-2">Failed to load data</p>
            <p>{error.message}</p>
            <button
              onClick={handleUpdate}
              className="mt-4 bg-red-600 hover:bg-red-700 text-white font-bold px-6 py-2 rounded-lg"
            >
              Retry
            </button>
          </div>
        )}

        {/* Dashboard Content */}
        {devices && zones && (
          <>
            {/* Empty State */}
            {devices.length === 0 && zones.length === 0 && (
              <div className="text-center py-12 bg-slate-800 rounded-xl border-2 border-slate-700">
                <p className="text-white text-2xl font-bold mb-4">Welcome to your farm!</p>
                <p className="text-slate-400 text-lg mb-6">
                  Get started by creating an irrigation zone and adding devices
                </p>
                <div className="flex gap-4 justify-center">
                  <button
                    onClick={() => setIsCreateZoneModalOpen(true)}
                    className="bg-farm-blue hover:bg-blue-600 text-white font-bold text-lg px-8 py-4 touch-target rounded-lg transition-colors shadow-lg"
                  >
                    Create Zone
                  </button>
                  <button
                    onClick={() => setIsAddDeviceModalOpen(true)}
                    className="bg-farm-green hover:bg-green-600 text-white font-bold text-lg px-8 py-4 touch-target rounded-lg transition-colors shadow-lg"
                  >
                    Add Device
                  </button>
                </div>
              </div>
            )}

            {/* Irrigation Zones Section */}
            {zones.length > 0 && (
              <div className="mb-8">
                <h2 className="text-3xl font-bold text-white mb-4 high-contrast-text">
                  Irrigation Zones
                </h2>
                {zones.map((zone) => (
                  <IrrigationZoneCard
                    key={zone.id}
                    zone={zone}
                    devices={devicesByZone.get(zone.id) || []}
                    unassignedDevices={unassignedDevices}
                    onUpdate={handleUpdate}
                  />
                ))}
              </div>
            )}

            {/* Unassigned Devices Section */}
            {unassignedDevices.length > 0 && (
              <div>
                <h2 className="text-3xl font-bold text-white mb-4 high-contrast-text">
                  Unassigned Devices
                </h2>
                <div className="bg-slate-800/50 border-2 border-dashed border-slate-600 rounded-xl p-6">
                  <p className="text-slate-400 mb-4">
                    These devices are not assigned to any irrigation zone
                  </p>

                  {/* Unassigned Sensors */}
                  {unassignedSensors.length > 0 && (
                    <div className="mb-6">
                      <h3 className="text-white text-xl font-bold mb-3">Soil Sensors</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedSensors.map((device) => (
                          <KiwiSensorCard
                            key={device.deveui}
                            device={device}
                            onRemove={handleUpdate}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unassigned Valves */}
                  {unassignedValves.length > 0 && (
                    <div>
                      <h3 className="text-white text-xl font-bold mb-3">Smart Valves</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedValves.map((device) => (
                          <StregaValveCard
                            key={device.deveui}
                            device={device}
                            onUpdate={handleUpdate}
                            onRemove={handleUpdate}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Auto-refresh indicator */}
            <div className="mt-8 text-center text-slate-400 text-sm">
              <p>Auto-refreshing every 10 seconds</p>
            </div>
          </>
        )}
      </main>

      {/* Modals */}
      <AddDeviceModal
        isOpen={isAddDeviceModalOpen}
        onClose={() => setIsAddDeviceModalOpen(false)}
        onDeviceAdded={handleDeviceAdded}
      />

      <CreateZoneModal
        isOpen={isCreateZoneModalOpen}
        onClose={() => setIsCreateZoneModalOpen(false)}
        onZoneCreated={handleZoneCreated}
      />
    </div>
  );
};
