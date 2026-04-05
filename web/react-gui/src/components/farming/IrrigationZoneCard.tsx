import React, { useEffect, useState } from 'react';
import type { IrrigationZone, Device, ZoneEnvironmentSummary, ZoneRecommendation } from '../../types/farming';
import { dendroAnalyticsAPI, environmentAPI, irrigationZonesAPI } from '../../services/api';
import { KiwiSensorCard } from './KiwiSensorCard';
import { DraginoTempCard } from './DraginoTempCard';
import { StregaValveCard } from './StregaValveCard';
import { ScheduleSection } from './ScheduleSection';
import { AssignDeviceModal } from './AssignDeviceModal';
import { DendrometerSection } from './dendrometer/DendrometerSection';
import { EnvironmentCard } from './environment/EnvironmentCard';
import { ZoneConfigModal } from './ZoneConfigModal';
import { AdvancedScheduleDrawer } from './AdvancedScheduleDrawer';
import { useTranslation } from 'react-i18next';

interface IrrigationZoneCardProps {
  zone: IrrigationZone;
  devices: Device[];
  unassignedDevices: Device[];
  onUpdate: () => void;
}

function formatWaterValue(value: number | null | undefined, unit: string, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(digits)} ${unit}`;
}

function formatWaterAction(code: string | null | undefined): string {
  switch (code) {
    case 'delay_irrigation':
      return 'Delay irrigation';
    case 'irrigate_today':
      return 'Irrigate today';
    case 'monitor_today':
      return 'Monitor today';
    case 'maintain_rain_suppression':
      return 'Rain suppression active';
    case 'maintain_recovery_hold':
      return 'Recovery hold active';
    case 'increase_10':
      return 'Increase irrigation slightly';
    case 'increase_20':
      return 'Increase irrigation';
    case 'decrease_10':
      return 'Decrease irrigation slightly';
    case 'decrease_20':
      return 'Decrease irrigation';
    case 'emergency_irrigate':
      return 'Emergency irrigation';
    default:
      return 'Monitor water status';
  }
}

function classifySoil(devices: Device[]): { label: string; swt: number | null } {
  const swtValues = devices.flatMap((device) => {
    const data = device.latest_data;
    return [data?.swt_wm1, data?.swt_wm2].filter((value): value is number => value != null && Number.isFinite(value));
  });
  if (!swtValues.length) {
    return { label: 'No soil sensor reading', swt: null };
  }
  const mean = swtValues.reduce((sum, value) => sum + value, 0) / swtValues.length;
  if (mean < 20) return { label: 'Wet', swt: mean };
  if (mean < 60) return { label: 'Moderate', swt: mean };
  return { label: 'Dry', swt: mean };
}

function formatSchedulingMode(mode: string | null | undefined): string {
  return mode === 'server_preferred' ? 'Server when fresh' : 'Local scheduling';
}

function formatDisplayMode(mode: string | null | undefined): string {
  switch (mode) {
    case 'shared_server':
      return 'OSI Server';
    case 'shared_server_stale':
      return 'OSI Server stale';
    case 'local_fallback':
      return 'Local fallback';
    case 'unlinked_local':
      return 'Local only';
    default:
      return 'Water source';
  }
}

export const IrrigationZoneCard: React.FC<IrrigationZoneCardProps> = ({
  zone,
  devices,
  unassignedDevices,
  onUpdate,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [zoneCollapsed, setZoneCollapsed] = useState(true);
  const [devicesCollapsed, setDevicesCollapsed] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showAdvancedDrawer, setShowAdvancedDrawer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingDevice, setRemovingDevice] = useState<string | null>(null);
  const [environmentSummary, setEnvironmentSummary] = useState<ZoneEnvironmentSummary | null>(null);
  const [latestZoneRecommendation, setLatestZoneRecommendation] = useState<ZoneRecommendation | null>(null);
  const [dismissedDriftAt, setDismissedDriftAt] = useState<string | null>(null);

  const handleDeleteZone = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await irrigationZonesAPI.delete(zone.id);
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || t('zone.failedToDelete'));
      setIsDeleting(false);
    }
  };

  const handleRemoveDevice = async (deveui: string) => {
    setRemovingDevice(deveui);
    setError(null);
    try {
      await irrigationZonesAPI.removeDevice(zone.id, deveui);
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || t('zone.failedToRemoveDevice'));
    } finally {
      setRemovingDevice(null);
    }
  };

  const kiwiSensors = devices.filter((d) => d.type_id === 'KIWI_SENSOR' || d.type_id === 'TEKTELIC_CLOVER');
  const stregaValves = devices.filter((d) => d.type_id === 'STREGA_VALVE');
  const lsn50Nodes = devices.filter((d) => d.type_id === 'DRAGINO_LSN50');

  const hasDendroDevices = lsn50Nodes.some(d => d.dendro_enabled === 1);
  const schedMetric = zone.schedule?.triggerMetric ?? zone.schedule?.trigger_metric;
  const schedEnabled = zone.schedule?.enabled ?? false;
  const cropType = zone.cropType;
  const soilType = zone.soilType;
  const soilNow = classifySoil(devices);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [summary, recommendations] = await Promise.all([
          environmentAPI.getSummary(zone.id),
          hasDendroDevices ? dendroAnalyticsAPI.getZoneRecommendations(zone.id, 1) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setEnvironmentSummary(summary);
        setLatestZoneRecommendation(recommendations[0] ?? null);
      } catch {
        if (!cancelled) {
          setEnvironmentSummary(null);
          setLatestZoneRecommendation(null);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hasDendroDevices, zone.id]);

  useEffect(() => {
    setDismissedDriftAt(null);
  }, [environmentSummary?.generatedAt, zone.id]);

  const handleUseServerScheduling = async () => {
    try {
      await irrigationZonesAPI.updateConfig(zone.id, { schedulingMode: 'server_preferred' });
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.response?.data?.message || 'Failed to switch scheduling source');
    }
  };

  const driftPrompt = environmentSummary?.drift?.active
    && environmentSummary.display?.schedulingMode !== 'server_preferred'
    && environmentSummary.drift.canSwitchScheduling
    && dismissedDriftAt !== environmentSummary.generatedAt
      ? environmentSummary.drift
      : null;

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--border)] rounded-xl p-6 shadow-lg mb-6">
      {/* Zone Header — stacks vertically on mobile */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 mb-3">
        <button
          className="flex-1 min-w-0 text-left flex items-center gap-2 group"
          onClick={() => setZoneCollapsed(c => !c)}
        >
          <h3 className="text-3xl font-bold text-[var(--text)] mb-1 high-contrast-text break-words">
            {zone.name}
          </h3>
          <span
            className="text-[var(--text-tertiary)] text-lg transition-transform duration-200 mt-0.5 shrink-0"
            style={{ display: 'inline-block', transform: zoneCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
          <p className="text-[var(--text-secondary)] text-sm mt-1">
            {t('zone.deviceCount', { count: zone.device_count })}
          </p>
        </button>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            onClick={() => setShowConfigModal(true)}
            className="touch-target bg-[var(--surface)] hover:bg-[var(--border)] border border-[var(--border)] text-[var(--text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            Configure
          </button>
          <button
            onClick={() => setShowAssignModal(true)}
            className="touch-target bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            {t('zone.assignDevice')}
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeleting}
            className="touch-target bg-[var(--error-bg)] hover:bg-red-700 disabled:bg-[var(--border)] text-[var(--error-text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
          >
            {t('zone.deleteZone')}
          </button>
        </div>
      </div>

      {/* Zone context chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {cropType && (
          <span className="inline-flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] text-xs px-2.5 py-1 rounded-full">
            <span>🌱</span> {cropType}{(zone.variety) ? ` — ${zone.variety}` : ''}
          </span>
        )}
        {soilType && (
          <span className="inline-flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] text-xs px-2.5 py-1 rounded-full">
            <span>⛰</span> {soilType}
          </span>
        )}
        {hasDendroDevices && (
          <span className="inline-flex items-center gap-1 bg-teal-50 border border-teal-200 text-teal-800 text-xs px-2.5 py-1 rounded-full font-medium">
            <span>📏</span> Dendro active
          </span>
        )}
        {zone.schedule && schedEnabled && schedMetric && (() => {
          const metricLabel =
            schedMetric === 'DENDRO'   ? 'Dendro trigger' :
            schedMetric === 'VWC'      ? 'VWC trigger' :
            schedMetric === 'SWT_WM1'  ? 'Soil tension (S1)' :
            schedMetric === 'SWT_WM2'  ? 'Soil tension (S2)' :
            schedMetric === 'SWT_WM3'  ? 'Soil tension (S3)' :
            schedMetric === 'SWT_AVG'  ? 'Soil tension (avg)' :
                                         'Soil tension';
          return (
            <span className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 text-blue-800 text-xs px-2.5 py-1 rounded-full">
              <span>⏱</span> {metricLabel} enabled
            </span>
          );
        })()}
        {zone.schedule && !schedEnabled && (
          <span className="inline-flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] text-xs px-2.5 py-1 rounded-full">
            <span>⏸</span> Scheduler off
          </span>
        )}
      </div>

      {!zoneCollapsed && (
      <>

      {environmentSummary?.water && (
        <div className="mb-4 rounded-2xl border border-sky-100 bg-[linear-gradient(135deg,#f0f9ff,white_55%,#ecfeff)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">Water Today</p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {environmentSummary.water.action?.reasoning ?? 'Daily rain, irrigation, and crop demand summary for this zone.'}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 text-xs text-[var(--text-tertiary)]">
              <div>Updated {environmentSummary.water.observedAt ? new Date(environmentSummary.water.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</div>
              <div className="flex flex-wrap justify-end gap-1">
                <span className="rounded-full border border-sky-200 bg-white/80 px-2 py-0.5 font-semibold text-sky-700">
                  {formatDisplayMode(environmentSummary.display?.mode)}
                </span>
                <span className="rounded-full border border-[var(--border)] bg-white/80 px-2 py-0.5 font-semibold text-[var(--text-secondary)]">
                  {formatSchedulingMode(environmentSummary.display?.schedulingMode ?? zone.schedulingMode)}
                </span>
              </div>
            </div>
          </div>
          {environmentSummary.display?.fallbackReason && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {environmentSummary.display.fallbackReason}
            </div>
          )}
          {environmentSummary.display?.schedulingMode === 'server_preferred' && (
            <div className="mt-3 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm text-cyan-900">
              This zone follows OSI Server recommendations when they are fresh, with automatic local fallback if the link becomes stale.
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div className="rounded-xl bg-white/80 p-3 shadow-sm ring-1 ring-sky-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Rain today</p>
              <p className="mt-2 text-2xl font-bold text-sky-700">{formatWaterValue(environmentSummary.water.rainTodayMm, 'mm', 1)}</p>
            </div>
            <div className="rounded-xl bg-white/80 p-3 shadow-sm ring-1 ring-teal-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Irrigation today</p>
              <p className="mt-2 text-2xl font-bold text-teal-700">{formatWaterValue(environmentSummary.water.irrigationTodayLiters, 'L', 0)}</p>
              {environmentSummary.water.irrigationTodayNetMm != null && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{formatWaterValue(environmentSummary.water.irrigationTodayNetMm, 'mm', 1)} effective</p>
              )}
            </div>
            <div className="rounded-xl bg-white/80 p-3 shadow-sm ring-1 ring-cyan-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Next rain</p>
              <p className="mt-2 text-2xl font-bold text-cyan-700">{formatWaterValue(environmentSummary.water.next24hRainMm, 'mm', 1)}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">Forecast next 24 h</p>
            </div>
            <div className="rounded-xl bg-white/80 p-3 shadow-sm ring-1 ring-amber-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Action</p>
              <p className="mt-2 text-2xl font-bold text-amber-700">{formatWaterAction(environmentSummary.water.action?.code)}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {environmentSummary.water.action?.source === 'dendro' ? 'Driven by dendrometer recommendation' : 'Driven by water balance'}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-[var(--border)] bg-white/70 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Soil now</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text)]">
                {soilNow.swt != null ? `${soilNow.swt.toFixed(1)} kPa` : '—'}
              </p>
              <p className="text-sm text-[var(--text-secondary)]">{soilNow.label}</p>
            </div>
            {hasDendroDevices && (
              <div className="rounded-xl border border-[var(--border)] bg-white/70 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Tree stress</p>
                <p className="mt-1 text-lg font-semibold text-[var(--text)]">
                  {latestZoneRecommendation?.zone_stress_summary?.replace(/_/g, ' ') ?? 'Awaiting recommendation'}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {latestZoneRecommendation?.zone_confidence_score != null
                    ? `${Math.round(latestZoneRecommendation.zone_confidence_score * 100)}% confidence`
                    : 'Confidence updates with the latest dendro run'}
                </p>
              </div>
            )}
          </div>
          {driftPrompt && (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950">
              <p className="font-semibold">Local and OSI Server recommendations are drifting.</p>
              <p className="mt-1">{driftPrompt.reason}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-amber-900">
                <span className="rounded-full bg-white/70 px-2 py-1 font-medium">
                  Local: {formatWaterAction(driftPrompt.localActionCode)}
                </span>
                <span className="rounded-full bg-white/70 px-2 py-1 font-medium">
                  Server: {formatWaterAction(driftPrompt.serverActionCode)}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setDismissedDriftAt(environmentSummary.generatedAt)}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900"
                >
                  Keep local
                </button>
                <button
                  onClick={() => void handleUseServerScheduling()}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700"
                >
                  Use server scheduling
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showDeleteConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">{t('zone.deleteConfirm')}</p>
          <p className="text-sm mb-3">
            {t('zone.deleteSubtitle')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDeleteZone}
              disabled={isDeleting}
              className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
            >
              {isDeleting ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  {t('zone.deleting')}
                </>
              ) : (
                t('zone.yesDelete')
              )}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Schedule Section */}
      <ScheduleSection
        zoneId={zone.id}
        zoneName={zone.name}
        onAdvancedOpen={() => setShowAdvancedDrawer(true)}
      />

      {/* Dendrometer Monitoring Section */}
      <DendrometerSection zone={zone} devices={lsn50Nodes} />

      {/* Environment Section */}
      <EnvironmentCard zone={zone} devices={devices} />

      {/* Devices in Zone — collapsible */}
      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <button
          className="w-full flex items-center justify-between text-left group"
          onClick={() => setDevicesCollapsed(c => !c)}
        >
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] group-hover:text-[var(--text)] transition-colors">
            {t('zone.devicesInZone')}
          </span>
          <span
            className="text-[var(--text-tertiary)] text-sm transition-transform duration-200"
            style={{ display: 'inline-block', transform: devicesCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
        </button>

        {!devicesCollapsed && (
          devices.length > 0 ? (
            <div className="mt-3">
              {/* Sensors */}
              {kiwiSensors.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('soilSensors')}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {kiwiSensors.map((device) => (
                      <div key={device.deveui} className="relative">
                        <KiwiSensorCard
                          device={device}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                        />
                        {removingDevice === device.deveui && (
                          <div className="absolute inset-0 bg-[var(--overlay)]/70 flex items-center justify-center rounded-xl">
                            <div className="animate-spin h-8 w-8 border-4 border-[var(--primary)] border-t-transparent rounded-full" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Valves */}
              {stregaValves.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('smartValves')}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {stregaValves.map((device) => (
                      <div key={device.deveui} className="relative">
                        <StregaValveCard
                          device={device}
                          onUpdate={onUpdate}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                        />
                        {removingDevice === device.deveui && (
                          <div className="absolute inset-0 bg-[var(--overlay)]/70 flex items-center justify-center rounded-xl">
                            <div className="animate-spin h-8 w-8 border-4 border-[var(--primary)] border-t-transparent rounded-full" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* LSN50 Nodes */}
              {lsn50Nodes.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">Dragino LSN50 Nodes</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {lsn50Nodes.map((device) => (
                      <div key={device.deveui} className="relative">
                        <DraginoTempCard
                          device={device}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                        />
                        {removingDevice === device.deveui && (
                          <div className="absolute inset-0 bg-[var(--overlay)]/70 flex items-center justify-center rounded-xl">
                            <div className="animate-spin h-8 w-8 border-4 border-[var(--primary)] border-t-transparent rounded-full" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3 bg-[var(--card)] rounded-lg p-6 text-center">
              <p className="text-[var(--text-tertiary)] text-lg mb-3">{t('zone.noDevices')}</p>
              <button
                onClick={() => setShowAssignModal(true)}
                className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-6 py-3 rounded-lg transition-colors"
              >
                {t('zone.assignFirst')}
              </button>
            </div>
          )
        )}
      </div>

      </>
      )} {/* end !zoneCollapsed */}

      {/* Assign Device Modal */}
      <AssignDeviceModal
        isOpen={showAssignModal}
        onClose={() => setShowAssignModal(false)}
        onDeviceAssigned={onUpdate}
        zoneId={zone.id}
        zoneName={zone.name}
        availableDevices={unassignedDevices}
      />

      <ZoneConfigModal
        isOpen={showConfigModal}
        zone={zone}
        onClose={() => setShowConfigModal(false)}
        onSaved={onUpdate}
      />

      <AdvancedScheduleDrawer
        isOpen={showAdvancedDrawer}
        zone={zone}
        onClose={() => setShowAdvancedDrawer(false)}
        onSaved={onUpdate}
      />
    </div>
  );
};
