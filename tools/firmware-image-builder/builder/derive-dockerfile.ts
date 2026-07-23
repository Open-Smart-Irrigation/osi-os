import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type BuilderSourceErrorCode = 'BUILDER_SOURCE_DRIFT' | 'BUILDER_DOCKERFILE_INVALID';

export class BuilderSourceError extends Error {
  readonly code: BuilderSourceErrorCode;

  constructor(code: BuilderSourceErrorCode, message: string) {
    super(message);
    this.name = 'BuilderSourceError';
    this.code = code;
  }
}

const PACKAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({ 'libncurses5-dev': 'libncurses-dev' });
export const BUILDER_ONLY_PACKAGES = Object.freeze([
  'gcc-14', 'g++-14', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev', 'rustc', 'cargo', 'rust-src', 'rust-llvm', 'xz-utils',
  'musl:arm64', 'musl-dev:arm64', 'musl:armhf', 'musl-dev:armhf',
] as const);

function packageTokens(source: string): Set<string> {
  const tokens: string[] = [];
  for (const match of source.matchAll(/apt-get\s+(?:install|download)\b([\s\S]*?)(?=\s+&&|\n\s*&&|$)/gu)) {
    const packageArguments = match[1]!.replace(/=\$\{[A-Z0-9_]+\}/gu, '');
    tokens.push(...(packageArguments.match(/[A-Za-z0-9][A-Za-z0-9+_.:-]*/gu) ?? []));
  }
  const flags = new Set(['no-install-recommends', 'no-install-suggests', 'yes']);
  return new Set(tokens.map((token) => PACKAGE_ALIASES[token] ?? token).filter((token) => !flags.has(token)));
}

export function supportedPackageTokens(source: string): readonly string[] {
  return [...packageTokens(source)].sort();
}

export async function assertSupportedPackageParity(rootDockerfilePath: string, toolDockerfilePath: string): Promise<void> {
  const [root, tool] = await Promise.all([readFile(rootDockerfilePath, 'utf8'), readFile(toolDockerfilePath, 'utf8')]);
  assertExactPackageParity(root, tool);
}

export function assertExactPackageParity(root: string, tool: string): void {
  const rootPackages = packageTokens(root);
  const toolPackages = packageTokens(tool);
  const allowedExtras = new Set<string>(BUILDER_ONLY_PACKAGES);
  const missing = [...rootPackages].filter((pkg) => !toolPackages.has(pkg));
  const unexpected = [...toolPackages].filter((pkg) => !rootPackages.has(pkg) && !allowedExtras.has(pkg));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new BuilderSourceError('BUILDER_SOURCE_DRIFT', `Dockerfile-devel parity mismatch; missing=${missing.sort().join(',') || 'none'} unexpected=${unexpected.sort().join(',') || 'none'}`);
  }
}

export async function deriveDockerfile(options: {
  readonly rootDockerfilePath?: string;
  readonly destinationPath?: string;
  readonly toolDockerfilePath?: string;
  readonly rootDockerfile?: string;
  readonly builderDockerfile?: string;
}): Promise<{ readonly destinationPath?: string; readonly packageSet?: readonly string[]; readonly packageNames?: readonly string[] }> {
  let root: string;
  let tool: string;
  if (options.rootDockerfile !== undefined && options.builderDockerfile !== undefined) {
    root = options.rootDockerfile;
    tool = options.builderDockerfile;
  } else {
    const toolDockerfilePath = options.toolDockerfilePath ?? new URL('./Dockerfile', import.meta.url).pathname;
    if (!options.rootDockerfilePath || !options.destinationPath) throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile derivation paths are incomplete');
    await assertSupportedPackageParity(options.rootDockerfilePath, toolDockerfilePath);
    root = await readFile(options.rootDockerfilePath, 'utf8');
    tool = await readFile(toolDockerfilePath, 'utf8');
    if (!/^ARG BUILDER_PLATFORM=linux\/amd64\s+FROM\s+--platform=\$\{BUILDER_PLATFORM\}\s+\S+@sha256:[0-9a-f]{64}\s*$/mu.test(tool) || /^FROM\s+--platform=linux\/amd64/mu.test(tool)) throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'The tool-owned Dockerfile must use a digest-pinned validated linux/amd64 base image');
    await mkdir(dirname(options.destinationPath), { recursive: true });
    await copyFile(toolDockerfilePath, options.destinationPath);
  }
  const rootPackages = packageTokens(root);
  const toolPackages = packageTokens(tool);
  assertExactPackageParity(root, tool);
  const polly = [...toolPackages].find((pkg) => /^libpolly-\d+-dev$/u.test(pkg));
  if (!polly) throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Tool-owned builder has no matching Polly development package');
  const packageNames = Object.freeze([...toolPackages].sort());
  return Object.freeze({ destinationPath: options.destinationPath, packageSet: Object.freeze(['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', polly, 'libzstd-dev']), packageNames });
}
