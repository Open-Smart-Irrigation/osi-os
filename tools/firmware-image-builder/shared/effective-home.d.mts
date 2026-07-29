export interface EffectiveHomeResolverOptions {
  readonly ownerUid?: number;
  readonly lookupPasswd?: (uid: number) => Promise<string>;
  readonly closeHandle?: (handle: { close: () => Promise<void> }) => Promise<void>;
}

export interface EffectiveHomeAuthority {
  readonly path: string;
  readonly ownerUid: number;
  readonly executionPath: string;
  readonly childPath: (...components: readonly string[]) => string;
  readonly revalidate: () => Promise<void>;
}

export function withEffectiveHomeAuthority<T>(
  options: EffectiveHomeResolverOptions | undefined,
  callback: (authority: EffectiveHomeAuthority) => Promise<T>,
): Promise<T>;

export function resolveEffectiveHome(options?: EffectiveHomeResolverOptions): Promise<string>;
