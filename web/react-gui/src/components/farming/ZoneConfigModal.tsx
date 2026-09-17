import React, { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { IrrigationZone } from '../../types/farming';
import { irrigationZonesAPI } from '../../services/api';
import {
  getDeviceLocationErrorMessage,
  getDeviceLocationSupport,
  openNativeLocationSettings,
  requestDeviceLocation,
  type DeviceLocationCapture,
  type DeviceLocationSupport,
} from '../../services/deviceLocation';
import { CROP_GROUPS } from './cropKc';
import { DataExportSection } from './DataExportSection';
import { TimezoneInput } from './TimezoneInput';
import { useDateFormat } from '../../utils/datetime';

interface Props {
  isOpen: boolean;
  zone: IrrigationZone;
  onClose: () => void;
  onSaved: () => void;
}

type Translate = TFunction<'devices'>;

/**
 * Option lists as `{ value, key, fallback }`: the value is what the API
 * stores, the key is what the seven bundles translate, and the fallback is the
 * English source text this file used to render directly.
 */
interface Option { value: string; key: string; fallback: string }

const SOIL_OPTIONS: Option[] = [
  { value: '', key: 'soil.select', fallback: '— Select soil type —' },
  { value: 'sandy', key: 'soil.sandy', fallback: 'Sandy' },
  { value: 'sandy_loam', key: 'soil.sandy_loam', fallback: 'Sandy loam' },
  { value: 'loam', key: 'soil.loam', fallback: 'Loam' },
  { value: 'clay_loam', key: 'soil.clay_loam', fallback: 'Clay loam' },
  { value: 'clay', key: 'soil.clay', fallback: 'Clay' },
  { value: 'silt_loam', key: 'soil.silt_loam', fallback: 'Silt loam' },
  { value: 'other', key: 'soil.other', fallback: 'Other' },
];

const IRRIGATION_METHODS: Option[] = [
  { value: '', key: 'method.select', fallback: '— Select method —' },
  { value: 'drip', key: 'method.drip', fallback: 'Drip / micro-drip' },
  { value: 'sprinkler', key: 'method.sprinkler', fallback: 'Sprinkler' },
  { value: 'furrow', key: 'method.furrow', fallback: 'Furrow' },
  { value: 'flood', key: 'method.flood', fallback: 'Flood / basin' },
  { value: 'subsurface', key: 'method.subsurface', fallback: 'Subsurface drip' },
  { value: 'other', key: 'method.other', fallback: 'Other' },
];

const CALIBRATION_KEYS: Option[] = [
  { value: 'default', key: 'calibration.default', fallback: 'Default (generic thresholds)' },
  { value: 'apple', key: 'calibration.apple', fallback: 'Apple' },
  { value: 'grapevine', key: 'calibration.grapevine', fallback: 'Grapevine' },
  { value: 'olive', key: 'calibration.olive', fallback: 'Olive' },
];

const PHENOLOGICAL_STAGES: Option[] = [
  { value: 'default', key: 'stage.default', fallback: 'Default' },
  { value: 'dormancy', key: 'stage.dormancy', fallback: 'Dormancy' },
  { value: 'budbreak', key: 'stage.budbreak', fallback: 'Bud break / flowering' },
  { value: 'fruitset', key: 'stage.fruitset', fallback: 'Fruit set' },
  { value: 'veraison', key: 'stage.veraison', fallback: 'Veraison / ripening' },
  { value: 'harvest', key: 'stage.harvest', fallback: 'Harvest / post-harvest' },
];

function optionLabel(t: Translate, option: Option): string {
  return t(`zoneConfig.${option.key}`, { defaultValue: option.fallback });
}

export const ZoneConfigModal: React.FC<Props> = ({ isOpen, zone, onClose, onSaved }) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  // One id prefix per mounted modal, so a dashboard with several zone cards
  // open does not produce duplicate control ids.
  const dateFormat = useDateFormat();
  const fieldId = useId();
  const id = (name: string) => `zone-config-${name}-${fieldId}`;
  const [cropType, setCropType] = useState(zone.cropType ?? '');
  const [variety, setVariety] = useState(zone.variety ?? '');
  const [soilType, setSoilType] = useState(zone.soilType ?? '');
  const [irrigationMethod, setIrrigationMethod] = useState(zone.irrigationMethod ?? '');
  const [areaM2, setAreaM2] = useState(zone.areaM2 != null ? String(zone.areaM2) : '');
  const [irrigationEfficiencyPct, setIrrigationEfficiencyPct] = useState(
    zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : ''
  );
  const [measuredFlowRateLpm, setMeasuredFlowRateLpm] = useState(
    zone.measuredFlowRateLpm != null ? String(zone.measuredFlowRateLpm) : ''
  );
  const [measurementMethod, setMeasurementMethod] = useState(zone.measurementMethod ?? '');
  const [notes, setNotes] = useState(zone.notes ?? '');
  const [timezone, setTimezone] = useState(zone.timezone ?? 'UTC');
  const [phenologicalStage, setPhenologicalStage] = useState(zone.phenologicalStage ?? 'default');
  const [calibrationKey, setCalibrationKey] = useState(zone.calibrationKey ?? 'default');
  const [latitude, setLatitude] = useState(zone.latitude != null ? String(zone.latitude) : '');
  const [longitude, setLongitude] = useState(zone.longitude != null ? String(zone.longitude) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceLocationSupport, setDeviceLocationSupport] = useState<DeviceLocationSupport | null>(null);
  const [deviceLocationSupportLoading, setDeviceLocationSupportLoading] = useState(false);
  const [deviceLocationLoading, setDeviceLocationLoading] = useState(false);
  const [deviceLocationError, setDeviceLocationError] = useState<string | null>(null);
  const [deviceLocationMeta, setDeviceLocationMeta] = useState<DeviceLocationCapture | null>(null);
  const hasLegacyCrop = Boolean(
    cropType && !CROP_GROUPS.some(group => group.crops.some(crop => crop.value === cropType))
  );

  // Sync when zone prop changes (e.g. after onSaved refresh)
  useEffect(() => {
    setCropType(zone.cropType ?? '');
    setVariety(zone.variety ?? '');
    setSoilType(zone.soilType ?? '');
    setIrrigationMethod(zone.irrigationMethod ?? '');
    setAreaM2(zone.areaM2 != null ? String(zone.areaM2) : '');
    setIrrigationEfficiencyPct(zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : '');
    setMeasuredFlowRateLpm(zone.measuredFlowRateLpm != null ? String(zone.measuredFlowRateLpm) : '');
    setMeasurementMethod(zone.measurementMethod ?? '');
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

  useEffect(() => {
    if (!isOpen) return;
    void refreshDeviceLocationSupport();
  }, [isOpen]);

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
      throw new Error(t('zoneConfig.errors.bothCoordinates', {
        defaultValue: 'Enter both latitude and longitude or leave both blank.',
      }));
    }
    const parsedLatitude = Number(trimmedLatitude);
    const parsedLongitude = Number(trimmedLongitude);
    if (!Number.isFinite(parsedLatitude) || parsedLatitude < -90 || parsedLatitude > 90) {
      throw new Error(t('zoneConfig.errors.latitudeRange', { defaultValue: 'Latitude must be between -90 and 90.' }));
    }
    if (!Number.isFinite(parsedLongitude) || parsedLongitude < -180 || parsedLongitude > 180) {
      throw new Error(t('zoneConfig.errors.longitudeRange', { defaultValue: 'Longitude must be between -180 and 180.' }));
    }
    return { latitude: parsedLatitude, longitude: parsedLongitude };
  };

  const parseCalibrationPayload = () => {
    const flowRateChanged = (zone.measuredFlowRateLpm != null ? String(zone.measuredFlowRateLpm) : '') !== measuredFlowRateLpm;
    const methodChanged = (zone.measurementMethod ?? '') !== measurementMethod;
    if (!flowRateChanged && !methodChanged) return null;

    const trimmedFlowRate = measuredFlowRateLpm.trim();
    if (!trimmedFlowRate) {
      throw new Error(t('zoneConfig.errors.flowRateRequired', {
        defaultValue: 'Flow rate (L/min) is required to save irrigation calibration.',
      }));
    }
    const parsedFlowRate = Number(trimmedFlowRate);
    if (!Number.isFinite(parsedFlowRate) || parsedFlowRate <= 0) {
      throw new Error(t('zoneConfig.errors.flowRatePositive', { defaultValue: 'Flow rate (L/min) must be greater than 0.' }));
    }
    return {
      measuredFlowRateLpm: parsedFlowRate,
      measurementMethod: measurementMethod.trim() || null,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const configPayload = buildConfigPayload();
      const locationPayload = parseLocationPayload();
      const calibrationPayload = parseCalibrationPayload();
      const hasConfigChanges = Object.keys(configPayload).length > 0;
      const locationChanged = locationPayload != null
        && (locationPayload.latitude !== zone.latitude || locationPayload.longitude !== zone.longitude);

      if (hasConfigChanges) {
        await irrigationZonesAPI.updateConfig(zone.id, configPayload);
      }
      if (calibrationPayload) {
        await irrigationZonesAPI.updateCalibration(zone.id, calibrationPayload);
      }
      if (locationChanged) {
        await irrigationZonesAPI.setZoneLocation(zone.id, locationPayload);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? t('zoneConfig.errors.saveFailed', { defaultValue: 'Failed to save' }));
    } finally {
      setSaving(false);
    }
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
      setDeviceLocationError(t('zoneConfig.openSettingsHint', {
        defaultValue: 'Open the app settings and enable location permission, then try again.',
      }));
    }
  };

  const canRequestDeviceLocation = Boolean(deviceLocationSupport?.available && !deviceLocationLoading);
  const todayIso = new Date().toISOString().slice(0, 10);
  const deviceLocationStatusClass = deviceLocationSupport?.available
    ? 'bg-emerald-100 text-emerald-800'
    : deviceLocationSupport?.reason === 'permission_denied'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-700';
  const deviceLocationStatusLabel = deviceLocationSupport?.available
    ? t('zoneConfig.gps.available', { defaultValue: 'Available' })
    : deviceLocationSupport?.reason === 'permission_denied'
      ? t('zoneConfig.gps.permissionNeeded', { defaultValue: 'Permission needed' })
      : deviceLocationSupportLoading
        ? t('zoneConfig.gps.checking', { defaultValue: 'Checking…' })
        : t('zoneConfig.gps.unavailable', { defaultValue: 'Unavailable' });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-[var(--border)]">
          <h2 className="text-xl font-bold text-[var(--text)]">
            {t('zoneConfig.title', { zone: zone.name, defaultValue: 'Configure zone — {{zone}}' })}
          </h2>
          <button
            onClick={onClose}
            aria-label={tc('close')}
            title={tc('close')}
            className="touch-target text-[var(--text-tertiary)] hover:text-[var(--text)] text-2xl leading-none"
          >&times;</button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 text-sm">{error}</div>
          )}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/70 p-4">
            <DataExportSection zoneId={zone.id} todayIso={todayIso} />
          </div>

          {/* Crop & Variety */}
          <div>
            <label htmlFor={id('crop')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.crop', { defaultValue: 'Crop' })}
            </label>
            <div className="flex gap-2">
              <select
                id={id('crop')}
                value={cropType}
                onChange={e => setCropType(e.target.value)}
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
              >
                <option value="">{t('zoneConfig.selectCrop', { defaultValue: '— Select prediction crop —' })}</option>
                {hasLegacyCrop && <option value={cropType}>{cropType}</option>}
                {CROP_GROUPS.map(g => (
                  <optgroup key={g.groupLabel} label={g.groupLabel}>
                    {g.crops.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </optgroup>
                ))}
              </select>
              <input
                id={id('variety')}
                aria-label={t('zoneConfig.variety', { defaultValue: 'Variety' })}
                type="text"
                value={variety}
                onChange={e => setVariety(e.target.value)}
                placeholder={t('zoneConfig.varietyPlaceholder', { defaultValue: 'Variety (optional)' })}
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          </div>

          {/* Soil type */}
          <div>
            <label htmlFor={id('soil')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.soilType', { defaultValue: 'Soil type' })}
            </label>
            <select
              id={id('soil')}
              value={soilType}
              onChange={e => setSoilType(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {SOIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
            </select>
          </div>

          {/* Irrigation method */}
          <div>
            <label htmlFor={id('method')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.irrigationMethod', { defaultValue: 'Irrigation method' })}
            </label>
            <select
              id={id('method')}
              value={irrigationMethod}
              onChange={e => setIrrigationMethod(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {IRRIGATION_METHODS.map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={id('area')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
                {t('zoneConfig.area', { defaultValue: 'Area (m²)' })}
              </label>
              <input
                id={id('area')}
                type="number"
                min="0"
                step="0.1"
                value={areaM2}
                onChange={e => setAreaM2(e.target.value)}
                placeholder="m²"
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>
            <div>
              <label htmlFor={id('efficiency')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
                {t('zoneConfig.irrigationEfficiency', { defaultValue: 'Irrigation efficiency (%)' })}
              </label>
              <input
                id={id('efficiency')}
                type="number"
                min="0"
                max="100"
                step="1"
                value={irrigationEfficiencyPct}
                onChange={e => setIrrigationEfficiencyPct(e.target.value)}
                placeholder="%"
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          </div>

          <hr className="border-[var(--border)]" />

          {/* Calibration */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/70 p-4">
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-3">
              {t('zoneConfig.calibrationTitle', { defaultValue: 'Irrigation calibration' })}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={id('flow-rate')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
                  {t('zoneConfig.flowRate', { defaultValue: 'Flow rate (L/min)' })}
                </label>
                <input
                  id={id('flow-rate')}
                  type="number"
                  min="0"
                  step="0.1"
                  value={measuredFlowRateLpm}
                  onChange={e => setMeasuredFlowRateLpm(e.target.value)}
                  placeholder="L/min"
                  className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
                />
              </div>
              <div>
                <label htmlFor={id('measurement-method')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
                  {t('zoneConfig.measurementMethod', { defaultValue: 'Measurement method' })}
                </label>
                <input
                  id={id('measurement-method')}
                  type="text"
                  value={measurementMethod}
                  onChange={e => setMeasurementMethod(e.target.value)}
                  placeholder={t('zoneConfig.measurementMethodPlaceholder', { defaultValue: 'Bucket test, meter read, or other method' })}
                  className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
                />
              </div>
            </div>
          </div>

          <div>
            <label htmlFor={id('calibration')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.dendroCalibration', { defaultValue: 'Dendro calibration' })}
            </label>
            <select
              id={id('calibration')}
              value={calibrationKey}
              onChange={e => setCalibrationKey(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {CALIBRATION_KEYS.map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
            </select>
          </div>

          {/* Phenological stage */}
          <div>
            <label htmlFor={id('stage')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.phenologicalStage', { defaultValue: 'Phenological stage' })}
            </label>
            <select
              id={id('stage')}
              value={phenologicalStage}
              onChange={e => setPhenologicalStage(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {PHENOLOGICAL_STAGES.map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
            </select>
          </div>

          {/* Timezone */}
          <TimezoneInput
            id={id('timezone')}
            label={t('zoneConfig.timezone', { defaultValue: 'Timezone' })}
            value={timezone}
            onChange={setTimezone}
          />

          <div>
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.zoneLocation', { defaultValue: 'Zone location' })}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {/* A placeholder is not a label: it disappears as soon as the
                  field has a value, and axe reports the input as unnamed. */}
              <input
                id={id('latitude')}
                aria-label={t('zoneConfig.latitude', { defaultValue: 'Latitude' })}
                type="number"
                value={latitude}
                onChange={e => setLatitude(e.target.value)}
                placeholder={t('zoneConfig.latitude', { defaultValue: 'Latitude' })}
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
              <input
                id={id('longitude')}
                aria-label={t('zoneConfig.longitude', { defaultValue: 'Longitude' })}
                type="number"
                value={longitude}
                onChange={e => setLongitude(e.target.value)}
                placeholder={t('zoneConfig.longitude', { defaultValue: 'Longitude' })}
                className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                  {t('zoneConfig.deviceGps', { defaultValue: 'Device GPS' })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void useDeviceLocation()}
                disabled={!canRequestDeviceLocation}
                className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] disabled:opacity-50"
              >
                {deviceLocationLoading
                  ? t('zoneConfig.locating', { defaultValue: 'Locating…' })
                  : t('zoneConfig.useDeviceLocation', { defaultValue: 'Use device location' })}
              </button>
            </div>

            <div className="mt-3 space-y-2 text-sm text-[var(--text)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${deviceLocationStatusClass}`}>{deviceLocationStatusLabel}</span>
                {deviceLocationSupport?.permissionState && deviceLocationSupport.permissionState !== 'unknown' && (
                  <span className="text-[var(--text-tertiary)]">
                    {t('zoneConfig.permissionState', {
                      state: deviceLocationSupport.permissionState,
                      defaultValue: 'Permission {{state}}',
                    })}
                  </span>
                )}
              </div>
              <p>{deviceLocationSupport?.message
                ?? t('zoneConfig.checkingGps', { defaultValue: 'Checking whether device GPS is available…' })}</p>
              {deviceLocationMeta && (
                <div className="space-y-1">
                  <p>
                    {trimmedLatitude && trimmedLongitude
                      ? `${Number(trimmedLatitude).toFixed(6)}, ${Number(trimmedLongitude).toFixed(6)}`
                      : t('zoneConfig.locationCaptured', { defaultValue: 'Device location captured.' })}
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    {t('zoneConfig.captured', {
                      time: dateFormat.dateTime(deviceLocationMeta.capturedAt) ?? deviceLocationMeta.capturedAt,
                      defaultValue: 'Captured {{time}}',
                    })}
                    {deviceLocationMeta.accuracyM != null
                      ? t('zoneConfig.capturedAccuracy', {
                          meters: deviceLocationMeta.accuracyM.toFixed(1),
                          defaultValue: ', accuracy ~{{meters}} m',
                        })
                      : ''}
                    {deviceLocationMeta.source === 'native-app'
                      ? t('zoneConfig.capturedViaApp', { defaultValue: ', via mobile app' })
                      : t('zoneConfig.capturedViaBrowser', { defaultValue: ', via browser' })}
                  </p>
                </div>
              )}
              {deviceLocationSupport?.canOpenSettings && deviceLocationSupport.reason === 'permission_denied' && (
                <button
                  type="button"
                  onClick={handleOpenLocationSettings}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)]"
                >
                  {t('zoneConfig.openAppSettings', { defaultValue: 'Open app settings' })}
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
            <label htmlFor={id('notes')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2">
              {t('zoneConfig.notes', { defaultValue: 'Notes' })}
            </label>
            <textarea
              id={id('notes')}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder={t('zoneConfig.notesPlaceholder', { defaultValue: 'Any additional info about this zone…' })}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-tertiary)] resize-none"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end p-5 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] px-5 py-2 rounded-lg text-sm font-semibold"
          >
            {tc('cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-60 text-[var(--on-primary)] px-5 py-2 rounded-lg text-sm font-semibold"
          >
            {saving
              ? t('zoneConfig.saving', { defaultValue: 'Saving…' })
              : t('zoneConfig.save', { defaultValue: 'Save' })}
          </button>
        </div>
      </div>
    </div>
  );
};
