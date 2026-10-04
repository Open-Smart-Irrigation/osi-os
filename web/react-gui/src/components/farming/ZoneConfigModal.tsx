import React, { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { IrrigationZone } from '../../types/farming';
import { irrigationZonesAPI } from '../../services/api';
import { useSessionFence } from '../../contexts/AuthSessionDataBoundary';
import {
  getDeviceLocationErrorMessage,
  getDeviceLocationSupport,
  openNativeLocationSettings,
  requestDeviceLocation,
  type DeviceLocationCapture,
  type DeviceLocationSupport,
} from '../../services/deviceLocation';
import {
  CROP_OPTION_GROUPS,
  PREDICTION_CROP_NAMES,
  STAGES,
  cropById,
  formCropValue,
  normalizeStage,
  stageLengths,
  type StageId,
} from '../../agronomy/cropKc';
import { stageOptionLabel } from '../../agronomy/stageLabels';
import { HelpTip } from './shared/HelpTip';
import { DataExportSection } from './DataExportSection';
import { TimezoneInput } from './TimezoneInput';
import { useDateFormat } from '../../utils/datetime';

/** Today in the browser's local time as YYYY-MM-DD (the stage start date pre-fill). */
export function localTodayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The zone's stored stage-started-on date, or '' when the zone's stored stage itself does not
 * resolve to a real stage (unset/legacy). Used both to seed/reset the form and as the baseline
 * for the "send only when changed" diff, so the two never disagree (F3).
 */
function storedStageStartedOn(zone: IrrigationZone): string {
  return normalizeStage(zone.phenologicalStage) ? (zone.stageStartedOn ?? '') : '';
}

const STAGE_STARTED_ON_HELP = "The date the current stage began (day 1). In the development and late-season stages Kc moves along the FAO-56 curve from this date; in the other stages it stays at the stage's value. The stage never advances by itself: after the typical length for this crop ({{days}} days) Kc stays at the stage's end value until you choose the next stage. After leaf fall or harvest choose Dormancy (Kc 0.25, bare soil); in spring choose Initial with the green-up date. Changes to crop, stage or start date apply to days calculated after the change. Leave empty to use the stage's table value.";

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

/** The providers the edge implements (osi-weather-provider resolveProvider). */
const WEATHER_SOURCES = ['auto', 'open_meteo', 'meteoswiss', 'local'];
const WEATHER_SOURCE_FALLBACK: Record<string, string> = {
  open_meteo: 'Open-Meteo',
  meteoswiss: 'MeteoSwiss',
  local: 'Local weather station only',
};

/** A variant sits under its default crop, indented and marked with an en dash. */
const VARIANT_PREFIX = '\u00A0\u00A0\u2013 ';

function optionLabel(t: Translate, option: Option): string {
  return t(`zoneConfig.${option.key}`, { defaultValue: option.fallback });
}

export const ZoneConfigModal: React.FC<Props> = ({ isOpen, zone, onClose, onSaved }) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  // #378: the save is up to three writes in a row; stop it if the session
  // ends between them.
  const sessionFence = useSessionFence();
  // One id prefix per mounted modal, so a dashboard with several zone cards
  // open does not produce duplicate control ids.
  const dateFormat = useDateFormat();
  const fieldId = useId();
  const id = (name: string) => `zone-config-${name}-${fieldId}`;
  const [cropType, setCropType] = useState(formCropValue(zone.cropType));
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
  const [phenologicalStage, setPhenologicalStage] = useState<string>(normalizeStage(zone.phenologicalStage) ?? '');
  const [stageStartedOn, setStageStartedOn] = useState(storedStageStartedOn(zone));
  const [calibrationKey, setCalibrationKey] = useState(zone.calibrationKey ?? 'default');
  const [weatherSource, setWeatherSource] = useState(zone.weatherSource ?? 'auto');
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
    cropType && cropType !== 'other' && !cropById(cropType)
  );

  // Sync when zone prop changes (e.g. after onSaved refresh)
  useEffect(() => {
    setCropType(formCropValue(zone.cropType));
    setVariety(zone.variety ?? '');
    setSoilType(zone.soilType ?? '');
    setIrrigationMethod(zone.irrigationMethod ?? '');
    setAreaM2(zone.areaM2 != null ? String(zone.areaM2) : '');
    setIrrigationEfficiencyPct(zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : '');
    setMeasuredFlowRateLpm(zone.measuredFlowRateLpm != null ? String(zone.measuredFlowRateLpm) : '');
    setMeasurementMethod(zone.measurementMethod ?? '');
    setNotes(zone.notes ?? '');
    setTimezone(zone.timezone ?? 'UTC');
    setPhenologicalStage(normalizeStage(zone.phenologicalStage) ?? '');
    setStageStartedOn(storedStageStartedOn(zone));
    setCalibrationKey(zone.calibrationKey ?? 'default');
    setWeatherSource(zone.weatherSource ?? 'auto');
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
      stageStartedOn?: string | null;
      calibrationKey?: string | null;
      weatherSource?: string;
    } = {};

    // Compared in the form's normalised value, so a stored 'Maize' the user
    // did not touch is not written back as 'maize'.
    if (formCropValue(zone.cropType) !== cropType) payload.cropType = cropType || null;
    if ((zone.variety ?? '') !== variety) payload.variety = variety || null;
    if ((zone.soilType ?? '') !== soilType) payload.soilType = soilType || null;
    if ((zone.irrigationMethod ?? '') !== irrigationMethod) payload.irrigationMethod = irrigationMethod || null;
    if ((zone.areaM2 != null ? String(zone.areaM2) : '') !== areaM2) payload.areaM2 = areaM2.trim() ? Number(areaM2) : null;
    if ((zone.irrigationEfficiencyPct != null ? String(zone.irrigationEfficiencyPct) : '') !== irrigationEfficiencyPct) {
      payload.irrigationEfficiencyPct = irrigationEfficiencyPct.trim() ? Number(irrigationEfficiencyPct) : null;
    }
    if ((zone.notes ?? '') !== notes) payload.notes = notes || null;
    if ((zone.timezone ?? 'UTC') !== timezone) payload.timezone = timezone;
    // The stored stage is compared in its normalised form, so a legacy value
    // (`veraison`) or 'default' the user did not touch is never written back.
    // A cleared stage goes out as 'default', not null: the cloud mirror drops
    // a null stage and would keep the old one.
    const stageChanged = (normalizeStage(zone.phenologicalStage) ?? '') !== phenologicalStage;
    if (stageChanged) payload.phenologicalStage = phenologicalStage || 'default';
    // Sent whenever the stage changes (even to the same date the field already
    // shows, e.g. a second stage change on the same day) or the date itself
    // differs from the stored one; empty clears it. A payload that carries
    // phenologicalStage must carry stageStartedOn too, also as an empty value,
    // so the backend's date rule -- not a stale pre-filled date -- decides it
    // (final review E-I2/E-M-queue; cloud form osi-server 070b3f88). Baselined
    // through storedStageStartedOn, the same empty-when-unset rule the form
    // itself uses to seed and reset the field (F3), so an unset stage's
    // leftover stored date is never read as "changed" just because the raw
    // zone field is not empty.
    if (stageChanged || storedStageStartedOn(zone) !== stageStartedOn) payload.stageStartedOn = stageStartedOn || null;
    if ((zone.calibrationKey ?? 'default') !== calibrationKey) payload.calibrationKey = calibrationKey;
    // Sent only when the user picked another provider, so a save of other
    // fields never rewrites a stored value, including a cloud-only one.
    if ((zone.weatherSource ?? 'auto') !== weatherSource) payload.weatherSource = weatherSource;

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
        sessionFence();
        await irrigationZonesAPI.updateCalibration(zone.id, calibrationPayload);
      }
      if (locationChanged) {
        sessionFence();
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

  const storedWeatherSource = zone.weatherSource ?? 'auto';
  const weatherSourceLabel = (value: string) => t(`zoneConfig.weatherProviderOption.${value}`, { defaultValue: WEATHER_SOURCE_FALLBACK[value] ?? value });
  const weatherSourceOptionLabel = (value: string) => (value === 'auto'
    ? t('zoneConfig.weatherProviderOption.auto', {
      provider: weatherSourceLabel(zone.weatherSourceDefault === 'meteoswiss' ? 'meteoswiss' : 'open_meteo'),
      defaultValue: 'Gateway default ({{provider}})',
    })
    : weatherSourceLabel(value));

  const stageLengthDays = phenologicalStage && phenologicalStage !== 'dormancy'
    ? stageLengths(cropType)?.[phenologicalStage as Exclude<StageId, 'dormancy'>] ?? null
    : null;

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
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id('crop')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                {t('zoneConfig.crop', { defaultValue: 'Crop' })}
              </label>
              <HelpTip label={t('zoneConfig.cropHelpLabel', { defaultValue: 'About the crop list' })}>
                {t('zoneConfig.cropHelp', {
                  crops: PREDICTION_CROP_NAMES.join(', '),
                  defaultValue: 'Crop coefficients follow FAO-56 Table 12. The prediction advisor supports {{crops}} only.',
                })}
              </HelpTip>
            </div>
            <div className="flex gap-2">
              <select
                id={id('crop')}
                value={cropType}
                onChange={e => setCropType(e.target.value)}
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
              >
                <option value="">{t('zoneConfig.selectCrop', { defaultValue: '— Select crop —' })}</option>
                {hasLegacyCrop && <option value={cropType}>{cropType}</option>}
                {CROP_OPTION_GROUPS.map(({ group, crops }) => (
                  <optgroup key={group.id} label={t(`zoneConfig.cropGroup.${group.id}`, { defaultValue: group.label })}>
                    {crops.flatMap(({ crop, variants }) => [
                      <option key={crop.id} value={crop.id}>{crop.label}</option>,
                      ...variants.map((variant) => (
                        <option key={variant.id} value={variant.id}>{VARIANT_PREFIX + variant.label}</option>
                      )),
                    ])}
                  </optgroup>
                ))}
                <option value="other">{t('zoneConfig.cropOther', { defaultValue: 'Other crop' })}</option>
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
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id('stage')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                {t('zoneConfig.phenologicalStage', { defaultValue: 'Phenological stage' })}
              </label>
              <HelpTip label={t('zoneConfig.stageHelpLabel', { defaultValue: 'About growth stages' })}>
                {t('zoneConfig.stageHelp', {
                  defaultValue: 'FAO-56 growth stages set the crop coefficient Kc: initial until about 10 % ground cover, development until full cover, mid-season until maturity starts, late season until harvest or leaf fall. Dormancy (Kc 0.25) is for deciduous crops and annual rest periods; evergreens such as citrus, olive, coffee and banana keep their late-season Kc instead.',
                })}
              </HelpTip>
            </div>
            <select
              id={id('stage')}
              value={phenologicalStage}
              onChange={e => {
                const next = e.target.value;
                // A new stage starts today unless the user says otherwise; landing back on the
                // zone's stored stage restores its stored date instead of re-stamping today
                // (F1); "Not set" has no start date. Compared against the STORED stage, not the
                // live form value, so browsing away and back does not leave a stale today's-date
                // behind a stage that never actually changed.
                if (!next) setStageStartedOn('');
                else if (next === (normalizeStage(zone.phenologicalStage) ?? '')) setStageStartedOn(storedStageStartedOn(zone));
                else setStageStartedOn(localTodayIso());
                setPhenologicalStage(next);
              }}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              <option value="">{t('zoneConfig.stage.unset', { defaultValue: 'Not set' })}</option>
              {STAGES.map(stage => (
                <option key={stage} value={stage}>{stageOptionLabel(t, cropType, stage)}</option>
              ))}
            </select>
          </div>

          {/* Stage start date: FAO-56 Kc curve (spec 2026-09-27-daily-agronomy-parity B5) */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id('stageStartedOn')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                {t('zoneConfig.stageStartedOn', { defaultValue: 'Stage started on' })}
              </label>
              <HelpTip label={t('zoneConfig.stageStartedOnHelpLabel', { defaultValue: 'About the stage start date' })}>
                {stageLengthDays != null
                  ? t('zoneConfig.stageStartedOnHelp', { days: stageLengthDays, defaultValue: STAGE_STARTED_ON_HELP })
                  : t('zoneConfig.stageStartedOnHelpNoLength', { defaultValue: STAGE_STARTED_ON_HELP.replace(' ({{days}} days)', '') })}
              </HelpTip>
            </div>
            <input
              id={id('stageStartedOn')}
              type="date"
              value={stageStartedOn}
              disabled={!phenologicalStage}
              onChange={e => setStageStartedOn(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm disabled:opacity-50"
            />
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

          {/* Weather provider */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id('weatherSource')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                {t('zoneConfig.weatherProvider', { defaultValue: 'Weather provider' })}
              </label>
              <HelpTip label={t('zoneConfig.weatherProviderHelpLabel', { defaultValue: 'About the weather provider' })}>
                {t('zoneConfig.weatherProviderHelp', {
                  defaultValue: 'Sets where this zone\'s hourly weather history comes from, and its daily ET0 unless an assigned weather station has a complete day, which takes precedence. MeteoSwiss covers Switzerland. With Local weather station only, the gateway downloads no weather history for this zone, so without an assigned station it gets no ET0. The weather forecast does not change.',
                })}
              </HelpTip>
            </div>
            <select
              id={id('weatherSource')}
              value={weatherSource}
              onChange={e => setWeatherSource(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {WEATHER_SOURCES.map(value => (
                <option key={value} value={value}>{weatherSourceOptionLabel(value)}</option>
              ))}
              {/* A value only the cloud implements stays visible and selected;
                  once the user picks another it cannot be chosen again here. */}
              {!WEATHER_SOURCES.includes(storedWeatherSource) && (
                <option value={storedWeatherSource} disabled>
                  {t('zoneConfig.weatherProviderCloud', { value: storedWeatherSource, defaultValue: '{{value}} (cloud provider)' })}
                </option>
              )}
            </select>
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
