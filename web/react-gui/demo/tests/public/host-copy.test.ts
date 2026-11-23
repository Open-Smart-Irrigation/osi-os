import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {resolve} from 'node:path';

const languages = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
const required = ['brand', 'title', 'appFrameTitle', 'appRegion', 'reset', 'openTools', 'tools', 'close',
  'time', 'speed', 'pause', 'resume', 'nextEvent', 'expanded', 'compact', 'loading', 'retry', 'loadFailed',
  'instructionsTitle', 'featuresTitle', 'featureOneTitle', 'featureOneCopy', 'featureTwoTitle', 'featureTwoCopy',
  'featureThreeTitle', 'featureThreeCopy', 'featureFourTitle', 'featureFourCopy', 'featureFiveTitle', 'featureFiveCopy',
  'featureSixTitle', 'featureSixCopy', 'instructionOne', 'instructionTwo', 'instructionThree', 'lugandaReview',
  'noticeUnsupported', 'noticeProtected', 'noticeInvalid', 'noticeBlocked', 'noticeMissing', 'noticeAssigned',
  'noticeDuplicate', 'noticeBusy', 'noticeDemoDevice', 'noticeNoEvent'];
required.push('linkHome','linkVisitor','linkInstaller','linkDeveloper','formNotice','noticeUnsupportedDevice','safeFarm','guide','guideTitle','guideIntro','guideStart','guideNext','guideClose','guideDone',
  'stepInspect','stepAdvice','stepHistory','stepIrrigation','stepSkip','stepResult','stepSchedule','stepNext',
  'skipEvent','farmTime','resetTitle','resetDetail','resetConfirm','resetCancel','guideRetry');

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
    for (const key of required.filter(key => key !== 'lugandaReview' && key !== 'safeFarm' && key !== 'noticeUnsupportedDevice')) {
      assert.doesNotMatch(copy[key] as string, /simulat|fictional|demo-only|demonstration|fictif|fictício|fittizio|ficticio|simuliert|simulée|simulada|simulati|okugezesa|obulimba/i,
        `${languages[index]}.${key} must use ordinary product copy`);
    }
  }
  assert.notEqual(copies[1]!.reset, english.reset);
  assert.notEqual(copies[6]!.reset, english.reset);
});

test('public host removes explanation blocks while retaining working controls and status flow', () => {
  const hostDirectory = resolve(import.meta.dirname, '../../public');
  const html = readFileSync(resolve(hostDirectory, 'index.html'), 'utf8');
  const script = readFileSync(resolve(hostDirectory, 'host.ts'), 'utf8');
  const css = readFileSync(resolve(hostDirectory, 'host.css'), 'utf8');
  for (const obsolete of ['tagline', 'simulation-label', 'reset-note', 'tools-reset-note']) {
    assert.doesNotMatch(html, new RegExp(`id=["']${obsolete}["']`), `${obsolete} explanation element must be removed`);
    assert.doesNotMatch(script, new RegExp(`#${obsolete}`), `${obsolete} selector must be removed`);
  }
  assert.doesNotMatch(html, /working simulation|simulated data|every result stays simulated|simulated session/i);
  assert.doesNotMatch(css, /\.simulation-label/);
  for (const id of ['open-tools', 'reset', 'tools-dialog', 'speed', 'pause', 'next-event', 'view-toggle', 'host-notice', 'loading', 'retry', 'event-row', 'guide-panel', 'guide-links']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} control/status element must remain`);
  }
  for (const selector of ['#reset', '#speed', '#pause', '#next-event', '#view-toggle', '#host-notice', '#loading', '#mobile-luganda-review']) {
    assert.ok(script.includes(selector), `${selector} behavior must remain wired`);
  }
});

test('main keeps the conditional-policy advisory out of the public simulator port', () => {
  const component = readFileSync(resolve(import.meta.dirname, '../../../src/components/farming/AdvancedScheduleDrawer.tsx'), 'utf8');
  assert.doesNotMatch(component, /isPublicSimulator|publicAdvisory/);
  assert.doesNotMatch(component, /lastEvaluationAdvisory/);
});

test('public invitation, status, and source labels use ordinary OSI OS copy', () => {
  const guiRoot = resolve(import.meta.dirname, '../../..');
  const read = (relative: string) => readFileSync(resolve(guiRoot, relative), 'utf8');
  const appHtml = read('demo/public/app.html');
  assert.match(appHtml, /<title>OSI OS<\/title>/);
  const invitation = read('demo/website/invitation.html');
  assert.match(invitation, /aria-label="Try OSI OS"/);
  assert.match(invitation, /alt="OSI OS dashboard"/);
  const website = ['demo/website/embed.html', 'demo/website/preview.html'].map(read).join('\n');
  assert.doesNotMatch(website, /fictional farm|fictional data|browser-local simulator|no hardware or (?:sign-up|account) is needed/i);
  const location = read('demo/public/device-location.ts');
  assert.match(location, /message: 'Location is available\.'/);
  assert.doesNotMatch(location, /fictional|demonstration/i);
  const sessions = read('demo/model/sessions.ts');
  assert.match(sessions, /Enter a server URL, username, and password/);
  assert.match(sessions, /Enter a valid email address/);
  assert.doesNotMatch(sessions, /fictional link|fictional registration/i);
  for (const file of ['demo/model/history.ts', 'demo/model/environment.ts', 'demo/model/analysis.ts', 'demo/model/histories.ts']) {
    assert.doesNotMatch(read(file), /Illustrative simulator|Fictional .*illustrative public-simulator rule/i, `${file} labels must be neutral`);
  }
  assert.doesNotMatch(read('demo/model/triggers.ts'), /Simulated DENDRO|Simulated \$\{metric\}|Illustrative simulator rule|Simulator opening skipped/i);
  assert.match(read('demo/model/triggers.ts'), /No eligible \$\{metric\} measurement was available in the last hour/);
});
