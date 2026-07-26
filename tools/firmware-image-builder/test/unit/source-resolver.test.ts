import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GitCommand,
  GitCommandError,
  FIXED_GIT_ENV,
  type GitProcessResult,
} from '../../api/src/git/git-command.js';
import {
  SourceResolver,
  SourceResolverError,
  validateRecursiveSourcePreparation,
  type GitExecutor,
  type GitResolutionMetadata,
} from '../../api/src/git/source-resolver.js';
import { CANONICAL_FETCH_REFSPEC } from '../../config/origin-policy.js';
import { loadConfig } from '../../config/load.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccc';
const SHA_D = 'dddddddddddddddddddddddddddddddddddddddd';
const ORIGIN = 'git@github.com:Open-Smart-Irrigation/osi-os.git';
const NUL = '\0';
const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

class FakeGit implements GitExecutor {
  readonly calls: Array<{ argv: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  private readonly replies: (argv: readonly string[], callNumber: number) => Reply;

  constructor(replies?: (argv: readonly string[], callNumber: number) => Reply) {
    this.replies = replies ?? ((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config' && argv.includes('remote.origin.fetch')) return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref' && argv.includes('refs/remotes/origin/alias')) return { stdout: `refs/remotes/origin/alias${NUL}refs/remotes/origin/main${NUL}\n` };
      if (argv[0] === 'for-each-ref' && argv.at(-1)?.startsWith('refs/remotes/origin/') && argv.at(-1) !== 'refs/remotes/origin/') return { stdout: `${argv.at(-1)}${NUL}${NUL}\n` };
      if (argv[0] === 'for-each-ref') return { stdout: `refs/remotes/origin/feature/a${NUL}${NUL}\nrefs/remotes/origin/HEAD${NUL}${NUL}\nrefs/remotes/origin/main${NUL}${NUL}\nrefs/heads/local${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { stdout: `${argv.at(-1)?.includes('feature/a') ? SHA_B : SHA_A}\n` };
      if (argv[0] === 'ls-tree') return {
        stdout: `100644 blob ${SHA_B}\t.gitmodules${NUL}040000 tree ${SHA_C}\tfeeds/chirpstack-openwrt-feed${NUL}040000 tree ${SHA_D}\topenwrt${NUL}`,
      };
      if (argv[0] === 'show' && argv.at(-1)?.endsWith(':.gitmodules')) return {
        stdout: '[submodule "openwrt"]\n path = openwrt\n url = https://github.com/openwrt/openwrt.git\n branch = openwrt-24.10\n[submodule "feeds/chirpstack-openwrt-feed"]\n path = feeds/chirpstack-openwrt-feed\n url = https://github.com/chirpstack/chirpstack-openwrt-feed.git\n',
      };
      if (argv[0] === 'show') {
        const sha = argv.at(-1) === SHA_B ? SHA_B : SHA_A;
        return argv.some((part) => part.includes('%an'))
          ? { stdout: `${sha}${NUL}2026-07-22T10:00:00+00:00${NUL}Alice Example${NUL}alice@example.test${NUL}subject with\nnewline${NUL}` }
          : { stdout: `${sha}${NUL}2026-07-22T10:00:00+00:00${NUL}subject with\nnewline${NUL}` };
      }
      return { stdout: '' };
    });
  }

  async run(argv: readonly string[], _options: { readonly cwd?: string; readonly signal?: AbortSignal } = {}): Promise<GitProcessResult> {
    this.calls.push({ argv: [...argv], env: FIXED_GIT_ENV });
    const reply = this.replies(argv, this.calls.length);
    return {
      argv,
      exitCode: reply.exitCode ?? 0,
      signal: null,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      durationMs: 1,
      timedOut: false,
      aborted: false,
    };
  }
}

function resolver(fake: FakeGit, now = () => '2026-07-23T12:00:00.000Z'): SourceResolver {
  return new SourceResolver({ repositoryPath: '/work/osi-os', remote: 'origin', git: fake, now });
}

describe('Git command boundary', () => {
  it('uses an absolute executable, argument arrays, fixed environment, and bounded output', async () => {
    let observed: { executable: string; argv: readonly string[]; options: Record<string, unknown> } | undefined;
    const command = new GitCommand({
      execFile: async (executable, argv, options) => {
        observed = { executable, argv, options };
        return { stdout: 'ok', stderr: '', exitCode: 0, signal: null };
      },
    });

    const result = await command.run(['fetch', 'origin', '--prune'], { cwd: '/work/osi-os' });

    expect(result.stdout).toBe('ok');
    expect(observed).toMatchObject({ executable: '/usr/bin/git', argv: ['fetch', 'origin', '--prune'] });
    expect(observed?.options).toMatchObject({ cwd: '/work/osi-os', timeout: 30_000, maxBuffer: 128 * 1024 });
    expect(observed?.options.env).toEqual(expect.objectContaining({
      PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: 'ssh',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    }));

    await command.run(['status'], { allowedProtocols: 'https' });
    expect(observed?.options.env).toEqual(expect.objectContaining({ GIT_ALLOW_PROTOCOL: 'https' }));
    expect(observed?.options.env).not.toHaveProperty('GIT_SSH_COMMAND');
    expect(observed?.options.env).not.toHaveProperty('GIT_SSH_VARIANT');
    expect(observed?.options.env).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('returns only bounded diagnostics for a failed command', async () => {
    const command = new GitCommand({
      execFile: async () => ({ stdout: 'x'.repeat(300_000), stderr: 'secret\n'.repeat(300_000), exitCode: 128, signal: null }),
    });

    await expect(command.run(['show', '--format=%s', SHA_A])).rejects.toSatisfy((error: unknown) => {
      return error instanceof GitCommandError
        && ['GIT_COMMAND_FAILED', 'GIT_OUTPUT_LIMIT'].includes(error.code)
        && error.stdout.length <= 64 * 1024
        && error.stderr.length <= 64 * 1024;
    });
  });

  it('classifies real child-process max-buffer overflow and preserves UTF-8 diagnostic bounds', async () => {
    await expect(new GitCommand({ executable: '/usr/bin/yes', sshAuthSock: null }).run(['x'])).rejects.toMatchObject({ code: 'GIT_OUTPUT_LIMIT' });
    for (const [prefix, character] of [['a', 'é'], ['ab', '€'], ['abc', '😀']] as const) {
      for (let boundary = 64 * 1024 - 4; boundary <= 64 * 1024 + 4; boundary += 1) {
        const command = new GitCommand({
          execFile: async () => ({ stdout: '', stderr: prefix + character.repeat(Math.ceil(boundary / Buffer.byteLength(character, 'utf8'))), exitCode: 128, signal: null }),
        });
        await expect(command.run(['status'])).rejects.toSatisfy((error: unknown) => error instanceof GitCommandError
          && Buffer.byteLength(error.stderr, 'utf8') <= 64 * 1024
          && !error.stderr.includes('\uFFFD'));
      }
    }
  });

  it('distinguishes abort from timeout at the command boundary', async () => {
    const aborted = new GitCommand({ execFile: async () => ({ stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', aborted: true }) });
    await expect(aborted.run(['status'])).rejects.toMatchObject({ code: 'GIT_COMMAND_ABORTED', aborted: true, timedOut: false });
    const timedOut = new GitCommand({ execFile: async () => ({ stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: true }) });
    await expect(timedOut.run(['status'])).rejects.toMatchObject({ code: 'GIT_COMMAND_TIMEOUT', aborted: false, timedOut: true });
  });

  it('does not expose private-key material in command diagnostics', async () => {
    const command = new GitCommand({
      execFile: async () => ({ stdout: '', stderr: '-----BEGIN OPENSSH PRIVATE KEY-----\nDO_NOT_EXPOSE_THIS\n-----END OPENSSH PRIVATE KEY-----', exitCode: 128, signal: null }),
    });

    await expect(command.run(['show', 'core.sshCommand=ssh -i /secret/key', 'fetch', 'origin', '--prune'])).rejects.toSatisfy((error: unknown) => {
      return error instanceof GitCommandError && !error.stderr.includes('DO_NOT_EXPOSE_THIS') && !error.argv.some((arg) => arg.includes('/secret/key'));
    });
  });

  it('passes abort and timeout controls to the process boundary', async () => {
    let observed: Record<string, unknown> | undefined;
    const command = new GitCommand({
      execFile: async (_executable, _argv, options) => {
        observed = { ...options };
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      },
    });
    const controller = new AbortController();
    await command.run(['status', '--porcelain'], { cwd: '/work/osi-os', signal: controller.signal });
    expect(observed).toMatchObject({ timeout: 30_000, maxBuffer: 128 * 1024, signal: controller.signal });
  });

  it('rejects an injected non-absolute executable before spawning', async () => {
    expect(() => new GitCommand({ executable: 'git;touch /tmp/pwned' })).toThrow(TypeError);
  });

  it('enforces immutable hook neutralization and rejects conflicting command-line overrides', async () => {
    let calls = 0;
    const command = new GitCommand({
      execFile: async (_executable, _argv, options) => {
        calls += 1;
        expect(options.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' });
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      },
    });
    await command.run(['-c', 'core.hooksPath=/dev/null', 'status']);
    await expect(command.run(['-c', 'core.hooksPath=/tmp/hooks', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['-ccore.hooksPath=/tmp/hooks', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['-cuser.name=UNTRUSTED', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['-c', 'user.name=UNTRUSTED', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['--config-env=core.hooksPath=UNTRUSTED', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['--config-env', 'core.hooksPath=UNTRUSTED', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['--config-env=user.name=UNTRUSTED', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['--config-env', 'user.name=UNTRUSTED', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['-c', 'include.path=/tmp/config', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['-cinclude.path=/tmp/config', 'status'])).rejects.toThrow(TypeError);
    for (const argv of [
      ['-C', '/repo', '-c', 'user.name=UNTRUSTED', 'fetch'],
      ['--git-dir=/repo/.git', '-c', 'user.name=UNTRUSTED', 'fetch'],
      ['--work-tree=/repo', '-c', 'user.name=UNTRUSTED', 'fetch'],
      ['--namespace=untrusted', '-c', 'user.name=UNTRUSTED', 'fetch'],
      ['--bare', '-c', 'user.name=UNTRUSTED', 'fetch'],
      ['--no-pager', '-c', 'user.name=UNTRUSTED', 'fetch'],
    ]) {
      await expect(command.run(argv)).rejects.toThrow(TypeError);
    }
    await expect(command.run(['-c', 'core.hooksPath=/dev/null', '-C', '/repo', 'status'])).rejects.toThrow(TypeError);
    await expect(command.run(['-c', 'core.hooksPath=/dev/null'])).rejects.toThrow(TypeError);
    await expect(command.run(['-c', 'core.hooksPath=/dev/null', '--bare', 'status'])).rejects.toThrow(TypeError);
    await command.run(['commit', '-c', 'HEAD']);
    expect(calls).toBe(2);
  });

  it('accepts a validated real Unix socket and keeps it API-private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-agent-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'agent.sock');
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    try {
      let environment: Readonly<Record<string, string>> | undefined;
      const command = new GitCommand({ sshAuthSock: socketPath, execFile: async (_executable, _argv, options) => {
        environment = options.env as Readonly<Record<string, string>>;
        return { stdout: 'ok', stderr: '', exitCode: 0, signal: null };
      } });
      await command.run(['status', '--porcelain']);
      expect(environment?.SSH_AUTH_SOCK).toBe(socketPath);
      expect(environment?.GIT_SSH_VARIANT).toBe('ssh');
      expect(environment?.GIT_SSH_COMMAND).toContain('/usr/bin/ssh');
      expect(Object.isFrozen(environment)).toBe(true);
      const failed = new GitCommand({ sshAuthSock: socketPath, execFile: async () => ({ stdout: '', stderr: `agent=${socketPath}`, exitCode: 128, signal: null }) });
      await expect(failed.run(['fetch', 'origin', '--prune'])).rejects.toSatisfy((error: unknown) => error instanceof GitCommandError && !error.stderr.includes(socketPath));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['missing.sock', 'regular.file'])('rejects an unavailable or non-socket SSH agent path', async (name) => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-agent-'));
    temporaryDirectories.push(directory);
    const path = join(directory, name);
    if (name === 'regular.file') await writeFile(path, 'not a socket');
    await expect(new GitCommand({ sshAuthSock: path, execFile: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }) }).run(['status']))
      .rejects.toMatchObject({ code: 'GIT_SSH_AUTH_UNAVAILABLE' });
  });

  it('rejects a symlinked agent and wrong-owner injected socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-agent-'));
    temporaryDirectories.push(directory);
    const target = join(directory, 'agent.sock');
    const link = join(directory, 'agent-link.sock');
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
    try {
      await symlink(target, link);
      await expect(new GitCommand({ sshAuthSock: link }).run(['status'])).rejects.toMatchObject({ code: 'GIT_SSH_AUTH_UNAVAILABLE' });
      const stats = await lstat(target);
      await expect(new GitCommand({
        sshAuthSock: target,
        sshAuthSocketFs: { lstat: async () => ({ uid: (process.geteuid?.() ?? 0) + 1, isSocket: () => true } as typeof stats), realpath: async () => target },
      }).run(['status'])).rejects.toMatchObject({ code: 'GIT_SSH_AUTH_UNAVAILABLE' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses process.env.SSH_AUTH_SOCK only through the validated constructor path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-agent-'));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, 'agent.sock');
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    vi.stubEnv('SSH_AUTH_SOCK', socketPath);
    try {
      let environment: Readonly<Record<string, string>> | undefined;
      await new GitCommand({ execFile: async (_executable, _argv, options) => { environment = options.env as Readonly<Record<string, string>>; return { stdout: '', stderr: '', exitCode: 0, signal: null }; } }).run(['status']);
      expect(environment?.SSH_AUTH_SOCK).toBe(socketPath);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('API-owned source resolver', () => {
  it('prepares exact detached feed checkouts with nested submodules under the real job path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-prepared-feeds-'));
    temporaryDirectories.push(directory);
    const nested = join(directory, 'nested');
    const packages = join(directory, 'packages');
    const luci = join(directory, 'luci');
    const routing = join(directory, 'routing');
    const repository = join(directory, 'repository');
    const gitEnvironment = {
      PATH: '/usr/bin:/bin',
      HOME: join(directory, 'git-home'),
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'file',
    };
    await mkdir(gitEnvironment.HOME);
    const git = async (cwd: string, argv: readonly string[]): Promise<string> => {
      const result = await execFile('/usr/bin/git', [...argv], { cwd, env: gitEnvironment });
      return result.stdout;
    };
    const init = async (path: string, file: string, contents: string): Promise<string> => {
      await mkdir(path);
      await git(path, ['init', '--quiet']);
      await git(path, ['config', 'user.name', 'Fixture Author']);
      await git(path, ['config', 'user.email', 'fixture@example.test']);
      await writeFile(join(path, file), contents);
      await git(path, ['add', '--', file]);
      await git(path, ['commit', '--quiet', '-m', `${file} fixture`]);
      return (await git(path, ['rev-parse', 'HEAD'])).trim();
    };
    const nestedSha = await init(nested, 'nested.txt', 'nested checkout\n');
    await init(packages, 'README', 'packages\n');
    await mkdir(join(packages, 'lang/rust'), { recursive: true });
    await writeFile(join(packages, 'lang/rust/Makefile'), 'fixture rust\n');
    await git(packages, ['add', 'lang/rust/Makefile']);
    await git(packages, ['commit', '--quiet', '-m', 'rust fixture']);
    await git(packages, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', nested, 'vendor/nested']);
    await git(packages, ['commit', '--quiet', '-am', 'nested submodule']);
    const packagesSha = (await git(packages, ['rev-parse', 'HEAD'])).trim();
    const luciSha = await init(luci, 'luci.txt', 'luci\n');
    const routingSha = await init(routing, 'routing.txt', 'routing\n');
    await init(repository, 'README', 'source\n');
    const locations = Object.freeze({
      packages: 'https://fixtures.invalid/packages.git',
      luci: 'https://fixtures.invalid/luci.git',
      routing: 'https://fixtures.invalid/routing.git',
    });
    await writeFile(join(repository, 'feeds.conf.default'), [
      `src-git packages ${locations.packages}^${packagesSha}`,
      `src-git luci ${locations.luci}^${luciSha}`,
      `src-git routing ${locations.routing}^${routingSha}`,
      'src-link chirpstack feeds/chirpstack-openwrt-feed',
      '',
    ].join('\n'));
    await git(repository, ['add', 'feeds.conf.default']);
    await git(repository, ['commit', '--quiet', '-m', 'pin fixture feeds']);
    const sourceSha = (await git(repository, ['rev-parse', 'HEAD'])).trim();

    const configHome = join(directory, 'config');
    const images = join(directory, 'images');
    await mkdir(configHome);
    await mkdir(images);
    await writeFile(join(configHome, 'config.json'), JSON.stringify({
      repositoryPath: repository,
      approvedOutputRoots: [{ id: 'images', label: 'images', path: images }],
      builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
      maxQueueLength: 50,
      diskFreeMinimumBytes: 20 * 1024 ** 3,
    }));
    const loaded = await loadConfig({
      configPath: join(configHome, 'config.json'),
      env: { HOME: directory, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(directory, 'state-home') },
      git: { getOriginPolicy: async () => ({ url: ORIGIN, fetchRefspec: CANONICAL_FETCH_REFSPEC }) },
      rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    });
    const urlMap = new Map<string, string>([
      [locations.packages, packages],
      [locations.luci, luci],
      [locations.routing, routing],
    ]);
    const feedGit: GitExecutor = {
      async run(argv, options) {
        expect(options?.allowedProtocols).toBe('https');
        const executed = argv.map((value) => urlMap.get(value) ?? value);
        try {
          const result = await execFile('/usr/bin/git', executed, {
            cwd: options?.cwd,
            env: gitEnvironment,
            timeout: options?.timeoutMs,
            maxBuffer: 128 * 1024,
          });
          if (argv[0] === 'clone') {
            const destination = argv.at(-1)!;
            const logicalUrl = argv.at(-2)!;
            await execFile('/usr/bin/git', ['remote', 'set-url', 'origin', logicalUrl], {
              cwd: join(options!.cwd!, destination),
              env: gitEnvironment,
            });
          }
          return { argv, exitCode: 0, signal: null, stdout: result.stdout, stderr: result.stderr, durationMs: 1, timedOut: false, aborted: false };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; code?: number; signal?: string };
          return { argv, exitCode: failure.code ?? 1, signal: failure.signal ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', durationMs: 1, timedOut: false, aborted: false };
        }
      },
    };
    const preparedPath = join(loaded.stateRoot, 'jobs/job-source-producer/prepared-feeds');
    expect(await lstat(preparedPath).catch(() => null)).toBeNull();

    const preparation = await new SourceResolver({
      repositoryPath: repository,
      git: new GitCommand({ sshAuthSock: null }),
      feedGit,
      now: () => '2026-07-26T20:00:00.000Z',
    }).prepareOfflineFeeds(sourceSha, loaded.pathAuthorities.stateRoot, 'job-source-producer');

    expect(preparation).toMatchObject({
      schemaVersion: 1,
      jobId: 'job-source-producer',
      sourceSha,
      preparedAt: '2026-07-26T20:00:00.000Z',
      feeds: [
        {
          name: 'packages',
          commit: packagesSha,
          detached: true,
          clean: true,
          recursiveSubmodulesPrepared: true,
          recursiveSubmodules: [{ path: 'vendor/nested', commit: nestedSha }],
        },
        { name: 'luci', commit: luciSha, recursiveSubmodules: [] },
        { name: 'routing', commit: routingSha, recursiveSubmodules: [] },
      ],
    });
    expect(await readFile(join(preparedPath, 'packages/vendor/nested/nested.txt'), 'utf8')).toBe('nested checkout\n');
    expect((await git(join(preparedPath, 'packages'), ['rev-parse', 'HEAD'])).trim()).toBe(packagesSha);
    await expect(git(join(preparedPath, 'packages'), ['symbolic-ref', '--quiet', 'HEAD'])).rejects.toThrow();
    expect(preparation.feeds.every((feed) => /^[0-9a-f]{64}$/u.test(feed.treeSha256))).toBe(true);
    expect(Object.isFrozen(preparation)).toBe(true);
  });

  it('prepares the actual repository vendored-tree layout before runner handoff', async () => {
    const repositoryPath = resolve(process.cwd(), '../..');
    const localGit = new GitCommand({ sshAuthSock: null });
    const head = (await localGit.run(['rev-parse', '--verify', 'HEAD'], { cwd: repositoryPath })).stdout.trim();
    const preparation = await new SourceResolver({
      repositoryPath,
      git: localGit,
      now: () => '2026-07-26T12:00:00.000Z',
    }).prepareRecursiveSource(head);

    expect(preparation).toEqual({
      schemaVersion: 1,
      sourceSha: head,
      gitmodulesBlobSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      preparedAt: '2026-07-26T12:00:00.000Z',
      components: [
        {
          path: 'feeds/chirpstack-openwrt-feed',
          mode: '040000',
          type: 'tree',
          objectId: expect.stringMatching(/^[0-9a-f]{40}$/),
          provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git',
        },
        {
          path: 'openwrt',
          mode: '040000',
          type: 'tree',
          objectId: expect.stringMatching(/^[0-9a-f]{40}$/),
          provenanceUrl: 'https://github.com/openwrt/openwrt.git',
        },
      ],
    });
    expect(Object.isFrozen(preparation)).toBe(true);
    expect(preparation.components.every(Object.isFrozen)).toBe(true);
    expect(() => validateRecursiveSourcePreparation({ ...preparation, extra: true } as never, head)).toThrow(SourceResolverError);
    expect(() => validateRecursiveSourcePreparation({
      ...preparation,
      components: preparation.components.map((component, index) => index === 0 ? { ...component, extra: true } as never : component),
    }, head)).toThrow(SourceResolverError);
  });

  it('fetches origin and lists only deterministic remote commit branches', async () => {
    const fake = new FakeGit();
    const result = await resolver(fake).listBranches();

    expect(result).toEqual({
      fetchedAt: '2026-07-23T12:00:00.000Z',
      branches: [
        { name: 'feature/a', sha: SHA_B, commitTime: '2026-07-22T10:00:00+00:00', subject: 'subject with\nnewline' },
        { name: 'main', sha: SHA_A, commitTime: '2026-07-22T10:00:00+00:00', subject: 'subject with\nnewline' },
      ],
    });
    expect(fake.calls.some(({ argv }) => argv.includes('fetch') && argv.at(-2) === ORIGIN && argv.at(-1) === CANONICAL_FETCH_REFSPEC)).toBe(true);
    expect(fake.calls.every(({ env }) => env.HOME === '/nonexistent' && env.GIT_TERMINAL_PROMPT === '0')).toBe(true);
  });

  it.each([
    ['https://github.com/example/osi-os.git', 'https origin'],
    ['/tmp/osi-os.git', 'local origin'],
    ['git@example.com:repo.git\0git@example.com:other.git\0', 'multiple origins'],
    ['git@example.com:repo.git\n', 'ambiguous origin'],
  ])('rejects %s', async (origin, label) => {
    const fake = new FakeGit((argv) => argv[0] === 'config' ? { stdout: origin } : { stdout: '' });
    await expect(resolver(fake).listBranches()).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
    expect(label).toBeTypeOf('string');
  });

  it('accepts the approved ssh URL form and does not inspect local heads', async () => {
    const fake = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: 'ssh://git.example/Open-Smart-Irrigation/osi-os.git\0' };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref') return { stdout: `refs/remotes/origin/main${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { stdout: `${SHA_A}\n` };
      if (argv[0] === 'show') return { stdout: `${SHA_A}${NUL}2026-07-22T10:00:00+00:00${NUL}subject${NUL}` };
      return { stdout: '' };
    });

    await expect(resolver(fake).listBranches()).resolves.toMatchObject({ branches: [{ name: 'main', sha: SHA_A }] });
    expect(fake.calls.some(({ argv }) => argv.includes('refs/heads/main'))).toBe(false);
    expect(fake.calls.some(({ argv }) => argv.at(-1) === 'refs/remotes/origin/main^{commit}')).toBe(true);
  });

  it('fetches the captured SSH URL with fixed nonrecursive fetch flags and the canonical refspec', async () => {
    const fake = new FakeGit();
    await resolver(fake).listBranches();
    const fetch = fake.calls.find(({ argv }) => argv.includes('fetch'));
    expect(fetch?.argv).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      'fetch',
      '--prune',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      ORIGIN,
      CANONICAL_FETCH_REFSPEC,
    ]);
  });

  it('rejects full ref-format hazards before Git resolution', async () => {
    const fake = new FakeGit();
    for (const branch of ['HEAD', 'a..b', '.hidden', 'a/.hidden', 'a.lock', 'a.lock/b', 'a.', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a\\b', 'a@b', 'a@{b', 'a//b', 'a/']) {
      await expect(resolver(fake).resolveAtAcceptance(branch, SHA_A)).rejects.toMatchObject({ code: 'INVALID_BRANCH' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it.each(['', '.hidden', 'a//b', 'a/./b', 'a/../b', '../main', 'main/', 'main;touch', '-option', `a${'x'.repeat(300)}`])('rejects unsafe branch %s before Git resolution', async (branch) => {
    const fake = new FakeGit();
    await expect(resolver(fake).resolveAtAcceptance(branch, SHA_A)).rejects.toMatchObject({ code: 'INVALID_BRANCH' });
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects invalid pinned SHA before Git resolution', async () => {
    const fake = new FakeGit();
    await expect(resolver(fake).resolveAtAcceptance('main', SHA_A.toUpperCase())).rejects.toMatchObject({ code: 'INVALID_SHA' });
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects a remote ref which does not resolve to a commit', async () => {
    const fake = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref') return { stdout: `${argv.at(-1)}${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { exitCode: 128, stderr: 'not a commit' };
      return { stdout: '' };
    });

    await expect(resolver(fake).resolveAtAcceptance('main', SHA_A)).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });
  });

  it('rejects malformed ref framing, extra metadata records, and SHA disagreement', async () => {
    const malformedRefs = new FakeGit((argv) => argv[0] === 'config' && argv.includes('remote.origin.url') ? { stdout: `${ORIGIN}${NUL}` } : argv[0] === 'config' && argv.includes('--name-only') ? { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` } : argv[0] === 'config' ? { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` } : argv[0] === 'fetch' ? { stdout: '' } : argv[0] === 'for-each-ref' ? { stdout: `refs/remotes/origin/main${NUL}${NUL}` } : { stdout: '' });
    await expect(resolver(malformedRefs).listBranches()).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });

    const extraMetadata = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref') return { stdout: `${argv.at(-1)}${NUL}${NUL}\n` };
      if (argv[0] === 'for-each-ref') return { stdout: `refs/remotes/origin/main${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { stdout: `${SHA_A}\n` };
      if (argv[0] === 'show') return { stdout: `${SHA_A}${NUL}2026-07-22T10:00:00+00:00${NUL}subject${NUL}${SHA_A}${NUL}2026-07-22T10:00:00+00:00${NUL}subject${NUL}` };
      return { stdout: '' };
    });
    await expect(resolver(extraMetadata).resolveAtAcceptance('main', SHA_A)).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });

    const wrongSha = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref') return { stdout: `${argv.at(-1)}${NUL}${NUL}\n` };
      if (argv[0] === 'for-each-ref') return { stdout: `refs/remotes/origin/main${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { stdout: `${SHA_A}\n` };
      if (argv[0] === 'show') return { stdout: `${SHA_B}${NUL}2026-07-22T10:00:00+00:00${NUL}Alice${NUL}alice@example.test${NUL}subject${NUL}` };
      return { stdout: '' };
    });
    await expect(resolver(wrongSha).resolveAtAcceptance('main', SHA_A)).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });
  });

  it('rejects symbolic aliases for acceptance and reports them as unknown for freshness', async () => {
    const fake = new FakeGit();
    await expect(resolver(fake).resolveAtAcceptance('alias', SHA_A)).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });
    await expect(resolver(fake).requestFreshness('alias', SHA_A)).resolves.toMatchObject({ status: 'unknown', errorCode: 'FRESHNESS_UNKNOWN' });
  });

  it.each(['core.sshCommand', 'core.alternateRefsCommand', 'core.alternateRefsPrefixes', 'core.fsmonitor', 'core.askPass', 'core.pager', 'core.editor', 'hook.reference-transaction.command', 'hook.reference-transaction.event', 'fetch.bundleURI', 'fetch.BUNDLEuri', 'fetch.bundleCreationToken', 'url.ssh://rewritten.insteadOf', 'remote.origin.uploadpack', 'remote.origin.proxy', 'include.path'])('rejects operation-time transport override %s before fetch', async (unsafeKey) => {
    const fake = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}${unsafeKey}${NUL}` };
      return { stdout: '' };
    });
    await expect(resolver(fake).resolveAtAcceptance('main', SHA_A)).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
    expect(fake.calls.some(({ argv }) => argv.includes('fetch'))).toBe(false);
  });

  it('rejects a noncanonical fetch refspec and detects origin drift after fetch', async () => {
    const unsafeRefspec = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `refs/heads/main:refs/remotes/origin/main${NUL}` };
      return { stdout: '' };
    });
    await expect(resolver(unsafeRefspec).resolveAtAcceptance('main', SHA_A)).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });

    let originReads = 0;
    const drift = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${originReads++ === 0 ? ORIGIN : 'git@example.com:changed/repo.git'}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      return { stdout: '' };
    });
    await expect(resolver(drift).resolveAtAcceptance('main', SHA_A)).rejects.toMatchObject({ code: 'GIT_FETCH_FAILED' });
  });

  it('returns BRANCH_MOVED without invoking the acceptance sink', async () => {
    const fake = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref') return { stdout: `${argv.at(-1)}${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { stdout: `${SHA_B}\n` };
      if (argv[0] === 'show') return { stdout: `${SHA_B}${NUL}2026-07-22T10:00:00+00:00${NUL}Alice${NUL}alice@example.test${NUL}moved${NUL}` };
      return { stdout: '' };
    });
    let accepted = 0;

    await expect(resolver(fake).resolveAtAcceptance('main', SHA_A, () => { accepted += 1; })).rejects.toMatchObject({ code: 'BRANCH_MOVED' });
    expect(accepted).toBe(0);
  });

  it('passes complete immutable metadata to the acceptance sink exactly once', async () => {
    const fake = new FakeGit();
    let accepted: GitResolutionMetadata | undefined;
    const result = await resolver(fake).resolveAtAcceptance('main', SHA_A, (metadata) => { accepted = metadata; });

    expect(result).toEqual(accepted);
    expect(accepted).toMatchObject({
      remote: 'origin',
      originUrl: ORIGIN,
      ref: 'refs/remotes/origin/main',
      branch: 'main',
      sha: SHA_A,
      commitTime: '2026-07-22T10:00:00+00:00',
      author: 'Alice Example <alice@example.test>',
      subject: 'subject with\nnewline',
      sourcePreparation: {
        schemaVersion: 1,
        sourceSha: SHA_A,
        gitmodulesBlobSha: SHA_B,
        preparedAt: '2026-07-23T12:00:00.000Z',
      },
    });
    expect(Object.isFrozen(accepted)).toBe(true);
  });

  it('returns fresh, advanced, and informational unknown freshness states', async () => {
    const fresh = new FakeGit();
    await expect(resolver(fresh).requestFreshness('main', SHA_A)).resolves.toEqual({ status: 'fresh', pinnedSha: SHA_A, observedSha: SHA_A, newerSourceAvailable: false });

    const advanced = new FakeGit((argv) => {
      if (argv[0] === 'config' && argv.includes('remote.origin.url')) return { stdout: `${ORIGIN}${NUL}` };
      if (argv[0] === 'config' && argv.includes('--name-only')) return { stdout: `remote.origin.url${NUL}remote.origin.fetch${NUL}` };
      if (argv[0] === 'config') return { stdout: `+refs/heads/*:refs/remotes/origin/*${NUL}` };
      if (argv[0] === 'fetch') return { stdout: '' };
      if (argv[0] === 'for-each-ref') return { stdout: `${argv.at(-1)}${NUL}${NUL}\n` };
      if (argv[0] === 'rev-parse') return { stdout: `${SHA_B}\n` };
      if (argv[0] === 'show') return { stdout: `${SHA_B}${NUL}2026-07-22T10:00:00+00:00${NUL}Alice${NUL}alice@example.test${NUL}new${NUL}` };
      return { stdout: '' };
    });
    await expect(resolver(advanced).requestFreshness('main', SHA_A)).resolves.toEqual({ status: 'advanced', pinnedSha: SHA_A, observedSha: SHA_B, newerSourceAvailable: true });

    const failed = new FakeGit((argv) => argv[0] === 'config' && argv.includes('remote.origin.url') ? { stdout: `${ORIGIN}${NUL}` } : { exitCode: 128, stderr: 'ssh unavailable' });
    await expect(resolver(failed).requestFreshness('main', SHA_A)).resolves.toEqual({ status: 'unknown', pinnedSha: SHA_A, observedSha: null, newerSourceAvailable: false, errorCode: 'FRESHNESS_UNKNOWN', errorEvidence: 'remote freshness check unavailable' });

    const invalidOrigin = new FakeGit((argv) => argv[0] === 'config' && argv.includes('remote.origin.url') ? { stdout: 'https://example.invalid/repo.git\0' } : { stdout: '' });
    await expect(resolver(invalidOrigin).requestFreshness('main', SHA_A)).resolves.toMatchObject({ status: 'unknown', errorCode: 'FRESHNESS_UNKNOWN' });
  });

  it('exposes a runner value with no network or credential capability', async () => {
    const fake = new FakeGit();
    const source = await resolver(fake).resolveAtAcceptance('main', SHA_A);
    const runnerSource = SourceResolver.toRunnerPinnedSource(source);

    expect(Object.keys(runnerSource).sort()).toEqual(['author', 'branch', 'commitTime', 'sha', 'sourcePreparation', 'subject']);
    expect(runnerSource).not.toHaveProperty('fetch');
    expect(runnerSource).not.toHaveProperty('originUrl');
    expect(runnerSource.sourcePreparation.components.every((component) => typeof component.objectId === 'string')).toBe(true);
    expect(Object.isFrozen(runnerSource)).toBe(true);
  });

  it('rejects incomplete or malformed metadata before creating a runner value', () => {
    expect(() => SourceResolver.toRunnerPinnedSource({
      remote: 'origin', originUrl: ORIGIN, ref: 'refs/remotes/origin/main', branch: 'main', sha: SHA_A,
      commitTime: '', author: '', subject: '', sourcePreparation: {} as never,
    })).toThrow(SourceResolverError);
  });

  it('resolves real Git ref and metadata framing while intercepting only fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-git-'));
    temporaryDirectories.push(directory);
    const repository = join(directory, 'repo');
    await mkdir(repository);
    await execFile('/usr/bin/git', ['init', '--quiet', repository]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.url', ORIGIN]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Real Author']);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'real@example.test']);
    await mkdir(join(repository, 'openwrt'));
    await mkdir(join(repository, 'feeds', 'chirpstack-openwrt-feed'), { recursive: true });
    await writeFile(join(repository, 'README'), 'real framing\n');
    await writeFile(join(repository, 'openwrt', 'README'), 'vendored openwrt\n');
    await writeFile(join(repository, 'feeds', 'chirpstack-openwrt-feed', 'README'), 'vendored feed\n');
    await writeFile(join(repository, '.gitmodules'), '[submodule "openwrt"]\n path = openwrt\n url = https://github.com/openwrt/openwrt.git\n branch = openwrt-24.10\n[submodule "feeds/chirpstack-openwrt-feed"]\n path = feeds/chirpstack-openwrt-feed\n url = https://github.com/chirpstack/chirpstack-openwrt-feed.git\n');
    await execFile('/usr/bin/git', ['-C', repository, 'add', '.']);
    await execFile('/usr/bin/git', ['-C', repository, 'commit', '--quiet', '-m', 'real framing subject']);
    const sha = (await execFile('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFile('/usr/bin/git', ['-C', repository, 'update-ref', 'refs/remotes/origin/main', sha]);
    await execFile('/usr/bin/git', ['-C', repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    await execFile('/usr/bin/git', ['-C', repository, 'symbolic-ref', 'refs/remotes/origin/alias', 'refs/remotes/origin/main']);

    const localGit = new GitCommand({ sshAuthSock: null });
    let fetchArgv: readonly string[] | undefined;
    const hybrid: GitExecutor = {
      async run(argv, options) {
        if (argv.includes('fetch')) {
          fetchArgv = [...argv];
          return { argv, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false };
        }
        return localGit.run(argv, options);
      },
    };
    const result = await new SourceResolver({ repositoryPath: repository, git: hybrid, now: () => '2026-07-23T12:00:00.000Z' }).listBranches();
    expect(fetchArgv).toEqual(['-c', 'core.hooksPath=/dev/null', 'fetch', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', ORIGIN, CANONICAL_FETCH_REFSPEC]);
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0]).toMatchObject({ name: 'main', sha, subject: 'real framing subject' });
    const metadata = await new SourceResolver({ repositoryPath: repository, git: hybrid }).resolveAtAcceptance('main', sha);
    expect(metadata).toMatchObject({ sha, author: 'Real Author <real@example.test>', ref: 'refs/remotes/origin/main' });
    await expect(new SourceResolver({ repositoryPath: repository, git: hybrid }).resolveAtAcceptance('alias', sha)).rejects.toMatchObject({ code: 'SOURCE_NOT_COMMIT' });
  });

  it('rejects effective worktree transport overrides before runtime fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-worktree-config-'));
    temporaryDirectories.push(directory);
    const repository = join(directory, 'repo');
    await mkdir(repository);
    await execFile('/usr/bin/git', ['init', '--quiet', repository]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', '--local', 'remote.origin.url', ORIGIN]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', '--local', 'remote.origin.fetch', CANONICAL_FETCH_REFSPEC]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', '--local', 'extensions.worktreeConfig', 'true']);
    for (const [key, value] of [
      ['url.ext::evil.insteadOf', 'git@github.com:rewritten/osi-os.git'],
      ['protocol.ext.allow', 'always'],
      ['core.sshCommand', 'ssh -i /secret/key'],
      ['remote.origin.fetch', 'refs/heads/main:refs/remotes/origin/main'],
    ]) {
      await execFile('/usr/bin/git', ['-C', repository, 'config', '--worktree', key, value]);
    }

    const localGit = new GitCommand({ sshAuthSock: null });
    let fetchCalls = 0;
    const hybrid: GitExecutor = {
      async run(argv, options) {
        if (argv[0] === 'fetch') {
          fetchCalls += 1;
          return { argv, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false };
        }
        return localGit.run(argv, options);
      },
    };

    await expect(new SourceResolver({ repositoryPath: repository, git: hybrid }).listBranches()).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
    expect(fetchCalls).toBe(0);
  });

  it('disables repository reference hooks for the hardened fetch command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-hook-'));
    temporaryDirectories.push(directory);
    const remote = join(directory, 'remote.git');
    const seed = join(directory, 'seed');
    const repository = join(directory, 'repository');
    await execFile('/usr/bin/git', ['init', '--quiet', '--bare', remote]);
    await execFile('/usr/bin/git', ['init', '--quiet', seed]);
    await execFile('/usr/bin/git', ['-C', seed, 'config', 'user.name', 'Hook Test']);
    await execFile('/usr/bin/git', ['-C', seed, 'config', 'user.email', 'hook@example.test']);
    await writeFile(join(seed, 'README'), 'first\n');
    await execFile('/usr/bin/git', ['-C', seed, 'add', 'README']);
    await execFile('/usr/bin/git', ['-C', seed, 'commit', '--quiet', '-m', 'first']);
    await execFile('/usr/bin/git', ['-C', seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main']);
    await execFile('/usr/bin/git', ['init', '--quiet', repository]);
    const marker = join(directory, 'hook-marker');
    const hook = join(repository, '.git', 'hooks', 'reference-transaction');
    await writeFile(hook, `#!/bin/sh\nprintf invoked > ${marker}\n`);
    await chmod(hook, 0o755);

    const fetchArgs = ['fetch', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', remote, CANONICAL_FETCH_REFSPEC];
    const fetchEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    await execFile('/usr/bin/git', fetchArgs, { cwd: repository, env: fetchEnv });
    expect((await lstat(marker)).isFile()).toBe(true);
    await rm(marker, { force: true });
    await writeFile(join(seed, 'README'), 'second\n');
    await execFile('/usr/bin/git', ['-C', seed, 'add', 'README']);
    await execFile('/usr/bin/git', ['-C', seed, 'commit', '--quiet', '-m', 'second']);
    await execFile('/usr/bin/git', ['-C', seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main']);

    await execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...fetchArgs], { cwd: repository, env: fetchEnv });
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs SourceResolver through GitCommand with an existing configured hooks path and leaves no marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-source-hook-'));
    temporaryDirectories.push(directory);
    const remote = join(directory, 'remote.git');
    const seed = join(directory, 'seed');
    const repository = join(directory, 'repository');
    await execFile('/usr/bin/git', ['init', '--quiet', '--bare', remote]);
    await execFile('/usr/bin/git', ['init', '--quiet', seed]);
    await execFile('/usr/bin/git', ['-C', seed, 'config', 'user.name', 'Hook Test']);
    await execFile('/usr/bin/git', ['-C', seed, 'config', 'user.email', 'hook@example.test']);
    await writeFile(join(seed, 'README'), 'first\n');
    await execFile('/usr/bin/git', ['-C', seed, 'add', 'README']);
    await execFile('/usr/bin/git', ['-C', seed, 'commit', '--quiet', '-m', 'first']);
    await execFile('/usr/bin/git', ['-C', seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main']);
    await execFile('/usr/bin/git', ['init', '--quiet', repository]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.url', ORIGIN]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.fetch', CANONICAL_FETCH_REFSPEC]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'core.hooksPath', join(repository, '.git', 'hooks')]);
    const marker = join(directory, 'source-hook-marker');
    const hook = join(repository, '.git', 'hooks', 'reference-transaction');
    await writeFile(hook, `#!/bin/sh\nprintf invoked > ${marker}\n`);
    await chmod(hook, 0o755);

    await writeFile(join(seed, 'README'), 'second\n');
    await execFile('/usr/bin/git', ['-C', seed, 'add', 'README']);
    await execFile('/usr/bin/git', ['-C', seed, 'commit', '--quiet', '-m', 'second']);
    await execFile('/usr/bin/git', ['-C', seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main']);

    const command = new GitCommand({
      sshAuthSock: null,
      execFile: async (executable, argv, options) => {
        const translatedArgv = argv.map((argument) => argument === ORIGIN ? remote : argument);
        const translatedEnv = { ...(options.env as Record<string, string>), GIT_ALLOW_PROTOCOL: 'ssh:file' };
        const result = await execFile(executable, translatedArgv, { ...options, env: translatedEnv });
        return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0, signal: null };
      },
    });
    const result = await new SourceResolver({ repositoryPath: repository, git: command }).listBranches();
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0]?.name).toBe('main');
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects configured hook commands before fetch and leaves the marker untouched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-configured-hook-'));
    temporaryDirectories.push(directory);
    const repository = join(directory, 'repository');
    await execFile('/usr/bin/git', ['init', '--quiet', repository]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.url', ORIGIN]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.fetch', CANONICAL_FETCH_REFSPEC]);
    const marker = join(directory, 'configured-hook-marker');
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'hook.reference-transaction.command', `printf invoked > ${marker}`]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'hook.reference-transaction.event', 'prepared']);
    const calls: string[][] = [];
    const command = new GitCommand({
      sshAuthSock: null,
      execFile: async (executable, argv, options) => {
        calls.push([...argv]);
        const result = await execFile(executable, [...argv], options as Parameters<typeof execFile>[2]);
        return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0, signal: null };
      },
    });

    await expect(new SourceResolver({ repositoryPath: repository, git: command }).listBranches()).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
    expect(calls.some((argv) => argv.includes('fetch'))).toBe(false);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores replacement refs for metadata, object type, tree, and source resolution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-replace-'));
    temporaryDirectories.push(directory);
    const repository = join(directory, 'repository');
    await mkdir(repository);
    await execFile('/usr/bin/git', ['init', '--quiet', repository]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Replace Test']);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'replace@example.test']);
    await writeFile(join(repository, 'README'), 'pinned source\n');
    await execFile('/usr/bin/git', ['-C', repository, 'add', 'README']);
    await execFile('/usr/bin/git', ['-C', repository, 'commit', '--quiet', '-m', 'pinned source']);
    const pinnedSha = (await execFile('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repository, 'README'), 'replacement source\n');
    await execFile('/usr/bin/git', ['-C', repository, 'add', 'README']);
    await execFile('/usr/bin/git', ['-C', repository, 'commit', '--quiet', '-m', 'replacement source']);
    const replacementSha = (await execFile('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await execFile('/usr/bin/git', ['-C', repository, 'replace', pinnedSha, replacementSha]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.url', ORIGIN]);
    await execFile('/usr/bin/git', ['-C', repository, 'config', 'remote.origin.fetch', CANONICAL_FETCH_REFSPEC]);
    await execFile('/usr/bin/git', ['-C', repository, 'update-ref', 'refs/remotes/origin/main', pinnedSha]);

    const rawEnv = { ...process.env };
    delete rawEnv.GIT_NO_REPLACE_OBJECTS;
    const replaced = await execFile('/usr/bin/git', ['-C', repository, 'show', '--no-patch', '--format=%H%x00%s%x00', pinnedSha], { env: rawEnv });
    expect(replaced.stdout).toContain(`${pinnedSha}\0replacement source\0`);

    const localGit = new GitCommand({ sshAuthSock: null });
    const fixedMetadata = await localGit.run(['show', '--no-patch', '--format=%H%x00%s%x00', pinnedSha], { cwd: repository });
    const fixedType = await localGit.run(['cat-file', '-t', pinnedSha], { cwd: repository });
    const fixedTree = await localGit.run(['rev-parse', `${pinnedSha}^{tree}`], { cwd: repository });
    expect(fixedMetadata.stdout).toContain(`${pinnedSha}\0pinned source\0`);
    expect(fixedType.stdout.trim()).toBe('commit');

    const hybrid: GitExecutor = {
      async run(argv, options) {
        if (argv[0] === '-c') return { argv, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false };
        return localGit.run(argv, options);
      },
    };
    const result = await new SourceResolver({ repositoryPath: repository, git: hybrid }).listBranches();
    expect(result.branches).toEqual([{ name: 'main', sha: pinnedSha, commitTime: expect.any(String), subject: 'pinned source' }]);
    const replacedTree = (await execFile('/usr/bin/git', ['-C', repository, 'rev-parse', `${pinnedSha}^{tree}`], { env: rawEnv })).stdout.trim();
    expect(fixedTree.stdout.trim()).not.toBe(replacedTree);
  });
});
