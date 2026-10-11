import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createInstance, type Resource} from 'i18next';
import {applyPublicSupportReceiptCopy} from '../public-copy';

test('public support receipt is truthful in all seven languages and leaves demo presentation copy alone', async () => {
  const languages = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
  const resources = Object.fromEntries(await Promise.all(languages.map(async language => [language, {
    settings: JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/settings.json`), 'utf8')),
  }]))) as Resource;
  const presentationI18n = createInstance();
  const publicI18n = createInstance();
  await presentationI18n.init({resources: structuredClone(resources), lng: 'en', fallbackLng: 'en', defaultNS: 'settings', interpolation: {escapeValue: false}});
  await publicI18n.init({resources: structuredClone(resources), lng: 'en', fallbackLng: 'en', defaultNS: 'settings', interpolation: {escapeValue: false}});
  const expected: Record<string, string> = {
    en: 'Saved in this demo session. No request was sent.',
    'de-CH': 'In dieser Demo-Sitzung gespeichert. Es wurde keine Anfrage gesendet.',
    fr: 'Enregistrée dans cette session de démonstration. Aucune demande n’a été envoyée.',
    it: 'Salvata in questa sessione demo. Non è stata inviata alcuna richiesta.',
    es: 'Guardada en esta sesión de demostración. No se ha enviado ninguna solicitud.',
    pt: 'Guardado nesta sessão de demonstração. Nenhum pedido foi enviado.',
    lg: 'Kiterekeddwa mu kwolesa kuno. Tewali kusaba kutumiddwa.',
  };
  applyPublicSupportReceiptCopy(publicI18n);
  for (const [language, message] of Object.entries(expected)) {
    assert.equal(publicI18n.t('requestSaved', {lng: language}), message);
    assert.equal(presentationI18n.t('requestSaved', {lng: language}), (resources[language]?.settings as Record<string, unknown>).requestSaved);
  }
  const runtime = await readFile(resolve(import.meta.dirname, '../runtime.ts'), 'utf8');
  assert.match(runtime, /if\s*\(publicMode\)\s*applyPublicSupportReceiptCopy\(i18n\)/);
  const productionEnglish = JSON.parse(await readFile(resolve(import.meta.dirname, '../../public/locales/en/settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(productionEnglish.requestSaved, 'Saved, waiting for internet');
});
