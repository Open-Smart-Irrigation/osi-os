import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import * as base from '../src/utils/datetime';
export * from '../src/utils/datetime';
const farmOptions = (options?: Intl.DateTimeFormatOptions) => ({timeZone: 'Africa/Kampala', ...options});
export const formatTime: typeof base.formatTime = (value, language, options) => base.formatTime(value, language, farmOptions(options));
export const formatDate: typeof base.formatDate = (value, language, options) => base.formatDate(value, language, farmOptions(options));
export const formatDateTime: typeof base.formatDateTime = (value, language, options) => base.formatDateTime(value, language, farmOptions(options));
export const formatWeekday: typeof base.formatWeekday = (value, language, options) => base.formatWeekday(value, language, farmOptions(options));
export function createDateFormatter(language?: string | null): base.DateFormatter {
  return {...base.createDateFormatter(language),
    time: (value, options) => formatTime(value, language, options),
    date: (value, options) => formatDate(value, language, options),
    dateTime: (value, options) => formatDateTime(value, language, options),
    weekday: (value, options) => formatWeekday(value, language, options)};
}
export function useDateFormat(): base.DateFormatter {
  const {i18n} = useTranslation();
  return useMemo(() => createDateFormatter(i18n?.language), [i18n?.language]);
}
