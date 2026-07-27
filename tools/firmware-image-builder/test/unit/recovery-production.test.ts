import { createHash } from 'node:crypto';
import { access, chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, type LoadedConfig } from '../../config/load.js';
import { ADMISSION_ID_PATTERN } from '../../domain/types.js';
import { encodeJson } from '../../api/src/validation.js';
import type { CleanupPostcondition } from '../../api/src/ownership.js';
import { createRecoveryPhysicalVerification } from '../../api/src/recovery-production.js';

const JOB_ID = 'recovery-production-job';
const ADMISSION_ID = 'cln_0123456789abcdefghjkmnpqrs';
const ROOT_ID = 'images';
const OTHER_ROOT_ID = 'other-images';
const NOW = '2026-07-28T12:00:00.000Z';
const STALE = '2026-07-28T11:55:00.000Z';
const HASH64 = /^[0-9a-f]{64}$/u;

function postcondition(staging: CleanupPostcondition['staging'] = {
  kind: 'absent',
  path: null,
  sourcePath: `staging/${JOB_ID}`,
  sourceAbsent: true,
  verifiedAt: NOW,
}): CleanupPostcondition {
  return {
    runner: {
      unit: `osi-image-builder-runner@${JOB_ID}.service`,
      owner: 'runner',
      leaseExpiresAt: STALE,
      inactiveAt: NOW,
      observedAt: NOW,
    },
    state: 'building',
    container: {
      kind: 'null-identity',
      dockerAction: 'none',
      globalLabelResult: 'no-match',
      observedAt: NOW,
    },
    staging,
    logs: { runner: 'absent', docker: 'absent', verifiedAt: NOW },
    blocker: 'none',
  };
}

function completionEnvelope(condition = postcondition()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'cleanup-complete',
    admissionId: ADMISSION_ID,
    jobId: JOB_ID,
    postcondition: condition,
    observedAt: NOW,
  };
}

async function fixture(): Promise<{ readonly base: string; readonly loaded: LoadedConfig }> {
  const base = await mkdtemp(join(tmpdir(), 'osi-image-builder-recovery-production-'));
  const configHome = join(base, 'config-home');
  const stateHome = join(base, 'state-home');
  const repository = join(base, 'repository');
  const output = join(base, 'output');
  const otherOutput = join(base, 'other-output');
  const configRoot = join(configHome, 'osi-image-builder');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(repository, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  await mkdir(otherOutput, { mode: 0o700 });
  const configPath = join(configRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath: repository,
    approvedOutputRoots: [
      { id: ROOT_ID, label: 'Images', path: output },
      { id: OTHER_ROOT_ID, label: 'Other images', path: otherOutput },
    ],
    builderLockPath: '/opt/osi-image-builder/v2026.07.28/builder.lock.json',
  }), { mode: 0o600 });
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    git: { getOriginPolicy: async () => ({ url: 'git@example.com:osi/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
  });
  return { base, loaded };
}

async function writeCompletion(loaded: LoadedConfig, value: Record<string, unknown>, name = `${ADMISSION_ID}.complete.json`): Promise<{ readonly path: string; readonly sha256: string; readonly absolutePath: string }> {
  const directory = join(loaded.stateRoot, 'jobs', JOB_ID, 'evidence', 'cleanup');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${encodeJson(value, 'completion evidence', true)}\n`, 'utf8');
  const path = join(directory, name);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path: `jobs/${JOB_ID}/evidence/cleanup/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), absolutePath: path };
}

async function writeRawCompletion(loaded: LoadedConfig, bytes: Buffer, name = `${ADMISSION_ID}.complete.json`): Promise<{ readonly path: string; readonly sha256: string; readonly absolutePath: string }> {
  const directory = join(loaded.stateRoot, 'jobs', JOB_ID, 'evidence', 'cleanup');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const absolutePath = join(directory, name);
  await writeFile(absolutePath, bytes, { mode: 0o600 });
  return { path: `jobs/${JOB_ID}/evidence/cleanup/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), absolutePath };
}

async function setupOutput(loaded: LoadedConfig, rootId = ROOT_ID): Promise<string> {
  const output = loaded.config.approvedOutputRoots.find((root) => root.id === rootId)!.path;
  await mkdir(join(output, '.osi-image-builder', 'staging'), { recursive: true, mode: 0o700 });
  await mkdir(join(output, '.osi-image-builder', 'quarantine'), { recursive: true, mode: 0o700 });
  return output;
}

function quarantinedPostcondition(sha256: string | null = null, size: number | null = null): CleanupPostcondition['staging'] {
  return {
    kind: 'quarantined',
    sourcePath: `staging/${JOB_ID}`,
    destinationPath: `quarantine/${JOB_ID}`,
    sourceAbsent: true,
    destinationPresent: true,
    sha256,
    size,
    verifiedAt: NOW,
  };
}

function createFactory(loaded: LoadedConfig) {
  return createRecoveryPhysicalVerification({
    stateRootAuthority: loaded.pathAuthorities.stateRoot,
    approvedRootRegistry: loaded.pathAuthorities.approvedRoots,
    ownerUid: process.getuid?.() ?? 0,
  });
}

function stagingInput(staging: CleanupPostcondition['staging'], overrides: Partial<{
  readonly rootId: string;
  readonly artifactStagingPath: string | null;
  readonly artifactSha256: string | null;
  readonly artifactSize: number | null;
}> = {}) {
  return {
    jobId: JOB_ID,
    admissionId: ADMISSION_ID,
    rootId: overrides.rootId ?? ROOT_ID,
    artifactStagingPath: overrides.artifactStagingPath ?? null,
    artifactSha256: overrides.artifactSha256 ?? null,
    artifactSize: overrides.artifactSize ?? null,
    postcondition: staging,
  } as const;
}

describe('production recovery physical verification', () => {
  it('reads a canonical completion envelope from the held state-root authority and hashes its actual bytes', async () => {
    expect(ADMISSION_ID_PATTERN.test(ADMISSION_ID)).toBe(true);
    const value = await fixture();
    try {
      const file = await writeCompletion(value.loaded, completionEnvelope());
      const physical = createFactory(value.loaded);

      await expect(physical.evidence.read({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        path: file.path,
        sha256: file.sha256,
      })).resolves.toMatchObject({
        jobId: JOB_ID,
        admissionId: ADMISSION_ID,
        sha256: file.sha256,
        postcondition: postcondition(),
      });
      await expect(readFile(join(value.loaded.stateRoot, file.path))).resolves.toBeTruthy();
      expect(file.sha256).toMatch(HASH64);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a path outside the fixed completion file, a wrong hash, and a non-canonical extra field', async () => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      const file = await writeCompletion(value.loaded, completionEnvelope());
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: `jobs/${JOB_ID}/evidence/cleanup/other.json`, sha256: file.sha256 })).rejects.toThrow(/fixed completion path/);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: 'a'.repeat(64) })).rejects.toThrow(/hash/);
      const extra = completionEnvelope() as Record<string, unknown>;
      extra.extra = true;
      const extraFile = await writeCompletion(value.loaded, extra);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: extraFile.path, sha256: extraFile.sha256 })).rejects.toThrow(/extra or missing fields/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects corrupt, non-canonical, and oversized evidence before returning a postcondition', async () => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      const corrupt = await writeRawCompletion(value.loaded, Buffer.from('{"kind":"cleanup-complete"}\n', 'utf8'));
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: corrupt.path, sha256: corrupt.sha256 })).rejects.toThrow(/identity|extra|missing/);
      await unlink(corrupt.absolutePath);
      const nonCanonical = Buffer.from('{"schemaVersion":1,"kind":"cleanup-complete","admissionId":"cln_0123456789abcdefghjkmnpqrs","jobId":"recovery-production-job","postcondition":{},"observedAt":"2026-07-28T12:00:00.000Z"}\n', 'utf8');
      const nonCanonicalFile = await writeRawCompletion(value.loaded, nonCanonical);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: nonCanonicalFile.path, sha256: nonCanonicalFile.sha256 })).rejects.toThrow(/canonical|postcondition/);
      await unlink(nonCanonicalFile.absolutePath);
      const oversized = await writeRawCompletion(value.loaded, Buffer.alloc(65_538, 0x20));
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: oversized.path, sha256: oversized.sha256 })).rejects.toThrow(/bounded read/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects evidence symlinks, hard links, and wrong file modes', async () => {
    const value = await fixture();
    try {
      const physical = createFactory(value.loaded);
      const first = await writeCompletion(value.loaded, completionEnvelope());
      const outside = join(value.base, 'outside-evidence.json');
      await writeFile(outside, await readFile(join(value.loaded.stateRoot, first.path)), { mode: 0o600 });
      await unlink(first.absolutePath);
      await symlink(outside, first.absolutePath);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: first.path, sha256: first.sha256 })).rejects.toThrow(/open recovery evidence|unsafe/);
      await unlink(first.absolutePath);
      const second = await writeCompletion(value.loaded, completionEnvelope());
      await link(second.absolutePath, join(value.loaded.stateRoot, 'hard-link-evidence.json'));
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: second.path, sha256: second.sha256 })).rejects.toThrow(/unsafe cleanup evidence/);
      await unlink(join(value.loaded.stateRoot, 'hard-link-evidence.json'));
      await chmod(second.absolutePath, 0o644);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: second.path, sha256: second.sha256 })).rejects.toThrow(/unsafe cleanup evidence/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects a state-root path swap instead of following the replacement', async () => {
    const value = await fixture();
    const replacement = `${value.loaded.stateRoot}.held`;
    try {
      const physical = createFactory(value.loaded);
      const file = await writeCompletion(value.loaded, completionEnvelope());
      await rename(value.loaded.stateRoot, replacement);
      await symlink('/tmp', value.loaded.stateRoot);
      await expect(physical.evidence.read({ jobId: JOB_ID, admissionId: ADMISSION_ID, path: file.path, sha256: file.sha256 })).rejects.toThrow(/state root|configured path authority/);
      await unlink(value.loaded.stateRoot);
      await rename(replacement, value.loaded.stateRoot);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('verifies an explicitly absent staging and quarantine pair without mutating it', async () => {
    const value = await fixture();
    try {
      const output = await setupOutput(value.loaded);
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(postcondition().staging))).resolves.toBe(true);
      await expect(physical.staging.verify(stagingInput(postcondition().staging, {
        artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
      }))).resolves.toBe(true);
      await expect(physical.staging.verify(stagingInput(postcondition().staging, {
        artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
        artifactSha256: 'a'.repeat(64),
        artifactSize: 1,
      }))).rejects.toThrow(/absent staging retains artifact identity/);
      await expect(access(join(output, '.osi-image-builder', 'staging'))).resolves.toBeUndefined();
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('verifies a tracked quarantined artifact by hash and size, selecting the root from each request', async () => {
    const value = await fixture();
    try {
      const output = await setupOutput(value.loaded);
      const artifact = Buffer.from('tracked artifact bytes\n', 'utf8');
      const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
      await mkdir(join(output, '.osi-image-builder', 'quarantine', JOB_ID), { mode: 0o700 });
      await writeFile(join(output, '.osi-image-builder', 'quarantine', JOB_ID, 'image.img.gz'), artifact, { mode: 0o600 });
      const physical = createFactory(value.loaded);
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(artifactSha256, artifact.byteLength), {
        artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
        artifactSha256,
        artifactSize: artifact.byteLength,
      }))).resolves.toBe(true);

      const otherOutput = await setupOutput(value.loaded, OTHER_ROOT_ID);
      await mkdir(join(otherOutput, '.osi-image-builder', 'quarantine', JOB_ID), { mode: 0o700 });
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(), { rootId: OTHER_ROOT_ID }))).resolves.toBe(true);

      await writeFile(join(output, '.osi-image-builder', 'quarantine', JOB_ID, 'image.img.gz'), Buffer.from('tampered\n'), { mode: 0o600 });
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition(artifactSha256, artifact.byteLength), {
        artifactStagingPath: `staging/${JOB_ID}/image.img.gz`,
        artifactSha256,
        artifactSize: artifact.byteLength,
      }))).rejects.toThrow(/hash|size/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects staging and quarantine ambiguity, symlinks, and unsafe modes', async () => {
    const value = await fixture();
    try {
      const output = await setupOutput(value.loaded);
      const physical = createFactory(value.loaded);
      const source = join(output, '.osi-image-builder', 'staging', JOB_ID);
      const destination = join(output, '.osi-image-builder', 'quarantine', JOB_ID);
      await mkdir(source, { mode: 0o700 });
      await mkdir(destination, { mode: 0o700 });
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition()))).rejects.toThrow(/source and destination state/);
      await rm(source, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
      await symlink('/tmp', destination);
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition()))).rejects.toThrow(/inspect recovery directory/);
      await unlink(destination);
      await mkdir(destination, { mode: 0o700 });
      await chmod(destination, 0o755);
      await expect(physical.staging.verify(stagingInput(quarantinedPostcondition()))).rejects.toThrow(/unsafe recovery directory/);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it('rejects an approved-root path swap and a postcondition with a non-fixed source path', async () => {
    const value = await fixture();
    const output = value.loaded.config.approvedOutputRoots[0]!.path;
    const replacement = `${output}.held`;
    try {
      await setupOutput(value.loaded);
      const physical = createFactory(value.loaded);
      const invalid = { ...postcondition().staging, sourcePath: 'staging/other-job' };
      await expect(physical.staging.verify(stagingInput(invalid))).rejects.toThrow(/invalid|fixed/);
      await rename(output, replacement);
      await symlink('/tmp', output);
      await expect(physical.staging.verify(stagingInput(postcondition().staging))).rejects.toThrow(/approved root|configured path authority/);
      await unlink(output);
      await rename(replacement, output);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });
});
