import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WATER_COPY} from '@osi-demo/water-copy';

export const locales = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'] as const;
type Locale = typeof locales[number];

export const providerOrPlace = /\b(?:Open[-_ ]?Meteo|Meteo[- ]?Swiss|MeteoSchweiz|MétéoSuisse|MeteoSvizzera|OpenAgri|Schweiz|Suisse|Svizzera|Suiza|Suíça|Switzerland|Uganda|Kampala|Rom[ea]|Zürich|Genève|Geneva)\b|\b(?:Europe|Africa)\//iu;

export const shippedLocales = new URL('../../react-gui/public/locales/', import.meta.url);
const spec = readFileSync(new URL('../docs/research/phone-surfaces.md', import.meta.url), 'utf8');
const tableRows = (section: string) => section.split('\n').filter(line => line.startsWith('| '))
  .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()));
const section = (from: string, to: string) => spec.slice(spec.indexOf(from), spec.indexOf(to, spec.indexOf(from)));
const labels = tableRows(section('### 2.5', '### 2.6'));
const round3 = tableRows(section('## Round-3 addendum', '## Round-4 addendum'));
const dendro = tableRows(section('#### 1.3 Layer 1', '#### 1.4 Layer 2'));
const meter = tableRows(section('#### 2. Flow meter labels', '#### 3. Weather tab attribution'));
const round5 = tableRows(spec.slice(spec.indexOf('## Round-5 addendum')));
const refusals = tableRows(section('### 1.4', '### 1.5'));

function named(rows: string[][], key: string): string[] {
  const row = rows.find(cells => cells[0] === key);
  assert.ok(row, `Missing spec row: ${key}`);
  return row;
}

export function expectedCopy(locale: Locale): Record<string, string> {
  const index = locales.indexOf(locale);
  const lgFallback = (en: string, translated: string | undefined) =>
    translated === undefined || /^(?:\(en\)|en(?: \(see lg policy\))?)$/.test(translated) ? en : translated;
  const across = (rows: string[][], key: string, first = 1) => {
    const values = named(rows, key);
    return lgFallback(values[first], values[first + index]);
  };
  const down = (key: string) => {
    const row = round3.find(cells => cells[0] === key && cells[1] === locale);
    assert.ok(row, `Missing spec row: ${key}, ${locale}`);
    return row[2];
  };
  const data: Record<string, string> = {};
  const device = (keys: string[], value: string) => {
    for (const key of keys) data[`devices:${key}`] = value;
  };

  const advice = WATER_COPY[locale].advice;
  device(['zone.water.drivenByBalance', 'zone.water.drivenByWaterBalanceFromWeather', 'zone.water.drivenByWaterBalanceFromStation'], advice);
  device(['environment.water.balance'], `${shipped(locale, 'devices:environment.water.balance')} · ${advice}`);
  device([
    'environment.water.et0Tier.provider_open_meteo', 'environment.water.et0Tier.provider_meteoswiss',
    'zoneConfig.weatherProviderOption.open_meteo', 'environment.source.open_meteo',
    'environment.source.openagri', 'environment.source.meteoswiss',
  ], across(labels, 'GAME label'));
  for (const [key, row] of Object.entries({
    'environment.water.et0Tier.open_meteo_daily': 'daily FAO-56',
    'environment.water.stationCredit': 'station credit',
    'environment.water.computedBy.cloud': 'computedBy.cloud',
    'zoneConfig.weatherProviderOption.meteoswiss': 'not in game',
    'zoneConfig.weatherProviderOption.auto': 'auto',
    'zoneConfig.weatherProviderHelp': 'provider help',
    'environment.source.illustrative': 'illustrative',
    'zone.water.rainFromStation': 'station rain',
    'environment.water.demandMixedStation': 'two stations',
    'environment.water.demandUnknownStation': 'station unknown',
  })) device([key], across(labels, row));

  for (const key of [
    'devices:environment.water.meteoswissCloudNote', 'common:analysis.aggregation.help',
    'devices:environment.description.weatherConditions', 'devices:systemPanel.title', 'devices:systemPanel.subtitle',
    'devices:advancedSchedule.timezoneExample',
  ]) data[key] = down(`\`${key}\``);
  data['settings:timeZoneInvalid'] = ['it', 'es', 'pt'].includes(locale)
    ? round5.find(cells => cells[0] === locale && cells[1].includes('Etc/GMT-3'))![1]
    : down('`settings:timeZoneInvalid`');
  data['settings:swtSample'] = `${shipped(locale, 'settings:swtSample')} · ${across(labels, 'illustrative')}`;
  data['devices:environment.water.attribution.open_meteo'] = named(round5, locale)[1];
  for (const suffix of ['agronomic.dewPoint', 'agronomic.heatIndex', 'agronomic.thi', 'cache.live']) {
    const key = `devices:environment.${suffix}`;
    data[key] = across(round5, `\`${key}\``);
  }

  const meterLabel = across(meter, '`devices:environment.water.measuredIrrigationToday`', 3);
  device(['zone.water.measured', 'environment.water.measuredIrrigationToday'], meterLabel);
  device(['zone.water.subtitle'], `${shipped(locale, 'devices:zone.water.rainToday')} · ${meterLabel}`);
  for (const key of ['devices:environment.water.tooltipMeasuredEffective', 'devices:environment.water.flowMeterReporting', 'devices:stregaValve.measured']) {
    data[key] = across(meter, `\`${key}\``, 3);
  }
  data['common:farmSim.flowMeterHeading'] = across(meter, 'hard-coded `Flow Meter`', 3);

  for (const cells of dendro.filter(cells => cells[0].startsWith('`devices:'))) {
    data[cells[0].slice(1, -1)] = across(dendro, cells[3][0]);
  }
  data['common:farmSim.game_refused'] = locale === 'lg' ? 'Ekikolwa kino tekisoboka.' : named(refusals, locale)[1];
  data['common:farmSim.game_tier'] = locale === 'lg' ? data['common:farmSim.game_refused'] : named(refusals, locale)[2];
  return data;
}

export function shipped(locale: Locale, key: string): string | undefined {
  const [ns, dotted] = key.split(':');
  let value: unknown = JSON.parse(readFileSync(new URL(`${locale}/${ns}.json`, shippedLocales), 'utf8'));
  for (const part of dotted.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  return typeof value === 'string' ? value : undefined;
}
