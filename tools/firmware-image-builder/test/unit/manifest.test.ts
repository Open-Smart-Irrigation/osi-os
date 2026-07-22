import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MANIFEST_STAGES,
  MANIFEST_OPERATIONS,
  REQUIRED_RUNTIME_FILES,
  type Manifest,
  type TargetManifest,
} from '../../manifest/schema.js';
import {
  ManifestValidationError,
  MAX_MANIFEST_BYTES,
  loadManifest,
  validateArtifactGlob,
  type ManifestFileSystem,
} from '../../manifest/validate.js';

const manifestPath = new URL('../../manifest/targets.json', import.meta.url);
const tempFixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of tempFixtureDirectories) {
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
  tempFixtureDirectories.clear();
  expect(tempFixtureDirectories.size).toBe(0);
});

function readManifestText(): string {
  return readFileSync(manifestPath, 'utf8');
}

function readManifestJson(): Manifest {
  return JSON.parse(readManifestText()) as Manifest;
}

function tempManifest(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'osi-image-builder-manifest-'));
  tempFixtureDirectories.add(directory);
  const path = join(directory, 'targets.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function tempManifestText(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'osi-image-builder-manifest-'));
  tempFixtureDirectories.add(directory);
  const path = join(directory, 'targets.json');
  writeFileSync(path, text, 'utf8');
  return path;
}

function rawReplaceOnce(text: string, needle: string, replacement: string): string {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`fixture needle not found: ${needle}`);
  return `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

function duplicateNeedle(name: string): string {
  switch (name) {
    case 'root schemaVersion': return '  "schemaVersion": 1,';
    case 'repository name': return '    "name": "osi-os",';
    case 'target label': return '      "label": "Pi 5",';
    case 'stage definition required': return '    "preflight": { "required": true, "timeoutSeconds": 300 },';
    case 'config symbol name': return '        { "name": "CONFIG_TARGET_bcm27xx_bcm2712", "type": "bool", "value": true },';
    default: throw new Error(`unknown duplicate fixture: ${name}`);
  }
}

interface FakeFileSystemOptions {
  readonly initialSize?: number;
  readonly postReadSize?: number;
  readonly readChunks?: readonly number[];
  readonly openError?: Error;
  readonly statError?: Error;
  readonly readError?: Error;
  readonly closeError?: Error;
  readonly bytes?: Buffer;
}

function fakeFileSystem(options: FakeFileSystemOptions = {}): {
  readonly fileSystem: ManifestFileSystem;
  readonly calls: { open: string[]; stat: number; read: number; close: number };
} {
  const bytes = options.bytes ?? Buffer.from(readManifestText());
  const calls: { open: string[]; stat: number; read: number; close: number } = { open: [], stat: 0, read: 0, close: 0 };
  let readOffset = 0;
  let chunkIndex = 0;
  const initialSize = options.initialSize ?? bytes.length;
  const fileSystem: ManifestFileSystem = {
    open(path) {
      calls.open.push(path);
      if (options.openError) throw options.openError;
      return 41;
    },
    stat() {
      calls.stat += 1;
      if (options.statError) throw options.statError;
      return { size: calls.stat === 1 ? initialSize : (options.postReadSize ?? initialSize) };
    },
    read(_fd, buffer, offset, length) {
      calls.read += 1;
      if (options.readError) throw options.readError;
      const requested = options.readChunks?.[chunkIndex++] ?? Math.min(length, bytes.length - readOffset);
      const count = Math.max(0, Math.min(requested, length, bytes.length - readOffset));
      bytes.copy(buffer, offset, readOffset, readOffset + count);
      readOffset += count;
      return count;
    },
    close() {
      calls.close += 1;
      if (options.closeError) throw options.closeError;
    },
  };
  return { fileSystem, calls };
}

function expectManifestCode(value: unknown, code: string): void {
  try {
    loadManifest(tempManifest(value));
    throw new Error('expected manifest validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).code).toBe(code);
  }
}

function expectManifestTextCode(text: string, code: string): void {
  const error = manifestTextError(text);
  expect(error.code).toBe(code);
}

function manifestTextError(text: string): ManifestValidationError {
  try {
    loadManifest(tempManifestText(text));
    throw new Error('expected manifest validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestValidationError);
    return error as ManifestValidationError;
  }
}

describe('target manifest', () => {
  it('loads the exact approved stages and Pi target records', () => {
    const loaded = loadManifest(manifestPath.pathname);

    expect(loaded.manifest.schemaVersion).toBe(1);
    expect(loaded.manifest.repository).toEqual({ name: 'osi-os', remote: 'origin' });
    expect(loaded.manifest.stages).toEqual([
      'preflight', 'source', 'release-gates', 'frontend', 'target-setup',
      'feeds', 'config', 'build', 'verify', 'publish',
    ]);
    expect(Object.keys(loaded.manifest.stageDefinitions)).toEqual(MANIFEST_STAGES);
    expect(Object.values(loaded.manifest.stageDefinitions)).toEqual([
      { required: true, timeoutSeconds: 300 },
      { required: true, timeoutSeconds: 300 },
      { required: true, timeoutSeconds: 1800 },
      { required: true, timeoutSeconds: 1800 },
      { required: true, timeoutSeconds: 900 },
      { required: true, timeoutSeconds: 1800 },
      { required: true, timeoutSeconds: 900 },
      { required: true, timeoutSeconds: 21600 },
      { required: true, timeoutSeconds: 1800 },
      { required: true, timeoutSeconds: 300 },
    ]);
    expect(loaded.manifest.targets).toEqual([
      {
        id: 'rpi-5', label: 'Pi 5', environment: 'full_raspberrypi_bcm27xx_bcm2712',
        openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5',
        rootfs: 'build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
        artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz',
        rootfsPartSize: 14336, minimumArtifactBytes: 67108864,
        configSymbols: [
          { name: 'CONFIG_TARGET_bcm27xx_bcm2712', type: 'bool', value: true },
          { name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-5' },
          { name: 'CONFIG_TARGET_ROOTFS_PARTSIZE', type: 'number', value: 14336 },
          { name: 'CONFIG_PACKAGE_node-red', type: 'bool', value: true },
          { name: 'CONFIG_PACKAGE_node-red-contrib-chirpstack', type: 'bool', value: true },
          { name: 'CONFIG_PACKAGE_chirpstack', type: 'bool', value: true },
          { name: 'CONFIG_PACKAGE_node-red-node-sqlite', type: 'bool', value: true },
        ],
        operations: ['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds',
          'resolve-config', 'build-image', 'verify-image'],
      },
      {
        id: 'rpi-2', label: 'Pi 4 / 400 / 3 / 2', environment: 'full_raspberrypi_bcm27xx_bcm2709',
        openwrtTarget: 'bcm27xx/bcm2709', profile: 'DEVICE_rpi-2',
        rootfs: 'build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx',
        artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz',
        rootfsPartSize: 14336, minimumArtifactBytes: 67108864,
        configSymbols: [
          { name: 'CONFIG_TARGET_bcm27xx_bcm2709', type: 'bool', value: true },
          { name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-2' },
          { name: 'CONFIG_TARGET_ROOTFS_PARTSIZE', type: 'number', value: 14336 },
          { name: 'CONFIG_PACKAGE_node-red', type: 'bool', value: true },
          { name: 'CONFIG_PACKAGE_node-red-contrib-chirpstack', type: 'bool', value: true },
          { name: 'CONFIG_PACKAGE_chirpstack', type: 'bool', value: true },
          { name: 'CONFIG_PACKAGE_node-red-node-sqlite', type: 'bool', value: true },
        ],
        operations: ['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds',
          'resolve-config', 'build-image', 'verify-image'],
      },
    ] satisfies readonly TargetManifest[]);
    expect(loaded.sha256).toBe(createHash('sha256').update(readManifestText()).digest('hex'));
  });

  it('exposes the exact runtime files required by verification', () => {
    expect(REQUIRED_RUNTIME_FILES).toEqual([
      '/etc/uci-defaults/98_osi_node_red_seed',
      '/usr/share/flows.json',
      '/usr/share/db/farming.db',
      '/etc/init.d/node-red',
      '/usr/lib/node-red/gui/index.html',
      '/usr/share/node-red/node_modules/@grpc/grpc-js/package.json',
      '/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json',
      '/usr/share/node-red/node_modules/google-protobuf/package.json',
      '/usr/share/node-red/node_modules/protobufjs/package.json',
      '/usr/share/node-red/node_modules/osi-chameleon-helper/package.json',
      '/usr/share/node-red/node_modules/osi-chirpstack-helper/package.json',
      '/usr/share/node-red/node_modules/osi-cloud-http/package.json',
      '/usr/share/node-red/node_modules/osi-command-ledger/package.json',
      '/usr/share/node-red/node_modules/osi-db-helper/package.json',
      '/usr/share/node-red/node_modules/osi-dendro-helper/package.json',
      '/usr/share/node-red/node_modules/osi-dendro-analytics/package.json',
      '/usr/share/node-red/node_modules/osi-zone-env/package.json',
      '/usr/share/node-red/node_modules/osi-history-helper/package.json',
      '/usr/share/node-red/node_modules/osi-history-sync-helper/package.json',
      '/usr/share/node-red/node_modules/osi-history-router/package.json',
      '/usr/share/node-red/node_modules/osi-health-helper/package.json',
      '/usr/share/node-red/node_modules/osi-lib/package.json',
      '/usr/share/node-red/node_modules/osi-journal/package.json',
      '/usr/share/node-red/node_modules/osi-device-writer/package.json',
      '/usr/share/node-red/node_modules/osi-uc512-normalize/package.json',
      '/usr/share/node-red/node_modules/osi-lsn50-normalize/package.json',
    ]);
    expect(Object.isFrozen(REQUIRED_RUNTIME_FILES)).toBe(true);
  });

  it('exposes the complete independent trusted operation vocabulary', () => {
    expect(MANIFEST_OPERATIONS).toEqual([
      'activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds',
      'resolve-config', 'build-image', 'verify-image', 'verify-profile-parity',
      'verify-chameleon', 'verify-db-schema', 'verify-sync-flow', 'verify-strega',
      'verify-communication', 'check-mqtt-topics', 'frontend-install', 'frontend-test',
      'frontend-typecheck', 'frontend-build', 'mirror-gui',
    ]);
  });

  it('returns a deeply frozen manifest', () => {
    const loaded = loadManifest(manifestPath.pathname);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.manifest)).toBe(true);
    expect(Object.isFrozen(loaded.manifest.targets)).toBe(true);
    expect(Object.isFrozen(loaded.manifest.targets[0])).toBe(true);
    expect(Object.isFrozen(loaded.manifest.targets[0].configSymbols)).toBe(true);
    expect(Object.isFrozen(loaded.manifest.targets[0].configSymbols[0])).toBe(true);
    expect(Reflect.set(loaded.manifest.targets[0], 'label', 'changed')).toBe(false);
    expect(() => Reflect.apply(Array.prototype.push, loaded.manifest.targets, [loaded.manifest.targets[0]])).toThrow();
  });

  it('rejects unknown keys at each manifest object level', () => {
    const original = readManifestJson();
    expectManifestCode({ ...original, extra: true }, 'MANIFEST_KEYS_INVALID');
    const { schemaVersion: _schemaVersion, ...withoutSchemaVersion } = original;
    expectManifestCode(withoutSchemaVersion, 'MANIFEST_KEYS_INVALID');
    expectManifestCode({ ...original, repository: { ...original.repository, extra: true } }, 'REPOSITORY_KEYS_INVALID');
    expectManifestCode({ ...original, stageDefinitions: {
      ...original.stageDefinitions,
      preflight: { ...original.stageDefinitions.preflight, extra: true },
    } }, 'STAGE_DEFINITION_KEYS_INVALID');
    expectManifestCode({ ...original, targets: [{ ...original.targets[0], extra: true }, original.targets[1]] }, 'TARGET_KEYS_INVALID');
    expectManifestCode({ ...original, targets: [{
      ...original.targets[0], configSymbols: [
        { ...original.targets[0].configSymbols[0], extra: true },
        ...original.targets[0].configSymbols.slice(1),
      ],
    }, original.targets[1]] }, 'CONFIG_SYMBOL_KEYS_INVALID');
  });

  it('rejects duplicate keys with control characters without exposing decoded key text', () => {
    const original = readManifestText();
    const text = rawReplaceOnce(
      original,
      '    "remote": "origin"\n',
      '    "remote": "origin", "bad\\u000a": 1, "bad\\u000a": 2\n',
    );
    const error = manifestTextError(text);
    expect(error.code).toBe('DUPLICATE_KEY');
    expect(error.message).toBe('Manifest contains duplicate key.');
    expect(error.message).not.toContain('bad');
    expect(error.message).not.toContain('\n');
  });

  it.each([
    ['deep nesting', `${'['.repeat(5000)}0${']'.repeat(5000)}`, 'MANIFEST_JSON_INVALID'],
    ['oversized bytes', `${readManifestText()}${' '.repeat(1024 * 1024)}`, 'MANIFEST_TOO_LARGE'],
  ])('maps %s to a typed JSON validation error', (_name, text, code) => {
    const error = manifestTextError(text);
    expect(error.code).toBe(code);
    expect(error).toBeInstanceOf(ManifestValidationError);
  });

  it('rejects sparse oversize files from fstat without reading or allocating by file size', () => {
    const fake = fakeFileSystem({ initialSize: MAX_MANIFEST_BYTES + 1 });
    const error = (() => {
      try {
        loadManifest('/virtual/sparse-targets.json', fake.fileSystem);
        throw new Error('expected manifest validation to fail');
      } catch (value) {
        return value;
      }
    })();
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).code).toBe('MANIFEST_TOO_LARGE');
    expect(fake.calls.open).toEqual(['/virtual/sparse-targets.json']);
    expect(fake.calls.read).toBe(0);
    expect(fake.calls.close).toBe(1);
  });

  it('rejects an ordinary oversize file before parsing', () => {
    const path = tempManifestText(`${' '.repeat(MAX_MANIFEST_BYTES)}x`);
    const error = (() => {
      try {
        loadManifest(path);
        throw new Error('expected manifest validation to fail');
      } catch (value) {
        return value;
      }
    })();
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).code).toBe('MANIFEST_TOO_LARGE');
  });

  it('opens once, never reopens the path, and hashes the exact accepted bytes', () => {
    const bytes = Buffer.from(readManifestText());
    const fake = fakeFileSystem({ bytes });
    const loaded = loadManifest('/virtual/accepted-targets.json', fake.fileSystem);
    expect(loaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fake.calls.open).toEqual(['/virtual/accepted-targets.json']);
    expect(fake.calls.read).toBeGreaterThan(0);
    expect(fake.calls.close).toBe(1);
  });

  it.each([
    ['growth', { bytes: Buffer.concat([Buffer.from(readManifestText()), Buffer.from('x')]), initialSize: readManifestText().length, postReadSize: readManifestText().length + 1 }],
    ['short read', { readChunks: [Math.floor(readManifestText().length / 2), 0] }],
  ])('rejects %s through the held descriptor', (_name, options) => {
    const fake = fakeFileSystem(options);
    const error = (() => {
      try {
        loadManifest('/virtual/mutable-targets.json', fake.fileSystem);
        throw new Error('expected manifest validation to fail');
      } catch (value) {
        return value;
      }
    })();
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).code).toBe('MANIFEST_FILE_CHANGED');
    expect(fake.calls.open).toEqual(['/virtual/mutable-targets.json']);
    expect(fake.calls.close).toBe(1);
  });

  it.each([
    ['open', { openError: new Error('secret open detail') }, 'MANIFEST_OPEN_FAILED'],
    ['stat', { statError: new Error('secret stat detail') }, 'MANIFEST_STAT_FAILED'],
    ['read', { readError: new Error('secret read detail') }, 'MANIFEST_READ_FAILED'],
    ['close', { closeError: new Error('secret close detail') }, 'MANIFEST_CLOSE_FAILED'],
  ])('maps %s adapter failures to typed errors', (_name, options, code) => {
    const fake = fakeFileSystem(options);
    const error = (() => {
      try {
        loadManifest('/virtual/failure-targets.json', fake.fileSystem);
        throw new Error('expected manifest validation to fail');
      } catch (value) {
        return value;
      }
    })();
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).code).toBe(code);
    expect((error as Error).message).not.toContain('secret');
  });

  it.each([
    ['comments', readManifestText().replace('{\n', '{\n  // comments are not JSON\n')],
    ['trailing commas', readManifestText().replace(/\n}\s*$/, ',\n}\n')],
    ['empty content', ''],
  ])('rejects strict JSON violation: %s', (_name, text) => {
    expectManifestTextCode(text, 'MANIFEST_JSON_INVALID');
  });

  it.each([
    ['root schemaVersion', '  "schemaVersion": 0,\n  "schemaVersion": 1,', '  "schemaVersion": 1,\n  "schemaVersion": 0,'],
    ['repository name', '    "name": "invalid",\n    "name": "osi-os",', '    "name": "osi-os",\n    "name": "invalid",'],
    ['target label', '      "label": "invalid",\n      "label": "Pi 5",', '      "label": "Pi 5",\n      "label": "invalid",'],
    ['stage definition required', '    "preflight": { "required": false, "required": true, "timeoutSeconds": 300 },', '    "preflight": { "required": true, "required": false, "timeoutSeconds": 300 },'],
    ['config symbol name', '        { "name": "INVALID", "name": "CONFIG_TARGET_bcm27xx_bcm2712", "type": "bool", "value": true },', '        { "name": "CONFIG_TARGET_bcm27xx_bcm2712", "name": "INVALID", "type": "bool", "value": true },'],
  ])('rejects duplicate %s member names before semantic validation', (_name, invalidFirst, validFirst) => {
    const original = readManifestText();
    expectManifestTextCode(rawReplaceOnce(original, duplicateNeedle(_name), invalidFirst), 'DUPLICATE_KEY');
    expectManifestTextCode(rawReplaceOnce(original, duplicateNeedle(_name), validFirst), 'DUPLICATE_KEY');
  });

  it.each([
    ['repository null', (m: Manifest) => ({ ...m, repository: null }), 'REPOSITORY_SHAPE_INVALID'],
    ['repository array', (m: Manifest) => ({ ...m, repository: [] }), 'REPOSITORY_SHAPE_INVALID'],
    ['repository missing key', (m: Manifest) => ({ ...m, repository: { name: 'osi-os' } }), 'REPOSITORY_KEYS_INVALID'],
    ['stage definition null', (m: Manifest) => ({ ...m, stageDefinitions: { ...m.stageDefinitions, preflight: null } }), 'STAGE_DEFINITION_SHAPE_INVALID'],
    ['stage definition array', (m: Manifest) => ({ ...m, stageDefinitions: { ...m.stageDefinitions, preflight: [] } }), 'STAGE_DEFINITION_SHAPE_INVALID'],
    ['stage definition missing key', (m: Manifest) => ({ ...m, stageDefinitions: { ...m.stageDefinitions, preflight: { required: true } } }), 'STAGE_DEFINITION_KEYS_INVALID'],
    ['target null', (m: Manifest) => ({ ...m, targets: [null, m.targets[1]] }), 'TARGET_SHAPE_INVALID'],
    ['target array', (m: Manifest) => ({ ...m, targets: [[], m.targets[1]] }), 'TARGET_SHAPE_INVALID'],
    ['target missing key', (m: Manifest) => {
      const { profile: _profile, ...target } = m.targets[0];
      return { ...m, targets: [target, m.targets[1]] };
    }, 'TARGET_KEYS_INVALID'],
    ['config symbol null', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], configSymbols: [null, ...m.targets[0].configSymbols.slice(1)] }, m.targets[1]] }), 'CONFIG_SYMBOL_SHAPE_INVALID'],
    ['config symbol array', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], configSymbols: [[], ...m.targets[0].configSymbols.slice(1)] }, m.targets[1]] }), 'CONFIG_SYMBOL_SHAPE_INVALID'],
    ['config symbol missing key', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], configSymbols: [{ name: 'CONFIG_TARGET_bcm27xx_bcm2712', type: 'bool' }, ...m.targets[0].configSymbols.slice(1)],
    }, m.targets[1]] }), 'CONFIG_SYMBOL_KEYS_INVALID'],
  ])('%s has a context-specific validation error', (_name, mutate, code) => {
    expectManifestCode(mutate(readManifestJson()), code);
  });

  it.each([
    ['unknown stage', (m: Manifest) => ({ ...m, stages: ['preflight', 'unknown', ...m.stages.slice(2)] }), 'UNKNOWN_STAGE'],
    ['wrong stage order', (m: Manifest) => ({ ...m, stages: [...m.stages].reverse() }), 'STAGE_ORDER_MISMATCH'],
    ['duplicate stage', (m: Manifest) => ({ ...m, stages: [...m.stages.slice(0, -1), m.stages[m.stages.length - 2]] }), 'STAGE_ORDER_MISMATCH'],
    ['missing stage definition', (m: Manifest) => {
      const { publish: _publish, ...definitions } = m.stageDefinitions;
      return { ...m, stageDefinitions: definitions };
    }, 'STAGE_DEFINITION_MISMATCH'],
    ['duplicate target', (m: Manifest) => ({ ...m, targets: [m.targets[0], m.targets[0]] }), 'DUPLICATE_TARGET_ID'],
    ['changed target order', (m: Manifest) => ({ ...m, targets: [m.targets[1], m.targets[0]] }), 'TARGET_ORDER_MISMATCH'],
    ['unknown operation', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], operations: ['run-shell'] }, m.targets[1]] }), 'UNKNOWN_OPERATION'],
    ['duplicate operation', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], operations: ['activate-target', 'activate-target', ...m.targets[0].operations.slice(2)],
    }, m.targets[1]] }), 'DUPLICATE_OPERATION'],
    ['changed operation order', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], operations: [...m.targets[0].operations].reverse(),
    }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['changed config-symbol order', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], configSymbols: [m.targets[0].configSymbols[1], m.targets[0].configSymbols[0], ...m.targets[0].configSymbols.slice(2)],
    }, m.targets[1]] }), 'CONFIG_SYMBOL_VALUE'],
    ['wrong bool type', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], configSymbols: [
        { ...m.targets[0].configSymbols[0], value: 'true' },
        ...m.targets[0].configSymbols.slice(1),
      ],
    }, m.targets[1]] }), 'CONFIG_SYMBOL_TYPE'],
    ['wrong known bool value', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], configSymbols: [{ ...m.targets[0].configSymbols[0], value: false }, ...m.targets[0].configSymbols.slice(1)],
    }, m.targets[1]] }), 'CONFIG_SYMBOL_VALUE'],
    ['wrong known string value', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], configSymbols: [m.targets[0].configSymbols[0], { ...m.targets[0].configSymbols[1], value: 'DEVICE-rpi-5' }, ...m.targets[0].configSymbols.slice(2)],
    }, m.targets[1]] }), 'CONFIG_SYMBOL_VALUE'],
    ['wrong known number value', (m: Manifest) => ({ ...m, targets: [{
      ...m.targets[0], configSymbols: [m.targets[0].configSymbols[0], m.targets[0].configSymbols[1], { ...m.targets[0].configSymbols[2], value: 4096 }, ...m.targets[0].configSymbols.slice(3)],
    }, m.targets[1]] }), 'CONFIG_SYMBOL_VALUE'],
    ['missing profile', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], profile: '' }, m.targets[1]] }), 'MISSING_PROFILE'],
    ['incorrect nonempty profile', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], profile: 'DEVICE_rpi-5-alt' }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['changed label', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], label: 'Pi Five' }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['changed environment', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], environment: 'full_raspberrypi_bcm27xx_bcm2712-alt' }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['changed OpenWrt target', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], openwrtTarget: 'bcm27xx/bcm2712-alt' }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['changed rootfs', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], rootfs: 'build_dir/other-rootfs' }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['changed artifact glob', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz' }, m.targets[1]] }), 'TARGET_DATA_MISMATCH'],
    ['wrong partition size', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], rootfsPartSize: 1024 }, m.targets[1]] }), 'ROOTFS_PART_SIZE'],
    ['wrong artifact floor', (m: Manifest) => ({ ...m, targets: [{ ...m.targets[0], minimumArtifactBytes: 1 }, m.targets[1]] }), 'MINIMUM_ARTIFACT_BYTES'],
  ])('%s fails with a stable code', (_name, mutate, code) => {
    expectManifestCode(mutate(readManifestJson()), code);
  });

  it.each([
    ['absolute', '/tmp/image.img.gz'],
    ['empty', ''],
    ['dot', '.'],
    ['dotdot', '..'],
    ['backslash', 'image\\*.img.gz'],
    ['traversal', 'dir/../../image.img.gz'],
    ['control', 'image\u0000.img.gz'],
    ['shell', 'image$(touch pwned).img.gz'],
    ['wrong suffix', 'image.img'],
    ['directory separator', 'dir/image-*.img.gz'],
  ])('rejects unsafe artifact pattern: %s', (_name, pattern) => {
    expect(validateArtifactGlob(pattern)).toBe(false);
    const original = readManifestJson();
    expectManifestCode({ ...original, targets: [{ ...original.targets[0], artifactGlob: pattern }, original.targets[1]] }, 'ARTIFACT_GLOB_INVALID');
  });

  it.each(['/tmp/rootfs', '', '.', '..', 'build_dir/../rootfs', 'build_dir\\rootfs', 'build_dir/\u0001rootfs'])(
    'rejects unsafe rootfs path: %s',
    (rootfs) => {
      const original = readManifestJson();
      expectManifestCode({ ...original, targets: [{ ...original.targets[0], rootfs }, original.targets[1]] }, 'UNSAFE_PATH');
    },
  );

  it('accepts only the intended factory image glob shape and does not claim cardinality', () => {
    expect(validateArtifactGlob('chirpstack-gateway-os-2026.07-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz')).toBe(true);
    expect(validateArtifactGlob('chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz')).toBe(true);
    expect(validateArtifactGlob('chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-sysupgrade.img.gz')).toBe(false);
  });
});
