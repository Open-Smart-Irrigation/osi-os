import React, { useState, useEffect } from 'react';
import type { IrrigationZone } from '../../types/farming';
import { irrigationZonesAPI } from '../../services/api';

interface Props {
  isOpen: boolean;
  zone: IrrigationZone;
  onClose: () => void;
  onSaved: () => void;
}

const CROP_OPTIONS = [
  { value: '', label: '— Select crop —' },
  { value: 'apple', label: 'Apple' },
  { value: 'grapevine', label: 'Grapevine' },
  { value: 'olive', label: 'Olive' },
  { value: 'citrus', label: 'Citrus' },
  { value: 'peach', label: 'Peach / Nectarine' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'pear', label: 'Pear' },
  { value: 'plum', label: 'Plum' },
  { value: 'walnut', label: 'Walnut' },
  { value: 'almond', label: 'Almond' },
  { value: 'other', label: 'Other' },
];

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
                {CROP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
