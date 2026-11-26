import {isBuiltin} from 'node:module';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {imports, sourceFile, walk} from './module-imports.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1])) {
  console.error('usage: verify-core-purity.mjs [--root <package directory>]');
  process.exit(2);
}
// The self-test points --root at a fixture package with its own src/core, tsconfig.json and package.json.
const root = args.length ? resolve(args[1]) : fileURLToPath(new URL('../', import.meta.url));
const core = resolve(root, 'src/core');
const osi = resolve(core, 'osi');
const scenarios = resolve(root, 'src/scenarios');
const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));
const {dependencies} = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const isSource = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const webOnly = new Set(['localStorage', 'sessionStorage', 'navigator', 'location', 'self', 'window', 'document']);
const forbiddenPackages = new Set(['pixi.js', 'preact']);
// @noble/hashes also exports randomBytes, a Date.now-paced asyncLoop and globalThis.crypto: only these named imports pass.
const nobleImports = new Map([
  ['@noble/hashes/sha256', ['sha256']],
  ['@noble/hashes/utils', ['utf8ToBytes']],
]);
// Node also has these, so the DOM check above skips them; a run that read them would depend on when it runs (plan 2).
// Temporal is in neither Node 22 nor lib.dom.d.ts, but browsers ship Temporal.Now.
// With `allowed`, a member outside both lists is reported as unclassified: Date.call() reads the clock, as Date() does.
// Core uses no member of performance, process, crypto or Temporal, so their allow-lists are empty; digests use @noble/hashes.
const clockMembers = new Map([
  ['Math', {forbidden: ['random']}],
  ['Date', {forbidden: ['now'], allowed: ['parse', 'UTC']}],
  ['performance', {forbidden: ['now', 'timeOrigin'], allowed: []}],
  ['process', {forbidden: ['hrtime', 'uptime'], allowed: []}],
  ['crypto', {forbidden: ['getRandomValues', 'randomUUID', 'subtle'], allowed: []}],
  ['Temporal', {forbidden: ['Now'], allowed: []}],
]);
// new Date and Date.parse read a date-time string without Z or an offset as host local time. A date-only string is
// UTC by the spec, but it fails too: core always names the offset.
const zonedDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const schedulingOrNetwork = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'fetch', 'WebSocket']);
// Both run a string as code, which no static check can read.
const dynamicCode = new Set(['eval', 'Function']);
const globalObjects = new Set(['globalThis', 'global']);

function within(dir, path) {
  const child = relative(dir, path);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

function resolveSource(path) {
  return ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.json', '.jsx', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.mjs']
    .map(suffix => path + suffix)
    .some(candidate => statSync(candidate, {throwIfNoEntry: false})?.isFile());
}

/** `listed` is true when the entry is an import declaration that `listedImports` approved. */
function importProblem(file, specifier, listed) {
  if (!specifier) return 'cannot classify non-literal or empty module specifier';
  const path = specifier.split(/[?#]/, 1)[0];
  if (path.startsWith('.')) {
    const target = resolve(dirname(file), path);
    if (!within(core, target) && !within(scenarios, target)) return 'core import leaves core and scenarios: ' + specifier;
    if (!resolveSource(target)) return 'unresolved relative import: ' + specifier;
    return;
  }
  const segments = path.split('/');
  const packageName = segments.slice(0, path.startsWith('@') ? 2 : 1).join('/');
  if (forbiddenPackages.has(packageName)) return 'UI package import: ' + specifier;
  for (const alias of ['@osi-demo', '@osi-edge']) {
    if (!path.startsWith(alias + '/')) continue;
    if (alias === '@osi-demo' && !within(osi, file)) return 'simulator import outside core/osi: ' + specifier;
    const directory = resolve(root, config.compilerOptions.paths[alias + '/*'][0].slice(0, -1));
    const target = resolve(directory, path.slice(alias.length + 1));
    if (within(directory, target) && resolveSource(target)) return;
    return 'unresolved alias import: ' + specifier;
  }
  // A built-in such as node:perf_hooks would bind performance locally, out of reach of the global checks below.
  if (isBuiltin(path)) return 'Node built-in import: ' + specifier;
  if (!Object.hasOwn(dependencies, packageName)) return 'cannot classify import: ' + specifier;
  if (packageName === '@noble/hashes' && !listed) return 'cannot classify import: ' + specifier;
}

/**
 * Counts, by line and specifier, the declarations that import only listed names from @noble/hashes, with no default
 * or namespace binding. Each one admits one entry of imports(), so a re-export, import() or require() of the same
 * specifier on the same line still fails.
 */
function listedImports(source, line) {
  const counts = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const names = nobleImports.get(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!names || !clause || clause.name || !bindings || !ts.isNamedImports(bindings)
      || !bindings.elements.every(each => names.includes((each.propertyName ?? each.name).text))) continue;
    const key = line(statement) + ' ' + statement.moduleSpecifier.text;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The expression that consumes `node`, past parentheses, non-null assertions and type assertions. */
function consumer(node) {
  let current = node;
  while ((ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)) && current.parent.expression === current) current = current.parent;
  return current;
}

/** The static member name read from `object`, null for a computed key, undefined when `object` is not read that way. */
function memberName(object) {
  const {parent} = object;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === object) return parent.name.text;
  if (!ts.isElementAccessExpression(parent) || parent.expression !== object) return undefined;
  const key = parent.argumentExpression;
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null;
}

/** Names destructured from `object` by `const {a, b: c} = object`, null with a rest or computed key, else undefined. */
function destructuredNames(object) {
  const {parent} = object;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== object || !ts.isObjectBindingPattern(parent.name)) {
    return undefined;
  }
  const names = [];
  for (const element of parent.name.elements) {
    const key = element.propertyName ?? element.name;
    if (element.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) {
      return null;
    }
    names.push(key.text);
  }
  return names;
}

/** `node` past parentheses, non-null assertions and type assertions, the inverse of consumer(). */
function unwrapped(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

/**
 * Reports a string literal passed to new Date or Date.parse that names no offset. A variable or an expression cannot
 * be read statically and passes (plan 2).
 */
function dateString(value, what, at, report) {
  const text = value && unwrapped(value);
  if (text && ts.isStringLiteralLike(text) && !zonedDateTime.test(text.text)) {
    report(at, 'host time zone: ' + what + ' string without Z or an offset');
  }
}

/** Checks a read of `member` from the clock global `name`. */
function clockMember(name, member, at, report) {
  const {forbidden, allowed} = clockMembers.get(name);
  if (forbidden.includes(member)) return report(at, 'nondeterministic source: ' + name + '.' + member);
  if (allowed && !allowed.includes(member)) report(at, 'cannot classify use of ' + name + '.' + member);
}

/** Checks one use of the global `name`; `expression` evaluates to it (an identifier or a globalThis member). */
function globalUse(name, expression, report) {
  const used = consumer(expression);
  if (schedulingOrNetwork.has(name)) return report(used, 'host scheduling or network: ' + name);
  if (name === 'eval') return report(used, 'dynamic code: eval');
  const {parent} = used;
  if (name === 'Function') {
    // Function.prototype.toString reads a function's source; Function.prototype.constructor is Function again.
    if (memberName(used) === 'prototype' && memberName(consumer(parent)) === 'toString') return;
    const called = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === used;
    return report(used, called ? 'dynamic code: Function' : 'cannot classify use of Function');
  }
  if (!clockMembers.has(name) && !globalObjects.has(name)) return;
  const member = memberName(used);
  if (typeof member === 'string') {
    if (globalObjects.has(name)) return globalUse(member, parent, report);
    if (name === 'Date' && member === 'parse') {
      const callee = consumer(parent);
      const call = callee.parent;
      if (ts.isCallExpression(call) && call.expression === callee) dateString(call.arguments[0], 'Date.parse', used, report);
    }
    return clockMember(name, member, used, report);
  }
  if (member === null) return report(used, 'cannot classify dynamic access on ' + name);
  const names = destructuredNames(used);
  if (names === null) return report(used, 'cannot classify rest or computed destructuring of ' + name);
  if (names) {
    for (const each of names) {
      if (!globalObjects.has(name)) {
        clockMember(name, each, used, report);
      } else if (schedulingOrNetwork.has(each)) {
        report(used, 'host scheduling or network: ' + each);
      } else if (dynamicCode.has(each)) {
        report(used, 'dynamic code: ' + each);
      } else if (clockMembers.has(each) || globalObjects.has(each)) {
        // The local binding would hide every later use from this guard.
        report(used, 'cannot classify use of ' + each);
      }
    }
    return;
  }
  if (name === 'Date' && ts.isNewExpression(parent) && parent.expression === used) {
    const values = parent.arguments ?? [];
    if (values.some(value => ts.isSpreadElement(value))) return report(used, 'cannot classify spread arguments of new Date');
    if (!values.length) return report(used, 'nondeterministic source: new Date() without arguments');
    // new Date(year, month, ...) reads its fields as local time.
    if (values.length > 1) return report(used, 'host time zone: new Date with two or more arguments');
    return dateString(values[0], 'new Date', used, report);
  }
  if (name === 'Date' && ts.isCallExpression(parent) && parent.expression === used) {
    return report(used, 'nondeterministic source: Date() call');
  }
  if (name === 'Date' && ts.isBinaryExpression(parent) && parent.right === used
    && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return;
  report(used, 'cannot classify use of ' + name);
}

/** True for an identifier that reads a global: no local binding and not a property or specifier name. */
function isGlobalReference(node) {
  if (!ts.isIdentifier(node)) return false;
  const {parent} = node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node
    || ts.isQualifiedName(parent) && parent.right === node
    || ts.isPropertyAssignment(parent) && parent.name === node
    || ts.isBindingElement(parent) && parent.propertyName === node
    || (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === node
    || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  const symbol = ts.isShorthandPropertyAssignment(parent)
    ? symbols.getShorthandAssignmentValueSymbol(parent)
    : symbols.getSymbolAtLocation(node);
  if (!symbol) return true;
  const declarations = symbol.declarations ?? [];
  // The checker resolves globalThis even without lib files, to its own symbol with no declarations.
  if (!declarations.length) return node.text === 'globalThis';
  // `declare` and `declare global` emit no code, so a name declared only that way still reads the global at run time.
  return declarations.every(each => each.flags & ts.NodeFlags.Ambient) && !declarations.some(each => each.name === node);
}

/** Visits value positions only: type annotations name types, not globals. A class `extends` clause is a value. */
function walkValues(node, visit) {
  if (ts.isTypeNode(node) && !(ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)
    && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent))) return;
  visit(node);
  ts.forEachChild(node, child => walkValues(child, visit));
}

function browserGlobals() {
  const domPath = resolve(dirname(ts.getDefaultLibFilePath({})), 'lib.dom.d.ts');
  const globals = new Set(webOnly);
  function add(name) {
    // Node exposes some web standards, including URL and EventTarget.
    if (name && !(name in globalThis)) globals.add(name);
  }
  for (const node of sourceFile(domPath, readFileSync(domPath, 'utf8')).statements) {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) add(declaration.name.getText());
    } else if (node.name && ts.isIdentifier(node.name)) {
      add(node.name.text);
    }
  }
  return globals;
}

const files = readdirSync(core, {recursive: true, withFileTypes: true})
  .filter(entry => entry.isFile() && isSource.test(entry.name))
  .map(entry => resolve(entry.parentPath, entry.name))
  .sort();
if (!files.length) throw new Error('verify-core-purity: no core source files found');

// Use TypeScript's lexical bindings without loading dependencies or checking types.
const options = {noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.Latest};
const host = ts.createCompilerHost(options, true);
const program = ts.createProgram(files, options, host);
const symbols = program.getTypeChecker();
const globals = browserGlobals();
const errors = [];

for (const file of files) {
  const source = program.getSourceFile(file);
  const report = (line, problem) => errors.push(`${relative(root, file)}:${line}: ${problem}`);
  for (const diagnostic of source.parseDiagnostics) {
    report(source.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const listed = listedImports(source, line);
  for (const {line: at, specifier} of imports(source)) {
    const key = at + ' ' + specifier;
    const count = listed.get(key) ?? 0;
    if (count) listed.set(key, count - 1);
    const problem = importProblem(file, specifier, count > 0);
    if (problem) report(at, problem);
  }
  walk(source, node => {
    if (!ts.isIdentifier(node) && !ts.isStringLiteralLike(node)) return;
    if (!globals.has(node.text)) return;
    const parent = node.parent;
    const globalProperty = (ts.isPropertyAccessExpression(parent) && parent.name === node
      || ts.isElementAccessExpression(parent) && parent.argumentExpression === node && ts.isStringLiteralLike(node))
      && ts.isIdentifier(parent.expression) && globalObjects.has(parent.expression.text);
    const binding = ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node
      && ts.isObjectBindingPattern(parent.parent) && ts.isVariableDeclaration(parent.parent.parent)
      && globalObjects.has(parent.parent.parent.initializer?.getText());
    if (globalProperty || binding || isGlobalReference(node)) report(line(node), 'DOM global: ' + node.text);
  });
  walkValues(source, node => {
    if (isGlobalReference(node)) globalUse(node.text, node, (at, problem) => report(line(at), problem));
  });
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`verify-core-purity: OK (${files.length} core sources)`);
}
