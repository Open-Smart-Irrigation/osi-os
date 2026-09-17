import type { Device } from '../types/farming';

/**
 * Soil-sensor presence and freshness for a zone.
 *
 * The water card used to render its "Soil now" box for every zone, so a zone
 * with no soil sensor at all and a zone whose sensor stopped reporting both
 * showed the same bare em dash. Presence and freshness are separate facts and
 * this module keeps them separate.
 */

/**
 * Matches the edge's own freshness window: `buildLocalEnvironment` in
 * conf/.../node-red/osi-zone-env/index.js splits fresh from stale sensors at
 * three hours, and the Environment tab's fresh/stale counts already use it.
 */
export const SENSOR_FRESHNESS_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Chameleon's resistance→kPa conversion clamps to [0, 300]; readings outside it are a fault, not a dry soil. */
const SWT_KPA_RANGE: readonly [number, number] = [0, 300];
const VWC_PCT_RANGE: readonly [number, number] = [0, 100];
const VWC_CHANNEL_COUNT = 10;

/** Tension is reported in kPa (displayed as kPa or pF); volumetric water content in percent. */
export type SoilQuantity = 'tension' | 'volumetric';

/** A single buried tension channel, or every channel pooled. */
export type SoilChannel = 'swt_1' | 'swt_2' | 'swt_3';
export type SoilChannelSelection = SoilChannel | 'mean';

export interface ZoneSoilStatus {
  /** A soil sensor is configured in this zone, whatever it has reported so far. */
  hasSensor: boolean;
  /** Which quantity the value below is in, or `null` when no sensor is configured. */
  quantity: SoilQuantity | null;
  sensorCount: number;
  /**
   * The reported channel's value on the latest snapshot, averaged across the
   * zone's sensors the way the scheduler's own query averages it; `null` when
   * nothing usable was reported.
   */
  value: number | null;
  /** Which channel `value` came from, or `mean` when every channel is pooled. */
  channel: SoilChannelSelection | null;
  /** The reported channel's burial depth, when the installation recorded one. */
  depthCm: number | null;
  /** When the contributing devices last reported; `null` when none ever have. */
  observedAt: string | null;
  /** Configured and reporting, but the newest uplink predates the freshness window. */
  stale: boolean;
  /** Configured and reporting, but no channel value is finite and in range. */
  invalid: boolean;
}

const ABSENT: ZoneSoilStatus = {
  hasSensor: false,
  quantity: null,
  sensorCount: 0,
  value: null,
  channel: null,
  depthCm: null,
  observedAt: null,
  stale: false,
  invalid: false,
};

const TENSION_CHANNELS: readonly SoilChannel[] = ['swt_1', 'swt_2', 'swt_3'];

/** Legacy write path: `swt_wm1`/`swt_wm2` are read-only aliases on old rows. */
const LEGACY_ALIAS: Partial<Record<SoilChannel, string>> = { swt_1: 'swt_wm1', swt_2: 'swt_wm2' };

/**
 * A channel's recorded burial depth, from either place the schema keeps one:
 * `devices.chameleon_swt{n}_depth_cm` for a Chameleon array, and the
 * `soil_moisture_probe_depths_json` map for a soil-moisture probe. Depth is
 * installation geometry, not calibration, which is why it is device-local.
 */
export function probeDepthCm(device: Device, channel: string): number | null {
  const legacy = LEGACY_ALIAS[channel as SoilChannel];
  const record = device as unknown as Record<string, unknown>;
  const candidates: unknown[] = [
    device.soilMoistureProbeDepths?.[channel],
    device.soil_moisture_probe_depths_json?.[channel],
    legacy ? device.soilMoistureProbeDepths?.[legacy] : undefined,
    legacy ? device.soil_moisture_probe_depths_json?.[legacy] : undefined,
    record[`chameleon_${channel.replace('swt_', 'swt')}_depth_cm`],
  ];
  for (const candidate of candidates) {
    const depth = Number(candidate);
    if (candidate != null && Number.isFinite(depth) && depth > 0) return depth;
  }
  return null;
}

function isTensionSensor(device: Pick<Device, 'type_id' | 'chameleon_enabled'>): boolean {
  if (device.type_id === 'KIWI_SENSOR' || device.type_id === 'TEKTELIC_CLOVER') return true;
  return device.type_id === 'DRAGINO_LSN50' && device.chameleon_enabled === 1;
}

function isVolumetricSensor(device: Pick<Device, 'type_id'>): boolean {
  return device.type_id === 'DRAGINO_SDI12';
}

function volumetricChannels(data: Device['latest_data'] | null | undefined): unknown[] {
  const values: unknown[] = [];
  for (let channel = 1; channel <= VWC_CHANNEL_COUNT; channel += 1) {
    values.push((data as Record<string, unknown> | null | undefined)?.[`vwc_${channel}`]);
  }
  return values;
}

/** Splits a device's channels into "reported anything" and "reported something usable". */
function partitionChannels(raw: unknown[], [min, max]: readonly [number, number]) {
  let reported = 0;
  const usable: number[] = [];
  for (const value of raw) {
    if (value === null || value === undefined) continue;
    reported += 1;
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      usable.push(value);
    }
  }
  return { reported, usable };
}

function newerInstant(left: string | null, right: string | null | undefined): string | null {
  if (!right) return left;
  if (!left) return right;
  return new Date(right).getTime() > new Date(left).getTime() ? right : left;
}

function selectChannel(
  available: SoilChannel[],
  depths: Map<SoilChannel, number | null>,
  requested: SoilChannelSelection | null,
): SoilChannelSelection | null {
  if (available.length === 0) return null;
  if (requested === 'mean') return 'mean';
  if (requested && available.includes(requested)) return requested;
  // The shallowest channel leads the drying front and is what drives
  // irrigation timing; a channel with no recorded depth sorts last, and ties
  // fall back to channel order.
  return available
    .slice()
    .sort((left, right) => {
      const leftDepth = depths.get(left) ?? Number.POSITIVE_INFINITY;
      const rightDepth = depths.get(right) ?? Number.POSITIVE_INFINITY;
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      return TENSION_CHANNELS.indexOf(left) - TENSION_CHANNELS.indexOf(right);
    })[0];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeVolumetric(devices: Device[], nowMs: number): ZoneSoilStatus {
  const [min, max] = VWC_PCT_RANGE;
  const usableValues: number[] = [];
  let reportedCount = 0;
  let valueObservedAt: string | null = null;
  let anyObservedAt: string | null = null;

  for (const device of devices) {
    const { reported, usable } = partitionChannels(volumetricChannels(device.latest_data), [min, max]);
    reportedCount += reported;
    if (reported > 0) anyObservedAt = newerInstant(anyObservedAt, device.last_seen);
    if (usable.length > 0) {
      usableValues.push(...usable);
      valueObservedAt = newerInstant(valueObservedAt, device.last_seen);
    }
  }

  const observedAt = valueObservedAt ?? anyObservedAt;
  const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;
  return {
    hasSensor: true,
    quantity: 'volumetric',
    sensorCount: devices.length,
    value: mean(usableValues),
    channel: usableValues.length > 0 ? 'mean' : null,
    depthCm: null,
    observedAt,
    stale: !Number.isFinite(observedMs) || nowMs - observedMs > SENSOR_FRESHNESS_WINDOW_MS,
    invalid: reportedCount > 0 && usableValues.length === 0,
  };
}

/**
 * Tension, channel by channel.
 *
 * `swt_1`, `swt_2` and `swt_3` are different burial depths — the schema keeps
 * a depth column per channel precisely because depth is installation
 * geometry. Pooling them into one arithmetic mean answers neither the shallow
 * question (does the crop need water today) nor the deep one (did we
 * over-irrigate), and in a drying front the shallow channel leads the deep one
 * by a day or more, so the mean systematically under-reports the stress the
 * crop feels. One channel is reported, and it is the one the zone's own
 * scheduler compares when the zone has a schedule.
 */
function summarizeTension(
  devices: Device[],
  nowMs: number,
  requested: SoilChannelSelection | null,
): ZoneSoilStatus {
  const [min, max] = SWT_KPA_RANGE;
  const values = new Map<SoilChannel, number[]>();
  const observedAtByChannel = new Map<SoilChannel, string | null>();
  const depths = new Map<SoilChannel, number | null>();
  let reportedCount = 0;
  let anyObservedAt: string | null = null;

  for (const device of devices) {
    const row = device.latest_data as Record<string, unknown> | null | undefined;
    for (const channel of TENSION_CHANNELS) {
      const legacy = LEGACY_ALIAS[channel];
      const raw = row?.[channel] ?? (legacy ? row?.[legacy] : undefined);
      if (raw === null || raw === undefined) continue;
      reportedCount += 1;
      anyObservedAt = newerInstant(anyObservedAt, device.last_seen);
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) continue;
      values.set(channel, [...(values.get(channel) ?? []), raw]);
      observedAtByChannel.set(channel, newerInstant(observedAtByChannel.get(channel) ?? null, device.last_seen));
      const depth = probeDepthCm(device, channel);
      if (depth != null) {
        const known = depths.get(channel);
        depths.set(channel, known == null ? depth : Math.min(known, depth));
      }
    }
  }

  const available = TENSION_CHANNELS.filter((channel) => (values.get(channel)?.length ?? 0) > 0);
  const channel = selectChannel(available, depths, requested);
  const pooled = available.flatMap((name) => values.get(name) ?? []);
  const value = channel === 'mean' ? mean(pooled) : channel ? mean(values.get(channel) ?? []) : null;
  const observedAt = channel === 'mean'
    ? available.reduce<string | null>((newest, name) => newerInstant(newest, observedAtByChannel.get(name) ?? null), null)
    : channel
      ? observedAtByChannel.get(channel) ?? null
      : anyObservedAt;
  const resolvedObservedAt = observedAt ?? anyObservedAt;
  const observedMs = resolvedObservedAt ? new Date(resolvedObservedAt).getTime() : Number.NaN;

  return {
    hasSensor: true,
    quantity: 'tension',
    sensorCount: devices.length,
    value,
    channel,
    depthCm: channel && channel !== 'mean' ? depths.get(channel) ?? null : null,
    observedAt: resolvedObservedAt,
    stale: !Number.isFinite(observedMs) || nowMs - observedMs > SENSOR_FRESHNESS_WINDOW_MS,
    invalid: reportedCount > 0 && pooled.length === 0,
  };
}

/**
 * Tension wins when a zone carries both kinds: it is the quantity the edge
 * scheduler compares against `threshold_kpa`, so it is the number an operator
 * acts on.
 */
export function summarizeZoneSoil(
  devices: Device[],
  nowMs: number = Date.now(),
  /** The channel the zone's scheduler compares, when it compares a tension channel. */
  triggerChannel: SoilChannelSelection | null = null,
): ZoneSoilStatus {
  const tension = devices.filter(isTensionSensor);
  if (tension.length > 0) return summarizeTension(tension, nowMs, triggerChannel);

  const volumetric = devices.filter(isVolumetricSensor);
  if (volumetric.length > 0) return summarizeVolumetric(volumetric, nowMs);

  return ABSENT;
}

/**
 * A flow meter is an opt-in LSN50 input on MOD9, not a property of the valve.
 *
 * This is the same predicate the edge applies for
 * `water.sensorHealth.flowMeterPresent` (`buildSensorHealth` in
 * osi-zone-env), evaluated against the device list the card is already
 * rendering — the way the tree-stress tile gates on `dendro_enabled`. Reading
 * it locally keeps the tile in step with the devices on screen even when the
 * summary is being served from the cloud mirror.
 */
export function zoneHasFlowMeter(devices: Device[]): boolean {
  return devices.some((device) => device.flow_meter_enabled === 1);
}

/**
 * Device types that measure rain without the opt-in LSN50 MOD9 input: the
 * S2120's cumulative gauge and the LoRain's interval tips.
 */
const RAIN_SOURCE_TYPE_IDS: ReadonlySet<string> = new Set(['SENSECAP_S2120', 'AQUASCOPE_LORAIN']);

/**
 * Whether anything in the zone measures rain.
 *
 * `zone_daily_environment.rainfall_mm` is written as 0 for a day with no
 * sample, so "0.0 mm" on a zone with no gauge is an invented dry day, not a
 * measurement (engineering playbook, prime directive 3). The same predicate
 * runs on the edge as `water.sensorHealth.rainGaugePresent`; the card checks
 * both, because a shared weather station reaches a zone through
 * `weather_station_zones` and never appears in that zone's device list.
 */
export function zoneHasRainGauge(devices: Device[]): boolean {
  return devices.some((device) => (
    device.rain_gauge_enabled === 1 || RAIN_SOURCE_TYPE_IDS.has(String(device.type_id))
  ));
}

const VALVE_TYPE_IDS: ReadonlySet<string> = new Set(['STREGA_VALVE', 'MILESIGHT_UC512']);

/**
 * Whether the zone has a valve, which is what makes an *estimated* irrigation
 * figure (commanded valve time × the zone's flow calibration) mean anything.
 * Without one the estimate is a zero the zone never had a way to produce.
 */
export function zoneHasValve(devices: Device[]): boolean {
  return devices.some((device) => VALVE_TYPE_IDS.has(String(device.type_id)));
}
