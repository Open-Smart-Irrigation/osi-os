import React, { useState, useEffect } from 'react';
import type { GatewayLocation, IrrigationZone } from '../../types/farming';
import { gatewayLocationAPI, irrigationZonesAPI } from '../../services/api';
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

  // Sync when zone prop changes (e.g. after onSaved refresh)
  useEffect(() => {
    setCropType(zone.cropType ?? '');
    setVariety(zone.variety ?? '');
    setSoilType(zone.soilType ?? '');
    setIrrigationMethod(zone.irrigationMethod ?? '');
    setNotes(zone.notes ?? '');
    setTimezone(zone.timezone ?? 'UTC');
    setPhenologicalStage(zone.phenologicalStage ?? 'default');
    setCalibrationKey(zone.calibrationKey ?? 'default');
    setLatitude(zone.latitude != null ? String(zone.latitude) : '');
    setLongitude(zone.longitude != null ? String(zone.longitude) : '');
  }, [zone]);

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
      return;
    }
    void loadGatewayLocation(gatewayDeviceEui);
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
      notes?: string | null;
      timezone?: string | null;
      phenologicalStage?: string | null;
      calibrationKey?: string | null;
    } = {};

    if ((zone.cropType ?? '') !== cropType) payload.cropType = cropType || null;
    if ((zone.variety ?? '') !== variety) payload.variety = variety || null;
    if ((zone.soilType ?? '') !== soilType) payload.soilType = soilType || null;
    if ((zone.irrigationMethod ?? '') !== irrigationMethod) payload.irrigationMethod = irrigationMethod || null;
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
