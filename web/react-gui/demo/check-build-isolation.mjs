import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--production', '--public', '--source'].includes(key) || !argv[index + 1]) {
      throw new Error(`Usage: node demo/check-build-isolation.mjs --production <dir> --public <dir> --source <dir>`);
    }
    values.set(key, argv[++index]);
  }
  for (const key of ['--production', '--public', '--source']) if (!values.has(key)) throw new Error(`Missing ${key}`);
  return Object.fromEntries(values);
}

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(file));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

const textExtensions = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.map', '.svg', '.txt']);
async function textFiles(directory) {
  return (await filesUnder(directory)).filter(file => textExtensions.has(path.extname(file).toLowerCase()));
}

async function requireDirectory(directory, label) {
  try {if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');}
  catch {throw new Error(`${label} directory is missing: ${directory}`);}
}

export async function checkBuildIsolation({production, publicBuild, source}) {
  const errors = [];
  for (const [directory, label] of [[production, 'production build'], [publicBuild, 'public build'], [source, 'source']]) {
    try {await requireDirectory(directory, label);} catch (error) {errors.push(error.message);}
  }
  if (errors.length) return errors;

for (const file of await textFiles(production)) {
  const content = await readFile(file, 'utf8');
  const relative = path.relative(production, file);
  if (content.includes('inert-demo-session-not-a-jwt')) errors.push(`production artifact contains inert demo session marker: ${relative}`);
  if (/(?:^|[^A-Za-z0-9_$])demo[\\/](?:runtime|adapter|model|public|fixtures|revalidation)(?=$|[\\/.'"`?#\s])/i.test(content)) {
    errors.push(`production artifact references simulator modules: ${relative}`);
  }
}

for (const file of await filesUnder(source)) {
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(file) || /(?:^|[/\\])__tests__(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file)) continue;
  const content = await readFile(file, 'utf8');
  const scriptKind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const specifier of specifiers) {
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
    if (/(?:^|[/\\])demo(?:[/\\]|$)/i.test(resolved) || /^demo(?:[/\\]|$)/i.test(specifier)) {
      errors.push(`production source imports demo code: ${path.relative(source, file)} -> ${specifier}`);
    }
  }
}

const publicFiles = await filesUnder(publicBuild);
for (const expected of ['index.html', 'app.html']) {
  if (!publicFiles.includes(path.join(publicBuild, expected))) errors.push(`public artifact is missing ${expected}`);
}
for (const file of publicFiles) {
  const relative = path.relative(publicBuild, file).split(path.sep).join('/');
  if (relative !== 'index.html' && relative !== 'app.html' && !relative.startsWith('assets/')) {
    errors.push(`public artifact contains a non-entry resource: ${relative}`);
  }
}

  return errors;
}

const scriptPath = process.argv[1] && path.resolve(process.argv[1]);
if (scriptPath === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const {['--production']: production, ['--public']: publicBuild, ['--source']: source} = args(process.argv.slice(2));
    const errors = await checkBuildIsolation({production, publicBuild, source});
    if (errors.length) {
      for (const error of errors) console.error(`FAIL: ${error}`);
      process.exitCode = 1;
    } else {
      const productionFiles = await filesUnder(production);
      const publicFiles = await filesUnder(publicBuild);
      console.log(`build isolation: PASS (production ${productionFiles.length} files, public ${publicFiles.length} files)`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
