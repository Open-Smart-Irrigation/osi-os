import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');

function readDevices(locale: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
}

function getPath(obj: Record<string, any>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

test('devices locale files include irrigation actuation translation keys', () => {
  // C2 final fix wave ("one ValveTile everywhere"): `stregaValve.actuationFeedback.*` was
  // read only by the now-deleted StregaValveCard.tsx (getStregaActuationFeedback) -- the
  // shared ValveTile surfaces the same information via valves.json's own state/pendingHint/
  // planIncomplete keys instead. Removed from this required set alongside the keys
  // themselves (all 7 devices.json), which stregaValveCard.test.ts's own deletion also
  // stopped exercising.
  const requiredKeys = [
    'irrigationOutcomes.duration',
    'irrigationOutcomes.totalVolume',
    'irrigationOutcomes.irrigated',
    'irrigationOutcomes.timestampTitle',
    'irrigationOutcomes.settings',
    'irrigationOutcomes.advancedView',
  ];

  for (const locale of ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt']) {
    const devices = readDevices(locale);
    for (const key of requiredKeys) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} missing ${key}`);
    }
  }
});
