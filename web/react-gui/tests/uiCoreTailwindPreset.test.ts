import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const guiRoot = path.resolve(import.meta.dirname, '..');

test('tailwind-preset maps the farm palette and ui-core tokens', async () => {
  const preset = (await import('../src/ui-core/tailwind-preset.js')).default;
  const colors = preset.theme.extend.colors;
  assert.equal(colors['farm-green'], '#22c55e');
  assert.equal(colors.card, 'var(--card)');
  assert.equal(colors['error-text'], 'var(--error-text)');
  assert.equal(colors['brand-red'], 'var(--brand-red)');
});

test('edge tailwind.config extends the ui-core preset', () => {
  const config = fs.readFileSync(path.join(guiRoot, 'tailwind.config.js'), 'utf8');
  assert.match(config, /from '\.\/src\/ui-core\/tailwind-preset\.js'/);
  assert.match(config, /presets:\s*\[uiCorePreset\]/);
  assert.doesNotMatch(config, /'farm-green'/);
});

test('index.css loads the config so the preset is active under Tailwind v4', () => {
  const css = fs.readFileSync(path.join(guiRoot, 'src/index.css'), 'utf8');
  assert.match(css, /@config "\.\.\/tailwind\.config\.js";/);
});
