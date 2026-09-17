import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];

function readNamespace(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, `${namespace}.json`), 'utf8'));
}

function getPath(tree: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, tree);
}

// Read by SystemPanel.tsx (the Gateway system-status card: temperature,
// memory, CPU load, fan control, reboot) and by SettingsPage.tsx /
// SystemPanel.tsx's shared "Admin only" role-gating hint. Mirrors the
// pattern in waterCardLocales.test.ts -- a key missing from one locale
// silently falls back to English on that language, which is exactly the
// leak F32 closed.

const DEVICES_KEYS = [
  'systemPanel.title',
  'systemPanel.subtitle',
  'systemPanel.updated',
  'systemPanel.refresh',
  'systemPanel.loadError',
  'systemPanel.cpuTemperature',
  'systemPanel.maxTemperature',
  'systemPanel.memory',
  'systemPanel.memoryUsed',
  'systemPanel.cpuLoad',
  'systemPanel.load1m',
  'systemPanel.load5m',
  'systemPanel.load15m',
  'systemPanel.fanControl',
  'systemPanel.fanCurrent',
  'systemPanel.fanOff',
  'systemPanel.fanLow',
  'systemPanel.fanMedium',
  'systemPanel.fanHigh',
  'systemPanel.fanMax',
  'systemPanel.fanError',
  'systemPanel.noFanDetected',
  'systemPanel.rebootButton',
  'systemPanel.rebootConfirmTitle',
  'systemPanel.rebootConfirmYes',
  'systemPanel.rebootingMessage',
  'systemPanel.rebootError',
];

const COMMON_KEYS = ['adminOnly'];

// Luganda is human translation work product: where no reviewed Luganda
// exists, the honest shipped value is the English source text, never a
// machine translation. Every key above is in that state today, tracked in
// docs/i18n/pending-luganda-translations.md. A human Luganda pass must
// change both files together, and this assertion is what forces that.
const PENDING_HUMAN_LUGANDA = new Set<string>([...DEVICES_KEYS, ...COMMON_KEYS]);

// locale:key pairs where matching English is correct: "Gateway" is kept as
// a loanword in de-CH/es/it/pt (same convention as e.g. devices.json's
// existing "GPS gateway"/"Gateway-GPS" entries), and "Max"/"max {{max}}°C"
// is an abbreviation kept as-is in de-CH/fr/it (like "MB" or "kPa").
const REVIEWED_IDENTICAL = new Set<string>([
  'de-CH:systemPanel.title',
  'de-CH:systemPanel.fanMax',
  'es:systemPanel.title',
  'fr:systemPanel.fanMax',
  'it:systemPanel.title',
  'it:systemPanel.maxTemperature',
  'it:systemPanel.fanMax',
  'pt:systemPanel.title',
]);

test('SystemPanel keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const devices = readNamespace(locale, 'devices');
    for (const key of DEVICES_KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
    const common = readNamespace(locale, 'common');
    for (const key of COMMON_KEYS) {
      assert.equal(typeof getPath(common, key), 'string', `${locale} common.json missing ${key}`);
    }
  }
});

test('SystemPanel interpolation placeholders match English in every locale', () => {
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  for (const [namespace, keys] of [['devices', DEVICES_KEYS], ['common', COMMON_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    for (const locale of LOCALES) {
      const translated = readNamespace(locale, namespace);
      for (const key of keys) {
        assert.equal(
          placeholders(getPath(translated, key) as string),
          placeholders(getPath(english, key) as string),
          `${locale} ${namespace}.json placeholder mismatch at ${key}`,
        );
      }
    }
  }
});

test('the five European locales translate every new SystemPanel key', () => {
  for (const [namespace, keys] of [['devices', DEVICES_KEYS], ['common', COMMON_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    for (const locale of ['de-CH', 'es', 'fr', 'it', 'pt']) {
      const translated = readNamespace(locale, namespace);
      const identical = keys.filter((key) => getPath(translated, key) === getPath(english, key));
      // Loanwords/abbreviations are the only expected exceptions; everything
      // else identical to English would be an untranslated key.
      assert.deepEqual(
        identical,
        identical.filter((key) => REVIEWED_IDENTICAL.has(`${locale}:${key}`)),
        `${locale} ${namespace}.json has untranslated SystemPanel values`,
      );
    }
  }
});

test('Luganda ships the English source text for SystemPanel until a human pass lands', () => {
  for (const [namespace, keys] of [['devices', DEVICES_KEYS], ['common', COMMON_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    const luganda = readNamespace('lg', namespace);
    for (const key of keys) {
      if (!PENDING_HUMAN_LUGANDA.has(key)) continue;
      assert.equal(
        getPath(luganda, key),
        getPath(english, key),
        `lg ${namespace}.json ${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`,
      );
    }
  }
});

test('de-CH SystemPanel copy avoids the eszett', () => {
  const german = readNamespace('de-CH', 'devices');
  for (const key of DEVICES_KEYS) {
    const value = getPath(german, key) as string;
    assert.ok(!value.includes('ß'), `de-CH ${key} uses ß instead of Swiss spelling`);
  }
});
