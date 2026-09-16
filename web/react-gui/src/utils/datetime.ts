import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Date/time formatting keyed to the app's active i18n language.
 *
 * Call sites used to pass `[]` or `undefined` as the `Intl` locale argument,
 * which formats against the browser's OS locale and ignores the in-app
 * language entirely: switching the GUI to French left every clock and date in
 * the operating system's format. Everything here takes the language
 * explicitly so that cannot drift again.
 */

export type DateInput = string | number | Date | null | undefined;

/** i18next's own `fallbackLng`; see src/i18n/config.ts. */
const FALLBACK_LOCALE = 'en';

const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
const WEEKDAY_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'short' };

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
];

/**
 * Maps an i18n language tag to a locale `Intl` can actually format with.
 * Runtimes carry different slices of CLDR — `lg` (Luganda) has date data in
 * some and none in others — so an unsupported tag resolves to the app's
 * declared fallback instead of to whatever the host machine is set to.
 */
export function resolveDateLocale(language?: string | null): string {
  const tag = typeof language === 'string' ? language.trim() : '';
  if (!tag) return FALLBACK_LOCALE;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0 ? tag : FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** Parses any accepted input into a Date, or `null` when there is nothing valid to show. */
export function toDate(value: DateInput): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWith(
  value: DateInput,
  language: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const date = toDate(value);
  if (date === null) return null;
  try {
    return new Intl.DateTimeFormat(resolveDateLocale(language), options).format(date);
  } catch {
    return null;
  }
}

/** Clock time, e.g. `09:41`. `null` when the input is missing or unparseable. */
export function formatTime(
  value: DateInput,
  language?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string | null {
  return formatWith(value, language, { ...TIME_OPTIONS, ...options });
}

/** Short calendar date, e.g. `8 Jul`. */
export function formatDate(
  value: DateInput,
  language?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string | null {
  return formatWith(value, language, { ...DATE_OPTIONS, ...options });
}

/** Date and clock time together, for timestamps shown outside a chart axis. */
export function formatDateTime(
  value: DateInput,
  language?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string | null {
  return formatWith(value, language, { ...DATE_TIME_OPTIONS, ...options });
}

/** Abbreviated weekday, e.g. `Tue`. */
export function formatWeekday(
  value: DateInput,
  language?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string | null {
  return formatWith(value, language, { ...WEEKDAY_OPTIONS, ...options });
}

/**
 * Distance from now in words, e.g. `4 hours ago`. Used for "no reading since
 * …" status lines, where an absolute timestamp alone does not tell the
 * operator how bad the gap is.
 */
export function formatRelativeToNow(
  value: DateInput,
  language?: string | null,
  now: number = Date.now(),
): string | null {
  const date = toDate(value);
  if (date === null) return null;
  const deltaMs = date.getTime() - now;
  const absMs = Math.abs(deltaMs);
  try {
    const formatter = new Intl.RelativeTimeFormat(resolveDateLocale(language), { numeric: 'auto' });
    for (const [unit, unitMs] of RELATIVE_UNITS) {
      if (absMs >= unitMs || unit === 'second') {
        return formatter.format(Math.round(deltaMs / unitMs), unit);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface DateFormatter {
  /** The locale actually handed to `Intl`, after the `lg` fallback above. */
  locale: string;
  time(value: DateInput, options?: Intl.DateTimeFormatOptions): string | null;
  date(value: DateInput, options?: Intl.DateTimeFormatOptions): string | null;
  dateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string | null;
  weekday(value: DateInput, options?: Intl.DateTimeFormatOptions): string | null;
  relativeToNow(value: DateInput, now?: number): string | null;
}

export function createDateFormatter(language?: string | null): DateFormatter {
  return {
    locale: resolveDateLocale(language),
    time: (value, options) => formatTime(value, language, options),
    date: (value, options) => formatDate(value, language, options),
    dateTime: (value, options) => formatDateTime(value, language, options),
    weekday: (value, options) => formatWeekday(value, language, options),
    relativeToNow: (value, now) => formatRelativeToNow(value, language, now),
  };
}

/**
 * Component-side entry point. react-i18next returns an empty `i18n` object
 * when no instance is initialised — static renders in the tsx-runner tests do
 * exactly that — so an absent `language` is a legitimate state here and falls
 * back to English rather than throwing.
 */
export function useDateFormat(): DateFormatter {
  const { i18n } = useTranslation();
  const language = i18n?.language;
  return useMemo(() => createDateFormatter(language), [language]);
}
