import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, readlink, rename, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';
import { PIPELINE_STAGE_NAMES, type PipelineStageName } from '../../domain/types.js';
import { createIndexedEvidenceReader, EvidenceReadError, type EvidenceIndex } from '../../api/src/evidence-reader.js';

const temporaryDirectories: string[] = [];
const JOB_ID = 'job-reader-1';
const STAGE: PipelineStageName = 'source';

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function authorityFixture(pathAuthorityDependencies?: Partial<PathAuthorityDependencies>) {
  const base = await mkdtemp(join(tmpdir(), 'osi-image-builder-evidence-reader-'));
  temporaryDirectories.push(base);
  const configHome = join(base, 'config');
  const repositoryPath = join(base, 'repository');
  const outputRoot = join(base, 'images');
  await mkdir(configHome, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const configPath = join(configHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{ id: 'images', label: 'images', path: outputRoot }],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(base, 'state-home') },
    git: { getOriginPolicy: async () => ({ url: 'git@github.com:Open-Smart-Irrigation/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    pathAuthorityDependencies,
  });
  return { stateRoot: loaded.pathAuthorities.stateRoot, statePath: loaded.stateRoot };
}

function evidencePath(jobId = JOB_ID, stage: PipelineStageName = STAGE): string {
  const index = PIPELINE_STAGE_NAMES.indexOf(stage);
  return `jobs/${jobId}/evidence/${String(index).padStart(2, '0')}-${stage}.json`;
}

function indexFor(bytes: Buffer, jobId = JOB_ID, stage: PipelineStageName = STAGE): EvidenceIndex {
  return { jobId, stage, path: evidencePath(jobId, stage), sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function prepareEvidence(statePath: string, bytes = Buffer.from('{"ok":true}')) {
  const evidenceDirectory = join(statePath, 'jobs', JOB_ID, 'evidence');
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(statePath, 'jobs'), 0o700);
  await chmod(join(statePath, 'jobs', JOB_ID), 0o700);
  await chmod(evidenceDirectory, 0o700);
  const filePath = join(evidenceDirectory, '01-source.json');
  await writeFile(filePath, bytes, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return { filePath, bytes, index: indexFor(bytes) };
}

async function expectCode(operation: Promise<unknown>, code: EvidenceReadError['code']): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: 'EvidenceReadError', code });
}

describe('indexed evidence reader', () => {
  it('reads the exact indexed evidence file and returns its JSON object', async () => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath);

    await expect(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index)).resolves.toEqual({ ok: true });
  });

  const invalidIndexes: ReadonlyArray<readonly [string, (index: EvidenceIndex) => EvidenceIndex, EvidenceReadError['code']]> = [
    ['path', (index: EvidenceIndex) => ({ ...index, path: 'jobs/job-reader-1/evidence/00-preflight.json' }), 'INDEX_INVALID'],
    ['job', (index: EvidenceIndex) => ({ ...index, jobId: 'job-other' }), 'INDEX_INVALID'],
    ['stage', (index: EvidenceIndex) => ({ ...index, stage: 'verify' as PipelineStageName }), 'INDEX_INVALID'],
    ['digest', (index: EvidenceIndex) => ({ ...index, sha256: 'a'.repeat(64) }), 'DIGEST_MISMATCH'],
  ];

  it.each(invalidIndexes)('rejects an index with the wrong %s binding', async (_label, mutate, expectedCode) => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath);
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(mutate(prepared.index)), expectedCode);
  });

  it('rejects symlinked final files and ancestors', async () => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath);
    const outside = await mkdtemp(join(tmpdir(), 'osi-image-builder-evidence-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'evidence.json'), prepared.bytes, { mode: 0o600 });
    await rm(prepared.filePath);
    await symlink(join(outside, 'evidence.json'), prepared.filePath);
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'PATH_UNSAFE');

    await rm(prepared.filePath);
    await rm(join(fixture.statePath, 'jobs'), { recursive: true });
    await symlink(outside, join(fixture.statePath, 'jobs'));
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'PATH_UNSAFE');
  });

  it('rejects a hardlinked evidence file', async () => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath);
    await link(prepared.filePath, `${prepared.filePath}.link`);
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'FILE_UNSAFE');
  });

  it('enforces the injected owner and exact modes', async () => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath);
    const ownerUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot, ownerUid: ownerUid + 1 }).read(prepared.index), 'PATH_UNSAFE');

    await chmod(join(fixture.statePath, 'jobs', JOB_ID), 0o750);
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'PATH_UNSAFE');
    await chmod(join(fixture.statePath, 'jobs', JOB_ID), 0o700);
    await chmod(prepared.filePath, 0o640);
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'FILE_UNSAFE');
  });

  it.each([
    ['oversize', Buffer.alloc(65_537, 0x20), undefined, 'SIZE_INVALID'],
    ['empty', Buffer.alloc(0), undefined, 'SIZE_INVALID'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), undefined, 'UTF8_INVALID'],
    ['invalid JSON', Buffer.from('{not-json}'), undefined, 'JSON_INVALID'],
  ] as const)('rejects %s evidence', async (_label, bytes, maxBytes, code) => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath, bytes);
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot, ...(maxBytes === undefined ? {} : { maxBytes }) }).read(prepared.index), code);
  });

  it('honors a lower configured byte limit', async () => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath, Buffer.from('{"ok":true}'));
    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot, maxBytes: 4 }).read(prepared.index), 'SIZE_INVALID');
  });

  it('rejects replacement of the named file during the beforeRead hook', async () => {
    let armed = false;
    let raced = false;
    let canonicalPath = '';
    const fixture = await authorityFixture({
      beforeRead: async (handle) => {
        if (!armed || raced) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith('/01-source.json')) return;
        raced = true;
        await rename(canonicalPath, `${canonicalPath}.held`);
        await writeFile(canonicalPath, '{"replacement":true}', { mode: 0o600 });
      },
    });
    const prepared = await prepareEvidence(fixture.statePath);
    canonicalPath = prepared.filePath;
    armed = true;

    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'RACE_DETECTED');
    expect(raced).toBe(true);
  });

  it('rejects same-size in-place mutation during the beforeRead hook', async () => {
    let armed = false;
    let raced = false;
    const fixture = await authorityFixture({
      beforeRead: async (handle) => {
        if (!armed || raced) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith('/01-source.json')) return;
        raced = true;
        const writable = await open(`/proc/self/fd/${handle.fd}`, fsConstants.O_WRONLY);
        try { await writable.write(Buffer.from('{"no":false}'), 0, 11, 0); } finally { await writable.close(); }
      },
    });
    const prepared = await prepareEvidence(fixture.statePath, Buffer.from('{"no":false}'));
    armed = true;

    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'RACE_DETECTED');
    expect(raced).toBe(true);
  });

  it('closes every descriptor when a read fails', async () => {
    const fixture = await authorityFixture();
    const prepared = await prepareEvidence(fixture.statePath, Buffer.from('{bad}'));
    const before = new Set(await readdir('/proc/self/fd'));

    await expectCode(createIndexedEvidenceReader({ stateRoot: fixture.stateRoot }).read(prepared.index), 'JSON_INVALID');

    expect(new Set(await readdir('/proc/self/fd'))).toEqual(before);
  });
});
