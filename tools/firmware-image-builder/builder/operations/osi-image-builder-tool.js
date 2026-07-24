#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';

const WORKTREE = '/workdir';
const FEED_CONFIG_SOURCE = `${WORKTREE}/feeds.conf.default`;
const FEED_CONFIG_DESTINATION = `${WORKTREE}/openwrt/feeds.conf.default`;
const GUI_SOURCE = `${WORKTREE}/web/react-gui/build`;
const GUI_DESTINATION = `${WORKTREE}/feeds/chirpstack-openwrt-feed/apps/node-red/files/gui`;
const IMAGE_DIRECTORY = `${WORKTREE}/openwrt/bin/targets`;
const OPERATIONS = new Set(['copy-feed-config', 'verify-image', 'mirror-gui']);

function fail(message) {
  process.stderr.write(`osi-image-builder-tool: ${message}\n`);
  process.exitCode = 2;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function copyFeedConfig() {
  const sourceHash = await sha256(FEED_CONFIG_SOURCE);
  await mkdir(`${WORKTREE}/openwrt`, { recursive: true });
  await copyFile(FEED_CONFIG_SOURCE, FEED_CONFIG_DESTINATION);
  const destinationHash = await sha256(FEED_CONFIG_DESTINATION);
  if (sourceHash !== destinationHash) throw new Error('feed configuration hash changed during copy');
  process.stdout.write(JSON.stringify({ operation: 'copy-feed-config', source: 'feeds.conf.default', destination: 'openwrt/feeds.conf.default', sha256: sourceHash }) + '\n');
}

async function mirrorGui() {
  const source = await stat(GUI_SOURCE);
  if (!source.isDirectory()) throw new Error('GUI build output is not a directory');
  await cp(GUI_SOURCE, GUI_DESTINATION, { recursive: true, force: true });
  const files = await readdir(GUI_DESTINATION, { recursive: true });
  if (files.length === 0) throw new Error('GUI mirror produced no files');
  process.stdout.write(JSON.stringify({ operation: 'mirror-gui', source: 'web/react-gui/build', destination: 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui', fileCount: files.length }) + '\n');
}

async function verifyImage() {
  const root = await stat(IMAGE_DIRECTORY);
  if (!root.isDirectory()) throw new Error('OpenWrt target directory is not a directory');
  const candidates = [];
  for (const target of await readdir(IMAGE_DIRECTORY, { withFileTypes: true })) {
    if (!target.isDirectory()) continue;
    for (const profile of await readdir(`${IMAGE_DIRECTORY}/${target.name}`, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      for (const file of await readdir(`${IMAGE_DIRECTORY}/${target.name}/${profile.name}`, { withFileTypes: true })) {
        if (/\.(?:img|img\.gz)$/u.test(file.name)) candidates.push(`${target.name}/${profile.name}/${file.name}`);
      }
    }
  }
  if (candidates.length !== 1) throw new Error(`expected exactly one firmware image, found ${candidates.length}`);
  const image = await stat(`${IMAGE_DIRECTORY}/${candidates[0]}`);
  if (!image.isFile() || image.size < 64 * 1024 * 1024) throw new Error('firmware image is missing or below the 64 MiB minimum');
  process.stdout.write(JSON.stringify({ operation: 'verify-image', relativePath: `openwrt/bin/targets/${candidates[0]}`, size: image.size, sha256: await sha256(`${IMAGE_DIRECTORY}/${candidates[0]}`) }) + '\n');
}

const args = process.argv.slice(2);
if (args.length !== 1 || !OPERATIONS.has(args[0])) {
  fail('exactly one trusted operation name is required');
} else {
  try {
    if (args[0] === 'copy-feed-config') await copyFeedConfig();
    else if (args[0] === 'verify-image') await verifyImage();
    else await mirrorGui();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
