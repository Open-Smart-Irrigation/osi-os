import type { JsonObject } from '../../api/src/store.js';
import {
  encodeJson,
  normalizeJson,
  stableRelativePath,
} from '../../api/src/validation.js';
import { PIPELINE_STAGE_NAMES } from '../../domain/types.js';

export interface TerminalVerification {
  readonly manifest: JsonObject;
  readonly bytes: string;
}

function canonicalObject(value: unknown, field: string): JsonObject {
  const normalized = normalizeJson(value, field);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return normalized as JsonObject;
}

export function createTerminalVerification(
  jobIdInput: string,
  verificationManifest: JsonObject,
): TerminalVerification {
  const jobId = stableRelativePath(jobIdInput, 'terminal verification job ID');
  if (jobId.includes('/')) throw new Error('terminal verification job ID is not one path segment');
  const observations = verificationManifest.observations;
  if (observations === null || typeof observations !== 'object' || Array.isArray(observations)) {
    throw new Error('staged verification observations are invalid');
  }
  const observationRecord = observations as JsonObject;
  const stageEvidence = observationRecord.stageEvidence;
  if (!Array.isArray(stageEvidence) || stageEvidence.length !== PIPELINE_STAGE_NAMES.length) {
    throw new Error('staged verification stage aggregation is invalid');
  }
  const terminalStages = stageEvidence.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('staged verification stage record is invalid');
    }
    const stage = PIPELINE_STAGE_NAMES[index];
    const record = entry as JsonObject;
    if (
      record.stage !== stage
      || record.path !== `${String(index).padStart(2, '0')}-${stage}.json`
    ) {
      throw new Error('staged verification stage record is out of order');
    }
    if (index === PIPELINE_STAGE_NAMES.length - 1) {
      if (record.outcome !== 'running' && record.outcome !== 'passed') {
        throw new Error('staged verification contains an invalid publish outcome');
      }
      return { stage: 'publish', path: '09-publish.json', outcome: 'passed' };
    }
    if (record.outcome !== 'passed') {
      throw new Error('staged verification contains a non-passed prerequisite');
    }
    return record;
  });
  const evidencePath = `jobs/${jobId}/evidence/09-publish.json`;
  const finalStage = stageEvidence.at(-1);
  if (
    finalStage !== null
    && typeof finalStage === 'object'
    && !Array.isArray(finalStage)
    && (finalStage as JsonObject).outcome === 'passed'
  ) {
    const publishEvidence = observationRecord.publishEvidence;
    if (
      publishEvidence === null
      || typeof publishEvidence !== 'object'
      || Array.isArray(publishEvidence)
      || Object.keys(publishEvidence).join('\0') !== 'path'
      || (publishEvidence as JsonObject).path !== evidencePath
    ) {
      throw new Error('terminal verification does not bind publish evidence');
    }
  }
  const manifest = canonicalObject({
    ...verificationManifest,
    observations: {
      ...observationRecord,
      stageEvidence: terminalStages,
      publishEvidence: { path: evidencePath },
    },
  }, 'terminal verification manifest');
  return Object.freeze({
    manifest,
    bytes: encodeJson(manifest, 'terminal verification manifest', true),
  });
}
