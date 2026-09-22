/**
 * The name rule of the zone and device rename design, section 4, in the exact
 * order the design runs it. The edge module `osi-entity-name` and the cloud's
 * `EntityNames` implement the same five steps against the same sixteen
 * vectors; a name this file accepts must be a name those two accept, so the
 * three may only change together.
 */

export const ENTITY_NAME_MAX = 100;

export type EntityNameReason =
  | 'name_empty'
  | 'name_too_long'
  | 'name_control_characters'
  | 'name_invalid_unicode';

export type EntityNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: EntityNameReason };

// Categories Cc (U+0000-U+001F and U+007F-U+009F), Zl (U+2028) and Zp
// (U+2029), spelled out rather than written as \p{Cc}: the property escape
// needs the u flag and ES2018, and the edge module's copy of this regex has to
// behave identically on the gateway's Node build.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * True when `value` holds a surrogate code unit without its partner. SQLite and
 * PostgreSQL store UTF-8 and cannot represent one; JavaScript can hold it, so
 * the check has to happen before the value reaches a route.
 *
 * `String.prototype.isWellFormed` answers this in one call but is ES2024, and
 * this project compiles against `"lib": ["ES2020", "DOM", "DOM.Iterable"]`
 * (tsconfig.json), so the call would neither typecheck nor exist on an older
 * browser. Scanning code units is the portable form.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function normalizeEntityName(raw: string): EntityNameResult {
  // The type guards are not decoration: the modals hand this whatever their
  // input state holds, and a caller compiled from JavaScript can pass anything.
  // An absent value is a missing name, not a broken one, and gets the reason
  // an empty string gets, so the operator reads one sentence for both. That is
  // what the edge module answers for the same input; the two copies of this
  // rule may only differ where the design says they do.
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'name_empty' };
  }
  if (typeof raw !== 'string' || hasLoneSurrogate(raw)) {
    return { ok: false, reason: 'name_invalid_unicode' };
  }

  // String.prototype.trim strips exactly the set the rule names: WhiteSpace
  // plus LineTerminator, which is U+0009, U+000A, U+000B, U+000C, U+000D,
  // U+0020, U+00A0, U+2028, U+2029, U+FEFF and every character of category Zs.
  // U+0085 is not in it, which is why that vector reaches the control-character
  // step instead of being trimmed. Java's trim() and strip() use other sets,
  // which is why the Java implementation spells the set out and this one does
  // not have to.
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'name_empty' };
  }

  // Code points, never UTF-16 units: 100 astral characters are 200 units and
  // still fit the cloud's VARCHAR(100).
  if (Array.from(trimmed).length > ENTITY_NAME_MAX) {
    return { ok: false, reason: 'name_too_long' };
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: 'name_control_characters' };
  }

  return { ok: true, name: trimmed };
}
