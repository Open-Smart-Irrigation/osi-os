import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readDisplayPreferences, writeDisplayPreferences} from '../../src/utils/displayPreferences';

test('native display preferences retain public controls and notify timezone consumers without HTTP', () => {
  const values = new Map<string, string>();
  let events = 0;
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {
    localStorage: {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)},
    dispatchEvent: (event: Event) => {if (event.type === 'osi-display-preferences') events += 1; return true;},
    matchMedia: () => ({matches: false}),
  }});
  writeDisplayPreferences({theme: 'dark', swtUnit: 'pF', dashboardDensity: 'compact', dashboardAutoRefresh: 'off',
    defaultTimezone: 'Europe/Zurich', journalDetailLevel: 'full_record',
    modules: {predictionAdvisory: true, environment: true, waterCard: false, schedulerUi: true, valveControl: true}});
  const preferences = readDisplayPreferences();
  assert.equal(preferences.theme, 'dark');
  assert.equal(preferences.swtUnit, 'pF');
  assert.equal(preferences.dashboardDensity, 'compact');
  assert.equal(preferences.dashboardAutoRefresh, 'off');
  assert.equal(preferences.defaultTimezone, 'Europe/Zurich');
  assert.equal(preferences.journalDetailLevel, 'full_record');
  assert.deepEqual(preferences.modules, {predictionAdvisory: true, environment: true, waterCard: false, schedulerUi: true, valveControl: true});
  assert.equal(events, 1);
});
