import { describe, expect, it } from 'vitest';
import { isMobileSoilUplotEnabled, mobileSoilHistoryContextKey } from '../mobileSoilUplot';

describe('mobile soil uPlot gate', () => {
  const ready = { buildFlag: 'true', historyUxReady: true, historyUxEnabled: true, isMobile: true, cardType: 'soil' };
  it('requires explicit build opt-in, ready permission, mobile layout and soil card', () => {
    expect(isMobileSoilUplotEnabled(ready)).toBe(true);
    expect(isMobileSoilUplotEnabled({ ...ready, buildFlag: undefined })).toBe(false);
    expect(isMobileSoilUplotEnabled({ ...ready, buildFlag: 'TRUE' })).toBe(false);
    expect(isMobileSoilUplotEnabled({ ...ready, historyUxReady: false })).toBe(false);
    expect(isMobileSoilUplotEnabled({ ...ready, historyUxEnabled: false })).toBe(false);
    expect(isMobileSoilUplotEnabled({ ...ready, isMobile: false })).toBe(false);
    expect(isMobileSoilUplotEnabled({ ...ready, cardType: 'environment' })).toBe(false);
  });
  it('changes the fence for auth, scope, card and advertised source transitions', () => {
    const base = mobileSoilHistoryContextKey(4, 'principal', 'zone:7', 'soil', 'probe-a');
    expect(mobileSoilHistoryContextKey(5, 'principal', 'zone:7', 'soil', 'probe-a')).not.toBe(base);
    expect(mobileSoilHistoryContextKey(4, 'principal', 'zone:8', 'soil', 'probe-a')).not.toBe(base);
    expect(mobileSoilHistoryContextKey(4, 'principal', 'zone:7', 'other', 'probe-a')).not.toBe(base);
    expect(mobileSoilHistoryContextKey(4, 'principal', 'zone:7', 'soil', 'probe-b')).not.toBe(base);
  });
});
