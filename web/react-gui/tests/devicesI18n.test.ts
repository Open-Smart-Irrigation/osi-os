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
  const requiredKeys = [
    'stregaValve.actuationFeedback.closed',
    'stregaValve.actuationFeedback.closedAt',
    'stregaValve.actuationFeedback.open',
    'stregaValve.actuationFeedback.openClosesAt',
    'stregaValve.actuationFeedback.openQueued',
    'stregaValve.actuationFeedback.waitingForUplink',
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
