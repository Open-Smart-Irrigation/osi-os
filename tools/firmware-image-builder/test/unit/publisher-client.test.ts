import { describe, expect, it } from 'vitest';
import { createPublisherClient, type PublisherCommandExecutor } from '../../publisher/client.js';
import { createRunnerPublisherClient } from '../../runner/src/publisher-client.js';
import type { CommandResult, CommandRunOptions } from '../../runner/src/command-executor.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ROOT = '/tmp/osi-image-builder-images';

function result(stdout: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    argv: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    startedAt: '2026-07-24T10:00:00.000Z',
    finishedAt: '2026-07-24T10:00:01.000Z',
    ...overrides,
  };
}

function fakeExecutor(reply: CommandResult): PublisherCommandExecutor & { calls: string[][]; options: CommandRunOptions[] } {
  const calls: string[][] = [];
  const options: CommandRunOptions[] = [];
  return {
    calls,
    options,
    run: async (argv, runOptions) => {
      calls.push([...argv]);
      options.push(runOptions);
      return { ...reply, argv: [...argv] };
    },
  };
}

function client(executor: PublisherCommandExecutor) {
  return createPublisherClient({
    executable: '/opt/osi-image-builder/bin/osi-image-publish',
    approvedRoots: [{ id: 'images', label: 'Images', path: ROOT, quarantinePath: `${ROOT}/.osi-image-builder/quarantine` }],
    commandExecutor: executor,
  });
}

const request = {
  rootId: 'images',
  jobId: 'job-123',
  branchSlug: 'feature%2Fpublisher',
  sourceSha: SHA,
  targetId: 'rpi-5' as const,
};

describe('publisher client', () => {
  it('rejects arbitrary paths and unsafe publication components before invoking the helper', async () => {
    const executor = fakeExecutor(result('{"available":true,"published":true}'));
    const publisher = client(executor);
    await expect(publisher.publish({ ...request, rootId: ROOT })).rejects.toThrow(/approved root/i);
    await expect(publisher.publish({ ...request, jobId: '../escape' })).rejects.toThrow(/job/i);
    await expect(publisher.publish({ ...request, branchSlug: '../escape' })).rejects.toThrow(/branch/i);
    await expect(publisher.publish({ ...request, sourceSha: 'not-a-sha' })).rejects.toThrow(/sha/i);
    await expect(publisher.publish({ ...request, targetId: 'rpi-5/evil' as never })).rejects.toThrow(/target/i);
    expect(executor.calls).toHaveLength(0);
  });

  it('passes only the fixed validated argv and parses structured publication output', async () => {
    const executor = fakeExecutor(result(JSON.stringify({
      available: true,
      published: true,
      mutationCount: 1,
      sourceRelativePath: '.osi-image-builder/staging/job-123',
      destinationRelativePath: 'feature%2Fpublisher/0123456789abcdef0123456789abcdef01234567/rpi-5',
      renameResult: 'RENAME_NOREPLACE',
    })));
    const published = await client(executor).publish(request);
    expect(published).toMatchObject({ available: true, published: true, mutationCount: 1 });
    expect(executor.calls).toEqual([[
      '/opt/osi-image-builder/bin/osi-image-publish',
      'publish',
      '--root', ROOT,
      '--job-id', 'job-123',
      '--branch', 'feature%2Fpublisher',
      '--sha', SHA,
      '--target', 'rpi-5',
    ]]);
    expect(executor.options[0]?.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
  });

  it('returns typed unsupported capability without claiming publication', async () => {
    const executor = fakeExecutor(result(JSON.stringify({ available: false, published: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' })));
    const response = await client(executor).publish(request);
    expect(response).toMatchObject({ available: false, published: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' });
  });

  it('exposes quarantine and non-destructive recheck through fixed operations', async () => {
    const executor = fakeExecutor(result(JSON.stringify({ available: true, mutationCount: 1, quarantined: true })));
    const publisher = client(executor);
    await expect(publisher.quarantine(request)).resolves.toMatchObject({ quarantined: true });
    expect(executor.calls[0]).toEqual([
      '/opt/osi-image-builder/bin/osi-image-publish', 'quarantine', '--root', ROOT, '--job-id', 'job-123',
    ]);

    executor.run = async (argv, options) => {
      executor.calls.push([...argv]);
      executor.options.push(options);
      return { ...result(JSON.stringify({ available: true, destination: 'mismatched', staging: 'present', mutationCount: 0 })), argv: [...argv] };
    };
    await expect(publisher.recheck(request)).resolves.toMatchObject({ destination: 'mismatched', staging: 'present', mutationCount: 0 });
    expect(executor.calls[1]).toEqual([
      '/opt/osi-image-builder/bin/osi-image-publish', 'recheck', '--root', ROOT, '--job-id', 'job-123',
      '--branch', 'feature%2Fpublisher', '--sha', SHA, '--target', 'rpi-5',
    ]);
  });

  it('keeps the runner adapter on the same production client contract', async () => {
    const executor = fakeExecutor(result(JSON.stringify({ available: true, published: true, mutationCount: 1 })));
    const published = await createRunnerPublisherClient({
      executable: '/opt/osi-image-builder/bin/osi-image-publish',
      approvedRoots: [{ id: 'images', label: 'Images', path: ROOT, quarantinePath: `${ROOT}/.osi-image-builder/quarantine` }],
      commandExecutor: executor,
    }).publish(request);
    expect(published).toMatchObject({ available: true, published: true });
  });
});
