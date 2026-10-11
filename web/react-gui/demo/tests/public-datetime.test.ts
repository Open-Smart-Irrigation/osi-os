import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {test} from 'node:test';

test('public datetime uses explicit timezone, then display default, then gateway fallback', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {
    localStorage: {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)},
    dispatchEvent: () => true,
  }});
  const {formatTime} = await import('../public/datetime');
  const {setGatewayTimezone, subscribeTimezone} = await import('../timezone-store');
  const stamp = '2026-10-10T00:30:00.000Z';
  let invalidations = 0;
  const unsubscribe = subscribeTimezone(() => {invalidations += 1;});
  setGatewayTimezone('Africa/Kampala');
  assert.match(formatTime(stamp, 'en'), /3:30/);
  values.set('osi.defaults.timezone', 'Europe/Zurich');
  assert.match(formatTime(stamp, 'en'), /2:30/);
  assert.match(formatTime(stamp, 'en', {timeZone: 'America/New_York'}), /8:30/);
  values.delete('osi.defaults.timezone');
  setGatewayTimezone('Europe/Zurich');
  assert.match(formatTime(stamp, 'en'), /2:30/);
  assert.equal(invalidations, 1);
  unsubscribe();
});

test('public Vite alias is opt-in so the ordinary demonstration keeps its Kampala formatter', async () => {
  const {createDemoViteConfig, datetimeAlias} = await import('../../vite.demo.config');
  const publicConfig = createDemoViteConfig('public');
  const presentationConfig = createDemoViteConfig('presentation');
  const publicFlag = publicConfig.define?.['import.meta.env.VITE_PUBLIC_SIMULATOR'];
  const presentationFlag = presentationConfig.define?.['import.meta.env.VITE_PUBLIC_SIMULATOR'];

  assert.equal(JSON.parse(publicFlag!), 'true');
  assert.equal(JSON.parse(presentationFlag!), 'false');
  assert.equal(datetimeAlias('public'), resolve(import.meta.dirname, '../../demo/public/datetime.ts'));
  assert.equal(datetimeAlias('presentation'), resolve(import.meta.dirname, '../../demo/datetime.ts'));
  assert.equal(presentationConfig.base, '/');
  assert.equal(publicConfig.base, '/simulator/');
});
