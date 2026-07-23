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

function packageTokens(source: string): Set<string> {
  const tokens: string[] = [];
  for (const match of source.matchAll(/apt-get\s+install\b([\s\S]*?)(?=\s+&&|\n\s*&&|$)/gu)) {
    tokens.push(...(match[1]!.match(/[A-Za-z0-9][A-Za-z0-9+_.-]*/gu) ?? []));
  }
  const flags = new Set(['no-install-recommends', 'no-install-suggests', 'yes']);
  return new Set(tokens.map((token) => PACKAGE_ALIASES[token] ?? token).filter((token) => !flags.has(token)));
}

export function supportedPackageTokens(source: string): readonly string[] {
  return [...packageTokens(source)].sort();
}

export async function assertSupportedPackageParity(rootDockerfilePath: string, toolDockerfilePath: string): Promise<void> {
  const [root, tool] = await Promise.all([readFile(rootDockerfilePath, 'utf8'), readFile(toolDockerfilePath, 'utf8')]);
  const rootPackages = packageTokens(root);
  const toolPackages = packageTokens(tool);
  const missing = [...rootPackages].filter((pkg) => !toolPackages.has(pkg));
  if (missing.length > 0) throw new BuilderSourceError('BUILDER_SOURCE_DRIFT', `Tool-owned builder is missing Dockerfile-devel tools: ${missing.join(', ')}`);
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
    if (!/^FROM\s+\S+@sha256:[0-9a-f]{64}\s*$/mu.test(tool)) throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'The tool-owned Dockerfile must use a digest-pinned base image');
    await mkdir(dirname(options.destinationPath), { recursive: true });
    await copyFile(toolDockerfilePath, options.destinationPath);
  }
  const rootPackages = packageTokens(root);
  const toolPackages = packageTokens(tool);
  const missing = [...rootPackages].filter((pkg) => !toolPackages.has(pkg));
  if (missing.length > 0) throw new BuilderSourceError('BUILDER_SOURCE_DRIFT', `Tool-owned builder is missing Dockerfile-devel tools: ${missing.join(', ')}`);
  const polly = [...toolPackages].find((pkg) => /^libpolly-\d+-dev$/u.test(pkg));
  if (!polly) throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Tool-owned builder has no matching Polly development package');
  const packageNames = Object.freeze([...toolPackages].sort());
  return Object.freeze({ destinationPath: options.destinationPath, packageSet: Object.freeze(['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', polly, 'libzstd-dev']), packageNames });
}
