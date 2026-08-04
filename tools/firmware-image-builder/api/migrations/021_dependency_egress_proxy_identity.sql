ALTER TABLE jobs ADD COLUMN builder_dependency_egress_proxy_sha256 TEXT;

DROP TRIGGER jobs_builder_identity_guard_update;

-- Migration 020 identities did not bind the host-side proxy policy bytes. They
-- cannot be admitted retroactively because SQLite has no trusted file hashing
-- authority, so every historical identity is blocked and must be re-enqueued.
--
-- A crash during the legacy recovery hand-back path could leave an interrupted
-- terminal job with runner_started_at and stale lease fields even though the
-- durable cleanup completion and hand-back proof had already established
-- runner inactivity and exact Docker absence. Reconcile only that exact,
-- immutable proof shape. The TypeScript precheck runs after this update in the
-- same transaction, so every other active or dispatched row aborts the whole
-- migration and rolls back this reconciliation.
WITH qualified_candidate AS (
  SELECT job.job_id, lease.admission_id, lease.complete_at
  FROM jobs AS job
  JOIN cleanup_leases AS lease
    ON lease.job_id = job.job_id
   AND lease.status = 'handed_back'
  JOIN job_events AS completion
    ON completion.job_id = job.job_id
   AND completion.event_type = 'cleanup_complete'
   AND completion.at = lease.complete_at
   AND completion.state = lease.stale_state
  JOIN job_events AS handback
    ON handback.job_id = job.job_id
   AND handback.event_type = 'recovery'
   AND handback.at = lease.handback_at
   AND handback.state = 'interrupted'
  WHERE job.state = 'interrupted'
    AND job.queue_state = 'complete'
    AND job.terminal_at IS NOT NULL
    AND job.runner_unit IS NOT NULL
    AND job.runner_started_at IS NOT NULL
    AND job.runner_finished_at IS NULL
    AND job.runner_lease_owner IS NOT NULL
    AND job.runner_lease_expires_at IS NOT NULL
    AND job.cleanup_admission_id IS NULL
    AND job.cleanup_fence_generation IS NULL
    AND job.cleanup_fence_token_hash IS NULL
    AND job.cleanup_blocker_code IS NULL
    AND job.cleanup_blocker_json IS NULL
    AND job.container_id IS NULL
    AND job.container_name IS NULL
    AND job.container_image_digest IS NULL
    AND job.container_label_job_id IS NULL
    AND job.container_label_manifest_sha IS NULL
    AND job.container_labels_json IS NULL
    AND job.container_mount_json IS NULL
    AND job.container_env_json IS NULL
    AND job.container_security_json IS NULL
    AND job.container_inspection_json IS NULL
    AND job.container_created_at IS NULL
    AND job.container_started_at IS NULL
    AND job.container_stopped_at IS NULL
    AND job.container_removed_at IS NULL
    AND job.container_cleanup_outcome IS NULL

    -- One handed-back generation is the complete admission boundary. Expired
    -- predecessors are allowed, but another handed-back generation is not.
    AND (
      SELECT COUNT(*)
      FROM cleanup_leases AS handed_back_lease
      WHERE handed_back_lease.job_id = job.job_id
        AND handed_back_lease.status = 'handed_back'
    ) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM cleanup_leases AS active_lease
      WHERE active_lease.job_id = job.job_id
        AND active_lease.status IN ('admitted', 'claimed', 'failed', 'blocking')
    )

    -- Bind the terminal row to the immutable handed-back lease and its sealed
    -- evidence identity. Canonical timestamps make lexical chronology exact.
    AND lease.claim_at IS NOT NULL
    AND lease.complete_at IS NOT NULL
    AND lease.handback_at IS NOT NULL
    AND lease.handback_at = job.terminal_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', job.runner_started_at) = job.runner_started_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', job.runner_lease_expires_at) = job.runner_lease_expires_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', lease.claim_at) = lease.claim_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', lease.complete_at) = lease.complete_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ', lease.handback_at) = lease.handback_at
    AND job.runner_started_at <= job.runner_lease_expires_at
    AND lease.claim_at <= lease.complete_at
    AND lease.complete_at <= lease.handback_at
    AND lease.blocker_code IS NULL
    AND lease.blocker_json IS NULL
    AND lease.completion_evidence_path = 'jobs/' || job.job_id || '/evidence/cleanup/' || lease.admission_id || '.complete.json'
    AND length(lease.completion_evidence_sha256) = 64
    AND lease.completion_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND lease.stale_runner_unit = job.runner_unit
    AND lease.stale_runner_owner = job.runner_lease_owner
    AND lease.stale_runner_lease_expires_at = job.runner_lease_expires_at
    AND lease.stale_state IN ('starting', 'preflight', 'source', 'release_gates', 'frontend', 'target_setup', 'feeds', 'config', 'building', 'verifying', 'publishing', 'cancel_requested')
    AND lease.stale_container_id IS NOT NULL
    AND lease.stale_container_name IS NOT NULL
    AND json_valid(lease.stale_container_labels_json) = 1

    -- The admission snapshot is immutable after claim. Require its runner and
    -- exact container identity to agree with every stale_* field on the lease.
    AND json_valid(lease.proof_json) = 1
    AND json_type(lease.proof_json) = 'object'
    AND json_extract(lease.proof_json, '$.state') = lease.stale_state
    AND json_extract(lease.proof_json, '$.runner.unit') = lease.stale_runner_unit
    AND json_extract(lease.proof_json, '$.runner.owner') = lease.stale_runner_owner
    AND json_extract(lease.proof_json, '$.runner.leaseExpiresAt') = lease.stale_runner_lease_expires_at
    AND json_extract(lease.proof_json, '$.container.kind') = 'present'
    AND json_extract(lease.proof_json, '$.container.id') = lease.stale_container_id
    AND json_extract(lease.proof_json, '$.container.name') = lease.stale_container_name
    AND length(json_extract(lease.proof_json, '$.container.imageDigest')) = 64
    AND json_extract(lease.proof_json, '$.container.imageDigest') NOT GLOB '*[^0-9a-f]*'
    AND json_extract(lease.proof_json, '$.container.labels."org.osi.image-builder.job-id"') = job.job_id
    AND json_extract(lease.proof_json, '$.container.labels."org.osi.image-builder.manifest-sha"') = job.target_manifest_sha256
    AND json_extract(lease.stale_container_labels_json, '$."org.osi.image-builder.job-id"') = job.job_id
    AND json_extract(lease.stale_container_labels_json, '$."org.osi.image-builder.manifest-sha"') = job.target_manifest_sha256
    AND (SELECT COUNT(*) FROM json_each(json_extract(lease.proof_json, '$.container.labels'))) = 2
    AND (SELECT COUNT(*) FROM json_each(lease.stale_container_labels_json)) = 2

    -- Bind runner inactivity to both the immutable snapshot and completion
    -- event, with the canonical chronology requested by the hand-back proof.
    AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(lease.proof_json, '$.runner.inactiveAt')) = json_extract(lease.proof_json, '$.runner.inactiveAt')
    AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(lease.proof_json, '$.runner.observedAt')) = json_extract(lease.proof_json, '$.runner.observedAt')
    AND lease.stale_runner_lease_expires_at <= json_extract(lease.proof_json, '$.runner.inactiveAt')
    AND json_extract(lease.proof_json, '$.runner.inactiveAt') <= json_extract(lease.proof_json, '$.runner.observedAt')
    AND json_extract(lease.proof_json, '$.runner.observedAt') <= lease.complete_at
    AND json_valid(completion.payload_json) = 1
    AND json_extract(completion.payload_json, '$.admissionId') = lease.admission_id
    AND json_extract(completion.payload_json, '$.evidencePath') = lease.completion_evidence_path
    AND json_extract(completion.payload_json, '$.postcondition.blocker') = 'none'
    AND json_extract(completion.payload_json, '$.postcondition.state') = lease.stale_state
    AND json_extract(completion.payload_json, '$.postcondition.runner.unit') = lease.stale_runner_unit
    AND json_extract(completion.payload_json, '$.postcondition.runner.owner') = lease.stale_runner_owner
    AND json_extract(completion.payload_json, '$.postcondition.runner.leaseExpiresAt') = lease.stale_runner_lease_expires_at
    AND json_extract(completion.payload_json, '$.postcondition.runner.inactiveAt') = json_extract(lease.proof_json, '$.runner.inactiveAt')
    AND json_extract(completion.payload_json, '$.postcondition.runner.observedAt') = json_extract(lease.proof_json, '$.runner.observedAt')

    -- Bind the completion observation to the exact snapshot container. Both
    -- removal outcomes prove exact-ID and global-label absence.
    AND json_extract(completion.payload_json, '$.postcondition.container.id') = lease.stale_container_id
    AND json_extract(completion.payload_json, '$.postcondition.container.name') = lease.stale_container_name
    AND json_extract(completion.payload_json, '$.postcondition.container.imageDigest') = json_extract(lease.proof_json, '$.container.imageDigest')
    AND json_extract(completion.payload_json, '$.postcondition.container.labels."org.osi.image-builder.job-id"') = job.job_id
    AND json_extract(completion.payload_json, '$.postcondition.container.labels."org.osi.image-builder.manifest-sha"') = job.target_manifest_sha256
    AND (SELECT COUNT(*) FROM json_each(json_extract(completion.payload_json, '$.postcondition.container.labels'))) = 2
    AND json_extract(completion.payload_json, '$.postcondition.container.exactIdAbsent') = 1
    AND json_extract(completion.payload_json, '$.postcondition.container.globalLabelResult') = 'no-match'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(lease.proof_json, '$.container.observedAt')) = json_extract(lease.proof_json, '$.container.observedAt')
    AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(completion.payload_json, '$.postcondition.container.observedAt')) = json_extract(completion.payload_json, '$.postcondition.container.observedAt')
    AND json_extract(lease.proof_json, '$.container.observedAt') <= json_extract(completion.payload_json, '$.postcondition.container.observedAt')
    AND json_extract(completion.payload_json, '$.postcondition.container.observedAt') <= lease.complete_at
    AND (
      (
        json_extract(completion.payload_json, '$.postcondition.container.kind') = 'already-absent'
        AND json_extract(completion.payload_json, '$.postcondition.container.dockerAction') = 'none'
      )
      OR (
        json_extract(completion.payload_json, '$.postcondition.container.kind') = 'removed'
        AND json_extract(completion.payload_json, '$.postcondition.container.dockerAction') = 'remove'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(completion.payload_json, '$.postcondition.container.stoppedAt')) = json_extract(completion.payload_json, '$.postcondition.container.stoppedAt')
        AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(completion.payload_json, '$.postcondition.container.removedAt')) = json_extract(completion.payload_json, '$.postcondition.container.removedAt')
        AND json_extract(lease.proof_json, '$.container.observedAt') <= json_extract(completion.payload_json, '$.postcondition.container.stoppedAt')
        AND json_extract(completion.payload_json, '$.postcondition.container.stoppedAt') <= json_extract(completion.payload_json, '$.postcondition.container.removedAt')
        AND json_extract(completion.payload_json, '$.postcondition.container.removedAt') <= json_extract(completion.payload_json, '$.postcondition.container.observedAt')
      )
    )

    -- Dependency-egress resources are a separate ownership domain. Missing or
    -- partial proof is not equivalent to absence.
    AND json_type(completion.payload_json, '$.postcondition.egress') = 'object'
    AND json_type(completion.payload_json, '$.postcondition.egress.persistedDocker') = 'null'
    AND json_type(completion.payload_json, '$.postcondition.egress.discoveredDocker') = 'array'
    AND json_array_length(completion.payload_json, '$.postcondition.egress.discoveredDocker') = 0
    AND json_type(completion.payload_json, '$.postcondition.egress.credentials') = 'array'
    AND json_array_length(completion.payload_json, '$.postcondition.egress.credentials') = 0
    AND json_extract(completion.payload_json, '$.postcondition.egress.globalLabelResult') = 'no-match'

    -- Hand-back is the terminal transition for this exact admission.
    AND json_valid(handback.payload_json) = 1
    AND json_extract(handback.payload_json, '$.admissionId') = lease.admission_id
    AND json_extract(handback.payload_json, '$.state') = 'interrupted'
),
single_candidate AS (
  SELECT job_id, MIN(admission_id) AS admission_id, MIN(complete_at) AS complete_at
  FROM qualified_candidate
  GROUP BY job_id
  HAVING COUNT(*) = 1
)
UPDATE jobs AS job
SET runner_finished_at = candidate.complete_at,
    runner_lease_owner = NULL,
    runner_lease_expires_at = NULL
FROM single_candidate AS candidate
WHERE job.job_id = candidate.job_id;

UPDATE jobs
SET builder_identity_status = 'legacy_blocked',
    builder_package_version = NULL,
    builder_package_root = NULL,
    builder_lock_sha256 = NULL,
    builder_execution_definition_sha256 = NULL,
    builder_target_manifest_sha256 = NULL,
    builder_runner_sha256 = NULL,
    builder_cleanup_worker_sha256 = NULL,
    builder_dependency_egress_proxy_sha256 = NULL,
    builder_image_reference = NULL,
    builder_image_id = NULL,
    builder_image_digest = NULL
WHERE builder_identity_status = 'admitted';

INSERT INTO job_events (job_id, seq, event_type, state, stage, payload_json, at)
SELECT job_id,
       COALESCE((SELECT MAX(existing.seq) + 1 FROM job_events AS existing WHERE existing.job_id = jobs.job_id), 0),
       'recovery',
       'interrupted',
       NULL,
       '{"reason":"legacy job has no dependency egress proxy identity","recovery":"reenqueue-required"}',
       updated_at
FROM jobs
WHERE builder_identity_status = 'legacy_blocked' AND queue_state = 'queued';

DELETE FROM queue_entries
WHERE job_id IN (
  SELECT job_id FROM jobs
  WHERE builder_identity_status = 'legacy_blocked' AND queue_state = 'queued'
);

UPDATE jobs
SET state = 'interrupted',
    current_stage = NULL,
    queue_state = 'complete',
    queue_position = NULL,
    terminal_error_code = 'BUILDER_DIGEST_MISMATCH',
    terminal_error_json = '{"reason":"legacy job has no dependency egress proxy identity","recovery":"reenqueue-required"}',
    terminal_at = updated_at
WHERE builder_identity_status = 'legacy_blocked' AND queue_state = 'queued';

UPDATE jobs
SET queue_position = (
  SELECT COUNT(*) FROM jobs AS predecessor
  WHERE predecessor.queue_state = 'queued'
    AND (
      predecessor.queue_position < jobs.queue_position
      OR (predecessor.queue_position = jobs.queue_position AND predecessor.job_id < jobs.job_id)
    )
)
WHERE queue_state = 'queued';

CREATE TRIGGER jobs_builder_proxy_identity_guard
BEFORE INSERT ON jobs
WHEN NOT (
  NEW.builder_identity_status = 'admitted'
  AND NEW.builder_dependency_egress_proxy_sha256 IS NOT NULL
  AND length(NEW.builder_dependency_egress_proxy_sha256) = 64
  AND NEW.builder_dependency_egress_proxy_sha256 NOT GLOB '*[^0-9a-f]*'
  AND NEW.builder_dependency_egress_proxy_sha256 <> '0000000000000000000000000000000000000000000000000000000000000000'
)
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is incomplete or invalid');
END;

CREATE TRIGGER jobs_builder_identity_guard_update
BEFORE UPDATE OF builder_identity_status, builder_package_version, builder_package_root, builder_lock_sha256,
  builder_execution_definition_sha256, builder_target_manifest_sha256, builder_image_reference,
  builder_runner_sha256, builder_cleanup_worker_sha256, builder_dependency_egress_proxy_sha256,
  builder_image_id, builder_image_digest ON jobs
WHEN NEW.builder_identity_status IS NOT OLD.builder_identity_status
  OR NEW.builder_package_version IS NOT OLD.builder_package_version
  OR NEW.builder_package_root IS NOT OLD.builder_package_root
  OR NEW.builder_lock_sha256 IS NOT OLD.builder_lock_sha256
  OR NEW.builder_execution_definition_sha256 IS NOT OLD.builder_execution_definition_sha256
  OR NEW.builder_target_manifest_sha256 IS NOT OLD.builder_target_manifest_sha256
  OR NEW.builder_runner_sha256 IS NOT OLD.builder_runner_sha256
  OR NEW.builder_cleanup_worker_sha256 IS NOT OLD.builder_cleanup_worker_sha256
  OR NEW.builder_dependency_egress_proxy_sha256 IS NOT OLD.builder_dependency_egress_proxy_sha256
  OR NEW.builder_image_reference IS NOT OLD.builder_image_reference
  OR NEW.builder_image_id IS NOT OLD.builder_image_id
  OR NEW.builder_image_digest IS NOT OLD.builder_image_digest
BEGIN
  SELECT RAISE(ABORT, 'job builder identity is immutable');
END;
