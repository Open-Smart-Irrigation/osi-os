# OSI firmware image builder

**Status:** ready for implementation

**Scope:** local Linux workstation, one Raspberry Pi image per job

**Implementation shape:** standalone runner, local Node/TypeScript API, React/Vite UI, and user-level systemd services

## 1. Problem

The current release workflow depends on an operator remembering state that the
build system does not record. A source branch can move while an image is being
built, `make switch-env` can remove installed feed links, a host compiler can
be incompatible with the pinned OpenWrt toolchain, and an old small image can
look like a successful output. Browser state does not help with any of these
failures.

The builder will turn one remote branch commit and one target into a durable
job. It will fetch and pin the commit, build in a detached worktree, capture
the commands and evidence for every stage, verify the generated image, and
publish it only after all gates pass. The browser is a view and control surface;
the runner owns the build process.

## 2. Goals

The system must:

- run on the Linux workstation that has the OSI OS checkout, Docker, Node/npm,
  and the OpenWrt build resources;
- allow the operator to select an `origin` branch, a target, and one approved
  output root;
- fetch the selected remote branch and pin the exact full SHA before worktree
  creation;
- keep the build independent of the active checkout, its dirty state, and the
  browser or API process;
- serialize jobs in a persistent FIFO queue;
- run one Pi 5 or one Pi 4/400/3/2 target per job;
- execute the repository release gates, frontend build, target setup, OpenWrt
  build, and release-grade artifact checks;
- preserve logs, stage evidence, source identity, tool versions, and failure
  diagnosis after a restart;
- make a newer remote commit visible without changing the commit being built;
- publish the verified image and its manifest atomically into a deterministic
  branch/SHA/target directory;
- prevent writes outside configured output roots and prevent overwriting an
  existing target directory.

## 3. Non-goals

The MVP does not:

- flash an SD card;
- boot-test hardware or run QEMU;
- build local uncommitted work;
- accept arbitrary output paths;
- access multiple repositories;
- run parallel builds;
- combine Pi 4 and Pi 5 outputs in one job;
- restart a build automatically when the remote branch advances;
- operate as a remote or multi-user service;
- contact OSI Server, `osicloud.ch`, ChirpStack services, or any production
  endpoint;
- accept secrets or inject cloud credentials into a build;
- delete or overwrite user files as part of cleanup.

## 4. Terms

These terms are used in the API, database, UI, logs, and evidence files.

| Term | Definition |
| --- | --- |
| Repository | The configured local clone of `osi-os`; the MVP uses one repository only. |
| Remote branch | A branch resolved from `refs/remotes/origin/<branch>` after `git fetch origin --prune`. A local branch is never a source. |
| Pinned source | The complete 40-character commit SHA resolved and persisted by the API at queue acceptance. |
| Target | One manifest entry, either `rpi-5` or `rpi-2`. `rpi-2` is the Pi 4/400/3/2 universal image. |
| Build worktree | A job-owned detached Git worktree containing the pinned source and its OpenWrt submodule state. |
| Stage | A named pipeline unit with inputs, trusted typed operations, pass evidence, and failure classification. |
| Artifact | The target factory image, ending in `.img.gz`, plus its published manifest and checksum files. |
| Quarantine | The single builder-managed directory under an approved output root for failed, cancelled, interrupted, or superseded staging. Quarantine contents are never presented as verified output. |
| Approved output root | A configured, canonical directory in which the API may create release directories. The UI selects an entry; it cannot submit a new path. |
| Release directory | `<approved-root>/<branch-slug>/<source-sha>/<target-id>/`. It is created once and is immutable after publication. |
| Evidence | A machine-readable record proving a stage result, including command, exit code, timestamps, selected paths, and relevant hashes or measurements. |
| Newer source | A later SHA currently at the same remote branch after the job pinned its source. It is informational and never changes the active job. |
| Cleanup fence | A per-job compare-and-set barrier installed atomically by API recovery admission. While present, runner lease, stage, operation, container, and terminal writes are rejected; only the matching cleanup worker and API hand-back may advance recovery. |
| Direct interruption proof | A transaction proving `jobs.container_*` are all null, the global Docker label query has no matching job container, staging is absent, logs are sealed at their last durable event with no orphan tail or gap, and no blocker, cleanup admission, or cleanup fence exists. Only this proof permits API interruption without a cleanup worker. |
| Admission ID | A tool-generated systemd-safe identifier matching `^cln_[0-7][0-9a-hj-km-np-tv-z]{25}$`: lowercase fixed prefix `cln_` plus one canonical lowercase Crockford-Base32 ULID. The first ULID character is limited to `0` through `7` by the 128-bit ULID range. The ID is immutable, never user supplied, contains no slash, backslash, percent, whitespace, `@`, dot, or shell metacharacter, and is used directly as the only dynamic systemd instance argument. |

The API uses `rpi-5` and `rpi-2` as stable target IDs. It displays “Pi 5” and
“Pi 4 / 400 / 3 / 2” as the corresponding human labels.

## 5. Architecture

```text
                 127.0.0.1
       React/Vite UI <----> Node/TypeScript API
          |                      |
          | SSE                  | SQLite job database
          |                      |
          +----------------------+-- systemctl --user start
                                         |
                             osi-image-builder-runner@JOB.service
                                         |
                                 deterministic runner
                                         |
              detached job worktree + Docker-supported OpenWrt builder
                                         |
                              staging output -> verified publish
```

### 5.1 Components

| Component | Owns | Does not own |
| --- | --- | --- |
| React/Vite UI | Form state, queue view, log display, verification display, operator actions | Git, Docker, filesystem paths, build processes, source pinning |
| Local API | Configuration, request validation, remote SHA pinning at acceptance, FIFO queue, queue/cancellation fields, systemd dispatch, cleanup-worker admission leases, enumerated recovery terminals and blocker rechecks, SSE | Compilation, Git worktree contents, normal stage/terminal transitions, Docker runtime identity, cleanup execution, normal/live publishing execution or decisions |
| Runner | Detached worktree from the persisted SHA, preflight execution, gates, frontend preparation, target setup, direct Docker lifecycle and runtime identity, verification, staging, cancellation cleanup, atomic publish, normal stage/terminal transitions | Queue ordering, source selection, recovery terminal transitions, arbitrary API requests, production access |
| Cleanup worker | A narrowly admitted recovery lease; stop/remove of the exact persisted container, absence verification, orphan-log sealing, staging quarantine, cleanup evidence, cleanup-worker CAS clearing of active container columns, and hand-back of cleanup completion | Stages, source/build execution, publishing, queue ordering, normal cancellation, and every terminal-state transition |
| Target/stage manifest | Target identifiers, config paths, expected artifact/rootfs paths, stage order, required checks | Job-specific state and logs |
| User systemd manager | API, runner, and API-started cleanup-worker process lifetimes | Build semantics and evidence policy |
| SQLite store | Durable job metadata and transitions | Large logs and source trees |

The API owns requests, queue order, dispatch, cleanup-worker admission, and
only these recovery terminals: `queued -> starting`, `queued -> cancelled`,
service-start failure `starting -> interrupted`, stale recovery from the
explicit active set to `interrupted`, and stale publishing recovery to
`succeeded` or `failed`, plus non-destructive publish-blocker rechecks. The
API does not own normal/live publishing execution or decisions. The API may
commit `interrupted` directly only with the Direct interruption proof. The runner
owns all normal stage and terminal transitions, Docker runtime identity and
cleanup, and normal cancellation. If any identity, matching label, staging/log
cleanup, blocker, admission, or fence exists, the cleanup worker may act only
under an API-issued recovery admission after the runner unit is inactive and
the runner lease is stale. The admission atomically installs a fence/token and
runner snapshot. For an already
`interrupted` job with only a staging or log blocker, the admission instead
proves `container_id IS NULL` and no matching labeled container; that exception
permits no Docker action. The cleanup worker performs cleanup and hands back
evidence; it cannot run stages, publish, or change terminal state. The API
clears the fence and commits stale active recovery only after hand-back;
already `interrupted` jobs remain terminal. Publishing has no interruption
transition and uses dedicated recovery. This summary is the same ownership
contract as the matrix in section 9.

### 5.2 Proposed ownership boundaries

The implementation must place the builder under `tools/firmware-image-builder/`:

```text
tools/firmware-image-builder/
  manifest/targets.json
  runner/
  api/
  ui/
  systemd/
  test/
```

The exact module names may vary during implementation, but ownership must stay
within these boundaries:

- `runner/` may read and write only the job worktree, job log/evidence paths,
  the jobs database through its runner-owned columns, and the selected output
  root after path validation;
- `api/` may mutate the jobs database and invoke `systemctl --user`; it must
  not execute build commands directly;
- `cleanup-worker/` may be started only with an API-issued cleanup admission.
  It may use Docker and the native publisher only for the admitted job's
  exact persisted container and staging/log paths. Its CAS writes are limited
  to cleanup evidence, cleanup-worker lease fields, and clearing active
  `jobs.container_*`; it cannot write `state`, `current_stage`, terminal, or
  publish fields;
- `ui/` may call the local API only;
- `manifest/targets.json` is the only source of target-specific paths and
  typed operation IDs; executable operations live in trusted TypeScript;
- `systemd/` contains unit templates and installation metadata, not build
  logic;
- existing OSI source files, `Makefile`, `Dockerfile-devel`, OpenWrt patches,
  feed files, and verification scripts remain owned by the OSI OS repository.
  The builder invokes them from the pinned worktree and does not duplicate
  their contents.

The builder is a separate tool. It must not add build state to `flows.json`,
the Pi image, or the OSI edge runtime.

## 6. Source selection and pinning

The repository configuration contains one absolute repository path and the
remote name `origin`. The API lists branches from the remote, not from local
heads. A branch name is accepted only when it matches
`^[A-Za-z0-9][A-Za-z0-9._/-]*$`, contains no `..` path component, and resolves
under `refs/remotes/origin/`.

The UI first calls `POST /api/preflight` with a branch and the SHA currently
shown to the operator. The API fetches `origin`, resolves the branch, and
returns the observed SHA plus checks. A preflight result expires after 10
minutes. The API does not reserve a source with this advisory request.

At queue acceptance, `POST /api/jobs` requires the same branch and
`expectedSha`. The API fetches `origin` again, resolves the branch, and
compares the result with `expectedSha` before inserting the job. A mismatch
returns `409 BRANCH_MOVED`; no job is inserted. On success, the API persists
the complete SHA, commit time, author, and subject in the `jobs` source columns
in the same transaction as the queue row. The runner never resolves the branch
to choose its source.

The runner performs these operations using the persisted SHA:

1. Verify the persisted SHA is a commit with `git cat-file -e <sha>^{commit}`.
2. Record the branch, remote URL, full SHA, commit time, author identity, and
   subject from `git show` and compare them with the API-persisted source row.
3. Create a detached worktree at the job-owned path from that SHA.
4. Run `git submodule update --init --recursive` inside the detached worktree.
5. Check the selected `openwrt/bin/targets/<manifest.openwrtTarget>/` path is
   absent and record that source-stage evidence before any subsequent worktree
   mutation.
6. Record the worktree HEAD and submodule SHAs, and fail if the worktree HEAD
   differs from the pinned SHA.

The runner never runs `git pull` in the active checkout and never switches the
active checkout's branch. A dirty active checkout is irrelevant to the source
pin, but the runner records a warning that the build came from the remote ref.
No local changes can enter the build. The API source resolver is the only
component allowed to run networked Git fetches, and the configured `origin`
URL must use SSH syntax such as `ssh://git.example/repository` or
`builder@git.example:repository`.

After queue acceptance, a later remote movement is handled as follows:

- the job continues with the recorded SHA;
- at verification completion, the runner requests a freshness check from the
  API source resolver over the local service socket; the runner never fetches
  or resolves the remote branch;
- when the current SHA differs, the evidence records
  `freshnessStatus: "advanced"`, `newerSourceAvailable: true`, and both SHAs;
- a successful equal-SHA result records `freshnessStatus: "fresh"`;
- an unavailable or failed check records `freshnessStatus: "unknown"` and
  does not fail an otherwise verified pinned build;
- the API shows that flag on the completed job and offers “Build newer commit”
  by creating a new job; it does not mutate or restart the existing job.

## 7. Declarative manifest

`tools/firmware-image-builder/manifest/targets.json` defines the supported
targets and ordered stages. The manifest is versioned with the builder and its
hash is recorded in each job.

The manifest schema is:

```json
{
  "schemaVersion": 1,
  "repository": {
    "name": "osi-os",
    "remote": "origin"
  },
  "stages": [
    "preflight",
    "source",
    "release-gates",
    "frontend",
    "target-setup",
    "feeds",
    "config",
    "build",
    "verify",
    "publish"
  ],
  "stageDefinitions": {
    "preflight": { "required": true, "timeoutSeconds": 300 },
    "source": { "required": true, "timeoutSeconds": 300 },
    "release-gates": { "required": true, "timeoutSeconds": 1800 },
    "frontend": { "required": true, "timeoutSeconds": 1800 },
    "target-setup": { "required": true, "timeoutSeconds": 900 },
    "feeds": { "required": true, "timeoutSeconds": 1800 },
    "config": { "required": true, "timeoutSeconds": 900 },
    "build": { "required": true, "timeoutSeconds": 21600 },
    "verify": { "required": true, "timeoutSeconds": 1800 },
    "publish": { "required": true, "timeoutSeconds": 300 }
  },
  "targets": [
    {
      "id": "rpi-5",
      "label": "Pi 5",
      "environment": "full_raspberrypi_bcm27xx_bcm2712",
      "openwrtTarget": "bcm27xx/bcm2712",
      "profile": "DEVICE_rpi-5",
      "rootfs": "build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx",
      "artifactGlob": "chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz",
      "rootfsPartSize": 14336,
      "minimumArtifactBytes": 67108864,
      "configSymbols": [
        { "name": "CONFIG_TARGET_bcm27xx_bcm2712", "type": "bool", "value": true },
        { "name": "CONFIG_TARGET_PROFILE", "type": "string", "value": "DEVICE_rpi-5" },
        { "name": "CONFIG_TARGET_ROOTFS_PARTSIZE", "type": "number", "value": 14336 },
        { "name": "CONFIG_PACKAGE_node-red", "type": "bool", "value": true },
        { "name": "CONFIG_PACKAGE_node-red-contrib-chirpstack", "type": "bool", "value": true },
        { "name": "CONFIG_PACKAGE_chirpstack", "type": "bool", "value": true },
        { "name": "CONFIG_PACKAGE_node-red-node-sqlite", "type": "bool", "value": true }
      ],
      "operations": ["activate-target", "copy-feed-config", "update-feeds", "install-feeds", "resolve-config", "build-image", "verify-image"]
    },
    {
      "id": "rpi-2",
      "label": "Pi 4 / 400 / 3 / 2",
      "environment": "full_raspberrypi_bcm27xx_bcm2709",
      "openwrtTarget": "bcm27xx/bcm2709",
      "profile": "DEVICE_rpi-2",
      "rootfs": "build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx",
      "artifactGlob": "chirpstack-gateway-os-*-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz",
      "rootfsPartSize": 14336,
      "minimumArtifactBytes": 67108864,
      "configSymbols": [
        { "name": "CONFIG_TARGET_bcm27xx_bcm2709", "type": "bool", "value": true },
        { "name": "CONFIG_TARGET_PROFILE", "type": "string", "value": "DEVICE_rpi-2" },
        { "name": "CONFIG_TARGET_ROOTFS_PARTSIZE", "type": "number", "value": 14336 },
        { "name": "CONFIG_PACKAGE_node-red", "type": "bool", "value": true },
        { "name": "CONFIG_PACKAGE_node-red-contrib-chirpstack", "type": "bool", "value": true },
        { "name": "CONFIG_PACKAGE_chirpstack", "type": "bool", "value": true },
        { "name": "CONFIG_PACKAGE_node-red-node-sqlite", "type": "bool", "value": true }
      ],
      "operations": ["activate-target", "copy-feed-config", "update-feeds", "install-feeds", "resolve-config", "build-image", "verify-image"]
    }
  ]
}
```

The implementation must validate the manifest at API startup. It must reject
unknown stage names, duplicate target IDs, unknown operation IDs, absolute
paths, path traversal, a rootfs partition size other than `14336`, a target
without a profile, a config symbol with the wrong value type, and an artifact
glob that cannot produce exactly one factory image at verification time. A
manifest error prevents new jobs from being accepted.

Each `stageDefinitions` entry specifies timeout and evidence fields. The
values above are the MVP timeouts in seconds. No stage is resumable after an
active job interruption. Stage code invokes trusted TypeScript
implementations selected by the typed operation IDs. JSON never contains shell
command text, executable paths, or user-controlled arguments. The target
entries provide the environment,
OpenWrt target, profile, rootfs, artifact pattern, exact config symbols,
partition size, and minimum artifact size consumed by those implementations.

Each operation ID maps to one trusted TypeScript argv factory and one evidence
schema. The MVP mappings are:

| Operation ID | Fixed argv shape |
| --- | --- |
| `activate-target` | `make`, `switch-env`, `ENV=<validated manifest environment>` |
| `copy-feed-config` | `node`, `<installed tool operation>`, `copy-feed-config` |
| `update-feeds` | `openwrt/scripts/feeds`, `update`, `-a` |
| `install-feeds` | `openwrt/scripts/feeds`, `install`, `-a` |
| `resolve-config` | `make`, `-C`, `openwrt`, `defconfig` |
| `build-image` | `make`, `-C`, `openwrt`, `-j4` |
| `verify-image` | `node`, `<installed tool operation>`, `verify-image` |
| `verify-profile-parity` | `node`, `scripts/verify-profile-parity.js` |
| `verify-chameleon` | `node`, `scripts/verify-chameleon-calibration.js` |
| `verify-db-schema` | `node`, `scripts/verify-db-schema-consistency.js` |
| `verify-sync-flow` | `node`, `scripts/verify-sync-flow.js` |
| `verify-strega` | `node`, `scripts/verify-strega-gen1.js` |
| `verify-communication` | `node`, `scripts/verify-communication-contract.js` |
| `check-mqtt-topics` | `scripts/check-mqtt-topics.sh` |
| `frontend-install` | `npm`, `ci` |
| `frontend-test` | `npm`, `run`, `test:unit` |
| `frontend-typecheck` | `npm`, `run`, `typecheck` |
| `frontend-build` | `npm`, `run`, `build` |
| `mirror-gui` | `node`, `<installed tool operation>`, `mirror-gui` |

Angle-bracket values are selected only from validated manifest entries or the
immutable installed tool path. They are argv elements, never shell fragments.
An operation cannot select a different executable, add an argument, or invoke
branch-provided shell text.

## 8. Persistent storage

The default state root is `${XDG_STATE_HOME:-$HOME/.local/state}/osi-image-builder`.
The default config root is `${XDG_CONFIG_HOME:-$HOME/.config}/osi-image-builder`.
The implementation must expand these values at process start and record the
resolved absolute paths in the installation report.

### 8.1 Config layout

`config.json` is user-owned and contains no secrets:

```json
{
  "repositoryPath": "/home/phil/Repos/osi-os",
  "approvedOutputRoots": [
    { "id": "sdcard-images", "label": "SD card images", "path": "/home/phil/sdcard-images" }
  ],
  "builderLockPath": "/home/phil/.local/lib/osi-image-builder/2026.07.22.1/builder.lock.json",
  "maxQueueLength": 50,
  "diskFreeMinimumBytes": 21474836480
}
```

The builder lock path must resolve to a versioned, immutable lock containing a
64-hex image digest, pinned base-image digest, Dockerfile hash, and validated
tool versions. An approved root must be absolute, exist, be writable by the
service user, resolve to a directory, and not be a symlink. The API assigns and
persists the configured stable root ID, canonicalizes the path with `realpath`,
and exposes only the ID and canonical path. A job request contains an
approved-root ID, not an arbitrary path.

### 8.2 State layout

```text
<state-root>/
  jobs.sqlite
  jobs.sqlite-wal
  jobs.sqlite-shm
  jobs/<job-id>/
    request.json
    pinned-source.json
    manifest.json
    logs/
      runner.log
      docker.log
    evidence/
      00-preflight.json
      01-source.json
      02-release-gates.json
      03-frontend.json
      04-target-setup.json
      05-feeds.json
      06-config.json
      07-build.json
      08-verify.json
      09-publish.json
    recovery/
      cleanup-credentials/
        <admission-id>.token
    workspace/
      source/                 # detached worktree, job-owned
    runtime.json              # diagnostic service/container hints only
```

SQLite is canonical for job state, queue order, source pinning, cancellation
requests, runner identity, stage outcomes, terminal outcomes, event sequence,
evidence paths, and published paths. The database is the only authority used
by the API after restart. `runtime.json` contains diagnostic hints only and
can never establish a state or a successful result.

The schema is migrated by versioned SQL files under
`tools/firmware-image-builder/api/migrations/`, tracked in a
`schema_migrations` table. Node >=22 uses the built-in `node:sqlite`
`DatabaseSync` driver with WAL mode, foreign keys, a busy timeout, and
explicit transactions. The migrations define at least `jobs`, `job_events`,
`job_stages`, `job_operations`, `queue_entries`, `cleanup_leases`, and
`schema_migrations`. `jobs` uses column ownership: the API writes request,
queue, cancellation, dispatch, cleanup-admission, and enumerated
verified-recovery columns; the runner writes runner lease, Docker runtime
identity, current stage, stage result, normal terminal state, artifact result,
and normal publish columns. The cleanup worker writes only its own lease and
cleanup evidence plus the CAS clear of active `jobs.container_*`; it retains
the cleanup fence until API hand-back. Database
constraints and compare-and-set transition
functions reject writes from the wrong owner or an illegal predecessor.

The API and runner both open the same database and use transactions. Every
queue, cancellation, stage, or terminal transition and its structured
`job_events` insertion commit atomically. Large stdout/stderr remains in
per-job files and is never used as state authority. Evidence JSON files are
immutable stage attachments; their paths, hashes, and outcomes are recorded
in SQLite. The API reads the database and evidence files during recovery, then
queries systemd and Docker only to reconcile liveness and runtime hints.

The database contract is explicit:

- `jobs` contains identity, `branch`, `pinned_sha`, target/root IDs, queue and
  cancellation fields, `state`, `current_stage`, runner unit, runner lease
  owner/expiry, Docker container ID/name, image digest, exact labels, mount,
  environment and security evidence, cleanup fence generation/token hash and
  admission ID, terminal error, artifact metadata, publish metadata, and
  timestamps;
- `queue_entries` contains one row per queued job and its FIFO sequence;
- `job_stages` contains one row per stage with start/finish, outcome, evidence
  path/hash, and stable error code;
- `job_operations` contains one row per trusted operation execution with
  operation ID, fixed argv hash, start/finish, container identity, exit code,
  outcome, and evidence path/hash. After the operation result commits, this
  row is immutable and retains the container identity and inspection evidence;
  cleanup is represented by a separate structured cleanup event;
- `job_events` contains a monotonically increasing per-job `seq`, event type,
  state/stage snapshot, structured payload, timestamp, and for log chunks the
  `stream`, `file_generation`, `byte_offset`, and `byte_length`;
- `cleanup_leases` contains one API-issued admission per recovery cleanup,
  including job ID, admission ID, exact worker unit name
  (`osi-image-builder-cleanup@<admission-id>.service`), owner, expiry, status
  (`admitted`, `claimed`, `completed`, `failed`, `blocking`, `expired`, or
  `handed_back`), credential relative path, credential hash, cleanup-fence
  generation, stale runner lease snapshot, proof snapshot (inactive runner
  unit, eligible state, and exact container identity/labels or the
  already-absent exact ID proof), and completion evidence. The API atomically
  installs the per-job fence and admission only after the mode-0600 credential
  file is durable. It may expire or rotate an admission only with CAS. The
  cleanup worker may claim, renew, and complete only its own matching
  fence/token/admission and exact persisted unit name with CAS. Completion clears container identity but not
  the fence; the API clears the fence during hand-back. The worker cannot use
  the lease to write a job state or terminal result;
- all foreign keys use `ON DELETE RESTRICT`; terminal jobs are retained by
  policy rather than deleted as a queue cleanup side effect.

The API enqueue transaction inserts `jobs`, `queue_entries`, and the enqueue
event. The API cancellation transaction updates cancellation fields and
inserts the request event. The dispatcher claim transaction removes the queue
entry, sets the runner unit, and records the dispatch event. The runner stage
transaction updates `jobs`/`job_stages` and inserts the stage event. The runner
container transaction persists the validated container identity and runtime
inspection evidence with a compare-and-set owner check before start. The
runner first commits the operation result, associated stage outcome, and their
structured events while retaining the active `jobs.container_*` identity. It
then runs `docker rm <exact-persisted-stopped-id>`, verifies that exact ID no
longer exists, and only then commits a runner-owned CAS cleanup transaction
that records cleanup success, emits a cleanup event, and clears only the
active `jobs.container_*` columns. The immutable `job_operations` row retains
the identity and inspection evidence. A failure or crash before that cleanup
transaction retains the identity as the recovery handle and blocker; it
cannot permit the next operation. The runner terminal transaction updates
terminal fields and inserts the terminal event.

Recovery cleanup has a separate transaction contract. The API first proves the
runner unit is inactive, the runner lease is stale, the job state is exactly
one of `starting`, `preflight`, `source`, `release_gates`, `frontend`,
`target_setup`, `feeds`, `config`, `building`, `verifying`, or
`cancel_requested`, and the persisted container ID, name, and both labels
match the one Docker object, or the exact persisted ID is already absent and
the global label query is empty. `queued` is excluded and `publishing` is handled
by dedicated publish recovery. An already `interrupted` job with a persisted
container ID is admitted under the same fence: if the exact ID is present,
the worker stops/removes/verifies it; if it is already absent, the worker
verifies that exact ID is absent and the global label query has no matching
container before cleanup CAS clears the identity. An already `interrupted`
job with only a staging/log blocker may instead prove null container columns
and no matching label; that exception permits no Docker action. The same null
identity/no-label admission is used for any active job that has staging or log
cleanup work, but it is not a Direct interruption proof because cleanup is
still required.

The API admission transaction locks the job, rechecks the inactive runner
unit, stale runner lease, eligible state, exact identity/label proof, and
absence of a competing admission, then atomically installs a new per-job
cleanup-fence generation and opaque token hash, derives and persists the exact
unit name `osi-image-builder-cleanup@<admission-id>.service`, inserts the stale
runner snapshot in `cleanup_leases`, and emits the admission event. The cleanup
worker rechecks and claims the matching fence/token/admission, stops/removes
only the exact persisted container when present, verifies exact absence and
the global no-label condition, seals logs, quarantines staging, records
cleanup evidence, and commits a cleanup-worker CAS that clears active
`jobs.container_*` while retaining the fence. It does not run a stage, publish,
or change `jobs.state`.

The worker hands back a completed admission. The API independently rechecks
exact absence, global no-label state, cleanup CAS completion, inactive unit,
stale lease, and no remaining blocker, then commits the stale active job to
`interrupted` and clears the fence/token/admission in one hand-back
transaction. If the job is already `interrupted`, the API leaves its state
unchanged but clears the fence only after the same hand-back proof. A worker
crash expires the admission without clearing the fence or any retained
identity, so the job remains blocked until a new matching cleanup admission.

Admission credentials are durable, job-owned files. Before the admission
transaction, the API creates
`jobs/<job-id>/recovery/cleanup-credentials/<admission-id>.token` with a
cryptographically random token, the admission ID, and the generation in a
fixed encoded record. It creates the file with mode `0600`, verifies the
service-user owner and non-symlink path, fsyncs the file, and fsyncs its parent
directory. The admission transaction stores only the credential path relative
to the job directory, its token hash, admission ID, and generation, and
references the already durable file. A file created before a failed admission
commit is an orphan: startup may prune it only from this fixed credential
directory after proving no matching SQLite admission exists, then fsync the
parent directory.

The cleanup unit's sole dynamic `ExecStart` argument is `%i`, the Admission ID.
The worker resolves the job ID, credential path, fence generation, and
persisted exact unit name from the matching `cleanup_leases` row. It validates
the Admission ID grammar, mode `0600`, owner, non-symlink traversal, admission
ID, generation, token hash, persisted exact unit name, and matching fence
before claiming. After a successful claim CAS, it securely unlinks the
credential file and fsyncs its parent; the token is never passed on argv or
environment and is not sent into Docker. A missing, corrupt, wrong-owner,
wrong-mode, or mismatched credential after DB commit does not clear the fence:
the API CAS-expires the admission, creates a new generation/token credential,
and rotates the SQLite reference before starting a retry. An expired or stale
claim always rotates generation and token, so an old token cannot claim.

If cleanup completed but API hand-back did not commit, startup or
`POST /api/jobs/:id/recover` independently validates the recorded cleanup
evidence, exact ID absence, global no-label state, and blocker resolution,
then performs hand-back without starting another worker. A failed or blocking
admission retains its fence and is exposed as an explicit retry action. After
the operator corrects the recorded blocker, retry CAS-expires the old
admission, creates and durably installs a new credential, rotates generation
and token, and starts the cleanup worker. No retry reuses an old credential.
Each update includes the expected predecessor state and runner identity, so a
stale process receives a zero-row result and stops without writing an event.
Runner lease acquisition and renewal, every normal stage/operation/container
write, and every normal terminal write also require the job's cleanup-fence
columns to be null. A runner-start or renewal CAS that races an API cleanup
admission therefore loses atomically; it cannot write beside the cleanup
worker.

### 8.3 Retention

The builder owns and may prune only its own state. It retains job database rows,
evidence, and logs for 180 days; detached worktrees for 7 days after terminal
completion; Docker/OpenWrt caches for 30 days subject to the 20 GiB free-space
floor; and quarantined staging directories for 180 days. Published release
directories are immutable and have no automatic retention or deletion policy.
The prune job runs only at API startup and requires the target to be inside
the builder state or its one approved-root quarantine directory. It records
each prune in the database and never follows symlinks.

### 8.4 Output layout

Before publication, the runner creates a staging directory under the selected
approved root:

```text
<approved-root>/.osi-image-builder/staging/<job-id>/
<approved-root>/.osi-image-builder/quarantine/<job-id>/
```

The final destination is:

```text
<approved-root>/<branch-slug>/<full-source-sha>/<target-id>/
  <factory-image>.img.gz
  sha256sums
  build-manifest.json
  verification.json
```

The branch component is an injective percent-encoding of UTF-8 bytes: only
`A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, and `~` remain literal; every other byte
becomes uppercase `%HH`. The full SHA is always retained in the path. The API
refuses a job when the final target directory exists, including a directory
from a prior failed attempt. Existing content is never removed or replaced.

Publication uses one held approved-root directory file descriptor. The native
helper creates or opens only the branch and full-SHA parent directories with
`openat`/`O_NOFOLLOW` and directory flags, rejecting symlinks and path escapes.
It does not create or open the target basename. The absent target basename is
passed directly as `newName` to a small tested native helper calling Linux
`renameat2(oldParentFd, oldName, newParentFd, newName,
RENAME_NOREPLACE)` with held parent directory descriptors;
the implementation never uses check-then-replace. If the output root cannot
provide same-filesystem staging, the job fails before building.

`<approved-root>/.osi-image-builder/quarantine/` is the only quarantine
location. It is separate from the job workspace and holds failed, cancelled,
interrupted, and superseded staging directories. A failed move leaves the
staging path recorded in SQLite and blocks publication. Quarantine is not an
approved release directory and is never returned by the verified-artifact API.

The native publisher is part of the tool, not the firmware repository. Its
source is `tools/firmware-image-builder/publisher/osi-image-publish.c` and its
build requires GCC, libc development headers, and `make`. The package build
uses `-std=c17 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror` and installs the binary
at `~/.local/lib/osi-image-builder/<package-version>/bin/osi-image-publish`.
`osi-image-publish --version` prints the package version and publisher source
SHA-256. Before the API starts, `osi-image-publish --self-test` creates private
scratch directories, tests symlink and traversal rejection, tests an atomic
no-overwrite publication, fsyncs the relevant files and directories, and
removes only that scratch tree. A failed self-test prevents startup.

## 9. Job state machine

The job has one persisted state and one optional `currentStage`. SQLite is the
only state authority. The API owns `queue_state`, `queue_position`,
`cancel_requested_at`, `cancel_reason`, dispatch fields, and cleanup-fence
admission fields. The runner owns normal `state`, `current_stage`, stage
outcomes, terminal result, and publish fields; the API owns the explicitly
listed queue and verified-recovery transitions. Both actors use
compare-and-set transactions that insert the corresponding structured event in
`job_events` before commit. An API cancellation request sets a cancellation
field. For a pre-creation cancellation, the runner proves the null container
identity and absence of a matching label; `stagingAbsent: true` is valid when
no staging exists, otherwise staging is safely quarantined before committing
the terminal transition. For a container cancellation, it stops the exact
container and records `stagingAbsent: true` or safely quarantines staging
before committing the terminal transition.

An API transition to `interrupted` is disjoint from cleanup recovery. It is
direct only when one transaction proves the Direct interruption proof: all
`jobs.container_*` columns are null, the global Docker label query has no
matching job container, no staging or log cleanup is needed, and no blocker,
cleanup admission, or cleanup fence exists. If any identity, matching label,
staging/log cleanup, blocker, admission, or fence exists, the cleanup worker
must hand back completion before the API can commit `interrupted`.

The actor/transition matrix is normative. The runner owns every Docker runtime
column (`container_id`, `container_name`, image digest, labels, inspection
evidence, lifecycle timestamps, and cleanup result) and updates those columns
with runner-identity CAS transactions during live execution. The API and
cleanup worker read them during recovery; neither writes live identity. The
cleanup worker may clear active container columns only in its own matching
fence/token/admission CAS after exact container absence has been verified, and
it retains the fence until API hand-back.

| Transition or write | Owner | Preconditions and evidence |
| --- | --- | --- |
| `queued -> starting` | API | FIFO claim transaction succeeds and records the runner unit |
| `queued -> cancelled` | API | Cancellation request wins before dispatch; no runner unit exists |
| `starting -> preflight` and all normal stage transitions through `publishing` | Runner | The persisted runner identity owns the row and each predecessor matches |
| `starting`, `preflight`, `source`, `release_gates`, `frontend`, `target_setup`, `feeds`, `config`, or `building`/`verifying` -> `cancel_requested` | Runner | API cancellation fields are set; exact labeled container is validated and stopped, or the pre-creation null-container proof succeeds |
| `cancel_requested -> cancelled` | Runner | Exact container is stopped, cancellation/quarantine result commits while identity remains, exact ID is removed and verified absent, runner cleanup CAS/event clears active identity, then terminal evidence commits; pre-creation null-container proof with `stagingAbsent: true` is the no-container exception |
| `starting -> interrupted` for service-start failure by direct proof | API | Unit start was attempted and is inactive; all `jobs.container_*` are null, the global label query is empty, no staging/log cleanup is needed, and no blocker, cleanup admission, or fence exists |
| `starting -> interrupted` for service-start failure after cleanup | API | A cleanup worker handed back completion; API rechecks exact absence/no-label state and clears the fence in the hand-back transaction |
| `starting`, `preflight`, `source`, `release_gates`, `frontend`, `target_setup`, `feeds`, `config`, `building`, `verifying`, or `cancel_requested` -> `interrupted` by direct proof | API | Unit is inactive, runner lease is stale, the Direct interruption proof holds, `queued` is excluded, and `publishing` uses dedicated recovery |
| `starting`, `preflight`, `source`, `release_gates`, `frontend`, `target_setup`, `feeds`, `config`, `building`, `verifying`, or `cancel_requested` -> `interrupted` after cleanup | API | Cleanup worker handed back completion; API rechecks exact ID absence, global no-label state, cleanup CAS completion, inactive unit, stale lease, and no remaining blocker, then clears the fence |
| recovery cleanup admission claim/renewal/completion | Cleanup worker | API atomically installed the matching fence/token/admission after proving inactive unit, stale runner lease, exact active recoverable state, and matching persisted identity/labels; for an already `interrupted` persisted ID it proves present or already-absent exact-ID protocol, and for a null staging/log blocker it proves null identity/no label |
| exact recovery container stop/remove, absence verification, log sealing, staging quarantine, and cleanup-worker CAS clear | Cleanup worker | A valid unexpired matching fence/token/admission exists; the worker acts only on the persisted ID, verifies global no-label state, retains the fence, cannot run stages or publish, and cannot change `jobs.state` |
| `interrupted` blocker -> `interrupted` after cleanup | API | For a persisted present or already-absent exact ID, the cleanup worker handed back stop/remove/absence evidence and cleanup CAS completion; API leaves terminal state unchanged and releases the queue blocker only after exact absence, global no-label state, and fence hand-back |
| `publishing -> succeeded` or `publishing -> failed` during verified recovery | API | Unit is inactive, lease is stale, no live container exists, and final-path evidence matches or rejects the recorded publish |
| normal stage failure, normal `publishing -> succeeded`, or normal terminal failure | Runner | Runner owns the active lease and commits stage/terminal evidence atomically |

The API may write only its request, queue, dispatch, cancellation-request,
cleanup-admission, lease-recovery, and enumerated verified-recovery terminal
columns. The runner
may write its lease, Docker runtime identity, current stage, normal stage,
artifact, publish, cancellation, and normal terminal columns. A compare-and-set
failure means the actor lost ownership; it must stop and emit no event. The API
only performs interruption for the explicit active-state set in the matrix
either by the Direct interruption proof or after cleanup-worker hand-back,
cannot transition a publishing job to `interrupted`, and does not perform
cleanup itself. The cleanup worker cannot transition any job state, including
`interrupted`, and cannot publish.

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `queued` | Accepted with a persisted SHA and waiting for FIFO dispatch. | `starting`, `cancelled` |
| `starting` | API claimed the queue row and started the user service. | `preflight`, `cancel_requested`, `interrupted` |
| `preflight` | Host, path, Docker, Git, and collision checks run. | `source`, `failed`, `cancel_requested`, `interrupted` |
| `source` | Detached worktree was created from the persisted SHA. | `release_gates`, `failed`, `cancel_requested`, `interrupted` |
| `release_gates` | OSI release verifiers passed. | `frontend`, `failed`, `cancel_requested` |
| `frontend` | React tests/build passed and GUI feed mirror verified. | `target_setup`, `failed`, `cancel_requested` |
| `target_setup` | Target environment selected in the job worktree. | `feeds`, `failed`, `cancel_requested` |
| `feeds` | Feeds updated and installed after environment cleanup. | `config`, `failed`, `cancel_requested` |
| `config` | Target config resolved and checked. | `building`, `failed`, `cancel_requested` |
| `building` | Supported Docker builder is compiling the image. | `verifying`, `failed`, `cancel_requested` |
| `verifying` | Artifact and rootfs checks are running. | `publishing`, `failed`, `cancel_requested` |
| `publishing` | Verified staging directory is being atomically published. | `succeeded`, `failed` |
| `cancel_requested` | Runner has observed cancellation and is either proving the pre-creation no-container condition or stopping the exact labeled container. | `cancelled`, `interrupted` |
| `succeeded` | Published artifact passed every required gate. | terminal |
| `failed` | A required stage failed with a diagnosis. | terminal |
| `cancelled` | Operator cancellation completed; `stagingAbsent: true` or staging is safely quarantined. | terminal |
| `interrupted` | API recorded recovery after a runner or workstation stopped before a terminal result; cleanup or the Direct interruption proof completed, and the job is never resumed. | terminal |

`newerSourceAvailable` is a result field, not a state. A job can be
`succeeded` with that field set to `true`.

The API displays only terminal jobs in history. `interrupted` jobs remain
visible with their last stage and recovery reason. Queued jobs remain queued
across API restarts and resume dispatch when the API starts at the user's
systemd login. Active jobs do not resume after a process or host reboot.

## 10. Pipeline and stage evidence

Every stage writes one evidence JSON file even when it fails. Each file has:

```json
{
  "schemaVersion": 1,
  "jobId": "20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V",
  "stage": "config",
  "startedAt": "2026-07-22T12:00:00.000Z",
  "finishedAt": "2026-07-22T12:00:01.000Z",
  "outcome": "passed",
  "operationId": "resolve-config",
  "commands": [
    { "argv": ["make", "-C", "openwrt", "defconfig"], "exitCode": 0 }
  ],
  "inputs": {},
  "observations": {},
  "error": null
}
```

A failure replaces `outcome` with `failed` and includes a stable error code,
short diagnosis, the trusted operation ID, captured command result, and the
operator recovery action. The captured argv is evidence emitted by trusted
TypeScript; it is not a manifest command or an input source.
Evidence is written before the job state changes to the next stage or a
terminal state.

### 10.1 Preflight

The API preflight endpoint and the runner preflight stage use the same typed
checks. The runner repeats them from the pinned job record immediately before
mutation. The checks are:

- at least 20 GiB free on the filesystem containing the job worktree and on
  the selected output root;
- the configured repository exists and is a Git worktree;
- `git`, `docker`, `node`, `npm`, `sqlite3`, and `systemctl`
  are executable;
- the `origin` remote is configured; branch resolution and `expectedSha`
  equality were already completed by API queue acceptance;
- a user systemd manager is available and the runner service is not already
  active for another job;
- the Docker builder service and the exact locked image digest are available;
- the approved output root is writable, canonical, non-symlinked, and on the
  same filesystem as its staging directory;
- the final branch/SHA/target destination is writable and its configured
  parent path can be opened safely, and the final destination does not exist;
  the job-specific OpenWrt output directory is checked later by the source
  stage after the detached worktree exists;
- the manifest validates and contains the selected target.

The stage records free bytes, Git version, Docker client/server version, Node,
npm, and sqlite3 versions, systemd availability, builder image ID and digest,
and the approved-root ID. A failed preflight prevents source or build
mutation. It does not inspect a target output path inside a worktree that has
not yet been created.

### 10.2 Source

The source stage verifies the persisted SHA and creates a detached worktree as
specified in section 6. It runs `git submodule update --init --recursive`,
then checks that `openwrt/bin/targets/<manifest.openwrtTarget>/` is absent in
that fresh worktree before any environment switch, feed operation, or other
mutation. A present directory fails with `BUILD_OUTPUT_COLLISION`. The stage
records `targetOutputAbsent: true` with the checked path as source evidence.
Only after this check may later stages mutate the worktree. The stage also
records the remote branch, remote URL, full SHA, commit timestamp, subject,
worktree path, OpenWrt submodule commit, and a clean/dirty status of the
detached worktree after checkout. The active checkout is not cleaned, reset,
or switched.

### 10.3 Release gates

From the detached worktree, the runner runs the release gates documented in
`docs/build/rpi5-full-osi-image.md`:

```text
node scripts/verify-profile-parity.js
node scripts/verify-chameleon-calibration.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
node scripts/verify-strega-gen1.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
```

The runner captures one command result per verifier. Any non-zero result fails
the stage and prevents the image build. Each verifier is a separate registered
operation ID and receives the full container create/inspect/CAS/start/attach/
outcome/clear/remove lifecycle.

### 10.4 Frontend

All repository commands after source creation run through registered operation
IDs in operation-specific locked builder containers. The runner dispatches
`frontend-install` only when `web/react-gui/node_modules` is absent or does not
match the lockfile. It then dispatches:

```text
["npm", "run", "test:unit"]  cwd=web/react-gui
["npm", "run", "typecheck"]   cwd=web/react-gui
["npm", "run", "build"]       cwd=web/react-gui
```

It dispatches `mirror-gui` to mirror `web/react-gui/build/.` into
`feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/` using a job-local
staging operation. The mirror check compares the recursive file list, file
sizes, and SHA-256 of every file. It also verifies that the feed copy contains
the built GUI title and the expected hashed asset payload. The runner never
uses an old feed GUI after a successful frontend build.

Frontend dependency absence is classified as `FRONTEND_DEPENDENCY_FAILURE`,
with the package manager output and the lockfile path in evidence.

### 10.5 Target setup

Inside the operation's locked builder container, the runner activates the target environment
only in the detached worktree. It invokes the repository's supported
`make switch-env ENV=<manifest value>` workflow and records the result. The
known behavior that this command cleans the OpenWrt build tree is safe here
because the worktree is job-owned.

Immediately after `switch-env`, the trusted `copy-feed-config` operation copies
the pinned worktree's repository-level `feeds.conf.default` to
`openwrt/feeds.conf.default`. It records and compares both SHA-256 values,
then verifies that the local ChirpStack feed entry resolves to the pinned
worktree's `feeds/chirpstack-openwrt-feed` directory. A missing local feed or a
hash mismatch fails the job.

If `quilt push -a` reports the known reverse-applicable rootfs patch, the
runner accepts that result only for the named rootfs-padding patch and only
when every other patch is applied and
`openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh` contains the
expected `ROOTFSPADDING` implementation. It records `patchDecision:
already-present`. A reverse-application report for any other patch, an
incomplete patch stack, or a missing padding implementation fails with
`PATCH_STATE_AMBIGUOUS`.

The runner then verifies the active target and profile before any build:

```text
CONFIG_TARGET_<platform>=y
CONFIG_TARGET_PROFILE="<manifest profile>"
CONFIG_TARGET_ROOTFS_PARTSIZE=14336
CONFIG_PACKAGE_node-red-node-sqlite=y
```

### 10.6 Feeds

Environment activation and feed configuration are followed by explicit feed
refresh and installation inside an operation's locked builder container:

```text
openwrt/scripts/feeds update -a
openwrt/scripts/feeds install -a
```

The runner verifies that `openwrt/package/feeds/` contains the installed
package links for Node-RED, ChirpStack, and `node-red-node-sqlite`, and that
the links point into the expected installed feed trees. It records the feed
revisions and installed package names. Missing installed feed links are a
hard failure. This prevents the observed failure where a tiny image was
generated with configuration symbols but without the Node-RED package.

### 10.7 Config

The runner runs `make -C openwrt defconfig` in the job worktree after feeds are
installed, inside an operation's locked builder container, then verifies the resolved
`openwrt/.config` values against every typed manifest symbol. It performs the
same source/config checks for both shipped profiles before building the
selected target. It records the selected target, profile, rootfs partition
size, Node-RED packages, and a SHA-256 of the resolved config.

The runner refuses a target mismatch even when OpenWrt exits successfully. It
also records the source config SHA before resolution and the resolved config
SHA after resolution so generated Kconfig changes are explainable.

### 10.8 Builder image and build

The builder is one immutable Docker image selected by a versioned lock file,
not a mutable tag. The lock records the image digest, Dockerfile SHA-256,
pinned Debian base-image digest, package versions, and the builder validation
result. The installer refuses to start the API when the digest is absent,
malformed, or differs from the image available to the service user.

The locked image is built from `Dockerfile-devel` with a digest-pinned Debian
base and must contain GCC 14, Node >=22, npm, OpenWrt build tools, `llvm-dev`,
the matching `libpolly-<LLVM-major>-dev`, and `libzstd-dev`. The Rust package
configuration must select `/usr/bin/llvm-config` for the host target and must
not request the expiring Rust CI LLVM artifact. The image validation build
must compile the Rust host and target standard libraries through that
LLVM/Polly/Zstd path and record the resulting `rustc`, LLVM, Polly, and Zstd
versions. The tested image is the only image accepted for target setup, feed
operations, defconfig, frontend commands, release gates, and compilation.

`builder.lock.json` contains these fields: `schemaVersion`, `packageVersion`,
`imageRepository`, `imageDigest`, `baseImage`, `baseImageDigest`,
`dockerfileSha256`, `packageSet`, `rustConfig`, `nodeVersion`,
`executionDefinitionSha256`, and `validationEvidenceSha256`.
`imageDigest`, `baseImageDigest`, and `executionDefinitionSha256` are each a
64-hex SHA-256 digest. The lock is generated only after the validation build
passes and is copied into the immutable versioned installation directory.
The tool-owned execution definition must resolve the image to
`imageRepository@imageDigest`; a mutable tag, an unpinned base image, or a
lock/image mismatch fails preflight. The definition is installed at the
immutable package path in section 19 and is not read from the branch's Compose
file or Dockerfile.

Every post-source operation that executes repository tools uses one common
direct-Docker protocol. Each trusted operation ID maps to exactly one fixed
argv factory from the manifest mapping above. At most one container may be
registered for a job at a time. Before each operation's container creation,
the runner proves in SQLite that `container_id IS NULL` and queries Docker for
no live container carrying the exact job label. It checks cancellation again
at this boundary; a requested cancellation proves the null identity and no
matching label, records `stagingAbsent: true` when staging does not yet exist,
or safely quarantines existing staging, then commits `cancelled` without
creating a container.

The runner creates a stopped container with exactly one job-worktree bind
mount, the host UID/GID supplied explicitly, and `CARGO_BUILD_JOBS=2`.
The installed execution definition names the operations that are read-only.
`verify-image` is read-only; operations that prepare or build the worktree are
writable:

```text
docker create --name <validated-container-name>
  --label org.osi.image-builder.job-id=<job-id>
  --label org.osi.image-builder.manifest-sha=<manifest-sha>
  --user <uid>:<gid> --workdir /workdir
  --mount type=bind,src=<job-worktree>,dst=/workdir,<rw-or-readonly-by-operation>
  --env HOME=/workdir/.builder-home --env PATH=<image-path>
  --env CARGO_BUILD_JOBS=2 --env TZ=UTC
  --env SOURCE_DATE_EPOCH=<persisted-commit-time>
  --network=bridge --cap-drop=ALL --security-opt=no-new-privileges
  --pids-limit=4096 --ulimit nofile=1024:4096
  <imageRepository>@<imageDigest> <trusted-operation-argv>
```

For `verify-image`, the runner uses `--network=none`, a read-only worktree
bind, and `--read-only` for the container root filesystem. For a mutating
operation, it omits `--read-only` and keeps the worktree bind writable. The
runner derives both modes only from the hashed installed execution definition;
branch content cannot request or relax them.

For each operation, the runner immediately inspects the created object and validates the exact
container ID and name, image ID and immutable digest, both labels, one and
only one bind mount with the expected source/destination/access, the exact
allowlisted environment, requested user IDs, `Privileged=false`, no added
capabilities, `CapDrop=ALL`, no devices, and the expected network, rootfs, and
security settings. It persists the ID, name, image digest, labels, mount, environment,
user IDs, operation ID, and security inspection evidence through a runner-
identity CAS transaction before invoking `docker start --attach <container-id>`.

The runner captures attached stdout/stderr and is the sole live-container log
indexer. After the operation exits, the runner durably commits the operation
exit code, evidence, and stage outcome in SQLite while retaining all active
`jobs.container_*` identity columns. It then runs
`docker rm <exact-persisted-stopped-id>`, verifies that exact ID no longer
exists, and only then performs the runner-owned CAS cleanup transaction that
records cleanup success, emits the cleanup event, and clears only active
`jobs.container_*`. The immutable `job_operations` row retains container
identity and inspection evidence. Cleanup failure or a crash before the CAS
cleanup transaction retains the identity as a recovery handle and blocker;
progression to the next operation is forbidden. This removal is required
after every operation and does not wait for a terminal job outcome. API
recovery reads the persisted identity and Docker inspection but never creates,
starts, stops, removes, or clears container identity for a live runner.

The implementation must pass command arguments from trusted TypeScript
operation code without interpolating branch, target, or output-root input into
shell text. The target is selected by the resolved configuration, not by an
untrusted command argument. The direct invocation has no Docker socket,
`--privileged`, `--device`, added capability, or mount other than the one
worktree bind. Its only permitted environment is
`HOME=/workdir/.builder-home`, the installed image `PATH`,
`CARGO_BUILD_JOBS=2`, `TZ=UTC`, and the persisted `SOURCE_DATE_EPOCH`; host
environment variables are not inherited. The exact container name matches
`^osi-image-builder-[a-z0-9-]{8,64}$`, and the exact job and manifest labels
are checked after creation and before any build output is trusted. The API
never records or writes live container identity; the runner is the sole owner
of those CAS columns.

The runner records image ID, digest, creation time, and the output of
`gcc --version`, `rustc --version`, `llvm-config --version`,
`node --version`, `npm --version`, `make --version`, and the Rust LLVM
configuration from inside the container. An expired Rust CI artifact is an
actionable `RUST_BOOTSTRAP_UNAVAILABLE` failure, never a silent compiler
fallback.

The runner streams stdout and stderr to `logs/docker.log`, emits stage progress
events, and keeps the complete exit code and duration. Low CPU during package
indexing or image assembly is not a failure; the runner reports process
activity and the last log timestamp so an operator can distinguish idle work
from a stopped process.

### 10.9 Verification

Verification begins only after a successful build command. The source stage
evidence is the authoritative record that the fresh detached worktree's
target output directory was absent before mutation. Verification resolves
exactly one artifact matching the target's glob and requires all of the
following:

1. Source evidence has `targetOutputAbsent: true` for the exact target output
   path, and that directory contains exactly one factory image after build. A
   pre-existing image is never accepted. The factory image mtime is later than
   `buildStartedAt` as supporting evidence, not as the freshness authority.
2. The artifact size is at least the target manifest's
   `minimumArtifactBytes` floor. The current floor is 64 MiB; the observed
   18 MiB feed-less image therefore fails before publication.
3. The original OpenWrt `sha256sums` file is treated as verification evidence
   only. `sha256sum -c sha256sums` passes for the target output directory, but
   that file is never published.
4. `gzip -t` passes for the factory image.
5. The resolved target, profile, and `CONFIG_TARGET_ROOTFS_PARTSIZE=14336`
   match the manifest.
6. Both profile source checks pass, and the selected target rootfs directory
   contains:
   `/etc/uci-defaults/98_osi_node_red_seed`,
   `/usr/share/flows.json`,
   `/usr/share/db/farming.db`,
   `/etc/init.d/node-red`,
   `/usr/lib/node-red/gui/index.html`,
   `/usr/share/node-red/node_modules/@grpc/grpc-js/package.json`,
   `/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json`,
   `/usr/share/node-red/node_modules/google-protobuf/package.json`,
   `/usr/share/node-red/node_modules/protobufjs/package.json`,
   and the package manifests for the local OSI helper modules used by the
   shipped flows, including `osi-lib`, `osi-db-helper`, and
   `osi-chirpstack-helper`.
7. The rootfs includes nginx locations for `/gui/`, `/auth/`, `/api/`, and
   `/download/`.
8. The GUI title and recursive SHA-256 payload match the feed mirror produced
   by the frontend stage.
9. The SHA-256 of the critical source `flows.json`, seed database, and GUI
   payload recorded before packaging matches the corresponding rootfs payload
   or the documented first-boot seed source. The evidence records both hashes
   and the comparison rule.
10. A host Node >=22 `node:sqlite` check opens the rootfs database and
   `PRAGMA integrity_check` returns `ok`; the Chameleon calibration table can
   be queried. A row count of zero is allowed because runtime calibration
   lookup can populate the table.
11. A Node resolution check from the rootfs Node-RED directory resolves
   `protobufjs` and every required local helper. This check runs with the
   builder's Node runtime and does not execute target binaries.
   The trusted CommonJS probe accepts synchronous package initialization only.
   It launches one permission-constrained child for each fixed package, warms
   the approved real builtins before observation (including `dns`, whose first
   load creates a trusted `DNSCHANNEL` resource), and enables a private
   `async_hooks` observer only around the package `require`. Any package-created
   scheduled or still-pending asynchronous resource, including a `PROMISE`,
   `Immediate`, `Timeout`, `TickObject`, DNS, or network resource, fails the
   check; the probe does not use a finite event-loop drain. The child seals the
   CommonJS loader, extension surface, loader arrays, and captured intrinsic
   calls for its lifetime, and the parent enforces the fixed timeout and
   `SIGKILL` boundary.
12. The runner requests a final freshness result from the API source resolver
   over the local service socket. A successful equal-SHA result records
   `freshnessStatus: "fresh"`; a different SHA records
   `freshnessStatus: "advanced"`, `newerSourceAvailable: true`, and both SHAs.
   A failed or unavailable check records `freshnessStatus: "unknown"` with
   error evidence and does not fail an otherwise verified pinned build.
The evidence records artifact path, size, mtime, SHA-256, gzip result, target
values, every required path, nginx route result, source/rootfs hash comparison,
GUI mirror hash, Node resolution result, and database result. Any missing
file, route, dependency, cardinality check, or integrity result fails the job.

### 10.10 Publish

The runner constructs `build-manifest.json` with source identity, target,
timestamps, output root, manifest hash, resolved config hash, tool versions,
builder image identity, artifact size, and artifact SHA-256. It writes
`verification.json` with all stage outcomes and evidence paths.

Only a fully verified staging directory enters publication. The runner creates
a new published `sha256sums` containing the factory image basename only, then
verifies that checksum before publish. It fsyncs the image, this generated
checksum, the manifest, and the verification file. A held directory FD and
the tested `renameat2(RENAME_NOREPLACE)` helper publish the complete directory
without a check-then-replace race.

The runner passes the staging source path
`<approved-root>/.osi-image-builder/staging/<job-id>`, the branch and full-SHA
parent components, and the absent target basename to `osi-image-publish`. The
helper creates or opens only the branch and SHA parents, holds the approved-
root and parent directory FDs, walks every component with `openat`/
`O_NOFOLLOW`, fsyncs files and directories, and performs the single
`renameat2(RENAME_NOREPLACE)` operation with the target basename as `newName`.
It accepts no arbitrary path or overwrite mode. The helper returns the
installed version, source hash, source and destination relative paths, and the
kernel result as structured evidence.

Before the rename, the runner commits `publish_started` and its source/staging
paths in SQLite. After a successful rename, it reopens the published image and
reverifies the generated checksum, size, manifest, and verification hashes;
then it commits `succeeded` and the terminal event in one transaction. If the
process dies between the rename and that commit, API recovery treats a
complete matching destination as a recoverable publish completion and commits
the success record; after a successful rename no staging path is claimed or
moved. If recovery finds the final destination absent while staging survives,
it commits `PUBLISH_RECOVERY_FAILED`; staging is quarantined only after the
helper proves an atomic no-overwrite move. If the final destination exists but
mismatches the manifest or checksum, it commits
`UNVERIFIED_FINAL_PATH_BLOCKER`; the helper never deletes, replaces, or claims
that final path quarantined. An `EEXIST` from `RENAME_NOREPLACE` is always
`OUTPUT_COLLISION`; no existing directory is replaced. A failed quarantine
move records `QUARANTINE_PENDING`, leaves the source path explicit, and keeps
the blocker until an operator resolves it.

## 11. Queue, cancellation, and restart behavior

The API inserts a job, its persisted source SHA, and a monotonically increasing
`queue_position` in one SQLite transaction. The dispatcher claims only the
oldest `queued` row with a compare-and-set transaction, changes it to
`starting`, writes the runner unit name, and then starts
`osi-image-builder-runner@<job-id>.service`. If service start fails after the
claim, the API first attempts the Direct interruption proof with
`SERVICE_START_FAILED`. If any container identity, matching label,
staging/log cleanup, blocker, cleanup admission, or cleanup fence exists, the
job remains `starting` with a recovery blocker until cleanup-worker hand-back;
only then does the API commit `starting -> interrupted`. It never silently
returns the claimed row to the queue, and it does not dispatch another job
until the exact no-container and recovery-blocker check is clear.

The runner unit is independent of the API unit. The API unit must not declare
`PartOf=osi-image-builder-runner@*`, stop runner units on restart, or own their
process group. Closing the browser and restarting the API leave a live runner
and its Docker container untouched.

For every trusted operation, the runner persists the validated Docker
container name, container ID, and labels in SQLite before start. The exact
container has both labels:

```text
org.osi.image-builder.job-id=<job-id>
org.osi.image-builder.manifest-sha=<manifest-sha>
```

The API cancellation endpoint sets `cancel_requested_at` and
`cancel_reason` in a transaction, inserts a cancellation-request event, and
when the row is still `queued`, changes it to `cancelled` in that same API
transaction without starting a service. For each active non-publishing state
`starting`, `preflight`, `source`, `release_gates`, `frontend`,
`target_setup`, `feeds`, `config`, `building`, `verifying`, or
`cancel_requested`, it signals the runner service with its dedicated
cancellation signal. When the row is already `cancel_requested`, this signal
asks the runner to finish its existing controlled cleanup. Before any
container creation, the runner proves `container_id IS NULL` in SQLite and
queries Docker for no matching labeled container, asks the native publisher
to quarantine staging if present, and commits `cancelled` only after that
proof. During a container operation, the runner revalidates the stored
container ID, name, job label, and manifest label, transitions to
`cancel_requested`, and stops only that exact container. It waits up to 30
seconds for the container and child process group to exit, asks the native
publisher for an atomic no-overwrite move of staging to the single quarantine
location, and commits the controlled cancellation result and quarantine
evidence while retaining active `jobs.container_*`. It then runs `docker rm`
on the exact persisted stopped ID, verifies that exact ID no longer exists,
and only then commits the runner CAS cleanup event that clears active
`jobs.container_*`. The terminal `cancelled` event follows that cleanup
transaction. If the move or cleanup cannot be proven safe, it records
`QUARANTINE_PENDING` or the cleanup blocker, leaves the source and identity
explicit, and does not claim `cancelled`.

`publishing` has no cancellation transition. A
cancellation request received after `publish_started` is recorded as a late
request, does not stop or remove a publisher operation, and lets the runner
complete the atomic publish result.

If the runner does not commit cancellation within 30 seconds, the API sends
`systemctl --user stop` to the runner unit. The unit has a further 15-second
grace period, after which systemd kills its control group. A runner killed
before its terminal commit does not immediately produce `interrupted`: the job
remains in its last active state with a recovery blocker. The API never claims
`cancelled` after forced termination. Publishing is never rolled back. API
recovery later commits `interrupted` only after cleanup-worker hand-back, or
after a fresh Direct interruption proof.

If the service is forcibly killed before the runner commits a terminal result,
the job remains in its last active state with the last stage, systemd result,
and recovery blocker recorded. A forced kill never becomes `cancelled` merely
because the Docker container stopped. The API leaves all files and any
persisted identity in place and requires either cleanup-worker hand-back or
the Direct interruption proof before committing `interrupted`; queue dispatch
cannot continue before that proof.

On API startup, recovery uses SQLite as the source of truth and never races a
live runner:

1. Apply pending schema migrations in a transaction before opening the queue.
2. Reconcile every `cleanup_leases` row before reconciling active job states.
   For `admitted` rows whose cleanup unit has not started, validate the
   durable mode-0600 credential file and the persisted exact unit name
   `osi-image-builder-cleanup@<admission-id>.service`. If both are valid and
   the Admission ID matches its grammar, idempotently start that exact unit;
   `%i` is the sole dynamic `ExecStart` argument and the worker resolves the
   job ID from the matching admission row.
   If either is missing, corrupt, unsafe, or its hash, generation, admission,
   or unit name does not match, CAS-expire the admission and rotate
   generation/token by creating and fsyncing a replacement credential before
   committing the new reference. For `claimed` rows with an active cleanup
   unit and unexpired cleanup lease, validate the exact persisted unit name
   and defer without writing beside the worker. For `claimed` rows with an
   inactive unit and an unexpired lease, unit inactivity wins: record the
   unexpected exit, CAS-expire and rotate generation/token, then restart the
   exact replacement unit. For `claimed` rows with an inactive unit and stale
   lease, CAS-expire and rotate generation/token, then restart the exact
   replacement unit. For `claimed` rows with an active unit and stale lease,
   issue a bounded `systemctl --user stop` for that exact unit, confirm it is
   inactive, and only then CAS-expire and rotate; never start a replacement
   while the old unit is active. A stop failure retains the fence and blocker.
   For `completed` rows not
   marked `handed_back`, independently validate cleanup evidence, exact ID
   absence, global no-label state, and blocker resolution, then perform API
   hand-back without starting another worker. For `failed` or `blocking` rows,
   retain the cleanup fence and expose the explicit retry action; retry after
   operator correction rotates generation/token and starts a new admission.
   An orphan credential file with no matching SQLite admission is safely
   pruned from the fixed job directory and its parent is fsynced.
3. Re-read active rows in the explicit recovery set
   `starting`, `preflight`, `source`, `release_gates`, `frontend`,
   `target_setup`, `feeds`, `config`, `building`, `verifying`, and
   `cancel_requested`, together with each runner lease. `queued` is excluded
   because it has no active runner. Query the recorded user service and exact
   labeled Docker container for each active row. A unit that is active or a
   lease that is not stale is live for recovery purposes; recovery defers that
   row and never writes beside it. `publishing` is handled separately in step
   4. Any non-null `jobs.container_*` identity is also a cleanup blocker, even
   if Docker already reports that the ID is absent; the cleanup worker must
   verify the exact ID absent, verify the global label query is empty, and
   commit its cleanup-worker CAS event before API terminal recovery. A cleanup
   admission or expired cleanup lease also blocks queue dispatch. If all
   `jobs.container_*` are null, no label matches, no staging/log cleanup is
   needed, and no blocker, admission, or fence exists, the Direct interruption
proof is available instead.
4. Reconcile stale `publishing` rows before the explicit active-state
   interruption set. Only when the
   unit is inactive, the lease is expired, and no matching labeled container
   exists may the API inspect the recorded destination with the held path-walk
   rules. Before any recovery terminal event, API publishing recovery seals
   the orphan log tail as described below. A complete destination
   whose manifest and generated checksum match the SQLite publish record
   commits `publishing -> succeeded`; after a successful rename no staging
   path is claimed or moved. If the final destination is absent while staging
   survives, recovery commits `PUBLISH_RECOVERY_FAILED` and asks the helper to
   quarantine staging. If the final destination exists but mismatches, recovery
   commits `UNVERIFIED_FINAL_PATH_BLOCKER` and does not touch or quarantine that
   final path. An absent destination with no staging also commits
   `PUBLISH_RECOVERY_FAILED`.
5. For exactly these active states: `starting`, `preflight`, `source`,
   `release_gates`, `frontend`, `target_setup`, `feeds`, `config`, `building`,
   `verifying`, and `cancel_requested`, recovery first attempts the Direct
   interruption proof. If it passes, the API commits the state to
   `interrupted` without a cleanup worker, admission, or fence. If any
   identity, matching label, staging/log cleanup, blocker, admission, or
   fence exists, recovery must acquire the cleanup-worker admission described
   in section 12. For a persisted exact ID, the worker stops/removes/verifies
   it when present, or verifies that exact ID absent plus global no-label state
   when already absent, then cleanup CAS clears the identity while retaining
   the fence. Only after hand-back may the API commit the verified recovery
   transition to `interrupted` and clear the fence. `queued` is excluded.
   `publishing` uses only the dedicated recovery in step 4. A claimed job
   whose unit failed to start receives `SERVICE_START_FAILED`; an exited
   runner without a terminal result receives `RUNNER_DISAPPEARED`. Evidence
   and logs remain in place.
6. Before any next dispatch, including after a service-start failure, query
   Docker for every container carrying `org.osi.image-builder.job-id` and
   verify its job and manifest labels. Any live labeled container, unresolved
   recovery action, `QUARANTINE_PENDING`, or
   `UNVERIFIED_FINAL_PATH_BLOCKER`, or a persisted container identity awaiting
   cleanup blocks the entire queue. A container with a
   live matching runner is expected but still prevents a second dispatch.
7. An operator-confirmed recovery action is admitted by the API only after
   the runner unit is inactive, the runner lease is stale, and the job is in
   the exact active set `starting`, `preflight`, `source`, `release_gates`,
   `frontend`, `target_setup`, `feeds`, `config`, `building`, `verifying`, or
   `cancel_requested`, or is already `interrupted` with a cleanup blocker.
   The cleanup worker then follows the present/absent exact-ID protocol, waits
   for and verifies disappearance or absence, seals logs, and asks the native
   publisher to move staging atomically to the sole quarantine location. If
   that move cannot be proven safe, it records `QUARANTINE_PENDING` and keeps
   dispatch blocked. The worker cannot change the job state; the API commits
   stale active jobs to `interrupted` only after hand-back, while already
   `interrupted` jobs remain interrupted.
8. Read structured events from `job_events` and replay logs from their durable
   offsets. No JSON snapshot, systemd output, or log line can change job state.
9. Dispatch the oldest remaining queued row only after all blockers are clear.

The API restart recovery is idempotent because state and event sequence live
in SQLite. Host reboot or user-manager shutdown leaves an active job in its
last active state with a recovery blocker until the API proves the Direct
interruption proof or receives cleanup-worker hand-back; it does not pretend
that an interrupted terminal state already exists. The runner is never
resumed from a partial worktree or Docker state.
Queued jobs remain queued and resume when the API starts at the user's systemd
login. Browser closure has no effect on either class of job.

## 12. API

All API responses are JSON unless an endpoint explicitly says SSE. The API
binds to `127.0.0.1` and serves the built UI from the same origin.

The API source resolver is the only component allowed to use SSH or fetch
`origin`. The configured remote must be an SSH URL such as
`ssh://git.example/repository` or `builder@git.example:repository`; an HTTPS
or local-path origin fails configuration. The runner has no SSH credentials
and never invokes `git fetch`. For the final
freshness check, the runner inserts a freshness request in SQLite and signals
the API over a mode-0600 Unix socket at `<state-root>/api.sock`. The API
resolver fetches and resolves the branch, then commits a result containing
`status` (`fresh`, `advanced`, or `unknown`), observed SHA, checked-at time,
and error evidence. The runner reads that result from SQLite. Socket failure,
SSH failure, or an unresolvable ref produces `unknown`, which is informational
and cannot downgrade an otherwise verified pinned build.

### 12.1 Read endpoints

| Method and path | Response |
| --- | --- |
| `GET /api/health` | `{ "status": "ok", "version": string, "activeJobId": string \| null }` |
| `GET /api/config` | `{ "repository": { "path": string, "remote": "origin" }, "approvedOutputRoots": [{ "id": string, "label": string, "path": string }], "targets": [TargetConfig] }` |
| `GET /api/branches` | `{ "fetchedAt": string, "branches": [{ "name": string, "sha": string, "commitTime": string, "subject": string }] }` |
| `GET /api/jobs?limit=50&cursor=opaque-cursor` | `{ "jobs": [JobSummary], "nextCursor": string \| null }` |
| `GET /api/jobs/:id` | `JobDetail`, including state, source, stage, output, errors, cancellation, runtime, and evidence index |
| `GET /api/jobs/:id/evidence/:stage` | The immutable stage evidence JSON |
| `GET /api/jobs/:id/events?after=123` | `{ "events": [Event], "next": number }` for non-streaming recovery |
| `GET /api/jobs/:id/events/stream?after=123` | SSE stream of job events and periodic keepalives |

`GET /api/branches` performs a fetch only when explicitly requested by the UI
refresh action or when its cache is older than five minutes. It never pins or
creates a job. A failed fetch returns `503` with `GIT_FETCH_FAILED` and the
last successful branch snapshot remains visible as stale data.

### 12.2 Mutating endpoints

Every mutating request must contain an `Origin` header equal to the API origin
and a JSON content type. The API rejects missing or foreign origins with `403`.

`POST /api/preflight` accepts:

```json
{
  "branch": "design-sync/agrolink",
  "expectedSha": "677eb1377f71e3ffd05f1278888ca5b1d8ccc96b",
  "targetId": "rpi-5",
  "outputRootId": "sdcard-images"
}
```

It fetches `origin`, resolves the remote branch, compares the result with
`expectedSha`, and runs non-mutating host, builder, target, disk, and output
collision checks. It returns `200` with a `preflightId`, `observedSha`,
`expiresAt`, and typed check results. `expiresAt` is exactly 10 minutes after
creation. A remote mismatch returns `409` with `BRANCH_MOVED`; an invalid
target/root or failed check returns a structured `400` or `503` response.
The UI must refresh an expired result before submission.

`POST /api/jobs` accepts:

```json
{
  "branch": "design-sync/agrolink",
  "expectedSha": "677eb1377f71e3ffd05f1278888ca5b1d8ccc96b",
  "targetId": "rpi-5",
  "outputRootId": "sdcard-images",
  "preflightId": "pf_20260722T120000Z_01J4D5YQG7M9R2C6N8P0S1T3V"
}
```

`preflightId` is optional for trusted automation but the UI supplies it. The
API always repeats fetch, SHA comparison, collision, and safety checks at queue
acceptance. The API persists `branch`, `expectedSha`, and the resolved full
SHA before returning success. A mismatch returns `409 BRANCH_MOVED` and does
not create a queue row.

The response is `202 Accepted`:

```json
{
  "job": {
    "id": "20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V",
    "state": "queued",
    "queuePosition": 2,
    "branch": "design-sync/agrolink",
    "targetId": "rpi-5",
    "outputRootId": "sdcard-images"
  }
}
```

The API validates branch, expected SHA, target, approved-root ID, queue
capacity, preflight expiry, and the final-path collision before insertion.
Source selection ends at queue acceptance; the runner builds only the SHA in
the inserted row.

`POST /api/jobs/:id/cancel` accepts `{}` and returns the updated `JobDetail`.
It is valid for queued or active jobs, returns `409` for terminal jobs, and
records the operator request time. It never deletes the job directory or
output.

`POST /api/jobs/:id/recover` accepts `{}` for either (a) a stale job in the
explicit active set `starting`, `preflight`, `source`, `release_gates`,
`frontend`, `target_setup`, `feeds`, `config`, `building`, `verifying`, or
`cancel_requested`, or (b) an `interrupted` job with a persisted container,
quarantine, or log blocker. `queued` is excluded and `publishing` uses the
dedicated publish recovery. For an active job, the API first attempts the
Direct interruption proof; only its success permits direct API interruption.
Before choosing that path, the endpoint reconciles any existing cleanup
admission using the same rules as startup: an admitted valid credential is
started idempotently, an admitted invalid credential is CAS-expired and
rotated, a claimed active unit with an unexpired lease is deferred, a claimed
inactive unit with an unexpired lease records unexpected exit and is
CAS-expired/rotated, a claimed inactive stale lease is rotated and restarted,
and a claimed active unit with a stale lease is stopped with bounded
`systemctl --user stop`, confirmed inactive, then rotated/restarted. A stop
failure retains the fence/blocker. A completed admission is independently
verified and handed back without a new worker, and a failed/blocking admission
remains fenced until explicit corrected retry.
Otherwise the API proves the runner unit is inactive, the runner lease is
stale, and the exact persisted ID/name/labels match the Docker object, or
proves the exact ID already absent with global no-label state. For a
staging/log-only blocker it proves null container columns and no matching
label. It then atomically installs the cleanup fence, token, and stale runner
snapshot in one cleanup admission transaction. A runner-start or renewal
that loses this CAS cannot write after admission.

For an `interrupted` job with a persisted exact ID, the cleanup worker follows
one protocol: when the exact ID is present, it validates labels, stops it,
removes it, and verifies absence; when the exact ID is already absent, it
verifies that exact ID absent and the global Docker label query has no matching
container. Only then does cleanup-worker CAS clear the persisted identity.
An already `interrupted` staging/log-only blocker may instead prove null
container columns and no matching label; that path performs no Docker action.
The API then starts `osi-image-builder-cleanup@<admission-id>.service`; it never
starts a build runner for recovery.

The cleanup worker rechecks the admission proof and exact persisted unit name
and claims only the matching fence/token/admission for that unit. An old or
delayed unit for a rotated admission fails this CAS even if it presents an old
credential. It owns the cleanup protocol: it stops the exact
persisted container when present, waits for it, runs `docker rm` on that exact
stopped ID, verifies the ID is absent and the global label query is empty,
seals orphan logs, asks the native publisher for an atomic no-overwrite move
of staging into the single quarantine directory, records cleanup evidence,
and commits the cleanup-worker CAS that clears active `jobs.container_*` while
retaining the fence. It cannot run stages, publish, or change `jobs.state`.
The immutable `job_operations` row is unchanged. If quarantine cannot be
proven safe, it records `QUARANTINE_PENDING` and keeps the blocker; a cleanup
worker crash before removal or after removal but before its CAS leaves the
persisted identity and cleanup fence/recovery blocker in SQLite.

After the worker hands back completion, the API independently verifies exact
container absence, global no-label state, cleanup-CAS completion, and no
remaining blocker. For a stale active job, it then commits the explicit active
state to `interrupted` and clears the fence/token/admission in one hand-back
transaction. For an already `interrupted` job, it leaves the terminal state
unchanged but clears the fence only in that same hand-back transaction. Only
after exact absence, cleanup-worker CAS, and fence hand-back are durable does
the API record `containerCleanupAt` and release the queue blocker. The
endpoint never resumes a build or makes a worker claim terminal success.

When the Direct interruption proof succeeds, the endpoint commits the API
recovery event without creating a cleanup admission or fence and returns
`200 OK` with the updated `JobDetail`. While cleanup is running, the endpoint
returns `202 Accepted` with
`{ "job": JobDetail, "recovery": "cleanup_pending", "cleanupLeaseId":
string }`. A failed admission proof returns `409 RECOVERY_NOT_ELIGIBLE`; an
unexpired cleanup lease returns `409 CLEANUP_IN_PROGRESS`. Completion is
observable through the normal SSE stream and `JobDetail`; the API commits the
active-state `interrupted` event only after the worker completion proof.

For a `failed` or `blocking` cleanup admission, the operator must correct the
recorded blocker and call the same endpoint with `{ "retry": true }`. The API
does not retry automatically: it CAS-expires the old admission, creates and
fsyncs a new credential, rotates generation/token, updates the SQLite
reference and exact admission unit name, and starts the new worker. A retry
response is `202 Accepted` with
the new admission ID; an uncorrected blocker returns
`409 CLEANUP_RETRY_BLOCKED`.

`POST /api/jobs/:id/publish-blocker/recheck` accepts `{}` only for a job with
`UNVERIFIED_FINAL_PATH_BLOCKER`. It is non-destructive: it independently
reopens the approved root and final path with held no-follow descriptors,
without removing, replacing, or republishing anything. The blocker clears
only when the destination is independently absent and no staging path remains,
or when an existing destination now matches the recorded manifest, generated
factory-image checksum, artifact size, and verification evidence and no
staging path remains. The API
records the recheck evidence and clears the blocker flag, but never rewrites a
terminal failed job to `succeeded`; an operator submits a new job when the
destination was removed. A mismatch, symlink, path error, or incomplete
evidence leaves the blocker and queue dispatch blocked.

`POST /api/branches/refresh` accepts `{}` and returns the same shape as
`GET /api/branches`. It is a read operation with explicit operator intent and
does not create a job.

### 12.3 Response and error shapes

`JobDetail` has this stable shape:

```json
{
  "id": "20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V",
  "state": "building",
  "stage": "build",
  "branch": "design-sync/agrolink",
  "pinnedSha": "677eb1377f71e3ffd05f1278888ca5b1d8ccc96b",
  "targetId": "rpi-5",
  "outputRootId": "sdcard-images",
  "queuePosition": null,
  "cancelRequestedAt": null,
  "artifact": null,
  "freshnessStatus": "unknown",
  "freshnessCheckedAt": null,
  "newerSourceAvailable": false,
  "error": null,
  "evidence": [{ "stage": "build", "outcome": "running", "path": "evidence/07-build.json" }]
}
```

Every non-success response has the same structure:

```json
{
  "error": {
    "code": "BRANCH_MOVED",
    "message": "The remote branch changed after the displayed SHA.",
    "stage": "source",
    "details": { "expectedSha": "sha256-hex-string", "observedSha": "sha256-hex-string" },
    "retryable": true,
    "requestId": "req_20260722T120000Z_000042"
  }
}
```

The UI branches on `code`, not message text. The API never returns stack
traces, environment variables, secrets, or arbitrary filesystem paths.

### 12.4 SSE event format

The stream emits:

```text
id: 42
event: stage
data: {"jobId":"20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V","state":"building","stage":"build","at":"2026-07-22T12:00:02.000Z","message":"Docker build active"}

id: 43
event: log
data: {"jobId":"20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V","stream":"docker","at":"2026-07-22T12:00:03.000Z","line":"make -C openwrt -j4"}

id: 44
event: terminal
data: {"jobId":"20260722T120000Z-01J4D5YQG7M9R2C6N8P0S1T3V","state":"succeeded","at":"2026-07-22T12:04:00.000Z","newerSourceAvailable":false}
```

The client sends the last received ID as `after` on reconnect; the value is a
durable per-job `job_events.seq` cursor, not a process-local counter. A log
event row records the source file (`runner` or `docker`), file generation,
byte offset, byte length, UTF-8 partial-line flag, and the stable sequence.
The log file is canonical content; SQLite metadata makes a replay select exact
bytes deterministically. The runner appends and fsyncs bytes before inserting
the corresponding event row in the same durable protocol. It never stores a
large log body in SQLite.

The API replays every event with `seq > after` in sequence order, reading each
log chunk from its recorded generation and byte range, then subscribes to new
rows without a gap. A missing or shorter file, generation mismatch, or failed
read produces a durable `log-gap` event with the affected range and
`RECOVERY_LOG_GAP`; it never invents text or advances the cursor over an
unreadable range. Log rotation creates a new generation row before writing to
the new file. Retention cannot remove a generation while its event rows are
replayable; after event retention, the API reports the documented gap.

Bytes without a trailing newline are valid chunks with `partial: true`. While
the runner unit and lease are live, the runner is the sole log indexer. API
publishing recovery may seal a publishing orphan tail; the cleanup worker may
seal a non-publishing recovery tail only after the API has proved the unit is
inactive, the lease is stale, and no matching labeled container exists (or
the exact persisted identity is already absent). It compares each file size
with the last committed end,
reads any larger tail exactly, fsyncs the file, and inserts one
`log_orphan_tail` event with the actual offset, byte length, stream, and
generation describing the exact file range before handing back cleanup
completion; the file remains canonical and the tail bytes are not copied into
SQLite. A shorter file inserts a `RECOVERY_LOG_GAP` event before cleanup
completion. The tail metadata event and recovery event are committed in order
by SQLite transactions, so a cleanup crash cannot hand back completion before
its log evidence. The API then commits the active-state recovery event, if
applicable. No API process indexes a live runner's log.

This makes a crash during a partial final line recoverable without rewriting
the canonical log. The API caps one SSE payload at 64 KiB and emits a
`log-truncated` metadata event while preserving the complete file bytes.
A keepalive comment is sent every 15 seconds.

## 13. UX

The UI is an operational console with a compact two-column desktop layout and
a single-column mobile layout. It uses existing project typography and
neutral status colors. It does not use a marketing hero, nested cards, or
explanatory feature copy.

### 13.1 New build screen

The first screen contains:

- remote branch select with commit SHA, commit time, and subject;
- target segmented control with Pi 5 and Pi 4 / 400 / 3 / 2;
- approved output-root select showing the canonical path;
- an `expectedSha` field taken from the selected remote branch;
- a `Run preflight` action that shows the observed SHA, check results, and
  10-minute expiry;
- a pinned-source summary that appears after API queue acceptance;
- a deterministic destination preview;
- preflight indicators for disk, Docker, systemd, Git remote, and path
  collision;
- a `Start build` button with a build icon, disabled until request validation
  passes;
- a compact warning when the branch snapshot is stale.

The form never accepts a free-text path. The destination preview is read-only.
Changing branch, target, or output root updates the preview and clears any old
preflight result. `Start build` remains disabled until the preflight is valid
and the API accepts the same branch/expected-SHA pair.

### 13.2 Queue and history

The queue view shows one active row, waiting rows in FIFO order, and terminal
history. Each row displays branch, abbreviated SHA, target, state, current
stage, elapsed time, and output path when published. The active row exposes a
cancel icon with a tooltip and confirmation dialog. Queued rows can be
cancelled without starting a service.

History filters by state, target, branch, and date. A succeeded row shows the
artifact hash and a link to the local release directory. A row with a newer
source shows the newer SHA and a `Build newer commit` action that submits a new
job. No history action removes files.

### 13.3 Job detail

Job detail has tabs for `Activity`, `Verification`, and `Files`:

- `Activity` shows stage transitions, live logs, command exit status, and the
  reconnect state;
- `Verification` shows each gate as passed or failed with evidence timestamps,
  artifact size/hash, target/profile, required file checks, route checks, GUI
  hash, and database integrity result;
- `Files` shows only known job log, evidence, quarantine, and published paths.
- A stale job in `starting`, `preflight`, `source`, `release_gates`,
  `frontend`, `target_setup`, `feeds`, `config`, `building`, `verifying`, or
  `cancel_requested`, or an interrupted job with an orphaned labeled
  container, shows a `Recover container` control. It
  requires confirmation, starts only the admitted cleanup worker, never
  resumes the build, and leaves an already interrupted job interrupted; a
  stale active job becomes interrupted only after cleanup completion.

When the browser closes, reopening the detail page uses the event sequence to
replay activity. The page displays “runner active” based on systemd-backed API
state, not on a browser timer.

## 14. Error taxonomy and recovery

Errors have stable codes, a cause, the failed stage, relevant evidence path,
and one operator recovery action. The UI displays the short diagnosis and
offers the log/evidence file; it does not display a generic “build failed”
without the code.

| Code | Cause | Recovery |
| --- | --- | --- |
| `BRANCH_MOVED` | The branch SHA at queue acceptance differs from `expectedSha`. | Refresh branches, review the new commit, and submit a new preflight/job request. |
| `PREFLIGHT_EXPIRED` | The UI preflight is older than 10 minutes. | Run preflight again before submitting. |
| `PREFLIGHT_DISK_SPACE` | A required filesystem has less than 20 GiB free. | Free space and submit a new job. The failed job is unchanged. |
| `DOCKER_UNAVAILABLE` | Docker daemon or the locked builder image is unavailable. | Start Docker or repair the builder image, then submit a new job. |
| `DOCKER_EXECUTION_DEFINITION_MISMATCH` | The direct tool-owned Docker argv, labels, user IDs, mounts, capabilities, or environment differs from the installed definition. | Restore the immutable tool package and rerun its self-test. |
| `BUILDER_DIGEST_MISMATCH` | The installed image does not match the versioned builder lock digest. | Install the tested immutable builder version and retry. |
| `SYSTEMD_USER_UNAVAILABLE` | The user systemd manager cannot start or query a runner unit. | Enable the user manager and retry. |
| `GIT_FETCH_FAILED` | `origin` or the requested remote ref cannot be fetched. | Restore network/remote access and refresh branches. |
| `ORIGIN_NOT_SSH` | The configured `origin` is not an approved SSH URL. | Configure the allowed SSH remote and rerun configuration validation. |
| `FRESHNESS_UNKNOWN` | The API source resolver could not complete the final informational freshness check. | Review the evidence and remote access; the pinned build may remain verified. |
| `SOURCE_NOT_COMMIT` | The remote ref does not resolve to a commit. | Refresh branches and select a valid branch. |
| `WORKTREE_CREATE_FAILED` | The detached job worktree cannot be created. | Inspect the job log and remove only the recorded stale job worktree after confirming no runner is active. |
| `OUTPUT_COLLISION` | The deterministic final target directory already exists. | Select another approved root or retain the existing immutable release. |
| `BUILD_OUTPUT_COLLISION` | The target OpenWrt output directory was present before the build. | Use a fresh job worktree; the builder never cleans a pre-existing output directory. |
| `RELEASE_GATE_FAILED` | An OSI verifier returned non-zero. | Read the named verifier output; fix the branch and create a new commit. |
| `FRONTEND_DEPENDENCY_FAILURE` | `npm ci`, unit tests, or GUI build failed. | Repair branch dependencies or build tooling and create a new commit. |
| `FRONTEND_TYPECHECK_FAILED` | `npm run typecheck` failed or the required script is absent. | Repair the branch's TypeScript checks and create a new commit. |
| `GUI_MIRROR_MISMATCH` | The feed GUI differs from the built GUI. | Inspect frontend evidence and rebuild from the pinned source. |
| `FEED_INSTALL_FAILED` | Feed update/install failed. | Retry with network access; the runner must reinstall feeds after environment cleanup. |
| `FEED_LINKS_MISSING` | Installed package symlinks are absent. | Treat the image as invalid; a new job must restore feeds before config resolution. |
| `PATCH_STATE_AMBIGUOUS` | A patch reverse-applied outside the documented rootfs-padding exception or the stack invariant failed. | Inspect the pinned OpenWrt state and create a new job after resolving the patch mismatch. |
| `TARGET_CONFIG_MISMATCH` | OpenWrt target/profile/rootfs size differs from the manifest. | Inspect the resolved config and create a new job after correcting the source or manifest. |
| `BUILDER_HOST_INCOMPATIBLE` | Host compiler or tool version breaks OpenWrt tooling. | Use the supported Docker builder; do not compile with the incompatible host toolchain. |
| `RUST_BOOTSTRAP_UNAVAILABLE` | A pinned Rust CI artifact is expired or unavailable. | Use the supported LLVM-backed builder path and record its tool versions. |
| `BUILD_FAILED` | OpenWrt returned non-zero. | Inspect `docker.log` for the first failing command and create a new job after correction. |
| `RUNNER_DISAPPEARED` | The service ended without a terminal result. | Keep the last active state and recovery blocker; use direct no-cleanup proof or cleanup-worker hand-back before API commits `interrupted`, then create a new job only after the cause is understood. |
| `SERVICE_START_FAILED` | The API claimed a queue row but systemd did not start its runner. | Inspect the user journal; use direct no-cleanup proof when all runtime/label/cleanup fields are empty, otherwise cleanup-worker hand-back before API commits `interrupted`. |
| `CLEANUP_CREDENTIAL_INVALID` | The durable admission credential is missing, corrupt, unsafe, or does not match the SQLite generation/hash. | Keep the fence, rotate the admission generation/token under CAS, and retry the cleanup worker; never pass the old token to a process. |
| `CLEANUP_ADMISSION_BLOCKED` | Cleanup failed or remains blocked by a staging, log, container, or filesystem condition. | Correct the recorded blocker, then use `POST /api/jobs/:id/recover` with `{"retry":true}`; the fence remains until successful hand-back. |
| `CLEANUP_UNIT_UNEXPECTED_EXIT` | A claimed cleanup unit became inactive while its lease was still unexpired. | Record the exit evidence, retain the fence during CAS rotation, and start only the replacement admission unit. |
| `CLEANUP_UNIT_STOP_FAILED` | A claimed cleanup unit with a stale lease did not stop within the bounded timeout. | Retain the fence and blocker, do not start a replacement, and require operator correction before explicit retry. |
| `DOCKER_CONTAINER_ORPHANED` | A labeled job container remains without a live runner service. | Use `POST /api/jobs/:id/recover`; the API admits the cleanup worker, which removes and verifies the exact container before cleanup CAS and queue release. A stale active job then becomes `interrupted`; an already interrupted job remains interrupted. |
| `ARTIFACT_STALE` | The image mtime predates the build. | Do not publish; rerun from a fresh job. |
| `ARTIFACT_TOO_SMALL` | The image is below the target floor, commonly caused by missing feed links. | Do not flash it; repair feeds/build environment and create a new job. |
| `CHECKSUM_FAILED` | `sha256sum -c sha256sums` failed. | Treat the build as invalid and inspect output corruption. |
| `GZIP_FAILED` | The factory image is not valid gzip. | Treat the build as invalid and create a new job. |
| `ROOTFS_CONTENT_FAILED` | Required runtime file, dependency, route, GUI, or DB check failed. | Inspect the named missing item and create a new job. |
| `PUBLISH_RECOVERY_FAILED` | Recovery found the final destination absent, including the case where staging survives after the rename boundary. | Use the helper's atomic quarantine move for surviving staging when proven safe, inspect the evidence, then use a new approved root. |
| `UNVERIFIED_FINAL_PATH_BLOCKER` | The existing final path does not match the recorded manifest or checksum. | Do not touch the final path; stop dispatch and use the non-destructive blocker recheck after independent operator correction or removal. |
| `QUARANTINE_PENDING` | The helper could not prove an atomic no-overwrite move into quarantine. | Leave the source path untouched, resolve the filesystem blocker, and rerun the helper recovery action. |
| `PUBLISH_FAILED` | Atomic publication or post-rename verification failed. | Preserve the staging path and recorded quarantine status, verify filesystem health, and submit a new job to a different approved root when the original filesystem cannot publish safely. |
| `CANCELLED` | The operator requested controlled termination. | No recovery is required; `stagingAbsent: true` or the partial files are safely quarantined. |
| `RECOVERY_LOG_GAP` | Durable event sequence cannot be reconstructed. | Inspect the job evidence and systemd journal; leave the job interrupted and create a new job only after review. |

The UI maps all codes to these actions. It never suggests flashing a failed or
quarantined artifact.

## 15. Security and destructive-action constraints

- Bind both API and static UI to `127.0.0.1`; do not listen on LAN interfaces.
- Serve the UI and API from one origin. Validate `Origin` on every mutating
  request and reject cross-origin writes.
- Accept branch, target, and approved-root IDs only from validated enums or
  manifest entries. Do not accept shell fragments or filesystem paths from
  the UI.
- Resolve and verify every path with `realpath`; reject symlinked output roots,
  path traversal, and paths outside the configured root. Publication holds the
  approved-root directory FD, walks components with `O_NOFOLLOW`, and uses the
  tested native `renameat2(RENAME_NOREPLACE)` helper.
- Use argument arrays for child processes and fixed environment allowlists.
  Do not pass tokens, SSH agents, cloud credentials, or the complete host
  environment into the Docker builder.
- Store cleanup admission credentials only in the fixed job-owned recovery
  directory with mode `0600`, the service-user owner, no symlink traversal,
  fsynced file and parent, and a SQLite hash/reference. Pass only the
  systemd-safe Admission ID as `%i`; the worker resolves the job ID and all
  other paths/fields from the matching `cleanup_leases` row, then validates and
  unlinks the credential after claim. Old or rotated credentials cannot claim
  a newer generation.
- The API source resolver is the only component allowed to invoke SSH for the
  configured `origin`. The runner has no SSH/network Git path and cannot
  access cloud APIs, `osicloud.ch`, or production services.
- The service UID is the local trust boundary. Its state root is owned by that
  UID with mode `0700`; code already running as the same UID can modify the
  SQLite database, evidence, and build inputs, so hostile same-UID code is
  outside this tool's threat model. The API still serializes legitimate
  instances with an atomic PID/start-time lifecycle lock. The freshness
  listener binds a private mode-`0600` socket through the held state-root
  descriptor and hard-links that inode to `api.sock`, which keeps Node's
  automatic listener cleanup away from the public pathname.
- Run the tool-owned direct Docker execution definition pinned by image digest;
  do not trust branch Compose or branch Dockerfile instructions at job time.
  Require exactly one worktree bind mount, no Docker socket, no
  `--privileged`, no devices, no capabilities, no extra mounts, explicit
  user IDs, exact job/manifest labels, and the fixed environment allowlist.
- Accept Docker cancellation and cleanup only for the validated job container
  name and both required job labels.
- Never use recursive deletion against the active checkout, an approved output
  root, the user's home directory, or an unresolved variable.
- Cleanup may remove only a job-owned temporary path after the runner is
  terminal and the path has been revalidated. Failed and cancelled artifacts
  are moved to quarantine, not deleted.
- The final release directory is immutable and is never overwritten.
- SD-card device paths are not accepted anywhere in the MVP, so the builder
  cannot format or write a block device.

## 16. Testing strategy

Tests must run without a full firmware build by substituting a fake command
executor and fixture worktree. A smaller integration suite runs the real
verifiers and Docker preflight where those tools are available.

### 16.1 Domain and manifest tests

- reject malformed branch names and local-only refs;
- require a 40-character `expectedSha` at preflight and queue acceptance;
- return `BRANCH_MOVED` and insert no job when the remote moves between the
  displayed SHA and queue acceptance;
- resolve branch slugs without path escape;
- validate the target array and reject invalid manifest changes;
- assert every target has Pi-specific target/profile/rootfs/artifact values;
- assert each target has typed exact config symbols and known operation IDs;
- reject a manifest with an absolute path, traversal, duplicate ID, wrong
  partition size, or unknown stage;
- calculate deterministic release paths and reject collisions.

### 16.2 Runner tests

- pin a remote SHA from a fixture Git repository and prove a dirty active
  worktree is untouched;
- prove a post-acceptance branch movement sets `newerSourceAvailable` while
  the worktree remains at the persisted original SHA;
- initialize a fixture submodule, run `switch-env`, copy and hash
  `feeds.conf.default`, verify the local ChirpStack feed, install feed links,
  and exercise both allowed and rejected reverse-applicable patch cases;
- inject failures at every stage and assert evidence, state, and error code;
- prove a missing feed link fails before build completion and a small artifact
  cannot publish;
- verify the source-stage target-output absence evidence is created after
  submodule initialization and before any worktree mutation, then enforce
  exact artifact cardinality after build;
- verify the original OpenWrt checksum as evidence and the generated
  image-only checksum before and after publish;
- verify checksum, gzip, both profile checks, rootfs file, nginx route, GUI
  hash, critical flow/database/GUI source hashes, Node resolution, and SQLite
  checks;
- verify the zero Chameleon calibration row case passes;
- prove publish is atomic, `renameat2(RENAME_NOREPLACE)` rejects a collision,
  held dirfds reject symlinks, and a pre-existing final directory is not
  touched;
- prove cancellation validates the job-labeled container, stops it, waits,
  atomically quarantines staging before committing `cancelled`, or records
  `QUARANTINE_PENDING` without claiming cancellation;
- prove every post-source operation uses `docker create` without `--rm`,
  inspects and validates the exact ID/image/mount/environment/labels/security,
  persists runtime identity through runner CAS, then uses `docker start
  --attach`; prove each operation result commits while `jobs.container_*`
  remains populated, then exact-ID removal and absence verification precede
  the cleanup CAS/event/clear transaction, without waiting for the terminal
  job outcome;
- prove a crash after the operation result commit but before `docker rm` keeps
  the persisted identity as a recovery handle and blocks the next operation;
- prove a crash after exact-ID removal but before the cleanup CAS transaction
  leaves the identity and blocker persisted, while recovery verifies the ID is
  absent and completes cleanup without altering immutable `job_operations`;
- prove pre-creation cancellation sees no registered or matching labeled
  container, records `stagingAbsent: true` when applicable or safely
  quarantines staging, and cancels without creating one; prove cancellation
  works from every listed active non-publishing state and publishing ignores
  cancellation transition;
- prove a forced runner kill leaves the job in its last active state with a
  recovery blocker, never `cancelled` or prematurely `interrupted`, and that
  API recovery commits `interrupted` only after cleanup hand-back or a Direct
  interruption proof;
- prove a crash between rename and terminal DB commit recovers only a complete
  matching publication.
- prove the actor/transition matrix rejects API writes to runner-owned normal
  transitions and runner writes to API-owned queue/recovery transitions;
- prove runner start and lease renewal racing cleanup admission cannot write
  after the API atomically installs the per-job fence/token; prove cleanup
  claim and CAS reject a mismatched fence, token, admission, or stale runner
  snapshot;
- crash after durable credential creation but before the admission commit;
  restart API reconciliation, prove the orphan credential is pruned safely,
  and prove no cleanup worker starts from it;
- crash after cleanup-worker completion but before API hand-back; restart API
  or call `POST /api/jobs/:id/recover`, prove evidence/exact absence/global
  no-label state is independently validated, hand-back occurs without a new
  worker, and the fence clears only after hand-back;
- verify admission credentials are mode `0600`, owner-correct, non-symlink,
  fsynced, hash-matched, and absent after successful claim; corrupt or missing
  post-commit credentials rotate generation/token under CAS, and old tokens
  cannot claim;
- prove the API never writes live container identity and does not own
  normal/live publishing execution or decisions;
- prove the recovery order handles stale publishing before interruption, and
  never recovers an active unit, unexpired lease, or live labeled container;
- prove API publishing recovery and the cleanup worker seal orphan log tails
  only after inactive-unit, stale-lease, and no-container proofs, fsync the
  file, insert the exact range event before hand-back or the API recovery
  terminal event, and report a shorter file as a gap;
- prove SSE replay from a durable cursor handles byte offsets, rotation,
  truncated files, and a partial final line without duplicate or invented
  content;
- prove the runner has no SSH/fetch path and that final freshness results are
  `fresh`, `advanced`, or non-failing `unknown` through the API resolver;
- prove branch Compose changes cannot alter the tool-owned direct Docker
  invocation, mount count, labels, user IDs, capabilities, or environment;
- build and self-test the native publisher, including no-follow traversal,
  fsync, no-overwrite rename, post-rename mismatch, and honest
  `QUARANTINE_PENDING` reporting.
- prove publisher recovery creates or opens only branch/SHA parents, passes an
  absent target basename to `renameat2`, distinguishes absent destination with
  surviving staging from an existing mismatched destination, and supports a
  non-destructive blocker recheck;

### 16.3 API and queue tests

- run `POST /api/preflight`, assert 10-minute expiry, stable output-root IDs,
  and structured errors;
- enqueue jobs with branch, expected SHA, target, root, and preflight data
  transactionally, then dispatch in FIFO order;
- reject a second active runner and retain later jobs;
- reject foreign `Origin`, arbitrary output paths, unknown targets, and invalid
  branches;
- assert API writes only request/queue/dispatch/cancellation-request and
  cleanup-admission fields and enumerated recovery terminals, while runner writes lease/runtime,
  per-operation container identity, stage, normal terminal, and publish fields;
  API runtime-identity writes fail; transition and event insertion commit
  together;
- assert API owns `queued -> starting`, `queued -> cancelled`, service-start
  failure recovery, and verified recovery transitions while the runner owns
  normal stage and terminal transitions; assert direct interruption is
  accepted only when all runtime columns and global labels are absent and no
  cleanup is needed;
- reconnect SSE from a durable event ID and replay log bytes by stream,
  generation, offset, and length without duplication;
- restart the API while a fake runner service and labeled container are active
  and restore SQLite state without dispatching a second job;
- crash the dispatcher after the SQLite queue claim and before systemd start,
  then assert the claimed job remains `starting` with a recovery blocker until
  direct no-cleanup proof or cleanup hand-back, and the next queued job remains
  ordered;
- simulate host reboot, service-start crash, forced kill, orphan-container
  cleanup-worker recovery, and API restart; queued jobs resume, active jobs
  remain in their last active state with a recovery blocker, become
  `interrupted` only after cleanup hand-back or direct no-cleanup proof, and
  dispatch remains blocked until exact absence and cleanup-worker CAS;
- reconcile a completed, failed, cancelled, interrupted, and publishing unit;
- reconcile stale publishing before the explicit active-state interruption set and block dispatch
  on a live labeled container even after service-start failure;
- enumerate recovery as `starting`, `preflight`, `source`, `release_gates`,
  `frontend`, `target_setup`, `feeds`, `config`, `building`, `verifying`, and
  `cancel_requested`, with `queued` excluded and `publishing` separate;
- exercise `POST /api/jobs/:id/recover` for a stale active job and for an
  already interrupted blocker; assert API admission precedes cleanup-worker
  execution, the cleanup worker cannot write terminal state, stale active
  recovery commits `interrupted` only after hand-back, and interrupted
  recovery leaves the state unchanged;
- exercise an already `interrupted` job with a persisted present exact ID and
  one with the same exact ID already absent; require stop/remove/verify for
  the present case, exact-ID absence plus global no-label proof for the absent
  case, cleanup-worker CAS in both cases, and no terminal-state change;
- exercise `admitted`/not-started, `claimed`/active, `claimed`/stale,
  `completed`/not-handed-back, and `failed`/`blocking` admissions through both
  startup and `POST /api/jobs/:id/recover`; assert defer, rotate/restart,
  hand-back without a new worker, and explicit corrected retry behavior;
- exercise all claimed reconciliation combinations: active unit plus
  unexpired lease defers; inactive unit plus unexpired lease records
  unexpected exit and rotates immediately; inactive unit plus stale lease
  rotates; active unit plus stale lease receives bounded stop and confirmation
  before rotation. Assert stop failure retains the fence/blocker and never
  starts a replacement while the old unit is active;
- assert every cleanup admission persists the exact
  `osi-image-builder-cleanup@<admission-id>.service` name, the worker resolves
  the job from that admission row, and a delayed old unit cannot claim a
  rotated generation/token;
- validate and reject unsafe or ambiguous systemd instance IDs: uppercase,
  wrong prefix, invalid Crockford characters, wrong length, slash,
  backslash, percent, whitespace, `@`, dot, shell metacharacters, and an ID
  whose persisted unit name does not equal
  `osi-image-builder-cleanup@<admission-id>.service`; assert `%i` is the only
  dynamic `ExecStart` argument and no job ID/token appears in argv or env;
- prove direct API interruption rejects any non-null runtime column, matching
  global label, staging/log cleanup, blocker, cleanup admission, or cleanup
  fence, including service-start failure, and falls back to cleanup-worker
  hand-back;
- seal orphan logs before recovery terminal events and reject any interruption
  transition for `publishing`;
- assert every operation removes its stopped container before the next
  operation, and cleanup failure blocks progression;
- exercise both cleanup crash windows: before exact-ID removal and after
  removal before runner CAS cleanup; require retained identity/blocker until
  cleanup success is durably recorded;
- end-to-end: create a stale `building` job with its operation result committed
  and persisted container ID, crash the cleanup worker before `docker rm`,
  restart recovery through `POST /api/jobs/:id/recover`, and prove the same ID
  is recovered by the newly admitted cleanup worker, removed and verified
  absent, then cleared by cleanup-worker CAS before the API commits
  `building -> interrupted` and releases the next queued job;
- end-to-end: create both a stale active `verifying` job and an already
  `interrupted` job whose exact container was removed, crash the cleanup worker
  after `docker rm` and absence verification but before cleanup-worker CAS,
  restart recovery, and prove the persisted ID remains the recovery handle,
  the worker completes the absence/CAS path, the stale active job becomes
  `interrupted`, the already interrupted job remains unchanged, and neither
  queued job dispatches until exact absence and CAS completion are durable;
- prove a cleanup worker with a mismatched admission, unit still active,
  unexpired runner lease, non-listed state, wrong container ID, or wrong label
  cannot stop, remove, quarantine, clear identity, or alter job state;
- ensure a terminal job cannot be cancelled or overwritten.
- run installer probes for GCC, libc headers, `make`, Linux `renameat2`,
  `RENAME_NOREPLACE` filesystem support, and publisher self-test before the
  selected version changes; exercise crash-safe selection updates.

### 16.4 UI tests

- submit only when branch, target, root, and preflight data are valid;
- display queued, active, verifying, succeeded, failed, cancelled, and
  interrupted states;
- reconnect logs after a simulated browser close;
- render a newer-source warning and create a new job from the newer SHA;
- show artifact evidence and error recovery without presenting quarantined
  paths as releases;
- exercise desktop and narrow viewport layouts without control overlap.

### 16.5 System integration tests

On a build workstation, run one controlled Pi 5 and one Pi 4/400/3/2 image
through the real supported builder and compare the captured evidence with the
manual workflow in `docs/build/rpi5-full-osi-image.md`. The integration test
must confirm that API restart and browser closure do not stop the runner, that
the installed image digest matches the builder lock, and that a host reboot
leaves the job in its last active state with a recovery blocker until direct
no-cleanup proof or cleanup-worker hand-back commits `interrupted`. It must
not flash a device. A recovery integration fixture must also run both cleanup crash
windows end to end: crash before exact-ID removal and crash after exact-ID
absence but before cleanup-worker CAS. In each case, restart the API, submit
`POST /api/jobs/:id/recover`, prove the persisted ID is the recovery handle,
prove exact absence and cleanup-worker CAS before releasing the next queued
job, and verify that stale active recovery commits `interrupted` only after
cleanup while an already interrupted blocker remains interrupted.

## 17. Acceptance criteria

The implementation is accepted only when all of these pass:

1. `POST /api/preflight` accepts branch, expected SHA, target, and stable
   output-root ID, reports expiry, and returns structured errors.
2. `POST /api/jobs` re-fetches and resolves `origin`, returns `409 BRANCH_MOVED`
   on mismatch, and persists the full SHA before queue insertion.
3. The UI lists only fetched `origin` branches and submits no local worktree
   state.
4. A job records the full branch name, remote SHA, commit time and subject,
   target, timestamps, output root, manifest/config hashes, tool versions,
   immutable builder digest, artifact size, and artifact SHA-256.
5. A dirty active checkout remains unchanged while a detached job worktree
   builds the pinned SHA.
6. SQLite is canonical; request/queue/dispatch/cancellation-request and
   cleanup-admission fields and only the enumerated recovery terminal
   transitions are API-owned; lease, Docker runtime identity, normal
   stage/terminal, artifact, and publish fields are runner-owned. Cleanup
   admission atomically installs a per-job fence/token and stale runner
   snapshot. Runner lease, stage, operation, container, and terminal CAS
   writes require no fence; cleanup claim/CAS requires the matching fence,
   token, admission, and snapshot. A cleanup worker owns only its admitted
   lease, exact-container cleanup, log/staging evidence, and cleanup-worker CAS
   clear while retaining the fence; it cannot run stages, publish, or change
   terminal state. The API clears the fence only on hand-back. The API never
   writes live container identity or owns normal/live publishing execution or
   decisions. Each transition plus structured event commits atomically.
   Each admission has a durable mode-0600 job-owned credential created and
   fsynced before the admission commit; SQLite stores its relative path, hash,
   and generation. The worker receives only `%i` as its dynamic argument,
   resolves the job ID and cleanup fields from the matching admission row,
   validates and unlinks the credential after claim, and startup/POST recovery handles
   admitted, claimed, completed, failed, and blocking admissions idempotently.
   Claimed reconciliation defers active/unexpired units, rotates inactive
   units immediately even when their lease is unexpired, and bounded-stops
   active/stale units before rotation; stop failure retains the fence and no
   replacement starts while the old unit is active. The exact persisted unit
is `osi-image-builder-cleanup@<admission-id>.service`, and delayed old
units cannot claim rotated generations. Admission IDs match
`^cln_[0-7][0-9a-hj-km-np-tv-z]{25}$`; unsafe or mismatched IDs are rejected before
systemd invocation. `%i` is the only dynamic `ExecStart` argument, and no job
ID or token appears in cleanup argv or environment.
7. The queue survives API restart and starts exactly one runner at a time in
   FIFO order.
8. Browser closure and API restart do not terminate an active Docker build;
   reopening the UI restores SQLite state and file-backed logs. Host reboot
   leaves exactly the last active state plus a recovery blocker for
   `starting`, `preflight`, `source`, `release_gates`, `frontend`,
   `target_setup`, `feeds`, `config`, `building`, `verifying`, or
   `cancel_requested`; `queued` is excluded and `publishing` uses dedicated
   recovery. API commits `interrupted` only after cleanup-worker hand-back or
   the Direct interruption proof. Queued jobs resume at login.
9. Every post-source operation uses `docker create` without `--rm`, validates
   the exact image, ID, one mount, environment, labels, user, and security
   settings, persists runtime identity before `docker start --attach`, and
   commits each operation result while retaining `jobs.container_*`, removes
   the exact persisted stopped ID, verifies its absence, then records cleanup
   success/event and clears only active `jobs.container_*` before the next
   operation. Cleanup failure or either crash window blocks progression;
   immutable `job_operations` retains the identity/evidence.
   Cancellation and recovery use that exact identity; forced termination
   without a terminal result leaves the last active state and recovery blocker
   until cleanup hand-back or the Direct interruption proof, then API commits
   `interrupted`.
   Recovery cleanup is separately fenced: the API admits only inactive units,
   stale runner leases, and the exact active set
   `starting`, `preflight`, `source`, `release_gates`, `frontend`,
   `target_setup`, `feeds`, `config`, `building`, `verifying`, or
   `cancel_requested`; `queued` is excluded and `publishing` is dedicated.
   The cleanup worker stops/removes and verifies the exact persisted ID,
   seals logs, quarantines staging, records evidence, and clears identity by
   cleanup-worker CAS, then the API commits stale active jobs to
   `interrupted`. Already interrupted blockers remain interrupted. A persisted
   present exact ID is stopped/removed/verified; an already-absent exact ID is
   verified absent with a global no-label query. Queue release waits for exact
   absence, cleanup-worker CAS, and fence hand-back.
   Direct API interruption, including service-start failure, is accepted only
   when all `jobs.container_*` are null, the global label query is empty,
   staging is absent, logs are sealed with no tail/gap, and no blocker,
   admission, or fence exists.
10. The runner initializes submodules, runs `switch-env` in the pinned
   worktree, copies and hashes repository `feeds.conf.default`, verifies the
   local feed, handles the named reverse-applicable patch deterministically,
   installs feed links, and resolves typed target config.
11. The runner uses one immutable builder image by digest with the tested
   Node >=22 LLVM/Polly/Zstd Rust setup for all repository build operations.
12. The runner runs all listed OSI release gates, frontend tests/typecheck/build, GUI
   mirror verification, target setup, feed refresh/install, defconfig checks,
   Docker build, and post-build verification.
13. The source stage rejects a pre-existing target output directory after
   submodule initialization and before worktree mutation; missing feed links,
   a stale artifact, or an artifact below the
   64 MiB target floor cannot publish.
14. Artifact cardinality is exactly one; the original OpenWrt checksum is
   evidence only; the published checksum contains the factory image only and
   passes before and after publication.
15. A verified job passes checksum and gzip checks; both profile/source hashes,
   target/profile/rootfs size,
   required runtime files, Node-RED dependencies, nginx routes, GUI payload,
   critical flow/database/GUI hashes, protobufjs/helper resolution, and SQLite
   integrity checks are recorded as evidence.
16. A Chameleon calibration row count of zero passes when the table and runtime
   lookup support are present.
17. If the remote branch advances after queue acceptance, the job remains pinned to
   its original SHA. It reports a newer SHA only when the API source resolver
   successfully completes the final SSH freshness check with status
   `advanced`; resolver status `unknown` does not fail the pinned build and
   does not claim that a newer SHA was observed.
18. Cancellation is controlled from every active non-publishing state,
   records `stagingAbsent: true` when applicable, stops the exact labeled
   container when present, and safely quarantines partial output through the
   native helper; an unproven move remains an explicit
   `QUARANTINE_PENDING` blocker.
   Recovery uses the cleanup worker for stale active jobs and interrupted
   blockers; both crash windows retain the persisted identity until exact
   absence and cleanup-worker CAS are durable, and neither path releases the
   queue early.
19. Publication uses the installed native helper with held no-follow
   directory FDs, fsync, and `renameat2(RENAME_NOREPLACE)` after verification,
   and an existing deterministic target directory is never overwritten. A
   post-rename mismatch blocks publication and is never falsely reported as
   quarantined; recovery distinguishes absent destination with surviving
   staging from an existing mismatched destination, and provides a
   non-destructive blocker recheck.
20. The API rejects cross-origin writes, arbitrary output paths, block-device
   paths, production/cloud access, and secret-bearing build environments.
21. The API and runner systemd units install for the current user and leave
   runner units independent from API restarts.
22. Retention is enforced for builder-owned worktrees, logs, caches, and
   quarantine, while published releases remain immutable.
23. The runner uses the tool-owned direct Docker execution definition, with one
   worktree mount, no socket/privilege/devices/capabilities/extra mounts, exact
   labels and user IDs, and the fixed environment allowlist. Final freshness
   is API-owned, a newer SHA is reported only for resolver status `advanced`,
   and `unknown` is non-failing and does not claim a newer SHA.
24. The unit, API, runner, UI, manifest, publisher, and integration tests pass, and one
   real image for each target passes the manual release verification commands.

## 18. Observability and operations

The operator can inspect the live system without the browser:

```text
systemctl --user status osi-image-builder.service
systemctl --user list-units 'osi-image-builder-runner@*.service'
systemctl --user list-units 'osi-image-builder-cleanup@*.service'
journalctl --user -u osi-image-builder.service
journalctl --user -u 'osi-image-builder-runner@<job-id>.service'
```

The API exposes current queue depth, active job ID, current stage, last event
time, disk-free bytes, builder image ID/digest, labeled container identity,
queue blocker, and the last terminal error. The UI shows stale-log age, runner
liveness, preflight expiry, recovery blockers, cleanup admission status,
admission generation, and whether hand-back is pending; it never exposes the
credential path or token. A job evidence record
includes stage duration and trusted operation exit code, which is enough to
distinguish a slow package phase from a stopped process.

The builder must log structured records with job ID, stage, command ID, and
timestamp. It may include command output, but it must redact values from the
fixed secret denylist and never log the host environment wholesale.

## 19. Packaging and systemd installation

The installation command requires Node >=22 and npm, builds the UI, builds the
native publisher with the exact C17 warning-as-error flags in section 8.4,
builds and validates the immutable Docker builder image, installs the API and
runner bundles under a user-owned versioned prefix, validates the manifest,
schema migrations, builder lock, direct Docker execution definition, and
config, runs the publisher `--version` and `--self-test` checks, and installs
only after all checks pass:

```text
~/.local/lib/osi-image-builder/<package-version>/
~/.local/lib/osi-image-builder/<package-version>/builder.lock.json
~/.local/lib/osi-image-builder/<package-version>/bin/osi-image-publish
~/.config/systemd/user/osi-image-builder.service
~/.config/systemd/user/osi-image-builder-runner@.service
~/.config/systemd/user/osi-image-builder-cleanup@.service
```

Each versioned install directory is immutable after installation. The systemd
units point to the selected versioned directory; an upgrade installs a new
directory and atomically updates the user-owned selection file only after
validation. The API unit serves the static UI and listens on `127.0.0.1`. The
runner unit has `KillMode=control-group`, a 15-second stop timeout, a `SIGUSR1`
handler for cooperative cancellation, no API dependency, and no automatic
restart after a terminal exit. The API dispatcher starts and stops runner
units through the user's systemd manager. The API unit is wanted by the
user's `default.target` so queued jobs resume at login; runner units are not
wanted by that target.

`osi-image-builder-cleanup@.service` is a single-use, API-started cleanup
worker. The unit is always
`osi-image-builder-cleanup@<admission-id>.service`; systemd `%i` is the
Admission ID only and is the sole dynamic `ExecStart` argument. The worker
resolves the job ID, credential path, fence generation, and persisted exact
unit name from the matching `cleanup_leases` admission row, then reads the
credential from that fixed job-owned path. It receives no job ID or plaintext
token on argv or environment. It validates mode `0600`, owner,
non-symlink traversal, Admission ID grammar, generation, and hash, claims the matching
fence/token/admission by CAS, then securely unlinks the credential and fsyncs
its parent. It runs with `KillMode=control-group`, `Restart=no`,
`NoNewPrivileges=yes`, a private temporary directory, the same user/group as
the builder, and access only to the state root, fixed job-owned staging/log and
credential paths, the approved quarantine root, SQLite, Docker, and the
installed native publisher. The worker validates its admission and lease
before every action. It may stop/remove the exact persisted container, verify
absence, seal logs, quarantine staging, record cleanup evidence, and clear
active `jobs.container_*` in its cleanup-worker CAS while retaining the fence.
It cannot run any build operation, publish, alter queue order, or write a job
state or terminal result. It is never wanted by `default.target`; a crash or
expiry leaves the fence and blocker for startup reconciliation or explicit
retry.

The installer checks that the user manager can start units, Docker is usable
by the service user, the repository and output roots are accessible, and
Node >=22/npm are available. It also requires `gcc`, libc development headers,
and `make`. It compiles and runs a C17 header probe that includes the required
libc and Linux filesystem headers, compiles and links a `renameat2` probe, and
requires a Linux kernel exposing `renameat2` plus a filesystem on which the
publisher self-test succeeds. The probe must exercise `RENAME_NOREPLACE` and
report unsupported filesystems before installation selection changes.

The installer builds the publisher from the recorded source, checks its
version/source hash, and runs its startup self-test. It runs the builder
validation build that proves the pinned LLVM/Polly/Zstd Rust setup and records
the resulting image digest. The installed direct execution definition is
hashed and the API refuses to start if it changes.

Installation is transactional. It builds into a new temporary directory under
the versioned install root, fsyncs files and directories, runs every compiler,
header, `renameat2`, filesystem, publisher, manifest, builder, and UI check,
then writes a complete selection record containing package version, manifest
hash, builder-lock hash, publisher hash, and execution-definition hash to a
temporary file. After fsync, it atomically renames that record into the
user-owned selection path and fsyncs its parent. The old selection remains
valid until the new record is complete; a crash leaves either the old complete
selection or the new complete selection, never a partially installed version.
It does not enable lingering, alter system services, modify Docker daemon
policy, or install system-wide packages.

The package version and manifest hash appear in `/api/health` and every build
manifest. The first-run configuration command must require explicit approved
root registration and print the canonicalized paths before writing config.

## 20. Implementation review checklist

Before implementation is considered complete, the reviewer must inspect:

- every filesystem write for scope and atomicity;
- every state transition for a legal predecessor;
- every subprocess call for fixed argv and environment handling;
- every error path for evidence and an actionable code;
- API recovery with a live runner unit and a disappeared runner unit;
- output collision handling and quarantine behavior;
- source pinning against remote movement;
- the feed reinstall ordering after `make switch-env`;
- the Docker builder toolchain path, including host GCC and Rust CI expiry;
- GUI mirror hash and rootfs checks against both target manifests;
- same-origin write validation and absence of production/cloud access.

There are no unresolved design decisions in this specification. The companion
implementation plan must preserve the boundaries and locked decisions above.
