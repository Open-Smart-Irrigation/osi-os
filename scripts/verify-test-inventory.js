#!/usr/bin/env node
'use strict';
// Fails when a test file in the repository is not run by any CI workflow and
// is not excluded with a reason, and when a workflow collects tests in a way
// that passes with nothing collected.
//
// `node --test` treats its arguments as glob patterns and skips one that
// matches nothing, so a renamed or moved test file stops running while its
// step stays green. This verifier reads every workflow under
// .github/workflows and enforces:
//   - test commands name tracked files: no glob, no missing path, no bare
//     `node --test`;
//   - every tracked test file (naming rules in TEST_NAME) is named by a
//     workflow step, collected by an npm script a step runs, chained by a
//     runner listed under "indirect", or listed under "excluded" with a
//     reason (scripts/verify-test-inventory.json); stale entries fail;
//   - npm scripts collect GUI tests through vitest directory filters, each
//     of which must match a test, or through scripts/run-tsx-tests.mjs;
//     --passWithNoTests is not allowed;
//   - actions/setup-node pins a numeric Node version (no lts/*);
//   - installs use `npm ci` without --legacy-peer-deps or --force.
// An unreadable or unparsable workflow is an error, never a pass. The YAML
// reader (parseYaml, plain JavaScript, no dependency) supports the subset
// the workflows use and rejects anything else.
//
// Scope: files named like tests (TEST_NAME). Verifiers such as
// scripts/verify-*.js or scripts/check-*.sh are not tests in this sense and
// are not inventoried.
//
// Usage: node scripts/verify-test-inventory.js [--root=<dir>] [--list]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INVENTORY_FILE = 'scripts/verify-test-inventory.json';
const WORKFLOW_DIR = '.github/workflows';
const TSX_RUNNER = 'scripts/run-tsx-tests.mjs';
const RUN_MODULE_TESTS = 'scripts/run-module-tests.js';
const TEST_NAME = [
  /\.(test|spec)\.(c|m)?[jt]sx?$/,
  /\.test\.sh$/,
  /^test[-_][^/]*\.((c|m)?js|ts|sh|py|R)$/,
  /^selftest\.((c|m)?js|ts|sh)$/,
];
const SCRIPT_EXT = /\.((c|m)?[jt]sx?|sh)$/;
const GLOB_CHARS = /[*?[\]{}]/;
const VITEST_INCLUDE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
const MIN_REASON = 10;
// Exclusion reasons that start like this name a defect or a cost someone must pick up.
const ISSUE_CLASS = /^(fails on main|slow)\b/i;

// ------------------------------------------------------------- YAML subset

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.\-/]*|"[^"]*"|'[^']*')[ ]*:(?:[ ]+(.*)|[ ]*)$/;

function parseYaml(text, file) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const fail = (msg, n) => {
    throw new Error(`${file}:${n + 1}: ${msg}`);
  };
  const blankOrComment = (line) => /^\s*(#.*)?$/.test(line);
  const indentOf = (n) => {
    const m = /^( *)(.?)/.exec(lines[n]);
    if (m[2] === '\t') fail('tab indentation is not supported', n);
    return m[1].length;
  };
  const skip = () => {
    while (i < lines.length && blankOrComment(lines[i])) i += 1;
  };
  const isSeqItem = (content) => content === '-' || content.startsWith('- ');

  function stripComment(raw, n) {
    // Removes a trailing " # comment" from a plain or quoted scalar.
    if (raw.startsWith("'") || raw.startsWith('"')) {
      const q = raw[0];
      let j = 1;
      for (; j < raw.length; j += 1) {
        if (q === "'" && raw[j] === "'" && raw[j + 1] === "'") { j += 1; continue; }
        if (q === '"' && raw[j] === '\\') { j += 1; continue; }
        if (raw[j] === q) break;
      }
      if (j >= raw.length) fail('unterminated quote', n);
      const rest = raw.slice(j + 1);
      if (rest.trim() && !/^\s+#/.test(rest)) fail('text after a quoted scalar', n);
      return raw.slice(0, j + 1);
    }
    const m = /(^|\s)#/.exec(raw);
    return (m ? raw.slice(0, m.index) : raw).trim();
  }

  function scalar(raw, n) {
    const v = stripComment(raw.trim(), n);
    if (v === '' || v === '~' || v === 'null') return null;
    if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    if (v.startsWith('"')) {
      return v.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' }[c] ?? fail(`unsupported escape \\${c}`, n)));
    }
    if (v.startsWith('{')) fail('flow mapping is not supported', n);
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) fail('unterminated flow sequence', n);
      const inner = v.slice(1, -1);
      if (/[[\]{}]/.test(inner)) fail('nested flow collections are not supported', n);
      if (!inner.trim()) return [];
      return inner.split(',').map((item) => scalar(item, n));
    }
    if (/^[&*!%@`|>]/.test(v)) fail('anchor, alias, tag or reserved indicator is not supported', n);
    if (/:(\s|$)/.test(v)) fail('": " inside a plain scalar', n);
    return v;
  }

  function blockScalar(header, keyIndent, n) {
    const h = stripComment(header, n);
    const m = /^([|>])([+-]?)$/.exec(h);
    if (!m) fail(`unsupported block scalar header "${h}"`, n);
    const [, style, chomp] = m;
    const body = [];
    let contentIndent = -1;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { body.push(''); i += 1; continue; }
      const ind = indentOf(i);
      if (contentIndent < 0) {
        if (ind <= keyIndent) break;
        contentIndent = ind;
      }
      if (ind < contentIndent) {
        if (ind > keyIndent && !/^\s*#/.test(line)) fail('block scalar line is less indented than its first line', i);
        break;
      }
      body.push(line.slice(contentIndent));
      i += 1;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing += 1; }
    if (!body.length) return '';
    let text;
    if (style === '|') {
      text = body.join('\n');
    } else {
      text = '';
      for (const line of body) {
        if (line.startsWith(' ')) fail('more-indented lines in a folded block are not supported', n);
        if (line === '') text += '\n';
        else text += (text && !text.endsWith('\n') ? ' ' : '') + line;
      }
    }
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }

  function node(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(i);
    if (ind < minIndent) return null;
    return isSeqItem(lines[i].slice(ind)) ? seq(ind) : map(ind);
  }

  function value(raw, keyIndent, n) {
    if (raw === undefined || raw.trim() === '' || /^#/.test(raw.trim())) {
      skip();
      if (i >= lines.length) return null;
      const ind = indentOf(i);
      if (ind > keyIndent) return node(ind);
      if (ind === keyIndent && isSeqItem(lines[i].slice(ind))) return seq(ind);
      return null;
    }
    if (/^[|>]/.test(raw.trim())) return blockScalar(raw.trim(), keyIndent, n);
    return scalar(raw, n);
  }

  function seq(ind) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const lineIndent = indentOf(i);
      if (lineIndent < ind) break;
      if (lineIndent > ind) fail('unexpected indentation', i);
      const content = lines[i].slice(ind);
      if (!isSeqItem(content)) break;
      const rest = content.slice(1);
      const body = rest.trimStart();
      const bodyIndent = ind + 1 + (rest.length - body.length);
      const n = i;
      if (body === '' || body.startsWith('#')) {
        i += 1;
        out.push(value(undefined, ind, n));
      } else if (KEY_RE.test(body)) {
        lines[i] = ' '.repeat(bodyIndent) + body;
        out.push(map(bodyIndent));
      } else {
        i += 1;
        if (/^[|>]/.test(body)) out.push(blockScalar(body, ind, n));
        else out.push(scalar(body, n));
      }
    }
    return out;
  }

  function map(ind) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const lineIndent = indentOf(i);
      if (lineIndent < ind) break;
      if (lineIndent > ind) fail('unexpected indentation', i);
      const content = lines[i].slice(ind);
      if (isSeqItem(content)) break;
      const m = KEY_RE.exec(content);
      if (!m) fail('expected "key: value"', i);
      const key = /^['"]/.test(m[1]) ? m[1].slice(1, -1) : m[1];
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate key "${key}"`, i);
      const n = i;
      i += 1;
      out[key] = value(m[2], ind, n);
    }
    return out;
  }

  skip();
  if (i < lines.length && /^---\s*$/.test(lines[i])) i += 1;
  const doc = node(0);
  skip();
  if (i < lines.length) fail('unexpected content', i);
  return doc;
}

// ------------------------------------------------------------- shell words

// Splits a run script into commands on newlines, ;, &, &&, || and |,
// honouring quotes. Each command records the operator that ends it ('\n',
// ';', '&', '&&', '||', '|' or 'end'). GitHub expressions become a
// placeholder word.
function shellScript(script) {
  const src = script.replace(/\$\{\{[\s\S]*?\}\}/g, '__EXPR__');
  if (/<<-?\s*['"]?\w/.test(src)) throw new Error('here-documents are not supported in workflow run scripts');
  const commands = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = (sep) => {
    endWord();
    if (words.length) commands.push({ words, sep });
    else if (commands.length && sep !== '\n' && sep !== 'end' && commands[commands.length - 1].sep === '\n') {
      throw new Error(`a line starts with "${sep}"; continuation lines are not supported`);
    }
    words = [];
  };
  for (let j = 0; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\' && src[j + 1] === '\n') { j += 1; continue; }
    if (c === '\\') { word = (word ?? '') + (src[j + 1] ?? ''); j += 1; continue; }
    if (c === "'") {
      const end = src.indexOf("'", j + 1);
      if (end < 0) throw new Error('unterminated single quote in a run script');
      word = (word ?? '') + src.slice(j + 1, end);
      j = end;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      let buf = '';
      for (; k < src.length && src[k] !== '"'; k += 1) {
        if (src[k] === '\\' && k + 1 < src.length) { buf += src[k + 1]; k += 1; } else buf += src[k];
      }
      if (k >= src.length) throw new Error('unterminated double quote in a run script');
      word = (word ?? '') + buf;
      j = k;
      continue;
    }
    if (c === '#' && word === null) {
      while (j < src.length && src[j] !== '\n') j += 1;
      endCommand('\n');
      continue;
    }
    if (c === '>' || c === '<') {
      // A redirection: drop a numeric fd before it and the target after it.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      let k = j + 1;
      while (src[k] === '>' || src[k] === '<') k += 1;
      if (src[k] === '&' && /\d|-/.test(src[k + 1] || '')) {
        k += 1;
        while (/[\d-]/.test(src[k] || '')) k += 1;
      } else {
        while (src[k] === ' ' || src[k] === '\t') k += 1;
        while (k < src.length && !/[\s;&|()]/.test(src[k])) k += 1;
      }
      j = k - 1;
      continue;
    }
    if (c === '&' || c === '|') {
      if (src[j + 1] === c) { endCommand(c + c); j += 1; } else endCommand(c);
      continue;
    }
    if (c === '\n' || c === ';') { endCommand(c); continue; }
    if (c === ' ' || c === '\t' || c === '(' || c === ')') { endWord(); continue; }
    word = (word ?? '') + c;
  }
  endCommand('end');
  return commands;
}

function shellCommands(script) {
  return shellScript(script).map((c) => c.words);
}

// ------------------------------------------------------------- repository

function isTestFile(rel) {
  const base = rel.split('/').pop();
  return TEST_NAME.some((re) => re.test(base));
}

function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return new Set(out.split('\0').filter(Boolean));
}

function relPath(root, base, p) {
  return path.relative(root, path.resolve(root, base, p)).split(path.sep).join('/');
}

function matchesGlob(rel, pattern) {
  return path.matchesGlob(rel, pattern);
}

function loadInventory(root, errors) {
  const file = path.join(root, INVENTORY_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    errors.push(`${INVENTORY_FILE}: cannot read (${err.code || err.message})`);
    return null;
  }
  let inv;
  try {
    inv = JSON.parse(raw);
  } catch {
    errors.push(`${INVENTORY_FILE}: not valid JSON`);
    return null;
  }
  const allowed = { $comment: null, indirect: ['path', 'runner', 'note'], excluded: ['path', 'pattern', 'reason'] };
  let ok = true;
  for (const key of Object.keys(inv)) {
    if (!(key in allowed)) { errors.push(`${INVENTORY_FILE}: unknown key "${key}"`); ok = false; }
  }
  for (const list of ['indirect', 'excluded']) {
    if (!Array.isArray(inv[list])) { errors.push(`${INVENTORY_FILE}: "${list}" must be a list`); ok = false; continue; }
    inv[list].forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') { errors.push(`${INVENTORY_FILE}: ${list}[${idx}] is not an object`); ok = false; return; }
      for (const key of Object.keys(entry)) {
        if (!allowed[list].includes(key)) { errors.push(`${INVENTORY_FILE}: ${list}[${idx}] has unknown key "${key}"`); ok = false; }
      }
    });
  }
  return ok ? inv : null;
}

// ------------------------------------------------------------- workflows

// Conditions known to be true on a pull request in this repository.
const PR_CONDITIONS = new Set([
  'true',
  'success()',
  "github.event_name == 'pull_request'",
  "github.repository == 'Open-Smart-Irrigation/osi-os'",
]);

// Why a workflow does not run on every pull request, or null.
function pullRequestGap(on) {
  const missing = 'the workflow has no pull_request trigger';
  if (typeof on === 'string') return on === 'pull_request' ? null : missing;
  if (Array.isArray(on)) return on.includes('pull_request') ? null : missing;
  if (!on || typeof on !== 'object' || !Object.prototype.hasOwnProperty.call(on, 'pull_request')) return missing;
  const pr = on.pull_request;
  if (pr && typeof pr === 'object') {
    if (pr.paths !== undefined || pr['paths-ignore'] !== undefined) return 'its pull_request trigger has a path filter';
    if (pr.types !== undefined) {
      const types = Array.isArray(pr.types) ? pr.types : [pr.types];
      if (!types.includes('opened') || !types.includes('synchronize')) return 'its pull_request trigger skips opened or synchronize';
    }
  }
  return null;
}

function judgeIf(value, gate) {
  if (value === undefined || value === null) return;
  const expr = String(value).trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
  if (expr === 'false') gate.blocked = gate.blocked || 'if: false';
  else if (!PR_CONDITIONS.has(expr)) gate.undecidable.push(`cannot decide whether if: ${expr} runs on a pull request`);
}

function judgeContinueOnError(value, gate) {
  if (value === undefined || value === null || String(value) === 'false') return;
  if (String(value) === 'true') gate.blocked = gate.blocked || 'continue-on-error: true';
  else gate.undecidable.push(`cannot decide whether continue-on-error: ${value} is false`);
}

function loadWorkflows(root, errors) {
  const dir = path.join(root, WORKFLOW_DIR);
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    names = [];
  }
  if (!names.length) {
    errors.push(`${WORKFLOW_DIR}: no workflow files`);
    return [];
  }
  const steps = [];
  for (const name of names) {
    const rel = `${WORKFLOW_DIR}/${name}`;
    let doc;
    try {
      doc = parseYaml(fs.readFileSync(path.join(root, rel), 'utf8'), name);
    } catch (err) {
      errors.push(`${rel}: ${err.message}`);
      continue;
    }
    const where = (msg) => errors.push(`${name}: ${msg}`);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.jobs || typeof doc.jobs !== 'object' || Array.isArray(doc.jobs)) {
      where('no jobs mapping');
      continue;
    }
    const wfDir = doc.defaults && doc.defaults.run && doc.defaults.run['working-directory'];
    const wfShell = doc.defaults && doc.defaults.run && doc.defaults.run.shell;
    const prGap = pullRequestGap(doc.on);
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) { where(`job ${jobName} is not a mapping`); continue; }
      if (job.uses && !job.steps) continue; // reusable workflow call
      if (!Array.isArray(job.steps) || !job.steps.length) { where(`job ${jobName} has no steps`); continue; }
      const jobDir = job.defaults && job.defaults.run && job.defaults.run['working-directory'];
      const jobShell = job.defaults && job.defaults.run && job.defaults.run.shell;
      job.steps.forEach((step, idx) => {
        const label = `job ${jobName} step ${idx + 1}`;
        if (!step || typeof step !== 'object' || Array.isArray(step)) { where(`${label} is not a mapping`); return; }
        const hasRun = typeof step.run === 'string';
        const hasUses = typeof step.uses === 'string';
        if (hasRun === hasUses) {
          where(hasRun ? `${label} has both run and uses` : `${label} has neither run nor uses`);
          return;
        }
        // gate.blocked: why the step cannot fail a pull request;
        // gate.undecidable: what the verifier cannot judge.
        const gate = { blocked: prGap, undecidable: [] };
        judgeIf(job.if, gate);
        judgeContinueOnError(job['continue-on-error'], gate);
        judgeIf(step.if, gate);
        judgeContinueOnError(step['continue-on-error'], gate);
        const shell = step.shell || jobShell || wfShell;
        if (shell !== undefined && shell !== null && shell !== 'bash' && shell !== 'sh') gate.undecidable.push(`shell ${shell} is not modelled`);
        steps.push({
          file: name,
          label,
          uses: step.uses,
          with: step.with || {},
          run: step.run,
          dir: step['working-directory'] || jobDir || wfDir || '.',
          pipefail: shell === 'bash',
          gate,
        });
      });
    }
  }
  return steps;
}

// ------------------------------------------------------------- npm scripts

function npmCollection(ctx, pkgDir, scriptName, where, add, stack = []) {
  const { root, tracked, errors } = ctx;
  const pkgRel = relPath(root, '.', path.join(pkgDir, 'package.json'));
  if (stack.includes(scriptName)) { errors.push(`${where}: npm script "${scriptName}" calls itself`); return; }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, pkgRel), 'utf8'));
  } catch {
    errors.push(`${where}: cannot read ${pkgRel}`);
    return;
  }
  const script = pkg.scripts && pkg.scripts[scriptName];
  if (typeof script !== 'string') { errors.push(`${where}: npm script "${scriptName}" not found in ${pkgRel}`); return; }
  const here = `${where} (${pkgRel} "${scriptName}")`;
  let commands;
  try {
    commands = shellCommands(script);
  } catch (err) {
    errors.push(`${here}: ${err.message}`);
    return;
  }
  const pkgPrefix = relPath(root, '.', pkgDir);
  const inRoot = pkgPrefix === '';
  const pkgFiles = [...tracked].filter((f) => inRoot || f.startsWith(`${pkgPrefix}/`));
  const inPkg = (f) => (inRoot ? f : f.slice(pkgPrefix.length + 1));
  const fromPkg = (f) => (inRoot ? f : `${pkgPrefix}/${f}`);
  for (const words of commands) {
    const w = words.filter((x, idx) => !(idx === 0 && /^\w+=/.test(x)));
    if (w[0] === 'npm' && (w[1] === 'run' || w[1] === 'run-script')) {
      npmCollection(ctx, pkgDir, w[2], where, add, [...stack, scriptName]);
    } else if (w[0] === 'vitest' || (w[0] === 'npx' && w[1] === 'vitest')) {
      const args = w.slice(w[0] === 'npx' ? 2 : 1);
      if (args[0] !== 'run') { errors.push(`${here}: vitest without "run" watches instead of exiting`); continue; }
      const filters = [];
      for (const a of args.slice(1)) {
        if (/^--pass-?with-?no-?tests/i.test(a)) errors.push(`${here}: --passWithNoTests lets vitest pass with no tests`);
        else if (a.startsWith('-')) errors.push(`${here}: vitest option ${a} is not modelled by this verifier`);
        else filters.push(a);
      }
      for (const cfg of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs']) {
        const cfgPath = path.join(root, pkgDir, cfg);
        if (fs.existsSync(cfgPath) && /\b(include|exclude|dir|root)\s*:/.test(fs.readFileSync(cfgPath, 'utf8'))) {
          errors.push(`${here}: ${cfg} sets include/exclude/dir/root, which this verifier does not model`);
        }
      }
      const candidates = pkgFiles.filter((f) => VITEST_INCLUDE.test(f) && !/(^|\/)node_modules\//.test(f));
      if (!filters.length) {
        candidates.forEach((f) => add(f, `${here} vitest`));
        continue;
      }
      for (const filter of filters) {
        const needle = filter.toLowerCase();
        const hits = candidates.filter((f) => inPkg(f).toLowerCase().includes(needle));
        if (!hits.length) errors.push(`${here}: vitest filter ${filter} matches no test file`);
        hits.forEach((f) => add(f, `${here} vitest`));
      }
    } else if (w[0] === 'node' && w[1] === TSX_RUNNER) {
      if (!tracked.has(fromPkg(TSX_RUNNER))) errors.push(`${here}: ${TSX_RUNNER} is not a tracked file`);
      const globs = w.slice(2);
      if (!globs.length) errors.push(`${here}: ${TSX_RUNNER} without patterns`);
      for (const g of globs) {
        const hits = pkgFiles.filter((f) => matchesGlob(inPkg(f), g));
        if (!hits.length) errors.push(`${here}: ${g} matches no tracked file`);
        hits.forEach((f) => add(f, `${here} ${TSX_RUNNER}`));
      }
    } else if (w[0] === 'tsx' || (w[0] === 'node' && w.includes('--test'))) {
      errors.push(`${here}: ${w[0]} --test: collect tests through ${TSX_RUNNER}, which fails on a pattern that matches nothing`);
    }
  }
}

// ------------------------------------------------------------- checks

const NODE_SKIP = new Set(['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help']);
const NODE_RUN_OPTIONS = /^(--test|--no-warnings|--trace-warnings|--test-concurrency=\S+|--test-timeout=\S+|--test-reporter=\S+|--test-reporter-destination=\S+|--experimental-[\w-]+)$/;
const NODE_PARTIAL_OPTIONS = /^(--check|-c|--test-name-pattern(=.*)?|--test-skip-pattern(=.*)?|--test-only)$/;
const CONDITION_WORDS = new Set(['if', 'elif', 'while', 'until', '!']);

// Why a failing command would not fail the step under bash -e, or null.
function exitStatusLost(commands, i, pipefail) {
  const { sep } = commands[i];
  if (sep === '||') return 'its exit status is discarded (||)';
  if (sep === '&') return 'it runs in the background (&)';
  if (sep === '|' && !pipefail) return 'it feeds a pipe without pipefail';
  if (sep === '&&') {
    // bash -e ignores a failure inside an && list unless the list ends the script.
    let k = i;
    while (k < commands.length - 1 && (commands[k].sep === '&&' || commands[k].sep === '|')) k += 1;
    const tail = commands[k].sep;
    if (tail === '||') return 'its exit status is discarded (||)';
    if (tail === '&') return 'it runs in the background (&)';
    if (k < commands.length - 1) return 'it is followed by && and is not the last command of the script, so bash -e ignores its failure';
  }
  return null;
}

function checkRunStep(ctx, step) {
  const { root, tracked, errors } = ctx;
  const where = `${step.file}: ${step.label}`;
  let commands;
  try {
    commands = shellScript(step.run);
  } catch (err) {
    errors.push(`${where}: ${err.message}`);
    return;
  }
  const hits = []; // { file, via, lost }
  const resolveToken = (token, mode) => {
    if (token.includes('$') || token.includes('__EXPR__') || token.startsWith('/')) return null;
    if (!SCRIPT_EXT.test(token)) {
      if (mode === 'test') errors.push(`${where}: node --test argument ${token} is not a test file path`);
      return null;
    }
    if (GLOB_CHARS.test(token)) {
      errors.push(`${where}: ${token}: glob in a test command; list each file`);
      return null;
    }
    const rel = relPath(root, step.dir, token);
    if (!tracked.has(rel)) {
      errors.push(`${where}: ${rel}: not a tracked file`);
      return null;
    }
    return rel;
  };
  // Arguments after a script: a test file there is data for that script.
  const scriptArgs = (scriptRel, args, lost) => {
    for (const a of args) {
      if (a.startsWith('-')) continue;
      const rel = resolveToken(a, 'arg');
      if (!rel) continue;
      if (scriptRel === RUN_MODULE_TESTS) hits.push({ file: rel, via: where, lost });
      else if (isTestFile(rel)) hits.push({ file: rel, via: where, lost: lost || `it is passed as an argument to ${scriptRel}, which is not a test runner` });
    }
  };
  let pipefail = step.pipefail;
  let errexitOff = false;
  commands.forEach((command, i) => {
    let words = command.words;
    let lost = null;
    while (words.length && (SHELL_KEYWORDS.has(words[0]) || /^\w+=/.test(words[0]))) {
      if (CONDITION_WORDS.has(words[0])) lost = lost || `its exit status is the condition of ${words[0]}`;
      words = words.slice(1);
    }
    if (!words.length) return;
    lost = lost || exitStatusLost(commands, i, pipefail);
    const [cmd, ...args] = words;
    if (cmd === 'set') {
      for (let k = 0; k < args.length; k += 1) {
        const a = args[k];
        if (/^\+[a-z]*e/.test(a) || (a.startsWith('+') && args[k + 1] === 'errexit')) errexitOff = true;
        if (/^-[a-z]*o$/.test(a) && args[k + 1] === 'pipefail') pipefail = true;
        if (/^\+[a-z]*o$/.test(a) && args[k + 1] === 'pipefail') pipefail = false;
      }
      return;
    }
    if (errexitOff) lost = lost || 'set +e turns off exit on error before it';
    if (cmd === 'npm') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (['install', 'i', 'add', 'update', 'upgrade', 'isntall', 'in'].includes(sub)) errors.push(`${where}: npm ${sub}: use npm ci so the lockfile decides`);
      if (args.includes('--legacy-peer-deps')) errors.push(`${where}: --legacy-peer-deps is not allowed`);
      if (args.includes('--force')) errors.push(`${where}: --force is not allowed`);
      const add = (file, via) => hits.push({ file, via, lost });
      if (sub === 'run' || sub === 'run-script') npmCollection(ctx, step.dir, args[args.indexOf(sub) + 1], where, add);
      else if (sub === 'test' || sub === 't') npmCollection(ctx, step.dir, 'test', where, add);
      return;
    }
    if (cmd === 'node') {
      if (args.some((a) => NODE_SKIP.has(a))) return;
      let k = 0;
      const options = [];
      while (k < args.length && args[k].startsWith('-')) options.push(args[k++]);
      const rest = args.slice(k);
      let partial = null;
      for (const o of options) {
        if (NODE_PARTIAL_OPTIONS.test(o)) partial = partial || `node option ${o.split('=')[0]} does not run every test in the file`;
        else if (!NODE_RUN_OPTIONS.test(o)) errors.push(`${where}: node option ${o} is not modelled by this verifier`);
      }
      const itemLost = lost || partial;
      if (options.includes('--test')) {
        if (!rest.length) errors.push(`${where}: node --test without explicit test files collects whatever matches`);
        for (const a of rest) {
          if (a.startsWith('-')) { errors.push(`${where}: node option ${a} after the test files is not modelled`); continue; }
          const rel = resolveToken(a, 'test');
          if (rel) hits.push({ file: rel, via: where, lost: itemLost });
        }
        return;
      }
      if (!rest.length) return;
      const scriptRel = resolveToken(rest[0], 'script');
      if (scriptRel) hits.push({ file: scriptRel, via: where, lost: itemLost });
      scriptArgs(scriptRel || rest[0], rest.slice(1), itemLost);
      return;
    }
    if (cmd === 'sh' || cmd === 'bash') {
      if (args.includes('-c')) { errors.push(`${where}: ${cmd} -c is not supported; call a script file`); return; }
      const idx = args.findIndex((a) => !a.startsWith('-'));
      if (idx < 0) return;
      const scriptRel = resolveToken(args[idx], 'script');
      if (scriptRel && cmd === 'sh') {
        // sh is dash on Debian and Ubuntu runners; a bash script fails there.
        const firstLine = fs.readFileSync(path.join(root, scriptRel), 'utf8').split('\n', 1)[0];
        if (/^#!.*\bbash\b/.test(firstLine)) errors.push(`${where}: ${scriptRel}: a bash script (shebang ${firstLine.slice(2).trim()}) run with sh; run it with bash`);
      }
      if (scriptRel) hits.push({ file: scriptRel, via: where, lost });
      scriptArgs(scriptRel || args[idx], args.slice(idx + 1), lost);
      return;
    }
    if (SCRIPT_EXT.test(cmd) && cmd.includes('/')) {
      const scriptRel = resolveToken(cmd, 'script');
      if (scriptRel) hits.push({ file: scriptRel, via: where, lost });
      scriptArgs(scriptRel || cmd, args, lost);
    }
  });
  if (hits.length && step.gate.undecidable.length) {
    for (const msg of step.gate.undecidable) errors.push(`${where}: ${msg}`);
  }
  for (const h of hits) {
    const reason = step.gate.blocked || (step.gate.undecidable.length ? step.gate.undecidable[0] : null) || h.lost;
    if (reason) ctx.notRun(h.file, h.via, reason);
    else ctx.reference(h.file, h.via);
  }
}

function checkSetupNode(ctx, step) {
  const where = `${step.file}: ${step.label}`;
  if (step.with['node-version-file'] !== undefined) {
    ctx.errors.push(`${where}: node-version-file is not supported; pin node-version`);
    return;
  }
  const v = step.with['node-version'];
  if (v === undefined || v === null) {
    ctx.errors.push(`${where}: setup-node without node-version`);
    return;
  }
  if (!/^\d+(\.\d+){0,2}$/.test(String(v))) ctx.errors.push(`${where}: node-version ${v} is not a pinned version (use a major such as '22')`);
}

function verify(root) {
  const errors = [];
  let tracked;
  try {
    tracked = trackedFiles(root);
  } catch (err) {
    return { errors: [`git ls-files failed: ${err.message}`], stats: {}, status: new Map() };
  }
  const inventory = loadInventory(root, errors);
  const steps = loadWorkflows(root, errors);
  const discovered = [...tracked].filter(isTestFile).sort();
  const discoveredSet = new Set(discovered);
  const status = new Map(); // test file -> { kind, via }
  const referenced = new Set(); // any tracked script a blocking step runs
  const notRun = new Map(); // file -> where it is named without being able to fail a pull request
  const ctx = {
    root,
    tracked,
    errors,
    mark(file, via) {
      if (discoveredSet.has(file) && !status.has(file)) status.set(file, { kind: 'run', via });
    },
    reference(file, via) {
      referenced.add(file);
      this.mark(file, via);
    },
    notRun(file, via, reason) {
      if (!notRun.has(file)) notRun.set(file, []);
      notRun.get(file).push(`${via}: ${reason}`);
    },
  };
  for (const step of steps) {
    if (step.run !== undefined) checkRunStep(ctx, step);
    else if (/^actions\/setup-node@/.test(step.uses)) checkSetupNode(ctx, step);
  }
  const stats = { found: discovered.length, run: 0, indirect: 0, excluded: 0, workflows: new Set(steps.map((s) => s.file)).size, steps: steps.length };
  if (inventory) {
    // indirect: a runner that a workflow runs, or that is itself run indirectly
    const pending = inventory.indirect.slice();
    const runRunners = new Set(referenced);
    let progressed = true;
    const resolved = new Set();
    while (progressed) {
      progressed = false;
      for (const entry of pending) {
        if (!resolved.has(entry) && runRunners.has(entry.runner)) {
          resolved.add(entry);
          runRunners.add(entry.path);
          progressed = true;
        }
      }
    }
    for (const entry of inventory.indirect) {
      const p = entry.path;
      if (typeof p !== 'string' || typeof entry.runner !== 'string') { errors.push(`${INVENTORY_FILE}: indirect entry needs path and runner`); continue; }
      if (!tracked.has(p)) { errors.push(`${p}: indirect entry names no tracked file`); continue; }
      if (!tracked.has(entry.runner)) { errors.push(`${p}: runner ${entry.runner} is not a tracked file`); continue; }
      if (referenced.has(p)) { errors.push(`${p}: indirect entry is redundant, a workflow runs it directly`); continue; }
      if (!resolved.has(entry)) { errors.push(`${p}: runner ${entry.runner} is not run by any workflow`); continue; }
      const source = fs.readFileSync(path.join(root, entry.runner), 'utf8');
      if (!source.includes(path.basename(p))) { errors.push(`${p}: runner ${entry.runner} does not name it`); continue; }
      if (discoveredSet.has(p) && !status.has(p)) {
        status.set(p, { kind: 'indirect', via: entry.runner });
      }
    }
    for (const entry of inventory.excluded) {
      const hasPath = typeof entry.path === 'string';
      const hasPattern = typeof entry.pattern === 'string';
      const label = hasPath ? entry.path : hasPattern ? entry.pattern : JSON.stringify(entry);
      if (hasPath === hasPattern) { errors.push(`${INVENTORY_FILE}: ${label}: exclusion needs exactly one of path or pattern`); continue; }
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON) { errors.push(`${label}: exclusion needs a reason`); continue; }
      if (ISSUE_CLASS.test(entry.reason.trim()) && !/#\d+/.test(entry.reason)) errors.push(`${label}: a "fails on main" or "slow" exclusion needs an issue reference (#NNN) in its reason`);
      if (hasPath) {
        if (!discoveredSet.has(entry.path)) { errors.push(`${entry.path}: exclusion names no test file`); continue; }
        if (status.has(entry.path)) { errors.push(`${entry.path}: excluded but a workflow runs it`); continue; }
        status.set(entry.path, { kind: 'excluded', via: entry.reason });
        continue;
      }
      const hits = discovered.filter((f) => !status.has(f) && matchesGlob(f, entry.pattern));
      if (!hits.length) { errors.push(`${entry.pattern}: exclusion pattern matches no unrun test file`); continue; }
      hits.forEach((f) => status.set(f, { kind: 'excluded', via: entry.reason }));
    }
  }
  for (const f of discovered) {
    if (status.has(f)) continue;
    const named = notRun.has(f) ? `; it is named in ${notRun.get(f).join('; ')}, so it cannot fail a pull request` : '';
    errors.push(`${f}: no workflow runs this test${named}; run it in a workflow or add it to ${INVENTORY_FILE} with a reason`);
  }
  for (const s of status.values()) {
    if (s.kind === 'run') stats.run += 1;
    else if (s.kind === 'indirect') stats.indirect += 1;
    else stats.excluded += 1;
  }
  return { errors, stats, status };
}

function main(argv) {
  let root = process.cwd();
  let list = false;
  for (const a of argv) {
    if (a.startsWith('--root=')) root = path.resolve(a.slice('--root='.length));
    else if (a === '--list') list = true;
    else {
      console.error(`verify-test-inventory: unknown argument ${a}`);
      return 2;
    }
  }
  const { errors, stats, status } = verify(root);
  if (list) {
    for (const [file, s] of [...status.entries()].sort()) console.log(`${s.kind}\t${file}\t${s.via}`);
  }
  if (errors.length) {
    for (const e of errors) console.error(`verify-test-inventory: ${e}`);
    console.error(`verify-test-inventory: FAIL (${errors.length} problems)`);
    return 1;
  }
  console.log(`verify-test-inventory: OK (${stats.found} test files: ${stats.run} run by workflow steps, ${stats.indirect} run through a listed runner, ${stats.excluded} excluded with a reason; ${stats.steps} steps in ${stats.workflows} workflows)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseYaml, shellCommands, isTestFile, verify, main };
