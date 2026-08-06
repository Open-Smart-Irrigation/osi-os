import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listFilesRecursive(dir: string, extensions: string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFilesRecursive(fullPath, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [fullPath] : [];
  });
}

// Tailwind v3.4 cannot alpha-modify an arbitrary `var(--x)` color value:
// `bg-[var(--surface)]/60` compiles to nothing (no rule is generated), so the
// class is dropped and the element renders with no fill at all — including
// modal backdrops that silently stop dimming. The fix is the color-mix form:
// `bg-[color-mix(in_srgb,var(--surface)_60%,transparent)]`. This guard fails
// on any reintroduction of the inert `-[var(--x)]/NN` alpha-modifier pattern
// on the utilities that support it.
const INERT_TOKEN_ALPHA = /(?:bg|text|border|ring)-\[var\(--[a-z-]+\)\]\/\d+/;

// This guard existed only on osi-server before the AgroLink designer-fix
// batch (2026-08) ported it here. Porting it for the first time surfaced 5
// pre-existing edge-only instances of the inert `-[var(--x)]/NN` pattern —
// each of those elements currently renders with no fill/border at all in
// every theme, not just one. None of these were named in that review round,
// so fixing them is out of scope for that batch; allowlisted here, narrowly,
// pending a dedicated follow-up.
const PRE_EXISTING_INERT_ALPHA_OFFENDERS = new Set<string>([
  'components/farming/DraginoDendroCalibrationSection.tsx: border-[var(--border)]/50',
  'components/farming/IrrigationZoneCard.tsx: bg-[var(--overlay)]/70',
  'components/farming/ZoneConfigModal.tsx: bg-[var(--surface)]/70',
  'components/farming/environment/ForecastTab.tsx: bg-[var(--primary)]/10',
  'components/farming/environment/WeatherTab.tsx: bg-[var(--primary)]/10',
]);

test('no bg/text/border/ring utility alpha-modifies a var() arbitrary color (inert in Tailwind v3.4)', () => {
  const files = listFilesRecursive(srcRoot, ['.tsx', '.ts']);
  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(INERT_TOKEN_ALPHA);
    if (match) {
      offenders.push(`${path.relative(srcRoot, file)}: ${match[0]}`);
    }
  }
  const unexpected = offenders.filter((o) => !PRE_EXISTING_INERT_ALPHA_OFFENDERS.has(o));
  assert.deepEqual(unexpected, []);
});
