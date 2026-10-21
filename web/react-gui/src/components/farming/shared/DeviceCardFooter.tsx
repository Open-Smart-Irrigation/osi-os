import React from 'react';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../../utils/datetime';
import { footerBattery, footerLastSeen } from './deviceCardFooterModel';

export interface DeviceCardFooterProps {
  /** The device's last uplink (ISO time); null when it was never seen. */
  lastSeen: string | null | undefined;
  /** Reported battery percentage. Omit for mains-powered or non-reporting types. */
  batteryPercent?: unknown;
  /** LSN50-family battery voltage, used only when no valid percentage is reported. */
  batteryVoltage?: unknown;
  /** Injectable clock for tests. */
  nowMs?: number;
  /**
   * Edge only: text in place of the last-seen age for a device the gateway never gives a
   * `last_seen` (the field tester, whose uplinks land in the radio store), so the footer does
   * not claim "Never seen" for a device that is reporting.
   */
  lastSeenText?: string;
}

function formatPercent(percent: number, locale: string | undefined): string {
  const options: Intl.NumberFormatOptions = { style: 'percent', maximumFractionDigits: 0 };
  try {
    return new Intl.NumberFormat(locale, options).format(percent / 100);
  } catch {
    // An unusable language tag: the bare number still reads, never the host locale.
    return `${percent}%`;
  }
}

const BatteryGlyph: React.FC = () => (
  <svg aria-hidden="true" viewBox="0 0 16 10" className="h-2.5 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="0.75" y="0.75" width="12.5" height="8.5" rx="1.5" />
    <path d="M15 3.5v3" strokeLinecap="round" />
  </svg>
);

/**
 * The one footer of every device card, kept class-for-class with the OSI Cloud component:
 * battery on the left, last seen on the right, always the same height. The header carries
 * identity only and the body measurements only, so cards of the same width line up in the
 * grid (`mt-auto` keeps the footer at the card's bottom in a `flex flex-col` card). A type
 * without a battery reading keeps the slot, empty. Edge additions: a voltage-derived
 * percentage reads "≈" with an "estimated" hint, and `lastSeenText` for the field tester.
 */
export const DeviceCardFooter: React.FC<DeviceCardFooterProps> = ({ lastSeen, batteryPercent, batteryVoltage, nowMs, lastSeenText }) => {
  const { t, i18n } = useTranslation('devices');
  const locale = i18n?.language;
  const battery = footerBattery(batteryPercent, batteryVoltage);
  const seen = footerLastSeen(lastSeen, nowMs);

  let seenText: string;
  switch (seen.kind) {
    case 'never':
      seenText = t('deviceCard.footer.neverSeen');
      break;
    case 'justNow':
      seenText = t('deviceCard.footer.lastSeenJustNow');
      break;
    case 'minutes':
      seenText = t('deviceCard.footer.lastSeenMinutes', { count: seen.count });
      break;
    case 'hours':
      seenText = t('deviceCard.footer.lastSeenHours', { count: seen.count });
      break;
    case 'absolute':
      seenText = t('deviceCard.footer.lastSeenAt', { date: formatDateTime(seen.at, locale) ?? '' });
      break;
  }
  const exactTime = lastSeen && seen.kind !== 'never' && !lastSeenText ? formatDateTime(lastSeen, locale) ?? undefined : undefined;

  return (
    <footer data-testid="device-card-footer" className="mt-auto pt-3">
      <div className="flex min-h-5 items-center justify-between gap-3 border-t border-[var(--border)] pt-3 text-xs leading-5 text-[var(--text-tertiary)]">
        <span
          data-testid="device-card-battery"
          data-battery-low={battery?.low ? 'true' : undefined}
          title={battery?.derived ? t('common.batteryEstimated') : undefined}
          className={`inline-flex min-h-5 shrink-0 items-center gap-1 tabular-nums ${battery?.low ? 'font-semibold text-[var(--warn-text)]' : ''}`}
        >
          {battery && (
            <>
              <BatteryGlyph />
              <span className="sr-only">
                {battery.low ? t('deviceCard.footer.batteryLow') : t('deviceCard.footer.battery')}
                {' '}
              </span>
              {battery.derived ? '≈ ' : ''}{formatPercent(battery.percent, locale)}
            </>
          )}
        </span>
        <span data-testid="device-card-last-seen" className="min-w-0 truncate text-right" title={exactTime}>
          {lastSeenText ?? seenText}
        </span>
      </div>
    </footer>
  );
};
