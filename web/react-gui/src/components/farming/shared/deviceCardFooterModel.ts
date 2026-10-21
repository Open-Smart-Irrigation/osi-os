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
   * Edge only: the percentage comes from the LSN50 voltage curve, not a reported `bat_pct`.
   * The gateway GUI marked such a value "≈" with an "estimated" hint before the shared footer
   * existed (the LiSOCl2 cell holds ~3.6 V for most of its life, then drops off a cliff), and
   * keeps that marker; the cloud footer has no marker yet.
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
