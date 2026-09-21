import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IrrigationZone, Device, ZoneEnvironmentSummary, ZoneRecommendation, ValveSummary, WaterAction } from '../../types/farming';
import type { IrrigationActuation } from '../../services/api';
import { dendroAnalyticsAPI, environmentAPI, irrigationZonesAPI } from '../../services/api';
import { KiwiSensorCard } from './KiwiSensorCard';
import { DraginoTempCard } from './DraginoTempCard';
import { StregaValveCard } from './StregaValveCard';
import { SenseCapWeatherCard } from './SenseCapWeatherCard';
import { LoRainGaugeCard } from './LoRainGaugeCard';
import { Sdi12SoilCard } from './Sdi12SoilCard';
import { Sdi12SettingsModal } from './Sdi12SettingsModal';
import { ScheduleSection, normalizeTriggerMetric } from './ScheduleSection';
import { ZoneDeviceModal } from './ZoneDeviceModal';
import { EditableName } from './shared/EditableName';
import { DendrometerSection } from './dendrometer/DendrometerSection';
import { EnvironmentCard } from './environment/EnvironmentCard';
import { ZoneConfigModal } from './ZoneConfigModal';
import { AdvancedScheduleDrawer } from './AdvancedScheduleDrawer';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useDisplayPreferences } from '../../utils/displayPreferences';
import { useGatewayModules } from '../../hooks/useGatewayModules';
import { formatSwtValue } from '../../utils/swt';
import { summarizeZoneSoil, zoneHasFlowMeter, zoneHasRainGauge, type SoilChannelSelection } from '../../utils/zoneSoil';
import { useDateFormat } from '../../utils/datetime';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';

interface IrrigationZoneCardProps {
  zone: IrrigationZone;
  devices: Device[];
  unassignedDevices: Device[];
  onUpdate: () => void;
  allZones?: Array<{ id: number; name: string }>;
  irrigationActuations?: IrrigationActuation[];
  valvesByEui?: Map<string, ValveSummary>;
  canWrite?: boolean;
}

function formatWaterValue(value: number | null | undefined, unit: string, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(digits)} ${unit}`;
}

type Translate = TFunction<'devices'>;

// Recommendation codes come from the edge water-balance node and the cloud
// recommendation payload; they are stable identifiers, so each one gets its
// own locale key instead of being rendered verbatim.
const WATER_ACTION_LABELS: Record<string, string> = {
  delay_irrigation: 'Delay irrigation',
  irrigate_today: 'Irrigate today',
  monitor_today: 'Monitor today',
  maintain_rain_suppression: 'Rain suppression active',
  maintain_recovery_hold: 'Recovery hold active',
  increase_10: 'Increase irrigation slightly',
  increase_20: 'Increase irrigation',
  decrease_10: 'Decrease irrigation slightly',
  decrease_20: 'Decrease irrigation',
  emergency_irrigate: 'Emergency irrigation',
};

const DISPLAY_MODE_LABELS: Record<string, string> = {
  shared_server: 'OSI Server',
  shared_server_stale: 'OSI Server stale',
  local_fallback: 'Local fallback',
  unlinked_local: 'Local only',
};

// Why the edge reached its verdict, as codes rather than the English prose it
// used to send (which no locale bundle could translate). A code this build
// does not know — an older gateway, or the cloud mirror — falls back to the
// generic key instead of being printed raw.
const WATER_REASON_LABELS: Record<string, string> = {
  supply_covers_demand: "Rain and irrigation cover today's demand",
  forecast_rain_covers_demand: "Forecast rain covers today's shortfall",
  demand_exceeds_supply: "Demand exceeds today's rain and irrigation",
  balance_neutral: 'Water balance is close to neutral',
  balance_unknown: 'Set zone area and irrigation efficiency',
  forecast_unknown: 'No rain forecast available',
};

// Tailwind needs the class as a literal, so the column count is a lookup
// rather than a template. Tiles are gated on their source, so the row can be
// anything from the action tile alone to all four.
const WATER_TILE_GRID: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

const SCHEDULE_METRIC_LABELS: Record<string, string> = {
  DENDRO: 'Dendro trigger',
  VWC: 'VWC trigger',
  SWT_1: 'Soil tension (S1)',
  SWT_2: 'Soil tension (S2)',
  SWT_3: 'Soil tension (S3)',
  SWT_WM1: 'Soil tension (S1)',
  SWT_WM2: 'Soil tension (S2)',
  SWT_AVG: 'Soil tension (avg)',
};

function formatWaterAction(t: Translate, code: string | null | undefined): string {
  const fallback = code ? WATER_ACTION_LABELS[code] : undefined;
  return fallback
    ? t(`zone.water.action.${code}`, { defaultValue: fallback })
    : t('zone.water.action.default', { defaultValue: 'Monitor water status' });
}

function formatWaterReason(t: Translate, reasonCode: string | null | undefined): string {
  const fallback = reasonCode ? WATER_REASON_LABELS[reasonCode] : undefined;
  return fallback
    ? t(`zone.water.reason.${reasonCode}`, { defaultValue: fallback })
    : t('zone.water.reason.default', { defaultValue: 'Waiting for more data' });
}

// The zone-env-fn flow node (flows.json, "Get Zone Environment Summary",
// ~L769/772) still emits these two banners as plain English; the cloud's own
// linked bundle can land its own English prose in the same
// `display.fallbackReason` field (F100/X-16). Mapping the two known
// sentences to keys here is a stop-gap for the honesty gap until the flow
// itself emits a code — a follow-up (see FINDINGS.md F100), not this change.
// Anything unrecognised gets the generic fallback-source key instead of raw
// prose.
const FALLBACK_REASON_CODES: Record<string, string> = {
  'Using last synced OSI Server values.': 'using_last_synced',
  'Using local fallback because the OSI Server bundle is unavailable.': 'bundle_unavailable',
};

function formatFallbackReason(t: Translate, fallbackReason: string | null | undefined): string | null {
  if (!fallbackReason) return null;
  const code = FALLBACK_REASON_CODES[fallbackReason];
  if (!code) {
    // eslint-disable-next-line no-console
    console.debug('[IrrigationZoneCard] unmapped display.fallbackReason', fallbackReason);
    return t('zone.water.source.fallback_generic', { defaultValue: 'Showing data from a fallback source.' });
  }
  return t(`zone.water.source.${code}`, { defaultValue: fallbackReason });
}

/**
 * The "why" under the water-balance title. A `reasonCode` (F100/T13m) is
 * always preferred and translated. Absent that, only dendrometer-sourced
 * `reasoning` is prose this card may show verbatim — it is a stored per-zone
 * analytics sentence, not a template written for the screen. Any other
 * `reasoning` — most concretely the cloud's own fabricated English sentence
 * for a linked gateway (F100/X-01: "Available rain and effective irrigation
 * cover today's estimated demand.") — is logged at debug and replaced with
 * the neutral generic reason key, so #271's honesty fix cannot be bypassed
 * by a bundle that has not been ported to reason codes yet.
 */
function formatWaterSubtitle(t: Translate, action: WaterAction | null | undefined, defaultSubtitle: string): string {
  if (action?.reasonCode) {
    return formatWaterReason(t, action.reasonCode);
  }
  if (action?.source === 'dendro' && action.reasoning) {
    return action.reasoning;
  }
  if (action?.reasoning) {
    // eslint-disable-next-line no-console
    console.debug('[IrrigationZoneCard] suppressed non-dendro action.reasoning prose', action.reasoning);
    return formatWaterReason(t, null);
  }
  return defaultSubtitle;
}

function formatDisplayMode(t: Translate, mode: string | null | undefined): string {
  const fallback = mode ? DISPLAY_MODE_LABELS[mode] : undefined;
  return fallback
    ? t(`zone.water.source.${mode}`, { defaultValue: fallback })
    : t('zone.water.source.default', { defaultValue: 'Recommendation source' });
}

/**
 * Which soil channel the zone's scheduler compares. `threshold_kpa` carries an
 * encoded 1-4 stress level when the metric is DENDRO, and VWC has no edge
 * telemetry column at all, so neither is a tension the soil reading can be
 * judged against.
 */
function triggerChannelOf(metric: string | null | undefined): SoilChannelSelection | null {
  switch (metric) {
    case 'SWT_1': return 'swt_1';
    case 'SWT_2': return 'swt_2';
    case 'SWT_3': return 'swt_3';
    case 'SWT_AVG': return 'mean';
    default: return null;
  }
}

const CHANNEL_METRIC: Record<string, string> = { swt_1: 'SWT_1', swt_2: 'SWT_2', swt_3: 'SWT_3' };

function formatSoilChannel(t: Translate, channel: SoilChannelSelection): string {
  const metric = CHANNEL_METRIC[channel] ?? 'SWT_AVG';
  return t(`schedule.metric.${metric}`, { defaultValue: metric === 'SWT_AVG' ? 'Mean (all sensors)' : `Sensor ${metric.slice(-1)}` });
}

function formatScheduleMetric(t: Translate, metric: string): string {
  const fallback = SCHEDULE_METRIC_LABELS[metric];
  return fallback
    ? t(`zone.chips.metric.${metric}`, { defaultValue: fallback })
    : t('zone.chips.metric.default', { defaultValue: 'Soil tension' });
}

function buildJournalHref(zone: IrrigationZone): string {
  const zoneWithUuid = zone as IrrigationZone & { zoneUuid?: unknown; zone_uuid?: unknown };
  const zoneUuid = typeof zoneWithUuid.zone_uuid === 'string' && zoneWithUuid.zone_uuid.trim()
    ? zoneWithUuid.zone_uuid
    : typeof zoneWithUuid.zoneUuid === 'string' && zoneWithUuid.zoneUuid.trim()
      ? zoneWithUuid.zoneUuid
      : null;

  return zoneUuid
    ? `/journal?capture=1&zone_uuid=${encodeURIComponent(zoneUuid)}`
    : '/journal?capture=1';
}

export const IrrigationZoneCard: React.FC<IrrigationZoneCardProps> = ({
  zone,
  devices,
  unassignedDevices,
  onUpdate,
  allZones,
  irrigationActuations = [],
  valvesByEui,
  canWrite = true,
}) => {
  const { t } = useTranslation('devices');
  const { t: tDashboard } = useTranslation('dashboard');
  const { t: tc } = useTranslation('common');
  const dateFormat = useDateFormat();
  const { swtUnit, modules } = useDisplayPreferences();
  const [zoneCollapsed, setZoneCollapsed] = useState(true);
  const [devicesCollapsed, setDevicesCollapsed] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showAdvancedDrawer, setShowAdvancedDrawer] = useState(false);
  const [sdi12SettingsDevice, setSdi12SettingsDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingDevice, setRemovingDevice] = useState<string | null>(null);
  const [environmentSummary, setEnvironmentSummary] = useState<ZoneEnvironmentSummary | null>(null);
  const [latestZoneRecommendation, setLatestZoneRecommendation] = useState<ZoneRecommendation | null>(null);

  const handleRenameZone = async (nextName: string) => {
    await irrigationZonesAPI.rename(zone.id, nextName);
    onUpdate();
  };

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
  const s2120Stations = devices.filter((d) => d.type_id === 'SENSECAP_S2120');
  const loRainGauges = devices.filter((d) => d.type_id === 'AQUASCOPE_LORAIN');
  const sdi12Nodes = devices.filter((d) => d.type_id === 'DRAGINO_SDI12');

  const hasDendroDevices = lsn50Nodes.some(d => d.dendro_enabled === 1);
  const schedMetric = zone.schedule?.triggerMetric ?? zone.schedule?.trigger_metric;
  const schedEnabled = zone.schedule?.enabled ?? false;
  const cropType = zone.cropType;
  const soilType = zone.soilType;
  // The card, the trigger form and the scheduler must all be talking about the
  // same channel: one screen used to say "56.5 kPa · Moderate" above a form
  // that read "Irrigate when Sensor 1 exceeds 30 kPa".
  const triggerChannel = zone.schedule ? triggerChannelOf(normalizeTriggerMetric(schedMetric)) : null;
  const triggerThresholdKpa = triggerChannel !== null
    ? Number(zone.schedule?.thresholdKpa ?? zone.schedule?.threshold_kpa)
    : Number.NaN;
  const soilNow = summarizeZoneSoil(devices, Date.now(), triggerChannel);
  const hasFlowMeter = zoneHasFlowMeter(devices);
  const hasRainGauge = zoneHasRainGauge(devices) || (environmentSummary?.water.sensorHealth.rainGaugePresent ?? false);
  const hasForecastRain = environmentSummary?.water.next24hRainMm != null;
  // The action tile always renders; it has its own insufficient-data state.
  const waterTileCount = 1 + (hasRainGauge ? 1 : 0) + (hasFlowMeter ? 1 : 0) + (hasForecastRain ? 1 : 0);
  // Entry points to gateway-level modules follow the gateway's module flags, exactly as the
  // header does. `null` while the settings load: hidden rather than flashed and withdrawn.
  const gatewayModules = useGatewayModules();
  const showZoneDataLink = !isDesktopBrowser() && gatewayModules?.data === true;
  const showJournalLink = gatewayModules?.journal === true;
  const waterSubtitle = formatWaterSubtitle(
    t,
    environmentSummary?.water.action,
    t('zone.water.subtitle', { defaultValue: 'Daily rain, irrigation, and crop demand summary for this zone.' }),
  );
  const fallbackReasonText = formatFallbackReason(t, environmentSummary?.display?.fallbackReason);

  const soilValue = soilNow.value === null
    ? null
    : soilNow.quantity === 'tension'
      ? formatSwtValue(soilNow.value, swtUnit)
      : `${soilNow.value.toFixed(1)} %`;
  // Which channel the number came from: its depth when the installation
  // recorded one, otherwise the channel's own name. A cross-depth mean names
  // nothing, which is why it is no longer reported.
  const soilTitle = soilNow.depthCm != null
    ? t('zone.water.soil.titleAtDepth', {
        depth: soilNow.depthCm,
        defaultValue: 'Soil now · {{depth}} cm',
      })
    : soilNow.channel != null && soilNow.channel !== 'mean'
      ? t('zone.water.soil.titleChannel', {
          channel: formatSoilChannel(t, soilNow.channel),
          defaultValue: 'Soil now · {{channel}}',
        })
      : t('zone.water.soil.title', { defaultValue: 'Soil now' });
  // Judged against the zone's own trigger where there is one. The absolute
  // Wet/Moderate/Dry bucketing (utils/swt.ts) is identical for every crop and
  // every soil, and it called a reading "Moderate" that would open the valve
  // the same night. There is no reviewed equivalent for volumetric water
  // content, so that path names the quantity instead of inventing thresholds.
  const soilDescriptor = soilNow.quantity === 'volumetric'
    ? t('zone.water.soil.volumetric', { defaultValue: 'Volumetric water content' })
    : soilNow.value === null
      ? null
      : Number.isFinite(triggerThresholdKpa) && triggerThresholdKpa > 0
        ? soilNow.value >= triggerThresholdKpa
          ? t('zone.water.soil.atTrigger', { defaultValue: 'At or past the trigger' })
          : soilNow.value >= triggerThresholdKpa * 0.8
            ? t('zone.water.soil.nearTrigger', { defaultValue: 'Approaching the trigger' })
            : t('zone.water.soil.belowTrigger', { defaultValue: 'Below the trigger' })
        : soilNow.value < 20
          ? t('zone.water.soil.wet', { defaultValue: 'Wet' })
          : soilNow.value < 60
            ? t('zone.water.soil.moderate', { defaultValue: 'Moderate' })
            : t('zone.water.soil.dry', { defaultValue: 'Dry' });
  const soilObservedRelative = dateFormat.relativeToNow(soilNow.observedAt);
  const soilStatusLine = soilNow.invalid
    ? t('zone.water.soil.invalidReading', { defaultValue: 'Invalid reading' })
    : soilNow.stale
      ? soilObservedRelative
        ? t('zone.water.soil.noReadingSince', {
            since: soilObservedRelative,
            defaultValue: 'No reading since {{since}}',
          })
        : t('zone.water.soil.noReadingYet', { defaultValue: 'No reading yet' })
      : null;
  const soilLastValid = soilStatusLine !== null && soilValue !== null && soilNow.observedAt
    ? t('zone.water.soil.lastValid', {
        value: soilValue,
        time: dateFormat.dateTime(soilNow.observedAt) ?? soilNow.observedAt,
        defaultValue: 'Last valid {{value}} · {{time}}',
      })
    : null;

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

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--border)] rounded-xl p-6 shadow-lg mb-6">
      {/* Zone Header — stacks vertically on mobile */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 mb-3">
        {/* The pencil is a button, so the heading can no longer sit inside the
            collapse button: nested interactive elements are invalid markup and
            make the collapse control ambiguous to assistive technology. The
            heading moves out; the chevron and the device count stay the
            collapse control and keep aria-expanded. */}
        <div className="flex-1 min-w-0">
          <EditableName
            name={zone.name}
            canEdit={canWrite}
            onSave={handleRenameZone}
            renameLabel={t('rename.zone')}
            inputLabel={t('rename.zoneInputLabel')}
            headingClassName="text-3xl font-bold text-[var(--text)] mb-1 high-contrast-text break-words"
          />
          <button
            className="text-left flex items-center gap-2 group"
            aria-expanded={!zoneCollapsed}
            // T13-M2: the heading moved out of this button (above), so its own visible
            // content -- the chevron glyph plus the device-count text -- no longer names
            // the zone, and every zone card's toggle would otherwise share the same
            // accessible name. Built only from strings the component already has (the
            // zone name and the existing device-count translation); no new i18n key.
            aria-label={`${zone.name} ${t('zone.deviceCount', { count: zone.device_count })}`}
            onClick={() => setZoneCollapsed(c => !c)}
          >
            <span
              className="text-[var(--text-tertiary)] text-xl transition-transform duration-200 shrink-0"
              style={{ display: 'inline-block', transform: zoneCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            >
              ▾
            </span>
            <p className="text-[var(--text-secondary)] text-sm">
              {t('zone.deviceCount', { count: zone.device_count })}
            </p>
          </button>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0 max-w-full">
          {canWrite && (
            <>
              <button
                onClick={() => setShowConfigModal(true)}
                className="touch-target p-2 rounded-md text-[var(--text-secondary)] hover:bg-[var(--card)] transition-colors text-xl"
                title={t('zone.configure', { defaultValue: 'Configure' })}
                aria-label={t('zone.configure', { defaultValue: 'Configure' })}
              >
                ⚙
              </button>
              <button
                onClick={() => setShowAssignModal(true)}
                className="touch-target bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
              >
                {t('zone.assignDevice')}
              </button>
              {showJournalLink && (
                <Link
                  to={buildJournalHref(zone)}
                  style={{ minHeight: '56px' }}
                  className="touch-target min-h-14 bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center justify-center"
                >
                  {tDashboard('addMenu.activity')}
                </Link>
              )}
            </>
          )}
          {showZoneDataLink && (
            <Link
              to={`/history/zones/${zone.id}`}
              className="touch-target bg-[var(--success-border)] hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center justify-center"
            >
              {t('zone.data', 'Data')}
            </Link>
          )}
          {canWrite && <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeleting}
            className="touch-target bg-[var(--error-bg)] hover:opacity-90 disabled:bg-[var(--border)] text-[var(--error-text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
          >
            {t('zone.deleteZone')}
          </button>}
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
            <span>📏</span> {t('zone.chips.dendroActive', { defaultValue: 'Dendro active' })}
          </span>
        )}
        {zone.schedule && schedEnabled && schedMetric && (
          <span className="inline-flex items-center gap-1 bg-blue-50 border border-blue-200 text-blue-800 text-xs px-2.5 py-1 rounded-full">
            <span>⏱</span> {t('zone.chips.metricEnabled', {
              metric: formatScheduleMetric(t, schedMetric),
              defaultValue: '{{metric}} enabled',
            })}
          </span>
        )}
        {zone.schedule && !schedEnabled && (
          <span className="inline-flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text-tertiary)] text-xs px-2.5 py-1 rounded-full">
            <span>⏸</span> {t('zone.chips.schedulerOff', { defaultValue: 'Scheduler off' })}
          </span>
        )}
      </div>

      {!zoneCollapsed && (
      <>

      {/* `available` is true for a zone that has never seen a sample, so the
          empty zone used to render a full card of zeros — rain, irrigation, a
          seven-day chart and an action. A zone with nothing observed gets no
          water card. */}
      {modules.waterCard && environmentSummary?.water && environmentSummary.water.observedAt != null && (
        <div data-testid="water-today-card" className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary)]">
                {t('zone.water.title', { defaultValue: 'Water balance' })}
              </p>
              {/* See formatWaterSubtitle: a reasonCode is always preferred,
                  and only dendrometer reasoning is prose this card may show
                  verbatim. A linked gateway's fabricated cloud sentence never
                  reaches the screen (F100/X-01). */}
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {waterSubtitle}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 text-xs text-[var(--text-tertiary)]">
              <div>{t('zone.water.updated', {
                time: dateFormat.time(environmentSummary.water.observedAt) ?? '—',
                defaultValue: 'Updated {{time}}',
              })}</div>
              <div className="flex flex-wrap justify-end gap-1">
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 font-semibold text-[var(--primary)]">
                  {formatDisplayMode(t, environmentSummary.display?.mode)}
                </span>
              </div>
            </div>
          </div>
          {fallbackReasonText && (
            <div className="mt-3 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
              {fallbackReasonText}
            </div>
          )}
          <div className={`mt-4 grid grid-cols-2 gap-2 ${WATER_TILE_GRID[waterTileCount]}`}>
            {/* The daily aggregation writes 0 mm for a day with no sample, so
                this tile needs a gauge behind it before it can call anything a
                measurement. */}
            {hasRainGauge && (
              <div data-testid="water-rain-tile" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {t('zone.water.rainToday', { defaultValue: 'Rain today' })}
                </p>
                <p className="mt-2 text-2xl font-bold text-[var(--primary)]">{formatWaterValue(environmentSummary.water.rainTodayMm, 'mm', 1)}</p>
              </div>
            )}
            {/* A measured litre count needs a flow meter; without one the tile
                would show the same em dash as a zone whose meter has not
                reported yet. */}
            {hasFlowMeter && (
              <div data-testid="water-flow-meter-tile" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {t('zone.water.measured', { defaultValue: 'Measured (flow meter)' })}
                </p>
                <p className="mt-2 text-2xl font-bold text-[var(--success-text)]">
                  {formatWaterValue(environmentSummary.water.irrigationTodayMeasuredLiters, 'L', 0)}
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {t('zone.water.estimated', {
                    value: formatWaterValue(environmentSummary.water.irrigationTodayEstimatedLiters, 'L', 0),
                    defaultValue: 'Estimated (valve time × calibration): {{value}}',
                  })}
                </p>
              </div>
            )}
            {/* An offline or unlocated gateway has no forecast at all; the
                tile said "— mm" for it, which reads as a failed reading. */}
            {hasForecastRain && (
              <div data-testid="water-forecast-tile" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {t('zone.water.nextRain', { defaultValue: 'Next rain' })}
                </p>
                <p className="mt-2 text-2xl font-bold text-[var(--primary)]">{formatWaterValue(environmentSummary.water.next24hRainMm, 'mm', 1)}</p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {t('zone.water.forecastNext24h', { defaultValue: 'Forecast next 24 h' })}
                </p>
              </div>
            )}
            {/* An absent action code is the edge saying it could not compute
                one. It gets a neutral state and the reason, never an
                irrigation verb: "Delay irrigation" on an unknown balance is
                the recommendation that costs a crop when it is wrong. A cloud
                bundle that flags `source: 'insufficient_data'` (F100/T05j)
                gets the same neutral state even if it still carries a stale
                `code`. */}
            <div data-testid="water-action-tile" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('zone.water.actionTitle', { defaultValue: 'Action' })}
              </p>
              {environmentSummary.water.action?.code && environmentSummary.water.action.source !== 'insufficient_data' ? (
                <>
                  <p className="mt-2 text-2xl font-bold text-[var(--warn-text)]">{formatWaterAction(t, environmentSummary.water.action.code)}</p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    {environmentSummary.water.action.source === 'dendro'
                      ? t('zone.water.drivenByDendro', { defaultValue: 'Driven by dendrometer recommendation' })
                      : t('zone.water.drivenByBalance', { defaultValue: 'Driven by water balance' })}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-2xl font-bold text-[var(--text-secondary)]">
                    {t('zone.water.insufficientData', { defaultValue: 'Not enough data to advise' })}
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    {formatWaterReason(t, environmentSummary.water.action?.reasonCode)}
                  </p>
                </>
              )}
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {/* Gated the way the tree-stress tile already is: no configured
                soil sensor means there is nothing to report, not a reading of
                zero. A configured-but-silent sensor keeps the tile and says so. */}
            {soilNow.hasSensor && (
              <div data-testid="water-soil-tile" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {soilTitle}
                </p>
                <p className="mt-1 text-lg font-semibold text-[var(--text)]">
                  {soilStatusLine === null ? soilValue ?? '—' : '—'}
                </p>
                {soilDescriptor && soilStatusLine === null && (
                  <p className="text-sm text-[var(--text-secondary)]">{soilDescriptor}</p>
                )}
                {soilStatusLine && (
                  <p className="text-sm font-semibold text-[var(--warn-text)]">{soilStatusLine}</p>
                )}
                {soilLastValid && (
                  <p className="text-xs text-[var(--text-secondary)]">{soilLastValid}</p>
                )}
              </div>
            )}
            {hasDendroDevices && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {t('zone.water.treeStress', { defaultValue: 'Tree stress' })}
                </p>
                <p className="mt-1 text-lg font-semibold text-[var(--text)]">
                  {latestZoneRecommendation?.zone_stress_summary?.replace(/_/g, ' ')
                    ?? t('zone.water.awaitingRecommendation', { defaultValue: 'Awaiting recommendation' })}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {latestZoneRecommendation?.zone_confidence_score != null
                    ? t('zone.water.confidence', {
                        percent: Math.round(latestZoneRecommendation.zone_confidence_score * 100),
                        defaultValue: '{{percent}}% confidence',
                      })
                    : t('zone.water.confidencePending', { defaultValue: 'Confidence updates with the latest dendro run' })}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {canWrite && showDeleteConfirm && (
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
      {canWrite && modules.schedulerUi && (
        <ScheduleSection
          zoneId={zone.id}
          zoneName={zone.name}
          onAdvancedOpen={() => setShowAdvancedDrawer(true)}
        />
      )}

      {/* Dendrometer Monitoring Section */}
      <DendrometerSection
        zone={zone}
        devices={lsn50Nodes}
        predictionAdvisoryEnabled={modules.predictionAdvisory}
      />

      {/* Environment Section */}
      {modules.environment && <EnvironmentCard zone={zone} devices={devices} />}

      {/* Devices in Zone — collapsible */}
      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <button
          className="w-full flex items-center justify-between text-left group"
          aria-expanded={!devicesCollapsed}
          onClick={() => setDevicesCollapsed(c => !c)}
        >
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] group-hover:text-[var(--text)] transition-colors">
            {t('zone.devicesInZone')}
          </span>
          <span
            className="text-[var(--text-tertiary)] text-xl transition-transform duration-200"
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{tDashboard('soilSensors')}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {kiwiSensors.map((device) => (
                      <div key={device.deveui} className="relative">
                        <KiwiSensorCard
                          device={device}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                          readOnly={!canWrite}
                          removeContext="zone"
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{tDashboard('smartValves')}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {stregaValves.map((device) => (
                      <div key={device.deveui} className="relative">
                        <StregaValveCard
                          device={device}
                          onUpdate={onUpdate}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          removeContext="zone"
                          irrigationActuations={irrigationActuations}
                          timeZone={zone.timezone}
                          valve={valvesByEui?.get(device.deveui)}
                          readOnly={!canWrite}
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('zone.groups.lsn50Nodes', { defaultValue: 'Dragino LSN50 Nodes' })}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {lsn50Nodes.map((device) => (
                      <div key={device.deveui} className="relative">
                        <DraginoTempCard
                          device={device}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                          readOnly={!canWrite}
                          removeContext="zone"
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

              {/* SDI-12 Soil Nodes */}
              {sdi12Nodes.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('zone.groups.sdi12Nodes', { defaultValue: 'SDI-12 Soil Nodes' })}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sdi12Nodes.map((device) => (
                      <div key={device.deveui} className="relative">
                        <Sdi12SoilCard
                          device={device}
                          onOpenSettings={() => setSdi12SettingsDevice(device)}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                          readOnly={!canWrite}
                          removeContext="zone"
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

              {/* Weather Stations */}
              {s2120Stations.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('zone.groups.weatherStations', { defaultValue: 'Weather Stations' })}</p>
                  <div className="grid grid-cols-1 gap-4">
                    {s2120Stations.map((device) => (
                      <div key={device.deveui} className="relative">
                        <SenseCapWeatherCard
                          device={device}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                          allZones={allZones ?? [{ id: zone.id, name: zone.name }]}
                          readOnly={!canWrite}
                          removeContext="zone"
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

              {/* Rain Gauges */}
              {loRainGauges.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-3">{t('zone.groups.rainGauges', { defaultValue: 'Rain Gauges' })}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {loRainGauges.map((device) => (
                      <div key={device.deveui} className="relative">
                        <LoRainGaugeCard
                          device={device}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                          readOnly={!canWrite}
                          removeContext="zone"
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
              {canWrite && <button
                onClick={() => setShowAssignModal(true)}
                className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] font-bold px-6 py-3 rounded-lg transition-colors"
              >
                {t('zone.assignFirst')}
              </button>}
            </div>
          )
        )}
      </div>

      </>
      )} {/* end !zoneCollapsed */}

      {/* Zone device modal: assign an existing device or register a new one.
          Gated on `canWrite` (wave 3 scoped-access port): a prior port had left this
          unconditional pending scoping work landing -- it has now landed. */}
      <ZoneDeviceModal
        isOpen={canWrite && showAssignModal}
        onClose={() => setShowAssignModal(false)}
        onChanged={onUpdate}
        zoneId={zone.id}
        zoneName={zone.name}
        availableDevices={unassignedDevices}
      />

      <ZoneConfigModal
        isOpen={canWrite && showConfigModal}
        zone={zone}
        onClose={() => setShowConfigModal(false)}
        onSaved={onUpdate}
      />

      <AdvancedScheduleDrawer
        isOpen={canWrite && showAdvancedDrawer}
        zone={zone}
        onClose={() => setShowAdvancedDrawer(false)}
        onSaved={onUpdate}
      />

      {sdi12SettingsDevice && (
        <Sdi12SettingsModal
          device={sdi12SettingsDevice}
          onClose={() => setSdi12SettingsDevice(null)}
          onUpdate={onUpdate}
        />
      )}
    </div>
  );
};
