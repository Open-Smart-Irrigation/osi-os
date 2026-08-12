import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');

function getPath(obj: Record<string, any>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

test('every locale carries the two-tab zone device modal keys', () => {
  const requiredKeys = [
    'zoneDeviceModal.title',
    'zoneDeviceModal.tabAssign',
    'zoneDeviceModal.tabRegister',
    'zoneDeviceModal.assignConflict',
    'zoneDeviceModal.registerZoneNotice',
    'zoneDeviceModal.registerSubmit',
    'zoneDeviceModal.registering',
  ];

  for (const locale of ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt']) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'),
    );
    for (const key of requiredKeys) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} missing ${key}`);
    }
  }
});
