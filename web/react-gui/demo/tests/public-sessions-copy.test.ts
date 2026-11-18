import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createInstance, type Resource} from 'i18next';
import {applyPublicCopy} from '../public-copy';

test('public login and account-link help exist in all seven app languages', async () => {
  const languages = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
  const resources = Object.fromEntries(await Promise.all(languages.map(async language => [language, {
    auth: JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/auth.json`), 'utf8')),
    accountLink: JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/accountLink.json`), 'utf8')),
  }]))) as Resource;
  const i18n = createInstance();
  await i18n.init({resources, lng: 'en', fallbackLng: 'en', interpolation: {escapeValue: false}});
  applyPublicCopy(i18n);
  for (const language of languages) {
    const login = i18n.t('login.demoHelp', {lng: language, ns: 'auth'});
    const accountLink = i18n.t('form.demoNotice', {lng: language, ns: 'accountLink'});
    assert.equal(typeof login, 'string', `${language} login help is missing`);
    assert.equal(typeof accountLink, 'string', `${language} account-link help is missing`);
    assert.ok(login.length > 40, `${language} login help is too short`);
    assert.ok(accountLink.length > 40, `${language} account-link help is too short`);
    assert.doesNotMatch(login, /simulat|fictional|fictif|fictício|fittizio|ficticio|demo-only|demonstration|bulimba|obulimba/i,
      `${language} login help must not explain the simulator`);
    assert.doesNotMatch(accountLink, /simulat|fictional|fictif|fictício|fittizio|ficticio|demo-only|demonstration|bulimba|obulimba/i,
      `${language} account-link help must not explain the simulator`);
    assert.match(login, /Demo farmer \/ demo/, `${language} login help must retain the default credentials`);
  }
});
