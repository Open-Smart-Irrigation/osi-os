import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PACKAGE_ROOT = new URL('../', import.meta.url).pathname;
const DEFAULT_SOURCE_ROOTS = Object.freeze([
  'api/src',
  'builder',
  'cleanup-worker/src',
  'config',
  'domain',
  'installer',
  'manifest',
  'publisher',
  'runner/src',
  'scripts',
  'ui/src',
]);
const SOURCE_EXTENSIONS = new Set(['.c', '.js', '.json', '.mjs', '.sh', '.ts', '.tsx']);
const SELF = 'scripts/check-plan-policy.mjs';
const RULES = Object.freeze([
  {
    id: 'DYNAMIC_SHELL_EXECUTION',
    pattern: /\bshell\s*:\s*true\b|from\s+['"]node:child_process['"][\s\S]{0,160}\b(?:exec|execSync)\b|(?:^|[\s"'`])(?:bash|sh)\s+-c(?:$|[\s"'`])|\beval\s*(?:\(|["'$])/gmu,
  },
  {
    id: 'DOCKER_SOCKET_MOUNT',
    pattern: /\/(?:var\/)?run\/docker\.sock/gu,
  },
  {
    id: 'DOCKER_PRIVILEGE',
    pattern: /--privileged(?:=|\s|['"`])/gu,
  },
  {
    id: 'DOCKER_DEVICE',
    pattern: /--device(?:=|\s|['"`])/gu,
  },
  {
    id: 'PRODUCTION_ENDPOINT',
    pattern: /\b(?:osicloud\.ch|server\.opensmartirrigation\.org)\b/gu,
  },
  {
    id: 'ARBITRARY_OUTPUT_PATH',
    pattern: /\b(?:request|body|payload|query)(?:\s*\.\s*|\s*\[\s*['"])(?:outputPath|outputDirectory|destinationPath|outputRootPath)\b|\bconst\s*\{[^}]*\b(?:path|outputPath|outputDirectory|destinationPath|outputRootPath)\b[^}]*\}\s*=\s*(?:request|body|payload|query)\b/gu,
  },
]);

async function filesUnder(packageRoot, relativeRoot) {
  const absoluteRoot = join(packageRoot, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = join(relativeRoot, entry.name);
    if (relativePath === SELF || entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.isDirectory()) files.push(...await filesUnder(packageRoot, relativePath));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(relativePath);
  }
  return files;
}

export async function scanPlanPolicy(options = {}) {
  const packageRoot = resolve(options.packageRoot ?? DEFAULT_PACKAGE_ROOT);
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const files = (await Promise.all(sourceRoots.map((root) => filesUnder(packageRoot, root)))).flat().sort();
  const violations = [];
  for (const path of files) {
    const contents = await readFile(join(packageRoot, path), 'utf8');
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of contents.matchAll(rule.pattern)) {
        const line = contents.slice(0, match.index).split('\n').length;
        violations.push({
          id: rule.id,
          path: relative(packageRoot, join(packageRoot, path)),
          line,
        });
      }
    }
  }
  return Object.freeze({
    files: Object.freeze(files),
    violations: Object.freeze(violations),
  });
}

async function main() {
  const result = await scanPlanPolicy();
  if (result.violations.length > 0) {
    console.error(result.violations.map(({ id, path, line }) => `${id} ${path}:${line}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`builder policy check passed (${result.files.length} executable/configuration source files)`);
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
