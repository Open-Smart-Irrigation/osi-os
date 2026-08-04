import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const image = 'node:22.14.0-bookworm';
const guardPath = new URL('../../builder/operations/osi-image-builder-exec-guard.js', import.meta.url).pathname;
const proxyCredentialEnvironmentPath = new URL('../../builder/operations/osi-proxy-credential-environment.cjs', import.meta.url).pathname;
const toolPath = new URL('../../builder/operations/osi-image-builder-tool.js', import.meta.url).pathname;
const environment = 'full_raspberrypi_bcm27xx_bcm2712';

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('trusted feeds update signal boundary', () => {
  it('waits for feed cleanup and restores the active config after Docker stop', async () => {
    try {
      const [{ stdout: architecture }] = await Promise.all([
        exec('/usr/bin/docker', ['info', '--format={{.Architecture}}'], { timeout: 5_000, maxBuffer: 16 * 1024 }),
        exec('/usr/bin/docker', ['image', 'inspect', image], { timeout: 5_000, maxBuffer: 16 * 1024 }),
      ]);
      if (!/^(?:amd64|x86_64)$/u.test(architecture.trim())) return;
    } catch {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), 'osi-update-feeds-signal-'));
    const containerName = `osi-update-feeds-signal-${process.pid}`;
    const activeConfig = join(workspace, 'openwrt/.config');
    try {
      await mkdir(join(workspace, environment, 'files'), { recursive: true });
      await mkdir(join(workspace, environment, 'patches'), { recursive: true });
      await mkdir(join(workspace, 'openwrt/scripts'), { recursive: true });
      await mkdir(join(workspace, 'conf'), { recursive: true });
      await writeFile(join(workspace, environment, '.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink(`${environment}/.config`, join(workspace, 'conf/.config'));
      await symlink(`${environment}/files`, join(workspace, 'conf/files'));
      await symlink(`${environment}/patches`, join(workspace, 'conf/patches'));
      await symlink('../conf/.config', activeConfig);
      await symlink('../conf/files', join(workspace, 'openwrt/files'));
      await symlink('../conf/patches', join(workspace, 'openwrt/patches'));
      await writeFile(join(workspace, 'feed-grandchild.js'), [
        "process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync('/workdir/feed-grandchild-cleanup', 'complete\\n'); process.exit(0); }, 500));",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'));
      const feeds = join(workspace, 'openwrt/scripts/feeds');
      await writeFile(feeds, [
        '#!/bin/sh',
        'node /workdir/feed-grandchild.js &',
        'grandchild=$!',
        "printf 'started\\n' > /workdir/feeds-started",
        "trap 'wait \"$grandchild\"; printf \"complete\\n\" > /workdir/feeds-cleanup-complete; exit 0' TERM INT HUP",
        'wait "$grandchild"',
        '',
      ].join('\n'));
      await chmod(feeds, 0o755);

      const args = [
        'run', '--detach', '--name', containerName, '--network', 'none', '--user', '0:0', '--workdir', '/workdir',
        '--mount', `type=bind,src=${workspace},dst=/workdir`,
        '--mount', `type=bind,src=${guardPath},dst=/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js,readonly`,
        '--mount', `type=bind,src=${proxyCredentialEnvironmentPath},dst=/opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs,readonly`,
        '--mount', `type=bind,src=${toolPath},dst=/opt/osi-image-builder/operations/osi-image-builder-tool.js,readonly`,
        image, 'sh', '-c', `set -- $(stat -c "%d %i" /workdir); exec node /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js "--workspace-dev=$1" "--workspace-ino=$2" --active-target-environment=${environment} --operation-id=update-feeds --operation-environment=${environment} --working-directory=/workdir -- node /opt/osi-image-builder/operations/osi-image-builder-tool.js update-feeds`,
      ];
      await exec('/usr/bin/docker', args, { timeout: 15_000, maxBuffer: 64 * 1024 });

      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await pathExists(join(workspace, 'feeds-started')) && !(await pathExists(activeConfig))) {
          ready = true;
          break;
        }
        await delay(50);
      }
      expect(ready).toBe(true);

      await exec('/usr/bin/docker', ['stop', '--time', '5', containerName], { timeout: 15_000, maxBuffer: 64 * 1024 });
      const state = await exec('/usr/bin/docker', ['inspect', '--format={{.State.ExitCode}}', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 });
      expect(Number(state.stdout.trim())).toBe(143);
      expect(await readFile(join(workspace, 'feed-grandchild-cleanup'), 'utf8')).toBe('complete\n');
      expect(await readFile(join(workspace, 'feeds-cleanup-complete'), 'utf8')).toBe('complete\n');
      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(workspace, environment, '.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
      expect(await pathExists(join(workspace, 'openwrt/.osi-image-builder-active-config-mask'))).toBe(false);
      expect(await pathExists(join(workspace, 'openwrt/.osi-image-builder-active-config-replacement'))).toBe(false);
    } finally {
      try { await exec('/usr/bin/docker', ['rm', '--force', containerName], { timeout: 5_000, maxBuffer: 16 * 1024 }); } catch { /* absent is acceptable */ }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
