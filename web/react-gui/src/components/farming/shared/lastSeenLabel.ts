import type { TFunction } from 'i18next';
import { describeLastSeen } from '../valves/valveCardHelpers';

/**
 * The "last seen" label of a device card footer, in the tiers the OSI Cloud cards use: "Last
 * seen: just now / 2 minutes ago / 3 hours ago / 5 days ago", or "Never seen". i18next picks
 * the plural form from `count` (`_one` / `_other`) under `devices:deviceCard.lastSeen.*`.
 */
export function lastSeenLabel(t: TFunction<'devices'>, lastSeen: string | null | undefined): string {
  const descriptor = describeLastSeen(lastSeen ?? null);
  switch (descriptor.key) {
    case 'never':
      return t('deviceCard.lastSeen.never');
    case 'justNow':
      return t('deviceCard.lastSeen.justNow');
    case 'minutesAgo':
      return t('deviceCard.lastSeen.minutes', { count: descriptor.count });
    case 'hoursAgo':
      return t('deviceCard.lastSeen.hours', { count: descriptor.count });
    case 'daysAgo':
      return t('deviceCard.lastSeen.days', { count: descriptor.count });
  }
}
