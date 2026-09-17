import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Glyph-only controls on the farmer-facing screens, measured in page at
 * 390 px by the 2026-09-17 review: the per-device remove `✕` was 25 × 36 and
 * the configure `⚙` beside it 26 × 36 — the destructive control the smaller of
 * two adjacent 25-pixel targets, on the screen used outdoors. `index.css`
 * has defined `.touch-target { min-height: 48px; min-width: 48px }` all along
 * and twenty other buttons already use it.
 *
 * WCAG 2.5.8's own floor is 24 px, which these clear; 44 px is this product's
 * bar for a control with no text label to aim at.
 *
 * `src/ui-core/Modal.tsx` carries the same pattern and is deliberately out of
 * scope: ui-core is byte-mirrored to osi-server and `verify-ui-core-vendor.sh`
 * gates it, so its close button has to move in both repos at once.
 *
 * The gateway panel's own controls are covered by name rather than by glyph:
 * the five fan presets (38–65 × 24 px, and they drive real hardware) and the
 * refresh button (85 × 32) carry a label, so the scan above does not see them.
 */
const NAMED_CONTROLS: Array<[string, string[]]> = [
  ['SystemPanel.tsx', ['systemPanel.refresh', 'p.labelKey']],
];

test('the gateway panel fan and refresh controls carry a touch target', () => {
  for (const [file, markers] of NAMED_CONTROLS) {
    const source = fs.readFileSync(path.join(farmingRoot, file), 'utf8');
    for (const marker of markers) {
      const at = source.indexOf(marker);
      assert.ok(at >= 0, `${file} no longer contains ${marker}`);
      const opening = source.lastIndexOf('<button', at);
      assert.ok(opening >= 0, `${marker} is not inside a button`);
      assert.ok(
        source.slice(opening, at).includes('touch-target'),
        `${file} control at ${marker} is below the 48 px target`,
      );
    }
  }
});


const farmingRoot = path.resolve(import.meta.dirname, '../src/components/farming');

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') tsxFiles(full, found);
    } else if (full.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A button whose entire content is one icon glyph has nothing else to aim at.
 * Matched from the closing tag backwards, because a JSX attribute list holds
 * arrow functions and a forward `<button…>` match would run past the opening
 * tag it belongs to.
 */
const GLYPH_CLOSE = /([⚙✕×↻⟳])\s*<\/button>/g;

function glyphButtons(source: string): Array<{ glyph: string; attributes: string }> {
  const buttons: Array<{ glyph: string; attributes: string }> = [];
  for (const match of source.matchAll(GLYPH_CLOSE)) {
    const opening = source.lastIndexOf('<button', match.index);
    if (opening < 0) continue;
    const attributes = source.slice(opening, match.index);
    // Anything else between the tag and the glyph means the glyph is not the
    // whole content, so the control has a label to aim at.
    if (attributes.slice('<button'.length).includes('<')) continue;
    buttons.push({ glyph: match[1], attributes });
  }
  return buttons;
}

test('every glyph-only control on a farming screen carries a touch target', () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of tsxFiles(farmingRoot)) {
    for (const button of glyphButtons(fs.readFileSync(file, 'utf8'))) {
      scanned += 1;
      if (!button.attributes.includes('touch-target')) {
        offenders.push(`${path.relative(farmingRoot, file)} (${button.glyph})`);
      }
    }
  }
  assert.ok(scanned >= 17, `expected the farming screens' glyph buttons, scanned ${scanned}`);
  assert.deepEqual(offenders, [], `glyph-only buttons below the 48 px target: ${offenders.join(', ')}`);
});

/**
 * 1.4.4 Resize Text. `HistoryCardDetailPage` rewrote the viewport meta to
 * `maximum-scale=1, user-scalable=no` on mount, disabling pinch-zoom on the
 * one screen built for reading a chart — the screen an operator opens in the
 * field, in sunlight, to read a soil-tension trend. The gesture conflict it
 * was defending against is already handled where it belongs:
 * `useVisualizationGestures` sets `touch-action: none` on the visualization
 * surface alone, and `HistoryVisualizationSurface.test.tsx` pins that the page
 * root does not get it.
 */
test('no screen disables pinch-zoom through the viewport meta', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (/\.(ts|tsx)$/.test(full)) {
        const source = fs.readFileSync(full, 'utf8');
        if (/user-scalable\s*=\s*no|maximum-scale/.test(source)) {
          offenders.push(path.relative(srcRoot, full));
        }
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], `these files disable page zoom: ${offenders.join(', ')}`);
});
