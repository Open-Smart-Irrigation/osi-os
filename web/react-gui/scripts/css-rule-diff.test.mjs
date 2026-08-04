import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOW, atoms, diffAtoms } from './css-rule-diff-lib.mjs';

test('reordered rules produce no diff', () => {
  const a = ':root{--bg:#fff;--text:#000}.card{color:red}';
  const b = '.card{color:red}:root{--text:#000;--bg:#fff}';
  assert.deepEqual(diffAtoms(a, b), []);
});

test('a changed declaration is reported from both sides and allowlisted', () => {
  const changed = diffAtoms(':root{--error-bg:#DC2626}', ':root{--error-bg:#FEE2E2}');
  assert.equal(changed.length, 2);
  assert.ok(changed.every((atom) => ALLOW.test(atom)));
});

test('non-error drift is not covered by ALLOW', () => {
  const changed = diffAtoms('.card{color:red}', '.card{color:blue}');
  assert.equal(changed.filter((atom) => !ALLOW.test(atom)).length, 2);
});

test('atoms keep at-rule context distinct', () => {
  const css = '@media (pointer:coarse){.glass-tab{min-height:44px}}';
  assert.ok(atoms(css).some((atom) => atom.startsWith('@media (pointer:coarse)')));
});

test('the sanctioned ui-core JIT-scan atom (Chip.tsx border-danger-fg) is allowlisted exactly', () => {
  const atom = '.border-\\[var\\(--danger-fg\\)\\] { border-color:var(--danger-fg) }';
  assert.ok(ALLOW.test(atom));
});

test('a non-allowlisted variant of the JIT-scan atom still fails ALLOW', () => {
  const differentDeclaration = '.border-\\[var\\(--danger-fg\\)\\] { border-color:var(--danger-text) }';
  const differentSelector = '.text-\\[var\\(--danger-fg\\)\\] { border-color:var(--danger-fg) }';
  assert.ok(!ALLOW.test(differentDeclaration));
  assert.ok(!ALLOW.test(differentSelector));
});
