import { describe, expect, it } from 'vitest';
import {
  PUBLISHER_OPERATION_ERROR_CODES,
  createPublisherClient,
  type PublisherCommandExecutor,
} from '../../publisher/client.js';
import { BUILDER_ERROR_CODES } from '../../domain/types.js';
import { createRunnerPublisherClient } from '../../runner/src/publisher-client.js';
import type { CommandResult, CommandRunOptions } from '../../runner/src/command-executor.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ROOT = '/tmp/osi-image-builder-images';
const VERSION = '0.1.0';
const SOURCE_HASH = 'a'.repeat(64);

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
      return { ...reply, argv: reply.argv.length > 0 ? [...reply.argv] : [...argv] };
    },
  };
}

function validPublishOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    available: true,
    published: true,
    quarantined: false,
    selfTest: false,
    mutationCount: 1,
    publisherVersion: VERSION,
    publisherSourceSha256: SOURCE_HASH,
    sourceRelativePath: '.osi-image-builder/staging/job-123',
    destinationRelativePath: 'feature%2Fpublisher/0123456789abcdef0123456789abcdef01234567/rpi-5',
    renameResult: 'RENAMED',
    ...overrides,
  });
}

function client(executor: PublisherCommandExecutor) {
  return createPublisherClient({
    executable: '/opt/osi-image-builder/bin/osi-image-publish',
    approvedRoots: [{ id: 'images', label: 'Images', path: ROOT, quarantinePath: `${ROOT}/.osi-image-builder/quarantine` }],
    expectedVersion: VERSION,
    expectedSourceSha256: SOURCE_HASH,
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
  it('binds publisher version evidence to installed package authority', async () => {
    const installedVersion = '2026.07.27.1';
    const executor = fakeExecutor(result(validPublishOutput({
      publisherVersion: installedVersion,
    })));
    const publisher = createPublisherClient({
      executable: '/opt/osi-image-builder/bin/osi-image-publish',
      approvedRoots: [{
        id: 'images',
        label: 'Images',
        path: ROOT,
        quarantinePath: `${ROOT}/.osi-image-builder/quarantine`,
      }],
      expectedVersion: installedVersion,
      expectedSourceSha256: SOURCE_HASH,
      commandExecutor: executor,
    });

    await expect(publisher.publish(request)).resolves.toMatchObject({
      publisherVersion: installedVersion,
    });
  });

  it('rejects a publisher result from bytes other than the held lock authority', async () => {
    const executor = fakeExecutor(result(validPublishOutput({
      publisherSourceSha256: 'b'.repeat(64),
    })));

    await expect(client(executor).publish(request)).rejects.toThrow(
      /publisher source hash evidence/i,
    );
  });

  it('rejects arbitrary paths and unsafe publication components before invoking the helper', async () => {
    const executor = fakeExecutor(result(validPublishOutput()));
    const publisher = client(executor);
    await expect(publisher.publish({ ...request, rootId: ROOT })).rejects.toThrow(/approved root/i);
    await expect(publisher.publish({ ...request, jobId: '../escape' })).rejects.toThrow(/job/i);
    await expect(publisher.publish({ ...request, branchSlug: '../escape' })).rejects.toThrow(/branch/i);
    await expect(publisher.publish({ ...request, branchSlug: '.' })).rejects.toThrow(/branch/i);
    await expect(publisher.publish({ ...request, branchSlug: '..' })).rejects.toThrow(/branch/i);
    await expect(publisher.publish({ ...request, branchSlug: 'a'.repeat(256) })).rejects.toThrow(/branch/i);
    await expect(publisher.publish({ ...request, sourceSha: 'not-a-sha' })).rejects.toThrow(/sha/i);
    await expect(publisher.publish({ ...request, targetId: 'rpi-5/evil' as never })).rejects.toThrow(/target/i);
    expect(executor.calls).toHaveLength(0);
    executor.run = async (argv, options) => {
      executor.calls.push([...argv]);
      executor.options.push(options);
      const jobId = argv[argv.indexOf('--job-id') + 1]!;
      const branchSlug = argv[argv.indexOf('--branch') + 1]!;
      return {
        ...result(validPublishOutput({
          sourceRelativePath: `.osi-image-builder/staging/${jobId}`,
          destinationRelativePath: `${branchSlug}/${SHA}/rpi-5`,
        })),
        argv: [...argv],
      };
    };
    await expect(publisher.publish({ ...request, branchSlug: '%C3%A9-main' })).resolves.toMatchObject({ published: true });
    await expect(publisher.publish({ ...request, jobId: `j${'a'.repeat(127)}` })).resolves.toMatchObject({ published: true });
  });

  it('passes only the fixed validated argv and parses structured publication output', async () => {
    const executor = fakeExecutor(result(validPublishOutput()));
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
    const executor = fakeExecutor(result(JSON.stringify({ available: false, published: false, quarantined: false, selfTest: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' }), { exitCode: 2 }));
    const response = await client(executor).publish(request);
    expect(response).toMatchObject({ available: false, published: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' });
  });

  it('exposes quarantine and non-destructive recheck through fixed operations', async () => {
    const executor = fakeExecutor(result(JSON.stringify({
      available: true,
      published: false,
      quarantined: true,
      selfTest: false,
      mutationCount: 1,
      publisherVersion: VERSION,
      publisherSourceSha256: SOURCE_HASH,
      sourceRelativePath: '.osi-image-builder/staging/job-123',
      destinationRelativePath: '.osi-image-builder/quarantine/job-123',
      renameResult: 'RENAMED',
    })));
    const publisher = client(executor);
    await expect(publisher.quarantine(request)).resolves.toMatchObject({ quarantined: true });
    expect(executor.calls[0]).toEqual([
      '/opt/osi-image-builder/bin/osi-image-publish', 'quarantine', '--root', ROOT, '--job-id', 'job-123',
    ]);

    executor.run = async (argv, options) => {
      executor.calls.push([...argv]);
      executor.options.push(options);
      return { ...result(JSON.stringify({ available: true, published: false, quarantined: false, selfTest: false, destination: 'mismatched', staging: 'present', mutationCount: 0, errorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER' })), argv: [...argv] };
    };
    await expect(publisher.recheck(request)).resolves.toMatchObject({ destination: 'mismatched', staging: 'present', mutationCount: 0 });
    expect(executor.calls[1]).toEqual([
      '/opt/osi-image-builder/bin/osi-image-publish', 'recheck', '--root', ROOT, '--job-id', 'job-123',
      '--branch', 'feature%2Fpublisher', '--sha', SHA, '--target', 'rpi-5',
    ]);
  });

  it('keeps the runner adapter on the same production client contract', async () => {
    const executor = fakeExecutor(result(validPublishOutput()));
    const published = await createRunnerPublisherClient({
      executable: '/opt/osi-image-builder/bin/osi-image-publish',
      approvedRoots: [{ id: 'images', label: 'Images', path: ROOT, quarantinePath: `${ROOT}/.osi-image-builder/quarantine` }],
      expectedVersion: VERSION,
      expectedSourceSha256: SOURCE_HASH,
      commandExecutor: executor,
    }).publish(request);
    expect(published).toMatchObject({ available: true, published: true });
  });

  it('rejects duplicate roots and contradictory or incomplete helper results', async () => {
    const root = { id: 'images', label: 'Images', path: ROOT, quarantinePath: `${ROOT}/.osi-image-builder/quarantine` };
    expect(() => createPublisherClient({ executable: '/opt/osi-image-builder/bin/osi-image-publish', approvedRoots: [root, root], expectedVersion: VERSION, expectedSourceSha256: SOURCE_HASH, commandExecutor: fakeExecutor(result(validPublishOutput())) })).toThrow(/duplicate/i);

    const cases = [
      result(validPublishOutput({ extra: true })),
      result(validPublishOutput(), { argv: ['wrong'], }),
      result(validPublishOutput(), { signal: 'SIGTERM' }),
      result(validPublishOutput(), { timedOut: true }),
      result(JSON.stringify({ available: false, published: false, quarantined: false, selfTest: false, mutationCount: 1, errorCode: 'PUBLISHER_UNSUPPORTED' })),
      result(JSON.stringify({ available: false, published: false, quarantined: false, selfTest: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' })),
      result(JSON.stringify({ available: false, published: false, quarantined: false, selfTest: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' }), { exitCode: 99 }),
      result(JSON.stringify({ available: true, published: true, quarantined: false, selfTest: false, mutationCount: 1, renameResult: 'RENAMED' })),
    ];
    for (const reply of cases) await expect(client(fakeExecutor(reply)).publish(request)).rejects.toThrow();
  });

  it('accepts only exact publish phase, mutation, evidence, and exit combinations', async () => {
    const failedBeforeRename = JSON.stringify({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 0,
      errorCode: 'OUTPUT_COLLISION',
      publisherVersion: VERSION,
      publisherSourceSha256: SOURCE_HASH,
      sourceRelativePath: '.osi-image-builder/staging/job-123',
      destinationRelativePath: 'feature%2Fpublisher/0123456789abcdef0123456789abcdef01234567/rpi-5',
      renameResult: 'EEXIST',
    });
    await expect(client(fakeExecutor(result(failedBeforeRename, { exitCode: 2 }))).publish(request))
      .resolves.toMatchObject({ published: false, mutationCount: 0, errorCode: 'OUTPUT_COLLISION' });

    const failedAfterRename = validPublishOutput({
      published: false,
      errorCode: 'PUBLISH_FAILED',
    });
    await expect(client(fakeExecutor(result(failedAfterRename, { exitCode: 2 }))).publish(request))
      .resolves.toMatchObject({ published: false, mutationCount: 1, errorCode: 'PUBLISH_FAILED' });

    const contradictory = [
      result(failedBeforeRename),
      result(failedBeforeRename, { exitCode: 99 }),
      result(JSON.stringify({ ...JSON.parse(failedBeforeRename), renameResult: 'RENAMED' }), { exitCode: 2 }),
      result(validPublishOutput({ published: false, errorCode: 'OUTPUT_COLLISION' }), { exitCode: 2 }),
      result(validPublishOutput({ published: false, errorCode: 'PUBLISH_FAILED' })),
    ];
    for (const reply of contradictory) await expect(client(fakeExecutor(reply)).publish(request)).rejects.toThrow();
  });

  it('accepts only exact quarantine and recheck phase results', async () => {
    const quarantineFailure = JSON.stringify({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 0,
      errorCode: 'QUARANTINE_PENDING',
      publisherVersion: VERSION,
      publisherSourceSha256: SOURCE_HASH,
      sourceRelativePath: '.osi-image-builder/staging/job-123',
      destinationRelativePath: '.osi-image-builder/quarantine/job-123',
    });
    await expect(client(fakeExecutor(result(quarantineFailure, { exitCode: 2 }))).quarantine(request))
      .resolves.toMatchObject({ quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING' });

    const quarantineAfterRename = JSON.stringify({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 1,
      errorCode: 'QUARANTINE_PENDING',
      publisherVersion: VERSION,
      publisherSourceSha256: SOURCE_HASH,
      sourceRelativePath: '.osi-image-builder/staging/job-123',
      destinationRelativePath: '.osi-image-builder/quarantine/job-123',
      renameResult: 'RENAMED',
    });
    await expect(client(fakeExecutor(result(quarantineAfterRename, { exitCode: 2 }))).quarantine(request))
      .resolves.toMatchObject({ quarantined: false, mutationCount: 1, errorCode: 'QUARANTINE_PENDING' });

    const recheckComplete = JSON.stringify({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 0,
      destination: 'candidate',
      staging: 'absent',
    });
    await expect(client(fakeExecutor(result(recheckComplete))).recheck(request))
      .resolves.toMatchObject({ destination: 'candidate', staging: 'absent' });

    const recheckFailed = JSON.stringify({
      available: true,
      published: false,
      quarantined: false,
      selfTest: false,
      mutationCount: 0,
      destination: 'unknown',
      staging: 'unknown',
      errorCode: 'PUBLISH_RECOVERY_FAILED',
    });
    await expect(client(fakeExecutor(result(recheckFailed, { exitCode: 2 }))).recheck(request))
      .resolves.toMatchObject({ destination: 'unknown', staging: 'unknown', errorCode: 'PUBLISH_RECOVERY_FAILED' });

    const contradictoryQuarantine = [
      result(quarantineFailure),
      result(quarantineFailure, { exitCode: 99 }),
      result(JSON.stringify({ ...JSON.parse(quarantineFailure), mutationCount: 3 }), { exitCode: 2 }),
      result(JSON.stringify({ ...JSON.parse(quarantineFailure), errorCode: 'PUBLISH_FAILED' }), { exitCode: 2 }),
      result(quarantineAfterRename),
      result(JSON.stringify({ ...JSON.parse(quarantineAfterRename), errorCode: 'PUBLISH_FAILED' }), { exitCode: 2 }),
    ];
    for (const reply of contradictoryQuarantine) await expect(client(fakeExecutor(reply)).quarantine(request)).rejects.toThrow();

    const contradictoryRecheck = [
      result(recheckComplete, { exitCode: 2 }),
      result(JSON.stringify({ ...JSON.parse(recheckComplete), staging: 'present' })),
      result(JSON.stringify({ ...JSON.parse(recheckComplete), destination: 'absent' })),
      result(JSON.stringify({ ...JSON.parse(recheckComplete), destination: 'mismatched' })),
      result(recheckFailed),
    ];
    for (const reply of contradictoryRecheck) await expect(client(fakeExecutor(reply)).recheck(request)).rejects.toThrow();
  });

  it('limits operational publisher errors to the persisted builder taxonomy', () => {
    const builderCodes = new Set<string>(BUILDER_ERROR_CODES);
    expect(PUBLISHER_OPERATION_ERROR_CODES.every((code) => builderCodes.has(code))).toBe(true);
  });
});
