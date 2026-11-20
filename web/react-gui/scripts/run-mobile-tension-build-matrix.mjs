import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guiRoot = path.resolve(here, '..');
const repoRoot = path.resolve(guiRoot, '../..');
const playwrightBin = path.join(guiRoot, 'node_modules', '.bin', 'playwright');
const serverScript = path.join(guiRoot, 'scripts', 'serve-mobile-history-build.mjs');
const buildRoot = await mkdtemp(path.join(os.tmpdir(), 'osi-mobile-history-edge-build-'));
const offDir = path.join(buildRoot, 'off');
const onDir = path.join(buildRoot, 'on');
const feedDir = path.join(repoRoot, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
const tarDir = path.join(buildRoot, 'upgrade-gui');
const evidenceDir = process.env.MOBILE_HISTORY_PLAYWRIGHT_OUTPUT
  ? path.resolve(process.env.MOBILE_HISTORY_PLAYWRIGHT_OUTPUT)
  : await mkdtemp(path.join(os.tmpdir(), 'osi-mobile-history-edge-results-'));
const children = new Set();
const forwardedArgs = process.argv.slice(2);
const releaseOnly = forwardedArgs.includes('--release-only');

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: guiRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}\n${stderr}`));
    });
  });
}

async function build(outDir, enabled) {
  const args = ['--outDir', outDir, '--emptyOutDir', '--manifest', '.vite/manifest.json'];
  if (enabled) args.push('--config', 'vite.mobile-history.config.js');
  await run('npm', ['run', 'build', '--', ...args], {
    VITE_BASE_PATH: '/gui/',
    VITE_MOBILE_HISTORY_INTERNAL: 'true',
    VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS: 'true',
    VITE_HISTORY_UPLOT_SOIL_ENABLED: 'true',
  });
  if (!enabled) await run(process.execPath, ['scripts/verify-release-phone-chunks.mjs', outDir]);
}

async function preparePackages() {
  const suppliedUpgrade = process.env.REACT_GUI_TARBALL;
  const suppliedOffline = process.env.OSI_OFFLINE_BUNDLE;
  assert.ok(Boolean(suppliedUpgrade) === Boolean(suppliedOffline),
    'Provide REACT_GUI_TARBALL and OSI_OFFLINE_BUNDLE together to verify release artifacts');

  let upgrade = suppliedUpgrade && path.resolve(suppliedUpgrade);
  let offline = suppliedOffline && path.resolve(suppliedOffline);
  if (!upgrade) {
    upgrade = path.join(buildRoot, 'react_gui.tar.gz');
    await run('tar', ['-czf', upgrade, '-C', offDir, '.']);
    const packages = path.join(buildRoot, 'packages');
    await run('bash', [path.join(repoRoot, 'scripts/deploy-bundle.sh'), upgrade], {
      REPO_ROOT: repoRoot,
      REACT_GUI_TARBALL: upgrade,
      OUT_DIR: packages,
    });
    const bundles = (await readdir(packages)).filter((file) => /^deploy-bundle-.*\.tar\.gz$/.test(file));
    assert.equal(bundles.length, 1, 'deploy-bundle.sh must produce one offline bundle');
    offline = path.join(packages, bundles[0]);
  } else {
    // Release packaging refreshes the feed alongside the published upgrade tarball.
    await run(process.execPath, ['scripts/verify-release-gui-packages.mjs', offDir, feedDir, upgrade]);
  }

  const offlinePayload = path.join(buildRoot, 'offline-payload');
  await mkdir(offlinePayload);
  await run('tar', ['-xzf', offline, '-C', offlinePayload, './react_gui.tar.gz']);
  const embeddedUpgrade = path.join(offlinePayload, 'react_gui.tar.gz');
  assert.ok((await readFile(embeddedUpgrade)).equals(await readFile(upgrade)),
    'The offline payload must carry the exact upgrade archive');
  console.log('Offline deploy bundle contains the supplied upgrade archive byte-for-byte.');
  await mkdir(tarDir);
  await run('tar', ['-xzf', embeddedUpgrade, '-C', tarDir]);
  for (const directory of [feedDir, tarDir]) {
    await run(process.execPath, ['scripts/verify-release-phone-chunks.mjs', directory, '--packaged']);
  }
}

async function startServer(root, port) {
  const child = spawn(process.execPath, [serverScript, '--root', root, '--port', String(port), '--base', '/gui/'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForHealth(`http://127.0.0.1:${port}/__mobile_history_health`);
  return child;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()) === 'ok\n') return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`static server did not become healthy: ${url}: ${lastError ?? 'timeout'}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  children.delete(child);
}

let offServer;
let onServer;
let feedServer;
let failure = null;
try {
  await build(offDir, false);
  if (!releaseOnly) await build(onDir, true);
  await preparePackages();
  offServer = await startServer(tarDir, 4381);
  if (!releaseOnly) onServer = await startServer(onDir, 4382);
  feedServer = await startServer(feedDir, 4383);
  const playwrightArgs = [
    'test', '--config', 'playwright.mobile-history.config.ts',
    ...(releaseOnly
      ? ['--project=edge-off', '--project=release-feed', '--project=release-feed-phone', '--project=release-upgrade-desktop',
        'mobile-tension-real-data.spec.ts', 'release-data-views.spec.ts']
      : []),
    ...forwardedArgs.filter((arg) => arg !== '--release-only'),
  ];
  await run(playwrightBin, playwrightArgs, {
    MOBILE_HISTORY_EDGE_OFF_BASE_URL: 'http://127.0.0.1:4381/gui/',
    MOBILE_HISTORY_EDGE_ON_BASE_URL: 'http://127.0.0.1:4382/gui/',
    MOBILE_HISTORY_FEED_BASE_URL: 'http://127.0.0.1:4383/gui/',
    MOBILE_HISTORY_PLAYWRIGHT_OUTPUT: evidenceDir,
  });
} catch (error) {
  failure = error;
  process.exitCode = 1;
} finally {
  await stop(offServer);
  await stop(onServer);
  await stop(feedServer);
  for (const child of [...children]) {
    try { await stop(child); } catch { /* process is already gone */ }
  }
  await rm(buildRoot, { recursive: true, force: true });
  process.stdout.write(`mobile-history evidence: ${evidenceDir}\n`);
  if (failure) process.stderr.write(`${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}\n`);
}
