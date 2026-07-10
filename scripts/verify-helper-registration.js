#!/usr/bin/env node
'use strict';
// verify-helper-registration — refactor-program 1.A1, spec §D2.
// Closes issue #99's root-cause CLASS at merge time: a helper module that exists
// in the tree but is unregistered in any delivery surface fails CI here, so the
// next seam module cannot repeat #99. Helper modules (runtime package.json
// `file:` deps ∪ non-codec osi-lib NAME_TO_PATH entries) need all three surfaces;
// codec NAME_TO_PATH entries ride the wholesale codecs copy and only need their
// deploy.sh fetch line + the file on disk.
const fs = require('fs');
const path = require('path');

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
  const loop = seedSource.match(/^for module in (.+); do$/m);
  if (!loop || !loop[1].split(/\s+/).includes(name)) {
    issues.push(name + ': missing from 98_osi_node_red_seed module-copy loop');
  }
  if (!deploySource.includes('/srv/node-red/' + name + '/package.json')) {
    issues.push(name + ': missing package.json fetch_required in deploy.sh');
  }
  if (!deploySource.includes('/srv/node-red/' + name + '/index.js')) {
    issues.push(name + ': missing index.js fetch_required in deploy.sh');
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

function inspectModuleDir(nodeRedDir, name) {
  const dir = path.join(nodeRedDir, name);
  if (!fs.existsSync(dir)) return { hasDir: false };
  let mainName = 'index.js';
  let hasPackageJson = false;
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    hasPackageJson = true;
    try { mainName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main || 'index.js'; } catch (_) {}
  }
  return { hasDir: true, hasPackageJson, hasMain: fs.existsSync(path.join(dir, mainName)), mainName };
}

function run() {
  const repo = path.resolve(__dirname, '..');
  const deploySource = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const nameToPath = require(path.join(repo, PROFILES[0], 'files/usr/share/node-red/osi-lib')).NAME_TO_PATH;
  const failures = [];
  for (const profile of PROFILES) {
    const nodeRedDir = path.join(repo, profile, 'files/usr/share/node-red');
    const packageJson = JSON.parse(fs.readFileSync(path.join(nodeRedDir, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(nodeRedDir, 'package-lock.json'), 'utf8'));
    const seedSource = fs.readFileSync(path.join(repo, profile, 'files/etc/uci-defaults/98_osi_node_red_seed'), 'utf8');
    for (const name of collectHelperNames({ packageJson, nameToPath })) {
      const issues = checkSurfaces({
        name, packageJson, packageLock, seedSource, deploySource,
        moduleDir: inspectModuleDir(nodeRedDir, name),
      });
      if (issues.length) failures.push(...issues.map((i) => '[' + profile + '] ' + i));
      else console.log('OK [' + profile + '] ' + name);
    }
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
module.exports = { collectHelperNames, checkSurfaces, checkCodecs };
