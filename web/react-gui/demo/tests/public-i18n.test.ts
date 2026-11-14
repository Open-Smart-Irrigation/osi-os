import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createInstance, type Resource} from 'i18next';
import {applyPublicCopy} from '../public-copy';

test('public support receipt says only that the local request was saved in all seven languages', async () => {
  const languages = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
  const resources = Object.fromEntries(await Promise.all(languages.map(async language => [language, {
    settings: JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/settings.json`), 'utf8')),
    devices: JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/devices.json`), 'utf8')),
  }]))) as Resource;
  (resources.en.devices as {environment: {water: {trendNoteMeasured?: string}}}).environment.water.trendNoteMeasured =
    'Compare rainfall with measured effective irrigation over the last week.';
  const presentationI18n = createInstance();
  const publicI18n = createInstance();
  await presentationI18n.init({resources: structuredClone(resources), lng: 'en', fallbackLng: 'en', defaultNS: 'settings', interpolation: {escapeValue: false}});
  await publicI18n.init({resources: structuredClone(resources), lng: 'en', fallbackLng: 'en', defaultNS: 'settings', interpolation: {escapeValue: false}});
  const expected: Record<string, string> = {
    en: 'Saved.',
    'de-CH': 'Gespeichert.',
    fr: 'Enregistrée.',
    it: 'Salvata.',
    es: 'Guardada.',
    pt: 'Guardado.',
    lg: 'Kiterekeddwa.',
  };
  const expectedEmptyRuns: Record<string, string> = {
    en: 'No valve runs recorded yet.',
    'de-CH': 'Noch keine Ventilläufe aufgezeichnet.',
    fr: 'Aucune ouverture de vanne enregistrée pour le moment.',
    it: 'Nessuna apertura della valvola registrata.',
    es: 'Todavía no hay aperturas de válvula registradas.',
    pt: 'Ainda não há aberturas de válvula registadas.',
    lg: 'Tewali kufukirira kwa vvaalu kuwandiikiddwa.',
  };
  const expectedAdvice: Record<string, string> = {
    en: 'Sensor advice', 'de-CH': 'Sensorhinweis', fr: 'Conseil des capteurs', it: 'Consiglio dei sensori',
    es: 'Recomendación de los sensores', pt: 'Recomendação dos sensores', lg: 'Amagezi agava mu bipima',
  };
  const expectedWeatherSource: Record<string, string> = {
    en: 'Weather data', 'de-CH': 'Wetterdaten', fr: 'Données météo', it: 'Dati meteo',
    es: 'Datos meteorológicos', pt: 'Dados meteorológicos', lg: 'Ebikwata ku mbeera y’obudde',
  };
  const expectedWeatherConditions: Record<string, string> = {
    en: 'Weather conditions', 'de-CH': 'Wetterbedingungen', fr: 'Conditions météo', it: 'Condizioni meteo',
    es: 'Condiciones meteorológicas', pt: 'Condições meteorológicas', lg: 'Embeera y’obudde',
  };
  const expectedCropCoefficient: Record<string, string> = {
    en: 'Crop coefficient', 'de-CH': 'Kulturkoeffizient', fr: 'Coefficient cultural', it: 'Coefficiente colturale',
    es: 'Coeficiente de cultivo', pt: 'Coeficiente cultural', lg: 'Omugerageranyo gw’ekirime',
  };
  const expectedLocationAvailable: Record<string, string> = {
    en: 'Location is available.', 'de-CH': 'Standort ist verfügbar.', fr: 'La position est disponible.',
    it: 'La posizione è disponibile.', es: 'La ubicación está disponible.', pt: 'A localização está disponível.',
    lg: 'Ekifo kisobola okukozesebwa.',
  };
  const expectedValidation: Record<string, string> = {
    en: 'Enter a server URL, username, and password.', 'de-CH': 'Geben Sie die Server-URL, den Benutzernamen und das Passwort ein.',
    fr: 'Saisissez l’URL du serveur, le nom d’utilisateur et le mot de passe.', it: 'Inserisci l’URL del server, il nome utente e la password.',
    es: 'Introduce la URL del servidor, el nombre de usuario y la contraseña.', pt: 'Introduza o URL do servidor, o nome de utilizador e a palavra-passe.',
    lg: 'Teekamu URL ya seva, erinnya ly’omukozesa n’ekigambo ky’okuyingira.',
  };
  const expectedMeasuredTrendLuganda = 'Geraageranya enkuba n’amazzi agakozeseddwa mu kufukirira agapimiddwa mu wiiki ewedde.';
  applyPublicCopy(publicI18n);
  for (const [language, message] of Object.entries(expected)) {
    assert.equal(publicI18n.t('requestSaved', {lng: language}), message);
    assert.equal(presentationI18n.t('requestSaved', {lng: language}), (resources[language]?.settings as Record<string, unknown>).requestSaved);
    assert.equal(publicI18n.t('irrigationOutcomes.empty', {lng: language, ns: 'devices'}), expectedEmptyRuns[language]);
    assert.equal(publicI18n.t('zone.water.drivenByBalance', {lng: language, ns: 'devices'}), expectedAdvice[language]);
    assert.equal(publicI18n.t('environment.source.illustrative', {lng: language, ns: 'devices'}), expectedWeatherSource[language]);
    assert.equal(publicI18n.t('environment.source.meteoswiss', {lng: language, ns: 'devices'}), 'MeteoSwiss');
    assert.equal(publicI18n.t('environment.description.weatherConditions', {lng: language, ns: 'devices'}), expectedWeatherConditions[language]);
    assert.equal(publicI18n.t('environment.source.cropCoefficient', {lng: language, ns: 'devices'}), expectedCropCoefficient[language]);
    assert.equal(publicI18n.t('zoneConfig.locationAvailable', {lng: language, ns: 'devices'}), expectedLocationAvailable[language]);
    assert.equal(publicI18n.t('history.source.weatherData', {lng: language, ns: 'history'}), expectedWeatherSource[language]);
    assert.equal(publicI18n.t('analysis.tray.weatherData', {lng: language, ns: 'common'}), expectedWeatherSource[language]);
    assert.equal(publicI18n.t('errors.publicInvalidAccountLink', {lng: language, ns: 'accountLink'}), expectedValidation[language]);
    assert.equal(presentationI18n.t('irrigationOutcomes.empty', {lng: language, ns: 'devices'}),
      ((resources[language]?.devices as {irrigationOutcomes: {empty: string}}).irrigationOutcomes.empty));
    assert.doesNotMatch(message, /sent|inviad|envoy|enviad|tumiddwa/i);
  }
  assert.equal(publicI18n.t('environment.water.trendNoteMeasured', {lng: 'lg', ns: 'devices'}), expectedMeasuredTrendLuganda);
  assert.equal(presentationI18n.t('environment.water.trendNoteMeasured', {lng: 'lg', ns: 'devices'}),
    'Compare rainfall with measured effective irrigation over the last week.');
  const runtime = await readFile(resolve(import.meta.dirname, '../runtime.ts'), 'utf8');
  assert.match(runtime, /if\s*\(publicMode\)\s*applyPublicCopy\(i18n\)/);
  const productionEnglish = JSON.parse(await readFile(resolve(import.meta.dirname, '../../public/locales/en/settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(productionEnglish.requestSaved, 'Saved, waiting for internet');
});
