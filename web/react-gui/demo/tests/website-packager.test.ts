import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {packageWebsiteAssets} from '../website/package.mjs';

test('website packager fails when Task 9 invitation assets are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osi-website-package-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(source);
  try {
    await assert.rejects(packageWebsiteAssets(source, output), /invitation\.js, invitation\.css, osi-os-preview\.png/);
    await assert.rejects(readFile(path.join(output, 'invitation.js')), {code: 'ENOENT'});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('website packager copies eight named static inputs without a build dependency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osi-website-package-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(source);
  try {
    const names = ['invitation.js', 'invitation.css', 'osi-os-preview.png', 'invitation.html', 'cta.html', 'cta.css', 'preview.html', 'embed.html'];
    for (const name of names) await writeFile(path.join(source, name), name);
    await packageWebsiteAssets(source, output);
    for (const name of names) assert.equal(await readFile(path.join(output, name), 'utf8'), name);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('website plugin shortcode points to allowlisted public pages and enqueues its release stylesheet', async () => {
  const plugin = await readFile(new URL('../../../../docs/website/osi-os-demo-plugin.php', import.meta.url), 'utf8');
  const cta = await readFile(new URL('../website/cta.html', import.meta.url), 'utf8');
  assert.match(plugin, /add_shortcode\('osi_simulator_cta'/);
  assert.match(plugin, /esc_url\(home_url\('\/simulator\/'\)\)/);
  assert.match(plugin, /esc_url\(home_url\('\/osi-system\/'\)\)/);
  assert.match(plugin, /cta\.css/);
  assert.match(plugin, /v2-REPLACE_WITH_REVIEWED_SOURCE_COMMIT/);
  assert.match(cta, /Try the OSI OS simulator/);
  assert.match(cta, /href="\/simulator\/"/);
  assert.match(cta, /href="\/osi-system\/"/);
});
