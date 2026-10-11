import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

test('public login and account-link help exist in all seven app languages', async () => {
  const languages = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
  for (const language of languages) {
    const auth = JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/auth.json`), 'utf8')) as {
      login?: {demoHelp?: unknown};
    };
    const link = JSON.parse(await readFile(resolve(import.meta.dirname, `../../public/locales/${language}/accountLink.json`), 'utf8')) as {
      form?: {demoNotice?: unknown};
    };
    assert.equal(typeof auth.login?.demoHelp, 'string', `${language} login help is missing`);
    assert.equal(typeof link.form?.demoNotice, 'string', `${language} account-link help is missing`);
    assert.ok((auth.login!.demoHelp as string).length > 40, `${language} login help is too short`);
    assert.ok((link.form!.demoNotice as string).length > 40, `${language} account-link help is too short`);
  }
});
