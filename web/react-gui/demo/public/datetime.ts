import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import * as base from '../../src/utils/datetime';
import {readDisplayPreferences} from '../../src/utils/displayPreferences';
import {getGatewayTimezone, subscribeTimezone} from '../timezone-store';

export * from '../../src/utils/datetime';

export function resolvePublicTimezone(): string {
  return readDisplayPreferences().defaultTimezone || getGatewayTimezone();
}

function withPublicTimezone(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return {timeZone: options?.timeZone ?? resolvePublicTimezone(), ...options};
}

export const formatTime: typeof base.formatTime = (value, language, options) => base.formatTime(value, language, withPublicTimezone(options));
export const formatDate: typeof base.formatDate = (value, language, options) => base.formatDate(value, language, withPublicTimezone(options));
export const formatDateTime: typeof base.formatDateTime = (value, language, options) => base.formatDateTime(value, language, withPublicTimezone(options));
export const formatWeekday: typeof base.formatWeekday = (value, language, options) => base.formatWeekday(value, language, withPublicTimezone(options));

export function createDateFormatter(language?: string | null): base.DateFormatter {
  return {...base.createDateFormatter(language),
    time: (value, options) => formatTime(value, language, options),
    date: (value, options) => formatDate(value, language, options),
    dateTime: (value, options) => formatDateTime(value, language, options),
    weekday: (value, options) => formatWeekday(value, language, options)};
}

export function useDateFormat(): base.DateFormatter {
  const {i18n} = useTranslation();
  const [, refresh] = useState(0);
  useEffect(() => {
    const onPreferences = () => refresh(value => value + 1);
    window.addEventListener('osi-display-preferences', onPreferences);
    const unsubscribe = subscribeTimezone(onPreferences);
    return () => {
      window.removeEventListener('osi-display-preferences', onPreferences);
      unsubscribe();
    };
  }, []);
  return useMemo(() => createDateFormatter(i18n?.language), [i18n?.language, resolvePublicTimezone()]);
}
