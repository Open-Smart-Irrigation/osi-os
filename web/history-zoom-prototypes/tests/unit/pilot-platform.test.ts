import { describe, expect, test } from 'vitest';
import { platformConfig } from '../../src/pilot/platform';

describe('pilot platform contract', () => {
  test('uses fixed edge and cloud paths', () => {
    expect(platformConfig('edge')).toEqual({
      historyPrefix: '/api/history',
      zonesPath: '/api/irrigation-zones',
      loginPath: '/gui/#/login',
    });
    expect(platformConfig('cloud')).toEqual({
      historyPrefix: '/api/v1/history',
      zonesPath: '/api/v1/irrigation-zones',
      loginPath: '/login',
    });
  });

  test('rejects an unknown runtime platform', () => {
    expect(() => platformConfig('other' as never)).toThrow();
  });
});
