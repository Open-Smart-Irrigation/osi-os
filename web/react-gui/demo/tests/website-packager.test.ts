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

test('website packager copies the six named static inputs without a build dependency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'osi-website-package-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(source);
  try {
    const names = ['invitation.js', 'invitation.css', 'osi-os-preview.png', 'invitation.html', 'preview.html', 'embed.html'];
    for (const name of names) await writeFile(path.join(source, name), name);
    await packageWebsiteAssets(source, output);
    for (const name of names) assert.equal(await readFile(path.join(output, name), 'utf8'), name);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
