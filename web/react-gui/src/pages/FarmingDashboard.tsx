import React, { useState, useMemo } from 'react';
import useSWR from 'swr';
import { devicesAPI, irrigationOutcomesAPI, irrigationZonesAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useScope } from '../contexts/ScopeContext';
import { useTranslation } from 'react-i18next';
import { DashboardHeader } from '../components/DashboardHeader';
import { ReadOnlyNotice } from '../components/ReadOnlyNotice';
import { KiwiSensorCard } from '../components/farming/KiwiSensorCard';
import { StregaValveCard } from '../components/farming/StregaValveCard';
import { DraginoTempCard } from '../components/farming/DraginoTempCard';
import { IrrigationZoneCard } from '../components/farming/IrrigationZoneCard';
import { AddDeviceModal } from '../components/farming/AddDeviceModal';
import { CreateZoneModal } from '../components/farming/CreateZoneModal';
import { SystemPanel } from '../components/farming/SystemPanel';
import { SenseCapWeatherCard } from '../components/farming/SenseCapWeatherCard';
import { LoRainGaugeCard } from '../components/farming/LoRainGaugeCard';
import { Sdi12SoilCard } from '../components/farming/Sdi12SoilCard';
import { Sdi12SettingsModal } from '../components/farming/Sdi12SettingsModal';
import {
  IrrigationOutcomesPanel,
  type IrrigationOutcomeZoneContext,
} from '../components/farming/IrrigationOutcomesPanel';
import { Button, EmptyState } from '../ui-core';
import type { Device, IrrigationZone } from '../types/farming';
import type { IrrigationActuationsResponse } from '../services/api';

const devicesFetcher = () => devicesAPI.getAll();
const zonesFetcher = () => irrigationZonesAPI.getAll();
const irrigationActuationsFetcher = () => irrigationOutcomesAPI.recentActuations();

export const FarmingDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const { canWrite, isAdmin, loading: scopeLoading } = useScope();
  const { t } = useTranslation('dashboard');
  const { t: tc } = useTranslation('common');
  const [isAddDeviceModalOpen, setIsAddDeviceModalOpen] = useState(false);
  const [isCreateZoneModalOpen, setIsCreateZoneModalOpen] = useState(false);
  const [sdi12SettingsDevice, setSdi12SettingsDevice] = useState<Device | null>(null);

  // Fetch devices with SWR - polls every 10 seconds
  const { data: devices, error: devicesError, mutate: mutateDevices } = useSWR<Device[]>(
    '/api/devices',
    devicesFetcher,
    {
      refreshInterval: 10000,
      revalidateOnFocus: true,
    }
  );

  // Fetch zones
  const { data: zones, error: zonesError, mutate: mutateZones } = useSWR<IrrigationZone[]>(
    '/api/irrigation-zones',
    zonesFetcher,
    {
      refreshInterval: 10000,
      revalidateOnFocus: true,
    }
  );

  const {
    data: irrigationActuationsResponse,
    error: irrigationActuationsError,
    mutate: mutateIrrigationActuations,
  } = useSWR<IrrigationActuationsResponse>(
    '/api/irrigation/recent-actuations',
    irrigationActuationsFetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
    }
  );

  // Write-only scoping (W1): enabled accounts read every zone and device.
  // canWrite still gates mutation affordances below.
  const allZones = useMemo(() => zones ?? [], [zones]);

  const handleUpdate = () => {
    mutateDevices();
    mutateZones();
    mutateIrrigationActuations();
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

    const zoneIds = new Set(zones.map((zone) => zone.id));
    const byZone = new Map<number, Device[]>();
    const unassigned: Device[] = [];

    devices.forEach((device) => {
      // Write-only scoping (W1) removed the visible-zone term from this branch.
      // The weather-station term went with it: it existed only to sweep weather
      // stations out of zones the caller could not see. A zone-assigned weather
      // station belongs on its zone card, where IrrigationZoneCard renders its
      // own weather section; unassignedS2120/unassignedLoRain still cover the
      // genuinely unassigned ones.
      if (device.irrigation_zone_id && zoneIds.has(device.irrigation_zone_id)) {
        const zoneDevices = byZone.get(device.irrigation_zone_id) || [];
        zoneDevices.push(device);
        byZone.set(device.irrigation_zone_id, zoneDevices);
      } else {
        unassigned.push(device);
      }
    });

    return { devicesByZone: byZone, unassignedDevices: unassigned };
  }, [devices, zones]);

  const unassignedSensors = unassignedDevices.filter((d) => d.type_id === 'KIWI_SENSOR' || d.type_id === 'TEKTELIC_CLOVER');
  const unassignedValves = unassignedDevices.filter((d) => d.type_id === 'STREGA_VALVE');
  const unassignedLSN50 = unassignedDevices.filter((d) => d.type_id === 'DRAGINO_LSN50');
  const unassignedS2120 = unassignedDevices.filter((d) => d.type_id === 'SENSECAP_S2120');
  const unassignedLoRain = unassignedDevices.filter((d) => d.type_id === 'AQUASCOPE_LORAIN');
  const unassignedSdi12 = unassignedDevices.filter((d) => d.type_id === 'DRAGINO_SDI12');
  const irrigationActuations = irrigationActuationsResponse?.actuations ?? [];
  const zoneTimezones = useMemo(
    () => new Map(allZones.map((zone) => [zone.id, zone.timezone])),
    [allZones],
  );
  const irrigationOutcomeZoneContexts = useMemo(
    () => new Map<number, IrrigationOutcomeZoneContext>(allZones.map((zone) => [
      zone.id,
      {
        timeZone: zone.timezone ?? null,
        areaM2: zone.areaM2 ?? zone.area_m2 ?? null,
        irrigationEfficiencyPct: zone.irrigationEfficiencyPct ?? zone.irrigation_efficiency_pct ?? null,
      },
    ])),
    [allZones],
  );

  const isLoading = !devices && !devicesError && !zones && !zonesError;
  const error = devicesError || zonesError;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <DashboardHeader
        username={username}
        onAddZone={() => setIsCreateZoneModalOpen(true)}
        onAddDevice={() => setIsAddDeviceModalOpen(true)}
        onLogout={logout}
        canWrite={canWrite && !scopeLoading}
        showAdmin={isAdmin && !scopeLoading}
      />

      {/* Maintainer decision 3(c) (S6): one explanation per surface, not per
          hidden control. The header's Add-menu gating above, the 8 inline
          IrrigationZoneCard sites and its 10 readOnly disables all stay
          untouched — this is the single notice that explains all of them. */}
      {!scopeLoading && !canWrite && <ReadOnlyNotice scope="farm" />}

      {/* Main Content */}
      <main className="max-w-[1600px] mx-auto px-4 py-8">
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
            {devices.length === 0 && allZones.length === 0 && (
              <EmptyState title={t('emptyState.title')} subtitle={t('emptyState.subtitle')}>
                {canWrite && (
                  <>
                    <Button
                      onClick={() => setIsCreateZoneModalOpen(true)}
                      className="text-lg px-8 py-4 shadow-lg"
                    >
                      {t('emptyState.createZone')}
                    </Button>
                    <Button
                      onClick={() => setIsAddDeviceModalOpen(true)}
                      className="text-lg px-8 py-4 shadow-lg"
                    >
                      {t('emptyState.addDevice')}
                    </Button>
                  </>
                )}
              </EmptyState>
            )}

            {/* Zones section — heading omitted; the active nav tab labels the
                page. The Unassigned Devices section below keeps its heading
                because it is a distinct section. */}
            {allZones.length > 0 && (
              <div className="mb-8">
                {allZones.map((zone) => (
                  <IrrigationZoneCard
                    key={zone.id}
                    zone={zone}
                    devices={devicesByZone.get(zone.id) || []}
                    unassignedDevices={unassignedDevices}
                    onUpdate={handleUpdate}
                    allZones={allZones.map((z) => ({ id: z.id, name: z.name }))}
                    irrigationActuations={irrigationActuations}
                    canWrite={canWrite}
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
                            readOnly={!canWrite}
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
                            irrigationActuations={irrigationActuations}
                            timeZone={device.irrigation_zone_id ? zoneTimezones.get(device.irrigation_zone_id) : undefined}
                            readOnly={!canWrite}
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
                            readOnly={!canWrite}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unassigned SDI-12 Soil Nodes */}
                  {unassignedSdi12.length > 0 && (
                    <div className="mt-6">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">SDI-12 Soil Nodes</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedSdi12.map((device) => (
                          <Sdi12SoilCard
                            key={device.deveui}
                            device={device}
                            onOpenSettings={() => setSdi12SettingsDevice(device)}
                            onRemove={handleUpdate}
                            readOnly={!canWrite}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unassigned SenseCAP S2120 Weather Stations */}
                  {unassignedS2120.length > 0 && (
                    <div className="mt-6">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">SenseCAP S2120 Weather Stations</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedS2120.map((device) => (
                          <SenseCapWeatherCard
                            key={device.deveui}
                            device={device}
                            allZones={allZones.map((z) => ({ id: z.id, name: z.name }))}
                            onUpdate={handleUpdate}
                            readOnly={!canWrite}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unassigned Aqua-Scope LoRain Gauges */}
                  {unassignedLoRain.length > 0 && (
                    <div className="mt-6">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">Aqua-Scope LoRain Gauges</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedLoRain.map((device) => (
                          <LoRainGaugeCard
                            key={device.deveui}
                            device={device}
                            onRemove={handleUpdate}
                            readOnly={!canWrite}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Recent irrigation outcomes (osi-os#7) */}
            <div className="mt-8">
              <IrrigationOutcomesPanel
                response={irrigationActuationsResponse ?? null}
                loading={!irrigationActuationsResponse && !irrigationActuationsError}
                error={irrigationActuationsError instanceof Error ? irrigationActuationsError.message : irrigationActuationsError ? String(irrigationActuationsError) : null}
                zoneContexts={irrigationOutcomeZoneContexts}
              />
            </div>

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
        isOpen={canWrite && isAddDeviceModalOpen}
        onClose={() => setIsAddDeviceModalOpen(false)}
        onDeviceAdded={handleDeviceAdded}
      />

      <CreateZoneModal
        isOpen={canWrite && isCreateZoneModalOpen}
        onClose={() => setIsCreateZoneModalOpen(false)}
        onZoneCreated={handleZoneCreated}
      />

      {sdi12SettingsDevice && (
        <Sdi12SettingsModal
          device={sdi12SettingsDevice}
          onClose={() => setSdi12SettingsDevice(null)}
          onUpdate={handleUpdate}
        />
      )}
    </div>
  );
};
