import { describe, expect, it } from 'vitest';

import {
  buildxLoadArguments,
  canonicalLoadedBuildxImage,
} from '../../installer/production.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const REPOSITORY = 'osi-image-builder';
const TAG = `${REPOSITORY}:2026.07.29.1`;
const METADATA = JSON.stringify({ 'containerimage.digest': `sha256:${DIGEST}` });
const INSPECTION = {
  Id: IMAGE_ID,
  RepoDigests: [`${REPOSITORY}@sha256:${DIGEST}`],
  Config: {
    Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  },
};

describe('production builder image import', () => {
  it('loads a Buildx result with a content metadata file', () => {
    expect(buildxLoadArguments(TAG, '/tmp/build-metadata.json')).toEqual([
      'buildx',
      'build',
      '--platform=linux/amd64',
      '--load',
      '--provenance=false',
      '--metadata-file',
      '/tmp/build-metadata.json',
      '--tag',
      TAG,
      '--file',
      'builder/Dockerfile',
      '.',
    ]);
  });

  it('binds the canonical repository digest to Buildx content metadata', () => {
    expect(canonicalLoadedBuildxImage(REPOSITORY, METADATA, INSPECTION)).toEqual({
      digest: DIGEST,
      reference: `${REPOSITORY}@sha256:${DIGEST}`,
    });
  });

  it('rejects absent RepoDigests instead of falling back to the image ID', () => {
    expect(() => canonicalLoadedBuildxImage(REPOSITORY, METADATA, {
      ...INSPECTION,
      RepoDigests: [],
    })).toThrow(/repository digest/u);
  });

  it('rejects missing, malformed, or mismatched Buildx digest metadata', () => {
    for (const metadata of [
      '{}',
      JSON.stringify({ 'containerimage.digest': IMAGE_ID }),
      JSON.stringify({ 'containerimage.digest': DIGEST }),
      JSON.stringify({ 'containerimage.digest': `sha256:${'A'.repeat(64)}` }),
    ]) {
      expect(() => canonicalLoadedBuildxImage(REPOSITORY, metadata, INSPECTION)).toThrow(
        /metadata|digest/u,
      );
    }
    expect(() => canonicalLoadedBuildxImage(REPOSITORY, METADATA, {
      ...INSPECTION,
      RepoDigests: [`${REPOSITORY}@sha256:${OTHER_DIGEST}`],
    })).toThrow(/repository digest/u);
  });
});
