import React, { useState } from 'react';
import type { IrrigationZone, Device } from '../../types/farming';
import { irrigationZonesAPI } from '../../services/api';
import { KiwiSensorCard } from './KiwiSensorCard';
import { StregaValveCard } from './StregaValveCard';
import { ScheduleSection } from './ScheduleSection';
import { AssignDeviceModal } from './AssignDeviceModal';

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
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingDevice, setRemovingDevice] = useState<string | null>(null);

  const handleDeleteZone = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await irrigationZonesAPI.delete(zone.id);
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete zone');
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
      setError(err.response?.data?.message || 'Failed to remove device from zone');
    } finally {
      setRemovingDevice(null);
    }
  };

  const kiwiSensors = devices.filter((d) => d.type_id === 'KIWI_SENSOR');
  const stregaValves = devices.filter((d) => d.type_id === 'STREGA_VALVE');

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--border)] rounded-xl p-6 shadow-lg mb-6">
      {/* Zone Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-3xl font-bold text-[var(--text)] mb-1 high-contrast-text">
            {zone.name}
          </h3>
          <p className="text-[var(--text-secondary)] text-sm">
            {zone.device_count} device{zone.device_count !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAssignModal(true)}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            title="Assign device to zone"
          >
            + Device
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeleting}
            className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            title="Delete zone"
          >
            Delete
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {showDeleteConfirm && (
        <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
          <p className="font-bold mb-2">Delete this zone?</p>
          <p className="text-sm mb-3">
            All devices will be unassigned from this zone. This action cannot be undone.
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
                  Deleting...
                </>
              ) : (
                'Yes, Delete'
              )}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Schedule Section */}
      <ScheduleSection zoneId={zone.id} zoneName={zone.name} />

      {/* Devices in Zone */}
      {devices.length > 0 ? (
        <div>
          <h4 className="text-[var(--text)] text-xl font-bold mb-3">Devices in this zone:</h4>

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
        </div>
      ) : (
        <div className="bg-[var(--card)] rounded-lg p-6 text-center">
          <p className="text-[var(--text-tertiary)] text-lg mb-3">No devices in this zone yet</p>
          <button
            onClick={() => setShowAssignModal(true)}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-6 py-3 rounded-lg transition-colors"
          >
            Assign First Device
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
    </div>
  );
};
