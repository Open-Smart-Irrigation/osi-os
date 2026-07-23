import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { probeDocker, validateBuiltBuilderImage } from '../../builder/validate-builder.js';

const exec = promisify(execFile);
const imageTag = `osi-image-builder-task11-test:${process.pid}`;

describe('builder image integration boundary', () => {
  it('always reports Docker capability and preserves zero mutation when unavailable', async () => {
    const capability = await probeDocker();
    expect(capability).toHaveProperty('available');
    if (!capability.available) expect(capability.mutation).toBe('none');
    else { expect(capability.clientVersion).toBeTruthy(); expect(capability.serverVersion).toBeTruthy(); }
  });

  it('builds, inspects, and self-tests the complete image when Docker is available', async () => {
    const capability = await probeDocker();
    if (!capability.available) { expect(capability.mutation).toBe('none'); return; }
    const context = new URL('../..', import.meta.url).pathname;
    try {
      const result = await exec('/usr/bin/docker', ['build', '--tag', imageTag, '--file', 'builder/Dockerfile', '.'], { cwd: context, maxBuffer: 1024 * 1024 });
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/exporting to image|writing image sha256:|Successfully built/u);
      const inspected = await exec('/usr/bin/docker', ['image', 'inspect', '--format', '{{json .}}', imageTag], { maxBuffer: 64 * 1024 });
      const image = JSON.parse(inspected.stdout) as { Id?: string };
      expect(image.Id).toMatch(/^sha256:[0-9a-f]{64}$/u);
      await expect(validateBuiltBuilderImage(imageTag)).resolves.toMatchObject({ imageId: image.Id, selfTest: 'passed' });
    } finally {
      await exec('/usr/bin/docker', ['image', 'rm', '--force', imageTag], { maxBuffer: 64 * 1024 }).catch(() => undefined);
    }
  }, 900_000);
});
