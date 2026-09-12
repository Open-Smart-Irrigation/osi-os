import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');

function readDashboard(locale: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'dashboard.json'), 'utf8'));
}

test('dashboard locale files carry a real string "network" nav key in every locale', () => {
  // Regression coverage: the network nav label used to read the bare
  // `network` key, which fell back to network.json's `{ "network": {...} }`
  // object shape and i18next rendered "returned an object instead of
  // string." Every locale must carry dashboard.json:network as a string.
  for (const locale of ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt']) {
    const dashboard = readDashboard(locale);
    assert.equal(typeof dashboard.network, 'string', `${locale} dashboard.json missing string "network" key`);
    assert.notEqual(dashboard.network.trim(), '', `${locale} dashboard.json "network" key is empty`);
  }
});
