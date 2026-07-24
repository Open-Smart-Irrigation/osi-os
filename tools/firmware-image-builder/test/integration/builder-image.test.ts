import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { probeDocker, validateBuiltBuilderImage, validateTrustedOperationToolSource } from '../../builder/validate-builder.js';
import { BUILD_OUTPUT_TAIL_BYTES, BUILD_TIMEOUT_MS, runStreamingBuild } from '../support/run-streaming-build.js';

const exec = promisify(execFile);
const imageTag = `osi-image-builder-task11-test:${process.pid}`;
function isMissingImageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return /No such image|manifest unknown|reference not found/iu.test([value.stderr, value.stdout, value.message].filter((item): item is string => typeof item === 'string').join('\n'));
}

async function cleanupImageTag(tag: string): Promise<void> {
  try {
    await exec('/usr/bin/docker', ['image', 'inspect', tag], { maxBuffer: 64 * 1024 });
  } catch (error) {
    if (isMissingImageError(error)) return;
    throw error;
  }
  await exec('/usr/bin/docker', ['image', 'rm', '--force', tag], { maxBuffer: 64 * 1024 });
  try {
    await exec('/usr/bin/docker', ['image', 'inspect', tag], { maxBuffer: 64 * 1024 });
  } catch (error) {
    if (isMissingImageError(error)) return;
    throw error;
  }
  throw new Error(`Docker image tag was not removed: ${tag}`);
}

describe('builder image integration boundary', () => {
  it('binds the canonical image contract to the root-owned trusted operation tool', async () => {
    const context = new URL('../..', import.meta.url).pathname;
    const dockerfile = await readFile(`${context}/builder/Dockerfile`, 'utf8');
    const tool = await readFile(`${context}/builder/operations/osi-image-builder-tool.js`, 'utf8');
    expect(dockerfile).toContain('COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-tool.js /opt/osi-image-builder/operations/osi-image-builder-tool.js');
    expect(dockerfile).toContain("test \"$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-tool.js)\" = '0:0'");
    expect(dockerfile).toContain("test \"$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-tool.js)\" = '555'");
    expect(() => validateTrustedOperationToolSource(tool)).not.toThrow();
  });

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
    let failure: unknown;
    try {
      const check = await exec('/usr/bin/docker', ['build', '--check', '--platform=linux/amd64', '--file', 'builder/Dockerfile', '.'], { cwd: context, maxBuffer: 128 * 1024, timeout: 120_000 });
      expect(`${check.stdout}\n${check.stderr}`).not.toMatch(/FromPlatformFlagConstDisallowed/u);
      const result = await runStreamingBuild(['build', '--platform=linux/amd64', '--no-cache', '--tag', imageTag, '--file', 'builder/Dockerfile', '.'], context, { timeoutMs: BUILD_TIMEOUT_MS });
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
    } catch (error) {
      failure = error;
    }
    try {
      await cleanupImageTag(imageTag);
    } catch (cleanupError) {
      if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Build/validation and image cleanup both failed');
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
  }, 65 * 60 * 1000);
});
