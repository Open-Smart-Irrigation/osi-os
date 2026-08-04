import { execFile as execFileCallback } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const BLOCK_DEVICE_TOOLS = new Set(['dd', 'mkfs', 'mkfs.ext2', 'mkfs.ext3', 'mkfs.ext4', 'wipefs', 'parted', 'fdisk', 'sfdisk']);

export function assertSafeCommandArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.some((value) => typeof value !== 'string' || value.length === 0 || value.includes('\0'))) {
    throw new Error('command argv is invalid');
  }
  const executable = basename(argv[0]);
  if (BLOCK_DEVICE_TOOLS.has(executable) || argv.some((value) => /(?:^|\/)dev\//u.test(value))) {
    throw new Error('block-device command is forbidden');
  }
}

export async function runSafeCommand(request) {
  assertSafeCommandArgv(request.argv);
  try {
    const output = await execFile(request.argv[0], request.argv.slice(1), {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      timeout: request.timeoutMs,
      maxBuffer: request.maxOutputBytes,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: String(output.stdout),
      stderr: String(output.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}
