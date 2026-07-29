import { describe, expect, it } from 'vitest';

import * as configDocument from '../../config/config-document.mjs';

type AuthorityTopology = Readonly<{
  configRoot: string;
  stateRoot: string;
  installRoot: string;
  repositoryPath?: string;
  approvedOutputRoots?: readonly Readonly<{ id: string; path: string }>[];
}>;

const BASE: AuthorityTopology = Object.freeze({
  configRoot: '/srv/authority/config',
  stateRoot: '/srv/authority/state',
  installRoot: '/srv/authority/install',
  repositoryPath: '/srv/work/repository',
  approvedOutputRoots: [Object.freeze({ id: 'release', path: '/srv/releases' })],
});

describe('authority topology', () => {
  it('rejects overlap among config, state, install, repository, and output authorities', () => {
    const validate = Reflect.get(configDocument, 'validateAuthorityTopology') as
      | undefined
      | ((value: AuthorityTopology) => AuthorityTopology);
    expect(validate).toBeTypeOf('function');

    const invalid: AuthorityTopology[] = [
      { ...BASE, stateRoot: `${BASE.configRoot}/state` },
      {
        ...BASE,
        configRoot: '/srv/authority/config/nested',
        stateRoot: '/srv/authority/config',
      },
      { ...BASE, installRoot: `${BASE.configRoot}/install` },
      { ...BASE, installRoot: `${BASE.stateRoot}/install` },
      { ...BASE, repositoryPath: `${BASE.configRoot}/repository` },
      { ...BASE, repositoryPath: `${BASE.stateRoot}/repository` },
      { ...BASE, repositoryPath: `${BASE.installRoot}/repository` },
      { ...BASE, approvedOutputRoots: [{ id: 'release', path: `${BASE.configRoot}/images` }] },
      { ...BASE, approvedOutputRoots: [{ id: 'release', path: `${BASE.stateRoot}/images` }] },
      { ...BASE, approvedOutputRoots: [{ id: 'release', path: `${BASE.installRoot}/images` }] },
      { ...BASE, approvedOutputRoots: [{ id: 'release', path: `${BASE.repositoryPath}/images` }] },
      { ...BASE, approvedOutputRoots: [{ id: 'release', path: '/srv' }] },
      {
        ...BASE,
        approvedOutputRoots: [
          { id: 'release', path: '/srv/releases' },
          { id: 'archive', path: '/srv/releases/archive' },
        ],
      },
    ];
    for (const value of invalid) expect(() => validate?.(value)).toThrow(/overlap/u);
    expect(validate?.(BASE)).toEqual(BASE);
  });
});
