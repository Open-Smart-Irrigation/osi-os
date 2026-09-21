import { describe, expect, it } from 'vitest';

import { ENTITY_NAME_MAX, normalizeEntityName } from '../entityName';

// The sixteen vectors of the rename design, section 4, in the order the design
// lists them. Every character that is not plain ASCII is written as a \u escape
// so a diff shows it and no editor can normalise it away.
describe('normalizeEntityName', () => {
  it('keeps a plain name unchanged', () => {
    expect(normalizeEntityName('North block')).toEqual({ ok: true, name: 'North block' });
  });

  it('strips ASCII spaces and a trailing line feed', () => {
    expect(normalizeEntityName('  North block \u000a')).toEqual({ ok: true, name: 'North block' });
  });

  it('strips a no-break space at both ends', () => {
    expect(normalizeEntityName('\u00a0Bloc nord\u00a0')).toEqual({ ok: true, name: 'Bloc nord' });
  });

  it('strips a byte-order mark', () => {
    expect(normalizeEntityName('\ufeffNorth')).toEqual({ ok: true, name: 'North' });
  });

  it('strips a line separator and a paragraph separator at the ends', () => {
    expect(normalizeEntityName('\u2028North\u2029')).toEqual({ ok: true, name: 'North' });
  });

  it('rejects an empty string', () => {
    expect(normalizeEntityName('')).toEqual({ ok: false, reason: 'name_empty' });
  });

  it('rejects whitespace only', () => {
    expect(normalizeEntityName('   ')).toEqual({ ok: false, reason: 'name_empty' });
  });

  it('rejects an interior tab', () => {
    // '\u0009' is the tab; the '7' that follows it is a separate character.
    expect(normalizeEntityName('Row\u00097')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('rejects an interior NUL', () => {
    expect(normalizeEntityName('Row\u00007')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('rejects an interior line separator', () => {
    expect(normalizeEntityName('A\u2028B')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('rejects U+0085, which is Cc and outside the trim set', () => {
    expect(normalizeEntityName('\u0085North')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('accepts exactly 100 code points', () => {
    const name = 'a'.repeat(ENTITY_NAME_MAX);
    expect(normalizeEntityName(name)).toEqual({ ok: true, name });
  });

  it('rejects 101 code points', () => {
    expect(normalizeEntityName('a'.repeat(ENTITY_NAME_MAX + 1)))
      .toEqual({ ok: false, reason: 'name_too_long' });
  });

  it('counts code points, not UTF-16 units', () => {
    // 100 seedlings: 100 code points, 200 UTF-16 units. The cloud column is
    // VARCHAR(100), which counts code points too, so this must be accepted.
    const name = '\ud83c\udf31'.repeat(ENTITY_NAME_MAX);
    expect(name.length).toBe(200);
    expect(normalizeEntityName(name)).toEqual({ ok: true, name });
  });

  it('rejects a lone high surrogate', () => {
    expect(normalizeEntityName('\ud83c')).toEqual({ ok: false, reason: 'name_invalid_unicode' });
  });

  it('rejects a lone low surrogate', () => {
    expect(normalizeEntityName('\udf31x')).toEqual({ ok: false, reason: 'name_invalid_unicode' });
  });
});
