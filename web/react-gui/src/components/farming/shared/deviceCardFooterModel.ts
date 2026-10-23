import { getBatteryPercentFromVoltage, getValidBatteryPercent } from './deviceCardBattery';

/**
 * What the shared device card footer shows, kept free of i18n so the thresholds are testable
 * on their own. The same rules hold on the gateway GUI.
 */

/** Below this percentage the battery reads as low (amber, "Battery low" for assistive tech). */
export const LOW_BATTERY_PERCENT = 20;

/** From this age on the footer shows the full date and time instead of a relative age. */
export const ABSOLUTE_LAST_SEEN_AFTER_MINUTES = 6 * 60;

export interface FooterBattery {
  percent: number;
  low: boolean;
  /**
   * The percentage comes from the LSN50 voltage curve, not a reported `bat_pct`. The footer
   * marks it "≈" with an "estimated" hint, as the gateway GUI does: the LiSOCl2 cell holds
   * about 3.6 V for most of its life and then drops off a cliff.
   */
  derived: boolean;
}

/**
 * The battery to show, or null for a type that reports none (mains power, or no battery
 * field): the footer then leaves the slot empty instead of inventing a value. A real
 * percentage wins over one derived from the LSN50 voltage curve.
 */
export function footerBattery(percent: unknown, voltage?: unknown): FooterBattery | null {
  const reported = getValidBatteryPercent(percent);
  const value = reported ?? getBatteryPercentFromVoltage(voltage);
  return value === null ? null : { percent: value, low: value < LOW_BATTERY_PERCENT, derived: reported === null };
}

export type FooterLastSeen =
  | { kind: 'never' }
  | { kind: 'justNow' }
  | { kind: 'minutes'; count: number }
  | { kind: 'hours'; count: number }
  | { kind: 'absolute'; at: Date };

/**
 * Under 6 hours the age is relative ("15 min ago", "3 h ago"); from 6 hours on it is the
 * full date and time, which a farmer can match against a field visit. A missing or
 * unparseable time is "never"; a time in the future (clock skew) is "just now".
 */
export function footerLastSeen(lastSeen: string | null | undefined, nowMs: number = Date.now()): FooterLastSeen {
  if (!lastSeen) return { kind: 'never' };
  const at = new Date(lastSeen);
  if (Number.isNaN(at.getTime())) return { kind: 'never' };
  const minutes = Math.max(0, Math.floor((nowMs - at.getTime()) / 60_000));
  if (minutes >= ABSOLUTE_LAST_SEEN_AFTER_MINUTES) return { kind: 'absolute', at };
  if (minutes < 1) return { kind: 'justNow' };
  if (minutes < 60) return { kind: 'minutes', count: minutes };
  return { kind: 'hours', count: Math.floor(minutes / 60) };
}

/** Highest voltage read as a battery cell; anything above is a decoding error, not a battery. */
const MAX_RAW_BATTERY_VOLTS = 60;

/**
 * Edge rule (review R16 M1), proposed to the cloud: a device that reports neither a valid
 * percentage nor a voltage the LSN50 curve fits (STREGA Gen2 stores `bat_pct` null and
 * `bat_v` in volts; the LoRain reports volts only) shows its raw voltage instead of an empty
 * slot. No curve is guessed and the value is never amber, since no threshold is known.
 * Returns the volts to show, or null when there is no plausible reading (missing, not a
 * number, zero or below, or above 60 V).
 */
export function footerRawVoltage(voltage: unknown): number | null {
  const value = typeof voltage === 'number' ? voltage
    : typeof voltage === 'string' && voltage.trim() !== '' ? Number(voltage) : Number.NaN;
  return Number.isFinite(value) && value > 0 && value <= MAX_RAW_BATTERY_VOLTS ? value : null;
}
