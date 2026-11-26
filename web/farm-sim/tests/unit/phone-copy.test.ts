import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {applyPhoneCopy} from '../../src/phone/copy';
import {applyPublicCopy} from '@osi-demo/public-copy';
import {expectedCopy, locales, providerOrPlace, shipped, shippedLocales} from '../phone-spec';

const {createInstance} = createRequire(new URL('../../../react-gui/package.json', import.meta.url))('i18next') as typeof import('i18next');
const namespaces = readdirSync(new URL('en/', shippedLocales)).map(file => file.replace(/\.json$/, ''));
const publicOnly = new Set([
  'devices:environment.source.illustrative',
  'devices:environment.source.meteoswiss',
  'devices:environment.description.weatherConditions',
]);

const strings = function* (tree: unknown, path = ''): Generator<[string, string]> {
  if (typeof tree === 'string') yield [path, tree];
  else if (tree && typeof tree === 'object') {
    for (const [key, value] of Object.entries(tree)) yield* strings(value, path ? `${path}.${key}` : key);
  }
};

for (const locale of locales) {
  test(`phone copy matches the spec and contains no provider or place strings in ${locale}`, async () => {
    const instance = createInstance();
    await instance.init({
      lng: locale, fallbackLng: 'en',
      resources: Object.fromEntries(locales.map(lang => [lang, Object.fromEntries(namespaces.map(ns => [
        ns, JSON.parse(readFileSync(new URL(`${lang}/${ns}.json`, shippedLocales), 'utf8')),
      ]))])),
    });
    // The lg demo adds these to the real app's valve resources before public copy.
    const valves = JSON.parse(readFileSync(new URL('../../../react-gui/demo/locales/lg-valves.json', import.meta.url), 'utf8'));
    for (const [key, value] of Object.entries(valves)) instance.addResource('lg', 'valves', key, value as string);
    applyPublicCopy(instance);
    const before = structuredClone(instance.services.resourceStore.data[locale]);
    applyPhoneCopy(instance);

    const expected = expectedCopy(locale);
    const actual = instance.services.resourceStore.data[locale];
    for (const [ns, tree] of Object.entries(actual)) {
      const previous = new Map(strings(before[ns]));
      for (const [key, value] of strings(tree)) {
        if (previous.get(key) !== value) assert.ok(expected[`${ns}:${key}`], `Undocumented override: ${ns}:${key}`);
      }
    }
    for (const [key, value] of Object.entries(expected)) {
      const [ns, name] = key.split(':');
      if (!publicOnly.has(key) && !name.startsWith('farmSim.')) {
        assert.equal(typeof shipped('en', key), 'string', `Missing shipped key: ${key}`);
      }
      assert.equal(instance.getResource(locale, ns, name), value, key);
      assert.equal(instance.t(key, {skipInterpolation: true}), value, key);
    }
    for (const [key, value] of strings(actual)) assert.doesNotMatch(value, providerOrPlace, key);
  });
}

test('provider/place scan matches names and leaves dendrometer text intact', () => {
  for (const value of ['OpenAgri', 'Open-Meteo.com', 'MétéoSuisse', 'Europe/Rome', 'Africa/Kampala', 'Roma']) {
    assert.match(value, providerOrPlace);
  }
  for (const value of ['Dendrometer', 'dendrometro', 'Promedio']) assert.doesNotMatch(value, providerOrPlace);
});
