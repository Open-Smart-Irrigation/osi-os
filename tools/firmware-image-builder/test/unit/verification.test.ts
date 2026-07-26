import { describe, expect, it } from 'vitest';

import type { StateRootAuthority } from '../../config/load.js';
import { loadManifest } from '../../manifest/validate.js';
import {
  verifyFirmwareArtifact,
  type VerificationInput,
  type WorkspaceAuthority,
} from '../../runner/src/verification.js';

const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = '0'.repeat(64);
const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;

function inputFor(targetId: 'rpi-5' | 'rpi-2'): VerificationInput {
  const target = manifest.targets.find((candidate) => candidate.id === targetId)!;
  const workspace = {
    stateRoot: Object.freeze({}) as StateRootAuthority,
    jobId: 'job-verify',
  } satisfies WorkspaceAuthority;
  const profiles = Object.fromEntries(manifest.targets.map((profile) => [profile.id, {
    target: profile.id,
    environment: profile.environment,
    selectedTarget: profile.openwrtTarget,
    profile: profile.profile,
    rootfsPartSize: profile.rootfsPartSize,
    sourceSha256: SHA256,
    sourceConfigEvidencePath: `evidence/target-setup/${profile.id}.source.config`,
    resolvedSha256: SHA256,
  }])) as VerificationInput['config']['profiles'];
  return {
    workspace,
    target,
    targets: manifest.targets,
    buildStartedAt: '2026-07-26T10:00:00.000Z',
    sourceEvidence: {
      targetId,
      openwrtTarget: target.openwrtTarget,
      targetOutputAbsent: true,
      checkedTargetOutputPath: `openwrt/bin/targets/${target.openwrtTarget}/`,
    },
    config: {
      selectedTarget: target.openwrtTarget,
      profile: target.profile,
      rootfsPartSize: target.rootfsPartSize,
      bothProfilesChecked: true,
      profiles,
    },
    pinnedSha: SHA40,
    branch: 'main',
    nodeVerifier: {
      resolve: async () => {
        throw new Error('must not be reached by pre-authority unit tests');
      },
    },
    freshness: {
      client: {
        signal: async () => {
          throw new Error('must not be reached by pre-authority unit tests');
        },
      },
      store: {
        getJob: () => {
          throw new Error('must not be reached by pre-authority unit tests');
        },
      },
    },
  };
}

describe('firmware verification public authority contract', () => {
  it.each(['rpi-5', 'rpi-2'] as const)(
    'derives %s filesystem paths from one job workspace authority',
    (targetId) => {
      const input = inputFor(targetId);
      expect(Object.keys(input).sort()).toEqual([
        'branch',
        'buildStartedAt',
        'config',
        'freshness',
        'nodeVerifier',
        'pinnedSha',
        'sourceEvidence',
        'target',
        'targets',
        'workspace',
      ]);
      expect(input).not.toHaveProperty('artifactDirectory');
      expect(input).not.toHaveProperty('rootfsPath');
      expect(input).not.toHaveProperty('sourcePayloads');
      expect(input.sourceEvidence.checkedTargetOutputPath).toBe(
        `openwrt/bin/targets/${input.target.openwrtTarget}/`,
      );
    },
  );

  it.each(['rpi-5', 'rpi-2'] as const)(
    'rejects source-stage evidence that is not bound to the exact %s output',
    async (targetId) => {
      const input = inputFor(targetId);
      const wrongTarget = targetId === 'rpi-5' ? 'rpi-2' : 'rpi-5';
      const variants: VerificationInput['sourceEvidence'][] = [
        { ...input.sourceEvidence, targetOutputAbsent: false },
        { ...input.sourceEvidence, targetId: wrongTarget },
        { ...input.sourceEvidence, openwrtTarget: 'bcm27xx/wrong' },
        { ...input.sourceEvidence, checkedTargetOutputPath: input.sourceEvidence.checkedTargetOutputPath.slice(0, -1) },
      ];
      for (const sourceEvidence of variants) {
        await expect(verifyFirmwareArtifact({ ...input, sourceEvidence })).rejects.toMatchObject({
          code: 'BUILD_OUTPUT_COLLISION',
        });
      }
    },
  );

  it('requires exactly both canonical manifest target contracts', async () => {
    const input = inputFor('rpi-5');
    await expect(verifyFirmwareArtifact({
      ...input,
      targets: input.targets.filter((target) => target.id === 'rpi-5'),
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    await expect(verifyFirmwareArtifact({
      ...input,
      targets: [input.targets[0]!, input.targets[0]!],
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    await expect(verifyFirmwareArtifact({
      ...input,
      targets: [
        input.targets[0]!,
        { ...input.targets[1]!, label: 'forged Pi target' },
      ],
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    await expect(verifyFirmwareArtifact({
      ...input,
      target: { ...input.target, profile: 'DEVICE_forged' },
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    await expect(verifyFirmwareArtifact({
      ...input,
      targets: [
        input.targets[0]!,
        {
          ...input.targets[1]!,
          configSymbols: [
            {
              name: 'CONFIG_TARGET_bcm27xx_bcm2709',
              type: 'bool',
              value: false,
            },
            ...input.targets[1]!.configSymbols.slice(1),
          ],
        },
      ],
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
  });

  it('rejects malformed immutable source identity before opening the workspace', async () => {
    const input = inputFor('rpi-2');
    await expect(verifyFirmwareArtifact({
      ...input,
      pinnedSha: 'not-a-commit',
    })).rejects.toMatchObject({ code: 'ROOTFS_CONTENT_FAILED' });
  });
});
