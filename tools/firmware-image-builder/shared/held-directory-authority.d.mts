export type HeldDirectoryAccess = 'read' | 'write';

export interface HeldDirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly final: boolean;
}

export interface HeldDirectoryAuthority {
  readonly path: string;
  readonly ownerUid: number;
  readonly exists: boolean;
  readonly executionPath: string | undefined;
  readonly identityChain: readonly HeldDirectoryIdentity[];
  readonly unresolvedSuffix: readonly string[];
  readonly ensure: () => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly revalidate: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface HoldDirectoryAuthorityOptions {
  readonly ownerUid?: number;
  readonly allowMissing?: boolean;
  readonly createMode?: number;
  readonly finalAccess?: HeldDirectoryAccess;
}

export interface HeldAuthorityTopologyEntry {
  readonly name: string;
  readonly path: string;
  readonly authority: Pick<HeldDirectoryAuthority, 'exists' | 'identityChain' | 'unresolvedSuffix'>;
}

export function holdDirectoryAuthority(
  path: string,
  options?: HoldDirectoryAuthorityOptions,
): Promise<HeldDirectoryAuthority>;

export function assertHeldAuthoritiesDisjoint(
  entries: readonly HeldAuthorityTopologyEntry[],
): void;
