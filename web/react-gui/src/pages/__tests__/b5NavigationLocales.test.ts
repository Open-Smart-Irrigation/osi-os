import { describe, expect, it } from 'vitest';
import enSettings from '../../../public/locales/en/settings.json';
import itSettings from '../../../public/locales/it/settings.json';
import esSettings from '../../../public/locales/es/settings.json';
import ptSettings from '../../../public/locales/pt/settings.json';
import enDashboard from '../../../public/locales/en/dashboard.json';
import deDashboard from '../../../public/locales/de-CH/dashboard.json';
import lgDashboard from '../../../public/locales/lg/dashboard.json';
import enCommon from '../../../public/locales/en/common.json';
import deCommon from '../../../public/locales/de-CH/common.json';
import enAccountLink from '../../../public/locales/en/accountLink.json';

// Copy coverage and placeholders; translation quality still needs native review.
describe('B5 navigation and time-zone copy', () => {
  it.each([['it', itSettings], ['es', esSettings], ['pt', ptSettings]] as const)('translates every time-zone string in %s and preserves placeholders', (_lang, target) => {
    const keys = Object.keys(enSettings).filter(key => key.startsWith('timeZone')) as Array<keyof typeof enSettings>;
    for (const key of keys) {
      const source = String(enSettings[key]);
      const translated = String(target[key]);
      expect(translated, key).not.toBe(source);
      expect([...translated.matchAll(/{{\w+}}/g)].map(m => m[0]).sort(), key)
        .toEqual([...source.matchAll(/{{\w+}}/g)].map(m => m[0]).sort());
    }
  });

  it('uses sentence case and consistent navigation destinations', () => {
    expect(enDashboard.addMenu.zone).toBe('Add zone');
    expect(enDashboard.addMenu.device).toBe('Add device');
    expect(enDashboard.adminMenu.grants).toBe('Access grants');
    expect(enDashboard.logout).toBe('Log out');
    expect(enAccountLink.backToDashboard).toBe('Back to dashboard');
    expect(enCommon.analysis.backToDashboard).toBe('Back to dashboard');
    expect(deCommon.analysis.layout.smallMultiples).toBe('Einzeldiagramme');
    expect(deDashboard.title).toBe('Bewässerungsübersicht');
  });

  it('records the new Luganda header keys as English pending human translation', () => {
    expect(lgDashboard.header).toEqual(enDashboard.header);
    expect(enDashboard.header).toEqual({ menu: 'Menu', primaryNavigation: 'Primary navigation' });
  });
});
