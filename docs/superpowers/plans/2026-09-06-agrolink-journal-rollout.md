# AgroLink Journal Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently verify, push, deploy, and live-test the completed Journal parity release on AgroLink without touching any other deployment.

**Architecture:** Integrate the three implementation trains in dependency order: cloud consumer/storage, edge contracts/applier, then shared UI/catalog. Push both reviewed branches. Build the cloud backend image locally because it embeds the React UI, transfer it without a registry, and recreate only `agrolink-backend` with a preserved rollback image.

**Tech Stack:** Git, Node/Vitest/Vite, Gradle/JUnit/Spring Boot, Docker BuildKit, Docker Compose, SSH, curl, browser verification.

**Spec:** [Journal Edge/Cloud Parity and Fast Capture](../specs/2026-09-06-journal-edge-cloud-parity-and-fast-capture-design.md), §§9–10. Execute after the other three plans are green.

## Global Constraints

- Only `agro-link.ch` and Compose project `agrolink` are authorized. Never access `osicloud.ch`, Bovey, `/home/rocky/docker/osi-server`, or generic `osi-*` projects.
- Do not deploy edge firmware/Pi payloads in this rollout; commit and push edge changes for the next controlled gateway release. The live cloud UI must capability-gate batch behavior against the currently advertised edge capability.
- Do not alter `.env`, databases, Mosquitto, Caddy, or any other container.
- Build locally for `linux/amd64`; never compile on the VPS.
- Mandatory timestamped backup under `/home/rocky/backups/` and rollback image tag before recreation.
- A failed acceptance check triggers backend-only rollback and evidence capture.

---

### Task 1: Integrate and audit implementation history

- [ ] Confirm the edge worktree is `fix/deploy-agrolink-analysis-responsive-edge` and cloud worktree is `fix/deploy-agrolink-analysis-responsive-cloud`; inspect `git status --short --branch` in both.
- [ ] Confirm commits follow consumer-first dependency order and contain no secrets, generated junk, unrelated files, or production configuration changes.
- [ ] Compare implementation against every normative requirement in the design and all checkboxes in the three plans. Create a concise coverage table in the execution report.
- [ ] Run an independent fresh-agent code review focused on farmer speed, authority correctness, accessibility, schema/idempotency, and edge/cloud drift. Fix every required finding through test-first commits and repeat with a fresh reviewer until GREEN.

### Task 2: Run complete local verification

- [ ] Run edge gates:

```bash
node scripts/test-journal-schema.js
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/test-journal-command-path.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
node scripts/verify-db-schema-consistency.js
cd web/react-gui
npm run test:unit
npm run build
```

- [ ] Run cloud gates:

```bash
cd frontend
npm run test:unit
npm run build
cd ../backend
./gradlew test
```

- [ ] Run `git diff --check` and confirm clean worktrees after commits.
- [ ] Push both exact reviewed branches and verify remote refs resolve to local HEADs.

### Task 3: Resolve and preserve the current AgroLink deployment

- [ ] Using only `ssh -i /home/phil/.ssh/osicloud_rsa rocky@agro-link.ch`, inspect the Compose model from `/home/rocky/docker/agrolink/osi-server/docker` with project `agrolink`. Confirm backend resolves to `ghcr.io/open-smart-irrigation/osi-server-backend:dev-local` and the target container is `agrolink-backend`.
- [ ] Record current container ID, image ID/digest, health, start time, and recent error baseline.
- [ ] Resolve `AGROLINK_BACKUP=/home/rocky/backups/agrolink-$(date -u +%Y%m%dT%H%M%SZ)` on the host, create it with mode `0700`, and create this manifest before any image retag or container recreation:
  - `repo.tar.gz`: archive of `/home/rocky/docker/agrolink/osi-server`, including its deployment `.env` and Compose overrides, with ownership/permissions preserved;
  - `compose-images.txt`: output of the scoped `docker compose -p agrolink ... config --images` command (not rendered environment values);
  - `containers-before.txt`: scoped container names, IDs, images, states, and mount declarations;
  - `postgres.dump`: custom-format `pg_dump` executed read-only inside the PostgreSQL container resolved by `docker compose ... ps -q postgres`, using that container's existing `POSTGRES_USER` and `POSTGRES_DB` without printing them;
  - `persistent-mounts.txt`: the scoped Mosquitto and OpenAgri container mount source/destination list so their unchanged persistent state is recoverable through the existing volume snapshots/backups; if no maintained snapshot exists, archive each resolved bind-mount source read-only into this backup before proceeding.
- [ ] Use the following scoped commands for the repository, Compose, container, and PostgreSQL artifacts; keep the task-specific variables in the same remote shell:

```bash
cd /home/rocky/docker/agrolink/osi-server/docker
AGROLINK_BACKUP=/home/rocky/backups/agrolink-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$AGROLINK_BACKUP"
tar --acls --xattrs --numeric-owner -czf "$AGROLINK_BACKUP/repo.tar.gz" \
  -C /home/rocky/docker/agrolink osi-server
docker compose -p agrolink -f docker-compose.yml -f docker-compose.agrolink.yml \
  config --images >"$AGROLINK_BACKUP/compose-images.txt"
docker inspect $(docker compose -p agrolink -f docker-compose.yml \
  -f docker-compose.agrolink.yml ps -q) \
  --format '{{.Name}} {{.Id}} {{.Image}} {{.State.Status}} {{json .Mounts}}' \
  >"$AGROLINK_BACKUP/containers-before.txt"
cp "$AGROLINK_BACKUP/containers-before.txt" "$AGROLINK_BACKUP/persistent-mounts.txt"
AGROLINK_PG_CONTAINER=$(docker compose -p agrolink -f docker-compose.yml \
  -f docker-compose.agrolink.yml ps -q postgres)
test -n "$AGROLINK_PG_CONTAINER"
docker exec "$AGROLINK_PG_CONTAINER" sh -c \
  'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  >"$AGROLINK_BACKUP/postgres.dump"
chmod 0600 "$AGROLINK_BACKUP/repo.tar.gz" "$AGROLINK_BACKUP/postgres.dump"
```

- [ ] Write `SHA256SUMS` for every regular backup artifact, set files containing environment/database content to mode `0600`, run `pg_restore --list postgres.dump`, test the tar archive with `tar -tzf`, verify every checksum, and abort deployment if any artifact is empty or invalid. Do not print `.env` or dump contents.
- [ ] Add a unique immutable rollback tag to the current backend image and verify it resolves to the recorded image ID.

### Task 4: Build and transfer the reviewed backend image

- [ ] Choose a unique tag `agrolink-journal-<cloud-short-sha>` and build from the cloud repository root:

```bash
docker build --platform linux/amd64 \
  -f docker/backend/Dockerfile \
  -t ghcr.io/open-smart-irrigation/osi-server-backend:<tag> .
```

- [ ] Inspect the image architecture and labels. Start it locally if the repository's container smoke test supports an isolated disposable stack; otherwise rely on full build/tests and note that boundary.
- [ ] Transfer without a registry:

```bash
docker save ghcr.io/open-smart-irrigation/osi-server-backend:<tag> |
  gzip |
  ssh -i /home/phil/.ssh/osicloud_rsa rocky@agro-link.ch 'gunzip | docker load'
```

- [ ] Verify the transferred tag resolves to the expected local image ID/digest on AgroLink.

### Task 5: Recreate only AgroLink backend

- [ ] On AgroLink, tag the transferred image as `dev-local`.
- [ ] From `/home/rocky/docker/agrolink/osi-server/docker`, run only:

```bash
docker compose -p agrolink \
  -f docker-compose.yml \
  -f docker-compose.agrolink.yml \
  up -d --no-deps --force-recreate backend
```

- [ ] Confirm only `agrolink-backend` was recreated and every other container ID/start time is unchanged.
- [ ] Poll `https://agro-link.ch/actuator/health` until it returns exactly `{"status":"UP"}` within the normal startup window. Do not leave the service unhealthy while investigating.

### Task 6: Live acceptance and rollback decision

- [ ] Inspect startup and subsequent backend logs for new Flyway, API, WebSocket, authorization, schema, or uncaught errors relative to baseline.
- [ ] Confirm gateway `0016C001F116EBF2` retains fresh REST and MQTT activity without exposing credentials.
- [ ] In a private browser context, prove the asset hashes changed and verify: shared edge-like Journal layout; grey background/white fields; no duplicate header, Status selector, dashboard/refresh buttons, or Export research package button.
- [ ] Verify ST72 shows 72 plots and ST12 shows 12; select each independently, trigger both CSV and JSON downloads from the deployed browser UI, and inspect the requests and downloaded entry UUID sets to prove the UI sent the same station scope as the visible table. Verify unknown scope fails closed.
- [ ] Verify default Quick capture, operation-filtered Lysimeter machinery, More details disclosure, station range/all selection, draft tray, visible desktop Save, keyboard/focus basics, and deterministic activation ceilings.
- [ ] Verify cloud-primary attachments/conflicts remain present and gateway-backed attachments remain absent.
- [ ] If the live gateway lacks `journal_entry_batch_v1`, verify multi-plot gateway batch is clearly unavailable while single-entry remains usable. If present, verify a safe non-destructive receipt flow according to the agreed test fixture; do not create misleading production records merely to test it.
- [ ] Report human p75 as not measured unless the four-person pilot was actually performed.
- [ ] If any required acceptance fails, retag the preserved rollback image as `dev-local`, recreate only backend with the same Compose command, verify health/logs, and report the failing and rollback evidence.

### Task 7: Final evidence

- [ ] Record edge/cloud local and remote SHAs, image tag/ID, backup path, previous rollback tag, container ID, health response, test commands/results, live asset hash, and acceptance outcomes.
- [ ] Confirm explicitly that `osicloud.ch`, Bovey, other Compose projects, `.env`, databases, Mosquitto, and Caddy were untouched.
- [ ] Leave both repository worktrees clean and provide any deferred edge-firmware enablement as a bounded follow-up, not as a claim that live capability is already present.
