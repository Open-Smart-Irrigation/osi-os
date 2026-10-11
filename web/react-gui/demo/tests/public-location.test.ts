import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {getDeviceLocationSupport, requestDeviceLocation} from '../public/device-location';

test('NE04 public location selection returns fictional farm coordinates without browser permission or GPS calls', async () => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let permissionCalls = 0, geolocationCalls = 0;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {
    permissions: {query: async () => { permissionCalls++; throw new Error('native permission prompt called'); }},
    geolocation: {getCurrentPosition: () => { geolocationCalls++; throw new Error('native GPS called'); }},
  }});
  try {
    assert.deepEqual(await getDeviceLocationSupport(), {available: true, reason: 'available', permissionState: 'granted',
      isNativeApp: false, canOpenSettings: false, message: 'Use the fictional demonstration farm location.'});
    const captured = await requestDeviceLocation();
    assert.deepEqual(captured, {latitude: 0.3476, longitude: 32.5825,
      accuracyM: 8, capturedAt: captured.capturedAt, source: 'browser'});
    assert.ok(Number.isFinite(Date.parse(captured.capturedAt)));
    assert.equal(permissionCalls, 0);
    assert.equal(geolocationCalls, 0);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('NE04 public map replacement is bundled imagery and leaves no remote tile request in its public layer', async () => {
  const source = await readFile(fileURLToPath(new URL('../public/offline-map.tsx', import.meta.url)), 'utf8');
  const image = await readFile(fileURLToPath(new URL('../public/offline-map.svg', import.meta.url)), 'utf8');
  const vite = await readFile(fileURLToPath(new URL('../../vite.demo.config.ts', import.meta.url)), 'utf8');
  assert.match(source, /L\.imageOverlay\(offlineMapUrl/);
  assert.match(image, /<svg/);
  assert.doesNotMatch(source, /https?:\/\//);
  assert.match(vite, /demo\/public\/offline-map\.tsx/);
  assert.match(vite, /demo\/public\/device-location\.ts/);
});
