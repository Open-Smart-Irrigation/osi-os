import {
  PIPELINE_STAGE_NAMES,
  TARGET_IDS,
  TRUSTED_OPERATION_IDS,
  type PipelineStageName,
  type TargetId,
  type TrustedOperationId,
} from '../domain/types.js';

export const MANIFEST_STAGES = PIPELINE_STAGE_NAMES;
export const MANIFEST_TARGET_IDS = TARGET_IDS;
export const MANIFEST_OPERATIONS = TRUSTED_OPERATION_IDS;

export const REQUIRED_RUNTIME_FILES = Object.freeze([
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
] as const);

export interface RepositoryManifest {
  readonly name: 'osi-os';
  readonly remote: 'origin';
}

export interface StageDefinition {
  readonly required: true;
  readonly timeoutSeconds: number;
}

export type ConfigSymbol =
  | { readonly name: string; readonly type: 'bool'; readonly value: boolean }
  | { readonly name: string; readonly type: 'string'; readonly value: string }
  | { readonly name: string; readonly type: 'number'; readonly value: number };

export interface TargetManifest {
  readonly id: TargetId;
  readonly label: string;
  readonly environment: string;
  readonly openwrtTarget: string;
  readonly profile: string;
  readonly rootfs: string;
  readonly artifactGlob: string;
  readonly rootfsPartSize: 14336;
  readonly minimumArtifactBytes: 67108864;
  readonly configSymbols: readonly ConfigSymbol[];
  readonly operations: readonly TrustedOperationId[];
}

export interface Manifest {
  readonly schemaVersion: 1;
  readonly repository: RepositoryManifest;
  readonly stages: readonly PipelineStageName[];
  readonly stageDefinitions: Readonly<Record<PipelineStageName, StageDefinition>>;
  readonly targets: readonly TargetManifest[];
}

export interface LoadedManifest {
  readonly manifest: Manifest;
  readonly sha256: string;
}
