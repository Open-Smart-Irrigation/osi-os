import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './stripComments';

const srcRoot = path.resolve(import.meta.dirname, '../src');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

// Maintainer decision 4 (S6): read-only users keep Settings. The language,
// theme and units controls are per-user display preferences and the only
// in-app language switcher an authenticated desktop viewer can reach; Luganda
// is behind them and Luganda gates Uganda.
//
// These two tests assert on the WHOLE of App.tsx, not on a sliced route block.
// A slice is not available: edge App.tsx contains ZERO `</Route>` occurrences
// — every route is self-closing `<Route … />`, including /settings (line 69,
// `<WritableOnly><SettingsPage /></WritableOnly>`) and /support-requests (57).
// `</Routes>` does not contain the substring `</Route>` either. So
// `indexOf('</Route>')` returns -1, `slice(0, -1 + 8)` is the first SEVEN
// characters, and a block-slicing version of these tests passes today with the
// read-only wall fully intact. Whole-file assertions are also strictly
// stronger here: WritableOnly wrapped exactly one route, so "App.tsx does not
// mention it" is the complete statement of the fix. Each test also asserts its
// route is still REGISTERED, so neither can be satisfied by deleting a route.
test('App.tsx no longer references WritableOnly anywhere, and /settings is still routed', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('path="/settings"'), '/settings must still be registered');
  assert.ok(
    !app.includes('WritableOnly'),
    'Settings must be reachable by read-only users — no WritableOnly reference may remain in App.tsx',
  );
});

test('the WritableOnly import is gone from App.tsx, and /support-requests is still routed', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('path="/support-requests"'), '/support-requests must still be registered');
  assert.doesNotMatch(
    app,
    /^\s*import\s.*WritableOnly.*$/m,
    'the WritableOnly import must be removed, not left dangling',
  );
});

// The header must not hide Settings from non-writers any more.
test('no caller passes a canWrite-derived showSettings', () => {
  const offenders: string[] = [];
  for (const rel of [
    'components/DashboardHeader.tsx',
    'pages/JournalPage.tsx',
    'pages/HistoryDashboard.tsx',
    'pages/CrossZoneAnalysisPage.tsx',
  ]) {
    for (const line of read(rel).split('\n')) {
      if (/showSettings\s*=\s*\{[^}]*canWrite/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// The one genuinely mutating control stays gated, inside the page.
test('the irrigation-schedule module toggle is gated on canWrite', () => {
  // Comments are not code: indexOf() takes the FIRST occurrence, and a doc
  // comment mentioning either `disableAllSchedules` or `canWrite` ahead of
  // the real call would move the search origin or satisfy the proximity
  // check without a real guard existing. Stripped so both indexOf() and the
  // proximity match() below only ever see real code.
  const page = stripComments(read('pages/SettingsPage.tsx'));
  assert.ok(page.includes('canWrite'), 'SettingsPage must gate its one mutating control');
  const call = page.indexOf('disableAllSchedules');
  assert.ok(call > 0, 'disableAllSchedules must still exist');
  // The guard must be in the same function that makes the call, not merely
  // somewhere in the file.
  const before = page.slice(Math.max(0, call - 1200), call);
  assert.match(before, /canWrite/, 'the disableAllSchedules path must check canWrite');
});
