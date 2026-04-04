import React, { useState, useEffect } from 'react';
import type { GatewayLocation, IrrigationZone } from '../../types/farming';
import { gatewayLocationAPI, irrigationZonesAPI } from '../../services/api';
import {
  getDeviceLocationErrorMessage,
  getDeviceLocationSupport,
  openNativeLocationSettings,
  requestDeviceLocation,
  type DeviceLocationCapture,
  type DeviceLocationSupport,
} from '../../services/deviceLocation';
import { CROP_GROUPS } from './cropKc';

interface Props {
  isOpen: boolean;
  zone: IrrigationZone;
  onClose: () => void;
  onSaved: () => void;
}

const SOIL_OPTIONS = [
  { value: '', label: '— Select soil type —' },
  { value: 'sandy', label: 'Sandy' },
  { value: 'sandy_loam', label: 'Sandy Loam' },
  { value: 'loam', label: 'Loam' },
  { value: 'clay_loam', label: 'Clay Loam' },
  { value: 'clay', label: 'Clay' },
  { value: 'silt_loam', label: 'Silt Loam' },
  { value: 'other', label: 'Other' },
];

const IRRIGATION_METHODS = [
  { value: '', label: '— Select method —' },
  { value: 'drip', label: 'Drip / Micro-drip' },
  { value: 'sprinkler', label: 'Sprinkler' },
  { value: 'furrow', label: 'Furrow' },
  { value: 'flood', label: 'Flood / Basin' },
  { value: 'subsurface', label: 'Subsurface drip' },
  { value: 'other', label: 'Other' },
];

const CALIBRATION_KEYS = [
  { value: 'default', label: 'Default (generic thresholds)' },
  { value: 'apple', label: 'Apple' },
  { value: 'grapevine', label: 'Grapevine' },
  { value: 'olive', label: 'Olive' },
];

const PHENOLOGICAL_STAGES = [
  { value: 'default', label: 'Default' },
  { value: 'dormancy', label: 'Dormancy' },
  { value: 'budbreak', label: 'Bud break / flowering' },
  { value: 'fruitset', label: 'Fruit set' },
  { value: 'veraison', label: 'Veraison / ripening' },
  { value: 'harvest', label: 'Harvest / post-harvest' },
];

export const ZoneConfigModal: React.FC<Props> = ({ isOpen, zone, onClose, onSaved }) => {
  const gatewayDeviceEui = zone.gatewayDeviceEui ?? zone.gateway_device_eui ?? null;
  const [cropType, setCropType] = useState(zone.cropType ?? '');
  const [variety, setVariety] = useState(zone.variety ?? '');
  const [soilType, setSoilType] = useState(zone.soilType ?? '');
  const [irrigationMethod, setIrrigationMethod] = useState(zone.irrigationMethod ?? '');
  const [areaM2, setAreaM2] = useState(zone.areaM2 != null ? String(zone.areaM2) : '');
  const [irrigationEfficiencyPct, setIrrigationEfficiencyPct] = useState(
    zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : ''
  );
  const [notes, setNotes] = useState(zone.notes ?? '');
  const [timezone, setTimezone] = useState(zone.timezone ?? 'UTC');
  const [phenologicalStage, setPhenologicalStage] = useState(zone.phenologicalStage ?? 'default');
  const [calibrationKey, setCalibrationKey] = useState(zone.calibrationKey ?? 'default');
  const [latitude, setLatitude] = useState(zone.latitude != null ? String(zone.latitude) : '');
  const [longitude, setLongitude] = useState(zone.longitude != null ? String(zone.longitude) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gatewayLocation, setGatewayLocation] = useState<GatewayLocation | null>(null);
  const [gatewayLocationLoading, setGatewayLocationLoading] = useState(false);
  const [gatewayLocationError, setGatewayLocationError] = useState<string | null>(null);
  const [deviceLocationSupport, setDeviceLocationSupport] = useState<DeviceLocationSupport | null>(null);
  const [deviceLocationSupportLoading, setDeviceLocationSupportLoading] = useState(false);
  const [deviceLocationLoading, setDeviceLocationLoading] = useState(false);
  const [deviceLocationError, setDeviceLocationError] = useState<string | null>(null);
  const [deviceLocationMeta, setDeviceLocationMeta] = useState<DeviceLocationCapture | null>(null);

  // Sync when zone prop changes (e.g. after onSaved refresh)
  useEffect(() => {
    setCropType(zone.cropType ?? '');
    setVariety(zone.variety ?? '');
    setSoilType(zone.soilType ?? '');
    setIrrigationMethod(zone.irrigationMethod ?? '');
    setAreaM2(zone.areaM2 != null ? String(zone.areaM2) : '');
    setIrrigationEfficiencyPct(zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : '');
    setNotes(zone.notes ?? '');
    setTimezone(zone.timezone ?? 'UTC');
    setPhenologicalStage(zone.phenologicalStage ?? 'default');
    setCalibrationKey(zone.calibrationKey ?? 'default');
    setLatitude(zone.latitude != null ? String(zone.latitude) : '');
    setLongitude(zone.longitude != null ? String(zone.longitude) : '');
    setDeviceLocationError(null);
    setDeviceLocationMeta(null);
  }, [zone]);

  const refreshDeviceLocationSupport = async () => {
    setDeviceLocationSupportLoading(true);
    try {
      const support = await getDeviceLocationSupport();
      setDeviceLocationSupport(support);
      if (support.reason !== 'permission_denied') {
        setDeviceLocationError(null);
      } else if (!deviceLocationError) {
        setDeviceLocationError(support.message);
      }
    } finally {
      setDeviceLocationSupportLoading(false);
    }
  };

  const loadGatewayLocation = async (currentGatewayEui: string) => {
    setGatewayLocationLoading(true);
    setGatewayLocationError(null);
    try {
      const location = await gatewayLocationAPI.getForGateway(currentGatewayEui);
      setGatewayLocation(location);
    } catch (err: any) {
      setGatewayLocation(null);
      setGatewayLocationError(err.response?.data?.message ?? err.message ?? 'Failed to load gateway GPS');
    } finally {
      setGatewayLocationLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    if (!gatewayDeviceEui) {
      setGatewayLocation(null);
      setGatewayLocationError(null);
    } else {
      void loadGatewayLocation(gatewayDeviceEui);
    }
    void refreshDeviceLocationSupport();
  }, [gatewayDeviceEui, isOpen]);

  if (!isOpen) return null;

  const trimmedLatitude = latitude.trim();
  const trimmedLongitude = longitude.trim();

  const buildConfigPayload = () => {
    const payload: {
      cropType?: string | null;
      variety?: string | null;
      soilType?: string | null;
      irrigationMethod?: string | null;
      areaM2?: number | null;
      irrigationEfficiencyPct?: number | null;
      notes?: string | null;
      timezone?: string | null;
      phenologicalStage?: string | null;
      calibrationKey?: string | null;
    } = {};

    if ((zone.cropType ?? '') !== cropType) payload.cropType = cropType || null;
    if ((zone.variety ?? '') !== variety) payload.variety = variety || null;
    if ((zone.soilType ?? '') !== soilType) payload.soilType = soilType || null;
    if ((zone.irrigationMethod ?? '') !== irrigationMethod) payload.irrigationMethod = irrigationMethod || null;
    if ((zone.areaM2 != null ? String(zone.areaM2) : '') !== areaM2) payload.areaM2 = areaM2.trim() ? Number(areaM2) : null;
    if ((zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : '') !== irrigationEfficiencyPct) {
      payload.irrigationEfficiencyPct = irrigationEfficiencyPct.trim() ? Number(irrigationEfficiencyPct) : null;
    }
    if ((zone.notes ?? '') !== notes) payload.notes = notes || null;
    if ((zone.timezone ?? 'UTC') !== timezone) payload.timezone = timezone;
    if ((zone.phenologicalStage ?? 'default') !== phenologicalStage) payload.phenologicalStage = phenologicalStage;
    if ((zone.calibrationKey ?? 'default') !== calibrationKey) payload.calibrationKey = calibrationKey;

    return payload;
  };

  const parseLocationPayload = () => {
    if (trimmedLatitude === '' && trimmedLongitude === '') return null;
    if (trimmedLatitude === '' || trimmedLongitude === '') {
      throw new Error('Enter both latitude and longitude or leave both blank.');
    }
    const parsedLatitude = Number(trimmedLatitude);
    const parsedLongitude = Number(trimmedLongitude);
    if (!Number.isFinite(parsedLatitude) || parsedLatitude < -90 || parsedLatitude > 90) {
      throw new Error('Latitude must be between -90 and 90.');
    }
    if (!Number.isFinite(parsedLongitude) || parsedLongitude < -180 || parsedLongitude > 180) {
      throw new Error('Longitude must be between -180 and 180.');
    }
    return { latitude: parsedLatitude, longitude: parsedLongitude };
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const configPayload = buildConfigPayload();
      const locationPayload = parseLocationPayload();
      const hasConfigChanges = Object.keys(configPayload).length > 0;
      const locationChanged = locationPayload != null
        && (locationPayload.latitude !== zone.latitude || locationPayload.longitude !== zone.longitude);

      if (hasConfigChanges) {
        await irrigationZonesAPI.updateConfig(zone.id, configPayload);
      }
      if (locationChanged) {
        await irrigationZonesAPI.setZoneLocation(zone.id, locationPayload);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const useGatewayLocation = () => {
    if (gatewayLocation?.latitude == null || gatewayLocation.longitude == null) return;
    setLatitude(String(gatewayLocation.latitude));
    setLongitude(String(gatewayLocation.longitude));
    setError(null);
    setDeviceLocationError(null);
  };

  const useDeviceLocation = async () => {
    setDeviceLocationLoading(true);
    setDeviceLocationError(null);
    try {
      const capture = await requestDeviceLocation();
      setLatitude(String(capture.latitude));
      setLongitude(String(capture.longitude));
      setDeviceLocationMeta(capture);
      setError(null);
    } catch (err) {
      setDeviceLocationError(getDeviceLocationErrorMessage(err));
    } finally {
      setDeviceLocationLoading(false);
      void refreshDeviceLocationSupport();
    }
  };

  const handleOpenLocationSettings = () => {
    if (!openNativeLocationSettings()) {
      setDeviceLocationError('Open the app settings and enable location permission, then try again.');
    }
  };

  const gatewayStatusLabel = gatewayLocation?.status === 'live'
    ? 'Live'
    : gatewayLocation?.status === 'stale'
      ? 'Stale'
      : 'No fix';

  const gatewayStatusClass = gatewayLocation?.status === 'live'
    ? 'bg-emerald-100 text-emerald-800'
    : gatewayLocation?.status === 'stale'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-700';

  const gatewayAgeSource = gatewayLocation?.lastFixAt ?? gatewayLocation?.lastGoodFixAt ?? null;
  const gatewayAgeLabel = gatewayAgeSource
    ? `${Math.max(0, Math.round((Date.now() - new Date(gatewayAgeSource).getTime()) / 60000))} min ago`
    : 'No recent fix';

  const canRequestDeviceLocation = Boolean(deviceLocationSupport?.available && !deviceLocationLoading);
  const deviceLocationStatusClass = deviceLocationSupport?.available
    ? 'bg-emerald-100 text-emerald-800'
    : deviceLocationSupport?.reason === 'permission_denied'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-700';
  const deviceLocationStatusLabel = deviceLocationSupport?.available
    ? 'Available'
    : deviceLocationSupport?.reason === 'permission_denied'
      ? 'Permission needed'
      : deviceLocationSupportLoading
        ? 'Checking…'
        : 'Unavailable';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-[var(--border)]">
          <h2 className="text-xl font-bold text-[var(--text)]">Configure Zone — {zone.name}</h2>
          <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text)] text-2xl leading-none">&times;</button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 text-sm">{error}</div>
          )}

          {/* Crop & Variety */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Crop</p>
            <div className="flex gap-2">
              <select
                value={cropType}
                onChange={e => setCropType(e.target.value)}
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
              >
                <option value="">— Select crop —</option>
                {CROP_GROUPS.map(g => (
                  <optgroup key={g.groupLabel} label={g.groupLabel}>
                    {g.crops.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </optgroup>
                ))}
                <option value="other">Other / Custom</option>
              </select>
              <input
                type="text"
                value={variety}
                onChange={e => setVariety(e.target.value)}
                placeholder="Variety (optional)"
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          </div>

          {/* Soil type */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Soil type</p>
            <select
              value={soilType}
              onChange={e => setSoilType(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {SOIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Irrigation method */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Irrigation method</p>
            <select
              value={irrigationMethod}
              onChange={e => setIrrigationMethod(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {IRRIGATION_METHODS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Area</p>
              <input
                type="number"
                min="0"
                step="0.1"
                value={areaM2}
                onChange={e => setAreaM2(e.target.value)}
                placeholder="m²"
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">Used to convert irrigation liters into effective mm for the water balance.</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Irrigation efficiency</p>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={irrigationEfficiencyPct}
                onChange={e => setIrrigationEfficiencyPct(e.target.value)}
                placeholder="%"
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">Enter the estimated share of delivered water that reaches the crop root zone.</p>
            </div>
          </div>

          <hr className="border-[var(--border)]" />

          {/* Calibration */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Dendro calibration</p>
            <select
              value={calibrationKey}
              onChange={e => setCalibrationKey(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {CALIBRATION_KEYS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Selects species-specific stress thresholds for dendrometer analysis.</p>
          </div>

          {/* Phenological stage */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Phenological stage</p>
            <select
              value={phenologicalStage}
              onChange={e => setPhenologicalStage(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {PHENOLOGICAL_STAGES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Adjusts stress sensitivity for the current growth phase.</p>
          </div>

          {/* Timezone */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Timezone</p>
            <input
              type="text"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder="e.g. Europe/Rome"
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
            />
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Used to align nightly min/max extraction windows. IANA timezone (e.g. Europe/Rome).</p>
          </div>

          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Zone location</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="number"
                value={latitude}
                onChange={e => setLatitude(e.target.value)}
                placeholder="Latitude"
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
              <input
                type="number"
                value={longitude}
                onChange={e => setLongitude(e.target.value)}
                placeholder="Longitude"
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Used for weather and VPD lookup. Save both coordinates together.</p>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">Gateway GPS</p>
                <p className="text-sm text-[var(--text)]">
                  {gatewayDeviceEui ? `Gateway ${gatewayDeviceEui}` : 'No linked gateway for this zone'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => gatewayDeviceEui && void loadGatewayLocation(gatewayDeviceEui)}
                disabled={!gatewayDeviceEui || gatewayLocationLoading}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)] disabled:opacity-50"
              >
                {gatewayLocationLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {gatewayDeviceEui && !gatewayLocationError && (
              <div className="mt-3 space-y-2 text-sm text-[var(--text)]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${gatewayStatusClass}`}>{gatewayStatusLabel}</span>
                  <span className="text-[var(--text-tertiary)]">Last update {gatewayAgeLabel}</span>
                </div>
                <p>
                  {gatewayLocation?.latitude != null && gatewayLocation.longitude != null
                    ? `${gatewayLocation.latitude.toFixed(6)}, ${gatewayLocation.longitude.toFixed(6)}`
                    : 'Gateway GPS has not produced a coordinate fix yet.'}
                </p>
                {gatewayLocation?.altitudeM != null && (
                  <p className="text-xs text-[var(--text-tertiary)]">
                    Altitude {gatewayLocation.altitudeM.toFixed(1)} m
                    {gatewayLocation.accuracyM != null ? `, accuracy ~${gatewayLocation.accuracyM.toFixed(1)} m` : ''}
                  </p>
                )}
                <button
                  type="button"
                  onClick={useGatewayLocation}
                  disabled={gatewayLocation?.latitude == null || gatewayLocation.longitude == null}
                  className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
                >
                  Use gateway location
                </button>
              </div>
            )}

            {gatewayLocationError && (
              <p className="mt-3 text-xs text-[var(--text-tertiary)]">{gatewayLocationError}</p>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">Device GPS</p>
                <p className="text-sm text-[var(--text)]">Use your phone or browser location for this zone.</p>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  Fills latitude and longitude from this device. Review timezone separately if the farm is in a different timezone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void useDeviceLocation()}
                disabled={!canRequestDeviceLocation}
                className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
              >
                {deviceLocationLoading ? 'Locating…' : 'Use device location'}
              </button>
            </div>

            <div className="mt-3 space-y-2 text-sm text-[var(--text)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${deviceLocationStatusClass}`}>{deviceLocationStatusLabel}</span>
                {deviceLocationSupport?.permissionState && deviceLocationSupport.permissionState !== 'unknown' && (
                  <span className="text-[var(--text-tertiary)]">
                    Permission {deviceLocationSupport.permissionState}
                  </span>
                )}
              </div>
              <p>{deviceLocationSupport?.message ?? 'Checking whether device GPS is available…'}</p>
              {deviceLocationMeta && (
                <div className="space-y-1">
                  <p>
                    {trimmedLatitude && trimmedLongitude
                      ? `${Number(trimmedLatitude).toFixed(6)}, ${Number(trimmedLongitude).toFixed(6)}`
                      : 'Device location captured.'}
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    Captured {new Date(deviceLocationMeta.capturedAt).toLocaleString()}
                    {deviceLocationMeta.accuracyM != null ? `, accuracy ~${deviceLocationMeta.accuracyM.toFixed(1)} m` : ''}
                    {deviceLocationMeta.source === 'native-app' ? ', via mobile app' : ', via browser'}
                  </p>
                </div>
              )}
              {deviceLocationSupport?.canOpenSettings && deviceLocationSupport.reason === 'permission_denied' && (
                <button
                  type="button"
                  onClick={handleOpenLocationSettings}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)]"
                >
                  Open app settings
                </button>
              )}
            </div>

            {deviceLocationError && (
              <p className="mt-3 text-xs text-red-700">{deviceLocationError}</p>
            )}
          </div>

          <hr className="border-[var(--border)]" />

          {/* Notes */}
          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">Notes</p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Any additional info about this zone…"
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)] resize-none"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end p-5 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] px-5 py-2 rounded-lg text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-60 text-white px-5 py-2 rounded-lg text-sm font-semibold"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
