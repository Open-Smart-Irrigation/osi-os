import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { probeDocker } from '../../builder/validate-builder.js';

const exec = promisify(execFile);
const image = 'node:22.14.0-bookworm';
const guardPath = new URL('../../builder/operations/osi-image-builder-exec-guard.js', import.meta.url).pathname;
const credentialEnvironmentPath = new URL('../../builder/operations/osi-proxy-credential-environment.cjs', import.meta.url).pathname;

type CommandFailure = Error & { readonly code?: number | string; readonly stdout?: string; readonly stderr?: string };

describe('execution guard Docker boundary', () => {
  it('maps a signaled trusted operation to Docker exit 143 when running as PID 1', async () => {
    const capability = await probeDocker();
    if (!capability.available) {
      expect(capability).toMatchObject({ available: false, code: 'DOCKER_UNAVAILABLE' });
      return;
    }
    expect(capability).toMatchObject({ available: true, architecture: 'amd64', code: 'OK' });

    const workspace = await mkdtemp(join(tmpdir(), 'osi-execution-guard-'));
    const operationTool = join(workspace, 'operation-tool.js');
    const containerName = `osi-execution-guard-${process.pid}`;
    try {
      await writeFile(operationTool, "process.kill(process.pid, 'SIGTERM');\n", { mode: 0o555 });
      const args = [
        'run', '--rm', '--name', containerName, '--network', 'none', '--user', '0:0', '--workdir', '/workdir',
        '--mount', `type=bind,src=${workspace},dst=/workdir`,
        '--mount', `type=bind,src=${guardPath},dst=/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js,readonly`,
        '--mount', `type=bind,src=${credentialEnvironmentPath},dst=/opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs,readonly`,
        '--mount', `type=bind,src=${operationTool},dst=/opt/osi-image-builder/operations/osi-image-builder-tool.js,readonly`,
        image, 'sh', '-c', 'set -- $(stat -c "%d %i" /workdir); exec node /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js "--workspace-dev=$1" "--workspace-ino=$2" --active-target-environment=root --operation-id=copy-feed-config --operation-environment=full_raspberrypi_bcm27xx_bcm2712 --working-directory=/workdir -- node /opt/osi-image-builder/operations/osi-image-builder-tool.js copy-feed-config',
      ];

      let failure: CommandFailure | undefined;
      try {
        await exec('/usr/bin/docker', args, { timeout: 15_000, maxBuffer: 64 * 1024 });
      } catch (error) {
        failure = error as CommandFailure;
      }
      expect(failure).toBeDefined();
      expect(failure?.code).toBe(143);
      expect(failure?.stdout ?? '').toBe('');
      expect(failure?.stderr ?? '').toMatch(/execution guard: trusted operation terminated by SIGTERM\n/u);
    } finally {
      try { await exec('/usr/bin/docker', ['rm', '--force', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 }); } catch { /* --rm normally removed it */ }
      await expect(exec('/usr/bin/docker', ['inspect', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 })).rejects.toBeDefined();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('forwards Docker stop to the child and waits for child cleanup before exiting', async () => {
    let architecture: string;
    try {
      ({ stdout: architecture } = await exec('/usr/bin/docker', ['info', '--format={{.Architecture}}'], { timeout: 5_000, maxBuffer: 16 * 1024 }));
      await exec('/usr/bin/docker', ['image', 'inspect', image], { timeout: 5_000, maxBuffer: 16 * 1024 });
    } catch {
      return;
    }
    if (!/^(?:amd64|x86_64)$/u.test(architecture.trim())) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), 'osi-execution-guard-'));
    const operationTool = join(workspace, 'operation-tool.js');
    const grandchildTool = join(workspace, 'guard-grandchild.js');
    const containerName = `osi-execution-guard-cleanup-${process.pid}`;
    try {
      await writeFile(grandchildTool, [
        "process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync('/workdir/grandchild-cleanup-complete', 'term\\n'); process.exit(0); }, 500));",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'), { mode: 0o555 });
      await writeFile(operationTool, [
        "const fs = require('node:fs'); fs.writeFileSync('/workdir/child-ready', 'ready\\n');",
        "const child = require('node:child_process').spawn(process.execPath, ['/workdir/guard-grandchild.js'], { stdio: 'inherit' });",
        "process.on('SIGTERM', () => { fs.writeFileSync('/workdir/cleanup-started', 'term\\n'); child.once('close', () => { fs.writeFileSync('/workdir/cleanup-complete', 'term\\n'); process.exit(0); }); });",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'), { mode: 0o555 });
      const args = [
        'run', '--detach', '--name', containerName, '--network', 'none', '--user', '0:0', '--workdir', '/workdir',
        '--mount', `type=bind,src=${workspace},dst=/workdir`,
        '--mount', `type=bind,src=${guardPath},dst=/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js,readonly`,
        '--mount', `type=bind,src=${credentialEnvironmentPath},dst=/opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs,readonly`,
        '--mount', `type=bind,src=${operationTool},dst=/opt/osi-image-builder/operations/osi-image-builder-tool.js,readonly`,
        image, 'sh', '-c', 'set -- $(stat -c "%d %i" /workdir); exec node /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js "--workspace-dev=$1" "--workspace-ino=$2" --active-target-environment=root --operation-id=copy-feed-config --operation-environment=full_raspberrypi_bcm27xx_bcm2712 --working-directory=/workdir -- node /opt/osi-image-builder/operations/osi-image-builder-tool.js copy-feed-config',
      ];

      await exec('/usr/bin/docker', args, { timeout: 15_000, maxBuffer: 64 * 1024 });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const state = await exec('/usr/bin/docker', ['inspect', '--format={{.State.Running}}', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 });
        if (state.stdout.trim() === 'true') break;
        await delay(50);
      }
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          expect(await readFile(join(workspace, 'child-ready'), 'utf8')).toBe('ready\n');
          ready = true;
          break;
        } catch {
          await delay(50);
        }
      }
      expect(ready).toBe(true);
      await exec('/usr/bin/docker', ['stop', '--time', '5', containerName], { timeout: 15_000, maxBuffer: 64 * 1024 });

      const state = await exec('/usr/bin/docker', ['inspect', '--format={{.State.ExitCode}}', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 });
      const logs = await exec('/usr/bin/docker', ['logs', containerName], { timeout: 5_000, maxBuffer: 64 * 1024 });
      expect(Number(state.stdout.trim())).toBe(143);
      await expect(readFile(join(workspace, 'cleanup-started'), 'utf8')).resolves.toBe('term\n');
      await expect(readFile(join(workspace, 'grandchild-cleanup-complete'), 'utf8')).resolves.toBe('term\n');
      await expect(readFile(join(workspace, 'cleanup-complete'), 'utf8')).resolves.toBe('term\n');
      expect(logs.stderr).toMatch(/execution guard: received SIGTERM/u);
    } finally {
      try { await exec('/usr/bin/docker', ['rm', '--force', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 }); } catch { /* --rm is intentionally omitted so exit state can be inspected */ }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
