import {expect, test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import type {RollupOutput} from 'rollup';
import {cjsEdge, sharedConfig} from '../../vite.shared.mjs';
import type {paritySequence} from '../integration/run-replay-session';

test('Node and Chromium reproduce the same closed-loop SHA-256 checkpoints', async ({page}) => {
  const entry = fileURLToPath(new URL('../integration/run-replay-session.ts', import.meta.url));
  const bundles = await build({
    ...sharedConfig, configFile: false, publicDir: false, logLevel: 'error', plugins: [cjsEdge()],
    build: {write: false, lib: {entry, name: 'FarmReplayTest', formats: ['iife']}},
  }) as RollupOutput[];
  const script = bundles[0].output[0].code;
  const node = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', [
    'import {paritySequence} from "./tests/integration/run-replay-session.ts";',
    'process.stdout.write(JSON.stringify(paritySequence()));',
  ].join(' ')], {encoding: 'utf8'})) as ReturnType<typeof paritySequence>;
  expect(node.checkpoints.length).toBeGreaterThan(3);
  expect(node.terminal).toBe(node.live);
  await page.goto('about:blank');
  await page.addScriptTag({content: script});
  const browser = await page.evaluate(() => (window as Window & {
    FarmReplayTest?: {paritySequence(): ReturnType<typeof paritySequence>};
  }).FarmReplayTest!.paritySequence());
  expect(browser).toEqual(node);
});
