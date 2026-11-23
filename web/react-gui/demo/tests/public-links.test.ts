import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';

const publicDirectory = resolve(import.meta.dirname, '../public');

test('public host destinations stay on the reviewed allowlist and metadata uses the static preview asset', () => {
  const links = readFileSync(resolve(publicDirectory, 'links.ts'), 'utf8');
  const host = readFileSync(resolve(publicDirectory, 'host.ts'), 'utf8');
  const html = readFileSync(resolve(publicDirectory, 'index.html'), 'utf8');
  for (const href of ['/', '/osi-system/', 'https://github.com/Open-Smart-Irrigation/osi-os', 'https://github.com/Open-Smart-Irrigation/osi-os#device-setup']) {
    assert.ok(links.includes(`href: '${href}'`), `missing approved link ${href}`);
  }
  assert.match(host, /anchor\.rel = 'noopener'/);
  assert.doesNotMatch(host, /previewImage/);
  assert.ok(html.includes('property="og:image" content="https://opensmartirrigation.org/simulator/assets/osi-os-preview.png"'));
  for (const meta of ['name="description"', 'property="og:title"', 'property="og:description"', 'property="og:image"']) assert.ok(html.includes(meta));
});
