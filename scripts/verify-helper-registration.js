#!/usr/bin/env node
'use strict';
// verify-helper-registration — refactor-program 1.A1, spec §D2.
// Closes issue #99's root-cause CLASS at merge time: a helper module that exists
// in the tree but is unregistered in any delivery surface fails CI here, so the
// next seam module cannot repeat #99. Helper modules (runtime package.json
// `file:` deps ∪ non-codec osi-lib NAME_TO_PATH entries) need all three surfaces;
// codec NAME_TO_PATH entries ride the wholesale codecs copy and only need their
// deploy.sh fetch line + the file on disk.
// It also checks the caller side: every name a function node passes to its
// osi-lib loader must be a NAME_TO_PATH key (checkCallerNames, #564).
const fs = require('fs');
const path = require('path');
const { maskNonCode } = require('./verify-flows-output-arity');

const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];

function collectHelperNames({ packageJson, nameToPath }) {
  const names = new Set();
  for (const [dep, spec] of Object.entries(packageJson.dependencies || {})) {
    if (String(spec).startsWith('file:')) names.add(dep);
  }
  for (const rel of Object.values(nameToPath)) {
    if (!rel.startsWith('codecs/')) names.add(rel);
  }
  return [...names].sort();
}

function checkRegistryParity(canonicalNameToPath, profileNameToPath) {
  const canonical = Object.entries(canonicalNameToPath).sort();
  const profile = Object.entries(profileNameToPath).sort();
  return JSON.stringify(canonical) === JSON.stringify(profile)
    ? []
    : ['osi-lib NAME_TO_PATH differs from the canonical bcm2712 registry'];
}

// Helpers that deploy.sh delivers through a pinned staging path instead of a
// direct fetch_required into /srv/node-red. osi-command-ledger has a top-level
// require() on the WATERMARK binding, so deploy.sh fetches the pair into a
// private stage directory, checks each file against a committed SHA-256 pin,
// and activates it only after the schema migration. Each part of that path is
// asserted, so a module delivered by neither path still fails.
const STAGED_DELIVERY = {
  'osi-command-ledger': {
    stageDir: '$COMMAND_LEDGER_STAGE',
    pins: { 'package.json': 'COMMAND_LEDGER_PACKAGE_SHA256', 'index.js': 'COMMAND_LEDGER_INDEX_SHA256' },
    stageFn: 'stage_command_ledger_dependency',
    activateFn: 'activate_command_ledger_dependency',
  },
};

function shellFunctionDefined(source, fn) {
  return new RegExp('^' + fn + '\\(\\)\\s*\\{', 'm').test(source);
}

function shellFunctionCalled(source, fn) {
  return new RegExp('^\\s*(?:if\\s+!\\s+)?' + fn + '(?:\\s*(?:\\|\\||;|$))', 'm').test(source);
}

function stagedDeliveryIssues(name, deploySource) {
  const spec = STAGED_DELIVERY[name];
  if (!spec) return null;
  const issues = [];
  for (const [file, pinVar] of Object.entries(spec.pins)) {
    if (!deploySource.includes('"' + spec.stageDir + '/' + name + '/' + file + '"')) {
      issues.push(name + ': missing staged ' + file + ' fetch into ' + spec.stageDir + ' in deploy.sh');
    }
    if (!new RegExp('^' + pinVar + '="[0-9a-f]{64}"$', 'm').test(deploySource)) {
      issues.push(name + ': missing ' + pinVar + ' digest pin in deploy.sh');
    }
  }
  for (const fn of [spec.stageFn, spec.activateFn]) {
    if (!shellFunctionDefined(deploySource, fn)) issues.push(name + ': deploy.sh does not define ' + fn);
    if (!shellFunctionCalled(deploySource, fn)) issues.push(name + ': deploy.sh never calls ' + fn);
  }
  return issues;
}

function checkSurfaces({ name, packageJson, packageLock, seedSource, deploySource, moduleDir }) {
  const issues = [];
  if ((packageJson.dependencies || {})[name] !== 'file:' + name) {
    issues.push(name + ': missing "file:' + name + '" dep in runtime package.json');
  }
  const pkgs = (packageLock.packages || {});
  if (!(((pkgs[''] || {}).dependencies || {})[name])) {
    issues.push(name + ': missing root dependency entry in package-lock.json');
  }
  if (!pkgs['node_modules/' + name]) {
    issues.push(name + ': missing node_modules link entry in package-lock.json');
  }
  if (!pkgs[name]) {
    issues.push(name + ': missing local package metadata in package-lock.json');
  }
  const loop = seedSource.match(/^for module in (.+); do$/m);
  if (!loop || !loop[1].split(/\s+/).includes(name)) {
    issues.push(name + ': missing from 98_osi_node_red_seed module-copy loop');
  }
  const direct = ['package.json', 'index.js'].filter((file) => deploySource.includes('/srv/node-red/' + name + '/' + file));
  const staged = direct.length === 2 ? null : stagedDeliveryIssues(name, deploySource);
  const stagedReferenced = staged && Object.keys(STAGED_DELIVERY[name].pins)
    .some((file) => deploySource.includes(STAGED_DELIVERY[name].stageDir + '/' + name + '/' + file));
  if (stagedReferenced) {
    issues.push(...staged);
  } else {
    if (!direct.includes('package.json')) issues.push(name + ': missing package.json fetch_required in deploy.sh');
    if (!direct.includes('index.js')) issues.push(name + ': missing index.js fetch_required in deploy.sh');
  }
  if (!moduleDir.hasDir) {
    issues.push(name + ': module directory missing');
    return issues;
  }
  if (!moduleDir.hasPackageJson) issues.push(name + ': module package.json missing');
  if (!moduleDir.hasMain) issues.push(name + ': declared main file (' + moduleDir.mainName + ') missing');
  return issues;
}

function checkCodecs({ nameToPath, deploySource, codecsDir }) {
  const issues = [];
  for (const rel of Object.values(nameToPath)) {
    if (!rel.startsWith('codecs/')) continue;
    const file = rel.slice('codecs/'.length) + '.js';
    if (!deploySource.includes('/srv/node-red/codecs/' + file)) {
      issues.push('codec ' + file + ': missing fetch_required in deploy.sh');
    }
    if (!fs.existsSync(path.join(codecsDir, file))) {
      issues.push('codec ' + file + ': missing under ' + codecsDir);
    }
  }
  return issues;
}

// Caller names (#564): Merge Data called osiLib.require('history-helper'),
// a name no NAME_TO_PATH listed. The loader answered "unknown osi-lib module"
// on every gateway and GET /api/devices dropped rain_day while the package
// itself shipped, because the surface checks above start from the registry
// and never read the callers.
//
// Method: a loader is any variable a function node's `libs` binds to osi-lib.
// maskNonCode (the tokenizer verify-flows-output-arity.js uses; no JS parser
// is vendored here) blanks strings, comments and regex literals, so a call
// quoted in a comment or a string does not count. The argument is then read
// from the original source and must be one plain string literal; anything
// else fails, because its name cannot be checked.
// Blind spots: an alias (`const L = osiLib; L.require(...)`), bracket access
// (`osiLib['require'](...)`), and osiLib used in a node whose libs do not
// declare it are not seen.
const CALLER_SOURCE_FIELDS = ['func', 'initialize', 'finalize'];
const PLAIN_NAME_ARGUMENT = /^\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`)\s*\)/;

function osiLibLoaderVars(node) {
  return (Array.isArray(node.libs) ? node.libs : [])
    .filter((lib) => lib && lib.module === 'osi-lib' && typeof lib.var === 'string' && lib.var)
    .map((lib) => lib.var);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkCallerNames({ flows, nameToPath }) {
  const issues = [];
  let calls = 0;
  for (const node of flows) {
    if (!node || node.type !== 'function') continue;
    const loaders = osiLibLoaderVars(node);
    if (loaders.length === 0) continue;
    const label = node.id + ' (' + (node.name || 'unnamed') + ')';
    for (const field of CALLER_SOURCE_FIELDS) {
      const source = node[field];
      if (typeof source !== 'string' || !source) continue;
      const masked = maskNonCode(source);
      for (const loader of loaders) {
        const call = new RegExp('(?<![\\w$.])' + escapeRegExp(loader) + '\\s*\\??\\.\\s*require\\s*\\(', 'g');
        for (const match of masked.matchAll(call)) {
          calls += 1;
          const rest = source.slice(match.index + match[0].length);
          const literal = rest.match(PLAIN_NAME_ARGUMENT);
          if (!literal) {
            issues.push(label + ' ' + field + ': ' + loader + '.require argument is not one plain string literal: ' +
              JSON.stringify(rest.slice(0, 40)));
            continue;
          }
          const name = literal[1] ?? literal[2] ?? literal[3];
          if (!Object.prototype.hasOwnProperty.call(nameToPath, name)) {
            issues.push(label + ' ' + field + ": '" + name + "' is not a NAME_TO_PATH key");
          }
        }
      }
    }
  }
  return { issues, calls };
}

function inspectModuleDir(nodeRedDir, name, warn = console.warn) {
  const dir = path.join(nodeRedDir, name);
  if (!fs.existsSync(dir)) return { hasDir: false };
  let mainName = 'index.js';
  let hasPackageJson = false;
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    hasPackageJson = true;
    try {
      mainName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main || 'index.js';
    } catch (e) {
      warn('WARN ' + pkgPath + ': could not parse package.json (' + (e && e.message ? e.message : e) + '); defaulting main to index.js');
    }
  }
  return { hasDir: true, hasPackageJson, hasMain: fs.existsSync(path.join(dir, mainName)), mainName };
}

function run() {
  const repo = path.resolve(__dirname, '..');
  const deploySource = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const canonicalNameToPath = require(path.join(repo, PROFILES[0], 'files/usr/share/node-red/osi-lib')).NAME_TO_PATH;
  const failures = [];
  for (const profile of PROFILES) {
    const nodeRedDir = path.join(repo, profile, 'files/usr/share/node-red');
    const nameToPath = require(path.join(nodeRedDir, 'osi-lib')).NAME_TO_PATH;
    const packageJson = JSON.parse(fs.readFileSync(path.join(nodeRedDir, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(nodeRedDir, 'package-lock.json'), 'utf8'));
    const seedSource = fs.readFileSync(path.join(repo, profile, 'files/etc/uci-defaults/98_osi_node_red_seed'), 'utf8');
    const registryIssues = checkRegistryParity(canonicalNameToPath, nameToPath);
    if (registryIssues.length) failures.push(...registryIssues.map((i) => '[' + profile + '] ' + i));
    for (const name of collectHelperNames({ packageJson, nameToPath })) {
      const issues = checkSurfaces({
        name, packageJson, packageLock, seedSource, deploySource,
        moduleDir: inspectModuleDir(nodeRedDir, name),
      });
      if (issues.length) failures.push(...issues.map((i) => '[' + profile + '] ' + i));
      else console.log('OK [' + profile + '] ' + name);
    }
    const flows = JSON.parse(fs.readFileSync(path.join(repo, profile, 'files/usr/share/flows.json'), 'utf8'));
    const callers = checkCallerNames({ flows, nameToPath });
    if (callers.calls === 0) failures.push('[' + profile + '] caller scan found no osi-lib require calls');
    if (callers.issues.length) failures.push(...callers.issues.map((i) => '[' + profile + '] ' + i));
    else console.log('OK [' + profile + '] ' + callers.calls + ' osi-lib caller names are registered');
    const codecIssues = checkCodecs({ nameToPath, deploySource, codecsDir: path.join(nodeRedDir, 'codecs') });
    if (codecIssues.length) failures.push(...codecIssues.map((i) => '[' + profile + '] ' + i));
    else console.log('OK [' + profile + '] codec NAME_TO_PATH entries');
  }
  if (failures.length) {
    for (const f of failures) console.error('FAIL ' + f);
    process.exit(1);
  }
  console.log('All helper-registration checks passed.');
}

if (require.main === module) run();
module.exports = {
  collectHelperNames, checkRegistryParity, checkSurfaces, checkCodecs, inspectModuleDir, checkCallerNames, STAGED_DELIVERY,
};
