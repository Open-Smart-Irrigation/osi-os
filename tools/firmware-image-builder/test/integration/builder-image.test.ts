import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { probeDocker, validateBuiltBuilderImage } from '../../builder/validate-builder.js';

const exec = promisify(execFile);
const imageTag = `osi-image-builder-task11-test:${process.pid}`;

describe('builder image integration boundary', () => {
  it('always reports Docker capability and preserves zero mutation when unavailable', async () => {
    const calls: string[][] = [];
    const capability = await probeDocker({ run: async (_executable, argv) => { calls.push([...argv]); throw Object.assign(new Error('docker unavailable'), { code: 'ENOENT' }); } });
    expect(capability).toHaveProperty('available');
    expect(capability).toMatchObject({ available: false, mutation: 'none', code: 'DOCKER_UNAVAILABLE' });
    expect(calls).toEqual([['version', '--format', '{{json .}}']]);
    expect(calls.flat().some((argument) => new Set(['build', 'run', 'rm', 'create', 'push']).has(argument))).toBe(false);
  });

  it('builds, inspects, and self-tests the complete image when Docker is available', async () => {
    const capability = await probeDocker();
    expect(capability).toMatchObject({ available: true, architecture: 'amd64', code: 'OK' });
    const context = new URL('../..', import.meta.url).pathname;
    try {
      const result = await exec('/usr/bin/docker', ['build', '--platform=linux/amd64', '--no-cache', '--tag', imageTag, '--file', 'builder/Dockerfile', '.'], { cwd: context, maxBuffer: 1024 * 1024, timeout: 30 * 60 * 1000 });
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/exporting to image|writing image sha256:|Successfully built/u);
      const inspected = await exec('/usr/bin/docker', ['image', 'inspect', '--format', '{{json .}}', imageTag], { maxBuffer: 64 * 1024 });
      const image = JSON.parse(inspected.stdout) as { Id?: string; Size?: number };
      expect(image.Id).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(image.Size).toBeGreaterThan(0);
      expect(image.Size).toBeLessThan(4 * 1024 * 1024 * 1024);
      const validated = await validateBuiltBuilderImage(imageTag);
      expect(validated).toMatchObject({ imageId: image.Id, selfTest: 'passed' });
      expect(validated.evidence.rustTargets.map(({ target }) => target).sort()).toEqual(['aarch64-unknown-linux-musl', 'armv7-unknown-linux-musleabihf', 'x86_64-unknown-linux-gnu']);
      expect(validated.evidence.commands.some(({ argv }) => argv.join(' ').includes('test ! -e /tmp/rust-source'))).toBe(true);
    } finally {
      await exec('/usr/bin/docker', ['image', 'rm', '--force', imageTag], { maxBuffer: 64 * 1024 });
      await expect(exec('/usr/bin/docker', ['image', 'inspect', imageTag], { maxBuffer: 64 * 1024 })).rejects.toBeDefined();
    }
  }, 30 * 60 * 1000);
});
