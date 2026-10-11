import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {resolve} from 'node:path';

const languages = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
const required = ['brand', 'title', 'appFrameTitle', 'simulatorRegion', 'tagline', 'simulatedData', 'reset', 'resetNote', 'openTools', 'tools', 'close',
  'simulatedTime', 'speed', 'pause', 'resume', 'nextEvent', 'expanded', 'compact', 'loading', 'retry', 'loadFailed',
  'instructionsTitle', 'instructionOne', 'instructionTwo', 'instructionThree', 'lugandaReview',
  'noticeUnsupported', 'noticeProtected', 'noticeInvalid', 'noticeBlocked', 'noticeMissing', 'noticeAssigned',
  'noticeDuplicate', 'noticeBusy', 'noticeDemoDevice', 'noticeNoEvent'];

test('public host instructions and controls have complete copy in all seven app languages', () => {
  const localeDirectory = resolve(import.meta.dirname, '../../public/locales');
  const copies = languages.map(language => {
    const file = resolve(localeDirectory, `${language}.json`);
    assert.ok(existsSync(file), `missing public host copy for ${language}`);
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  });
  const english = copies[0]!;
  for (const [index, copy] of copies.entries()) {
    assert.deepEqual(Object.keys(copy).sort(), [...required].sort(), `${languages[index]} keys differ`);
    for (const key of required) assert.equal(typeof copy[key], 'string', `${languages[index]}.${key} must be text`);
    assert.ok((copy.lugandaReview as string).length > 20, `${languages[index]} must state the Luganda review status`);
  }
  assert.notEqual(copies[1]!.reset, english.reset);
  assert.notEqual(copies[6]!.reset, english.reset);
});

test('public rule advisory labels are present in every native app language', () => {
  const localeDirectory = resolve(import.meta.dirname, '../../locales/public-advisory');
  const productionLocaleDirectory = resolve(import.meta.dirname, '../../../public/locales');
  const advisory = languages.map(language => {
    const file = resolve(localeDirectory, `${language}.json`);
    assert.ok(existsSync(file), `missing demo-only public advisory copy for ${language}`);
    const productionFile = resolve(productionLocaleDirectory, language, 'devices.json');
    const production = JSON.parse(readFileSync(productionFile, 'utf8')) as {advancedSchedule?: {publicAdvisory?: unknown}};
    assert.equal(production.advancedSchedule?.publicAdvisory, undefined, `${language} public advisory copy must stay in demo resources`);
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  });
  const keys = Object.keys(advisory[0]!).sort();
  for (const [index, copy] of advisory.entries()) {
    assert.deepEqual(Object.keys(copy!).sort(), keys, `${languages[index]} advisory keys differ`);
    for (const [key, value] of Object.entries(copy!)) assert.equal(typeof value, 'string', `${languages[index]}.${key} must be text`);
  }
  for (const key of ['missingValve', 'busy', 'sameLogicalWindow', 'belowThreshold']) assert.ok(keys.includes(key), `missing structured ${key} reason`);
  for (const copy of advisory.slice(1)) assert.notEqual(copy!.decision, advisory[0]!.decision);
});
