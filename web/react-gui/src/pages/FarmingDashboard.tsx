import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { devicesAPI, irrigationZonesAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { KiwiSensorCard } from '../components/farming/KiwiSensorCard';
import { StregaValveCard } from '../components/farming/StregaValveCard';
import { DraginoTempCard } from '../components/farming/DraginoTempCard';
import { IrrigationZoneCard } from '../components/farming/IrrigationZoneCard';
import { AddDeviceModal } from '../components/farming/AddDeviceModal';
import { CreateZoneModal } from '../components/farming/CreateZoneModal';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { SystemPanel } from '../components/farming/SystemPanel';
import type { Device, IrrigationZone } from '../types/farming';

const devicesFetcher = () => devicesAPI.getAll();
const zonesFetcher = () => irrigationZonesAPI.getAll();

export const FarmingDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const { t } = useTranslation('dashboard');
  const { t: tc } = useTranslation('common');
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

    return { devicesByZone: byZone, unassignedDevices: unassigned };
  }, [devices, zones]);

  const unassignedSensors = unassignedDevices.filter((d) => d.type_id === 'KIWI_SENSOR');
  const unassignedValves = unassignedDevices.filter((d) => d.type_id === 'STREGA_VALVE');
  const unassignedLSN50 = unassignedDevices.filter((d) => d.type_id === 'DRAGINO_LSN50');

  const isLoading = !devices && !devicesError && !zones && !zonesError;
  const error = devicesError || zonesError;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Header */}
      <header className="bg-[var(--header-bg)] shadow-xl">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-4xl font-bold text-[var(--header-text)] high-contrast-text">
                OSI OS Dashboard
              </h1>
              <p className="text-[var(--header-subtext)] text-lg mt-1">{t('welcome', { username })}</p>
            </div>
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-3">
              <div className="w-full sm:w-auto flex justify-center sm:justify-start">
                <LanguageSwitcher />
              </div>
              <button
                onClick={() => setIsCreateZoneModalOpen(true)}
                className="w-full sm:w-auto bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
              >
                <span className="text-2xl">+</span>
                {t('addZone')}
              </button>
              <button
                onClick={() => setIsAddDeviceModalOpen(true)}
                className="w-full sm:w-auto bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
              >
                <span className="text-2xl">+</span>
                {t('addDevice')}
              </button>
              <Link
                to="/account-link"
                className="w-full sm:w-auto bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <span>☁</span>
                OSI Server
              </Link>
              <button
                onClick={logout}
                className="w-full sm:w-auto bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-lg px-6 py-3 touch-target rounded-lg transition-colors"
              >
                {t('logout')}
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
            <div className="inline-block animate-spin h-12 w-12 border-4 border-[var(--primary)] border-t-transparent rounded-full mb-4" />
            <p className="text-[var(--text)] text-xl">{t('loading')}</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-[var(--error-bg)] border-2 border-[var(--error-bg)] text-[var(--error-text)] px-6 py-4 rounded-lg text-center">
            <p className="text-xl font-bold mb-2">{t('failedToLoad')}</p>
            <p>{error.message}</p>
            <button
              onClick={handleUpdate}
              className="mt-4 bg-[var(--error-bg)] hover:bg-[var(--error-bg)] text-[var(--error-text)] font-bold px-6 py-2 rounded-lg"
            >
              {tc('retry')}
            </button>
          </div>
        )}

        {/* Dashboard Content */}
        {devices && zones && (
          <>
            {/* Empty State */}
            {devices.length === 0 && zones.length === 0 && (
              <div className="text-center py-12 bg-[var(--surface)] rounded-xl border-2 border-[var(--border)]">
                <p className="text-[var(--text)] text-2xl font-bold mb-4">{t('emptyState.title')}</p>
                <p className="text-[var(--text-tertiary)] text-lg mb-6">
                  {t('emptyState.subtitle')}
                </p>
                <div className="flex gap-4 justify-center">
                  <button
                    onClick={() => setIsCreateZoneModalOpen(true)}
                    className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold text-lg px-8 py-4 touch-target rounded-lg transition-colors shadow-lg"
                  >
                    {t('emptyState.createZone')}
                  </button>
                  <button
                    onClick={() => setIsAddDeviceModalOpen(true)}
                    className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold text-lg px-8 py-4 touch-target rounded-lg transition-colors shadow-lg"
                  >
                    {t('emptyState.addDevice')}
                  </button>
                </div>
              </div>
            )}

            {/* Irrigation Zones Section */}
            {zones.length > 0 && (
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-[var(--text)] mb-4 high-contrast-text">
                  {t('irrigationZones')}
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
                <h2 className="text-2xl font-bold text-[var(--text)] mb-4 high-contrast-text">
                  {t('unassignedDevices')}
                </h2>
                <div className="bg-[var(--surface)] border-2 border-dashed border-[var(--border)] rounded-xl p-6">
                  <p className="text-[var(--text-tertiary)] mb-4">
                    {t('unassignedSubtitle')}
                  </p>

                  {/* Unassigned Sensors */}
                  {unassignedSensors.length > 0 && (
                    <div className="mb-6">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('soilSensors')}</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedSensors.map((device) => (
                          <KiwiSensorCard
                            key={device.deveui}
                            device={device}
                            onRemove={handleUpdate}
                            onUpdate={handleUpdate}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unassigned Valves */}
                  {unassignedValves.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('smartValves')}</h3>
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

                  {/* Unassigned LSN50 Nodes */}
                  {unassignedLSN50.length > 0 && (
                    <div className="mt-6">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">Dragino LSN50 Nodes</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedLSN50.map((device) => (
                          <DraginoTempCard
                            key={device.deveui}
                            device={device}
                            onRemove={handleUpdate}
                            onUpdate={handleUpdate}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Gateway system panel */}
            <div className="mt-8">
              <SystemPanel />
            </div>

            {/* Auto-refresh indicator */}
            <div className="mt-8 text-center text-[var(--text-tertiary)] text-sm">
              <p>{t('autoRefresh')}</p>
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
