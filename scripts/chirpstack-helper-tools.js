'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// shfmt's typed AST covers substitutions, pipelines and quoted recovery code.
// https://github.com/mvdan/sh/blob/v3.10.0/cmd/shfmt/shfmt.1.scd
function parse(source) {
  const r = spawnSync('shfmt', ['-ln', 'posix', '--to-json'], {
    input: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`shfmt parser failed: ${r.error?.message || r.stderr}`);
  return JSON.parse(r.stdout);
}
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(n => walk(n, fn));
    else if (value && typeof value === 'object') walk(value, fn);
  }
}
function word(node, symbolic = false) {
  if (!node) return null;
  if (node.Type === 'Lit' || node.Type === 'SglQuoted') return node.Value;
  if (node.Type === 'ParamExp') return symbolic ? 'osi_static_value' : null;
  if (node.Parts) {
    const parts = node.Parts.map(n => word(n, symbolic));
    return parts.some(p => p === null) ? null : parts.join('');
  }
  return null;
}
const builtins = new Set(': [ test echo printf read set shift trap exit return exec command true false break continue umask'.split(' '));

function collectCommands(source) {
  const ast = parse(source);
  // Reconstruct every emitted branch in source order. Symbolic path/hash
  // arguments remain words; executable names must remain statically known.
  let emitting = false;
  const emitted = [];
  let recoveryFunction = false;
  walk(ast, node => {
    if (node.Type === 'FuncDecl' && node.Name.Value === 'report_recovery') recoveryFunction = true;
    if (emitting && node.Type === 'CallExpr' && ['printf', 'echo'].includes(word(node.Args?.[0]))) {
      throw new Error('recovery output must use the audited log/heredoc emitter');
    }
    if (emitting && node.Cmd?.Type === 'CallExpr' && word(node.Cmd.Args?.[0]) === 'cat' && !node.Redirs?.some(r => r.Hdoc)) {
      throw new Error('recovery cat requires an auditable heredoc');
    }
    if (node.Type === 'CallExpr' && word(node.Args?.[0]) === 'log') {
      const value = word(node.Args?.[1], true);
      if (value === 'BEGIN RECOVERY COMMANDS') emitting = true;
      else if (value === 'END RECOVERY COMMANDS') emitting = false;
      else if (emitting) {
        if (node.Args.length !== 2) throw new Error('recovery log must have one audited word');
        if (value === null) throw new Error('unrecognized recovery emitter');
        emitted.push(value);
      }
    }
    if (emitting && node.Hdoc) {
      const body = word(node.Hdoc, true);
      if (body === null) throw new Error('unresolved recovery heredoc');
      emitted.push(body);
    }
  });
  if (emitting || (recoveryFunction && !emitted.length)) throw new Error('missing or unterminated recovery emitter');
  const trees = [ast, ...(emitted.length ? [parse(emitted.join('\n'))] : [])];
  const functions = new Set();
  const variables = new Map();
  for (const tree of trees) walk(tree, node => {
    if (node.Type === 'FuncDecl') functions.add(node.Name.Value);
    // Assignments have no Type tag in shfmt's JSON representation.
    if (node.Name?.Value && node.Value?.Parts) {
      const value = word(node.Value);
      if (value) {
        if (!variables.has(node.Name.Value)) variables.set(node.Name.Value, new Set());
        variables.get(node.Name.Value).add(value);
      }
    }
  });
  const commands = new Set();
  function add(name) {
    if (!functions.has(name) && !builtins.has(name)) commands.add(name);
  }
  for (const tree of trees) walk(tree, node => {
    if (node.Type !== 'CallExpr' || !node.Args?.length) return;
    const first = node.Args[0];
    const name = word(first);
    if (name === null) {
      const dynamic = first.Parts?.[0]?.Parts?.[0] || first.Parts?.[0];
      const candidates = dynamic?.Type === 'ParamExp' && variables.get(dynamic.Param?.Value);
      if (!candidates?.size) throw new Error('unresolved dynamic helper command');
      candidates.forEach(add);
    } else {
      add(name);
      if (name === 'command') {
        const availability = ['-v', '-V'].includes(word(node.Args[1]));
        const args = node.Args.slice(1).filter(arg => !['-v', '-V', '-p', '--'].includes(word(arg)));
        for (const arg of availability ? args : args.slice(0, 1)) {
          const candidate = word(arg);
          if (!candidate) throw new Error('unresolved command availability or execution');
          add(candidate);
        }
      }
      // Require an explicit parser extension before introducing a wrapper
      // whose arguments can execute commands beyond the parsed CallExpr.
      if (['env', 'xargs', 'timeout', 'sh', 'ash', 'bash', 'dash'].includes(name) ||
          (name === 'find' && node.Args.some(arg => ['-exec', '-execdir'].includes(word(arg))))) {
        throw new Error('execution wrapper requires command-provider audit: ' + name);
      }
      if (name === 'exec' && node.Args.length > 1) {
        const target = word(node.Args[1]);
        if (!target || target.startsWith('-')) throw new Error('unresolved exec target');
        add(target);
      }
      if (name === 'trap') {
        const action = word(node.Args[1]);
        if (action && action !== '-') collectCommands(action).forEach(add);
      }
    }
  });
  return commands;
}
function configValues(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const set = /^(CONFIG_[A-Za-z0-9_-]+)=(y|m|n)$/.exec(line);
    const unset = /^# (CONFIG_[A-Za-z0-9_-]+) is not set$/.exec(line);
    if (set) values.set(set[1], set[2]);
    else if (unset) values.set(unset[1], 'n');
  }
  return values;
}
function busyboxDefaults(text) {
  const values = new Map();
  for (const block of text.split(/(?=^config )/m)) {
    const name = /^config (BUSYBOX_DEFAULT_\w+)$/m.exec(block)?.[1];
    // Conditional defaults require an explicit board selection; do not guess.
    const value = /^\s*default ([yn])\s*$/m.exec(block)?.[1];
    if (name && value && !/^\s*default .*\bif\b/m.test(block)) values.set('CONFIG_' + name, value);
  }
  return values;
}
const packages = { service: 'procd', sqlite3: 'sqlite3-cli' };
function missingCommands(commands, config, defaults) {
  const custom = config.get('CONFIG_BUSYBOX_CUSTOM') === 'y';
  return [...commands].filter(command => {
    const applet = command.toUpperCase().replaceAll('-', '_');
    const option = 'CONFIG_BUSYBOX_' + (custom ? 'CONFIG_' : 'DEFAULT_') + applet;
    const selected = config.get(option) ?? (!custom ? defaults.get(option) : undefined);
    const busybox = config.get('CONFIG_PACKAGE_busybox') === 'y' && selected === 'y';
    const packaged = packages[command] && config.get('CONFIG_PACKAGE_' + packages[command]) === 'y';
    return !busybox && !packaged;
  }).sort();
}
function auditRepo(root) {
  const feed = path.join(root, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack/files');
  const commands = new Set();
  for (const name of ['backup', 'restore']) collectCommands(fs.readFileSync(path.join(feed, name + '.sh'), 'utf8')).forEach(c => commands.add(c));
  const defaults = busyboxDefaults(fs.readFileSync(path.join(root, 'openwrt/package/utils/busybox/Config-defaults.in'), 'utf8'));
  const results = {};
  for (const board of ['bcm2712', 'bcm2709']) {
    const config = configValues(fs.readFileSync(path.join(root, `conf/full_raspberrypi_bcm27xx_${board}/.config`), 'utf8'));
    results[board] = missingCommands(commands, config, defaults);
  }
  // Pin the service provider as well as its package selection.
  const procd = path.join(root, 'openwrt/package/system/procd');
  if (!fs.existsSync(path.join(procd, 'files/service')) ||
      !fs.readFileSync(path.join(procd, 'Makefile'), 'utf8').includes('./files/service $(1)/sbin/')) {
    throw new Error('procd service installation must be re-audited');
  }
  return { commands: [...commands].sort(), missing: results };
}
module.exports = { collectCommands, configValues, busyboxDefaults, missingCommands, auditRepo };
