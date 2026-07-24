#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKTREE = '/workdir';
const OPERATIONS = new Set(['copy-feed-config', 'verify-image', 'mirror-gui']);

function fail(message) {
  process.stderr.write(`osi-image-builder-tool: ${message}\n`);
  process.exitCode = 2;
}

function paths(root) {
  return {
    feedSource: join(root, 'feeds.conf.default'),
    feedDestination: join(root, 'openwrt/feeds.conf.default'),
    feedStaging: join(root, '.osi-image-builder-feed-config-staging'),
    guiSource: join(root, 'web/react-gui/build'),
    guiDestination: join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui'),
    guiStaging: join(root, '.osi-image-builder-gui-staging'),
    imageDirectory: join(root, 'openwrt/bin/targets'),
  };
}

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function requireAbsoluteRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0')) throw new Error('operation root is not a canonical absolute path');
}

async function requireDirectory(path, field) {
  const value = await lstat(path);
  if (value.isSymbolicLink()) throw new Error(`${field} contains a symbolic link`);
  if (!value.isDirectory()) throw new Error(`${field} is not a directory`);
}

async function ensureDirectoryTree(root, relativePath) {
  await requireDirectory(root, 'operation root');
  let current = root;
  for (const part of relativePath.split('/').filter(Boolean)) {
    current = join(current, part);
    const value = await existing(current);
    if (value === null) await mkdir(current);
    const checked = await lstat(current);
    if (checked.isSymbolicLink() || !checked.isDirectory()) throw new Error(`directory path escapes through ${current}`);
  }
}

async function removeNoFollow(path) {
  const value = await existing(path);
  if (value === null) return;
  if (value.isSymbolicLink() || value.isFile()) { await unlink(path); return; }
  if (!value.isDirectory()) throw new Error(`cannot remove non-regular path ${path}`);
  for (const name of await readdir(path)) await removeNoFollow(join(path, name));
  await rmdir(path);
}

async function rejectSymlink(path, field) {
  const value = await existing(path);
  if (value?.isSymbolicLink()) throw new Error(`${field} is a symbolic link`);
  return value;
}

async function rejectSymlinkTree(path, field) {
  const value = await existing(path);
  if (value === null) return;
  if (value.isSymbolicLink()) throw new Error(`${field} contains a symbolic link`);
  if (!value.isDirectory()) return;
  for (const name of await readdir(path)) await rejectSymlinkTree(join(path, name), field);
}

async function readRegularNoFollow(path, field) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); }
  finally { await handle.close(); }
}

async function copyRegularNoFollow(source, destination) {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try { await destinationHandle.writeFile(await sourceHandle.readFile()); }
    finally { await destinationHandle.close(); }
  } finally { await sourceHandle.close(); }
}

async function fileManifest(path, relativePath = '') {
  const value = await lstat(path);
  if (value.isSymbolicLink()) throw new Error(`source contains a symbolic link at ${relativePath || path}`);
  if (value.isFile()) {
    const bytes = await readRegularNoFollow(path, `source file ${relativePath || path}`);
    return new Map([[relativePath, { size: value.size, sha256: createHash('sha256').update(bytes).digest('hex') }]]);
  }
  if (!value.isDirectory()) throw new Error(`source contains a non-regular path at ${relativePath || path}`);
  const result = new Map();
  for (const name of (await readdir(path)).sort()) {
    for (const [file, metadata] of await fileManifest(join(path, name), relativePath ? `${relativePath}/${name}` : name)) result.set(file, metadata);
  }
  return result;
}

function manifestHash(manifest) {
  const serialized = [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => `${path}\0${value.size}\0${value.sha256}\n`).join('');
  return createHash('sha256').update(serialized).digest('hex');
}

function equalManifest(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, value] of left) {
    const other = right.get(path);
    if (!other || other.size !== value.size || other.sha256 !== value.sha256) return false;
  }
  return true;
}

async function copyManifest(source, destination, manifest) {
  await ensureDirectoryTree(destination, '');
  for (const path of [...manifest.keys()].sort()) {
    const parent = dirname(path) === '.' ? '' : dirname(path);
    await ensureDirectoryTree(destination, parent);
    await copyRegularNoFollow(join(source, path), join(destination, path));
  }
}

async function copyFeedConfig(root) {
  const target = paths(root);
  await requireDirectory(root, 'operation root');
  const source = await rejectSymlink(target.feedSource, 'feed configuration source');
  if (!source?.isFile()) throw new Error('feed configuration source is missing or not regular');
  await ensureDirectoryTree(root, 'openwrt');
  await rejectSymlink(target.feedDestination, 'feed configuration destination');
  await rejectSymlinkTree(target.feedStaging, 'feed configuration staging');
  await removeNoFollow(target.feedStaging);
  const sourceHash = createHash('sha256').update(await readRegularNoFollow(target.feedSource, 'feed configuration source')).digest('hex');
  await copyRegularNoFollow(target.feedSource, target.feedStaging);
  const stagedHash = createHash('sha256').update(await readRegularNoFollow(target.feedStaging, 'feed configuration staging')).digest('hex');
  if (sourceHash !== stagedHash) throw new Error('feed configuration hash changed during staging');
  await removeNoFollow(target.feedDestination);
  await rename(target.feedStaging, target.feedDestination);
  const destinationHash = createHash('sha256').update(await readRegularNoFollow(target.feedDestination, 'feed configuration destination')).digest('hex');
  if (sourceHash !== destinationHash) throw new Error('feed configuration hash changed during publication');
  return { operation: 'copy-feed-config', source: 'feeds.conf.default', destination: 'openwrt/feeds.conf.default', sha256: sourceHash };
}

async function mirrorGui(root) {
  const target = paths(root);
  const sourceManifest = await fileManifest(target.guiSource);
  if (sourceManifest.size === 0) throw new Error('GUI build output contains no regular files');
  await ensureDirectoryTree(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files');
  await rejectSymlinkTree(target.guiDestination, 'GUI destination');
  await rejectSymlinkTree(target.guiStaging, 'GUI staging');
  await removeNoFollow(target.guiStaging);
  await mkdir(target.guiStaging);
  await copyManifest(target.guiSource, target.guiStaging, sourceManifest);
  const stagedManifest = await fileManifest(target.guiStaging);
  if (!equalManifest(sourceManifest, stagedManifest)) throw new Error('GUI staging manifest does not match source');
  await removeNoFollow(target.guiDestination);
  await rename(target.guiStaging, target.guiDestination);
  const destinationManifest = await fileManifest(target.guiDestination);
  if (!equalManifest(sourceManifest, destinationManifest)) throw new Error('GUI destination manifest does not match source');
  return { operation: 'mirror-gui', source: 'web/react-gui/build', destination: 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui', fileCount: sourceManifest.size, manifestSha256: manifestHash(sourceManifest) };
}

async function verifyImage(root) {
  const target = paths(root);
  const rootStat = await stat(target.imageDirectory);
  if (!rootStat.isDirectory()) throw new Error('OpenWrt target directory is not a directory');
  const candidates = [];
  for (const platform of await readdir(target.imageDirectory, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    for (const profile of await readdir(join(target.imageDirectory, platform.name), { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      for (const file of await readdir(join(target.imageDirectory, platform.name, profile.name), { withFileTypes: true })) {
        if (/\.(?:img|img\.gz)$/u.test(file.name)) candidates.push(join(platform.name, profile.name, file.name));
      }
    }
  }
  if (candidates.length !== 1) throw new Error(`expected exactly one firmware image, found ${candidates.length}`);
  const imagePath = join(target.imageDirectory, candidates[0]);
  const image = await stat(imagePath);
  if (!image.isFile() || image.size < 64 * 1024 * 1024) throw new Error('firmware image is missing or below the 64 MiB minimum');
  return { operation: 'verify-image', relativePath: `openwrt/bin/targets/${candidates[0]}`, size: image.size, sha256: createHash('sha256').update(await readFile(imagePath)).digest('hex') };
}

export function createOperationHandlersForTesting(root) {
  requireAbsoluteRoot(root);
  return Object.freeze({ copyFeedConfig: () => copyFeedConfig(root), mirrorGui: () => mirrorGui(root), verifyImage: () => verifyImage(root) });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !OPERATIONS.has(args[0])) { fail('exactly one trusted operation name is required'); return; }
  try {
    const handlers = createOperationHandlersForTesting(WORKTREE);
    const result = args[0] === 'copy-feed-config' ? await handlers.copyFeedConfig() : args[0] === 'mirror-gui' ? await handlers.mirrorGui() : await handlers.verifyImage();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
