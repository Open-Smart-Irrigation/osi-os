import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Measurements formatted for the interface language, as the OSI Cloud's `utils/number.ts`
 * does: French, Italian, Spanish and Portuguese use a decimal comma (`16,8`), Swiss German
 * groups thousands with an apostrophe. `toFixed` prints a period in every language.
 */

/** What a missing or unparseable number renders as. */
export const NO_VALUE = '—';

export function formatNumber(value: number | null | undefined, locale: string | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return NO_VALUE;
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: digits, maximumFractionDigits: digits };
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    // Unsupported or invalid BCP 47 tag: render in the runtime default rather than lose the value.
    return new Intl.NumberFormat(undefined, options).format(value);
  }
}

/** `formatNumber` with the interface language already bound. */
export function useFormatNumber(): (value: number | null | undefined, digits?: number) => string {
  const { i18n } = useTranslation();
  // Unit tests often mock useTranslation with `t` only; the runtime default locale is the fallback.
  const locale = i18n?.resolvedLanguage || i18n?.language || undefined;
  return useCallback((value: number | null | undefined, digits = 1) => formatNumber(value, locale, digits), [locale]);
}
