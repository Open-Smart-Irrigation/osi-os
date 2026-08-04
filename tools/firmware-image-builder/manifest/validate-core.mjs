import { createHash } from 'node:crypto';

import { getNodeValue, parseTree } from 'jsonc-parser';

import trustedManifest from './targets.json' with { type: 'json' };

export const MAX_MANIFEST_BYTES = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }
  return false;
}

function hasDuplicateKey(root) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.type === 'object') {
      const keys = new Set();
      for (const child of node.children ?? []) {
        const keyNode = child.type === 'property' ? child.children?.[0] : undefined;
        if (keyNode?.type !== 'string' || typeof keyNode.value !== 'string') continue;
        if (keys.has(keyNode.value)) return true;
        keys.add(keyNode.value);
      }
    }
    for (const child of node.children ?? []) pending.push(child);
  }
  return false;
}

function deepFreeze(value, seen = new Set()) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Validate manifest bytes without requiring the TypeScript runtime. The
 * checked-in manifest is the authenticated contract used by the TS loader;
 * comparing the complete parsed document keeps this direct-Node path on the
 * same full-manifest contract instead of maintaining a second schema.
 */
export function loadManifestBytes(input, label = 'manifest') {
  const bytes = Buffer.from(input);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error(`${label} exceeds the maximum size`);
  const text = bytes.toString('utf8');
  const parseErrors = [];
  let tree;
  try {
    tree = parseTree(text, parseErrors, {
      allowEmptyContent: false,
      allowTrailingComma: false,
      disallowComments: true,
    });
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  if (tree === undefined || parseErrors.length > 0 || hasDuplicateKey(tree)) {
    throw new Error(`${label} is invalid JSON`);
  }
  let parsed;
  try {
    parsed = getNodeValue(tree);
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  if (!isObject(parsed) || !sameJson(parsed, trustedManifest)) {
    throw new Error(`${label} does not match the authenticated manifest`);
  }
  return Object.freeze({
    manifest: deepFreeze(parsed),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
