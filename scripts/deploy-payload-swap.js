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

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  const walk = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(current, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${childRelative}\n`);
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile()) hash.update(fs.readFileSync(child));
      else throw new Error(`legacy capture: unsupported GUI entry: ${child}`);
    }
  };
  walk(root, '');
  return hash.digest('hex');
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
    try {
      const existing = fs.lstatSync(link);
      if (existing.isSymbolicLink()) previousTarget = fs.realpathSync(link);
      else {
        backup = `${link}.osi-old-${process.pid}-${Date.now()}`;
        fs.renameSync(link, backup);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.symlinkSync(relativeTarget, tmp);
    try {
      fs.renameSync(tmp, link);
    } catch (error) {
      if (!backup) throw error;
      fs.renameSync(backup, link);
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
    fs.rmSync(result.link, { force: true, recursive: true });
    fs.renameSync(result.backup, result.link);
    result.backup = null;
    return;
  }
  fs.rmSync(result.link, { force: true, recursive: true });
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

function flipTo(root, stamp, guiRoot = null) {
  const flowTarget = path.join(payloadDir(root, stamp), 'flows.json');
  if (!fs.existsSync(flowTarget)) {
    throw new Error(`flipTo: staged payload missing: ${flowTarget}`);
  }
  if (guiRoot && (!fs.existsSync(guiPayloadDir(root, stamp)) ||
      !fs.statSync(guiPayloadDir(root, stamp)).isDirectory())) {
    throw new Error(`flipTo: staged GUI payload missing: ${guiPayloadDir(root, stamp)}`);
  }
  const flow = atomicSymlink(flowsLink(root), flowTarget, 'flows flip', { keepBackup: Boolean(guiRoot) });
  if (!guiRoot) return { flowsLink: flow.link, target: flow.target };
  let gui;
  try {
    gui = atomicSymlink(guiLink(guiRoot), guiPayloadDir(root, stamp), 'GUI flip', { keepBackup: true });
  } catch (error) {
    restoreFlippedEntry(flow);
    throw error;
  }
  discardBackup(flow.backup);
  discardBackup(gui.backup);
  return { flowsLink: flow.link, guiLink: gui.link, target: flow.target, guiTarget: gui.target };
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
  return fs.existsSync(flowsTarget) && fs.statSync(flowsTarget).isFile() &&
    fs.existsSync(guiTarget) && fs.statSync(guiTarget).isDirectory() &&
    (!guiRoot || (() => {
      const pair = currentPair(root, guiRoot);
      return pair && pair.flows === stamp && pair.gui === stamp && pair.compatible;
    })());
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

function clearLegacyCapture(root) {
  fs.rmSync(legacyCapturePath(root), { force: true });
}

function deactivate(root, stamp, guiRoot = null) {
  const current = currentStamp(root);
  if (current === stamp) fs.rmSync(flowsLink(root), { force: true });
  if (guiRoot && guiStamp(root, guiRoot) === stamp) fs.rmSync(guiLink(guiRoot), { force: true });
}

function discardPayload(root, stamp) {
  if (currentStamp(root) === stamp) throw new Error(`discardPayload: payload is still live: ${stamp}`);
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

function listStamps(root) {
  try {
    return fs.readdirSync(payloadsRoot(root))
      .filter((entry) => fs.statSync(payloadDir(root, entry)).isDirectory())
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
  stagePayload,
  flipTo,
  currentStamp,
  guiStamp,
  currentPair,
  captureGui,
  captureExisting,
  legacyCaptureStamp,
  clearLegacyCapture,
  verifyPair,
  writeCompatibility,
  compatibilityExists,
  verifyCompatibility,
  deactivate,
  discardPayload,
  previousStamp,
  rollback,
  prunePayloads,
};
