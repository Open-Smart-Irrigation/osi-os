export interface ExactInstantFormatOptions {
  includeYear?: boolean;
}

export function formatExactInstant(timestamp: number, locale?: string, timeZone?: string, options: ExactInstantFormatOptions = {}): string {
  const formatter = new Intl.DateTimeFormat(locale, {
    ...(options.includeYear ? { year: 'numeric' as const } : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'shortOffset',
  });
  return formatter.format(timestamp);
}
