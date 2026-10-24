import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guiRoot = path.resolve(here, '..');
const repoRoot = path.resolve(guiRoot, '../..');
const viteBin = path.join(guiRoot, 'node_modules', '.bin', 'vite');
const playwrightBin = path.join(guiRoot, 'node_modules', '.bin', 'playwright');
const serverScript = path.join(guiRoot, 'scripts', 'serve-mobile-history-build.mjs');
const buildRoot = await mkdtemp(path.join(os.tmpdir(), 'osi-mobile-history-edge-build-'));
const offDir = path.join(buildRoot, 'off');
const onDir = path.join(buildRoot, 'on');
const evidenceDir = process.env.MOBILE_HISTORY_PLAYWRIGHT_OUTPUT
  ? path.resolve(process.env.MOBILE_HISTORY_PLAYWRIGHT_OUTPUT)
  : await mkdtemp(path.join(os.tmpdir(), 'osi-mobile-history-edge-results-'));
const children = new Set();

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
  await run(viteBin, ['build', '--outDir', outDir, '--emptyOutDir', '--manifest', '.vite/manifest.json'], {
    VITE_BASE_PATH: '/gui/',
    VITE_MOBILE_HISTORY_INTERNAL: enabled ? 'true' : 'false',
    VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS: enabled ? 'true' : 'false',
  });
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
let failure = null;
try {
  await build(offDir, false);
  await build(onDir, true);
  offServer = await startServer(offDir, 4181);
  onServer = await startServer(onDir, 4182);
  const playwrightArgs = ['test', '--config', 'playwright.mobile-history.config.ts', ...process.argv.slice(2)];
  await run(playwrightBin, playwrightArgs, {
    MOBILE_HISTORY_EDGE_OFF_BASE_URL: 'http://127.0.0.1:4181/gui/',
    MOBILE_HISTORY_EDGE_ON_BASE_URL: 'http://127.0.0.1:4182/gui/',
    MOBILE_HISTORY_PLAYWRIGHT_OUTPUT: evidenceDir,
  });
} catch (error) {
  failure = error;
  process.exitCode = 1;
} finally {
  await stop(offServer);
  await stop(onServer);
  for (const child of [...children]) {
    try { await stop(child); } catch { /* process is already gone */ }
  }
  await rm(buildRoot, { recursive: true, force: true });
  process.stdout.write(`mobile-history evidence: ${evidenceDir}\n`);
  if (failure) process.stderr.write(`${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}\n`);
}
