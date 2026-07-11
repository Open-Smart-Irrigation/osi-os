#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function payloadsRoot(root) {
  return path.join(root, 'payloads');
}

function payloadDir(root, stamp) {
  return path.join(payloadsRoot(root), stamp);
}

function flowsLink(root) {
  return path.join(root, 'flows.json');
}

function stagePayload(root, stamp, srcFlowsPath) {
  const dir = payloadDir(root, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(srcFlowsPath, path.join(dir, 'flows.json'));
  return dir;
}

function flipTo(root, stamp) {
  const target = path.join(payloadDir(root, stamp), 'flows.json');
  if (!fs.existsSync(target)) {
    throw new Error(`flipTo: staged payload missing: ${target}`);
  }
  const link = flowsLink(root);
  const relativeTarget = path.relative(root, target);
  const tmp = path.join(root, `.flows.json.flip-${process.pid}-${Date.now()}`);
  try {
    fs.rmSync(tmp, { force: true });
  } catch (_) {}
  fs.symlinkSync(relativeTarget, tmp);
  fs.renameSync(tmp, link);
  return { flowsLink: link, target };
}

function currentStamp(root) {
  const link = flowsLink(root);
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch (_) {
    return null;
  }
  if (!stat.isSymbolicLink()) {
    return null;
  }
  let resolved;
  let resolvedPayloadsRoot;
  try {
    resolved = fs.realpathSync(link);
    resolvedPayloadsRoot = fs.realpathSync(payloadsRoot(root));
  } catch (_) {
    return null;
  }
  const dir = path.dirname(resolved);
  if (path.dirname(dir) !== resolvedPayloadsRoot) {
    return null;
  }
  return path.basename(dir);
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
  previousStamp,
  rollback,
  prunePayloads,
};
