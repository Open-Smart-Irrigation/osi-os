import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { probeDocker, validateBuiltBuilderImage } from '../../builder/validate-builder.js';

const exec = promisify(execFile);
const imageTag = `osi-image-builder-task11-test:${process.pid}`;
const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
const BUILD_OUTPUT_TAIL_BYTES = 96 * 1024;

function runStreamingBuild(argv: readonly string[], cwd: string): Promise<{ readonly tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/docker', [...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer | string) => { tail = `${tail}${chunk.toString()}`.slice(-BUILD_OUTPUT_TAIL_BYTES); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => { if (timer !== undefined) clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (code === 0) resolve({ tail });
      else reject(new Error(`docker build exited with code=${code ?? 'null'} signal=${signal ?? 'none'}\n${tail}`));
    });
    timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`docker build timed out after ${BUILD_TIMEOUT_MS}ms\n${tail}`)); }, BUILD_TIMEOUT_MS);
  });
}

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
    if (!capability.available) {
      const calls: string[][] = [];
      const unavailableReference = `registry.example.invalid/osi-builder@sha256:${'a'.repeat(64)}`;
      await expect(validateBuiltBuilderImage(unavailableReference, { run: async (argv) => { calls.push([...argv]); throw Object.assign(new Error('docker unavailable'), { code: 'ENOENT' }); } })).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
      expect(calls).toEqual([['image', 'inspect', '--format', '{{json .}}', unavailableReference]]);
      expect(calls.flat().some((argument) => new Set(['build', 'run', 'rm', 'create', 'push']).has(argument))).toBe(false);
      return;
    }
    expect(capability).toMatchObject({ available: true, architecture: 'amd64', code: 'OK' });
    const context = new URL('../..', import.meta.url).pathname;
    try {
      const check = await exec('/usr/bin/docker', ['build', '--check', '--platform=linux/amd64', '--file', 'builder/Dockerfile', '.'], { cwd: context, maxBuffer: 128 * 1024, timeout: 120_000 });
      expect(`${check.stdout}\n${check.stderr}`).not.toMatch(/FromPlatformFlagConstDisallowed/u);
      const result = await runStreamingBuild(['build', '--platform=linux/amd64', '--no-cache', '--tag', imageTag, '--file', 'builder/Dockerfile', '.'], context);
      expect(result.tail).toMatch(/exporting to image|writing image sha256:|Successfully built/u);
      expect(result.tail.length).toBeLessThanOrEqual(BUILD_OUTPUT_TAIL_BYTES);
      const inspected = await exec('/usr/bin/docker', ['image', 'inspect', '--format', '{{json .}}', imageTag], { maxBuffer: 64 * 1024 });
      const image = JSON.parse(inspected.stdout) as { Id?: string; Size?: number; RepoDigests?: unknown; Config?: { Env?: unknown } };
      expect(image.Id).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(image.Size).toBeGreaterThan(0);
      expect(image.Size).toBeLessThan(4 * 1024 * 1024 * 1024);
      expect(image.Config?.Env).toEqual(['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);
      const repository = imageTag.slice(0, imageTag.lastIndexOf(':'));
      const canonical = Array.isArray(image.RepoDigests) ? image.RepoDigests.find((value): value is string => typeof value === 'string' && value.startsWith(`${repository}@sha256:`)) : undefined;
      expect(canonical).toMatch(new RegExp(`^${repository.replaceAll('.', '\\.') }@sha256:[0-9a-f]{64}$`, 'u'));
      const validated = await validateBuiltBuilderImage(canonical!);
      expect(validated).toMatchObject({ imageId: image.Id, selfTest: 'passed' });
      expect(validated.evidence.rustTargets.map(({ target }) => target).sort()).toEqual(['aarch64-unknown-linux-musl', 'armv7-unknown-linux-musleabihf', 'x86_64-unknown-linux-gnu']);
      expect(validated.evidence.commands.some(({ argv }) => argv.join(' ').includes('test ! -e /tmp/rust-source'))).toBe(true);
    } finally {
      await exec('/usr/bin/docker', ['image', 'rm', '--force', imageTag], { maxBuffer: 64 * 1024 });
      await expect(exec('/usr/bin/docker', ['image', 'inspect', imageTag], { maxBuffer: 64 * 1024 })).rejects.toBeDefined();
    }
  }, 30 * 60 * 1000);
});
