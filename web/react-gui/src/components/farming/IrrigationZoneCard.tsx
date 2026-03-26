import React, { useState } from 'react';
import type { IrrigationZone, Device } from '../../types/farming';
import { irrigationZonesAPI } from '../../services/api';
import { KiwiSensorCard } from './KiwiSensorCard';
import { DraginoTempCard } from './DraginoTempCard';
import { StregaValveCard } from './StregaValveCard';
import { ScheduleSection } from './ScheduleSection';
import { AssignDeviceModal } from './AssignDeviceModal';
import { DendrometerSection } from './dendrometer/DendrometerSection';
import { ZoneConfigModal } from './ZoneConfigModal';
import { AdvancedScheduleDrawer } from './AdvancedScheduleDrawer';
import { useTranslation } from 'react-i18next';

interface IrrigationZoneCardProps {
  zone: IrrigationZone;
  devices: Device[];
  unassignedDevices: Device[];
  onUpdate: () => void;
}

export const IrrigationZoneCard: React.FC<IrrigationZoneCardProps> = ({
  zone,
  devices,
  unassignedDevices,
  onUpdate,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showAdvancedDrawer, setShowAdvancedDrawer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingDevice, setRemovingDevice] = useState<string | null>(null);

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

  const kiwiSensors = devices.filter((d) => d.type_id === 'KIWI_SENSOR');
  const stregaValves = devices.filter((d) => d.type_id === 'STREGA_VALVE');
  const lsn50Nodes = devices.filter((d) => d.type_id === 'DRAGINO_LSN50');

  const hasDendroDevices = lsn50Nodes.some(d => d.dendro_enabled === 1);
  const schedMetric = zone.schedule?.triggerMetric ?? zone.schedule?.trigger_metric;
  const schedEnabled = zone.schedule?.enabled ?? false;
  const cropType = zone.cropType;
  const soilType = zone.soilType;

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--border)] rounded-xl p-6 shadow-lg mb-6">
      {/* Zone Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h3 className="text-3xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {zone.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">
            {t('zone.deviceCount', { count: zone.device_count })}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowConfigModal(true)}
            className="bg-[var(--surface)] hover:bg-[var(--border)] border border-[var(--border)] text-[var(--text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            Configure
          </button>
          <button
            onClick={() => setShowAssignModal(true)}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            title="Assign device to zone"
          >
            {t('zone.assignDevice')}
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeleting}
            className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            title="Delete zone"
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

      {/* Devices in Zone */}
      {devices.length > 0 ? (
        <div>
          <h4 className="text-[var(--text)] text-xl font-bold mb-3">{t('zone.devicesInZone')}</h4>

          {/* Sensors */}
          {kiwiSensors.length > 0 && (
            <div className="mb-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {kiwiSensors.map((device) => (
                  <div key={device.deveui} className="relative">
                    <KiwiSensorCard device={device} onRemove={() => handleRemoveDevice(device.deveui)} />
                    {removingDevice === device.deveui && (
                      <div className="absolute inset-0 bg-[var(--overlay)] flex items-center justify-center rounded-xl">
                        <div className="animate-spin h-8 w-8 border-4 border-white border-t-transparent rounded-full" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Valves */}
          {stregaValves.length > 0 && (
            <div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stregaValves.map((device) => (
                  <div key={device.deveui} className="relative">
                    <StregaValveCard
                      device={device}
                      onUpdate={onUpdate}
                      onRemove={() => handleRemoveDevice(device.deveui)}
                    />
                    {removingDevice === device.deveui && (
                      <div className="absolute inset-0 bg-[var(--overlay)] flex items-center justify-center rounded-xl">
                        <div className="animate-spin h-8 w-8 border-4 border-white border-t-transparent rounded-full" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* LSN50 Nodes */}
          {lsn50Nodes.length > 0 && (
            <div className="mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {lsn50Nodes.map((device) => (
                  <div key={device.deveui} className="relative">
                    <DraginoTempCard
                      device={device}
                      onRemove={() => handleRemoveDevice(device.deveui)}
                    />
                    {removingDevice === device.deveui && (
                      <div className="absolute inset-0 bg-[var(--overlay)] flex items-center justify-center rounded-xl">
                        <div className="animate-spin h-8 w-8 border-4 border-white border-t-transparent rounded-full" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-[var(--card)] rounded-lg p-6 text-center">
          <p className="text-[var(--text-tertiary)] text-lg mb-3">{t('zone.noDevices')}</p>
          <button
            onClick={() => setShowAssignModal(true)}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-6 py-3 rounded-lg transition-colors"
          >
            {t('zone.assignFirst')}
          </button>
        </div>
      )}

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
