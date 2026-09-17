import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];

function readNamespace(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, `${namespace}.json`), 'utf8'));
}

// Module visibility (2026-09-17): the Data view, Network, Gateway and Journal
// each became a switchable module in Settings. The four new rows need a label
// in every shipped locale, or the Settings page silently falls back to English
// on that language -- the same leak waterCardLocales/f37Locales close.
const SETTINGS_KEYS = ['dataModule', 'networkModule', 'gatewayHub', 'journalModule'];

// Luganda is human translation work product: where no reviewed Luganda exists,
// the honest shipped value is the English source text, never a machine
// translation. All four keys are in that state today (tracked in
// docs/i18n/pending-luganda-translations.md), and this assertion forces the
// doc and the shipped file to move together.
const PENDING_HUMAN_LUGANDA = new Set<string>(SETTINGS_KEYS);

// locale:key pairs where matching English is correct, not an untranslated
// leak. "Gateway" is the established loanword in these locales -- devices.json
// `systemPanel.title` already ships exactly "Gateway" for each of them, and the
// naming decision (2026-09-17) is that the module row reuses the panel's own
// name rather than inventing a second one. French is the one locale that
// translates it, to "Passerelle".
const REVIEWED_IDENTICAL = new Set<string>([
  'de-CH:gatewayHub',
  'it:gatewayHub',
  'es:gatewayHub',
  'pt:gatewayHub',
]);

test('module-visibility keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const settings = readNamespace(locale, 'settings');
    for (const key of SETTINGS_KEYS) {
      assert.equal(typeof settings[key], 'string', `${locale} settings.json missing ${key}`);
      assert.ok(String(settings[key]).trim().length > 0, `${locale} settings.json ${key} is blank`);
    }
  }
});

test('the module row names match the gateway naming decision', () => {
  assert.equal(readNamespace('en', 'settings').gatewayHub, 'Gateway');
  assert.equal(readNamespace('fr', 'settings').gatewayHub, 'Passerelle');
  // The Settings row and the dashboard panel must not drift apart.
  assert.equal(readNamespace('en', 'devices').systemPanel!['title' as never], 'Gateway');
  assert.equal(readNamespace('fr', 'devices').systemPanel!['title' as never], 'Passerelle');
});

test('the five European locales translate every new module key', () => {
  const english = readNamespace('en', 'settings');
  for (const locale of ['de-CH', 'es', 'fr', 'it', 'pt']) {
    const translated = readNamespace(locale, 'settings');
    const identical = SETTINGS_KEYS.filter((key) => translated[key] === english[key]);
    assert.deepEqual(
      identical,
      identical.filter((key) => REVIEWED_IDENTICAL.has(`${locale}:${key}`)),
      `${locale} settings.json has untranslated module-visibility values`,
    );
  }
});

test('Luganda ships the English source text for the new module keys until a human pass lands', () => {
  const english = readNamespace('en', 'settings');
  const luganda = readNamespace('lg', 'settings');
  for (const key of SETTINGS_KEYS) {
    if (!PENDING_HUMAN_LUGANDA.has(key)) continue;
    assert.equal(
      luganda[key],
      english[key],
      `lg settings.json ${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`,
    );
  }
});

test('de-CH module-visibility copy avoids the eszett', () => {
  const german = readNamespace('de-CH', 'settings');
  for (const key of SETTINGS_KEYS) {
    assert.ok(!String(german[key]).includes('ß'), `de-CH settings.json ${key} uses ß instead of Swiss spelling`);
  }
});
