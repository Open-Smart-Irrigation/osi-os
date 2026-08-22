import React, { useState, useMemo } from 'react';
import useSWR from 'swr';
import { devicesAPI, irrigationOutcomesAPI, irrigationZonesAPI, valvesAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { DashboardHeader } from '../components/DashboardHeader';
import { KiwiSensorCard } from '../components/farming/KiwiSensorCard';
import { StregaValveCard } from '../components/farming/StregaValveCard';
import { DraginoTempCard } from '../components/farming/DraginoTempCard';
import { IrrigationZoneCard } from '../components/farming/IrrigationZoneCard';
import { AddDeviceModal } from '../components/farming/AddDeviceModal';
import { CreateZoneModal } from '../components/farming/CreateZoneModal';
import { SystemPanel } from '../components/farming/SystemPanel';
import { SenseCapWeatherCard } from '../components/farming/SenseCapWeatherCard';
import { LoRainGaugeCard } from '../components/farming/LoRainGaugeCard';
import { ValveControlPanel } from '../components/farming/valves/ValveControlPanel';
import {
  IrrigationOutcomesPanel,
  type IrrigationOutcomeZoneContext,
} from '../components/farming/IrrigationOutcomesPanel';
import { useDisplayPreferences } from '../utils/displayPreferences';
import type { Device, IrrigationZone, ValveSummary } from '../types/farming';
import type { IrrigationActuationsResponse } from '../services/api';

const devicesFetcher = () => devicesAPI.getAll();
const zonesFetcher = () => irrigationZonesAPI.getAll();
const irrigationActuationsFetcher = () => irrigationOutcomesAPI.recentActuations();
const valvesFetcher = () => valvesAPI.list();

export const FarmingDashboard: React.FC = () => {
  const { username, logout } = useAuth();
  const { t } = useTranslation('dashboard');
  const { t: tc } = useTranslation('common');
  const { modules } = useDisplayPreferences();
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

  // A farm with no STREGA valves at all should not poll /api/valves — derive a stable
  // boolean from the already-loaded device list (false, not a flapping value, while
  // devices is still loading) and use it to gate the SWR key. `null` tells SWR "do not
  // fetch": no request is ever issued for a valve-less farm, on a Raspberry Pi 5 that
  // already polls three other endpoints every 10 s.
  //
  // When there IS at least one STREGA valve, this uses the exact same key
  // ValveControlPanel already fetches ('/api/valves', identical options), so SWR
  // dedupes and shares one cache entry/one poll while the panel is visible. That sharing
  // depends on SWR's default ~2 s dedupingInterval — it is not structural, so do not gate
  // this key on `modules.valveControl` (a per-browser display preference): StregaValveCard
  // still needs the data whether or not the panel itself is rendered, and hiding the panel
  // does not reduce this poll — it only stops being deduped against the panel's own timer.
  const hasStregaValve = useMemo(
    () => (devices ?? []).some((d) => d.type_id === 'STREGA_VALVE'),
    [devices],
  );
  const { data: valves } = useSWR<ValveSummary[]>(
    hasStregaValve ? '/api/valves' : null,
    valvesFetcher,
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

  const unassignedSensors = unassignedDevices.filter((d) => d.type_id === 'KIWI_SENSOR' || d.type_id === 'TEKTELIC_CLOVER');
  const unassignedValves = unassignedDevices.filter((d) => d.type_id === 'STREGA_VALVE');
  const unassignedLSN50 = unassignedDevices.filter((d) => d.type_id === 'DRAGINO_LSN50');
  const unassignedS2120 = unassignedDevices.filter((d) => d.type_id === 'SENSECAP_S2120');
  const unassignedLoRain = unassignedDevices.filter((d) => d.type_id === 'AQUASCOPE_LORAIN');
  const irrigationActuations = irrigationActuationsResponse?.actuations ?? [];
  const zoneTimezones = useMemo(
    () => new Map((zones ?? []).map((zone) => [zone.id, zone.timezone])),
    [zones],
  );
  // deviceEui is always uppercased by normaliseValveSummary; Device.deveui is always
  // uppercased by normaliseDevice — so a plain-string key match is safe.
  const valvesByEui = useMemo(
    () => new Map((valves ?? []).map((v) => [v.deviceEui, v])),
    [valves],
  );
  const irrigationOutcomeZoneContexts = useMemo(
    () => new Map<number, IrrigationOutcomeZoneContext>((zones ?? []).map((zone) => [
      zone.id,
      {
        timeZone: zone.timezone ?? null,
        areaM2: zone.areaM2 ?? zone.area_m2 ?? null,
        irrigationEfficiencyPct: zone.irrigationEfficiencyPct ?? zone.irrigation_efficiency_pct ?? null,
      },
    ])),
    [zones],
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
      />

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
                    allZones={(zones ?? []).map((z) => ({ id: z.id, name: z.name }))}
                    irrigationActuations={irrigationActuations}
                    valvesByEui={valvesByEui}
                  />
                ))}
              </div>
            )}

            {/* Valve control panel — also gated on hasStregaValve: ValveControlPanel
                runs its own unconditional useSWR('/api/valves', ...) on mount, so
                showing it for a farm with zero STREGA valves would poll every 10 s for
                a panel that can only ever say "no valves". modules.valveControl stays
                the user's display preference; hasStregaValve is the data-driven "is
                there anything to control at all" gate. */}
            {modules.valveControl && hasStregaValve && (
              <div className="mt-8">
                <ValveControlPanel onUpdate={handleUpdate} />
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
                            irrigationActuations={irrigationActuations}
                            timeZone={device.irrigation_zone_id ? zoneTimezones.get(device.irrigation_zone_id) : undefined}
                            valve={valvesByEui.get(device.deveui)}
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

                  {/* Unassigned SenseCAP S2120 Weather Stations */}
                  {unassignedS2120.length > 0 && (
                    <div className="mt-6">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">SenseCAP S2120 Weather Stations</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {unassignedS2120.map((device) => (
                          <SenseCapWeatherCard
                            key={device.deveui}
                            device={device}
                            allZones={(zones ?? []).map((z) => ({ id: z.id, name: z.name }))}
                            onUpdate={handleUpdate}
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
