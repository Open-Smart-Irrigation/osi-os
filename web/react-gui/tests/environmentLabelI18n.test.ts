import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The environment card, the water card and the weather card each render the
 * same facts as the rest of the zone, and each used to render some of them as
 * English literals: "Local only" three lines under a translated "Local
 * uniquement", "Air Temperature" over a value whose history drawer was
 * translated, and a reason sentence the edge had written in English prose.
 *
 * Two assertions per surface: the key exists in all seven bundles, and the
 * literal is gone from the source so it cannot come back by copy-paste.
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const srcRoot = path.resolve(process.cwd(), 'src');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];

function readDevices(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
}

function getPath(tree: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, tree);
}

const REQUIRED_KEYS = [
  // Water-balance reason codes, replacing the prose the edge used to emit.
  'zone.water.reason.supply_covers_demand',
  'zone.water.reason.forecast_rain_covers_demand',
  'zone.water.reason.demand_exceeds_supply',
  'zone.water.reason.balance_neutral',
  // Environment card badges and states. `environment.cache.*` already shipped
  // with a human Luganda translation and is only newly *used* here.
  'environment.cache.live',
  'environment.cache.stale',
  'environment.cache.miss',
  'environment.loading',
  'environment.loadFailed',
  // Weather-card tile labels (the metric keys already existed and were unused).
  'environment.metrics.air_temperature_c',
  'environment.metrics.relative_humidity_pct',
  'environment.metrics.wind_speed_mps',
  'environment.metrics.wind_direction_deg',
  'environment.metrics.pressure_hpa',
  'environment.metrics.light_lux',
  'environment.metrics.uv_index',
  'zone.water.rainToday',
];

test('every environment label key resolves in all seven locales', () => {
  for (const locale of LOCALES) {
    const devices = readDevices(locale);
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
  }
});

/**
 * Fragments that only exist when a string reaches the screen without `t()`.
 * A `defaultValue:` copy of the same English is fine and stays — it is the
 * source text the bundles translate.
 */
const FORBIDDEN: Array<[string, string[]]> = [
  ['components/farming/environment/EnvironmentCard.tsx', [
    "data.display.mode === 'shared_server' ? 'OSI Server' :",
    "label: 'Live'",
    "label: 'Stale'",
    "label: 'No data'",
    '\n              Loading environment data',
    "?? 'Failed to load environment data'",
  ]],
  ['components/farming/SenseCapWeatherCard.tsx', [
    '>Air Temperature<',
    '>Humidity<',
    '>Wind Speed<',
    '>Wind Direction<',
    '>Rain Today<',
    '>Pressure<',
    '>Light Intensity<',
    '>UV Index<',
    "label: 'Air Temperature'",
    "label: 'Humidity'",
    "label: 'Pressure'",
    "label: 'Light Intensity'",
    "label: 'UV Index'",
  ]],
];

test('the environment and weather cards render no English label literals', () => {
  for (const [file, literals] of FORBIDDEN) {
    const source = fs.readFileSync(path.join(srcRoot, file), 'utf8');
    for (const literal of literals) {
      assert.equal(source.includes(literal), false, `${file} still renders ${literal.trim()}`);
    }
  }
});

/**
 * `JSON.parse` keeps the last of two identical keys without complaining, so a
 * block appended next to one that already exists silently replaces it. That is
 * how a human Luganda `environment.cache` nearly got overwritten with the
 * English source text while every other test stayed green.
 */
function duplicateKeys(raw: string): string[] {
  const duplicates: string[] = [];
  const scopes: Array<Set<string>> = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '{') {
      scopes.push(new Set());
      index += 1;
    } else if (char === '}') {
      scopes.pop();
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      let text = '';
      while (end < raw.length && raw[end] !== '"') {
        if (raw[end] === '\\') {
          text += raw.slice(end, end + 2);
          end += 2;
          continue;
        }
        text += raw[end];
        end += 1;
      }
      index = end + 1;
      let after = index;
      while (after < raw.length && /\s/.test(raw[after])) after += 1;
      const scope = scopes[scopes.length - 1];
      if (raw[after] === ':' && scope) {
        if (scope.has(text)) duplicates.push(text);
        scope.add(text);
      }
    } else {
      index += 1;
    }
  }
  return duplicates;
}

test('no locale bundle declares the same key twice in one object', () => {
  for (const locale of LOCALES) {
    for (const file of fs.readdirSync(path.join(localeRoot, locale))) {
      if (!file.endsWith('.json')) continue;
      const raw = fs.readFileSync(path.join(localeRoot, locale, file), 'utf8');
      assert.deepEqual(duplicateKeys(raw), [], `${locale}/${file} declares a key more than once`);
    }
  }
});
