import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Background-token-as-foreground defect class: *-bg tokens (--error-bg,
// --warn-bg, --success-bg, ...) are pale washes since the S0 token fix; using
// one as a foreground utility (text/placeholder/caret/decoration/fill/stroke)
// renders pale-on-pale, or invisible against any surface painted with the
// same wash. Foreground utilities must use the paired -text/-fg token.
// Generalizes the original M3 guard (which only banned the literal
// `text-[var(--error-bg)]` string) so a sibling misuse such as
// `text-[var(--warn-bg)]` is caught too, not just the one instance found.
const FOREGROUND_MISUSE = /(?:text|placeholder|caret|decoration|fill|stroke)-\[var\(--[a-z-]*bg\)\]/;

test('no source file uses a *-bg token as a foreground utility color', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    if (FOREGROUND_MISUSE.test(fs.readFileSync(filePath, 'utf8'))) {
      offenders.push(path.relative(srcRoot, filePath));
    }
  }
  assert.deepEqual(offenders, []);
});

// Invisible-border defect class: filling and bordering an element with the
// same --error-bg wash draws a border that can't be distinguished from its
// own fill (SenseCapWeatherCard :195 and ScheduleSection :423 both had this
// shape, and were fixed on the cloud). The border must use a token — e.g.
// --danger-fg — that contrasts against the fill.
//
// This guard existed only on osi-server before the AgroLink designer-fix
// batch (2026-08) ported it here. The edge is canonical for ui-core but has
// its own hand-rolled error banners, and porting the guard for the first
// time immediately surfaced 13 pre-existing edge-only instances of this
// exact defect shape that the cloud already had fixed. None of these were
// named in that review round, so fixing them is out of scope for that batch
// — they are allowlisted here, narrowly, pending a dedicated follow-up
// migration (same class of work as the F6 history/analysis hardcoded-color
// sweep called out in that batch's report).
const PRE_EXISTING_INVISIBLE_BORDER_FILES = new Set<string>([
  'components/farming/AddDeviceModal.tsx',
  'components/farming/AssignDeviceModal.tsx',
  'components/farming/CreateZoneModal.tsx',
  'components/farming/DraginoTempCard.tsx',
  'components/farming/IrrigationZoneCard.tsx',
  'components/farming/KiwiSensorCard.tsx',
  'components/farming/ScheduleSection.tsx',
  'components/farming/StregaValveCard.tsx',
  'pages/AccountLink.tsx',
  'pages/FarmingDashboard.tsx',
  'pages/Login.tsx',
  'pages/Register.tsx',
  'pages/SettingsPage.tsx',
]);

test('no class string pairs bg-[var(--error-bg)] with border-[var(--error-bg)]', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.includes('bg-[var(--error-bg)]') && line.includes('border-[var(--error-bg)]')) {
        offenders.push(path.relative(srcRoot, filePath));
      }
    }
  }
  const unexpected = offenders.filter((rel) => !PRE_EXISTING_INVISIBLE_BORDER_FILES.has(rel));
  assert.deepEqual(unexpected, []);
});
