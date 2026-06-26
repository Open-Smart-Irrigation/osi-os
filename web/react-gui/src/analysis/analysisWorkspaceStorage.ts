import channelManifest from '../channels/channels.json';
import { canonicalize } from '../channels/registry';
import type { AnalysisCatalogEntry } from './types';
import { fromViewJson, toViewJson, type AnalysisWorkspaceState } from './workspaceModel';

type ChannelManifestEntry = { key: string; legacyAliases?: string[] };

const LEGACY_ALIASES_BY_KEY = new Map(
  (channelManifest as ChannelManifestEntry[]).map((channel) => [channel.key, channel.legacyAliases ?? []]),
);

function legacyAliasesFor(keyOrAlias: string): string[] {
  return LEGACY_ALIASES_BY_KEY.get(canonicalize(keyOrAlias)) ?? [];
}

const KEY = 'osi.analysis.workspace.v1';
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function sha256Hex(input: string): string {
  const inputBytes = new TextEncoder().encode(input);
  const bitLength = inputBytes.length * 8;
  const paddedLength = Math.ceil((inputBytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  const dataView = new DataView(padded.buffer);
  const words = new Uint32Array(64);

  padded.set(inputBytes);
  padded[inputBytes.length] = 0x80;
  dataView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  dataView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = dataView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function analysisSeriesIdFromParts(
  zoneId: number,
  cardType: string,
  sourceKey: string,
  channelKey: string,
): string {
  return sha256Hex(`${zoneId}|${cardType}|${sourceKey}|${channelKey}`).slice(0, 16);
}

function legacySeriesIdMap(catalogEntries: AnalysisCatalogEntry[]): Map<string, string> {
  const legacyIds = new Map<string, string>();

  for (const entry of catalogEntries) {
    for (const legacyChannel of legacyAliasesFor(entry.channelKey)) {
      legacyIds.set(
        analysisSeriesIdFromParts(entry.zoneId, entry.cardType, entry.sourceKey, legacyChannel),
        entry.seriesId,
      );
    }
  }

  return legacyIds;
}

export function loadWorkspace(): AnalysisWorkspaceState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return fromViewJson(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveWorkspace(state: AnalysisWorkspaceState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(toViewJson(state)));
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function migrateWorkspaceSeriesIds(
  workspace: AnalysisWorkspaceState,
  catalogEntries: AnalysisCatalogEntry[],
): AnalysisWorkspaceState {
  const legacyIds = legacySeriesIdMap(catalogEntries);
  if (legacyIds.size === 0) {
    return workspace;
  }

  let selectorsChanged = false;
  const selectorIds = new Set<string>();
  const selectors = workspace.selectors.flatMap((selector) => {
    const canonicalSeriesId = legacyIds.get(selector.seriesId) ?? selector.seriesId;
    if (canonicalSeriesId !== selector.seriesId) {
      selectorsChanged = true;
    }
    if (selectorIds.has(canonicalSeriesId)) {
      selectorsChanged = true;
      return [];
    }
    selectorIds.add(canonicalSeriesId);
    return [{ seriesId: canonicalSeriesId }];
  });

  const labelOverrideEntries = Object.entries(workspace.labelOverrides);
  let labelOverridesChanged = false;
  let labelOverrides = workspace.labelOverrides;

  if (labelOverrideEntries.length > 0) {
    const migratedOverrides: Record<string, string> = {};
    for (const [seriesId, label] of labelOverrideEntries) {
      if (!legacyIds.has(seriesId)) {
        migratedOverrides[seriesId] = label;
      }
    }
    for (const [seriesId, label] of labelOverrideEntries) {
      const canonicalSeriesId = legacyIds.get(seriesId);
      if (!canonicalSeriesId) {
        continue;
      }
      labelOverridesChanged = true;
      if (migratedOverrides[canonicalSeriesId] === undefined) {
        migratedOverrides[canonicalSeriesId] = label;
      }
    }
    if (labelOverridesChanged || Object.keys(migratedOverrides).length !== labelOverrideEntries.length) {
      labelOverrides = migratedOverrides;
    }
  }

  if (!selectorsChanged && !labelOverridesChanged) {
    return workspace;
  }

  return {
    ...workspace,
    selectors: selectorsChanged ? selectors : workspace.selectors,
    labelOverrides,
  };
}
