import type { Device, StregaModel } from '../../../types/farming';

/**
 * Pure, CSS-free helpers shared by the valve tile family. Split out of `StregaValveCard.tsx`
 * (final fix wave, C2 "one ValveTile everywhere") so `ValveServiceDialog` -- which still
 * needs `normaliseStregaModel`/`getRecognizedStregaModel` to gate its motorized-only commands --
 * keeps a home for them once that card is deleted. `describeLastSeen`/`renderLastSeen` are new
 * here (I6), ported from the OSI Server cloud's own `valveCardHelpers.ts`
 * (`ValveTile.tsx`'s top-right last-seen label).
 */

export type RecognizedStregaModel = StregaModel | 'UNKNOWN';

export function normaliseStregaModel(value: unknown): StregaModel | null {
  const raw = String(value ?? '').trim().toUpperCase();
  return raw === 'STANDARD' || raw === 'MOTORIZED' ? raw : null;
}

export function getRecognizedStregaModel(device: Device): RecognizedStregaModel {
  const explicit = normaliseStregaModel(device.strega_model);
  if (explicit) return explicit;
  const name = String(device.name || '').toLowerCase();
  if (name.includes('motor')) return 'MOTORIZED';
  if (name.includes('solenoid') || name.includes('lite') || name.includes('standard')) return 'STANDARD';
  return 'UNKNOWN';
}

export type LastSeenDescriptor =
  | { key: 'never' }
  | { key: 'justNow' }
  | { key: 'minutesAgo'; count: number }
  | { key: 'hoursAgo'; count: number }
  | { key: 'daysAgo'; count: number };

// Loose `t()` alias -- same shape as `ValveGlyph.tsx`'s own `Translate`, duplicated locally
// (rather than imported) so this module never pulls in that file's transitive
// `valveGlyphStyles.css` import. Matches the cloud's own `valveCardHelpers.ts` reasoning.
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Returns a descriptor rather than a translated string, so this stays i18n-free (see the
 * module doc comment) and directly unit-testable without a translation table.
 *
 * Tiered so a valve quiet for a day doesn't render as "1440 minutes ago": under a minute
 * reports `justNow`, under an hour reports minutes, under a day reports whole hours,
 * otherwise reports whole days. A clamped future or invalid-but-parseable timestamp also
 * lands in `justNow` rather than a negative or zero count.
 */
export function describeLastSeen(lastSeen: string | null): LastSeenDescriptor {
  if (!lastSeen) return { key: 'never' };
  const parsed = new Date(lastSeen);
  if (Number.isNaN(parsed.getTime())) return { key: 'never' };
  const minutes = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 60000));
  if (minutes < 1) return { key: 'justNow' };
  if (minutes < 60) return { key: 'minutesAgo', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'hoursAgo', count: hours };
  const days = Math.floor(hours / 24);
  return { key: 'daysAgo', count: days };
}

/**
 * Renders `describeLastSeen`'s descriptor into the `lastSeen.*` copy -- split out from
 * `describeLastSeen` itself because a typed `TFunction<'valves'>` cannot accept a
 * template-literal key, so the `_one`/`_other` plural suffix is picked HERE by the caller
 * rather than relying on i18next's own automatic count-based pluralization.
 */
export function renderLastSeen(descriptor: LastSeenDescriptor, t: Translate): string {
  if (descriptor.key === 'never') return t('lastSeen.never');
  if (descriptor.key === 'justNow') return t('lastSeen.justNow');
  const suffix = descriptor.count === 1 ? '_one' : '_other';
  return t(`lastSeen.${descriptor.key}${suffix}`, { count: descriptor.count });
}
