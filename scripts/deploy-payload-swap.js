#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function payloadsRoot(root) {
  return path.join(root, 'payloads');
}

function payloadDir(root, stamp) {
  return path.join(payloadsRoot(root), stamp);
}

function flowsLink(root) {
  return path.join(root, 'flows.json');
}

function guiLink(guiRoot) {
  return path.resolve(guiRoot);
}

function guiPayloadDir(root, stamp) {
  return path.join(payloadDir(root, stamp), 'gui');
}

function compatibilityPath(root, stamp) {
  return path.join(payloadDir(root, stamp), 'compatibility.json');
}

function legacyCapturePath(root) {
  return path.join(payloadsRoot(root), '.legacy-capture.json');
}

// Issue S-1 (v0.8.2 review): one link switches every payload entry.
// payloads/active is a link to payloads/<stamp>; flows.json, the GUI and each
// helper-module link point through it (payloads/active/flows.json, ...) and
// stay put once converted. flipTo() switches a payload by renaming one new
// link over payloads/active, so a kill at any instant leaves the complete
// old payload or the complete new one. listStamps() and every stamp check
// here skip the name. It sorts after every timestamp stamp on purpose: the
// prune of an older deploy.sh keeps the newest names, so a downgrade cannot
// remove the link the module links lead through. The first version of this
// layout named it payloads/active; flipTo() converts a gateway that has it.
const ACTIVE = 'active';
const LEGACY_ACTIVE = '.active';

function activeLink(root) {
  return path.join(payloadsRoot(root), ACTIVE);
}

function legacyActiveLink(root) {
  return path.join(payloadsRoot(root), LEGACY_ACTIVE);
}

function viaFlows(root) {
  return path.join(activeLink(root), 'flows.json');
}

function viaGui(root) {
  return path.join(activeLink(root), 'gui');
}

function viaModule(root, name) {
  return path.join(activeLink(root), 'modules', name);
}

function linkedStamp(root, link) {
  let target;
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    target = fs.readlinkSync(link);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
  if (!target || target.includes('/') || target.startsWith('.') || target === ACTIVE) return null;
  return isDirectory(payloadDir(root, target)) ? target : null;
}

// The payload payloads/active (or the first version's payloads/active)
// names, or null when it is absent, is not a plain payload name or names a
// payload that is gone.
function activeStamp(root) {
  if (lstatOrNull(activeLink(root))) return linkedStamp(root, activeLink(root));
  return linkedStamp(root, legacyActiveLink(root));
}

function isStampName(name) {
  return Boolean(name) && !name.startsWith('.') && name !== ACTIVE;
}

// True when <link> is a link whose text leads to <via>, resolvable or not.
function linksTo(link, via) {
  const stat = lstatOrNull(link);
  return Boolean(stat && stat.isSymbolicLink() &&
    path.resolve(path.dirname(link), fs.readlinkSync(link)) === via);
}

// Points payloads/active at <stamp> with one rename.
function pointActive(root, stamp) {
  const link = activeLink(root);
  const tmp = path.join(payloadsRoot(root), `.active-flip-${process.pid}-${Date.now()}`);
  try {
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(stamp, tmp);
    fs.renameSync(tmp, link);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`payload switch to ${stamp}: ${error.message}`);
  }
}

// Helper modules (issue #603). Each payload carries the osi-* modules deploy.sh
// fetched for it under modules/<name>/, and /srv/node-red/<name> is a link into
// the active payload, switched by flipTo() with flows and GUI. modules.json
// lists the payload's module set; a modules/ directory without it is a
// half-fetched payload and is never activated.
const MODULE_NAME = /^osi-[a-z0-9][a-z0-9-]*$/;
// These stay live directories outside every payload: deploy.sh activates the
// command-ledger pair on its own path, after the schema migration commits.
const LIVE_MODULES = ['osi-command-ledger', 'osi-watermark-binding'];
// Everything a payload module reaches through '../<name>' without it being a
// staged module: the command-ledger pair, plus the codecs and
// edge-channels.json that deploy.sh still writes in place
// (osi-sdi12-normalize requires '../edge-channels.json', osi-valve-control
// falls back to '../codecs/'). Node resolves those paths from the payload
// copy's real path, so every payload's modules/ links each one back.
const LIVE_ENTRIES = [...LIVE_MODULES, 'codecs', 'edge-channels.json'];

function modulesDir(root, stamp) {
  return path.join(payloadDir(root, stamp), 'modules');
}

function moduleManifestPath(root, stamp) {
  return path.join(payloadDir(root, stamp), 'modules.json');
}

function moduleLink(root, name) {
  return path.join(root, name);
}

function moduleTarget(root, stamp, name) {
  return path.join(modulesDir(root, stamp), name);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// followLinks hashes a symlink as the file or directory it points to, so a
// dereferenced copy of a module hashes like the original. The GUI evidence
// keeps the strict form: its digests are stored in .legacy-capture.json.
function hashTree(root, { followLinks = false, label = 'legacy capture: unsupported GUI entry' } = {}) {
  const hash = crypto.createHash('sha256');
  const walk = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(current, entry.name);
      const stat = followLinks && entry.isSymbolicLink() ? fs.statSync(child) : entry;
      hash.update(`${stat.isDirectory() ? 'd' : 'f'}:${childRelative}\n`);
      if (stat.isDirectory()) walk(child, childRelative);
      else if (stat.isFile()) hash.update(fs.readFileSync(child));
      else throw new Error(`${label}: ${child}`);
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

function hashModule(dir) {
  return hashTree(dir, { followLinks: true, label: 'module capture: unsupported entry' });
}

function legacyEvidence(flowsPath, guiRoot) {
  if (!fs.existsSync(flowsPath) || !fs.statSync(flowsPath).isFile()) {
    throw new Error(`legacy capture: current flows missing: ${flowsPath}`);
  }
  if (!fs.existsSync(guiRoot) || !fs.statSync(guiRoot).isDirectory()) {
    throw new Error(`legacy capture: current GUI missing: ${guiRoot}`);
  }
  return { flows_path: flowsPath, gui_path: path.resolve(guiRoot), flows_sha256: hashFile(flowsPath), gui_sha256: hashTree(guiRoot) };
}

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

function discardBackup(backup) {
  if (!backup) return;
  try {
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (_) {
    // Keep the backup if cleanup is interrupted; the active link is valid.
  }
}

function stagePayload(root, stamp, srcFlowsPath, srcGuiPath = null) {
  const dir = payloadDir(root, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(srcFlowsPath, path.join(dir, 'flows.json'));
  if (srcGuiPath) {
    if (!fs.existsSync(srcGuiPath) || !fs.statSync(srcGuiPath).isDirectory()) {
      throw new Error(`stagePayload: GUI directory missing: ${srcGuiPath}`);
    }
    copyTree(srcGuiPath, guiPayloadDir(root, stamp));
  }
  return dir;
}

function atomicSymlink(link, target, label, { keepBackup = false } = {}) {
  const parent = path.dirname(link);
  const relativeTarget = path.relative(parent, target);
  const tmp = path.join(parent, `.${path.basename(link)}.flip-${process.pid}-${Date.now()}`);
  let backup = null;
  let previousTarget = null;
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(relativeTarget, tmp);
    // rename(2) replaces a file or link with the new link in one step; a
    // directory cannot be replaced by a link, so it is moved aside first and
    // the path is absent until the link takes its place. A file is kept as a
    // hard link, and its path is never absent.
    let backupIsLink = false;
    try {
      const existing = fs.lstatSync(link);
      if (existing.isSymbolicLink()) previousTarget = fs.realpathSync(link);
      else if (existing.isDirectory()) {
        backup = `${link}.osi-old-${process.pid}-${Date.now()}`;
        fs.renameSync(link, backup);
      } else if (keepBackup) {
        backup = `${link}.osi-old-${process.pid}-${Date.now()}`;
        fs.linkSync(link, backup);
        backupIsLink = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      fs.renameSync(tmp, link);
    } catch (error) {
      if (!backup) throw error;
      if (backupIsLink) fs.rmSync(backup, { force: true });
      else fs.renameSync(backup, link);
      backup = null;
      throw error;
    }
    if (backup && !keepBackup) discardBackup(backup);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if (backup) {
      try {
        fs.renameSync(backup, link);
      } catch (_) {
        // Preserve the original activation error; the caller fails closed.
      }
    }
    throw new Error(`${label}: ${error.message}`);
  }
  return { link, target, backup: keepBackup ? backup : null, previousTarget };
}

function restoreFlippedEntry(result) {
  if (result.previousTarget) {
    atomicSymlink(result.link, result.previousTarget, 'pair flip restore');
    return;
  }
  if (result.backup) {
    if (isDirectory(result.backup)) fs.rmSync(result.link, { force: true, recursive: true });
    fs.renameSync(result.backup, result.link);
    result.backup = null;
    return;
  }
  fs.rmSync(result.link, { force: true, recursive: true });
}

function absent(error) {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

function isDirectory(target) {
  const stat = statOrNull(target);
  return Boolean(stat && stat.isDirectory());
}

function isFile(target) {
  const stat = statOrNull(target);
  return Boolean(stat && stat.isFile());
}

function assertModuleName(name, label) {
  if (typeof name !== 'string' || !MODULE_NAME.test(name)) {
    throw new Error(`${label}: invalid module name: ${JSON.stringify(name)}`);
  }
}

// null when the payload has no module set (a payload from before #603).
function readModuleManifest(root, stamp) {
  const file = moduleManifestPath(root, stamp);
  if (!fs.existsSync(file)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`module manifest unreadable: ${file}: ${error.message}`);
  }
  if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.modules) ||
      !manifest.captured || typeof manifest.captured !== 'object' || Array.isArray(manifest.captured)) {
    throw new Error(`module manifest malformed: ${file}`);
  }
  for (const name of manifest.modules) assertModuleName(name, `module manifest ${file}`);
  return manifest;
}

function writeModuleManifest(root, stamp, manifest) {
  const target = moduleManifestPath(root, stamp);
  const ordered = { format: 1, modules: [...manifest.modules].sort(), captured: {} };
  for (const name of Object.keys(manifest.captured).sort()) ordered.captured[name] = manifest.captured[name];
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(ordered)}\n`, { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return ordered;
}

// The payload a /srv/node-red/<name> link points into, read from the link
// text so a dangling link is still recognised; null for anything else.
function moduleLinkStamp(root, name) {
  const link = moduleLink(root, name);
  const stat = lstatOrNull(link);
  if (!stat || !stat.isSymbolicLink()) return null;
  const resolved = path.resolve(path.dirname(link), fs.readlinkSync(link));
  const parts = path.relative(payloadsRoot(root), resolved).split(path.sep);
  // A link through payloads/active belongs to the active payload while that
  // payload carries the module; otherwise it leads nowhere and counts as absent.
  if (resolved === viaModule(root, name) || resolved === path.join(legacyActiveLink(root), 'modules', name)) {
    const stamp = linkedStamp(root, path.dirname(path.dirname(resolved)));
    return stamp && lstatOrNull(moduleTarget(root, stamp, name)) ? stamp : null;
  }
  if (parts.length !== 3 || parts[1] !== 'modules' || parts[2] !== name ||
      parts[0] === '..' || !isStampName(parts[0])) return null;
  return parts[0];
}

// name -> stamp for every /srv/node-red/osi-* link into a payload.
function payloadModuleLinks(root) {
  const links = new Map();
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (error) {
    if (absent(error)) return links;
    throw error;
  }
  for (const name of entries) {
    if (!MODULE_NAME.test(name)) continue;
    const stamp = moduleLinkStamp(root, name);
    if (stamp) links.set(name, stamp);
  }
  return links;
}

function ensureLiveModuleLinks(root, stamp) {
  const dir = modulesDir(root, stamp);
  for (const name of LIVE_ENTRIES) {
    const link = path.join(dir, name);
    const expected = path.relative(dir, moduleLink(root, name));
    const stat = lstatOrNull(link);
    if (!stat) {
      fs.symlinkSync(expected, link);
    } else if (!stat.isSymbolicLink() || fs.readlinkSync(link) !== expected) {
      throw new Error(`${link} must be a link to the live ${name}, which stays outside the payload`);
    }
  }
}

function moduleSetComplete(root, stamp, manifest) {
  for (const name of manifest.modules) {
    const target = moduleTarget(root, stamp, name);
    const stat = lstatOrNull(target);
    if (!stat || !stat.isDirectory() || !isFile(path.join(target, 'package.json'))) return false;
  }
  for (const name of LIVE_ENTRIES) {
    const dir = modulesDir(root, stamp);
    const stat = lstatOrNull(path.join(dir, name));
    if (!stat || !stat.isSymbolicLink() ||
        fs.readlinkSync(path.join(dir, name)) !== path.relative(dir, moduleLink(root, name))) return false;
  }
  return true;
}

// Seals the modules deploy.sh fetched into payloads/<stamp>/modules/: every
// entry is a module directory with a package.json, the links to the live
// entries are added, and modules.json records the set.
function sealModules(root, stamp) {
  const dir = modulesDir(root, stamp);
  if (!isDirectory(dir)) throw new Error(`sealModules: no staged modules in ${dir}`);
  if (fs.existsSync(moduleManifestPath(root, stamp))) {
    throw new Error(`sealModules: payload ${stamp} is already sealed`);
  }
  const names = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (LIVE_ENTRIES.includes(entry.name)) {
      if (entry.isSymbolicLink()) continue;
      throw new Error(`sealModules: ${entry.name} was staged, but it stays outside the payload`);
    }
    assertModuleName(entry.name, 'sealModules');
    if (!entry.isDirectory()) throw new Error(`sealModules: ${entry.name} is not a module directory`);
    if (!isFile(path.join(dir, entry.name, 'package.json'))) {
      throw new Error(`sealModules: ${entry.name} has no package.json`);
    }
    names.push(entry.name);
  }
  if (!names.length) throw new Error(`sealModules: no staged modules in ${dir}`);
  ensureLiveModuleLinks(root, stamp);
  return writeModuleManifest(root, stamp, { modules: names, captured: {} }).modules;
}

// Copies each live module the new payload replaces into the previous payload,
// so a switch back restores it. Real directories (or links that lead outside
// payloads/) are captured; a link into a payload only when the previous
// payload has no module set yet. Mirrors legacyCaptureStamp(): a module
// captured by an earlier attempt must still match its recorded digest.
// Returns one line per action.
function captureModules(root, prevStamp, deployStamp) {
  const next = readModuleManifest(root, deployStamp);
  if (!next) throw new Error(`captureModules: payload ${deployStamp} has no sealed module set`);
  if (!isDirectory(payloadDir(root, prevStamp))) throw new Error(`captureModules: payload missing: ${prevStamp}`);
  const prev = readModuleManifest(root, prevStamp);
  const manifest = prev ? { modules: [...prev.modules], captured: { ...prev.captured } } : { modules: [], captured: {} };
  const dir = modulesDir(root, prevStamp);
  const lines = [];
  let changed = !prev;
  fs.mkdirSync(dir, { recursive: true });
  // The new payload's modules, and every module served from another payload
  // that the new payload drops (through the flows' payload, payloads/active,
  // or a link an older deploy.sh made): a switch back must restore it too.
  const names = new Set(next.modules);
  for (const [name, linked] of payloadModuleLinks(root)) if (linked !== deployStamp) names.add(name);
  for (const name of [...names].sort()) {
    const live = moduleLink(root, name);
    const stat = lstatOrNull(live);
    if (!stat || (linksTo(live, viaModule(root, name)) && !isDirectory(live))) continue;
    // A link into a payload is part of that payload's module set, unless the
    // previous payload has no module set of its own: the legacy capture after
    // a sysupgrade (it keeps /srv and with it the module links, but not the
    // GUI link) or flows switched by an older deploy.sh. Those flows run the
    // linked copy, so it is captured like a real directory, and a retry checks
    // it against the recorded digest. A dangling link is a module the running
    // flows do not have.
    const linked = stat.isSymbolicLink() ? moduleLinkStamp(root, name) : null;
    if (linked && ((prev && prev.captured[name] === undefined) || linked === prevStamp || !isDirectory(live))) continue;
    if (!isDirectory(live)) throw new Error(`captureModules: live module is not a directory: ${live}`);
    const liveHash = hashModule(live);
    const target = moduleTarget(root, prevStamp, name);
    if (manifest.modules.includes(name)) {
      if (manifest.captured[name] !== undefined) {
        if (manifest.captured[name] !== liveHash) {
          throw new Error(`captureModules: refusing to recapture changed live module ${name} after a prior attempt (payloads/${prevStamp}/modules/${name} holds the earlier copy)`);
        }
      } else if (!isDirectory(target) || hashModule(target) !== liveHash) {
        lines.push(`WARN: ${name} is a directory in ${root} that differs from payloads/${prevStamp}/modules/${name}; the flip replaces it, and a switch back restores the payload copy`);
      }
      continue;
    }
    const temp = path.join(dir, `.${name}.capture-${process.pid}-${Date.now()}`);
    try {
      copyTree(live, temp);
      if (hashModule(temp) !== liveHash) throw new Error(`captureModules: ${live} changed while it was copied`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    manifest.modules.push(name);
    manifest.captured[name] = liveHash;
    changed = true;
    lines.push(`OK: captured ${name} into payloads/${prevStamp}/modules/${name}`);
  }
  ensureLiveModuleLinks(root, prevStamp);
  if (changed) writeModuleManifest(root, prevStamp, manifest);
  return lines.join('\n');
}

// npm install runs before Node-RED stops and needs every file: dependency on
// disk. A module the gateway does not have yet gets a link into the staged
// payload now; the flows that run until the flip cannot reference it. A link
// left by an earlier deploy that exited before cleaning up counts as absent.
function linkNewModules(root, stamp, prevStamp = '') {
  const next = readModuleManifest(root, stamp);
  if (!next) throw new Error(`linkNewModules: payload ${stamp} has no sealed module set`);
  const prev = prevStamp ? readModuleManifest(root, prevStamp) : null;
  const lines = [];
  for (const name of next.modules) {
    const link = moduleLink(root, name);
    let stat = lstatOrNull(link);
    // A link through payloads/active that leads nowhere is a module the
    // running flows do not have, and npm install needs it on disk.
    if (stat && linksTo(link, viaModule(root, name)) && !isDirectory(link)) stat = null;
    const linked = stat && stat.isSymbolicLink() ? moduleLinkStamp(root, name) : null;
    if (stat && (!linked || linked === stamp || linked === prevStamp || (prev && prev.modules.includes(name)))) continue;
    atomicSymlink(link, moduleTarget(root, stamp, name), `link new module ${name}`);
    lines.push(`OK: ${stat ? 'relinked' : 'linked'} ${name} -> payloads/${stamp}/modules/${name} (absent before this deploy)`);
  }
  return lines.join('\n');
}

function removeModuleLinksInto(root, stamp) {
  for (const [name, linked] of payloadModuleLinks(root)) {
    if (linked === stamp) fs.rmSync(moduleLink(root, name), { force: true });
  }
}

// Which module links a flip to <stamp> switches and which it removes.
function moduleFlipPlan(root, stamp) {
  const manifest = readModuleManifest(root, stamp);
  const linked = payloadModuleLinks(root);
  if (!manifest) {
    if (fs.existsSync(modulesDir(root, stamp))) {
      throw new Error(`flipTo: payload ${stamp} has an unsealed modules directory`);
    }
    if (linked.size) {
      throw new Error(`flipTo: payload ${stamp} carries no helper modules, but ${[...linked.keys()].sort().join(', ')} link into payloads`);
    }
    return { link: [], unlink: [] };
  }
  if (!moduleSetComplete(root, stamp, manifest)) {
    throw new Error(`flipTo: staged helper modules incomplete in ${modulesDir(root, stamp)}`);
  }
  return {
    link: manifest.modules,
    unlink: [...linked.keys()].filter((name) => !manifest.modules.includes(name)).sort(),
  };
}

// True when every module link matches the payload's module set.
function modulesActive(root, stamp, manifest) {
  const names = manifest ? manifest.modules : [];
  const linked = payloadModuleLinks(root);
  return names.every((name) => linked.get(name) === stamp) &&
    [...linked.keys()].every((name) => names.includes(name));
}

function resolveStamp(root, link, expectedChild) {
  let resolved;
  let payloadRoot;
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    resolved = fs.realpathSync(link);
    payloadRoot = fs.realpathSync(payloadsRoot(root));
  } catch (_) {
    return null;
  }
  const child = path.dirname(resolved);
  if (expectedChild && path.basename(resolved) !== expectedChild) return null;
  if (path.dirname(child) !== payloadRoot) return null;
  return path.basename(child);
}

function guiStamp(root, guiRoot) {
  return resolveStamp(root, guiLink(guiRoot), 'gui');
}

function restoreSwitched(switched) {
  const failures = [];
  for (const entry of [...switched].reverse()) {
    try {
      restoreFlippedEntry(entry);
    } catch (error) {
      failures.push(`${entry.link}: ${error.message}`);
    }
  }
  return failures;
}

// True when <live> serves the same bytes as <copy>: the same file or
// directory, or an identical copy of it.
function sameContent(live, copy, kind) {
  const liveStat = statOrNull(live);
  const copyStat = statOrNull(copy);
  if (!liveStat || !copyStat) return false;
  if (fs.realpathSync(live) === fs.realpathSync(copy)) return true;
  if (kind === 'file') return liveStat.isFile() && copyStat.isFile() && hashFile(live) === hashFile(copy);
  return liveStat.isDirectory() && copyStat.isDirectory() &&
    hashTree(live, { followLinks: true, label: 'payload switch: unsupported entry' }) ===
    hashTree(copy, { followLinks: true, label: 'payload switch: unsupported entry' });
}

// The live entries a switch to <stamp> routes through payloads/active, with
// the copy each must match in <base>.
function switchEntries(root, stamp, guiRoot, modules, base) {
  const entries = [{ link: flowsLink(root), via: viaFlows(root), copy: base && path.join(payloadDir(root, base), 'flows.json'), kind: 'file', label: 'flows' }];
  if (guiRoot) entries.push({ link: guiLink(guiRoot), via: viaGui(root), copy: base && guiPayloadDir(root, base), kind: 'dir', label: 'GUI' });
  const baseManifest = base ? readModuleManifest(root, base) : null;
  const baseModules = baseManifest ? baseManifest.modules : [];
  const names = new Set([...modules.link, ...modules.unlink, ...baseModules]);
  for (const name of [...names].sort()) {
    const copy = base && baseModules.includes(name) ? moduleTarget(root, base, name) : null;
    const sealed = Boolean(copy && baseManifest.captured[name] === undefined);
    entries.push({ link: moduleLink(root, name), via: viaModule(root, name), copy, sealed, kind: 'dir', label: `module ${name}`, name });
  }
  return entries;
}

// Why <base> cannot stand in for the live entries, or null. Every step before
// the switch points payloads/active at <base> or routes an entry through it,
// so each served entry must already serve <base>'s bytes, with two
// exceptions that are recorded on the entry:
// - no GUI is served at all: routing it restores the payload's GUI;
// - a module <base> carries as its own sealed copy while the flows already
//   run from <base>: a switch into <base> by an older deploy.sh was cut
//   during its module renames (state-table row S7), and routing the module
//   completes that switch, as that deploy.sh would have.
function baseMismatch(root, base, stamp, guiRoot, entries) {
  if (!isFile(path.join(payloadDir(root, base), 'flows.json'))) return `payloads/${base} has no flows.json`;
  if (guiRoot && !isDirectory(guiPayloadDir(root, base))) return `payloads/${base} has no GUI`;
  const flowsInBase = currentStamp(root) === base;
  for (const entry of entries) {
    if (entry.copy) {
      if (sameContent(entry.link, entry.copy, entry.kind)) continue;
      if (entry.label === 'GUI' && !statOrNull(entry.link)) {
        entry.restores = true;
        continue;
      }
      if (entry.sealed && flowsInBase) {
        entry.completes = true;
        continue;
      }
      return `the live ${entry.label} differs from payloads/${base}`;
    }
    // payloads/<base> has no copy: the old flows must not run from the entry.
    // Absent, leading nowhere, or linked into a payload the flows do not run
    // from (a module new in this release, linked early for npm install) is
    // fine; a module the flows' own payload carries is not.
    const stat = lstatOrNull(entry.link);
    if (!stat || !statOrNull(entry.link)) continue;
    if (!stat.isSymbolicLink()) return `the live ${entry.label} is a directory payloads/${base} does not hold`;
    const into = moduleLinkStamp(root, entry.name);
    if (into && into !== base && (into === currentStamp(root) || into === activeStamp(root))) {
      return `the live ${entry.label} belongs to payloads/${into}, which the gateway runs from, and payloads/${base} does not hold it`;
    }
  }
  return null;
}

// No flows are served: Node-RED runs nothing a switch could break.
function nothingServed(entries) {
  return !statOrNull(entries[0].link);
}

// The entry paths a switch can move aside or leave a temporary link for.
function switchPaths(root, guiRoot) {
  const paths = [flowsLink(root)];
  if (guiRoot) paths.push(guiLink(guiRoot));
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const modules = new Set();
  for (const name of names) {
    const base = name.replace(/^\./, '').replace(/\.(osi-old|flip)-.*$/, '');
    if (MODULE_NAME.test(base)) modules.add(base);
  }
  for (const name of [...modules].sort()) paths.push(moduleLink(root, name));
  return paths;
}

// The sibling a killed atomicSymlink() left for <link>: the entry it moved
// aside ("<name>.osi-old-<pid>-<ms>"), newest first, and its temporary links.
function leftovers(link) {
  const dir = path.dirname(link);
  const base = path.basename(link);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const stampOf = (name) => Number(name.split('-').pop()) || 0;
  return {
    aside: names.filter((name) => name.startsWith(`${base}.osi-old-`)).sort((a, b) => stampOf(b) - stampOf(a)).map((name) => path.join(dir, name)),
    temps: names.filter((name) => name.startsWith(`.${base}.flip-`)).map((name) => path.join(dir, name)),
  };
}

// Finishes what a killed switch left behind, before deploy.sh reads the live
// state (and, in a later release, before Node-RED starts):
// - an entry that is absent while the directory or file a switch moved aside
//   lies beside it is moved back, which restores exactly what was served;
//   rename(2) cannot replace a directory with a link, so that window exists
//   once per converted directory, and older deploy.sh versions opened it for
//   files too;
// - leftover temporary links and moved-aside entries beside a present entry
//   are removed, as are temporary payloads/active links.
// Returns the lines deploy.sh prints, or null.
function resumeInterruptedSwitch(root, guiRoot) {
  const lines = [];
  for (const link of switchPaths(root, guiRoot)) {
    const { aside, temps } = leftovers(link);
    for (const temp of temps) fs.rmSync(temp, { force: true });
    if (!lstatOrNull(link) && aside.length) {
      fs.renameSync(aside[0], link);
      lines.push(`WARN: an interrupted switch left ${path.basename(link)} at ${path.basename(aside[0])}; moved it back`);
      aside.shift();
    }
    for (const stale of aside) discardBackup(stale);
  }
  let names = [];
  try {
    names = fs.readdirSync(payloadsRoot(root));
  } catch (error) {
    if (!absent(error)) throw error;
  }
  for (const name of names) {
    if (name.startsWith('.active.flip-') || name.startsWith('.active-flip-')) fs.rmSync(path.join(payloadsRoot(root), name), { force: true });
  }
  return lines.length ? lines.join('\n') : null;
}

// How a switch to <stamp> proceeds: the payload whose bytes the live entries
// serve (the base), the entries to route, and the notes deploy.sh prints.
// Throws when something is served and no payload holds it; deploy.sh calls
// switchPreflight() before Node-RED stops, so that refusal comes first.
function planSwitch(root, stamp, guiRoot, fromStamp) {
  const flowTarget = path.join(payloadDir(root, stamp), 'flows.json');
  if (!fs.existsSync(flowTarget)) {
    throw new Error(`flipTo: staged payload missing: ${flowTarget}`);
  }
  if (guiRoot && !isDirectory(guiPayloadDir(root, stamp))) {
    throw new Error(`flipTo: staged GUI payload missing: ${guiPayloadDir(root, stamp)}`);
  }
  const active = activeStamp(root);
  if (!guiRoot && active && isDirectory(guiPayloadDir(root, active)) && !isDirectory(guiPayloadDir(root, stamp))) {
    throw new Error(`flipTo: payload ${stamp} has no GUI, and switching payloads/active would take the GUI away`);
  }
  if (fromStamp && !isDirectory(payloadDir(root, fromStamp))) {
    throw new Error(`flipTo: rollback payload missing: ${fromStamp}`);
  }
  const modules = moduleFlipPlan(root, stamp);
  // The rollback payload deploy.sh names; the payload .active names; the one
  // the flows link into; the target itself (a rollback before the forward
  // switch began serves the target's own captured bytes).
  const candidates = fromStamp ? [fromStamp] : [...new Set([active, currentStamp(root), stamp].filter(Boolean))];
  const reasons = [];
  for (const base of candidates) {
    const entries = switchEntries(root, stamp, guiRoot, modules, base);
    const mismatch = baseMismatch(root, base, stamp, guiRoot, entries);
    if (!mismatch) {
      const notes = entries.filter((entry) => entry.completes)
        .map((entry) => `WARN: ${entry.label} was left behind by a switch into payloads/${base} that was cut; this switch completes it`);
      return { stamp, base, entries, modules, notes };
    }
    reasons.push(mismatch);
  }
  // No payload holds what is served. With a rollback payload named, that is
  // a refusal. Without one there is nothing to return to anyway (a first
  // deploy, or regular flows without a GUI to capture): the entries are
  // linked one by one, as before payloads/active existed.
  if (fromStamp) throw new Error(`flipTo: ${reasons.join('; ')}; refusing to switch`);
  const entries = switchEntries(root, stamp, guiRoot, modules, null);
  return { stamp, base: null, entries, modules, notes: nothingServed(entries) ? [] :
    ['WARN: no retained payload holds the live flows, GUI and modules; they are replaced one by one'] };
}

// The checks flipTo() makes, without changing anything; deploy.sh runs it
// before Node-RED stops. Returns the lines to print, or null.
function switchPreflight(root, stamp, guiRoot = null, fromStamp = '') {
  const plan = planSwitch(root, stamp, guiRoot, fromStamp);
  return plan.notes.length ? plan.notes.join('\n') : null;
}

// Switches flows, the GUI and the helper modules to <stamp>. <fromStamp> is
// the payload the live entries serve, as deploy.sh captured it (PREV_STAMP).
//
// With such a base, every step before the switch only re-points a live entry
// at an identical copy in it (see baseMismatch() for the two exceptions), and
// the switch is one rename of payloads/active: a kill at any instant leaves
// the complete old payload or the complete new one. Each step is idempotent,
// so a rerun resumes. Without a base (a first deploy, or regular flows with
// no GUI to capture) the entries are linked before payloads/active exists.
function flipTo(root, stamp, guiRoot = null, fromStamp = '') {
  const { base, entries, modules } = planSwitch(root, stamp, guiRoot, fromStamp);
  if (base) {
    if (linkedStamp(root, activeLink(root)) !== base) pointActive(root, base);
    for (const entry of entries) {
      if (!linksTo(entry.link, entry.via)) atomicSymlink(entry.link, entry.via, `${entry.label} link`);
    }
    if (base !== stamp) pointActive(root, stamp);
  } else {
    // With no flows served, the links are made before payloads/active, and a
    // link left from an earlier payload must not bring its flows back first.
    if (!statOrNull(flowsLink(root))) {
      fs.rmSync(activeLink(root), { force: true });
      fs.rmSync(legacyActiveLink(root), { force: true });
    }
    const switched = [];
    try {
      for (const entry of entries) {
        if (entry.name && modules.unlink.includes(entry.name)) continue;
        if (!linksTo(entry.link, entry.via)) switched.push(atomicSymlink(entry.link, entry.via, `${entry.label} link`, { keepBackup: true }));
      }
      pointActive(root, stamp);
    } catch (error) {
      const failures = restoreSwitched(switched);
      if (failures.length) error.message += `; could not restore: ${failures.join('; ')}`;
      throw error;
    }
    for (const entry of switched) discardBackup(entry.backup);
  }
  // Every entry now leads through payloads/active.
  if (lstatOrNull(legacyActiveLink(root))) fs.rmSync(legacyActiveLink(root), { force: true });
  // Links the new payload does not carry now lead nowhere; remove them.
  for (const name of modules.unlink) {
    const stat = lstatOrNull(moduleLink(root, name));
    if (stat && stat.isSymbolicLink()) fs.rmSync(moduleLink(root, name), { force: true });
  }
  const result = { flowsLink: flowsLink(root), target: path.join(payloadDir(root, stamp), 'flows.json') };
  if (guiRoot) Object.assign(result, { guiLink: guiLink(guiRoot), guiTarget: guiPayloadDir(root, stamp) });
  if (modules.link.length || modules.unlink.length) result.modules = modules;
  return result;
}

function currentStamp(root) {
  return resolveStamp(root, flowsLink(root), 'flows.json');
}

function currentPair(root, guiRoot) {
  const flows = currentStamp(root);
  const gui = guiRoot ? guiStamp(root, guiRoot) : null;
  if (!flows || !gui) return null;
  return { flows, gui, compatible: flows === gui };
}

function verifyPair(root, stamp, guiRoot) {
  const flowsTarget = path.join(payloadDir(root, stamp), 'flows.json');
  const guiTarget = guiPayloadDir(root, stamp);
  if (!(fs.existsSync(flowsTarget) && fs.statSync(flowsTarget).isFile() &&
      fs.existsSync(guiTarget) && fs.statSync(guiTarget).isDirectory())) return false;
  let manifest;
  try {
    manifest = readModuleManifest(root, stamp);
  } catch (_) {
    return false; // a malformed module manifest is not a verified payload
  }
  if (!manifest && fs.existsSync(modulesDir(root, stamp))) return false;
  if (manifest && !moduleSetComplete(root, stamp, manifest)) return false;
  if (!guiRoot) return true;
  const pair = currentPair(root, guiRoot);
  return Boolean(pair && pair.flows === stamp && pair.gui === stamp && pair.compatible) &&
    modulesActive(root, stamp, manifest);
}

function captureGui(root, stamp, guiRoot) {
  const destination = guiPayloadDir(root, stamp);
  if (fs.existsSync(destination)) return destination;
  const source = guiLink(guiRoot);
  if (!fs.existsSync(source)) throw new Error(`captureGui: current GUI missing: ${source}`);
  copyTree(source, destination);
  return destination;
}

function captureExisting(root, stamp, flowsPath, guiRoot) {
  const evidence = legacyEvidence(flowsPath, guiRoot);
  const marker = legacyCapturePath(root);
  if (fs.existsSync(marker)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); }
    catch (error) { throw new Error(`captureExisting: legacy evidence is unreadable: ${error.message}`); }
    if (!existing || existing.format !== 1 || !existing.stamp ||
        existing.flows_path !== evidence.flows_path || existing.gui_path !== evidence.gui_path ||
        existing.flows_sha256 !== evidence.flows_sha256 || existing.gui_sha256 !== evidence.gui_sha256 ||
        !fs.existsSync(payloadDir(root, existing.stamp))) {
      throw new Error('captureExisting: refusing to recapture changed legacy files after a prior attempt');
    }
    return payloadDir(root, existing.stamp);
  }
  const staged = stagePayload(root, stamp, flowsPath, guiRoot);
  const metadata = { format: 1, stamp, ...evidence };
  const temp = `${marker}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
    fs.renameSync(temp, marker);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return staged;
}

function legacyCaptureStamp(root, flowsPath, guiRoot) {
  const marker = legacyCapturePath(root);
  if (!fs.existsSync(marker)) return null;
  const evidence = legacyEvidence(flowsPath, guiRoot);
  let existing;
  try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); }
  catch (error) { throw new Error(`legacyCaptureStamp: legacy evidence is unreadable: ${error.message}`); }
  if (!existing || existing.format !== 1 || existing.flows_path !== evidence.flows_path ||
      existing.gui_path !== evidence.gui_path || existing.flows_sha256 !== evidence.flows_sha256 ||
      existing.gui_sha256 !== evidence.gui_sha256 || !fs.existsSync(payloadDir(root, existing.stamp))) {
    throw new Error('legacyCaptureStamp: refusing to recapture changed legacy files after a prior attempt');
  }
  return existing.stamp;
}

// Why the live flows, GUI and helper modules are not one set, or null.
// deploy.sh records no committed payload, so the live links are checked
// against the payload the flows point into. flipTo() now switches every entry
// with one rename of payloads/active, but the flipTo() of v0.8.2 and
// earlier switched flows first, then the GUI, then each module in that
// payload's modules.json, so a deploy interrupted on such a gateway leaves
// flows linked into a payload that the GUI or one of those modules does not
// point into. What no switch leaves behind is one set:
// - a regular flows file: no switch is under way;
// - a regular GUI directory: a sysupgrade keeps /srv but replaces the GUI
//   link with the image GUI, and an older deploy.sh wrote the GUI in place;
// - a GUI link into another payload while the flows payload has no gui/:
//   flipTo() never switches flows into a payload without a GUI, only the
//   flows-only switch of a v0.7.0 deploy.sh does;
// - a payload without modules.json (from before #603): its flows run the live
//   module directories;
// - a module that is a directory, not a link into a payload, with a digest in
//   modules.json: captureModules() copied it from the live directory these
//   flows were already running on, and no switch turns a link back into a
//   directory. A sysupgrade may have copied the image's helper over it since;
//   the capture block copies it as it is now.
// A module modules.json lists without a digest was sealed with the payload,
// and a switch into the payload links it there.
function halfSwitchedReason(root, flows, gui) {
  if (!flows) return null;
  if (gui && gui !== flows && isDirectory(guiPayloadDir(root, flows))) {
    return `the live flows point into payloads/${flows} but the GUI into payloads/${gui}`;
  }
  const manifest = readModuleManifest(root, flows);
  if (!manifest) return null;
  const stray = manifest.modules.filter((name) => {
    const present = isDirectory(moduleLink(root, name));
    const linked = moduleLinkStamp(root, name);
    if (linked !== null) return linked !== flows || !present;
    return manifest.captured[name] === undefined || !present;
  });
  if (!stray.length) return null;
  return `the live flows point into payloads/${flows}, but its helper modules ${stray.join(', ')} are not linked into it`;
}

// deploy.sh calls this before it replaces any live file. When the live flows
// and GUI are not one payload, the capture block further down keeps them, and
// the live helper modules, as the rollback target. This decides first:
// - a legacy-capture marker whose capture exists is reused when the live files
//   match and refused when they changed;
// - a marker whose capture directory is gone (pruned, or removed by a
//   deploy.sh that did not know the marker) guards nothing and is moved aside,
//   so the capture block starts fresh;
// - a fresh capture is refused when the live set is half switched
//   (halfSwitchedReason), whichever deploy attempt switched it.
// Returns the line deploy.sh prints, or null.
const PREVIOUS_SUFFIX = '-previous';

function legacyCapturePreflight(root, flowsPath, guiRoot) {
  // The condition under which deploy.sh's capture block runs.
  if (!isFile(flowsPath) || !isDirectory(guiRoot)) return null;
  const flows = currentStamp(root);
  const gui = guiStamp(root, guiRoot);
  if (flows && flows === gui) return null;
  const marker = legacyCapturePath(root);
  let stamp = null;
  if (fs.existsSync(marker)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); }
    catch (error) { throw new Error(`legacyCapturePreflight: legacy evidence is unreadable: ${error.message}`); }
    stamp = existing ? existing.stamp : undefined;
    if (!existing || existing.format !== 1 || typeof stamp !== 'string' || !stamp ||
        stamp.includes('/') || stamp.startsWith('.')) {
      throw new Error('legacyCapturePreflight: refusing to recapture changed legacy files after a prior attempt');
    }
    if (isDirectory(payloadDir(root, stamp))) {
      legacyCaptureStamp(root, flowsPath, guiRoot);
      return null;
    }
    const attempt = stamp.endsWith(PREVIOUS_SUFFIX) ? stamp.slice(0, -PREVIOUS_SUFFIX.length) : '';
    if (!attempt) {
      throw new Error(`legacyCapturePreflight: the legacy-capture marker names payload ${stamp}, which is gone, and no deploy attempt can be read from it; refusing recapture`);
    }
    if (flows === attempt || gui === attempt) {
      throw new Error(`legacyCapturePreflight: the legacy-capture marker names payload ${stamp}, which is gone, and the live ${flows === attempt ? 'flows' : 'GUI'} point into payloads/${attempt} from the deploy that wrote it; refusing to capture a half-switched state`);
    }
  }
  const reason = halfSwitchedReason(root, flows, gui);
  if (reason) throw new Error(`legacyCapturePreflight: ${reason}; refusing to capture a half-switched state`);
  if (stamp === null) return null;
  const aside = `${marker}.stale-${process.pid}-${Date.now()}`;
  fs.renameSync(marker, aside);
  return `WARN: stale legacy-capture marker (payload ${stamp} gone); moved to payloads/${path.basename(aside)}; recapturing`;
}

function clearLegacyCapture(root) {
  fs.rmSync(legacyCapturePath(root), { force: true });
}

// Removing payloads/active takes every entry routed through it away at once;
// the links that led through it are removed after it.
function deactivate(root, stamp, guiRoot = null) {
  const current = currentStamp(root);
  const gui = guiRoot ? guiStamp(root, guiRoot) : null;
  if (activeStamp(root) === stamp) {
    fs.rmSync(activeLink(root), { force: true });
    fs.rmSync(legacyActiveLink(root), { force: true });
    if (linksTo(flowsLink(root), viaFlows(root))) fs.rmSync(flowsLink(root), { force: true });
    if (guiRoot && linksTo(guiLink(guiRoot), viaGui(root))) fs.rmSync(guiLink(guiRoot), { force: true });
    for (const name of fs.readdirSync(root)) {
      if (MODULE_NAME.test(name) && linksTo(moduleLink(root, name), viaModule(root, name))) {
        fs.rmSync(moduleLink(root, name), { force: true });
      }
    }
  }
  if (current === stamp) fs.rmSync(flowsLink(root), { force: true });
  if (gui === stamp) fs.rmSync(guiLink(guiRoot), { force: true });
  removeModuleLinksInto(root, stamp);
}

// Also removes module links into the payload: the links linkNewModules made
// for modules the gateway did not have before this deploy.
function discardPayload(root, stamp) {
  if (currentStamp(root) === stamp || activeStamp(root) === stamp) {
    throw new Error(`discardPayload: payload is still live: ${stamp}`);
  }
  removeModuleLinksInto(root, stamp);
  fs.rmSync(payloadDir(root, stamp), { recursive: true, force: true });
}

function writeCompatibility(root, stamp, schemaHead, schemaLedger) {
  const dir = payloadDir(root, stamp);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`writeCompatibility: payload missing: ${dir}`);
  }
  const metadata = {
    format: 1,
    payload_stamp: stamp,
    schema_head: String(schemaHead),
    schema_ledger: String(schemaLedger),
  };
  const target = compatibilityPath(root, stamp);
  if (fs.existsSync(target)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(`writeCompatibility: existing metadata is unreadable: ${error.message}`);
    }
    if (JSON.stringify(existing) !== JSON.stringify(metadata)) {
      throw new Error(`writeCompatibility: refusing to overwrite existing metadata: ${target}`);
    }
    return target;
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

function compatibilityExists(root, stamp) {
  return fs.existsSync(compatibilityPath(root, stamp));
}

function verifyCompatibility(root, stamp, schemaHead, schemaLedger) {
  const target = compatibilityPath(root, stamp);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    return false;
  }
  return metadata && metadata.format === 1 && metadata.payload_stamp === stamp &&
    metadata.schema_head === String(schemaHead) &&
    metadata.schema_ledger === String(schemaLedger);
}

// Health record (v0.8.2 review, S-1 follow-up). A rollback target must be a
// payload that passed deploy.sh's health check. payloads/<stamp>/health.json
// says "activated" from just before a deploy switches to the payload, and
// "healthy" once its health check passed, with the digests of the flows, the
// GUI and each module as they were then. A payload without the file predates
// the record (or is a capture of what was running) and is trusted.
function healthPath(root, stamp) {
  return path.join(payloadDir(root, stamp), 'health.json');
}

function writeHealth(root, stamp, record) {
  if (!isDirectory(payloadDir(root, stamp))) throw new Error(`health record: payload missing: ${stamp}`);
  const target = healthPath(root, stamp);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ format: 1, payload_stamp: stamp, ...record })}\n`, { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

function payloadDigests(root, stamp) {
  const manifest = readModuleManifest(root, stamp);
  const modules = {};
  for (const name of manifest ? manifest.modules : []) modules[name] = hashModule(moduleTarget(root, stamp, name));
  return {
    flows_sha256: hashFile(path.join(payloadDir(root, stamp), 'flows.json')),
    gui_sha256: isDirectory(guiPayloadDir(root, stamp)) ? hashTree(guiPayloadDir(root, stamp), { followLinks: true }) : null,
    modules,
  };
}

function markActivated(root, stamp) {
  return writeHealth(root, stamp, { state: 'activated' });
}

function markHealthy(root, stamp) {
  return writeHealth(root, stamp, { state: 'healthy', ...payloadDigests(root, stamp) });
}

// True for a payload without a health record, and for one recorded healthy
// whose files still match the digests. An "activated" payload never passed
// its health check; files changed since (an older deploy.sh writes helper
// modules in place, through the module links) make it a set that did not.
function payloadTrusted(root, stamp) {
  const file = healthPath(root, stamp);
  if (!fs.existsSync(file)) return true;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return false;
  }
  if (!record || record.format !== 1 || record.payload_stamp !== stamp || record.state !== 'healthy' ||
      !record.modules || typeof record.modules !== 'object') return false;
  // The files recorded healthy must be unchanged. A module captureModules()
  // copied into the payload later is a copy of what its flows ran with.
  try {
    const dir = payloadDir(root, stamp);
    if (hashFile(path.join(dir, 'flows.json')) !== record.flows_sha256) return false;
    const gui = isDirectory(guiPayloadDir(root, stamp)) ? hashTree(guiPayloadDir(root, stamp), { followLinks: true }) : null;
    if (gui !== record.gui_sha256) return false;
    return Object.entries(record.modules).every(([name, digest]) =>
      MODULE_NAME.test(name) && isDirectory(moduleTarget(root, stamp, name)) && hashModule(moduleTarget(root, stamp, name)) === digest);
  } catch (_) {
    return false;
  }
}

// The payload a failed deploy returns to: the served one when it is trusted,
// else the newest other complete, trusted payload, else the served one (a
// complete set is better than none; deploy.sh warns).
function rollbackTarget(root, servedStamp, deployStamp = '') {
  if (!servedStamp) return '';
  if (payloadTrusted(root, servedStamp)) return servedStamp;
  const candidates = listStamps(root).filter((stamp) => stamp !== servedStamp && stamp !== deployStamp).reverse();
  for (const stamp of candidates) {
    if (verifyPair(root, stamp) && payloadTrusted(root, stamp)) return stamp;
  }
  return servedStamp;
}

function readHealth(root, stamp) {
  try {
    const record = JSON.parse(fs.readFileSync(healthPath(root, stamp), 'utf8'));
    return record && record.format === 1 && record.payload_stamp === stamp ? record : null;
  } catch (_) {
    return null;
  }
}

// A payload whose health check ran and failed: known bad, never a target.
function markFailed(root, stamp, reason = '') {
  return writeHealth(root, stamp, { state: 'failed', reason: String(reason) });
}

// The gateway's payload state, for status and for the next deploy:
// /srv/node-red/payload-state.json, written only through this helper (by
// deploy.sh and by node-red.init's start-up step). Format 1:
//   { "format": 1, "active": "<stamp>", "state": "healthy" | "unverified" | "held",
//     "reason": "<one sentence>", "updated_at": "<ISO 8601>", "writer": "deploy.sh" | "node-red.init" }
// osi-health-helper reports state "unverified" or "held" as health_state, so
// it reaches the heartbeat and the local health summary.
const PAYLOAD_STATE = 'payload-state.json';

function payloadStatePath(root) {
  return path.join(root, PAYLOAD_STATE);
}

function writePayloadState(root, active, state, reason = '', writer = 'deploy.sh') {
  if (!['healthy', 'unverified', 'held'].includes(state)) throw new Error(`payload state: unknown state ${state}`);
  const target = payloadStatePath(root);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const record = { format: 1, active: String(active || ''), state, reason: String(reason), updated_at: new Date().toISOString(), writer };
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

function readPayloadState(root) {
  try {
    const record = JSON.parse(fs.readFileSync(payloadStatePath(root), 'utf8'));
    return record && record.format === 1 ? record : null;
  } catch (_) {
    return null;
  }
}

// The active payload when a deploy switched to it and was cut before its
// health check ran ("activated"): not known bad, only unchecked.
function unverifiedActive(root) {
  const active = activeStamp(root) || currentStamp(root);
  if (!active) return null;
  const record = readHealth(root, active);
  return record && record.state === 'activated' ? active : null;
}

const UNVERIFIED_REASON = 'switched in by a deploy that was cut before its health check; it runs because it matches the database';

// node-red.init, before Node-RED starts: an unchecked active payload still
// starts (it is the code that matches the database; older code never starts
// on a migrated database), and the state file says it is unverified.
// Returns the line node-red.init logs, or null.
function recordBootState(root) {
  const active = unverifiedActive(root);
  if (!active) return null;
  const current = readPayloadState(root);
  if (current && current.active === active && current.state !== 'healthy') return null;
  writePayloadState(root, active, 'unverified', UNVERIFIED_REASON, 'node-red.init');
  return `WARN: payloads/${active} runs unverified: ${UNVERIFIED_REASON}`;
}

// What the next deploy does first when the active payload is unchecked:
// "<payload>|<migrated 0/1>|<fallback>|<restore target>", or null.
// - fallback: the newest complete, trusted payload recorded for the current
//   schema. Empty means the cut deploy migrated the database (or the schema
//   is unknown): only the unchecked payload matches it, so its owed health
//   check decides, and a failure holds Node-RED stopped.
// - restore target: the payload a held gateway returns to after restoring
//   the pre-migration backup.
function owedCheckPlan(root, schemaHead = '', schemaLedger = '') {
  const active = unverifiedActive(root);
  if (!active) return null;
  const others = listStamps(root).filter((stamp) => stamp !== active).reverse()
    .filter((stamp) => verifyPair(root, stamp) && payloadTrusted(root, stamp));
  const fits = schemaHead === '' ? null : others.find((stamp) => verifyCompatibility(root, stamp, schemaHead, schemaLedger));
  return [active, fits ? '0' : '1', fits || '', others[0] || ''].join('|');
}

function listStamps(root) {
  try {
    return fs.readdirSync(payloadsRoot(root))
      .filter((entry) => isStampName(entry) && fs.lstatSync(payloadDir(root, entry)).isDirectory())
      .sort();
  } catch (_) {
    return [];
  }
}

function previousStamp(root) {
  const current = currentStamp(root);
  const candidates = listStamps(root).filter((stamp) => stamp !== current);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function rollback(root) {
  const previous = previousStamp(root);
  if (!previous) {
    throw new Error('rollback: no previous payload retained to fall back to');
  }
  flipTo(root, previous);
  return { flippedTo: previous };
}

function prunePayloads(root, keepN) {
  const current = currentStamp(root);
  const stamps = listStamps(root);
  const keep = new Set(stamps.slice(Math.max(0, stamps.length - keepN)));
  if (current) {
    keep.add(current);
  }
  if (activeStamp(root)) keep.add(activeStamp(root));
  // The payload the next deploy would roll back to.
  const trusted = [...stamps].reverse().find((stamp) => verifyPair(root, stamp) && payloadTrusted(root, stamp));
  if (trusted) keep.add(trusted);
  for (const linked of payloadModuleLinks(root).values()) keep.add(linked);
  const removed = [];
  for (const stamp of stamps) {
    if (keep.has(stamp)) {
      continue;
    }
    fs.rmSync(payloadDir(root, stamp), { recursive: true, force: true });
    removed.push(stamp);
  }
  return { removed };
}

module.exports = {
  LIVE_MODULES,
  activeStamp,
  LIVE_ENTRIES,
  stagePayload,
  sealModules,
  captureModules,
  linkNewModules,
  flipTo,
  currentStamp,
  guiStamp,
  currentPair,
  captureGui,
  captureExisting,
  legacyCaptureStamp,
  legacyCapturePreflight,
  resumeInterruptedSwitch,
  switchPreflight,
  clearLegacyCapture,
  verifyPair,
  markActivated,
  markHealthy,
  payloadTrusted,
  rollbackTarget,
  readHealth,
  markFailed,
  writePayloadState,
  readPayloadState,
  unverifiedActive,
  recordBootState,
  owedCheckPlan,
  writeCompatibility,
  compatibilityExists,
  verifyCompatibility,
  deactivate,
  discardPayload,
  previousStamp,
  rollback,
  prunePayloads,
};
