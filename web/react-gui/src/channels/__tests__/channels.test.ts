import { describe, expect, it } from 'vitest';
import manifest from '../channels.json';

const CARD_TYPES = new Set(['soil', 'environment', 'dendro', 'irrigation', 'gateway']);
const keys = new Set(manifest.map((c: any) => c.key));

describe('channel manifest', () => {
  it('has unique keys and required fields', () => {
    expect(new Set(manifest.map((c: any) => c.key)).size).toBe(manifest.length);
    for (const c of manifest as any[]) {
      expect(typeof c.key).toBe('string');
      expect('unit' in c).toBe(true);
      expect(c.unit === null || typeof c.unit === 'string').toBe(true);
      expect(typeof c.label).toBe('string');
      expect(typeof c.displayName).toBe('string');
      expect(CARD_TYPES.has(c.cardType)).toBe(true);
      expect(typeof c.category).toBe('string');
      expect(c.edgeField === null || typeof c.edgeField === 'string').toBe(true);
      expect(typeof c.serverField).toBe('string');
      expect(typeof c.exportable).toBe('boolean');
      expect(c.deprecated).toBe(false);
      expect(Array.isArray(c.legacyAliases)).toBe(true);
      for (const alias of c.legacyAliases) {
        expect(typeof alias).toBe('string');
      }
    }
  });

  it('aliases do not duplicate canonical keys', () => {
    for (const c of manifest as any[]) {
      for (const alias of c.legacyAliases) {
        expect(keys.has(alias)).toBe(false);
      }
    }
  });

  it('includes vwc and excludes battery diagnostics from export', () => {
    const vwc = (manifest as any[]).find(c => c.key === 'vwc');
    expect(vwc).toBeTruthy();
    expect(vwc.edgeField).toBeNull();
    expect(vwc.cardType).toBe('soil');

    for (const key of ['bat_v', 'bat_pct']) {
      const bat = (manifest as any[]).find(c => c.key === key);
      expect(bat).toBeTruthy();
      expect(bat.exportable).toBe(false);
      expect(bat.cardType).toBe('gateway');
    }
  });
});
