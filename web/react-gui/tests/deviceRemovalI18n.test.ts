import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const locales = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];

function readDevices(locale: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
}

function getPath(obj: Record<string, any>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

test('devices locale files include the shared device-removal keys', () => {
  // `deviceRemoval.*` is the copy of DeviceRemoveConfirm.tsx and
  // deviceRemoveButtonLabel(), shared by all six device cards. A missing key
  // here renders the raw key inside a destructive confirm dialog.
  const requiredKeys = [
    'deviceRemoval.titleZone',
    'deviceRemoval.titleFarm',
    'deviceRemoval.subtitleZone',
    'deviceRemoval.subtitleFarm',
    'deviceRemoval.confirmZone',
    'deviceRemoval.confirmFarm',
    'deviceRemoval.removingZone',
    'deviceRemoval.removingFarm',
    'deviceRemoval.failedZone',
    'deviceRemoval.failedFarm',
    'deviceRemoval.buttonZone',
    'deviceRemoval.buttonFarm',
    'stregaValve.removeSubtitleZone',
  ];

  for (const locale of locales) {
    const devices = readDevices(locale);
    for (const key of requiredKeys) {
      const value = getPath(devices, key);
      assert.equal(typeof value, 'string', `${locale} missing ${key}`);
      assert.notEqual((value as string).trim(), '', `${locale} has an empty ${key}`);
    }
  }
});

test('zone-context removal copy never claims an account unlink or a deletion', () => {
  // The original defect was copy and behaviour disagreeing: the zone ✕ deleted
  // the device from the account while the dialog promised it only left the
  // zone. The zone strings must not mention the account or deleting anything.
  const forbidden: Record<string, RegExp> = {
    en: /account|delete/i,
    'de-CH': /Konto|löschen/i,
    es: /cuenta|elimina/i,
    fr: /compte|supprim/i,
    it: /account|elimina/i,
    lg: /account|delete/i,
    pt: /conta|elimina/i,
  };

  for (const locale of locales) {
    const devices = readDevices(locale);
    for (const key of ['deviceRemoval.titleZone', 'deviceRemoval.subtitleZone', 'deviceRemoval.confirmZone']) {
      const value = getPath(devices, key) as string;
      assert.equal(
        forbidden[locale].test(value),
        false,
        `${locale} ${key} promises more than a zone detach: ${value}`,
      );
    }
  }
});

test('farm-context removal copy does not claim stored readings are deleted', () => {
  // DELETE /api/devices/:deveui (flows.json delete-device-unlink) only nulls
  // user_id and irrigation_zone_id -- it never touches device_data. Earlier
  // hardcoded card copy claimed readings were deleted; that was wrong.
  const forbidden: Record<string, RegExp> = {
    en: /delete (all )?(stored |its )?readings/i,
    'de-CH': /Messwerte .*(gelöscht|löschen)/i,
    es: /(elimina|borra)\w*\s+(todas\s+)?(las\s+)?(mediciones|lecturas)/i,
    fr: /supprim\w*\s+(toutes\s+)?(les\s+)?(mesures|relevés)/i,
    it: /(elimin|cancell)\w*\s+(tutte\s+)?(le\s+)?misure/i,
    lg: /delete (all )?(stored |its )?readings/i,
    pt: /(elimina|apaga)\w*\s+(todas\s+)?(as\s+)?leituras/i,
  };

  for (const locale of locales) {
    const value = getPath(readDevices(locale), 'deviceRemoval.subtitleFarm') as string;
    assert.equal(
      forbidden[locale].test(value),
      false,
      `${locale} deviceRemoval.subtitleFarm claims readings are deleted: ${value}`,
    );
  }
});
