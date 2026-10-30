// The banner under a zone's water summary when its environment data comes
// from a fallback source instead of the linked OSI Server (#310). Both
// EnvironmentCard and IrrigationZoneCard render this banner; the rules live
// here once so the two cards cannot drift.
//
// A newer gateway sends `display.fallbackReasonCode`, a stable open-
// vocabulary code (`using_last_synced`, `bundle_unavailable` today; more may
// come). `display.fallbackReason` is the legacy English sentence, still
// emitted byte-for-byte for older clients and, on linked zones, sometimes
// authored by the cloud bundle itself. Rules: a recognized code translates;
// an unrecognized code, an absent code with unknown prose, and anything else
// unrecognized render the generic translated key — never a raw identifier and
// never raw prose. An older response with a known sentence keeps its legacy
// translation. Neither field means no banner at all.

import type { TFunction } from 'i18next';

type Translate = TFunction<'devices'>;

export interface DisplayFallbackSource {
  fallbackReason?: string | null;
  fallbackReasonCode?: string | null;
}

// The codes this GUI recognizes. The edge vocabulary is open, so an
// unrecognized code still arrives here — it renders the generic key below.
type RecognizedFallbackCode = 'using_last_synced' | 'bundle_unavailable';

const CODE_KEYS: Record<string, RecognizedFallbackCode> = {
  using_last_synced: 'using_last_synced',
  bundle_unavailable: 'bundle_unavailable',
};

// The two sentences the edge's zone-env flow node still emits; same mapping
// the edge derives its codes from, kept for gateways that predate codes.
const LEGACY_SENTENCE_CODES: Record<string, RecognizedFallbackCode> = {
  'Using last synced OSI Server values.': 'using_last_synced',
  'Using local fallback because the OSI Server bundle is unavailable.': 'bundle_unavailable',
};

export function formatDisplayFallbackReason(
  t: Translate,
  display: DisplayFallbackSource | null | undefined,
): string | null {
  const code = display?.fallbackReasonCode ?? null;
  if (code) {
    const key = Object.prototype.hasOwnProperty.call(CODE_KEYS, code) ? CODE_KEYS[code] : undefined;
    if (!key) {
      // eslint-disable-next-line no-console
      console.debug('[displayFallback] unmapped display.fallbackReasonCode', code);
      return t('zone.water.source.fallback_generic');
    }
    return t(`zone.water.source.${key}`);
  }
  const reason = display?.fallbackReason ?? null;
  if (!reason) return null;
  if (display?.fallbackReasonCode !== undefined) {
    return t('zone.water.source.fallback_generic');
  }
  const legacyCode = Object.prototype.hasOwnProperty.call(LEGACY_SENTENCE_CODES, reason)
    ? LEGACY_SENTENCE_CODES[reason]
    : undefined;
  if (!legacyCode) {
    // eslint-disable-next-line no-console
    console.debug('[displayFallback] unmapped display.fallbackReason', reason);
    return t('zone.water.source.fallback_generic');
  }
  return t(`zone.water.source.${legacyCode}`);
}
