import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatForecastHighLow } from '../src/utils/forecastFormat';

test('formats high/low when both finite', () => {
  assert.equal(formatForecastHighLow(28.4, 14.6), '28°/15°');
});

test('returns Unavailable when either side is null', () => {
  assert.equal(formatForecastHighLow(null, 14.6), 'Unavailable');
  assert.equal(formatForecastHighLow(28.4, null), 'Unavailable');
  assert.equal(formatForecastHighLow(undefined, null), 'Unavailable');
});

test('treats 0 as a valid value, not Unavailable', () => {
  assert.equal(formatForecastHighLow(0, -3), '0°/-3°');
});

test('edge environment summary calls buildForecastSection from the extracted module', () => {
  const flowsPath = path.resolve(
    import.meta.dirname,
    '../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
  );
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = flows.find((entry: { name?: string }) => entry.name === 'Get Zone Environment Summary');
  assert.ok(node && typeof node.func === 'string', 'Get Zone Environment Summary function node is present');

  assert.ok(node.func.includes('buildForecastSection'), 'adapter calls buildForecastSection');

  const modulePath = path.resolve(
    import.meta.dirname,
    '../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js'
  );
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  assert.ok(moduleSource.includes('function buildForecastSection'), 'buildForecastSection is defined in osi-zone-env');
  for (const field of ['description:', 'weatherCode:', 'maxTempC:', 'minTempC:', 'rainProbabilityPct:', 'tempC:']) {
    assert.match(moduleSource, new RegExp(`\\b${field.replace(':', '')}:`));
  }
});

test('weather forecast tabs keep summary controls usable on phone-width screens', () => {
  const componentRoot = path.resolve(import.meta.dirname, '../src/components/farming/environment');
  for (const fileName of ['ForecastTab.tsx', 'WeatherTab.tsx']) {
    const source = fs.readFileSync(path.join(componentRoot, fileName), 'utf8');
    assert.match(source, /grid-cols-2\s+sm:grid-cols-4/, `${fileName} uses two summary columns before the small breakpoint`);
    assert.match(source, /snap-x/, `${fileName} keeps daily forecast cards swipe-snappable`);
    assert.match(source, /min-h-\[44px\]/, `${fileName} keeps forecast summary touch targets at least 44px tall`);
  }
});
