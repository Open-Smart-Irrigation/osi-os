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

export interface ZoneSoilStatus {
  /** A soil sensor is configured in this zone, whatever it has reported so far. */
  hasSensor: boolean;
  /** Which quantity the value below is in, or `null` when no sensor is configured. */
  quantity: SoilQuantity | null;
  sensorCount: number;
  /** Mean of the in-range channel values on the latest snapshot; `null` when none are usable. */
  mean: number | null;
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
  mean: null,
  observedAt: null,
  stale: false,
  invalid: false,
};

function isTensionSensor(device: Pick<Device, 'type_id' | 'chameleon_enabled'>): boolean {
  if (device.type_id === 'KIWI_SENSOR' || device.type_id === 'TEKTELIC_CLOVER') return true;
  return device.type_id === 'DRAGINO_LSN50' && device.chameleon_enabled === 1;
}

function isVolumetricSensor(device: Pick<Device, 'type_id'>): boolean {
  return device.type_id === 'DRAGINO_SDI12';
}

/**
 * Raw channel values, not `canonicalSwtChannels` from utils/swt: that helper
 * sanitises a non-finite reading to `null`, which would make a sensor that
 * reported a fault look like a sensor that reported nothing. The same
 * canonical-then-legacy coalescing applies.
 */
function tensionChannels(data: Device['latest_data'] | null | undefined): unknown[] {
  const row = data as Record<string, unknown> | null | undefined;
  return [
    row?.swt_1 ?? row?.swt_wm1,
    row?.swt_2 ?? row?.swt_wm2,
    row?.swt_3,
  ];
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

function summarize(
  devices: Device[],
  quantity: SoilQuantity,
  nowMs: number,
): ZoneSoilStatus {
  const range = quantity === 'tension' ? SWT_KPA_RANGE : VWC_PCT_RANGE;
  const usableValues: number[] = [];
  let reportedCount = 0;
  let valueObservedAt: string | null = null;
  let anyObservedAt: string | null = null;

  for (const device of devices) {
    const raw = quantity === 'tension'
      ? tensionChannels(device.latest_data)
      : volumetricChannels(device.latest_data);
    const { reported, usable } = partitionChannels(raw, range);
    reportedCount += reported;
    if (reported > 0) anyObservedAt = newerInstant(anyObservedAt, device.last_seen);
    if (usable.length > 0) {
      usableValues.push(...usable);
      valueObservedAt = newerInstant(valueObservedAt, device.last_seen);
    }
  }

  const mean = usableValues.length > 0
    ? usableValues.reduce((sum, value) => sum + value, 0) / usableValues.length
    : null;
  const observedAt = valueObservedAt ?? anyObservedAt;
  const observedMs = observedAt ? new Date(observedAt).getTime() : Number.NaN;

  return {
    hasSensor: true,
    quantity,
    sensorCount: devices.length,
    mean,
    observedAt,
    stale: !Number.isFinite(observedMs) || nowMs - observedMs > SENSOR_FRESHNESS_WINDOW_MS,
    invalid: reportedCount > 0 && usableValues.length === 0,
  };
}

/**
 * Tension wins when a zone carries both kinds: it is the quantity the edge
 * scheduler compares against `threshold_kpa`, so it is the number an operator
 * acts on.
 */
export function summarizeZoneSoil(devices: Device[], nowMs: number = Date.now()): ZoneSoilStatus {
  const tension = devices.filter(isTensionSensor);
  if (tension.length > 0) return summarize(tension, 'tension', nowMs);

  const volumetric = devices.filter(isVolumetricSensor);
  if (volumetric.length > 0) return summarize(volumetric, 'volumetric', nowMs);

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
